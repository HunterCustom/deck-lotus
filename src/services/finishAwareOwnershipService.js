import db from '../db/connection.js';
import { getCardOwnershipAndUsage } from './cardService.js';

const VALID_FINISHES = new Set(['nonfoil', 'foil', 'etched']);

function normalizeFinish(value = 'nonfoil') {
  const finish = String(value || 'nonfoil').toLowerCase();
  if (finish === 'normal') return 'nonfoil';
  if (!VALID_FINISHES.has(finish)) {
    throw new Error(`Unsupported finish: ${finish}`);
  }
  return finish;
}

function priceTypeForFinish(finish) {
  return finish === 'nonfoil' ? 'normal' : finish;
}

function printingSupportsFinish(printing, finish) {
  const finishes = String(printing.finishes || '')
    .split(',')
    .map(value => value.trim().toLowerCase())
    .filter(Boolean);

  // Older/imported rows may not have finish metadata. Preserve legacy
  // nonfoil behavior in that case, but do not invent foil/etched support.
  if (finishes.length === 0) return finish === 'nonfoil';
  return finishes.includes(finish);
}

function getPrinting(printingId) {
  return db.get(
    `SELECT id, card_id, uuid, set_code, collector_number, finishes
     FROM printings
     WHERE id = ?`,
    [printingId]
  );
}

function refreshOwnedCardCompatibility(userId, cardId) {
  const remaining = db.get(
    `SELECT COUNT(*) as count
     FROM owned_printings op
     JOIN printings p ON p.id = op.printing_id
     WHERE op.user_id = ? AND p.card_id = ?`,
    [userId, cardId]
  );

  if ((remaining?.count || 0) > 0) {
    db.run(
      `INSERT INTO owned_cards (user_id, card_id, quantity)
       VALUES (?, ?, 1)
       ON CONFLICT(user_id, card_id) DO UPDATE SET quantity = 1`,
      [userId, cardId]
    );
  } else {
    db.run(
      `DELETE FROM owned_cards WHERE user_id = ? AND card_id = ?`,
      [userId, cardId]
    );
  }
}

export function getCardOwnershipAndUsageFinishAware(userId, cardId) {
  const data = getCardOwnershipAndUsage(userId, cardId);

  const ownedPrintings = (data.ownedPrintings || []).map(op => {
    const finish = normalizeFinish(op.finish || 'nonfoil');
    const priceType = priceTypeForFinish(finish);
    const priceRow = db.get(
      `SELECT pr.price
       FROM printings p
       LEFT JOIN prices pr
         ON pr.printing_uuid = p.uuid
        AND pr.provider = 'tcgplayer'
        AND pr.price_type = ?
       WHERE p.id = ?
       LIMIT 1`,
      [priceType, op.printing_id]
    );

    return {
      ...op,
      finish,
      price_type: priceType,
      price: priceRow?.price ?? null,
    };
  }).sort((a, b) => {
    const setCompare = String(a.set_code || '').localeCompare(String(b.set_code || ''));
    if (setCompare !== 0) return setCompare;

    const collectorCompare = String(a.collector_number || '').localeCompare(
      String(b.collector_number || ''),
      undefined,
      { numeric: true, sensitivity: 'base' }
    );
    if (collectorCompare !== 0) return collectorCompare;

    return String(a.finish || '').localeCompare(String(b.finish || ''));
  });

  return {
    ...data,
    ownedPrintings,
  };
}

