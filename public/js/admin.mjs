import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';

const status = document.getElementById('admin-status');
const loginForm = document.getElementById('admin-login-form');
const signOutButton = document.getElementById('admin-sign-out');
const accountLabel = document.getElementById('admin-account');
let auth;
let signingIn = false;
let dashboardLoading = false;
let signingOutByChoice = false;
let authorizationRejected = false;
let reservations = [];
let contactMessages = [];
let roomInformation = [];
let selectedReservation = null;
let reservationUpdateInProgress = false;
let roomInformationSaveInProgress = false;

function showStatus(message, isError = false) {
  status.textContent = message;
  status.classList.toggle('is-error', isError);
}

async function loadAuth() {
  const response = await fetch('/api/firebase-config', { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(response.status === 503
      ? 'Admin sign-in is not configured. Contact the site administrator.'
      : 'Unable to load sign-in configuration. Please try again later.');
  }
  const config = await response.json();
  return getAuth(initializeApp(config));
}

async function hasAdminClaim(user) {
  const token = await user.getIdTokenResult();
  return token.claims.admin === true;
}

async function fetchAdminData(user) {
  const idToken = await user.getIdToken();
  const [reservationResponse, contactResponse, roomResponse] = await Promise.all([
    fetch('/api/reservations', {
      headers: { Authorization: `Bearer ${idToken}` },
      cache: 'no-store'
    }),
    fetch('/api/contact', {
      headers: { Authorization: `Bearer ${idToken}` },
      cache: 'no-store'
    }),
    fetch('/api/rooms', { cache: 'no-store' })
  ]);

  if (reservationResponse.status === 401 || contactResponse.status === 401) {
    await signOut(auth);
    window.location.replace('/admin/login?session=expired');
    return;
  }
  if (reservationResponse.status === 403 || contactResponse.status === 403) {
    authorizationRejected = true;
    await signOut(auth);
    setTableMessage('admin-contact-messages', 5, 'Administrator access required.');
    document.getElementById('room-information-status').textContent = 'Administrator access required.';
    document.getElementById('room-information-status').classList.add('is-error');
    showStatus('Administrator permission was not accepted. Sign in with an authorized account.', true);
    return;
  }
  if (!reservationResponse.ok) {
    setTableMessage('admin-reservations', 8, 'Reservations could not be loaded.');
    throw new Error('Reservations could not be loaded. Please try again later.');
  }
  reservations = await reservationResponse.json();
  if (!Array.isArray(reservations)) {
    setTableMessage('admin-reservations', 8, 'Reservations could not be loaded.');
    throw new Error('Reservations could not be loaded. Please try again later.');
  }
  renderReservations();

  if (!contactResponse.ok) {
    setTableMessage('admin-contact-messages', 5, 'Contact messages could not be loaded.');
    throw new Error('Contact messages could not be loaded. Please try again later.');
  }
  contactMessages = await contactResponse.json();
  if (!Array.isArray(contactMessages)) {
    setTableMessage('admin-contact-messages', 5, 'Contact messages could not be loaded.');
    throw new Error('Contact messages could not be loaded. Please try again later.');
  }
  renderContactMessages();

  if (!roomResponse.ok) {
    document.getElementById('room-information-status').textContent = 'Room information could not be loaded.';
    document.getElementById('room-information-status').classList.add('is-error');
    throw new Error('Room information could not be loaded. Please try again later.');
  }
  roomInformation = await roomResponse.json();
  if (!Array.isArray(roomInformation) || roomInformation.length !== 3 ||
      roomInformation.some((room) => typeof room.key !== 'string' ||
        typeof room.description !== 'string' || !Number.isInteger(room.priceKrw))) {
    document.getElementById('room-information-status').textContent = 'Room information could not be loaded.';
    document.getElementById('room-information-status').classList.add('is-error');
    throw new Error('Room information could not be loaded. Please try again later.');
  }
  renderRoomInformation();
}

function addCell(row, value) {
  const cell = document.createElement('td');
  cell.textContent = value == null ? '' : String(value);
  row.appendChild(cell);
}

function setTableMessage(bodyId, columnCount, message) {
  const body = document.getElementById(bodyId);
  body.replaceChildren();
  const row = document.createElement('tr');
  const cell = document.createElement('td');
  cell.colSpan = columnCount;
  cell.textContent = message;
  row.appendChild(cell);
  body.appendChild(row);
}

function formatCreatedAt(value) {
  if (value && typeof value === 'object') {
    const timestampSeconds = Number.isFinite(value.seconds) ? value.seconds : value._seconds;
    if (Number.isFinite(timestampSeconds)) value = timestampSeconds * 1000;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unavailable' : date.toLocaleString();
}

function formatTotalPrice(value) {
  return Number.isSafeInteger(value) && value >= 0
    ? `₱${new Intl.NumberFormat('en-PH').format(value)}`
    : 'Unavailable';
}

function reservationMatchesFilters(reservation) {
  const search = document.getElementById('reservation-search').value.trim().toLocaleLowerCase();
  const room = document.getElementById('reservation-room-filter').value;
  const checkIn = document.getElementById('reservation-date-filter').value;
  const guest = String(reservation.name || '').toLocaleLowerCase();
  const email = String(reservation.email || '').toLocaleLowerCase();
  return (!search || guest.includes(search) || email.includes(search)) &&
    (!room || reservation.roomName === room) &&
    (!checkIn || reservation.checkInDate === checkIn);
}

function renderReservations() {
  const body = document.getElementById('admin-reservations');
  body.replaceChildren();
  const filtered = reservations.filter(reservationMatchesFilters);
  if (!filtered.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 8;
    cell.textContent = reservations.length ? 'No reservations match these filters.' : 'No reservations found.';
    row.appendChild(cell);
    body.appendChild(row);
    return;
  }
  filtered.forEach((reservation) => {
    const row = document.createElement('tr');
    addCell(row, reservation.name);
    addCell(row, reservation.roomName);
    addCell(row, reservation.checkInDate);
    addCell(row, reservation.checkOutDate);
    addCell(row, reservation.guests);
    addCell(row, formatTotalPrice(reservation.totalPrice));
    addCell(row, formatCreatedAt(reservation.createdAt));
    const actionCell = document.createElement('td');
    const detailsButton = document.createElement('button');
    detailsButton.className = 'admin-secondary-button';
    detailsButton.type = 'button';
    detailsButton.textContent = 'View';
    detailsButton.addEventListener('click', () => showReservationDetails(reservation));
    actionCell.appendChild(detailsButton);
    row.appendChild(actionCell);
    body.appendChild(row);
  });
}

function showReservationDetails(reservation) {
  resetReservationEdit();
  selectedReservation = reservation;
  document.getElementById('detail-name').textContent = reservation.name || '';
  document.getElementById('detail-email').textContent = reservation.email || '';
  document.getElementById('detail-room').textContent = reservation.roomName || '';
  document.getElementById('detail-check-in').textContent = reservation.checkInDate || '';
  document.getElementById('detail-check-out').textContent = reservation.checkOutDate || '';
  document.getElementById('detail-guests').textContent = reservation.guests == null ? '' : String(reservation.guests);
  document.getElementById('detail-total-price').textContent = formatTotalPrice(reservation.totalPrice);
  document.getElementById('detail-created').textContent = formatCreatedAt(reservation.createdAt);
  document.getElementById('detail-status').textContent = reservation.status || 'Confirmed';
  document.getElementById('reservation-details').hidden = false;
  document.getElementById('reservation-details-title').focus();
}

function closeReservationDetails() {
  selectedReservation = null;
  document.getElementById('reservation-details').hidden = true;
  resetReservationEdit();
}

function startReservationEdit() {
  if (!selectedReservation) return;
  document.getElementById('edit-reservation-name').value = selectedReservation.name || '';
  document.getElementById('edit-reservation-email').value = selectedReservation.email || '';
  document.getElementById('edit-reservation-guests').value = String(selectedReservation.guests || 1);
  document.getElementById('edit-reservation').hidden = true;
  document.getElementById('edit-reservation-form').hidden = false;
  document.getElementById('edit-reservation-name').focus();
}

function resetReservationEdit() {
  document.getElementById('edit-reservation-form').hidden = true;
  document.getElementById('edit-reservation').hidden = false;
}

async function updateSelectedReservation(event) {
  event.preventDefault();
  if (!selectedReservation || reservationUpdateInProgress) return;

  const form = document.getElementById('edit-reservation-form');
  if (!form.reportValidity()) return;
  const submitButton = form.querySelector('button[type="submit"]');
  const details = {
    name: document.getElementById('edit-reservation-name').value.trim(),
    email: document.getElementById('edit-reservation-email').value.trim(),
    guests: Number(document.getElementById('edit-reservation-guests').value)
  };

  reservationUpdateInProgress = true;
  submitButton.disabled = true;
  showStatus('Saving reservation details…');
  try {
    if (!auth.currentUser) {
      await signOut(auth);
      window.location.replace('/admin/login?session=expired');
      return;
    }
    const idToken = await auth.currentUser.getIdToken();
    const response = await fetch(`/api/reservations/${encodeURIComponent(selectedReservation.id)}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${idToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(details),
      cache: 'no-store'
    });
    if (response.status === 401) {
      await signOut(auth);
      window.location.replace('/admin/login?session=expired');
      return;
    }
    if (response.status === 403) {
      authorizationRejected = true;
      await signOut(auth);
      showStatus('Administrator permission was not accepted. Sign in with an authorized account.', true);
      return;
    }
    if (response.status === 404) {
      showStatus('This reservation no longer exists. Refresh the list and try again.', true);
      return;
    }
    if (response.status === 400) {
      const result = await response.json();
      showStatus(result.error || 'Enter valid reservation details.', true);
      return;
    }
    if (!response.ok) {
      throw new Error('Reservation details could not be updated. Please try again.');
    }

    const updated = await response.json();
    selectedReservation = { ...selectedReservation, ...updated };
    reservations = reservations.map((reservation) =>
      reservation.id === updated.id ? { ...reservation, ...updated } : reservation
    );
    showReservationDetails(selectedReservation);
    resetReservationEdit();
    renderReservations();
    showStatus('Reservation details updated.');
  } catch (error) {
    if (error && String(error.code || '').startsWith('auth/')) {
      await signOut(auth);
      window.location.replace('/admin/login?session=expired');
      return;
    }
    showStatus(error.message || 'Reservation details could not be updated. Please try again.', true);
  } finally {
    reservationUpdateInProgress = false;
    submitButton.disabled = false;
  }
}

function contactMessageMatchesSearch(message) {
  const query = document.getElementById('contact-message-search').value.trim().toLocaleLowerCase();
  if (!query) return true;
  return [message.name, message.email, message.message]
    .some((value) => String(value || '').toLocaleLowerCase().includes(query));
}

function renderContactMessages() {
  const body = document.getElementById('admin-contact-messages');
  const messageStatus = document.getElementById('contact-message-status');
  body.replaceChildren();
  messageStatus.textContent = '';
  const filtered = contactMessages.filter(contactMessageMatchesSearch);
  if (!filtered.length) {
    setTableMessage(
      'admin-contact-messages',
      5,
      contactMessages.length ? 'No messages match this search.' : 'No contact messages found.'
    );
    return;
  }
  filtered.forEach((message) => {
    const row = document.createElement('tr');
    addCell(row, message.name);
    addCell(row, message.email);
    addCell(row, message.message);
    addCell(row, formatCreatedAt(message.createdAt));
    const actionCell = document.createElement('td');
    const deleteButton = document.createElement('button');
    deleteButton.className = 'admin-danger-button';
    deleteButton.type = 'button';
    deleteButton.textContent = 'Delete';
    deleteButton.addEventListener('click', () => deleteContactMessage(message, deleteButton));
    actionCell.appendChild(deleteButton);
    row.appendChild(actionCell);
    body.appendChild(row);
  });
}

function renderRoomInformation() {
  const category = document.getElementById('room-information-category');
  const room = roomInformation.find((item) => item.key === category.value) || roomInformation[0];
  if (!room) return;
  category.value = room.key;
  document.getElementById('room-information-description').value = room.description;
  document.getElementById('room-information-price').value = String(room.priceKrw);
  document.getElementById('save-room-information').disabled = false;
  const roomStatus = document.getElementById('room-information-status');
  roomStatus.textContent = '';
  roomStatus.classList.remove('is-error');
}

async function saveRoomInformation(event) {
  event.preventDefault();
  if (roomInformationSaveInProgress) return;
  const category = document.getElementById('room-information-category').value;
  const description = document.getElementById('room-information-description').value.trim();
  const priceKrw = Number(document.getElementById('room-information-price').value);
  const form = document.getElementById('room-information-form');
  const saveButton = document.getElementById('save-room-information');
  const roomStatus = document.getElementById('room-information-status');
  roomInformationSaveInProgress = true;
  [...form.elements].forEach((element) => { element.disabled = true; });
  roomStatus.textContent = 'Saving room information…';
  roomStatus.classList.remove('is-error');
  try {
    const idToken = await auth.currentUser.getIdToken();
    const response = await fetch(`/api/rooms/${encodeURIComponent(category)}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${idToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ description, priceKrw }),
      cache: 'no-store'
    });
    if (response.status === 401) {
      await signOut(auth);
      window.location.replace('/admin/login?session=expired');
      return;
    }
    if (response.status === 403) {
      authorizationRejected = true;
      await signOut(auth);
      roomStatus.textContent = 'Administrator permission was not accepted. Sign in with an authorized account.';
      roomStatus.classList.add('is-error');
      return;
    }
    if (response.status === 400) {
      const result = await response.json();
      throw new Error(result.error || 'Enter a valid description and whole-number price.');
    }
    if (response.status === 404) {
      throw new Error('Room category not found. Reload the dashboard and try again.');
    }
    if (!response.ok) {
      throw new Error('Room information could not be saved. Please try again.');
    }

    const updated = await response.json();
    roomInformation = roomInformation.map((room) => room.key === updated.key ? updated : room);
    roomStatus.textContent = 'Room information saved.';
    roomStatus.classList.remove('is-error');
  } catch (error) {
    if (error && String(error.code || '').startsWith('auth/')) {
      await signOut(auth);
      window.location.replace('/admin/login?session=expired');
      return;
    }
    roomStatus.textContent = error.message || 'Room information could not be saved. Please try again.';
    roomStatus.classList.add('is-error');
  } finally {
    roomInformationSaveInProgress = false;
    [...form.elements].forEach((element) => { element.disabled = false; });
    saveButton.disabled = roomInformation.length !== 3;
  }
}

