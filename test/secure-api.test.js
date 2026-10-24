const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { afterEach, beforeEach, describe, it } = require('node:test');
const { createApp } = require('../server/server');
const {
  createAtomicReservation,
  createReservationAtomically,
  deleteContactMessageFromFirestore,
  deleteReservationFromFirestore,
  getRoomInformationFromFirestore,
  updateRoomInformationInFirestore,
  updateReservationDetailsInFirestore
} = require('../server/db');

class FakeFirestore {
  constructor() {
    this.collections = new Map();
    this.transactionQueue = Promise.resolve();
    this.failNextCommit = false;
  }

  collection(name) {
    if (!this.collections.has(name)) this.collections.set(name, new Map());
    return {
      _type: 'query',
      _collection: name,
      doc: (id) => ({
        _type: 'document',
        _collection: name,
        _id: id,
        get: async () => this.snapshot(name, id),
        update: async (changes) => {
          const records = this.collections.get(name);
          if (!records.has(id)) throw new Error('document does not exist');
          records.set(id, { ...records.get(id), ...changes });
        }
      })
    };
  }

  snapshot(collectionName, id) {
    const value = this.collections.get(collectionName).get(id);
    return {
      id,
      exists: value !== undefined,
      data: () => value === undefined ? undefined : { ...value },
      get: (field) => value && value[field]
    };
  }

  seed(collectionName, records) {
    const collection = this.collection(collectionName);
    records.forEach((record) => {
      this.collections.get(collectionName).set(record.id, { ...record });
    });
    return collection;
  }

  getRecords(collectionName) {
    return [...this.collections.get(collectionName).entries()]
      .map(([id, record]) => ({ id, ...record }));
  }

  async runTransaction(callback) {
    const priorTransaction = this.transactionQueue;
    let unlock;
    this.transactionQueue = new Promise((resolve) => { unlock = resolve; });
    await priorTransaction;

    const writes = [];
    const transaction = {
      get: async (target) => {
        if (writes.length > 0) {
          throw new Error('Firestore transactions cannot read after writes.');
        }
        if (target._type === 'query') {
          return {
            docs: [...this.collections.get(target._collection).entries()]
              .map(([id, record]) => ({ id, data: () => ({ ...record }) }))
          };
        }
        return this.snapshot(target._collection, target._id);
      },
      create: (reference, value) => writes.push({ type: 'create', reference, value }),
      delete: (reference) => writes.push({ type: 'delete', reference }),
      update: (reference, value) => writes.push({ type: 'update', reference, value }),
      set: (reference, value) => writes.push({ type: 'set', reference, value })
    };

    try {
      const result = await callback(transaction);
      if (this.failNextCommit) {
        this.failNextCommit = false;
        throw new Error('simulated commit failure');
      }

      for (const write of writes) {
        const records = this.collections.get(write.reference._collection);
        if (write.type === 'create' && records.has(write.reference._id)) {
          throw new Error('document already exists');
        }
        if (write.type === 'update' && !records.has(write.reference._id)) {
          throw new Error('document does not exist');
        }
      }
      for (const write of writes) {
        const records = this.collections.get(write.reference._collection);
        if (write.type === 'create' || write.type === 'set') {
          records.set(write.reference._id, {
            ...write.value,
            ...(write.value.createdAt ? { createdAt: 'server-timestamp' } : {})
          });
        } else if (write.type === 'update') {
          records.set(write.reference._id, {
            ...records.get(write.reference._id),
            ...write.value
          });
        } else {
          records.delete(write.reference._id);
        }
      }
      return result;
    } finally {
      unlock();
    }
  }
}

function makeDatabase() {
  const firestore = new FakeFirestore();
  firestore.seed('reservations', [
    { id: 'reservation-a', ownerUid: 'guest-a', guestId: 'legacy-a', name: 'Guest A', checkInDate: '2027-01-01', checkOutDate: '2027-01-02', roomName: 'Echoing Hall', guests: 1 },
    { id: 'reservation-b', ownerUid: 'guest-b', guestId: 'legacy-b', name: 'Guest B', checkInDate: '2027-02-01', checkOutDate: '2027-02-02', roomName: 'Moonview Chamber', guests: 1 },
    { id: 'legacy-reservation', guestId: 'old-browser-id', name: 'Legacy guest', checkInDate: '2027-03-01', checkOutDate: '2027-03-02', roomName: 'Celestial Suite', guests: 1 }
  ]);
  firestore.seed('room_night_claims', [
    {
      id: claimId('Echoing Hall', '2027-01-01'),
      reservationId: 'reservation-a',
      roomName: 'Echoing Hall'
    },
    {
      id: claimId('Moonview Chamber', '2027-02-01'),
      reservationId: 'reservation-b',
      roomName: 'Moonview Chamber'
    },
    {
      id: claimId('Echoing Hall', '2027-01-02'),
      reservationId: 'another-reservation',
      roomName: 'Echoing Hall'
    }
  ]);
  firestore.seed('contact_messages', [
    { id: 'message-1', name: 'A guest', email: 'guest@example.com', message: 'Hello', createdAt: '2027-01-01' },
    { id: 'message-2', name: 'Another guest', email: 'another@example.com', message: 'Goodbye', createdAt: '2027-01-02' }
  ]);
  firestore.seed('room_information', []);
  const data = {};
  Object.defineProperty(data, 'reservations', { get: () => firestore.getRecords('reservations') });
  Object.defineProperty(data, 'contactMessages', { get: () => firestore.getRecords('contact_messages') });

  return {
    data,
    firestore,
    async getReservationsByOwnerUid(ownerUid) {
      return firestore.getRecords('reservations').filter((reservation) => reservation.ownerUid === ownerUid);
    },
    async getAllReservations() {
      return firestore.getRecords('reservations');
    },
    async createReservationAtomically(reservation, key) {
      return createAtomicReservation(firestore, reservation, key);
    },
    async deleteReservation(id, ownerUid = null) {
      return deleteReservationFromFirestore(firestore, id, ownerUid);
    },
    async updateReservationDetails(id, details) {
      return updateReservationDetailsInFirestore(firestore, id, details);
    },
    async saveContactMessage(message) {
      const record = { id: `msg-${randomUUID()}`, ...message };
      firestore.collections.get('contact_messages').set(record.id, record);
      return record;
    },
    async getContactMessages() {
      return [...data.contactMessages];
    },
    async deleteContactMessage(id) {
      return deleteContactMessageFromFirestore(firestore, id);
    },
    async getRoomInformation() {
      return getRoomInformationFromFirestore(firestore);
    },
    async updateRoomInformation(key, changes) {
      return updateRoomInformationInFirestore(firestore, key, changes);
    }
  };
}

