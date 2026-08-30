export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char]);
}

/**
 * Sanitize application-generated rich HTML before putting it in a modal.
 * This keeps the existing formatted modal API while removing script-capable
 * elements, inline event handlers, and dangerous URL schemes.
 */
function sanitizeRichHtml(html) {
  const template = document.createElement('template');
  template.innerHTML = String(html ?? '');

  const blockedTags = new Set([
    'SCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'MATH', 'STYLE', 'LINK', 'META', 'BASE'
  ]);
  const urlAttributes = new Set(['href', 'src', 'xlink:href', 'formaction']);

  const nodes = template.content.querySelectorAll('*');
  for (const node of nodes) {
    if (blockedTags.has(node.tagName)) {
      node.remove();
      continue;
    }

    for (const attr of [...node.attributes]) {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim();
      if (name.startsWith('on') || name === 'srcdoc') {
        node.removeAttribute(attr.name);
        continue;
      }
      if (urlAttributes.has(name) && /^(?:javascript|vbscript|data):/i.test(value)) {
        node.removeAttribute(attr.name);
      }
    }
  }

  return template.content;
}

export function showLoading() {
  document.getElementById('loading').classList.remove('hidden');
}

export function hideLoading() {
  document.getElementById('loading').classList.add('hidden');
}

export function showError(message, container = 'auth-error') {
  const errorEl = document.getElementById(container);
  if (errorEl) {
    errorEl.textContent = message;
    errorEl.classList.remove('hidden');

    setTimeout(() => {
      errorEl.classList.add('hidden');
    }, 5000);
  }
}

/**
 * Show a modal with a plain-text title and sanitized rich application content.
 */
export function showModal(title, content) {
  const modal = document.getElementById('modal');
  const modalBody = document.getElementById('modal-body');

  modalBody.replaceChildren();
  const heading = document.createElement('h2');
  heading.textContent = String(title ?? '');
  modalBody.appendChild(heading);

  const body = document.createElement('div');
  body.appendChild(sanitizeRichHtml(content));
  modalBody.appendChild(body);

  modal.classList.remove('hidden');
}

export function hideModal() {
  document.getElementById('modal').classList.add('hidden');
}

export function openModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove('hidden');
  return el;
}

export function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.add('hidden');
  return el;
}

export const openDrawer = openModal;
export const closeDrawer = closeModal;

function closeTopLayer() {
  const layers = document.querySelectorAll(
    '.modal:not(.hidden):not([data-persist]), .drawer:not(.hidden):not([data-persist])'
  );
  const top = layers[layers.length - 1];
  if (top) top.classList.add('hidden');
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeTopLayer();
});

document.addEventListener('click', (e) => {
  const closer = e.target.closest('.modal-close, .drawer-close, [data-close]');
  if (closer) {
    const layer = closer.closest('.modal, .drawer');
    if (layer) {
      layer.classList.add('hidden');
      return;
    }
  }
  if (
    (e.target.classList.contains('modal') || e.target.classList.contains('drawer')) &&
    !e.target.hasAttribute('data-persist')
  ) {
    e.target.classList.add('hidden');
  }
});

export function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

export function formatMana(manaCost) {
  if (!manaCost) return '';

  return manaCost.replace(/\{([^}]+)\}/g, (match, symbol) => {
    const sym = symbol.toLowerCase()
      .replace('/', '')
      .replace('p', 'p');

    if (symbol.includes('/')) {
      const parts = symbol.split('/');
      return `<i class="ms ms-${parts[0].toLowerCase()}${parts[1].toLowerCase()} ms-split"></i>`;
    }

    return `<i class="ms ms-${sym} ms-cost"></i>`;
  });
}

export function formatDate(dateString) {
  const date = new Date(dateString);
  return date.toLocaleDateString();
}

export function formatOracleText(text) {
  if (!text) return '';
  return text.replace(/\\n/g, '<br>').replace(/\n/g, '<br>');
}

export function showToast(message, type = 'success', duration = 3000) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }

  const icons = {
    success: 'ph-check-circle',
    error: 'ph-x-circle',
    warning: 'ph-warning',
    info: 'ph-info',
  };

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;

  const icon = document.createElement('i');
  icon.className = `ph-fill ${icons[type] || icons.info}`;
  const text = document.createElement('span');
  text.textContent = message;
  toast.append(icon, text);

  const dismiss = () => {
    toast.classList.add('toast-out');
    setTimeout(() => toast.remove(), 250);
  };
  toast.addEventListener('click', dismiss);
  container.appendChild(toast);

  if (duration) setTimeout(dismiss, duration);
}

export function confirmDialog({
  title = 'Are you sure?',
  message = '',
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  danger = false,
  icon,
} = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal';
    const allowedIcons = new Set(['ph-warning', 'ph-question', 'ph-trash', 'ph-info']);
    const requestedIcon = icon || (danger ? 'ph-warning' : 'ph-question');
    const iconName = allowedIcons.has(requestedIcon) ? requestedIcon : 'ph-question';
    overlay.innerHTML = `
      <div class="modal-content modal-sm confirm-dialog ${danger ? 'confirm-danger' : ''}">
        <div class="confirm-icon"><i class="ph-fill ${iconName}"></i></div>
        <h2>${escapeHtml(title)}</h2>
        ${message ? `<p>${escapeHtml(message)}</p>` : ''}
        <div class="modal-footer">
          <button class="btn btn-ghost" data-act="cancel">${escapeHtml(cancelText)}</button>
          <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-act="ok">${escapeHtml(confirmText)}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const done = (val) => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(val);
    };
    overlay.querySelector('[data-act="ok"]').addEventListener('click', () => done(true));
    overlay.querySelector('[data-act="cancel"]').addEventListener('click', () => done(false));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) done(false);
    });
    const onKey = (e) => {
      if (e.key === 'Escape') done(false);
      else if (e.key === 'Enter') done(true);
    };
    document.addEventListener('keydown', onKey);
    overlay.querySelector('[data-act="ok"]').focus();
  });
}

export function popover(anchorEl, contentEl, { align = 'left', gap = 6 } = {}) {
  const pop = document.createElement('div');
  pop.className = 'popover';
  pop.appendChild(contentEl);
  document.body.appendChild(pop);

  const r = anchorEl.getBoundingClientRect();
  pop.style.top = `${r.bottom + window.scrollY + gap}px`;
  const rawLeft = align === 'right'
    ? r.right + window.scrollX - pop.offsetWidth
    : r.left + window.scrollX;
  const maxLeft = window.scrollX + document.documentElement.clientWidth - pop.offsetWidth - 8;
  pop.style.left = `${Math.max(8, Math.min(rawLeft, maxLeft))}px`;

  const close = () => {
    pop.remove();
    document.removeEventListener('mousedown', onDoc, true);
    document.removeEventListener('keydown', onKey);
  };
  const onDoc = (e) => {
    if (!pop.contains(e.target) && !anchorEl.contains(e.target)) close();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };
  setTimeout(() => {
    document.addEventListener('mousedown', onDoc, true);
    document.addEventListener('keydown', onKey);
  }, 0);

  return { el: pop, close };
}