async function deleteContactMessage(message, button) {
  if (!window.confirm('Delete this contact message? This cannot be undone.')) return;
  const messageStatus = document.getElementById('contact-message-status');
  button.disabled = true;
  messageStatus.textContent = 'Deleting contact message…';
  messageStatus.classList.remove('is-error');
  try {
    const idToken = await auth.currentUser.getIdToken();
    const response = await fetch(`/api/contact/${encodeURIComponent(message.id)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${idToken}` },
      cache: 'no-store'
    });
    if (response.status === 401) {
      await signOut(auth);
      window.location.replace('/admin/login?session=expired');
      return;
    }
    if (response.status === 403) {
      authorizationRejected = true;
      await signOut(auth);
      messageStatus.textContent = 'Administrator permission was not accepted. Sign in with an authorized account.';
      messageStatus.classList.add('is-error');
      return;
    }
    if (response.status === 404) {
      messageStatus.textContent = 'This contact message no longer exists. Refresh the list and try again.';
      messageStatus.classList.add('is-error');
      return;
    }
    if (!response.ok) {
      throw new Error('The contact message could not be deleted. Please try again.');
    }
    contactMessages = contactMessages.filter((item) => item.id !== message.id);
    renderContactMessages();
    messageStatus.textContent = 'Contact message deleted.';
  } catch (error) {
    if (error && String(error.code || '').startsWith('auth/')) {
      await signOut(auth);
      window.location.replace('/admin/login?session=expired');
      return;
    }
    messageStatus.textContent = error.message || 'The contact message could not be deleted. Please try again.';
    messageStatus.classList.add('is-error');
  } finally {
    button.disabled = false;
  }
}