function claimId(roomName, night) {
  return createHash('sha256')
    .update(`${roomName}:${night}`)
    .digest('hex');
}

function futureDate(offsetDays) {
  return new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function bookingPayload(overrides = {}) {
  return {
    name: 'Booking guest',
    email: 'booking@example.com',
    checkInDate: futureDate(30),
    checkOutDate: futureDate(33),
    roomName: 'Echoing Hall',
    guests: 1,
    ...overrides
  };
}

function postBooking(baseUrl, payload, key = randomUUID()) {
  return fetch(`${baseUrl}/api/reservations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify(payload)
  });
}

describe('API security boundaries', () => {
  let database;
  let server;
  let baseUrl;

  beforeEach(async () => {
    database = makeDatabase();
    const identities = {
      'guest-a-token': { uid: 'guest-a' },
      'guest-b-token': { uid: 'guest-b' },
      'admin-token': { uid: 'admin-user', admin: true }
    };
    const app = createApp({
      db: database,
      verifyIdToken: async (token) => {
        if (!identities[token]) throw new Error('Invalid token');
        return identities[token];
      }
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  it('does not expose legacy guestId-only reservations to authenticated guests', async () => {
    const response = await fetch(`${baseUrl}/api/reservations?guestId=old-browser-id`, {
      headers: { Authorization: 'Bearer guest-a-token' }
    });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).map((reservation) => reservation.id), ['reservation-a']);
  });

  afterEach(async () => {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });

  it('preserves public contact submission and ignores caller-supplied message IDs', async () => {
    const response = await fetch(`${baseUrl}/api/contact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'caller-controlled-id',
        name: 'Visitor',
        email: 'visitor@example.com',
        subject: 'Question',
        message: 'Hello'
      })
    });
    const created = await response.json();
    assert.equal(response.status, 201);
    assert.notEqual(created.id, 'caller-controlled-id');
  });

  it('rejects anonymous reservation listing and deletion', async () => {
    const listing = await fetch(`${baseUrl}/api/reservations`);
    const deletion = await fetch(`${baseUrl}/api/reservations/reservation-a`, { method: 'DELETE' });
    assert.equal(listing.status, 401);
    assert.equal(deletion.status, 401);
    assert.equal(database.data.reservations.length, 3);
  });

  it('limits an authenticated guest to their own reservations regardless of guestId query', async () => {
    const response = await fetch(`${baseUrl}/api/reservations?guestId=guest-b`, {
      headers: { Authorization: 'Bearer guest-a-token' }
    });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).map((reservation) => reservation.id), ['reservation-a']);
  });

  it('returns booking prices to administrators but not reservation owners', async () => {
    const existingReservation = database.data.reservations.find((reservation) => reservation.id === 'reservation-a');
    database.firestore.seed('reservations', [{
      ...existingReservation,
      nightlyRate: 2000,
      totalPrice: 6000
    }]);

    const guestResponse = await fetch(`${baseUrl}/api/reservations`, {
      headers: { Authorization: 'Bearer guest-a-token' }
    });
    const adminResponse = await fetch(`${baseUrl}/api/reservations`, {
      headers: { Authorization: 'Bearer admin-token' }
    });
    const guestReservation = (await guestResponse.json())[0];
    const adminReservation = (await adminResponse.json()).find((reservation) => reservation.id === 'reservation-a');

    assert.equal(guestReservation.totalPrice, undefined);
    assert.equal(guestReservation.nightlyRate, undefined);
    assert.equal(adminReservation.totalPrice, 6000);
    assert.equal(adminReservation.nightlyRate, 2000);
  });

  it('allows an administrator to update only editable reservation details', async () => {
    database.firestore.seed('reservation_idempotency', [
      { id: 'existing-key', fingerprint: 'unchanged', reservationId: 'reservation-a' }
    ]);
    const before = { ...database.data.reservations.find((reservation) => reservation.id === 'reservation-a') };
    const claimsBefore = database.firestore.getRecords('room_night_claims');
    const idempotencyBefore = database.firestore.getRecords('reservation_idempotency');
    const response = await fetch(`${baseUrl}/api/reservations/reservation-a`, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer admin-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Updated Guest', email: 'updated@example.com', guests: 3 })
    });
    const updated = await response.json();
    const stored = database.data.reservations.find((reservation) => reservation.id === 'reservation-a');

    assert.equal(response.status, 200);
    assert.deepEqual(updated, {
      id: 'reservation-a',
      name: 'Updated Guest',
      email: 'updated@example.com',
      guests: 3
    });
    assert.equal(stored.name, 'Updated Guest');
    assert.equal(stored.email, 'updated@example.com');
    assert.equal(stored.guests, 3);
    assert.equal(stored.ownerUid, before.ownerUid);
    assert.equal(stored.guestId, before.guestId);
    assert.equal(stored.roomName, before.roomName);
    assert.equal(stored.checkInDate, before.checkInDate);
    assert.equal(stored.checkOutDate, before.checkOutDate);
    assert.deepEqual(database.firestore.getRecords('room_night_claims'), claimsBefore);
    assert.deepEqual(database.firestore.getRecords('reservation_idempotency'), idempotencyBefore);
  });

  it('rejects invalid reservation edit fields and does not mutate records', async () => {
    const original = { ...database.data.reservations[0] };
    const invalidUpdates = [
      { name: ' ', email: 'valid@example.com', guests: 2 },
      { name: 'Valid Name', email: 'not-an-email', guests: 2 },
      { name: 'Valid Name', email: 'valid@example.com', guests: 0 },
      { name: 'Valid Name', email: 'valid@example.com', guests: '2' },
      { name: 'Valid Name', email: 'valid@example.com', guests: 2, checkInDate: '2030-01-01' }
    ];

    for (const details of invalidUpdates) {
      const response = await fetch(`${baseUrl}/api/reservations/reservation-a`, {
        method: 'PATCH',
        headers: { Authorization: 'Bearer admin-token', 'Content-Type': 'application/json' },
        body: JSON.stringify(details)
      });
      assert.equal(response.status, 400);
    }
    assert.deepEqual(database.data.reservations[0], original);
  });

  it('returns not found when an administrator edits a missing reservation', async () => {
    const response = await fetch(`${baseUrl}/api/reservations/missing-reservation`, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer admin-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Guest', email: 'guest@example.com', guests: 2 })
    });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'Reservation not found.' });
  });

  it('rejects anonymous and ordinary guest reservation edits', async () => {
    const details = JSON.stringify({ name: 'Updated Guest', email: 'updated@example.com', guests: 2 });
    const anonymous = await fetch(`${baseUrl}/api/reservations/reservation-a`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: details
    });
    const guest = await fetch(`${baseUrl}/api/reservations/reservation-a`, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer guest-a-token', 'Content-Type': 'application/json' },
      body: details
    });
    assert.equal(anonymous.status, 401);
    assert.equal(guest.status, 403);
    assert.equal(database.data.reservations[0].name, 'Guest A');
  });

  it('does not let a guest delete another guest reservation', async () => {
    const response = await fetch(`${baseUrl}/api/reservations/reservation-b`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer guest-a-token' }
    });
    assert.equal(response.status, 404);
    assert.equal(database.data.reservations.some((reservation) => reservation.id === 'reservation-b'), true);
    assert.equal(
      database.firestore.getRecords('room_night_claims').some((claim) => claim.reservationId === 'reservation-b'),
      true
    );
  });

  it('allows a guest to delete their own reservation', async () => {
    const response = await fetch(`${baseUrl}/api/reservations/reservation-a`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer guest-a-token' }
    });
    assert.equal(response.status, 200);
    assert.equal(database.data.reservations.some((reservation) => reservation.id === 'reservation-a'), false);
    const claims = database.firestore.getRecords('room_night_claims');
    assert.equal(claims.some((claim) => claim.reservationId === 'reservation-a'), false);
    assert.equal(claims.some((claim) => claim.reservationId === 'another-reservation'), true);
  });

  it('allows an administrator to delete a reservation without deleting another reservation claim', async () => {
    const response = await fetch(`${baseUrl}/api/reservations/reservation-a`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer admin-token' }
    });
    const claims = database.firestore.getRecords('room_night_claims');
    assert.equal(response.status, 200);
    assert.equal(database.data.reservations.some((reservation) => reservation.id === 'reservation-a'), false);
    assert.equal(claims.some((claim) => claim.reservationId === 'reservation-a'), false);
    assert.equal(claims.some((claim) => claim.reservationId === 'reservation-b'), true);
    assert.equal(claims.some((claim) => claim.reservationId === 'another-reservation'), true);
  });

  it('keeps the reservation and claims when transactional deletion fails', async () => {
    database.firestore.failNextCommit = true;
    const originalConsoleError = console.error;
    console.error = () => {};
    try {
      const response = await fetch(`${baseUrl}/api/reservations/reservation-a`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer admin-token' }
      });
      assert.equal(response.status, 500);
    } finally {
      console.error = originalConsoleError;
    }

    assert.equal(database.data.reservations.some((reservation) => reservation.id === 'reservation-a'), true);
    assert.equal(
      database.firestore.getRecords('room_night_claims').some((claim) => claim.reservationId === 'reservation-a'),
      true
    );
  });

  it('allows only an administrator to list all reservations and contact messages', async () => {
    const guestReservations = await fetch(`${baseUrl}/api/reservations`, {
      headers: { Authorization: 'Bearer guest-a-token' }
    });
    const guestContacts = await fetch(`${baseUrl}/api/contact`, {
      headers: { Authorization: 'Bearer guest-a-token' }
    });
    const adminReservations = await fetch(`${baseUrl}/api/reservations`, {
      headers: { Authorization: 'Bearer admin-token' }
    });
    const adminContacts = await fetch(`${baseUrl}/api/contact`, {
      headers: { Authorization: 'Bearer admin-token' }
    });

    assert.equal(guestReservations.status, 200);
    assert.equal(guestContacts.status, 403);
    assert.equal(adminReservations.status, 200);
    assert.equal((await adminReservations.json()).length, 3);
    assert.equal(adminContacts.status, 200);
    const messages = await adminContacts.json();
    assert.equal(messages.length, 2);
    assert.equal(messages[0].name, 'A guest');
    assert.equal(messages[0].email, 'guest@example.com');
    assert.equal(messages[0].message, 'Hello');
  });

  it('allows an administrator to delete only the selected contact message', async () => {
    const response = await fetch(`${baseUrl}/api/contact/message-1`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer admin-token' }
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { success: true });
    assert.deepEqual(database.data.contactMessages.map((message) => message.id), ['message-2']);
  });

  it('returns not found when an administrator deletes a missing contact message', async () => {
    const response = await fetch(`${baseUrl}/api/contact/missing-message`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer admin-token' }
    });

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'Contact message not found.' });
    assert.deepEqual(database.data.contactMessages.map((message) => message.id), ['message-1', 'message-2']);
  });

  it('rejects anonymous and ordinary guest contact message deletion', async () => {
    const anonymous = await fetch(`${baseUrl}/api/contact/message-1`, { method: 'DELETE' });
    const guest = await fetch(`${baseUrl}/api/contact/message-1`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer guest-a-token' }
    });

    assert.equal(anonymous.status, 401);
    assert.equal(guest.status, 403);
    assert.deepEqual(database.data.contactMessages.map((message) => message.id), ['message-1', 'message-2']);
  });

  it('serves the fixed room categories with their current display defaults', async () => {
    const response = await fetch(`${baseUrl}/api/rooms`);
    const rooms = await response.json();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(rooms.map(({ key, roomName, priceKrw }) => ({ key, roomName, priceKrw })), [
      { key: 'echoing-hall', roomName: 'Echoing Hall', priceKrw: 8636 },
      { key: 'moonview-chamber', roomName: 'Moonview Chamber', priceKrw: 15352 },
      { key: 'celestial-suite', roomName: 'Celestial Suite', priceKrw: 31184 }
    ]);
  });

  it('allows an administrator to update only existing room display information', async () => {
    const response = await fetch(`${baseUrl}/api/rooms/echoing-hall`, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer admin-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'Updated public description', priceKrw: 245000 })
    });
    const updated = await response.json();
    const persisted = database.firestore.getRecords('room_information');

    assert.equal(response.status, 200);
    assert.equal(updated.roomName, 'Echoing Hall');
    assert.equal(updated.description, 'Updated public description');
    assert.equal(updated.priceKrw, 245000);
    assert.deepEqual(persisted, [{
      id: 'echoing-hall',
      description: 'Updated public description',
      priceKrw: 245000
    }]);
    assert.equal(database.data.reservations.some((reservation) => reservation.roomName === 'Echoing Hall'), true);
    assert.equal(database.firestore.getRecords('room_night_claims').length, 3);
  });

  it('rejects invalid room values and attempts to change categories or booking fields', async () => {
    const invalidChanges = [
      { description: '', priceKrw: 200000 },
      { description: 'x'.repeat(1001), priceKrw: 200000 },
      { description: 'Valid description', priceKrw: 0 },
      { description: 'Valid description', priceKrw: 200000.5 },
      { description: 'Valid description', priceKrw: 200000, roomName: 'New category' },
      { description: 'Valid description', priceKrw: 200000, checkInDate: '2030-01-01' },
      { description: 'Valid description', priceKrw: 200000, roomCategory: 'New category' }
    ];

    for (const changes of invalidChanges) {
      const response = await fetch(`${baseUrl}/api/rooms/echoing-hall`, {
        method: 'PATCH',
        headers: { Authorization: 'Bearer admin-token', 'Content-Type': 'application/json' },
        body: JSON.stringify(changes)
      });
      assert.equal(response.status, 400);
    }
    const unknownCategory = await fetch(`${baseUrl}/api/rooms/new-category`, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer admin-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'Valid description', priceKrw: 200000 })
    });
    assert.equal(unknownCategory.status, 404);
    assert.deepEqual(database.firestore.getRecords('room_information'), []);
  });

  it('rejects anonymous and non-admin room information updates', async () => {
    const anonymous = await fetch(`${baseUrl}/api/rooms/echoing-hall`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'Unauthorized change', priceKrw: 1 })
    });
    const guest = await fetch(`${baseUrl}/api/rooms/echoing-hall`, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer guest-a-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'Unauthorized change', priceKrw: 1 })
    });

    assert.equal(anonymous.status, 401);
    assert.equal(guest.status, 403);
    assert.deepEqual(database.firestore.getRecords('room_information'), []);
  });

  it('rejects missing and invalid bearer tokens', async () => {
    const missing = await fetch(`${baseUrl}/api/contact`);
    const invalid = await fetch(`${baseUrl}/api/contact`, {
      headers: { Authorization: 'Bearer invalid-token' }
    });
    assert.equal(missing.status, 401);
    assert.equal(invalid.status, 401);
  });

  it('does not trust a browser-supplied admin role', async () => {
    const response = await fetch(`${baseUrl}/api/contact?role=admin`, {
      headers: { Authorization: 'Bearer guest-a-token', 'X-Role': 'admin' }
    });
    assert.equal(response.status, 403);
  });

  it('ignores client reservation IDs and guest IDs when creating records', async () => {
    const original = { ...database.data.reservations[0] };
    const response = await fetch(`${baseUrl}/api/reservations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
      body: JSON.stringify(bookingPayload({
        id: original.id,
        guestId: 'guest-b',
        name: 'New guest',
        email: 'new@example.com',
        checkInDate: futureDate(1),
        checkOutDate: futureDate(2),
      }))
    });
    const created = await response.json();
    assert.equal(response.status, 201);
    assert.notEqual(created.id, original.id);
    assert.notEqual(created.guestId, 'guest-b');
    assert.equal(created.ownerUid, null);
    assert.deepEqual(database.data.reservations[0], original);
  });

  it('binds authenticated reservations to the verified UID, not request identity fields', async () => {
    const response = await fetch(`${baseUrl}/api/reservations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer guest-a-token', 'Idempotency-Key': randomUUID() },
      body: JSON.stringify(bookingPayload({
        guestId: 'guest-b',
        name: 'Guest A',
        email: 'guest-a@example.com',
        checkInDate: futureDate(3),
        checkOutDate: futureDate(4),
      }))
    });
    const created = await response.json();
    assert.equal(response.status, 201);
    assert.equal(created.ownerUid, 'guest-a');
    assert.notEqual(created.guestId, 'guest-b');
  });
});

