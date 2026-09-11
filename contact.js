(function () {
  const form = document.getElementById('contact-form');
  const formMessage = document.getElementById('contact-form-message');
  const submitBtn = document.getElementById('contact-submit-btn');
  const messageField = document.getElementById('contact-message');
  const modal = document.getElementById('contact-modal');
  const modalTitle = document.getElementById('contact-modal-title');
  const modalText = document.getElementById('contact-modal-text');
  const modalCloseBtn = document.getElementById('contact-modal-close');

  function showMessage(text, isError) {
    formMessage.textContent = text;
    formMessage.style.color = isError ? 'var(--rust-bright)' : 'var(--sage-bright)';
  }

  function openModal(title, text) {
    modalTitle.textContent = title;
    modalText.textContent = text;
    modal.classList.remove('hidden');
  }

  function closeModal() {
    modal.classList.add('hidden');
  }

  function setupCharCounter() {
    if (!messageField) return null;

    const counter = document.createElement('p');
    counter.className = 'char-counter';
    counter.id = 'contact-char-counter';
    messageField.insertAdjacentElement('afterend', counter);

    const update = () => {
      const max = messageField.getAttribute('maxlength') || 1000;
      counter.textContent = messageField.value.length + ' / ' + max;
    };

    messageField.addEventListener('input', update);
    update();
    return counter;
  }

  async function saveMessage(entry) {
    const response = await fetch('/api/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry)
    });

    if (!response.ok) {
      throw new Error('Failed to save contact message');
    }
  }

  function init() {
    const counter = setupCharCounter();

    if (!form) return;

    form.addEventListener('submit', async (event) => {
      event.preventDefault();

      const name = document.getElementById('contact-name').value.trim();
      const email = document.getElementById('contact-email').value.trim();
      const subject = document.getElementById('contact-subject').value;
      const message = messageField.value.trim();

      if (!name || !email || !subject || !message) {
        showMessage('Please fill in every field before sending.', true);
        return;
      }

      const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailPattern.test(email)) {
        showMessage('That email address does not look right.', true);
        return;
      }

      submitBtn.disabled = true;
      submitBtn.textContent = 'Sending...';

      try {
        await saveMessage({
          name: name,
          email: email,
          subject: subject,
          message: message,
          createdAt: new Date().toISOString()
        });

        showMessage('Message sent, thanks for reaching out.', false);
        form.reset();
        if (counter) {
          counter.textContent = '0 / ' + (messageField.getAttribute('maxlength') || 1000);
        }

        submitBtn.disabled = false;
        submitBtn.textContent = 'Send Message';

        openModal('Message Sent', 'Thanks, ' + name + '. We will get back to you within 24 hours.');
      } catch (error) {
        showMessage('We were unable to send your message right now. Please try again.', true);
        submitBtn.disabled = false;
        submitBtn.textContent = 'Send Message';
      }
    });

    if (modalCloseBtn) {
      modalCloseBtn.addEventListener('click', closeModal);
    }
    if (modal) {
      modal.addEventListener('click', (event) => {
        if (event.target === modal) closeModal();
      });
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
