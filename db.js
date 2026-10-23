const fs = require('fs');
const path = require('path');
const { createHash, randomUUID } = require('crypto');
const admin = require('firebase-admin');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

const ROOM_CATEGORIES = ['Echoing Hall', 'Moonview Chamber', 'Celestial Suite'];
const ROOM_INFORMATION_DEFAULTS = [
  {
    key: 'echoing-hall',
    roomName: 'Echoing Hall',
    description: 'A cozy haven where whispers of the past echo softly through the night. Ideal for guests seeking quiet reflection.',
    priceKrw: 8636
  },
  {
    key: 'moonview-chamber',
    roomName: 'Moonview Chamber',
    description: 'Luxurious quarters with panoramic views of the celestial moon garden and a private hanok-style balcony.',
    priceKrw: 15352
  },
  {
    key: 'celestial-suite',
    roomName: 'Celestial Suite',
    description: 'The pinnacle of otherworldly luxury, reserved for the most distinguished guests and their unfinished business. With personal attendant',
    priceKrw: 31184
  }
];
const ROOM_INFORMATION_BY_KEY = new Map(ROOM_INFORMATION_DEFAULTS.map((room) => [room.key, room]));

let firestoreDb = null;
const fallbackStore = {
  reservations: [],
  contactMessages: [],
  roomInformation: new Map()
};

function normalizePrivateKey(value) {
  return (value || '').replace(/\\n/g, '\n');
}

function readLocalServiceAccount() {
  const configuredPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (!configuredPath) {
    console.warn('[Firebase diagnostic] Service-account path is missing.');
    return null;
  }

  try {
    const raw = fs.readFileSync(configuredPath, 'utf8');
    const parsed = JSON.parse(raw);
    console.log('[Firebase diagnostic] JSON parsing succeeded.', {
      path: configuredPath,
      keys: Object.keys(parsed)
    });
    return parsed;
  } catch (error) {
    console.error('[Firebase diagnostic] JSON parsing failed.', {
      path: configuredPath,
      message: error.message
    });
    return null;
  }
}

function initializeFirebase() {
  if (firestoreDb) return true;

  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT;
  const localServiceAccount = readLocalServiceAccount();
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY;

  if (!serviceAccountJson && !localServiceAccount && !(projectId && clientEmail && privateKey)) {
    console.warn('Firebase credentials not found. Using in-memory fallback for local development.');
    return false;
  }

  let serviceAccount = null;

  if (serviceAccountJson) {
    try {
      serviceAccount = JSON.parse(serviceAccountJson);
    } catch (error) {
      console.error('Invalid FIREBASE_SERVICE_ACCOUNT JSON.');
      throw error;
    }
  } else if (localServiceAccount) {
    serviceAccount = localServiceAccount;
  } else {
    serviceAccount = {
      project_id: projectId,
      client_email: clientEmail,
      private_key: normalizePrivateKey(privateKey)
    };
  }

  try {
    if (admin.getApps().length === 0) {
      admin.initializeApp({
        credential: admin.cert(serviceAccount)
      });
    }
  } catch (error) {
    console.error('Firebase initialization failed:', error.code || error.message);
    return false;
  }

  firestoreDb = getFirestore(admin.getApp());
  return true;
}

function mapReservationDoc(doc) {
  return { id: doc.id, ...doc.data() };
}

function mapContactDoc(doc) {
  return { id: doc.id, ...doc.data() };
}

function reservationRecord(reservation) {
  return {
    guestId: reservation.guestId,
    ownerUid: reservation.ownerUid || null,
    name: reservation.name,
    email: reservation.email,
    checkInDate: reservation.checkInDate,
    checkOutDate: reservation.checkOutDate,
    roomName: reservation.roomName,
    guests: reservation.guests,
    createdAt: FieldValue.serverTimestamp()
  };
}

function contactMessageRecord(message) {
  return {
    name: message.name,
    email: message.email,
    subject: message.subject,
    message: message.message,
    createdAt: FieldValue.serverTimestamp()
  };
}

