(function () {
  const toggle = document.getElementById('nav-toggle');
  const menu = document.getElementById('nav-menu');
  if (!toggle || !menu) return;

  toggle.addEventListener('click', () => {
    menu.classList.toggle('open');
  });

  // Close the menu once a link is chosen (mobile)
  menu.querySelectorAll('.nav-link').forEach((link) => {
    link.addEventListener('click', () => menu.classList.remove('open'));
  });

  // Close the menu on outside click
  document.addEventListener('click', (event) => {
    if (!menu.classList.contains('open')) return;
    if (menu.contains(event.target) || toggle.contains(event.target)) return;
    menu.classList.remove('open');
  });
})();
