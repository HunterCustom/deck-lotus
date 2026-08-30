import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDir = mkdtempSync(join(tmpdir(), 'deck-lotus-test-'));
process.env.DATABASE_PATH = join(tempDir, 'test.db');
process.env.NODE_ENV = 'test';

let db;
let closeDb;
let getDeckPrice;
let getInventoryStats;
let parseDeckList;

before(async () => {
  const dbModule = await import('../src/db/index.js');
  await dbModule.runMigrations();
  db = dbModule.getDb();
  closeDb = dbModule.closeDb;

  ({ getDeckPrice } = await import('../src/services/pricingService.js'));
  ({ getInventoryStats } = await import('../src/services/inventoryService.js'));
  ({ parseDeckList } = await import('../src/services/importService.js'));

  db.prepare(`INSERT INTO users (id, username, email, password_hash, is_admin) VALUES (1, 'tester', 'tester@example.com', 'hash', 0)`).run();
  db.prepare(`INSERT INTO cards (id, name, type_line) VALUES (1, 'Test Elf', 'Creature — Elf')`).run();
  db.prepare(`INSERT INTO printings (id, card_id, uuid, set_code, collector_number, image_url) VALUES (10, 1, 'uuid-expensive', 'AAA', '1', 'https://example.test/a.jpg')`).run();
  db.prepare(`INSERT INTO printings (id, card_id, uuid, set_code, collector_number, image_url) VALUES (11, 1, 'uuid-cheap', 'BBB', '2', 'https://example.test/b.jpg')`).run();
  db.prepare(`INSERT INTO prices (printing_uuid, provider, price_type, price) VALUES ('uuid-expensive', 'tcgplayer', 'normal', 12.50)`).run();
  db.prepare(`INSERT INTO prices (printing_uuid, provider, price_type, price) VALUES ('uuid-cheap', 'tcgplayer', 'normal', 2.25)`).run();
  db.prepare(`INSERT INTO decks (id, user_id, name, format) VALUES (1, 1, 'Pricing Test', 'commander')`).run();
  db.prepare(`INSERT INTO deck_cards (deck_id, printing_id, quantity, is_sideboard, is_commander, board_type) VALUES (1, 10, 2, 0, 0, 'mainboard')`).run();
  db.prepare(`INSERT INTO owned_cards (user_id, card_id, quantity) VALUES (1, 1, 1)`).run();
  db.prepare(`INSERT INTO owned_printings (user_id, printing_id, quantity) VALUES (1, 11, 3)`).run();
});

after(() => {
  closeDb?.();
  rmSync(tempDir, { recursive: true, force: true });
});

test('deck pricing follows the exact deck printing', () => {
  const price = getDeckPrice(1);
  assert.equal(price.total, 25);
  assert.equal(price.cardPrices[1], 12.5);
});

test('inventory valuation follows the exact owned printing', () => {
  const stats = getInventoryStats(1);
  assert.equal(stats.totalCopies, 3);
  assert.equal(stats.estimatedValue, 6.75);
});

test('deck-list parser preserves commander and sideboard sections', () => {
  const parsed = parseDeckList(`Commander\n1 Test Elf (AAA) 1\n\nDeck\n2 Test Elf (BBB) 2\n\nSideboard\n1 Test Elf (AAA) 1`);
  assert.equal(parsed.length, 3);
  assert.equal(parsed[0].isCommander, true);
  assert.equal(parsed[0].isSideboard, false);
  assert.equal(parsed[1].isCommander, false);
  assert.equal(parsed[1].isSideboard, false);
  assert.equal(parsed[2].isSideboard, true);
});