function bookingError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function isDateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function getOccupiedNights(checkInDate, checkOutDate) {
  const nights = [];
  const current = new Date(`${checkInDate}T00:00:00.000Z`);
  const checkout = new Date(`${checkOutDate}T00:00:00.000Z`);
  while (current < checkout) {
    nights.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return nights;
}

function reservationFingerprint(reservation) {
  return createHash('sha256')
    .update(JSON.stringify([
      reservation.ownerUid || null,
      reservation.name,
      reservation.email,
      reservation.checkInDate,
      reservation.checkOutDate,
      reservation.roomName,
      reservation.guests
    ]))
    .digest('hex');
}

function validateExistingReservation(existing) {
  if (existing.status === 'cancelled') {
    return { cancelled: true };
  }

  if (!ROOM_CATEGORIES.includes(existing.roomName)) {
    return { unsafe: true };
  }

  if (!isDateOnly(existing.checkInDate) || !isDateOnly(existing.checkOutDate) ||
      existing.checkOutDate <= existing.checkInDate) {
    return { unsafe: existing.roomName };
  }

  return {
    roomName: existing.roomName,
    checkInDate: existing.checkInDate,
    checkOutDate: existing.checkOutDate
  };
}

async function createAtomicReservation(firestore, reservation, idempotencyKey) {
  const nights = getOccupiedNights(reservation.checkInDate, reservation.checkOutDate);
  const idempotencyId = createHash('sha256')
    .update(`${reservation.ownerUid || 'anonymous'}:${idempotencyKey}`)
    .digest('hex');
  const fingerprint = reservationFingerprint(reservation);
  const reservationId = `res-${randomUUID()}`;
  const reservationReference = firestore.collection('reservations').doc(reservationId);
  const idempotencyReference = firestore.collection('reservation_idempotency').doc(idempotencyId);
  const claimReferences = nights.map((night) => {
    const claimId = createHash('sha256')
      .update(`${reservation.roomName}:${night}`)
      .digest('hex');
    return firestore.collection('room_night_claims').doc(claimId);
  });
  const allReservationsQuery = firestore.collection('reservations');

  let committedReservationId = null;
  let replayed = false;

  try {
    await firestore.runTransaction(async (transaction) => {
      const idempotencySnapshot = await transaction.get(idempotencyReference);
      const claimSnapshots = await Promise.all(claimReferences.map((reference) => transaction.get(reference)));
      const reservationsSnapshot = await transaction.get(allReservationsQuery);

      if (idempotencySnapshot.exists) {
        const idempotencyRecord = idempotencySnapshot.data();
        if (idempotencyRecord.fingerprint !== fingerprint) {
          throw bookingError('IDEMPOTENCY_KEY_REUSED');
        }
        const existingReservation = await transaction.get(
          firestore.collection('reservations').doc(idempotencyRecord.reservationId)
        );
        if (!existingReservation.exists) {
          throw bookingError('IDEMPOTENCY_KEY_REUSED');
        }
        committedReservationId = idempotencyRecord.reservationId;
        replayed = true;
        return;
      }

      if (claimSnapshots.some((snapshot) => snapshot.exists)) {
        throw bookingError('ROOM_UNAVAILABLE');
      }

      for (const document of reservationsSnapshot.docs) {
        const existing = validateExistingReservation(document.data());
        if (existing.cancelled) {
          continue;
        }
        if (existing.unsafe === true || existing.unsafe === reservation.roomName) {
          throw bookingError('LEGACY_RESERVATION_UNSAFE');
        }
        if (existing.roomName === reservation.roomName &&
            existing.checkInDate < reservation.checkOutDate &&
            existing.checkOutDate > reservation.checkInDate) {
          throw bookingError('ROOM_UNAVAILABLE');
        }
      }

      const record = { ...reservationRecord(reservation) };
      transaction.create(reservationReference, record);
      transaction.create(idempotencyReference, {
        fingerprint,
        reservationId,
        createdAt: FieldValue.serverTimestamp()
      });
      claimReferences.forEach((reference) => {
        transaction.create(reference, {
          reservationId,
          roomName: reservation.roomName
        });
      });
      committedReservationId = reservationId;
    });
  } catch (error) {
    if (error.code) {
      throw error;
    }
    throw bookingError('BOOKING_STORAGE_UNAVAILABLE');
  }

  let committedSnapshot;
  try {
    committedSnapshot = await firestore.collection('reservations').doc(committedReservationId).get();
  } catch (error) {
    throw bookingError('BOOKING_STORAGE_UNAVAILABLE');
  }
  if (!committedSnapshot.exists) {
    throw bookingError('BOOKING_STORAGE_UNAVAILABLE');
  }

  return {
    reservation: mapReservationDoc(committedSnapshot),
    replayed
  };
}

async function getReservationsByOwnerUid(ownerUid) {
  if (!firestoreDb) {
    return fallbackStore.reservations.filter((reservation) => reservation.ownerUid === ownerUid);
  }

  const snapshot = await firestoreDb
    .collection('reservations')
    .where('ownerUid', '==', ownerUid)
    .get();

  return snapshot.docs
    .map(mapReservationDoc)
    .sort((a, b) => (a.checkInDate + a.checkOutDate).localeCompare(b.checkInDate + b.checkOutDate));
}

async function getAllReservations() {
  if (!firestoreDb) {
    return [...fallbackStore.reservations].sort((a, b) => (a.checkInDate + a.checkOutDate).localeCompare(b.checkInDate + b.checkOutDate));
  }

  const snapshot = await firestoreDb.collection('reservations').get();
  return snapshot.docs
    .map(mapReservationDoc)
    .sort((a, b) => (a.checkInDate + a.checkOutDate).localeCompare(b.checkInDate + b.checkOutDate));
}

async function updateReservationDetails(id, details) {
  if (!firestoreDb) {
    const reservation = fallbackStore.reservations.find((item) => item.id === id);
    if (!reservation) return null;
    Object.assign(reservation, details);
    return { id, ...reservation };
  }

  return updateReservationDetailsInFirestore(firestoreDb, id, details);
}

async function updateReservationDetailsInFirestore(firestore, id, details) {
  const reference = firestore.collection('reservations').doc(id);
  return firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    if (!snapshot.exists) return null;
    const editableFields = {
      name: details.name,
      email: details.email,
      guests: details.guests
    };
    transaction.update(reference, editableFields);
    return { id, ...snapshot.data(), ...editableFields };
  });
}

