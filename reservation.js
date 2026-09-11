(function () {
  const GUEST_ID_KEY = 'hoteldelluna_guest_id';

  const GUEST_LABELS = {
    '1': '1 Guest',
    '2': '2 Guests',
    '3': '3 Guests',
    '4': '4 Guests'
  };

  const form = document.getElementById('reservation-form');
  const formMessage = document.getElementById('form-message');
  const submitBtn = document.getElementById('submit-btn');
  const userIdDisplay = document.getElementById('user-id-display');
  const storageStatus = document.getElementById('storage-status');
  const reservationsList = document.getElementById('reservations-list');
  const refreshBtn = document.getElementById('refresh-btn');
  const modal = document.getElementById('modal-container');
  const modalTitle = document.getElementById('modal-title');
  const modalContent = document.getElementById('modal-content');
  const modalCloseBtn = document.getElementById('modal-close-btn');

  let pendingCancelId = null;

  function storageAvailable() {
    return true;
  }

  function getGuestId() {
    let id = localStorage.getItem(GUEST_ID_KEY);
    if (!id) {
      id = 'guest-' + Math.random().toString(36).slice(2, 8).toUpperCase();
      localStorage.setItem(GUEST_ID_KEY, id);
    }
    return id;
  }

  async function getReservations() {
    try {
      const response = await fetch(`/api/reservations?guestId=${encodeURIComponent(getGuestId())}`);
      if (!response.ok) throw new Error('Failed to load reservations');
      return await response.json();
    } catch (e) {
      return [];
    }
  }

  async function saveReservations(list) {
    if (!list || !list.length) return;
    return fetch('/api/reservations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(list[list.length - 1])
    });
  }

  function formatDate(dateStr) {
    if (!dateStr) return '';
    const parsed = new Date(dateStr + 'T00:00:00');
    if (isNaN(parsed.getTime())) return dateStr;
    return parsed.toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function showMessage(text, isError) {
    formMessage.textContent = text;
    formMessage.style.color = isError ? 'var(--rust-bright)' : 'var(--sage-bright)';
  }

  function openModal(title, text, closeLabel) {
    modalTitle.textContent = title;
    modalContent.textContent = text;
    modalCloseBtn.textContent = closeLabel || 'Close';
    modal.classList.remove('hidden');
  }

  function closeModal() {
    modal.classList.add('hidden');
    modalCloseBtn.textContent = 'Close';
    pendingCancelId = null;
  }

  async function renderReservations() {
    const guestId = getGuestId();
    const mine = await getReservations();

    reservationsList.innerHTML = '';

    if (!mine.length) {
      const empty = document.createElement('p');
      empty.className = 'empty-state';
      empty.textContent = 'No reservations yet, the house is waiting.';
      reservationsList.appendChild(empty);
      return;
    }

    mine
      .slice()
      .sort((a, b) => (a.checkInDate + a.checkOutDate).localeCompare(b.checkInDate + b.checkOutDate))
      .forEach((r) => {
        const card = document.createElement('div');
        card.className = 'reservation-card';
        card.innerHTML =
          '<div style="display:flex; justify-content:space-between; align-items:flex-start; gap:1rem; flex-wrap:wrap;">' +
            '<div>' +
              '<p style="font-family: var(--font-display); font-size: 1.1rem; color: var(--text-primary);">' + escapeHtml(r.name) + '</p>' +
              '<p style="color: var(--text-muted); font-size: 0.85rem; margin-top: 0.3rem;">' +
                formatDate(r.checkInDate) + ' to ' + formatDate(r.checkOutDate) + ' &middot; ' + escapeHtml(r.roomName) + ' &middot; ' + (GUEST_LABELS[r.guests] || r.guests) +
              '</p>' +
            '</div>' +
            '<button class="btn-cancel" data-id="' + r.id + '">Cancel</button>' +
          '</div>';
        reservationsList.appendChild(card);
      });

    reservationsList.querySelectorAll('.btn-cancel').forEach((btn) => {
      btn.addEventListener('click', () => {
        pendingCancelId = btn.getAttribute('data-id');
        openModal(
          'Cancel this reservation?',
          'We will release your room so another guest can reserve it. This cannot be undone.',
          'Yes, Cancel'
        );
      });
    });
  }

  function init() {
    if (userIdDisplay) {
      userIdDisplay.textContent = 'Your Reservation ID: ' + getGuestId();
    }

    if (storageStatus) {
      storageStatus.textContent = storageAvailable()
        ? 'Your guest ID is stored in this browser so your reservations can be retrieved.'
        : 'Local storage is unavailable in this browser, so reservations will not be saved after you close this tab.';
    }

    const checkInField = document.getElementById('check-in');
    if (checkInField) {
      checkInField.min = new Date().toISOString().split('T')[0];
    }

    renderReservations();

    if (form) {
      form.addEventListener('submit', async (event) => {
        event.preventDefault();

        const name = document.getElementById('name').value.trim();
        const email = document.getElementById('email').value.trim();
        const checkInDate = document.getElementById('check-in').value;
        const checkOutDate = document.getElementById('check-out').value;
        const roomName = document.getElementById('room-type').value;
        const guests = Number(document.getElementById('guests').value);

        if (!name || !email || !checkInDate || !checkOutDate) {
          showMessage('Please fill in your name, email, check-in date, and check-out date.', true);
          return;
        }

        if (checkOutDate <= checkInDate) {
          showMessage('Check-out must be after check-in.', true);
          return;
        }

        const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailPattern.test(email)) {
          showMessage('That email address does not look right, check it and try again.', true);
          return;
        }

        submitBtn.disabled = true;
        submitBtn.textContent = 'Confirming...';

        try {
          const reservation = {
            guestId: getGuestId(),
            name: name,
            email: email,
            checkInDate: checkInDate,
            checkOutDate: checkOutDate,
            roomName: roomName,
            guests: guests,
          };

          const response = await fetch('/api/reservations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(reservation)
          });

          if (!response.ok) {
            throw new Error('Reservation save failed');
          }

          await renderReservations();
          showMessage('Reservation confirmed, see you then.', false);
          form.reset();
          document.getElementById('guests').value = '2';

          submitBtn.disabled = false;
          submitBtn.textContent = 'Confirm Reservation';

          openModal(
            'Stay Reserved',
            'Thanks, ' + name + '. We have saved your stay from ' + formatDate(checkInDate) + ' to ' + formatDate(checkOutDate) + '.'
          );
        } catch (error) {
          showMessage('We were unable to save your reservation right now. Please try again.', true);
          submitBtn.disabled = false;
          submitBtn.textContent = 'Confirm Reservation';
        }
      });
    }

    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => {
        renderReservations();
        showMessage('Reservation list refreshed.', false);
      });
    }

    if (modalCloseBtn) {
      modalCloseBtn.addEventListener('click', async () => {
        if (pendingCancelId) {
          const response = await fetch(`/api/reservations/${encodeURIComponent(pendingCancelId)}`, {
            method: 'DELETE'
          });

          if (response.ok) {
            await renderReservations();
            showMessage('Reservation cancelled.', false);
          }
        }
        closeModal();
      });
    }

    if (modal) {
      modal.addEventListener('click', (event) => {
        if (event.target === modal) closeModal();
      });
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