export function setOwnedPrintingQuantityFinishAware(
  userId,
  printingId,
  quantity,
  requestedFinish = 'nonfoil'
) {
  const finish = normalizeFinish(requestedFinish);
  const parsedQuantity = Number(quantity);

  if (!Number.isInteger(parsedQuantity)) {
    throw new Error('Quantity must be an integer');
  }

  const printing = getPrinting(printingId);
  if (!printing) throw new Error('Printing not found');
  if (!printingSupportsFinish(printing, finish)) {
    throw new Error(`Printing does not support ${finish}`);
  }

  if (parsedQuantity <= 0) {
    db.run(
      `DELETE FROM owned_printings
       WHERE user_id = ? AND printing_id = ? AND finish = ?`,
      [userId, printingId, finish]
    );
    refreshOwnedCardCompatibility(userId, printing.card_id);

    return {
      success: true,
      printingId,
      finish,
      quantity: 0,
      message: 'Printing finish removed from collection',
    };
  }

  const existing = db.get(
    `SELECT id FROM owned_printings
     WHERE user_id = ? AND printing_id = ? AND finish = ?`,
    [userId, printingId, finish]
  );

  if (existing) {
    db.run(
      `UPDATE owned_printings
       SET quantity = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [parsedQuantity, existing.id]
    );
  } else {
    db.run(
      `INSERT INTO owned_printings (user_id, printing_id, finish, quantity)
       VALUES (?, ?, ?, ?)`,
      [userId, printingId, finish, parsedQuantity]
    );
  }

  refreshOwnedCardCompatibility(userId, printing.card_id);

  return {
    success: true,
    printingId,
    finish,
    quantity: parsedQuantity,
  };
}

export function swapOwnedPrintingFinishAware(
  userId,
  fromPrintingId,
  toPrintingId,
  requestedFinish = 'nonfoil'
) {
  const finish = normalizeFinish(requestedFinish);

  if (fromPrintingId === toPrintingId) {
    throw new Error('Replacement printing must be different');
  }

  const source = db.get(
    `SELECT op.id as owned_printing_id, op.quantity, p.card_id
     FROM owned_printings op
     JOIN printings p ON op.printing_id = p.id
     WHERE op.user_id = ? AND op.printing_id = ? AND op.finish = ?`,
    [userId, fromPrintingId, finish]
  );

  if (!source) {
    throw new Error('Owned printing finish not found');
  }

  const replacement = getPrinting(toPrintingId);
  if (!replacement) throw new Error('Replacement printing not found');
  if (replacement.card_id !== source.card_id) {
    throw new Error('Replacement printing must be for the same card');
  }
  if (!printingSupportsFinish(replacement, finish)) {
    throw new Error(`Replacement printing does not support ${finish}`);
  }

  const siblingFinishes = db.get(
    `SELECT COUNT(*) as count
     FROM owned_printings
     WHERE user_id = ? AND printing_id = ? AND finish <> ?`,
    [userId, fromPrintingId, finish]
  );

  const affectedDeckRows = db.all(
    `SELECT dc.id, dc.deck_id, dc.quantity, dc.is_sideboard, dc.is_commander,
            COALESCE(dc.board_type,
              CASE WHEN dc.is_sideboard = 1 THEN 'sideboard' ELSE 'mainboard' END
            ) as board_type
     FROM deck_cards dc
     JOIN decks d ON dc.deck_id = d.id
     WHERE dc.printing_id = ? AND d.user_id = ?`,
    [fromPrintingId, userId]
  );

  const deckSyncSkipped = (siblingFinishes?.count || 0) > 0 && affectedDeckRows.length > 0;

  return db.transaction(() => {
    // Deck rows do not yet store finish. If the same owned printing exists in
    // more than one finish, changing every deck row would guess which physical
    // copies the user meant. In that ambiguous case, leave decks untouched.
    if (!deckSyncSkipped) {
      for (const deckRow of affectedDeckRows) {
        const existingDeckRow = db.get(
          `SELECT id, quantity, is_commander,
                  COALESCE(board_type,
                    CASE WHEN is_sideboard = 1 THEN 'sideboard' ELSE 'mainboard' END
                  ) as board_type
           FROM deck_cards
           WHERE deck_id = ? AND printing_id = ? AND is_sideboard = ?`,
          [deckRow.deck_id, toPrintingId, deckRow.is_sideboard]
        );

        if (existingDeckRow) {
          if (existingDeckRow.board_type !== deckRow.board_type) {
            continue;
          }

          db.run(
            `UPDATE deck_cards
             SET quantity = ?, is_commander = ?
             WHERE id = ?`,
            [
              existingDeckRow.quantity + deckRow.quantity,
              existingDeckRow.is_commander || deckRow.is_commander ? 1 : 0,
              existingDeckRow.id,
            ]
          );
          db.run(`DELETE FROM deck_cards WHERE id = ?`, [deckRow.id]);
        } else {
          db.run(
            `UPDATE deck_cards SET printing_id = ? WHERE id = ?`,
            [toPrintingId, deckRow.id]
          );
        }
      }
    }

    const existingReplacement = db.get(
      `SELECT id, quantity
       FROM owned_printings
       WHERE user_id = ? AND printing_id = ? AND finish = ?`,
      [userId, toPrintingId, finish]
    );

    if (existingReplacement) {
      db.run(
        `UPDATE owned_printings
         SET quantity = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [existingReplacement.quantity + source.quantity, existingReplacement.id]
      );
    } else {
      db.run(
        `INSERT INTO owned_printings (user_id, printing_id, finish, quantity)
         VALUES (?, ?, ?, ?)`,
        [userId, toPrintingId, finish, source.quantity]
      );
    }

    db.run(
      `DELETE FROM owned_printings WHERE id = ?`,
      [source.owned_printing_id]
    );

    refreshOwnedCardCompatibility(userId, source.card_id);

    return {
      success: true,
      fromPrintingId,
      toPrintingId,
      finish,
      quantity: source.quantity,
      decksUpdated: deckSyncSkipped ? 0 : affectedDeckRows.length,
      deckSyncSkipped,
    };
  });
}
