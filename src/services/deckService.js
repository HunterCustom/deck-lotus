import db from '../db/connection.js';
import crypto from 'crypto';

/**
 * Get all decks for a user
 */
export function getUserDecks(userId) {
  const decks = db.all(
    `SELECT d.*,
      (SELECT COALESCE(SUM(quantity), 0) FROM deck_cards WHERE deck_id = d.id AND (board_type = 'mainboard' OR (board_type IS NULL AND is_sideboard = 0))) as mainboard_count,
      (SELECT COALESCE(SUM(quantity), 0) FROM deck_cards WHERE deck_id = d.id AND (board_type = 'sideboard' OR (board_type IS NULL AND is_sideboard = 1))) as sideboard_count,
      (SELECT COALESCE(SUM(quantity), 0) FROM deck_cards WHERE deck_id = d.id AND board_type = 'maybeboard') as maybeboard_count
     FROM decks d
     WHERE user_id = ?
     ORDER BY updated_at DESC`,
    [userId]
  );

  // Get a random card image for each deck (prefer creatures)
  return decks.map(deck => {
    const randomCard = db.get(
      `SELECT p.image_url, p.uuid
       FROM deck_cards dc
       JOIN printings p ON dc.printing_id = p.id
       JOIN cards c ON p.card_id = c.id
       WHERE dc.deck_id = ? AND (dc.board_type = 'mainboard' OR (dc.board_type IS NULL AND dc.is_sideboard = 0)) AND p.image_url IS NOT NULL
       ORDER BY
         CASE WHEN c.type_line LIKE '%Creature%' THEN 0 ELSE 1 END,
         RANDOM()
       LIMIT 1`,
      [deck.id]
    );

    return {
      ...deck,
      preview_image: randomCard?.image_url || null
    };
  });
}

/**
 * Get deck by ID (only if owned by user)
 */
export function getDeckById(deckId, userId) {
  const deck = db.get(
    `SELECT * FROM decks WHERE id = ? AND user_id = ?`,
    [deckId, userId]
  );

  if (!deck) {
    return null;
  }

  // Get all cards in deck with full details
  const cards = db.all(
    `SELECT
      dc.id as deck_card_id,
      dc.quantity,
      dc.is_sideboard,
      COALESCE(dc.board_type, CASE WHEN dc.is_sideboard = 1 THEN 'sideboard' ELSE 'mainboard' END) as board_type,
      dc.is_commander,
      p.id as printing_id,
      p.card_id,
      p.set_code,
      p.collector_number,
      p.rarity,
      p.artist,
      p.image_url,
      p.uuid,
      s.name as set_name,
      c.name,
      c.mana_cost,
      c.cmc,
      c.colors,
      c.color_identity,
      c.type_line,
      c.oracle_text,
      c.power,
      c.toughness,
      c.loyalty,
      (SELECT CASE WHEN oc.id IS NOT NULL THEN 1 ELSE 0 END FROM owned_cards oc WHERE oc.user_id = ? AND oc.card_id = c.id LIMIT 1) as is_owned
     FROM deck_cards dc
     JOIN printings p ON dc.printing_id = p.id
     JOIN cards c ON p.card_id = c.id
     LEFT JOIN sets s ON p.set_code = s.code
     WHERE dc.deck_id = ?
     ORDER BY
       CASE board_type
         WHEN 'mainboard' THEN 0
         WHEN 'sideboard' THEN 1
         WHEN 'maybeboard' THEN 2
         ELSE 3
       END,
       c.cmc, c.name`,
    [userId, deckId]
  );

  return {
    ...deck,
    cards,
  };
}

/**
 * Create a new deck
 */
export function createDeck(userId, name, format, description) {
  const result = db.run(
    `INSERT INTO decks (user_id, name, format, description) VALUES (?, ?, ?, ?)`,
    [userId, name, format || null, description || null]
  );

  return {
    id: result.lastInsertRowid,
    user_id: userId,
    name,
    format,
    description,
  };
}

/**
 * Update deck
 */
