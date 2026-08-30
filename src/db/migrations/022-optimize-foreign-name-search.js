export function up(db) {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_foreign_name_nocase
      ON card_foreign_data(foreign_name COLLATE NOCASE);

    CREATE INDEX IF NOT EXISTS idx_foreign_card_name_foreign_name
      ON card_foreign_data(card_name, foreign_name COLLATE NOCASE);
  `);

  console.log('✓ Added optimized translated-name search indexes');
}

export function down(db) {
  db.exec(`
    DROP INDEX IF EXISTS idx_foreign_card_name_foreign_name;
    DROP INDEX IF EXISTS idx_foreign_name_nocase;
  `);
}
