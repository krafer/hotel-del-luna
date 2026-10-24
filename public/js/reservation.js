(function () {
  const GUEST_LABELS = {
    '1': '1 Guest',
    '2': '2 Guests',
    '3': '3 Guests',
    '4': '4 Guests'
  };

  const form = document.getElementById('reservation-form');
  const formMessage = document.getElementById('form-message');
  const submitBtn = document.getElementById('submit-btn');
  const reservationsList = document.getElementById('reservations-list');
  const refreshBtn = document.getElementById('refresh-btn');
  const modal = document.getElementById('modal-container');
  const modalTitle = document.getElementById('modal-title');
  const modalContent = document.getElementById('modal-content');
  const modalCloseBtn = document.getElementById('modal-close-btn');
  const IDEMPOTENCY_STORAGE_KEY = 'hotel_pending_reservation';

  let pendingCancelId = null;

  function formatDateInput(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function getBookingWindow() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const max = new Date(today);
    max.setFullYear(max.getFullYear() + 1);

    return { today, max };
  }

  function isReasonableReservationDate(dateValue) {
    if (typeof dateValue !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) {
      return false;
    }

    const parsed = new Date(dateValue + 'T00:00:00');
    if (Number.isNaN(parsed.getTime())) {
      return false;
    }

    const { today, max } = getBookingWindow();
    const year = parsed.getFullYear();

    if (year < today.getFullYear() || year > max.getFullYear()) {
      return false;
    }

    return parsed >= today && parsed <= max;
  }

  function bindDateConstraints() {
    const checkInField = document.getElementById('check-in');
    const checkOutField = document.getElementById('check-out');
    if (!checkInField || !checkOutField) return;

    const { today, max } = getBookingWindow();
    checkInField.min = formatDateInput(today);
    checkInField.max = formatDateInput(max);
    checkOutField.min = formatDateInput(today);
    checkOutField.max = formatDateInput(max);

    if (checkInField.value && !isReasonableReservationDate(checkInField.value)) {
      checkInField.value = formatDateInput(today);
    }

    if (checkInField.value) {
      const minCheckout = new Date(checkInField.value + 'T00:00:00');
      minCheckout.setDate(minCheckout.getDate() + 1);
      checkOutField.min = formatDateInput(minCheckout);
    }

    if (checkOutField.value && checkOutField.value <= checkInField.value) {
      checkOutField.value = '';
    }
  }

  function selectRoomFromUrl() {
    const roomSelect = document.getElementById('room-type');
    const requestedRoom = new URLSearchParams(window.location.search).get('room');
    if (!roomSelect || !requestedRoom) return;

    const matchingOption = Array.from(roomSelect.options).find((option) => option.value === requestedRoom);
    if (matchingOption) {
      roomSelect.value = matchingOption.value;
    }
  }

  async function getReservations() {
    const response = await fetch('/api/reservations');
    if (!response.ok) {
      throw new Error(response.status === 401
        ? 'Reservation history requires a signed-in account. Sign-in is not available on this page yet.'
        : 'Unable to load reservations right now.');
    }
    return response.json();
  }

  function getIdempotencyKey(reservation) {
    const reservationJson = JSON.stringify(reservation);
    const pending = sessionStorage.getItem(IDEMPOTENCY_STORAGE_KEY);
    if (pending) {
      const saved = JSON.parse(pending);
      if (saved.reservationJson === reservationJson && typeof saved.key === 'string') {
        return saved.key;
      }
    }

    const key = window.crypto.randomUUID();
    sessionStorage.setItem(IDEMPOTENCY_STORAGE_KEY, JSON.stringify({ key, reservationJson }));
    return key;
  }

  function clearIdempotencyKey(key) {
    const pending = sessionStorage.getItem(IDEMPOTENCY_STORAGE_KEY);
    if (pending && JSON.parse(pending).key === key) {
      sessionStorage.removeItem(IDEMPOTENCY_STORAGE_KEY);
    }
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
    let mine;
    reservationsList.replaceChildren();
    try {
      mine = await getReservations();
    } catch (error) {
      const unavailable = document.createElement('p');
      unavailable.className = 'empty-state';
      unavailable.textContent = error.message;
      reservationsList.appendChild(unavailable);
      return false;
    }

    if (!mine.length) {
      const empty = document.createElement('p');
      empty.className = 'empty-state';
      empty.textContent = 'No reservations yet, the house is waiting.';
      reservationsList.appendChild(empty);
      return true;
    }

    mine
      .slice()
      .sort((a, b) => (a.checkInDate + a.checkOutDate).localeCompare(b.checkInDate + b.checkOutDate))
      .forEach((r) => {
        const card = document.createElement('div');
        card.className = 'reservation-card';
        const layout = document.createElement('div');
        layout.style.cssText = 'display:flex; justify-content:space-between; align-items:flex-start; gap:1rem; flex-wrap:wrap;';

        const details = document.createElement('div');
        const name = document.createElement('p');
        name.style.cssText = 'font-family: var(--font-display); font-size: 1.1rem; color: var(--text-primary);';
        name.textContent = String(r.name);

        const dates = document.createElement('p');
        dates.style.cssText = 'color: var(--text-muted); font-size: 0.85rem; margin-top: 0.3rem;';
        dates.textContent = `${formatDate(r.checkInDate)} to ${formatDate(r.checkOutDate)} \u00b7 ${String(r.roomName)} \u00b7 ${GUEST_LABELS[r.guests] || String(r.guests)}`;

        const cancelButton = document.createElement('button');
        cancelButton.type = 'button';
        cancelButton.className = 'btn-cancel';
        cancelButton.dataset.id = String(r.id);
        cancelButton.textContent = 'Cancel';

        details.appendChild(name);
        details.appendChild(dates);
        layout.appendChild(details);
        layout.appendChild(cancelButton);
        card.appendChild(layout);
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
    return true;
  }

  function init() {
    bindDateConstraints();
    selectRoomFromUrl();
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

        if (!isReasonableReservationDate(checkInDate) || !isReasonableReservationDate(checkOutDate)) {
          showMessage('Please choose a check-in and check-out date within the next year.', true);
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
            name: name,
            email: email,
            checkInDate: checkInDate,
            checkOutDate: checkOutDate,
            roomName: roomName,
            guests: guests,
          };

          const idempotencyKey = getIdempotencyKey(reservation);
          const response = await fetch('/api/reservations', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Idempotency-Key': idempotencyKey
            },
            body: JSON.stringify(reservation)
          });

          let serverMessage = 'Reservation save failed';
          if (!response.ok) {
            if (response.status < 500) {
              clearIdempotencyKey(idempotencyKey);
            }
            try {
              const payload = await response.json();
              if (payload && payload.error) {
                serverMessage = payload.error;
              }
            } catch (error) {
              try {
                const text = await response.text();
                if (text) {
                  serverMessage = text;
                }
              } catch (textError) {
                serverMessage = 'Reservation save failed';
              }
            }
            throw new Error(serverMessage);
          }

          clearIdempotencyKey(idempotencyKey);
          await renderReservations();
          showMessage('Reservation confirmed, see you then.', false);
          form.reset();
          document.getElementById('guests').value = '2';
          bindDateConstraints();

          submitBtn.disabled = false;
          submitBtn.textContent = 'Confirm Reservation';

          openModal(
            'Stay Reserved',
            'Thanks, ' + name + '. We have saved your stay from ' + formatDate(checkInDate) + ' to ' + formatDate(checkOutDate) + '.'
          );
        } catch (error) {
          showMessage(error && error.message ? error.message : 'We were unable to save your reservation right now. Please try again.', true);
          submitBtn.disabled = false;
          submitBtn.textContent = 'Confirm Reservation';
        }
      });
    }

    if (refreshBtn) {
      refreshBtn.addEventListener('click', async () => {
        if (await renderReservations()) {
          showMessage('Reservation list refreshed.', false);
        }
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
          } else {
            showMessage(response.status === 401 || response.status === 403
              ? 'Sign in to cancel this reservation.'
              : 'Unable to cancel this reservation right now.', true);
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
