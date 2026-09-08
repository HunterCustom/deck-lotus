import db from '../db/connection.js';

function parseManaBoxDescriptor(rawCardName) {
  let value = String(rawCardName || '').trim();
  let isFoil = false;

  if (/\s+\*F\*\s*$/i.test(value)) {
    isFoil = true;
    value = value.replace(/\s+\*F\*\s*$/i, '').trim();
  }

  // ManaBox collection export format:
  // Card Name (SET) 123
  // Card Name (SET) 72b
  // Double-Faced Card // Back Face (SET) 123
  const withCollector = value.match(/^(.*)\s+\(([A-Z0-9]+)\)\s+([^\s]+)$/i);
  if (withCollector) {
    return {
      cardName: withCollector[1].trim(),
      setCode: withCollector[2].toUpperCase(),
      collectorNumber: withCollector[3].trim(),
      isFoil,
    };
  }

  // Also accept Card Name (SET) when no collector number is supplied.
  const setOnly = value.match(/^(.*)\s+\(([A-Z0-9]+)\)\s*$/i);
  if (setOnly) {
    return {
      cardName: setOnly[1].trim(),
      setCode: setOnly[2].toUpperCase(),
      collectorNumber: null,
      isFoil,
    };
  }

  return {
    cardName: value,
    setCode: null,
    collectorNumber: null,
    isFoil,
  };
}

function normalizeBulkItem(item) {
  const parsed = parseManaBoxDescriptor(item?.cardName);

  return {
    cardName: parsed.cardName,
    setCode: item?.setCode ? String(item.setCode).toUpperCase() : parsed.setCode,
    collectorNumber: item?.collectorNumber != null
      ? String(item.collectorNumber).trim()
      : parsed.collectorNumber,
    quantity: item?.quantity ?? 1,
    isFoil: item?.isFoil === true || parsed.isFoil,
  };
}

function findCard(cardName) {
  let card = db.get(
    `SELECT id, name FROM cards WHERE name = ? COLLATE NOCASE LIMIT 1`,
    [cardName]
  );

  // A few importers export only the front face of a double-faced card.
  if (!card && !cardName.includes(' // ')) {
    card = db.get(
      `SELECT id, name FROM cards WHERE name LIKE ? COLLATE NOCASE ORDER BY name LIMIT 1`,
      [`${cardName} //%`]
    );
  }

  return card;
}

function findPrinting(cardId, setCode, collectorNumber) {
  if (setCode && collectorNumber) {
    return db.get(
      `SELECT id, set_code, collector_number
       FROM printings
       WHERE card_id = ?
         AND UPPER(set_code) = ?
         AND LOWER(CAST(collector_number AS TEXT)) = LOWER(?)
       LIMIT 1`,
      [cardId, setCode.toUpperCase(), collectorNumber]
    );
  }

  if (setCode) {
    return db.get(
      `SELECT id, set_code, collector_number
       FROM printings
       WHERE card_id = ? AND UPPER(set_code) = ?
       ORDER BY collector_number
       LIMIT 1`,
      [cardId, setCode.toUpperCase()]
    );
  }

  // No printing was requested, so retain the existing behavior of choosing
  // the cheapest available TCGPlayer normal printing.
  return db.get(`
    SELECT p.id, p.set_code, p.collector_number
    FROM printings p
    WHERE p.card_id = ?
    ORDER BY
      CASE WHEN (
        SELECT price FROM prices
        WHERE printing_uuid = p.uuid
          AND provider = 'tcgplayer'
          AND price_type = 'normal'
        LIMIT 1
      ) IS NULL THEN 999999
      ELSE (
        SELECT price FROM prices
        WHERE printing_uuid = p.uuid
          AND provider = 'tcgplayer'
          AND price_type = 'normal'
        LIMIT 1
      ) END ASC
    LIMIT 1
  `, [cardId]);
}

/**
 * Bulk-add inventory cards while preserving ManaBox printing identifiers.
 *
 * The current client sends ManaBox lines such as
 * "Azog, Moria's Ruin (HOB) 61" as cardName, so parsing happens here as a
 * defensive backend step. Existing callers that send { cardName, setCode,
 * quantity } continue to work.
 *
 * Foil markers are recognized so they no longer break card matching. Deck
 * Lotus does not yet persist finish on owned_printings, so foil ownership is
 * reported in foilNotTracked until finish-aware ownership is migrated.
 */
export function bulkAddToInventory(userId, items) {
  const results = {
    added: 0,
    failed: 0,
    foilNotTracked: 0,
    errors: [],
  };

  for (const rawItem of items) {
    const item = normalizeBulkItem(rawItem);

    try {
      const quantity = Number(item.quantity);
      if (!item.cardName) throw new Error('Card name is required');
      if (!Number.isInteger(quantity) || quantity <= 0) {
        throw new Error('Quantity must be a positive integer');
      }

      const card = findCard(item.cardName);
      if (!card) {
        throw new Error('Card not found');
      }

      const printing = findPrinting(card.id, item.setCode, item.collectorNumber);
      if (!printing) {
        if (item.setCode && item.collectorNumber) {
          throw new Error(`Printing not found: ${item.setCode} #${item.collectorNumber}`);
        }
        if (item.setCode) {
          throw new Error(`Printing not found in set ${item.setCode}`);
        }
        throw new Error('Printing not found');
      }

      const existing = db.get(
        `SELECT id FROM owned_printings WHERE user_id = ? AND printing_id = ?`,
        [userId, printing.id]
      );

      if (existing) {
        db.run(
          `UPDATE owned_printings
           SET quantity = quantity + ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [quantity, existing.id]
        );
      } else {
        db.run(
          `INSERT INTO owned_printings (user_id, printing_id, quantity)
           VALUES (?, ?, ?)`,
          [userId, printing.id, quantity]
        );
      }

      db.run(
        `INSERT INTO owned_cards (user_id, card_id, quantity) VALUES (?, ?, 1)
         ON CONFLICT(user_id, card_id) DO UPDATE SET quantity = 1`,
        [userId, card.id]
      );

      results.added += quantity;
      if (item.isFoil) results.foilNotTracked += quantity;
    } catch (error) {
      results.failed++;
      results.errors.push({
        cardName: rawItem?.cardName || item.cardName,
        error: error.message,
      });
    }
  }

  return results;
}
