import db from '../db/connection.js';
import { getMarketPriceSql } from './pricingService.js';

/**
 * Build a shopping list for the exact printings used by the selected decks.
 * Required quantities are summed across those decks, then reduced by the
 * quantity of that same printing the user owns.
 */
export function getShoppingList(userId, deckIds) {
  const ids = (deckIds || [])
    .map(Number)
    .filter(Number.isInteger);

  if (!ids.length) {
    return { sets: [], totalCards: 0, totalUniqueCards: 0, totalDecks: 0, totalPrice: 0 };
  }

  const placeholders = ids.map(() => '?').join(',');
  const priceSql = getMarketPriceSql('p');
  const rows = db.all(`
    SELECT
      c.id as card_id,
      c.name,
      c.mana_cost,
      c.type_line,
      c.color_identity,
      p.id as printing_id,
      p.uuid as printing_uuid,
      p.set_code,
      p.collector_number,
      p.rarity,
      p.image_url,
      s.name as set_name,
      s.release_date,
      d.id as deck_id,
      d.name as deck_name,
      dc.quantity,
      COALESCE(dc.board_type, CASE WHEN dc.is_sideboard = 1 THEN 'sideboard' ELSE 'mainboard' END) as board_type,
      COALESCE(op.quantity, 0) as owned_quantity,
      ${priceSql} as price
    FROM deck_cards dc
    JOIN decks d ON d.id = dc.deck_id
    JOIN printings p ON p.id = dc.printing_id
    JOIN cards c ON c.id = p.card_id
    LEFT JOIN sets s ON s.code = p.set_code
    LEFT JOIN owned_printings op ON op.user_id = ? AND op.printing_id = p.id
    WHERE d.user_id = ?
      AND d.id IN (${placeholders})
    ORDER BY s.name, p.collector_number, c.name
  `, [userId, userId, ...ids]);

  // Aggregate required copies by exact printing while retaining per-deck usage.
  const printingMap = new Map();
  for (const row of rows) {
    let item = printingMap.get(row.printing_id);
    if (!item) {
      item = {
        ...row,
        requiredQuantity: 0,
        ownedQuantity: Number(row.owned_quantity) || 0,
        decks: [],
      };
      printingMap.set(row.printing_id, item);
    }

    item.requiredQuantity += Number(row.quantity) || 0;
    const existingDeck = item.decks.find(d => d.deckId === row.deck_id && d.boardType === row.board_type);
    if (existingDeck) {
      existingDeck.quantity += Number(row.quantity) || 0;
    } else {
      item.decks.push({
        deckId: row.deck_id,
        deckName: row.deck_name,
        quantity: Number(row.quantity) || 0,
        boardType: row.board_type,
      });
    }
  }

  const setMap = new Map();
  let totalCards = 0;
  let totalPrice = 0;

  for (const item of printingMap.values()) {
    const quantityNeeded = Math.max(item.requiredQuantity - item.ownedQuantity, 0);
    if (!quantityNeeded) continue;

    const setCode = item.set_code || 'unknown';
    if (!setMap.has(setCode)) {
      setMap.set(setCode, {
        setCode,
        setName: item.set_name || (item.set_code ? item.set_code.toUpperCase() : 'Unknown Set'),
        releaseDate: item.release_date,
        cards: [],
      });
    }

    const unitPrice = Number(item.price) || 0;
    setMap.get(setCode).cards.push({
      cardId: item.card_id,
      printingId: item.printing_id,
      name: item.name,
      manaCost: item.mana_cost,
      typeLine: item.type_line,
      colorIdentity: item.color_identity,
      setCode: item.set_code,
      collectorNumber: item.collector_number,
      rarity: item.rarity,
      imageUrl: item.image_url,
      price: unitPrice,
      quantity: quantityNeeded,
      quantityNeeded,
      requiredQuantity: item.requiredQuantity,
      ownedQuantity: item.ownedQuantity,
      decks: item.decks,
    });

    totalCards += quantityNeeded;
    totalPrice += unitPrice * quantityNeeded;
  }

  const sets = Array.from(setMap.values()).sort((a, b) => a.setName.localeCompare(b.setName));
  const totalUniqueCards = sets.reduce((sum, set) => sum + set.cards.length, 0);

  return {
    sets,
    totalCards,
    totalUniqueCards,
    totalDecks: ids.length,
    totalPrice,
  };
}
