export function up(db) {
  db.exec(`
    CREATE TABLE deck_cards_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      deck_id INTEGER NOT NULL,
      printing_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1,
      is_sideboard INTEGER DEFAULT 0,
      is_commander INTEGER DEFAULT 0,
      added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      board_type TEXT NOT NULL DEFAULT 'mainboard',
      FOREIGN KEY (deck_id) REFERENCES decks(id) ON DELETE CASCADE,
      FOREIGN KEY (printing_id) REFERENCES printings(id) ON DELETE CASCADE,
      UNIQUE(deck_id, printing_id, board_type)
    );

    INSERT INTO deck_cards_new (
      deck_id,
      printing_id,
      quantity,
      is_sideboard,
      is_commander,
      added_at,
      board_type
    )
    SELECT
      deck_id,
      printing_id,
      SUM(quantity),
      CASE WHEN normalized_board_type = 'sideboard' THEN 1 ELSE 0 END,
      MAX(is_commander),
      MIN(added_at),
      normalized_board_type
    FROM (
      SELECT
        deck_id,
        printing_id,
        quantity,
        is_commander,
        added_at,
        CASE
          WHEN board_type = 'maybeboard' THEN 'maybeboard'
          WHEN is_sideboard = 1 OR board_type = 'sideboard' THEN 'sideboard'
          ELSE 'mainboard'
        END AS normalized_board_type
      FROM deck_cards
    )
    GROUP BY deck_id, printing_id, normalized_board_type;

    DROP TABLE deck_cards;
    ALTER TABLE deck_cards_new RENAME TO deck_cards;

    CREATE INDEX idx_deck_cards_deck_id ON deck_cards(deck_id);
    CREATE INDEX idx_deck_cards_printing_id ON deck_cards(printing_id);
    CREATE INDEX idx_deck_cards_board_type ON deck_cards(board_type);
  `);

  console.log('✓ Normalized deck board types and updated deck card uniqueness');
}

export function down(db) {
  // A strict rollback could lose valid rows when the same printing exists in both
  // mainboard and maybeboard, so leave the safer schema in place.
  console.log('⊘ deck_cards board integrity migration is not automatically reversible');
}
