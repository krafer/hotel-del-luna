const express = require('express');
const path = require('path');
const { initDb, getReservationsByGuestId, getAllReservations, saveReservation, deleteReservation, saveContactMessage, getContactMessages } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

function isDateOnly(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function isEmail(value) {
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(express.static(__dirname));

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

    if (!isEmail(payload.email) || !isDateOnly(payload.checkInDate) || !isDateOnly(payload.checkOutDate) || payload.checkOutDate <= payload.checkInDate) {
      return res.status(400).json({ error: 'Reservation email and dates are invalid.' });
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
