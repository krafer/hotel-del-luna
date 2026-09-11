const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

let firestoreDb = null;
const fallbackStore = {
  reservations: [],
  contactMessages: []
};

function normalizePrivateKey(value) {
  return (value || '').replace(/\\n/g, '\n');
}

function readLocalServiceAccount() {
  const configuredPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  const candidatePaths = [configuredPath].filter(Boolean);

  for (const candidate of candidatePaths) {
    if (!candidate || !fs.existsSync(candidate)) continue;

    const entries = fs.statSync(candidate).isDirectory()
      ? fs.readdirSync(candidate).filter((file) => file.toLowerCase().endsWith('.json')).map((file) => path.join(candidate, file))
      : [candidate];

    for (const file of entries) {
      try {
        const raw = fs.readFileSync(file, 'utf8');
        const parsed = JSON.parse(raw);
        const hasRequiredFields = parsed && parsed.project_id && parsed.client_email && parsed.private_key;
        if (!hasRequiredFields) {
          console.warn('Local Firebase service account exists but is missing required fields.');
          return null;
        }
        return parsed;
      } catch (error) {
        continue;
      }
    }
  }

  return null;
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
    if (!admin.apps || admin.apps.length === 0) {
      admin.initializeApp({
        credential: admin.cert(serviceAccount)
      });
    }
  } catch (error) {
    console.warn('Firebase credentials are invalid or incomplete. Falling back to local development mode.');
    return false;
  }

  firestoreDb = getFirestore();
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

async function getReservationsByGuestId(guestId) {
  if (!firestoreDb) {
    return fallbackStore.reservations.filter((reservation) => reservation.guestId === guestId);
  }

  const snapshot = await firestoreDb
    .collection('reservations')
    .where('guestId', '==', guestId)
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

async function saveReservation(reservation) {
  const id = reservation.id || `res-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const record = { id, ...reservationRecord(reservation) };

  if (!firestoreDb) {
    fallbackStore.reservations.push(record);
    return record;
  }

  const reference = firestoreDb.collection('reservations').doc(record.id);
  await reference.set(record);
  const snapshot = await reference.get();
  return mapReservationDoc(snapshot);
}

async function deleteReservation(id) {
  if (!firestoreDb) {
    const before = fallbackStore.reservations.length;
    fallbackStore.reservations = fallbackStore.reservations.filter((reservation) => reservation.id !== id);
    return before !== fallbackStore.reservations.length;
  }

  const reference = firestoreDb.collection('reservations').doc(id);
  const snapshot = await reference.get();
  if (!snapshot.exists) return false;
  await reference.delete();
  return true;
}

async function saveContactMessage(message) {
  const id = message.id || `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
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

async function initDb() {
  initializeFirebase();
  return true;
}

module.exports = {
  initDb,
  getReservationsByGuestId,
  getAllReservations,
  saveReservation,
  deleteReservation,
  saveContactMessage,
  getContactMessages
};