describe('authentication configuration', () => {
  it('fails closed with 503 when Firebase Authentication is unavailable', async () => {
    const app = createApp({
      db: makeDatabase(),
      verifyIdToken: async () => {
        const error = new Error('unavailable');
        error.code = 'AUTH_UNAVAILABLE';
        throw error;
      }
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/reservations`, {
        headers: { Authorization: 'Bearer token' }
      });
      assert.equal(response.status, 503);
    } finally {
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });

  it('serves only the configured public Firebase web settings', async () => {
    const app = createApp({
      db: makeDatabase(),
      getFirebaseWebConfig: () => ({
        apiKey: 'public-web-key',
        authDomain: 'example.firebaseapp.com',
        projectId: 'example-project',
        appId: 'web:example',
        privateKey: 'must-not-be-returned'
      })
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/firebase-config`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await response.json(), {
        apiKey: 'public-web-key',
        authDomain: 'example.firebaseapp.com',
        projectId: 'example-project',
        appId: 'web:example'
      });
    } finally {
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });

  it('fails clearly when Firebase web sign-in configuration is incomplete', async () => {
    const app = createApp({
      db: makeDatabase(),
      getFirebaseWebConfig: () => ({ apiKey: 'public-web-key' })
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/firebase-config`);
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: 'Admin sign-in is not configured.' });
    } finally {
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });

  it('serves the sign-in and dashboard pages without exposing dashboard data in the page response', async () => {
    const app = createApp({ db: makeDatabase() });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    try {
      const baseUrl = `http://127.0.0.1:${server.address().port}`;
      const [login, dashboard, adminScript, reservationsPage, styles, navigationScript, roomImage] = await Promise.all([
        fetch(`${baseUrl}/admin/login`),
        fetch(`${baseUrl}/admin`),
        fetch(`${baseUrl}/js/admin.mjs`),
        fetch(`${baseUrl}/reservations`),
        fetch(`${baseUrl}/css/hdlstyle.css`),
        fetch(`${baseUrl}/js/nav.js`),
        fetch(`${baseUrl}/images/The_Echoing_Hall.png`)
      ]);
      const loginHtml = await login.text();
      const dashboardHtml = await dashboard.text();
      const adminScriptText = await adminScript.text();
      const reservationsHtml = await reservationsPage.text();
      assert.equal(login.status, 200);
      assert.equal(dashboard.status, 200);
      assert.equal(adminScript.status, 200);
      assert.equal(reservationsPage.status, 200);
      assert.equal(styles.status, 200);
      assert.equal(navigationScript.status, 200);
      assert.equal(roomImage.status, 200);
      assert.equal(loginHtml.includes('admin-login-form'), true);
      assert.equal(dashboardHtml.includes('admin-reservations'), true);
      assert.equal(dashboardHtml.includes('<th>Total price</th>'), true);
      assert.match(adminScriptText, /addCell\(row, formatTotalPrice\(reservation\.totalPrice\)\)/);
      assert.equal(reservationsHtml.includes('Total price'), false);
      assert.equal(reservationsHtml.includes('totalPrice'), false);
      assert.equal(dashboardHtml.includes('guest@example.com'), false);
    } finally {
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });
});

describe('atomic booking API', () => {
  let database;
  let server;
  let baseUrl;

  beforeEach(async () => {
    database = makeDatabase();
    server = createApp({
      db: database,
      verifyIdToken: async () => { throw new Error('Invalid token'); }
    }).listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(async () => {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });

  it('rejects impossible calendar dates and invalid date types', async () => {
    const impossible = await postBooking(baseUrl, bookingPayload({
      checkInDate: '2027-02-30',
      checkOutDate: '2027-03-02'
    }));
    const wrongType = await postBooking(baseUrl, bookingPayload({ checkInDate: 20270230 }));
    const missingDate = await postBooking(baseUrl, bookingPayload({ checkOutDate: '' }));
    assert.equal(impossible.status, 400);
    assert.equal(wrongType.status, 400);
    assert.equal(missingDate.status, 400);
  });

  it('rejects checkout on or before check-in', async () => {
    const checkInDate = futureDate(30);
    const sameDay = await postBooking(baseUrl, bookingPayload({
      checkInDate,
      checkOutDate: checkInDate
    }));
    const earlier = await postBooking(baseUrl, bookingPayload({
      checkInDate,
      checkOutDate: futureDate(29)
    }));
    assert.equal(sameDay.status, 400);
    assert.equal(earlier.status, 400);
  });

  it('rejects unknown room categories', async () => {
    const response = await postBooking(baseUrl, bookingPayload({ roomName: 'Royal Tower' }));
    assert.equal(response.status, 400);
  });

  it('persists server-calculated totals using the current nightly rate and stay duration', async () => {
    const firstPayload = bookingPayload({
      checkInDate: futureDate(30),
      checkOutDate: futureDate(33),
      totalPrice: 1,
      nightlyRate: 1
    });
    const firstResponse = await postBooking(baseUrl, firstPayload);
    const firstCreated = await firstResponse.json();
    const firstStored = database.data.reservations.find((reservation) => reservation.id === firstCreated.id);

    await database.updateRoomInformation('echoing-hall', {
      description: 'Updated room description',
      priceKrw: 2000
    });
    const secondPayload = bookingPayload({
      checkInDate: futureDate(40),
      checkOutDate: futureDate(42)
    });
    const secondResponse = await postBooking(baseUrl, secondPayload);
    const secondCreated = await secondResponse.json();
    const secondStored = database.data.reservations.find((reservation) => reservation.id === secondCreated.id);

    assert.equal(firstResponse.status, 201);
    assert.equal(firstCreated.totalPrice, undefined);
    assert.equal(firstCreated.nightlyRate, undefined);
    assert.equal(firstStored.nightlyRate, 8636);
    assert.equal(firstStored.totalPrice, 8636 * 3);
    assert.equal(secondResponse.status, 201);
    assert.equal(secondStored.nightlyRate, 2000);
    assert.equal(secondStored.totalPrice, 4000);
  });

  it('fails closed when the stored nightly rate is invalid', async () => {
    database.firestore.seed('room_information', [
      { id: 'echoing-hall', description: 'Invalid rate', priceKrw: -1 }
    ]);
    const response = await postBooking(baseUrl, bookingPayload());
    assert.equal(response.status, 503);
    assert.equal(database.data.reservations.length, 3);
  });

  it('rejects overlapping stays but allows checkout-day turnover', async () => {
    const first = bookingPayload({
      checkInDate: futureDate(30),
      checkOutDate: futureDate(33)
    });
    const created = await postBooking(baseUrl, first);
    const logged = [];
    const originalConsoleError = console.error;
    console.error = (...args) => logged.push(args);
    let overlap;
    try {
      overlap = await postBooking(baseUrl, bookingPayload({
        checkInDate: futureDate(32),
        checkOutDate: futureDate(35)
      }));
    } finally {
      console.error = originalConsoleError;
    }
    const consecutive = await postBooking(baseUrl, bookingPayload({
      checkInDate: futureDate(33),
      checkOutDate: futureDate(35)
    }));

    assert.equal(created.status, 201);
    assert.equal(overlap.status, 409);
    assert.deepEqual(logged, []);
    assert.equal(consecutive.status, 201);
  });

  it('keeps availability independent between room categories', async () => {
    const dates = {
      checkInDate: futureDate(40),
      checkOutDate: futureDate(42)
    };
    const first = await postBooking(baseUrl, bookingPayload({ ...dates, roomName: 'Echoing Hall' }));
    const second = await postBooking(baseUrl, bookingPayload({ ...dates, roomName: 'Moonview Chamber' }));
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
  });

  it('allows at most one of two simultaneous overlapping requests', async () => {
    const payload = bookingPayload({
      checkInDate: futureDate(50),
      checkOutDate: futureDate(53)
    });
    const [first, second] = await Promise.all([
      postBooking(baseUrl, payload),
      postBooking(baseUrl, payload)
    ]);
    assert.deepEqual([first.status, second.status].sort(), [201, 409]);
  });

  it('checks legacy reservations without claims and fails closed on malformed records', async () => {
    const checkInDate = futureDate(60);
    const checkOutDate = futureDate(62);
    database.firestore.seed('reservations', [
      {
        id: 'legacy-overlap',
        roomName: 'Echoing Hall',
        checkInDate: futureDate(61),
        checkOutDate: futureDate(63)
      }
    ]);
    const legacyConflict = await postBooking(baseUrl, bookingPayload({ checkInDate, checkOutDate }));
    assert.equal(legacyConflict.status, 409);

    database.firestore.seed('reservations', [
      { id: 'legacy-malformed', roomName: 'Moonview Chamber', checkInDate: '2027-02-30', checkOutDate: '2027-03-01' }
    ]);
    const malformedConflict = await postBooking(baseUrl, bookingPayload({
      checkInDate,
      checkOutDate,
      roomName: 'Moonview Chamber'
    }));
    assert.equal(malformedConflict.status, 409);
  });

  it('leaves no reservation or claims when the transaction fails', async () => {
    const reservationsBefore = database.data.reservations.length;
    const claimsBefore = database.firestore.getRecords('room_night_claims').length;
    database.firestore.failNextCommit = true;
    const response = await postBooking(baseUrl, bookingPayload());
    assert.equal(response.status, 503);
    assert.equal(database.data.reservations.length, reservationsBefore);
    assert.equal(database.firestore.getRecords('room_night_claims').length, claimsBefore);
    assert.equal(database.firestore.getRecords('reservation_idempotency').length, 0);
  });

  it('does not disclose reservation details on an anonymous exact retry', async () => {
    const key = randomUUID();
    const payload = bookingPayload();
    const first = await postBooking(baseUrl, payload, key);
    const replay = await postBooking(baseUrl, payload, key);
    const firstRecord = await first.json();
    const replayRecord = await replay.json();
    assert.equal(first.status, 201);
    assert.equal(replay.status, 200);
    assert.equal(replay.headers.get('idempotency-replayed'), 'true');
    assert.deepEqual(replayRecord, {
      success: true,
      replayed: true,
      message: 'This booking request was already processed.'
    });
    assert.equal(replayRecord.id, undefined);
    assert.equal(replayRecord.email, undefined);
    assert.equal(database.data.reservations.filter((reservation) => reservation.id === firstRecord.id).length, 1);
  });

  it('rejects reuse of an idempotency key for different booking details', async () => {
    const key = randomUUID();
    const first = await postBooking(baseUrl, bookingPayload(), key);
    const second = await postBooking(baseUrl, bookingPayload({ name: 'Different guest' }), key);
    assert.equal(first.status, 201);
    assert.equal(second.status, 409);
  });

  it('requires a valid idempotency key', async () => {
    const response = await fetch(`${baseUrl}/api/reservations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bookingPayload())
    });
    assert.equal(response.status, 400);
  });

  it('does not claim success when durable booking storage is unavailable', async () => {
    database.createReservationAtomically = async () => {
      const error = new Error('storage unavailable with sensitive details');
      error.code = 'BOOKING_STORAGE_UNAVAILABLE';
      throw error;
    };
    const logged = [];
    const originalConsoleError = console.error;
    console.error = (...args) => logged.push(args);
    try {
      const response = await postBooking(baseUrl, bookingPayload());
      assert.equal(response.status, 503);
      assert.equal((await response.json()).error.includes('could not be secured'), true);
    } finally {
      console.error = originalConsoleError;
    }
    assert.deepEqual(logged, [[
      'Booking transaction failed',
      {
        operation: 'reservation.create',
        category: 'configuration',
        code: 'BOOKING_STORAGE_UNAVAILABLE'
      }
    ]]);
    assert.equal(JSON.stringify(logged).includes('sensitive details'), false);
  });
});

describe('durable booking requirement', () => {
  it('fails closed rather than using the in-memory fallback when Firestore is unavailable', async () => {
    await assert.rejects(
      createReservationAtomically(bookingPayload(), randomUUID()),
      (error) => error.code === 'BOOKING_STORAGE_UNAVAILABLE'
    );
  });
});

describe('public room pricing display', () => {
  it('shows the requested peso prices and formats API prices with the peso symbol', () => {
    const fs = require('node:fs');
    const html = fs.readFileSync(require.resolve('../public/rooms.html'), 'utf8');
    const script = fs.readFileSync(require.resolve('../public/js/rooms.js'), 'utf8');

    assert.match(html, /₱8,636/);
    assert.match(html, /₱15,352/);
    assert.match(html, /₱31,184/);
    assert.match(script, /`₱\$\{new Intl\.NumberFormat\('en-PH'\)\.format\(room\.priceKrw\)\}`/);
    assert.doesNotMatch(script, /₩/);
  });
});

describe('room price migration', () => {
  it('converts legacy prices to PHP and preserves descriptions', async () => {
    const firestore = new FakeFirestore();

    firestore.seed('room_information', [
      { id: 'echoing-hall', description: 'Quiet room', priceKrw: 180000 },
      { id: 'moonview-chamber', description: 'Ocean view', priceKrw: 320000 },
      { id: 'celestial-suite', description: 'Luxury suite', priceKrw: 650000 }
    ]);

    await getRoomInformationFromFirestore(firestore);

    assert.deepEqual(
      firestore.getRecords('room_information').map(({ id, description, priceKrw }) => ({
        id,
        description,
        priceKrw
      })),
      [
        { id: 'echoing-hall', description: 'Quiet room', priceKrw: 8636 },
        { id: 'moonview-chamber', description: 'Ocean view', priceKrw: 15352 },
        { id: 'celestial-suite', description: 'Luxury suite', priceKrw: 31184 }
      ]
    );
  });

  it('leaves custom room prices unchanged', async () => {
    const firestore = new FakeFirestore();

    firestore.seed('room_information', [
      { id: 'echoing-hall', description: 'Custom room', priceKrw: 245000 }
    ]);

    await getRoomInformationFromFirestore(firestore);

    const room = firestore.getRecords('room_information')
      .find(({ id }) => id === 'echoing-hall');

    assert.equal(room.priceKrw, 245000);
    assert.equal(room.description, 'Custom room');
  });
});

describe('reservation list rendering', () => {
  it('treats reservation-controlled values as text and never writes them to innerHTML', async () => {
    const nodes = [];
    class Element {
      constructor(tagName) {
        this.tagName = tagName;
        this.children = [];
        this.style = {};
        this.dataset = {};
        this.listeners = {};
        this.innerHTMLWrites = 0;
        this.className = '';
        this.textContent = '';
      }
      set innerHTML(value) {
        this.innerHTMLWrites += 1;
        this._innerHTML = value;
      }
      get innerHTML() { return this._innerHTML; }
      appendChild(child) {
        this.children.push(child);
        return child;
      }
      replaceChildren(...children) { this.children = children; }
      addEventListener(type, listener) { this.listeners[type] = listener; }
      querySelectorAll(selector) {
        const matches = [];
        const visit = (node) => {
          if (selector === '.btn-cancel' && node.className === 'btn-cancel') matches.push(node);
          node.children.forEach(visit);
        };
        this.children.forEach(visit);
        return matches;
      }
    }

    const list = new Element('div');
    const document = {
      getElementById(id) { return id === 'reservations-list' ? list : null; },
      createElement(tagName) {
        const node = new Element(tagName);
        nodes.push(node);
        return node;
      },
      addEventListener(type, listener) {
        if (type === 'DOMContentLoaded') this.ready = listener;
      }
    };
    const injectedText = '<img src=x onerror=alert(1)>';
    const injectedId = '"><script>alert(1)</script>';
    const source = require('node:fs').readFileSync(require.resolve('../public/js/reservation.js'), 'utf8');
    const vm = require('node:vm');

    vm.runInNewContext(source, {
      document,
      window: { location: { search: '' } },
      URLSearchParams,
      fetch: async () => ({
        ok: true,
        json: async () => [{
          id: injectedId,
          name: injectedText,
          roomName: injectedText,
          checkInDate: futureDate(1),
          checkOutDate: futureDate(2),
          guests: 1
        }]
      }),
      Date,
      Number,
      Math,
      isNaN,
      encodeURIComponent
    });

    describe('admin contact message rendering', () => {
      it('provides local search across sender, email, and message using safe text rendering', () => {
        const fs = require('node:fs');
        const html = fs.readFileSync(require.resolve('../public/admin.html'), 'utf8');
        const script = fs.readFileSync(require.resolve('../public/js/admin.mjs'), 'utf8');

        assert.match(html, /id="contact-message-search"/);
        assert.match(html, /id="admin-contact-messages"/);
        assert.match(html, /<th>Sender<\/th><th>Email<\/th><th>Message<\/th><th>Submitted<\/th><th>Actions<\/th>/);
        assert.match(script, /\[message\.name, message\.email, message\.message\]/);
        assert.match(script, /addCell\(row, message\.name\);[\s\S]*addCell\(row, message\.email\);[\s\S]*addCell\(row, message\.message\);[\s\S]*addCell\(row, formatCreatedAt\(message\.createdAt\)\);/);
        assert.match(script, /textContent = 'Delete'/);
        assert.match(script, /window\.confirm\('Delete this contact message\?/);
        assert.match(script, /fetch\(`\/api\/contact\/\$\{encodeURIComponent\(message\.id\)\}`/);
        assert.match(script, /cell\.textContent = value == null \? '' : String\(value\);/);
        assert.doesNotMatch(script, /\.innerHTML\s*=/);
      });
    });

    describe('admin reservation editing UI', () => {
      it('exposes only editable guest fields and sends updates to the protected API', () => {
        const fs = require('node:fs');
        const html = fs.readFileSync(require.resolve('../public/admin.html'), 'utf8');
        const script = fs.readFileSync(require.resolve('../public/js/admin.mjs'), 'utf8');

        assert.match(html, /id="edit-reservation-name"[^>]*name="name"/);
        assert.match(html, /id="edit-reservation-email"[^>]*name="email"/);
        assert.match(html, /id="edit-reservation-guests"[^>]*name="guests"/);
        assert.doesNotMatch(html, /name="(?:id|ownerUid|checkInDate|checkOutDate|roomName)"/);
        assert.match(script, /method: 'PATCH'/);
        assert.match(script, /name: document\.getElementById\('edit-reservation-name'\)\.value\.trim\(\)/);
        assert.match(script, /email: document\.getElementById\('edit-reservation-email'\)\.value\.trim\(\)/);
        assert.match(script, /guests: Number\(document\.getElementById\('edit-reservation-guests'\)\.value\)/);
        assert.match(script, /document\.getElementById\('detail-name'\)\.textContent = reservation\.name/);
      });
    });
    document.ready();
    await new Promise((resolve) => setImmediate(resolve));

    const allNodes = [list, ...nodes];
    assert.equal(allNodes.some((node) => node.innerHTMLWrites > 0), false);
    const renderedText = nodes.map((node) => node.textContent).join(' ');
    assert.equal(renderedText.includes(injectedText), true);
    assert.equal(renderedText.includes(injectedId), false);
    assert.equal(list.children.length, 1);
  });
});