async function deleteSelectedReservation() {
  if (!selectedReservation || !window.confirm('Cancel and delete this reservation? This cannot be undone.')) return;
  const deleteButton = document.getElementById('delete-reservation');
  deleteButton.disabled = true;
  showStatus('Cancelling reservation…');
  try {
    const idToken = await auth.currentUser.getIdToken();
    const response = await fetch(`/api/reservations/${encodeURIComponent(selectedReservation.id)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${idToken}` },
      cache: 'no-store'
    });
    if (response.status === 401) {
      await signOut(auth);
      window.location.replace('/admin/login?session=expired');
      return;
    }
    if (response.status === 403) {
      authorizationRejected = true;
      await signOut(auth);
      showStatus('Administrator permission was not accepted. Sign in with an authorized account.', true);
      return;
    }
    if (response.status === 404) {
      throw new Error('This reservation no longer exists. Refresh the list and try again.');
    }
    if (!response.ok) {
      throw new Error('The reservation could not be cancelled. Please try again.');
    }
    const guestName = selectedReservation.name || 'The reservation';
    reservations = reservations.filter((reservation) => reservation.id !== selectedReservation.id);
    closeReservationDetails();
    renderReservations();
    showStatus(`${guestName}'s reservation was cancelled.`);
  } catch (error) {
    if (error && String(error.code || '').startsWith('auth/')) {
      await signOut(auth);
      window.location.replace('/admin/login?session=expired');
      return;
    }
    showStatus(error.message || 'The reservation could not be cancelled. Please try again.', true);
  } finally {
    deleteButton.disabled = false;
  }
}

