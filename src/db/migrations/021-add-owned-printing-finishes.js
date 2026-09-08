export function up(db) {
  db.exec(`
    CREATE TABLE owned_printings_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      printing_id INTEGER NOT NULL,
      finish TEXT NOT NULL DEFAULT 'nonfoil',
      quantity INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (printing_id) REFERENCES printings(id) ON DELETE CASCADE,
      UNIQUE(user_id, printing_id, finish)
    );

    INSERT INTO owned_printings_new (
      id, user_id, printing_id, finish, quantity, created_at, updated_at
    )
    SELECT
      id, user_id, printing_id, 'nonfoil', quantity, created_at, updated_at
    FROM owned_printings;

    DROP TABLE owned_printings;
    ALTER TABLE owned_printings_new RENAME TO owned_printings;

    CREATE INDEX idx_owned_printings_user_id ON owned_printings(user_id);
    CREATE INDEX idx_owned_printings_printing_id ON owned_printings(printing_id);
    CREATE INDEX idx_owned_printings_finish ON owned_printings(finish);
  `);

  console.log('✓ Added finish-aware owned printing quantities');
}

export function down(db) {
  db.exec(`
    CREATE TABLE owned_printings_old (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      printing_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (printing_id) REFERENCES printings(id) ON DELETE CASCADE,
      UNIQUE(user_id, printing_id)
    );

    INSERT INTO owned_printings_old (
      user_id, printing_id, quantity, created_at, updated_at
    )
    SELECT
      user_id,
      printing_id,
      SUM(quantity),
      MIN(created_at),
      MAX(updated_at)
    FROM owned_printings
    GROUP BY user_id, printing_id;

    DROP TABLE owned_printings;
    ALTER TABLE owned_printings_old RENAME TO owned_printings;

    CREATE INDEX idx_owned_printings_user_id ON owned_printings(user_id);
    CREATE INDEX idx_owned_printings_printing_id ON owned_printings(printing_id);
  `);

  console.log('✓ Removed finish-aware owned printing quantities');
}
