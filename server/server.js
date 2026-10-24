const express = require('express');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const admin = require('firebase-admin');
const { getAuth } = require('firebase-admin/auth');
const database = require('./db');
const { createAuthentication, requireAdmin } = require('./auth');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const ROOM_CATEGORIES = database.ROOM_CATEGORIES;
const IDEMPOTENCY_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function getBookingFailureCategory(error) {
  const code = error && error.code;
  if (code === 'BOOKING_STORAGE_UNAVAILABLE') return 'configuration';
  if (code === 'permission-denied' || code === 7 || code === 'unauthenticated' || code === 16) return 'permission';
  if (code === 'unavailable' || code === 14 || code === 'deadline-exceeded' || code === 4) return 'connectivity';
  if (code === 'aborted' || code === 10 || code === 'failed-precondition' || code === 9 ||
      code === 'already-exists' || code === 6) return 'transaction';
  if (code === 'invalid-argument' || code === 3) return 'configuration';
  return 'unexpected';
}

function logBookingFailure(error) {
  const code = error && error.code;
  const safeCodes = new Set([
    'BOOKING_STORAGE_UNAVAILABLE',
    'permission-denied',
    'unauthenticated',
    'unavailable',
    'deadline-exceeded',
    'aborted',
    'failed-precondition',
    'already-exists',
    'invalid-argument'
  ]);
  const safeCode = safeCodes.has(code) || typeof code === 'number' && [3, 4, 6, 7, 8, 9, 10, 14, 16].includes(code)
    ? code
    : 'unknown';

  console.error('Booking transaction failed', {
    operation: 'reservation.create',
    category: getBookingFailureCategory(error),
    code: safeCode
  });
}

