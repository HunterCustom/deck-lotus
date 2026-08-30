import db from '../db/connection.js';

export function getPrintingPrices(uuid) {
  const prices = db.all(
    `SELECT provider, price_type, price, updated_at
     FROM prices
     WHERE printing_uuid = ?
     ORDER BY provider, price_type`,
    [uuid]
  );

  const formatted = {};
  for (const p of prices) {
    if (!formatted[p.provider]) formatted[p.provider] = {};
    formatted[p.provider][p.price_type] = p.price;
  }
  return formatted;
}

/**
 * Get deck total price. When userId is supplied, the deck must belong to that
 * user; this prevents authenticated users from probing other users' deck IDs.
 */
export function getDeckPrice(deckId, userId = null) {
  if (userId !== null) {
    const owned = db.get('SELECT id FROM decks WHERE id = ? AND user_id = ?', [deckId, userId]);
    if (!owned) {
      const error = new Error('Deck not found');
      error.statusCode = 404;
      throw error;
    }
  }

  const priceSubquery = `COALESCE(
    (SELECT price FROM prices WHERE printing_uuid = p.uuid AND provider = 'tcgplayer' AND price_type = 'normal' LIMIT 1),
    (SELECT price FROM prices WHERE printing_uuid = p.uuid AND price_type = 'normal' LIMIT 1),
    0
  )`;

  const result = db.get(
    `SELECT SUM((${priceSubquery}) * dc.quantity) as total_price
     FROM deck_cards dc
     JOIN printings p ON dc.printing_id = p.id
     WHERE dc.deck_id = ?`,
    [deckId]
  );

  const cardPrices = db.all(
    `SELECT
      dc.id as deck_card_id,
      dc.printing_id,
      p.uuid,
      c.name,
      p.image_url,
      dc.quantity,
      ${priceSubquery} as unit_price
     FROM deck_cards dc
     JOIN printings p ON dc.printing_id = p.id
     JOIN cards c ON p.card_id = c.id
     WHERE dc.deck_id = ?
     ORDER BY unit_price DESC`,
    [deckId]
  );

  const mostExpensive = cardPrices.length > 0 ? cardPrices[0] : null;
  const cardPriceMap = {};
  for (const card of cardPrices) cardPriceMap[card.deck_card_id] = card.unit_price;

  return {
    total: result?.total_price || 0,
    provider: 'market',
    currency: 'USD',
    mostExpensive: mostExpensive ? {
      name: mostExpensive.name,
      price: mostExpensive.unit_price,
      imageUrl: mostExpensive.image_url,
    } : null,
    cardPrices: cardPriceMap,
  };
}

export function getBulkPrices(uuids) {
  if (!uuids || uuids.length === 0) return {};

  const placeholders = uuids.map(() => '?').join(',');
  const prices = db.all(
    `SELECT printing_uuid, provider, price_type, price
     FROM prices
     WHERE printing_uuid IN (${placeholders})`,
    uuids
  );

  const grouped = {};
  for (const p of prices) {
    if (!grouped[p.printing_uuid]) grouped[p.printing_uuid] = {};
    if (!grouped[p.printing_uuid][p.provider]) grouped[p.printing_uuid][p.provider] = {};
    grouped[p.printing_uuid][p.provider][p.price_type] = p.price;
  }
  return grouped;
}