export function updateDeck(deckId, userId, updates) {
  const { name, format, description } = updates;

  // Check if deck belongs to user
  const deck = db.get(
    `SELECT id FROM decks WHERE id = ? AND user_id = ?`,
    [deckId, userId]
  );

  if (!deck) {
    throw new Error('Deck not found or access denied');
  }

  const fields = [];
  const params = [];

  if (name !== undefined) {
    fields.push('name = ?');
    params.push(name);
  }
  if (format !== undefined) {
    fields.push('format = ?');
    params.push(format);
  }
  if (description !== undefined) {
    fields.push('description = ?');
    params.push(description);
  }

  fields.push('updated_at = CURRENT_TIMESTAMP');

  if (fields.length === 1) {
    // Only updated_at, no changes
    return getDeckById(deckId, userId);
  }

  params.push(deckId, userId);

  db.run(
    `UPDATE decks SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`,
    params
  );

  return getDeckById(deckId, userId);
}

/**
 * Delete deck
 */
export function deleteDeck(deckId, userId) {
  const result = db.run(
    `DELETE FROM decks WHERE id = ? AND user_id = ?`,
    [deckId, userId]
  );

  return result.changes > 0;
}

/**
 * Add card to deck
 */
export function addCardToDeck(deckId, userId, printingId, quantity = 1, isSideboard = false, isCommander = false, boardType = null) {
  const deck = db.get(
    `SELECT id FROM decks WHERE id = ? AND user_id = ?`,
    [deckId, userId]
  );

  if (!deck) {
    throw new Error('Deck not found or access denied');
  }

  if (!Number.isInteger(Number(quantity)) || Number(quantity) <= 0) {
    throw new Error('Quantity must be a positive integer');
  }

  const finalBoardType = boardType || (isSideboard ? 'sideboard' : 'mainboard');
  if (!['mainboard', 'sideboard', 'maybeboard'].includes(finalBoardType)) {
    throw new Error('Invalid board type');
  }
  const finalIsSideboard = finalBoardType === 'sideboard' ? 1 : 0;

  const existing = db.get(
    `SELECT id FROM deck_cards
     WHERE deck_id = ? AND printing_id = ? AND board_type = ?`,
    [deckId, printingId, finalBoardType]
  );

  if (existing) {
    db.run(
      `UPDATE deck_cards
       SET quantity = quantity + ?, is_commander = CASE WHEN ? = 1 THEN 1 ELSE is_commander END,
           is_sideboard = ?
       WHERE id = ?`,
      [Number(quantity), isCommander ? 1 : 0, finalIsSideboard, existing.id]
    );
  } else {
    db.run(
      `INSERT INTO deck_cards (deck_id, printing_id, quantity, is_sideboard, is_commander, board_type)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [deckId, printingId, Number(quantity), finalIsSideboard, isCommander ? 1 : 0, finalBoardType]
    );
  }

  db.run(`UPDATE decks SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [deckId]);
  return getDeckById(deckId, userId);
}

/**
 * Update card quantity in deck
 */
export function updateDeckCard(deckId, userId, deckCardId, updates) {
  const deck = db.get(
    `SELECT id FROM decks WHERE id = ? AND user_id = ?`,
    [deckId, userId]
  );

  if (!deck) {
    throw new Error('Deck not found or access denied');
  }

  const current = db.get(
    `SELECT id, printing_id, quantity, is_sideboard, is_commander,
            COALESCE(board_type, CASE WHEN is_sideboard = 1 THEN 'sideboard' ELSE 'mainboard' END) AS board_type
     FROM deck_cards
     WHERE id = ? AND deck_id = ?`,
    [deckCardId, deckId]
  );

  if (!current) {
    throw new Error('Deck card not found');
  }

  const { quantity, isSideboard, isCommander, printingId, boardType } = updates;

  if (quantity !== undefined && Number(quantity) <= 0) {
    return removeCardFromDeck(deckId, userId, deckCardId);
  }

  const nextQuantity = quantity !== undefined ? Number(quantity) : current.quantity;
  if (!Number.isInteger(nextQuantity) || nextQuantity <= 0) {
    throw new Error('Quantity must be a positive integer');
  }

  let nextBoardType = current.board_type;
  if (boardType !== undefined) {
    nextBoardType = boardType;
  } else if (isSideboard !== undefined) {
    nextBoardType = isSideboard ? 'sideboard' : 'mainboard';
  }

  if (!['mainboard', 'sideboard', 'maybeboard'].includes(nextBoardType)) {
    throw new Error('Invalid board type');
  }

  const nextPrintingId = printingId !== undefined ? Number(printingId) : current.printing_id;
  const nextIsCommander = isCommander !== undefined ? (isCommander ? 1 : 0) : current.is_commander;
  const nextIsSideboard = nextBoardType === 'sideboard' ? 1 : 0;

  const existingTarget = db.get(
    `SELECT id, quantity, is_commander
     FROM deck_cards
     WHERE deck_id = ? AND printing_id = ? AND board_type = ? AND id != ?`,
    [deckId, nextPrintingId, nextBoardType, deckCardId]
  );

  if (existingTarget) {
    db.transaction(() => {
      db.run(
        `UPDATE deck_cards
         SET quantity = ?, is_commander = ?, is_sideboard = ?
         WHERE id = ?`,
        [
          existingTarget.quantity + nextQuantity,
          existingTarget.is_commander || nextIsCommander ? 1 : 0,
          nextIsSideboard,
          existingTarget.id
        ]
      );
      db.run(`DELETE FROM deck_cards WHERE id = ? AND deck_id = ?`, [deckCardId, deckId]);
    });
  } else {
    db.run(
      `UPDATE deck_cards
       SET printing_id = ?, quantity = ?, is_sideboard = ?, is_commander = ?, board_type = ?
       WHERE id = ? AND deck_id = ?`,
      [
        nextPrintingId,
        nextQuantity,
        nextIsSideboard,
        nextIsCommander,
        nextBoardType,
        deckCardId,
        deckId
      ]
    );
  }

  db.run(`UPDATE decks SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [deckId]);
  return getDeckById(deckId, userId);
}

/**
 * Remove card from deck
 */
export function removeCardFromDeck(deckId, userId, deckCardId) {
  // Verify deck ownership
  const deck = db.get(
    `SELECT id FROM decks WHERE id = ? AND user_id = ?`,
    [deckId, userId]
  );

  if (!deck) {
    throw new Error('Deck not found or access denied');
  }

  db.run(
    `DELETE FROM deck_cards WHERE id = ? AND deck_id = ?`,
    [deckCardId, deckId]
  );

  // Update deck timestamp
  db.run(`UPDATE decks SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [deckId]);

  return getDeckById(deckId, userId);
}

/**
 * Get deck statistics
 */
export function getDeckStats(deckId, userId) {
  const deck = getDeckById(deckId, userId);

  if (!deck) {
    return null;
  }

  // Calculate mana curve
  const manaCurve = db.all(
    `SELECT
      CAST(c.cmc AS INTEGER) as cmc,
      COUNT(*) as count,
      SUM(dc.quantity) as total_cards
     FROM deck_cards dc
     JOIN printings p ON dc.printing_id = p.id
     JOIN cards c ON p.card_id = c.id
     WHERE dc.deck_id = ? AND (dc.board_type = 'mainboard' OR (dc.board_type IS NULL AND dc.is_sideboard = 0))
     GROUP BY CAST(c.cmc AS INTEGER)
     ORDER BY cmc`,
    [deckId]
  );

  // Calculate color distribution
  const colorDistribution = db.all(
    `SELECT
      c.colors,
      COUNT(*) as count,
      SUM(dc.quantity) as total_cards
     FROM deck_cards dc
     JOIN printings p ON dc.printing_id = p.id
     JOIN cards c ON p.card_id = c.id
     WHERE dc.deck_id = ? AND (dc.board_type = 'mainboard' OR (dc.board_type IS NULL AND dc.is_sideboard = 0))
     GROUP BY c.colors`,
    [deckId]
  );

  // Calculate type distribution
  const typeDistribution = db.all(
    `SELECT
      CASE
        WHEN c.type_line LIKE '%Creature%' THEN 'Creature'
        WHEN c.type_line LIKE '%Instant%' THEN 'Instant'
        WHEN c.type_line LIKE '%Sorcery%' THEN 'Sorcery'
        WHEN c.type_line LIKE '%Enchantment%' THEN 'Enchantment'
        WHEN c.type_line LIKE '%Artifact%' THEN 'Artifact'
        WHEN c.type_line LIKE '%Planeswalker%' THEN 'Planeswalker'
        WHEN c.type_line LIKE '%Land%' THEN 'Land'
        ELSE 'Other'
      END as type,
      COUNT(*) as count,
      SUM(dc.quantity) as total_cards
     FROM deck_cards dc
     JOIN printings p ON dc.printing_id = p.id
     JOIN cards c ON p.card_id = c.id
     WHERE dc.deck_id = ? AND (dc.board_type = 'mainboard' OR (dc.board_type IS NULL AND dc.is_sideboard = 0))
     GROUP BY type`,
    [deckId]
  );

  return {
    deck: {
      id: deck.id,
      name: deck.name,
      format: deck.format,
    },
    manaCurve,
    colorDistribution,
    typeDistribution,
  };
}

/**
 * Create a share link for a deck
 */
export function createDeckShare(deckId, userId) {
  // Verify deck ownership
  const deck = db.get(
    `SELECT id FROM decks WHERE id = ? AND user_id = ?`,
    [deckId, userId]
  );

  if (!deck) {
    throw new Error('Deck not found or access denied');
  }

  // Check if share already exists
  const existingShare = db.get(
    `SELECT share_token FROM deck_shares WHERE deck_id = ? AND user_id = ? AND is_active = 1`,
    [deckId, userId]
  );

  if (existingShare) {
    return existingShare.share_token;
  }

  // Generate unique share token
  const shareToken = crypto.randomBytes(16).toString('hex');

  db.run(
    `INSERT INTO deck_shares (deck_id, user_id, share_token)
     VALUES (?, ?, ?)`,
    [deckId, userId, shareToken]
  );

  return shareToken;
}

/**
 * Get deck by share token (public access, no authentication required)
 */
export function getDeckByShareToken(shareToken) {
  // Get share info
  const share = db.get(
    `SELECT ds.deck_id, ds.is_active, ds.expires_at, d.user_id
     FROM deck_shares ds
     JOIN decks d ON ds.deck_id = d.id
     WHERE ds.share_token = ?`,
    [shareToken]
  );

  if (!share) {
    return null;
  }

  // Check if share is active
  if (!share.is_active) {
    return null;
  }

  // Check if share is expired
  if (share.expires_at && new Date(share.expires_at) < new Date()) {
    return null;
  }

  // Get deck with cards (similar to getDeckById but without user ownership check)
  const deck = db.get(
    `SELECT id, name, format, description, created_at, updated_at FROM decks WHERE id = ?`,
    [share.deck_id]
  );

  if (!deck) {
    return null;
  }

  // Get all cards in deck with full details
  const cards = db.all(
    `SELECT
      dc.id as deck_card_id,
      dc.quantity,
      dc.is_sideboard,
      COALESCE(dc.board_type, CASE WHEN dc.is_sideboard = 1 THEN 'sideboard' ELSE 'mainboard' END) as board_type,
      dc.is_commander,
      p.id as printing_id,
      p.card_id,
      p.set_code,
      p.collector_number,
      p.rarity,
      p.artist,
      p.image_url,
      p.uuid,
      s.name as set_name,
      c.name,
      c.mana_cost,
      c.cmc,
      c.colors,
      c.color_identity,
      c.type_line,
      c.oracle_text,
      c.power,
      c.toughness,
      c.loyalty
     FROM deck_cards dc
     JOIN printings p ON dc.printing_id = p.id
     JOIN cards c ON p.card_id = c.id
     LEFT JOIN sets s ON p.set_code = s.code
     WHERE dc.deck_id = ?
       AND COALESCE(dc.board_type, CASE WHEN dc.is_sideboard = 1 THEN 'sideboard' ELSE 'mainboard' END) != 'maybeboard'
     ORDER BY dc.is_sideboard, c.cmc, c.name`,
    [share.deck_id]
  );

  return {
    ...deck,
    cards,
    is_shared: true,
  };
}

/**
 * Delete/deactivate a deck share
 */
export function deleteDeckShare(deckId, userId) {
  const result = db.run(
    `UPDATE deck_shares SET is_active = 0
     WHERE deck_id = ? AND user_id = ?`,
    [deckId, userId]
  );

  return result.changes > 0;
}

/**
 * Import a shared deck to user's collection
 */
export function importSharedDeck(shareToken, userId) {
  // Get the shared deck
  const sharedDeck = getDeckByShareToken(shareToken);

  if (!sharedDeck) {
    throw new Error('Shared deck not found or no longer available');
  }

  // Create new deck for the user
  const newDeck = createDeck(
    userId,
    `${sharedDeck.name} (imported)`,
    sharedDeck.format,
    sharedDeck.description
  );

  // Copy all cards to the new deck, preserving the logical board.
  for (const card of sharedDeck.cards) {
    const boardType = card.board_type || (card.is_sideboard ? 'sideboard' : 'mainboard');
    const isSideboard = boardType === 'sideboard' ? 1 : 0;
    db.run(
      `INSERT INTO deck_cards (deck_id, printing_id, quantity, is_sideboard, is_commander, board_type)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(deck_id, printing_id, board_type) DO UPDATE SET
         quantity = deck_cards.quantity + excluded.quantity,
         is_commander = CASE WHEN excluded.is_commander = 1 THEN 1 ELSE deck_cards.is_commander END,
         is_sideboard = excluded.is_sideboard`,
      [newDeck.id, card.printing_id, card.quantity, isSideboard, card.is_commander ? 1 : 0, boardType]
    );
  }

  return getDeckById(newDeck.id, userId);
}

/**
 * Check deck legality for a specific format
 */
export function checkDeckLegality(deckId, userId, format) {
  // Verify deck ownership
  const deck = db.get(
    `SELECT id FROM decks WHERE id = ? AND user_id = ?`,
    [deckId, userId]
  );

  if (!deck) {
    throw new Error('Deck not found or access denied');
  }

  // Get all unique cards in the mainboard with their legalities
  const cards = db.all(
    `SELECT DISTINCT
      c.id,
      c.name,
      c.legalities,
      c.type_line,
      p.image_url,
      SUM(dc.quantity) as total_quantity
     FROM deck_cards dc
     JOIN printings p ON dc.printing_id = p.id
     JOIN cards c ON p.card_id = c.id
     WHERE dc.deck_id = ? AND (dc.board_type = 'mainboard' OR (dc.board_type IS NULL AND dc.is_sideboard = 0))
     GROUP BY c.id
     ORDER BY c.name`,
    [deckId]
  );

  const illegalCards = [];

  for (const card of cards) {
    if (!card.legalities) continue;

    try {
      const legalities = JSON.parse(card.legalities);
      const status = legalities[format];

      // Card is illegal if: not in format (null/undefined), banned, or restricted
      if (!status || status === 'null' || status === 'Banned' || status === 'Restricted') {
        illegalCards.push({
          id: card.id,
          name: card.name,
          type_line: card.type_line,
          image_url: card.image_url,
          quantity: card.total_quantity,
          status: status || 'Not Legal',
          reason: status === 'Banned' ? 'Banned' :
                  status === 'Restricted' ? 'Restricted' :
                  'Not legal in this format'
        });
      }
    } catch (e) {
      console.error(`Error parsing legalities for card ${card.name}:`, e);
    }
  }

  return {
    format,
    isLegal: illegalCards.length === 0,
    illegalCardCount: illegalCards.length,
    illegalCards
  };
}
