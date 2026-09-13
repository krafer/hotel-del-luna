const express = require('express');
const fs = require('fs');
const path = require('path');
const { initDb, getReservationsByGuestId, getAllReservations, saveReservation, deleteReservation, saveContactMessage, getContactMessages } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

function isDateOnly(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
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

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/rooms', (req, res) => {
  res.sendFile(path.join(__dirname, 'rooms.html'));
});

app.get('/reservations', (req, res) => {
  res.sendFile(path.join(__dirname, 'reservations.html'));
});

app.get('/about', (req, res) => {
  res.sendFile(path.join(__dirname, 'about.html'));
});

app.get('/contact', (req, res) => {
  res.sendFile(path.join(__dirname, 'contact.html'));
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, message: 'Hotel del Luna backend is running.' });
});

app.get('/api/reservations', async (req, res) => {
  try {
    const guestId = req.query.guestId;
    const rows = guestId ? await getReservationsByGuestId(guestId) : await getAllReservations();
    res.json(rows);
  } catch (error) {
    console.error('Failed to fetch reservations:', error);
    res.status(500).json({ error: 'Failed to fetch reservations' });
  }
});

app.post('/api/reservations', async (req, res) => {
  try {
    const payload = req.body || {};

    if (!payload.guestId || !payload.name || !payload.email || !payload.checkInDate || !payload.checkOutDate || !payload.roomName || !payload.guests) {
      return res.status(400).json({ error: 'Missing required reservation fields.' });
    }

    const checkInDate = String(payload.checkInDate);
    const checkOutDate = String(payload.checkOutDate);
    const checkInParsed = new Date(`${checkInDate}T00:00:00Z`);
    const checkOutParsed = new Date(`${checkOutDate}T00:00:00Z`);

    if (!isEmail(payload.email) || !isReasonableReservationDate(checkInDate) || !isReasonableReservationDate(checkOutDate) || checkOutParsed <= checkInParsed) {
      return res.status(400).json({ error: 'Reservation dates must be today or later, with checkout after check-in, and within one year of today.' });
    }

    const guests = Number(payload.guests);
    if (!Number.isInteger(guests) || guests < 1 || guests > 4) {
      return res.status(400).json({ error: 'Guests must be an integer between 1 and 4.' });
    }

    const reservation = {
      id: payload.id || `res-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      guestId: payload.guestId,
      name: payload.name,
      email: payload.email,
      checkInDate: payload.checkInDate,
      checkOutDate: payload.checkOutDate,
      roomName: payload.roomName,
      guests
    };

    const created = await saveReservation(reservation);
    res.status(201).json(created);
  } catch (error) {
    console.error('Failed to save reservation:', error);
    res.status(500).json({ error: 'Failed to save reservation' });
  }
});

app.delete('/api/reservations/:id', async (req, res) => {
  try {
    const deleted = await deleteReservation(req.params.id);
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

    if (!payload.name || !payload.email || !payload.subject || !payload.message) {
      return res.status(400).json({ error: 'Missing required contact fields.' });
    }

    if (!isEmail(payload.email) || payload.message.length > 1000) {
      return res.status(400).json({ error: 'Contact email or message is invalid.' });
    }

    const message = {
      id: payload.id || `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      name: payload.name,
      email: payload.email,
      subject: payload.subject,
      message: payload.message,
    };

    const created = await saveContactMessage(message);
    res.status(201).json(created);
  } catch (error) {
    console.error('Failed to save contact message:', error);
    res.status(500).json({ error: 'Failed to save contact message' });
  }
});

app.get('/api/contact', async (req, res) => {
  try {
    const rows = await getContactMessages();
    res.json(rows);
  } catch (error) {
    console.error('Failed to fetch contact messages:', error);
    res.status(500).json({ error: 'Failed to fetch contact messages' });
  }
});

app.use((req, res) => {
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ error: 'API route not found.' });
  }

  res.sendFile(path.join(__dirname, 'index.html'));
});

async function startServer() {
  try {
    logFirebaseServiceAccountDiagnostic();
    await initDb();
    app.listen(PORT, () => {
      console.log(`Hotel del Luna server running at http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error('Failed to initialize database:', error);
    process.exit(1);
  }
}

startServer();