async function createReservationAtomically(reservation, idempotencyKey) {
  if (!firestoreDb) {
    throw bookingError('BOOKING_STORAGE_UNAVAILABLE');
  }
  return createAtomicReservation(firestoreDb, reservation, idempotencyKey);
}

function getClaimReferences(firestore, reservation) {
  if (!ROOM_CATEGORIES.includes(reservation.roomName) ||
      !isDateOnly(reservation.checkInDate) ||
      !isDateOnly(reservation.checkOutDate) ||
      reservation.checkOutDate <= reservation.checkInDate) {
    return [];
  }

  return getOccupiedNights(reservation.checkInDate, reservation.checkOutDate).map((night) => {
    const claimId = createHash('sha256')
      .update(`${reservation.roomName}:${night}`)
      .digest('hex');
    return firestore.collection('room_night_claims').doc(claimId);
  });
}

async function deleteReservation(id, ownerUid = null) {
  if (!firestoreDb) {
    const index = fallbackStore.reservations.findIndex((reservation) => reservation.id === id);
    if (index === -1 || (ownerUid && fallbackStore.reservations[index].ownerUid !== ownerUid)) {
      return false;
    }
    fallbackStore.reservations.splice(index, 1);
    return true;
  }

  return deleteReservationFromFirestore(firestoreDb, id, ownerUid);
}

async function deleteReservationFromFirestore(firestore, id, ownerUid = null) {
  const reference = firestore.collection('reservations').doc(id);
  return firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    if (!snapshot.exists) return false;
    if (ownerUid && snapshot.get('ownerUid') !== ownerUid) return false;
    const claimReferences = getClaimReferences(firestore, snapshot.data());
    const claimSnapshots = await Promise.all(claimReferences.map((claimReference) => transaction.get(claimReference)));
    transaction.delete(reference);
    claimSnapshots.forEach((claimSnapshot, index) => {
      if (claimSnapshot.exists && claimSnapshot.get('reservationId') === id) {
        transaction.delete(claimReferences[index]);
      }
    });
    return true;
  });
}

async function saveContactMessage(message) {
  const id = `msg-${randomUUID()}`;
  const record = { id, ...contactMessageRecord(message) };

  if (!firestoreDb) {
    fallbackStore.contactMessages.push(record);
    return record;
  }

  const reference = firestoreDb.collection('contact_messages').doc(record.id);
  await reference.set(record);
  const snapshot = await reference.get();
  return mapContactDoc(snapshot);
}

