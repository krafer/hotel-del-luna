(() => {
  const roomCards = Array.from(document.querySelectorAll('.room-card'));
  const modal = document.createElement('div');
  modal.className = 'room-modal hidden';
  modal.setAttribute('aria-hidden', 'true');
  modal.innerHTML = `
    <div class="room-modal-box" role="dialog" aria-modal="true" aria-labelledby="room-modal-title">
      <button class="room-modal-close" type="button" aria-label="Close room details">&times;</button>
      <div class="room-modal-image-wrap">
        <img class="room-modal-image" alt="">
        <button class="room-modal-nav room-modal-prev" type="button" aria-label="Previous room image">&#8592;</button>
        <button class="room-modal-nav room-modal-next" type="button" aria-label="Next room image">&#8594;</button>
      </div>
      <div class="room-modal-content">
        <span class="eyebrow" data-modal-type></span>
        <h2 id="room-modal-title" data-modal-name></h2>
        <p data-modal-description></p>
        <p class="room-modal-price" data-modal-price></p>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  const modalImage = modal.querySelector('.room-modal-image');
  const modalType = modal.querySelector('[data-modal-type]');
  const modalName = modal.querySelector('[data-modal-name]');
  const modalDescription = modal.querySelector('[data-modal-description]');
  const modalPrice = modal.querySelector('[data-modal-price]');
  const closeButton = modal.querySelector('.room-modal-close');
  const previousButton = modal.querySelector('.room-modal-prev');
  const nextButton = modal.querySelector('.room-modal-next');
  let activeRoom = null;
  let activeImages = [];
  let activeImageIndex = 0;
  let lastFocusedElement = null;

  function updateModalImage() {
    const image = activeImages[activeImageIndex];
    modalImage.src = image;
    modalImage.alt = `${activeRoom.dataset.roomName} image ${activeImageIndex + 1}`;
    previousButton.disabled = activeImages.length < 2;
    nextButton.disabled = activeImages.length < 2;
  }

  function openRoom(roomCard) {
    activeRoom = roomCard;
    activeImages = roomCard.dataset.roomImages.split('|');
    activeImageIndex = 0;
    lastFocusedElement = document.activeElement;
    modalType.textContent = roomCard.dataset.roomType;
    modalName.textContent = roomCard.dataset.roomName;
    modalDescription.textContent = roomCard.dataset.roomDescription;
    modalPrice.textContent = `${roomCard.dataset.roomPrice} / night`;
    updateModalImage();
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    closeButton.focus();
  }

  function closeRoom() {
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
    if (lastFocusedElement) {
      lastFocusedElement.focus();
    }
  }

  function showAdjacentImage(direction) {
    activeImageIndex = (activeImageIndex + direction + activeImages.length) % activeImages.length;
    updateModalImage();
  }

  roomCards.forEach((roomCard) => {
    roomCard.addEventListener('click', (event) => {
      if (event.target.closest('button, a')) {
        return;
      }
      openRoom(roomCard);
    });

    roomCard.querySelectorAll('.room-feature').forEach((feature) => {
      feature.addEventListener('click', (event) => {
        event.stopPropagation();
        const image = feature.dataset.image;
        roomCard.querySelector('.room-card-image').style.backgroundImage = `linear-gradient(135deg, rgba(42, 38, 80, 0.45), rgba(25, 21, 52, 0.55)), url("${image}")`;
      });
    });
  });

  closeButton.addEventListener('click', closeRoom);
  previousButton.addEventListener('click', () => showAdjacentImage(-1));
  nextButton.addEventListener('click', () => showAdjacentImage(1));

  modal.addEventListener('click', (event) => {
    if (event.target === modal) {
      closeRoom();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (modal.classList.contains('hidden')) {
      return;
    }
    if (event.key === 'Escape') {
      closeRoom();
    } else if (event.key === 'ArrowLeft') {
      showAdjacentImage(-1);
    } else if (event.key === 'ArrowRight') {
      showAdjacentImage(1);
    }
  });
})();