function createApp(options = {}) {
  const db = options.db || database;
  const getFirebaseWebConfig = options.getFirebaseWebConfig || (() => ({
    apiKey: process.env.FIREBASE_WEB_API_KEY,
    authDomain: process.env.FIREBASE_WEB_AUTH_DOMAIN,
    projectId: process.env.FIREBASE_WEB_PROJECT_ID,
    appId: process.env.FIREBASE_WEB_APP_ID
  }));
  const verifyIdToken = options.verifyIdToken || ((token) => {
    if (admin.getApps().length === 0) {
      const error = new Error('Firebase Authentication is not initialized.');
      error.code = 'AUTH_UNAVAILABLE';
      throw error;
    }
    return getAuth(admin.getApp()).verifyIdToken(token);
  });
  const authentication = createAuthentication(verifyIdToken);
  const app = express();

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  app.use(express.static(PUBLIC_DIR));

  app.get('/', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });

  app.get('/rooms', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'rooms.html'));
  });

  app.get('/reservations', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'reservations.html'));
  });

  app.get('/about', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'about.html'));
  });

  app.get('/contact', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'contact.html'));
  });

  app.get('/admin/login', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'admin-login.html'));
  });

  app.get('/admin', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'admin.html'));
  });

  app.get('/api/health', (req, res) => {
    res.json({ ok: true, message: 'Hotel del Luna backend is running.' });
  });

  app.get('/api/rooms', async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      return res.json(await db.getRoomInformation());
    } catch (error) {
      console.error('Failed to fetch room information:', error);
      return res.status(500).json({ error: 'Room information could not be loaded.' });
    }
  });

  app.patch('/api/rooms/:key', authentication.required, requireAdmin, async (req, res) => {
    const payload = req.body;
    const editableFields = ['description', 'priceKrw'];
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
        Object.keys(payload).length !== editableFields.length ||
        !editableFields.every((field) => Object.prototype.hasOwnProperty.call(payload, field))) {
      return res.status(400).json({ error: 'Provide only a description and priceKrw.' });
    }

    const description = typeof payload.description === 'string' ? payload.description.trim() : '';
    if (!description || description.length > 1000 ||
        typeof payload.priceKrw !== 'number' || !Number.isInteger(payload.priceKrw) ||
        payload.priceKrw < 1 || payload.priceKrw > 10000000) {
      return res.status(400).json({ error: 'Enter a description of 1–1000 characters and a whole-number price from 1 to 10,000,000 PHP.' });
    }

    try {
      const updated = await db.updateRoomInformation(req.params.key, {
        description,
        priceKrw: payload.priceKrw
      });
      if (!updated) {
        return res.status(404).json({ error: 'Room category not found.' });
      }
      return res.json(updated);
    } catch (error) {
      console.error('Failed to update room information:', error);
      return res.status(500).json({ error: 'Room information could not be updated.' });
    }
  });

  app.get('/api/firebase-config', (req, res) => {
    const config = getFirebaseWebConfig();
    if (!config || !config.apiKey || !config.authDomain || !config.projectId || !config.appId) {
      return res.status(503).json({ error: 'Admin sign-in is not configured.' });
    }
    res.set('Cache-Control', 'no-store');
    return res.json({
      apiKey: config.apiKey,
      authDomain: config.authDomain,
      projectId: config.projectId,
      appId: config.appId
    });
  });

  app.get('/api/reservations', authentication.required, async (req, res) => {
    try {
      const isAdmin = req.auth.admin === true;
      const rows = isAdmin
        ? await db.getAllReservations()
        : await db.getReservationsByOwnerUid(req.auth.uid);
      res.json(isAdmin ? rows : rows.map(withoutReservationPricing));
    } catch (error) {
      console.error('Failed to fetch reservations:', error);
      res.status(500).json({ error: 'Failed to fetch reservations' });
    }
  });

  app.post('/api/reservations', authentication.optional, async (req, res) => {
    try {
      const payload = req.body || {};

      if (typeof payload.name !== 'string' || !payload.name.trim() ||
          typeof payload.email !== 'string' || !payload.email.trim() ||
          !payload.checkInDate || !payload.checkOutDate ||
          typeof payload.roomName !== 'string' || !payload.roomName.trim() ||
          !payload.guests) {
        return res.status(400).json({ error: 'Missing required reservation fields.' });
      }

      const checkInDate = payload.checkInDate;
      const checkOutDate = payload.checkOutDate;
      const checkInParsed = new Date(`${checkInDate}T00:00:00Z`);
      const checkOutParsed = new Date(`${checkOutDate}T00:00:00Z`);

      if (!isEmail(payload.email) || !isReasonableReservationDate(checkInDate) || !isReasonableReservationDate(checkOutDate) || checkOutParsed <= checkInParsed) {
        return res.status(400).json({ error: 'Reservation dates must be today or later, with checkout after check-in, and within one year of today.' });
      }

      if (!ROOM_CATEGORIES.includes(payload.roomName)) {
        return res.status(400).json({ error: 'Select a valid room category.' });
      }

      const guests = Number(payload.guests);
      if (!Number.isInteger(guests) || guests < 1 || guests > 4) {
        return res.status(400).json({ error: 'Guests must be an integer between 1 and 4.' });
      }

      const idempotencyKey = req.get('idempotency-key');
      if (!idempotencyKey || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
        return res.status(400).json({ error: 'A valid Idempotency-Key UUID is required.' });
      }

      const reservation = {
        guestId: `guest-${randomUUID()}`,
        ownerUid: req.auth ? req.auth.uid : null,
        name: payload.name,
        email: payload.email,
        checkInDate,
        checkOutDate,
        roomName: payload.roomName,
        guests
      };

      const result = await db.createReservationAtomically(reservation, idempotencyKey);
      if (result.replayed) {
        res.set('Idempotency-Replayed', 'true');
        if (!req.auth) {
          return res.status(200).json({
            success: true,
            replayed: true,
            message: 'This booking request was already processed.'
          });
        }
      }
      res.status(result.replayed ? 200 : 201).json(withoutReservationPricing(result.reservation));
    } catch (error) {
      if (error.code === 'ROOM_UNAVAILABLE') {
        return res.status(409).json({ error: 'That room is already reserved for one or more selected nights.' });
      }
      if (error.code === 'IDEMPOTENCY_KEY_REUSED') {
        return res.status(409).json({ error: 'This booking retry key was already used with different reservation details.' });
      }
      if (error.code === 'LEGACY_RESERVATION_UNSAFE') {
        return res.status(409).json({ error: 'Room availability cannot be confirmed for this category. Please contact the hotel.' });
      }
      if (error.code === 'INVALID_RESERVATION_DATES') {
        return res.status(400).json({ error: 'Reservation dates must include at least one valid night.' });
      }
      logBookingFailure(error);
      return res.status(503).json({ error: 'Booking could not be secured right now. Please retry with the same Idempotency-Key.' });
    }
  });

  app.patch('/api/reservations/:id', authentication.required, requireAdmin, async (req, res) => {
    const payload = req.body;
    const editableFields = ['name', 'email', 'guests'];
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
        Object.keys(payload).length !== editableFields.length ||
        !editableFields.every((field) => Object.prototype.hasOwnProperty.call(payload, field))) {
      return res.status(400).json({ error: 'Provide only name, email, and guests.' });
    }

    const name = typeof payload.name === 'string' ? payload.name.trim() : '';
    const email = typeof payload.email === 'string' ? payload.email.trim() : '';
    if (!name || name.length > 100 || !isEmail(email) || email.length > 254 ||
        typeof payload.guests !== 'number' || !Number.isInteger(payload.guests) ||
        payload.guests < 1 || payload.guests > 4) {
      return res.status(400).json({ error: 'Enter a valid guest name, email, and guest count between 1 and 4.' });
    }

    try {
      const updated = await db.updateReservationDetails(req.params.id, {
        name,
        email,
        guests: payload.guests
      });
      if (!updated) {
        return res.status(404).json({ error: 'Reservation not found.' });
      }
      return res.json({
        id: updated.id,
        name: updated.name,
        email: updated.email,
        guests: updated.guests
      });
    } catch (error) {
      console.error('Failed to update reservation details:', error);
      return res.status(500).json({ error: 'Reservation details could not be updated.' });
    }
  });

  app.delete('/api/reservations/:id', authentication.required, async (req, res) => {
    try {
      const deleted = req.auth.admin === true
        ? await db.deleteReservation(req.params.id)
        : await db.deleteReservation(req.params.id, req.auth.uid);
      if (!deleted) {
        return res.status(404).json({ error: 'Reservation not found.' });
      }
      res.json({ success: true });
    } catch (error) {
      console.error('Failed to delete reservation:', error);
      res.status(500).json({ error: 'Failed to delete reservation' });
    }
  });

  app.post('/api/contact', async (req, res) => {
    try {
      const payload = req.body || {};

      if (typeof payload.name !== 'string' || !payload.name.trim() ||
          typeof payload.email !== 'string' || !payload.email.trim() ||
          typeof payload.subject !== 'string' || !payload.subject.trim() ||
          typeof payload.message !== 'string' || !payload.message.trim()) {
        return res.status(400).json({ error: 'Missing required contact fields.' });
      }

      if (!isEmail(payload.email) || payload.message.length > 1000) {
        return res.status(400).json({ error: 'Contact email or message is invalid.' });
      }

      const message = {
        name: payload.name,
        email: payload.email,
        subject: payload.subject,
        message: payload.message
      };

      const created = await db.saveContactMessage(message);
      res.status(201).json(created);
    } catch (error) {
      console.error('Failed to save contact message:', error);
      res.status(500).json({ error: 'Failed to save contact message' });
    }
  });

  app.get('/api/contact', authentication.required, requireAdmin, async (req, res) => {
    try {
      const rows = await db.getContactMessages();
      res.json(rows);
    } catch (error) {
      console.error('Failed to fetch contact messages:', error);
      res.status(500).json({ error: 'Failed to fetch contact messages' });
    }
  });

  app.delete('/api/contact/:id', authentication.required, requireAdmin, async (req, res) => {
    try {
      const deleted = await db.deleteContactMessage(req.params.id);
      if (!deleted) {
        return res.status(404).json({ error: 'Contact message not found.' });
      }
      return res.json({ success: true });
    } catch (error) {
      console.error('Failed to delete contact message:', error);
      return res.status(500).json({ error: 'Failed to delete contact message.' });
    }
  });

  app.use((error, req, res, next) => {
    if (res.headersSent) {
      return next(error);
    }

    if (error && (error.type === 'entity.parse.failed' || error.type === 'entity.too.large')) {
      const status = error.type === 'entity.too.large' ? 413 : 400;
      return res.status(status).json({
        error: status === 413 ? 'Request body is too large.' : 'Invalid JSON request.'
      });
    }

    console.error('Unhandled request error.');
    return res.status(500).json({ error: 'Internal server error.' });
  });

  app.use((req, res) => {
    if (req.path.startsWith('/api')) {
      return res.status(404).json({ error: 'API route not found.' });
    }

    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });

  return app;
}

function isDateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function withoutReservationPricing(reservation) {
  const { nightlyRate, totalPrice, ...publicReservation } = reservation;
  return publicReservation;
}

function getReservationDateRange() {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const maxDate = new Date(today);
  maxDate.setUTCFullYear(maxDate.getUTCFullYear() + 1);

  return { today, maxDate };
}

function isReasonableReservationDate(value) {
  if (!isDateOnly(value)) {
    return false;
  }

  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    return false;
  }

  const { today, maxDate } = getReservationDateRange();
  const year = Number(value.slice(0, 4));
  if (year < today.getUTCFullYear() || year > maxDate.getUTCFullYear()) {
    return false;
  }

  return parsed >= today && parsed <= maxDate;
}

function isEmail(value) {
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function logFirebaseServiceAccountDiagnostic() {
  const configuredPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || '';
  const fileExists = configuredPath ? fs.existsSync(configuredPath) : false;
  let fileReadable = false;

  if (fileExists) {
    try {
      fs.accessSync(configuredPath, fs.constants.R_OK);
      fileReadable = true;
    } catch (error) {
      fileReadable = false;
    }
  }

  console.log('[Firebase diagnostic]', {
    pathConfigured: Boolean(process.env.FIREBASE_SERVICE_ACCOUNT_PATH),
    path: configuredPath,
    fileExists,
    fileReadable
  });
}

async function startServer() {
  try {
    logFirebaseServiceAccountDiagnostic();
    await database.initDb();
    createApp().listen(PORT, () => {
      console.log(`Hotel del Luna server running at http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error('Failed to initialize database:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  startServer();
}

module.exports = { createApp };
