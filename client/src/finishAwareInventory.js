import api from './services/api.js';
import { showToast } from './utils/ui.js';

let latestOwnership = null;
let nextQuantityFinish = null;
let activeSwapFinish = null;
let initialized = false;

function normalizeFinish(value) {
  const finish = String(value || 'nonfoil').toLowerCase();
  return finish === 'normal' ? 'nonfoil' : finish;
}

function finishLabel(finish) {
  switch (normalizeFinish(finish)) {
    case 'foil': return 'Foil';
    case 'etched': return 'Etched';
    default: return 'Nonfoil';
  }
}

function decorateOwnedPrintingRows() {
  if (!latestOwnership?.ownedPrintings?.length) return;

  const rows = Array.from(document.querySelectorAll('.owned-printing-item'));
  if (rows.length === 0) return;

  // cards.js renders these rows directly from ownership.ownedPrintings, so the
  // response order is the safest way to distinguish two rows that share the
  // same printing_id but have different finishes.
  rows.forEach((row, index) => {
    const owned = latestOwnership.ownedPrintings[index];
    if (!owned) return;

    const finish = normalizeFinish(owned.finish);
    row.dataset.finish = finish;

    row.querySelectorAll(
      '.owned-qty-increase, .owned-qty-decrease, .swap-printing-btn'
    ).forEach(button => {
      button.dataset.finish = finish;
    });

    const preview = row.querySelector('div.printing-preview');
    const titleLine = preview?.children?.[0];
    const detailLine = preview?.children?.[1];

    let badge = titleLine?.querySelector('.owned-finish-badge');
    if (!badge && titleLine) {
      badge = document.createElement('span');
      badge.className = 'owned-finish-badge';
      badge.style.cssText = [
        'margin-left:0.5rem',
        'padding:0.1rem 0.4rem',
        'border-radius:999px',
        'font-size:0.7rem',
        'font-weight:700',
        'vertical-align:middle',
      ].join(';');
      titleLine.appendChild(badge);
    }

    if (badge) {
      const label = finishLabel(finish);
      if (badge.textContent !== label) badge.textContent = label;

      if (finish === 'foil') {
        badge.style.background = 'rgba(245, 158, 11, 0.18)';
        badge.style.color = '#f59e0b';
      } else if (finish === 'etched') {
        badge.style.background = 'rgba(168, 85, 247, 0.18)';
        badge.style.color = '#c084fc';
      } else {
        badge.style.background = 'rgba(148, 163, 184, 0.16)';
        badge.style.color = 'var(--text-secondary)';
      }
    }

    let price = detailLine?.querySelector('.owned-finish-price');
    if (!price && detailLine) {
      price = document.createElement('span');
      price.className = 'owned-finish-price';
      detailLine.appendChild(price);
    }

    if (price) {
      const numericPrice = owned.price == null ? null : Number(owned.price);
      const priceText = Number.isFinite(numericPrice)
        ? ` • ${finishLabel(finish)} $${numericPrice.toFixed(2)}`
        : ` • ${finishLabel(finish)}`;
      if (price.textContent !== priceText) price.textContent = priceText;
    }

    row.style.borderColor = finish === 'foil'
      ? 'rgba(245, 158, 11, 0.55)'
      : finish === 'etched'
        ? 'rgba(168, 85, 247, 0.55)'
        : 'var(--border-color)';
  });
}

function scheduleDecoration() {
  requestAnimationFrame(() => {
    decorateOwnedPrintingRows();
    setTimeout(decorateOwnedPrintingRows, 0);
  });
}

export function setupFinishAwareInventory() {
  if (initialized) return;
  initialized = true;

  const originalGetOwnership = api.getCardOwnershipAndUsage.bind(api);
  api.getCardOwnershipAndUsage = async (cardId) => {
    const result = await originalGetOwnership(cardId);
    latestOwnership = result;
    scheduleDecoration();
    return result;
  };

  // Existing card/inventory components call this method with only printingId
  // and quantity. A capture-phase click records the finish before their normal
  // listener runs, preserving compatibility without duplicating the modal UI.
  api.setOwnedPrintingQuantity = async (printingId, quantity, explicitFinish = null) => {
    let finish = explicitFinish || nextQuantityFinish;
    nextQuantityFinish = null;

    // Legacy bulk-remove paths mean "remove this printing from inventory".
    // With finish-aware ownership that should remove all finishes for the
    // printing, while ordinary adds still default to nonfoil.
    if (!finish && Number(quantity) <= 0) finish = 'all';
    if (!finish) finish = 'nonfoil';

    return api.request(`/cards/printings/${printingId}/quantity`, {
      method: 'POST',
      body: JSON.stringify({ quantity, finish }),
    });
  };

  api.swapOwnedPrinting = async (fromPrintingId, replacementPrintingId, explicitFinish = null) => {
    const finish = explicitFinish || activeSwapFinish || 'nonfoil';
    activeSwapFinish = null;

    const result = await api.request(`/cards/printings/${fromPrintingId}/swap`, {
      method: 'POST',
      body: JSON.stringify({ replacementPrintingId, finish }),
    });

    if (result.deckSyncSkipped) {
      showToast(
        'Inventory updated. Deck printing was left unchanged because both foil and nonfoil copies of the old printing are owned.',
        'warning'
      );
    }

    return result;
  };

  document.addEventListener('click', event => {
    const quantityButton = event.target.closest?.(
      '.owned-qty-increase, .owned-qty-decrease'
    );
    if (quantityButton) {
      nextQuantityFinish = normalizeFinish(
        quantityButton.dataset.finish ||
        quantityButton.closest('.owned-printing-item')?.dataset.finish
      );
    }

    const swapButton = event.target.closest?.('.swap-printing-btn');
    if (swapButton) {
      activeSwapFinish = normalizeFinish(
        swapButton.dataset.finish ||
        swapButton.closest('.owned-printing-item')?.dataset.finish
      );
    }
  }, true);

  const observer = new MutationObserver(() => {
    if (document.querySelector('.owned-printing-item')) {
      scheduleDecoration();
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });
}
