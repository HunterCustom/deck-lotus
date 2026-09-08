import db from '../db/connection.js';
import {
  getInventory,
  getInventoryStats,
} from './inventoryService.js';

function priceTypeForFinish(finish) {
  return finish === 'foil' ? 'foil' : finish === 'etched' ? 'etched' : 'normal';
}

export function getInventoryFinishAware(userId, filters = {}) {
  const result = getInventory(userId, filters);

  const cards = (result.cards || []).map(card => ({
    ...card,
    printings: (card.printings || []).map(printing => {
      const ownership = db.get(
        `SELECT finish
         FROM owned_printings
         WHERE id = ? AND user_id = ?`,
        [printing.owned_printing_id, userId]
      );

      const finish = ownership?.finish || 'nonfoil';
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
        [priceType, printing.printing_id]
      );

      return {
        ...printing,
        finish,
        price_type: priceType,
        price: priceRow?.price ?? null,
      };
    }),
  }));

  return {
    ...result,
    cards,
  };
}

export function getInventoryStatsFinishAware(userId) {
  const stats = getInventoryStats(userId);

  const estimatedValue = db.get(
    `SELECT COALESCE(SUM(
       op.quantity * COALESCE((
         SELECT pr.price
         FROM prices pr
         WHERE pr.printing_uuid = p.uuid
           AND pr.provider = 'tcgplayer'
           AND pr.price_type = CASE
             WHEN op.finish = 'foil' THEN 'foil'
             WHEN op.finish = 'etched' THEN 'etched'
             ELSE 'normal'
           END
         LIMIT 1
       ), 0)
     ), 0) as total
     FROM owned_printings op
     JOIN printings p ON p.id = op.printing_id
     WHERE op.user_id = ?`,
    [userId]
  );

  return {
    ...stats,
    estimatedValue: estimatedValue?.total || 0,
  };
}