async function handleDashboardUser(user) {
  if (dashboardLoading) return;
  dashboardLoading = true;
  try {
    if (!await hasAdminClaim(user)) {
      authorizationRejected = true;
      await signOut(auth);
      showStatus('Administrator permission is required. Sign in with an authorized account.', true);
      return;
    }
    accountLabel.textContent = user.email || 'Administrator';
    showStatus('Loading protected dashboard data…');
    await fetchAdminData(user);
    if (status.textContent === 'Loading protected dashboard data…') {
      showStatus('');
    }
  } catch (error) {
    if (error && String(error.code || '').startsWith('auth/')) {
      await signOut(auth);
      window.location.replace('/admin/login?session=expired');
      return;
    }
    showStatus(error.message || 'Your session could not be verified. Please sign in again.', true);
    const contactBody = document.getElementById('admin-contact-messages');
    if (contactBody && contactBody.textContent.includes('Loading contact messages')) {
      setTableMessage('admin-contact-messages', 5, 'Contact messages could not be loaded.');
    }
    const roomStatus = document.getElementById('room-information-status');
    if (roomStatus && roomStatus.textContent.includes('Loading room information')) {
      roomStatus.textContent = 'Room information could not be loaded.';
      roomStatus.classList.add('is-error');
    }
  } finally {
    dashboardLoading = false;
  }
}