async function getContactMessages() {
  if (!firestoreDb) {
    return [...fallbackStore.contactMessages].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  }

  const snapshot = await firestoreDb.collection('contact_messages').orderBy('createdAt', 'desc').get();
  return snapshot.docs.map(mapContactDoc);
}

async function deleteContactMessage(id) {
  if (!firestoreDb) {
    const index = fallbackStore.contactMessages.findIndex((message) => message.id === id);
    if (index === -1) return false;
    fallbackStore.contactMessages.splice(index, 1);
    return true;
  }

  return deleteContactMessageFromFirestore(firestoreDb, id);
}

async function deleteContactMessageFromFirestore(firestore, id) {
  const reference = firestore.collection('contact_messages').doc(id);
  return firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    if (!snapshot.exists) return false;
    transaction.delete(reference);
    return true;
  });
}

function mergeRoomInformation(storedRooms = new Map()) {
  return ROOM_INFORMATION_DEFAULTS.map((room) => ({
    ...room,
    ...(storedRooms.get(room.key) || {})
  }));
}

async function getRoomInformation() {
  if (!firestoreDb) {
    return mergeRoomInformation(fallbackStore.roomInformation);
  }
  return getRoomInformationFromFirestore(firestoreDb);
}

async function getRoomInformationFromFirestore(firestore) {
  const snapshots = await Promise.all(ROOM_INFORMATION_DEFAULTS.map((room) =>
    firestore.collection('room_information').doc(room.key).get()
  ));
  const storedRooms = new Map();

  const legacyPriceMigrations = {
    'echoing-hall': { oldPrice: 180000, newPrice: 8636 },
    'moonview-chamber': { oldPrice: 320000, newPrice: 15352 },
    'celestial-suite': { oldPrice: 650000, newPrice: 31184 }
  };

  for (let index = 0; index < snapshots.length; index += 1) {
    const snapshot = snapshots[index];
    if (!snapshot.exists) continue;

    const room = ROOM_INFORMATION_DEFAULTS[index];
    const data = snapshot.data();

    if (typeof data.description !== 'string' || !data.description.trim() ||
        data.description.length > 1000 || !Number.isInteger(data.priceKrw) ||
        data.priceKrw < 1 || data.priceKrw > 10000000) {
      throw new Error(`Invalid room information document: ${room.key}`);
    }

    let priceKrw = data.priceKrw;
    const migration = legacyPriceMigrations[room.key];

    if (migration && priceKrw === migration.oldPrice) {
      priceKrw = migration.newPrice;
      await firestore.collection('room_information').doc(room.key).update({
        priceKrw
      });
    }

    storedRooms.set(room.key, {
      description: data.description,
      priceKrw
    });
  }

  return mergeRoomInformation(storedRooms);
}

async function updateRoomInformation(key, changes) {
  if (!ROOM_INFORMATION_BY_KEY.has(key)) {
    return null;
  }
  if (!firestoreDb) {
    fallbackStore.roomInformation.set(key, {
      description: changes.description,
      priceKrw: changes.priceKrw
    });
    return mergeRoomInformation(fallbackStore.roomInformation).find((room) => room.key === key);
  }
  return updateRoomInformationInFirestore(firestoreDb, key, changes);
}

async function updateRoomInformationInFirestore(firestore, key, changes) {
  if (!ROOM_INFORMATION_BY_KEY.has(key)) {
    return null;
  }
  const reference = firestore.collection('room_information').doc(key);
  await firestore.runTransaction(async (transaction) => {
    await transaction.get(reference);
    transaction.set(reference, {
      description: changes.description,
      priceKrw: changes.priceKrw
    });
  });
  return {
    ...ROOM_INFORMATION_BY_KEY.get(key),
    description: changes.description,
    priceKrw: changes.priceKrw
  };
}

async function initDb() {
  initializeFirebase();
  return true;
}

module.exports = {
  ROOM_CATEGORIES,
  ROOM_INFORMATION_DEFAULTS,
  initDb,
  getReservationsByOwnerUid,
  getAllReservations,
  updateReservationDetails,
  updateReservationDetailsInFirestore,
  createReservationAtomically,
  createAtomicReservation,
  deleteReservationFromFirestore,
  deleteReservation,
  saveContactMessage,
  getContactMessages,
  deleteContactMessage,
  deleteContactMessageFromFirestore,
  getRoomInformation,
  getRoomInformationFromFirestore,
  updateRoomInformation,
  updateRoomInformationInFirestore
};
