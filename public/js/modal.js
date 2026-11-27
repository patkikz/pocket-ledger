const CLOSE_ICON_SVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

export function openModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove('hidden');
}

export function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.add('hidden');
}

export function closeAllModals() {
  document.querySelectorAll('.modal-overlay:not(.confirm-overlay)').forEach((el) => el.classList.add('hidden'));
}

export function initModalComponents() {
  document.querySelectorAll('.modal-overlay[data-modal-title]').forEach((overlay) => {
    const sheet = overlay.querySelector('.modal-sheet');
    if (!sheet || sheet.querySelector('.modal-header')) return;
    const header = document.createElement('div');
    header.className = 'modal-header';

    const title = document.createElement('h2');
    const titleId = overlay.getAttribute('aria-labelledby');
    if (titleId) title.id = titleId;
    title.className = 'modal-title';
    title.textContent = overlay.dataset.modalTitle;

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'icon-btn';
    closeBtn.dataset.closeModal = overlay.id;
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.innerHTML = CLOSE_ICON_SVG;

    header.append(title, closeBtn);
    sheet.prepend(header);
  });

  document.addEventListener('click', (e) => {
    const closeBtn = e.target.closest('[data-close-modal]');
    if (closeBtn) {
      closeModal(closeBtn.dataset.closeModal);
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeAllModals();
  });
}