async function initialize() {
  try {
    auth = await loadAuth();
  } catch (error) {
    showStatus(error.message || 'Admin sign-in is unavailable.', true);
    if (loginForm) loginForm.querySelector('button').disabled = true;
    const contactBody = document.getElementById('admin-contact-messages');
    if (contactBody && contactBody.textContent.includes('Loading contact messages')) {
      setTableMessage('admin-contact-messages', 5, 'Contact messages are unavailable.');
    }
    const roomStatus = document.getElementById('room-information-status');
    if (roomStatus) {
      roomStatus.textContent = 'Room information is unavailable.';
      roomStatus.classList.add('is-error');
    }
    return;
  }

  if (loginForm) {
    const query = new URLSearchParams(window.location.search);
    if (query.get('session') === 'expired') {
      showStatus('Your session expired or is invalid. Please sign in again.', true);
    }
    onAuthStateChanged(auth, async (user) => {
      if (!user || signingIn) return;
      try {
        if (await hasAdminClaim(user)) {
          window.location.replace('/admin');
        } else {
          await signOut(auth);
          showStatus('Administrator permission is required for this account.', true);
        }
      } catch {
        await signOut(auth);
        showStatus('Your session could not be verified. Please sign in again.', true);
      }
    });
    loginForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = document.getElementById('admin-login-button');
      button.disabled = true;
      signingIn = true;
      showStatus('Signing in…');
      try {
        const email = document.getElementById('admin-email').value.trim();
        const password = document.getElementById('admin-password').value;
        const credential = await signInWithEmailAndPassword(auth, email, password);
        if (!await hasAdminClaim(credential.user)) {
          await signOut(auth);
          showStatus('Administrator permission is required for this account.', true);
          return;
        }
        window.location.replace('/admin');
      } catch (error) {
        const message = error.code === 'auth/invalid-credential' ||
          error.code === 'auth/user-not-found' ||
          error.code === 'auth/wrong-password'
          ? 'Email or password was not accepted.'
          : 'Sign-in failed. Check your connection and try again.';
        showStatus(message, true);
      } finally {
        signingIn = false;
        button.disabled = false;
      }
    });
    return;
  }

  if (signOutButton) {
    signOutButton.addEventListener('click', async () => {
      signOutButton.disabled = true;
      signingOutByChoice = true;
      try {
        await signOut(auth);
        window.location.replace('/admin/login');
      } catch {
        signingOutByChoice = false;
        showStatus('Sign out failed. Please try again.', true);
        signOutButton.disabled = false;
      }
    });
  }
  document.getElementById('reservation-search').addEventListener('input', renderReservations);
  document.getElementById('reservation-room-filter').addEventListener('change', renderReservations);
  document.getElementById('reservation-date-filter').addEventListener('change', renderReservations);
  document.getElementById('contact-message-search').addEventListener('input', renderContactMessages);
  document.getElementById('close-reservation-details').addEventListener('click', closeReservationDetails);
  document.getElementById('edit-reservation').addEventListener('click', startReservationEdit);
  document.getElementById('edit-reservation-form').addEventListener('submit', updateSelectedReservation);
  document.getElementById('cancel-reservation-edit').addEventListener('click', resetReservationEdit);
  document.getElementById('delete-reservation').addEventListener('click', deleteSelectedReservation);
  document.getElementById('room-information-category').addEventListener('change', renderRoomInformation);
  document.getElementById('room-information-form').addEventListener('submit', saveRoomInformation);
  onAuthStateChanged(auth, (user) => {
    if (!user) {
      if (signingOutByChoice || authorizationRejected) return;
      window.location.replace('/admin/login?session=expired');
      return;
    }
    handleDashboardUser(user);
  });
}

initialize();
