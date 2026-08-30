import { getDb } from '../db/index.js';
import fs from 'fs';
import path from 'path';
import cron from 'node-cron';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DATA_DIR = process.env.DATA_PATH || path.join(__dirname, '../../data');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const CONFIG_FILE = path.join(DATA_DIR, 'backup-config.json');

if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

const DEFAULT_CONFIG = {
  enabled: false,
  frequency: 'daily',
  retainCount: 10,
  lastRun: null,
};

function readBackupConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return { ...DEFAULT_CONFIG, ...(parsed && typeof parsed === 'object' ? parsed : {}) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function persistBackupConfig() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(backupConfig, null, 2), 'utf8');
}

let scheduledBackupJob = null;
let backupConfig = readBackupConfig();

function placeholders(values) {
  return values.map(() => '?').join(',');
}

function safeBackupPath(filename) {
  if (typeof filename !== 'string' || !filename || path.basename(filename) !== filename || !filename.endsWith('.json')) {
    throw new Error('Invalid backup filename');
  }

  const root = path.resolve(BACKUP_DIR);
  const resolved = path.resolve(BACKUP_DIR, filename);
  if (!resolved.startsWith(root + path.sep)) {
    throw new Error('Invalid backup filename');
  }
  return resolved;
}

/**
 * Create a portable backup of user-owned data. Card and printing references are
 * stored by stable card name / MTGJSON UUID so they survive card-data refreshes.
 */
export function createBackup(userId = null) {
  const db = getDb();
  const users = userId
    ? db.prepare(`SELECT id, username, email, password_hash, is_admin, created_at, updated_at FROM users WHERE id = ?`).all(userId)
    : db.prepare(`SELECT id, username, email, password_hash, is_admin, created_at, updated_at FROM users`).all();

  const backup = {
    version: '1.1',
    timestamp: new Date().toISOString(),
    data: {
      users,
      api_keys: [],
      owned_cards: [],
      owned_printings: [],
      decks: [],
      deck_cards: [],
      deck_shares: [],
      price_watches: [],
      price_check_log: [],
    },
  };

  const userIds = users.map(u => u.id);
  if (!userIds.length) return backup;
  const userPh = placeholders(userIds);

  backup.data.api_keys = db.prepare(`
    SELECT id, user_id, key_hash, name, last_used, created_at
    FROM api_keys WHERE user_id IN (${userPh})
  `).all(...userIds);

  backup.data.owned_cards = db.prepare(`
    SELECT oc.user_id, oc.quantity, oc.created_at, oc.updated_at, c.name AS card_name
    FROM owned_cards oc
    JOIN cards c ON c.id = oc.card_id
    WHERE oc.user_id IN (${userPh})
  `).all(...userIds);

  backup.data.owned_printings = db.prepare(`
    SELECT op.user_id, op.quantity, op.created_at, op.updated_at, p.uuid AS printing_uuid
    FROM owned_printings op
    JOIN printings p ON p.id = op.printing_id
    WHERE op.user_id IN (${userPh})
  `).all(...userIds);

  backup.data.decks = db.prepare(`
    SELECT id, user_id, name, format, description, created_at, updated_at
    FROM decks WHERE user_id IN (${userPh})
  `).all(...userIds);

  const deckIds = backup.data.decks.map(d => d.id);
  if (deckIds.length) {
    const deckPh = placeholders(deckIds);
    backup.data.deck_cards = db.prepare(`
      SELECT dc.id, dc.deck_id, dc.quantity, dc.is_sideboard, dc.is_commander,
             dc.board_type, dc.added_at, p.uuid AS printing_uuid
      FROM deck_cards dc
      JOIN printings p ON p.id = dc.printing_id
      WHERE dc.deck_id IN (${deckPh})
    `).all(...deckIds);

    backup.data.deck_shares = db.prepare(`
      SELECT id, deck_id, user_id, share_token, is_active, created_at, expires_at
      FROM deck_shares WHERE deck_id IN (${deckPh})
    `).all(...deckIds);
  }

  backup.data.price_watches = db.prepare(`
    SELECT * FROM price_watches WHERE user_id IN (${userPh})
  `).all(...userIds);

  const watchIds = backup.data.price_watches.map(w => w.id);
  if (watchIds.length) {
    backup.data.price_check_log = db.prepare(`
      SELECT * FROM price_check_log WHERE watch_id IN (${placeholders(watchIds)})
    `).all(...watchIds);
  }

  return backup;
}

/**
 * Restore backup data. When a normal user restores their own backup, their
 * current admin state is preserved and backup IDs are never allowed to replace
 * another user's rows.
 */
export function restoreBackup(backupData, options = {}) {
  if (!backupData?.version || !backupData?.data) throw new Error('Invalid backup format');

  const db = getDb();
  const { overwrite = false, userId = null } = options;
  let usersToRestore = backupData.data.users || [];

  if (userId !== null) {
    usersToRestore = usersToRestore.filter(u => Number(u.id) === Number(userId));
    if (!usersToRestore.length) throw new Error(`User ${userId} not found in backup`);
    if (!db.prepare('SELECT id FROM users WHERE id = ?').get(userId)) {
      throw new Error('Authenticated user no longer exists');
    }
  }

  const results = {
    users: 0,
    api_keys: 0,
    owned_cards: 0,
    owned_printings: 0,
    decks: 0,
    deck_cards: 0,
    deck_shares: 0,
    price_watches: 0,
    price_check_log: 0,
    errors: [],
  };

  const restore = db.transaction(() => {
    if (overwrite && userId !== null) {
      db.prepare('DELETE FROM price_watches WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM api_keys WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM owned_printings WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM owned_cards WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM deck_cards WHERE deck_id IN (SELECT id FROM decks WHERE user_id = ?)').run(userId);
      db.prepare('DELETE FROM deck_shares WHERE deck_id IN (SELECT id FROM decks WHERE user_id = ?)').run(userId);
      db.prepare('DELETE FROM decks WHERE user_id = ?').run(userId);
    } else if (overwrite) {
      db.prepare('DELETE FROM price_check_log').run();
      db.prepare('DELETE FROM price_watches').run();
      db.prepare('DELETE FROM deck_cards').run();
      db.prepare('DELETE FROM deck_shares').run();
      db.prepare('DELETE FROM decks').run();
      db.prepare('DELETE FROM api_keys').run();
      db.prepare('DELETE FROM owned_printings').run();
      db.prepare('DELETE FROM owned_cards').run();
      db.prepare('DELETE FROM users').run();
    }

    const restoredUserIds = usersToRestore.map(u => Number(u.id));

    for (const user of usersToRestore) {
      try {
        const existing = db.prepare('SELECT is_admin FROM users WHERE id = ?').get(user.id);
        const isAdmin = userId !== null && existing ? existing.is_admin : (user.is_admin || 0);
        db.prepare(`
          INSERT INTO users (id, username, email, password_hash, is_admin, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            username = excluded.username,
            email = excluded.email,
            password_hash = excluded.password_hash,
            is_admin = excluded.is_admin,
            updated_at = excluded.updated_at
        `).run(user.id, user.username, user.email, user.password_hash, isAdmin, user.created_at, user.updated_at);
        results.users++;
      } catch (e) {
        results.errors.push(`User ${user.username}: ${e.message}`);
      }
    }

    for (const key of (backupData.data.api_keys || []).filter(k => restoredUserIds.includes(Number(k.user_id)))) {
      try {
        if (userId !== null) {
          db.prepare(`INSERT OR IGNORE INTO api_keys (user_id, key_hash, name, last_used, created_at) VALUES (?, ?, ?, ?, ?)`)
            .run(userId, key.key_hash, key.name, key.last_used, key.created_at);
          db.prepare(`UPDATE api_keys SET name = ?, last_used = ? WHERE user_id = ? AND key_hash = ?`)
            .run(key.name, key.last_used, userId, key.key_hash);
        } else {
          db.prepare(`INSERT INTO api_keys (id, user_id, key_hash, name, last_used, created_at) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET user_id=excluded.user_id, key_hash=excluded.key_hash, name=excluded.name, last_used=excluded.last_used`)
            .run(key.id, key.user_id, key.key_hash, key.name, key.last_used, key.created_at);
        }
        results.api_keys++;
      } catch (e) {
        results.errors.push(`API key ${key.name}: ${e.message}`);
      }
    }

    const getCardId = db.prepare('SELECT id FROM cards WHERE name = ? LIMIT 1');
    for (const owned of (backupData.data.owned_cards || []).filter(o => restoredUserIds.includes(Number(o.user_id)))) {
      try {
        const card = getCardId.get(owned.card_name);
        if (!card) throw new Error('card not found in current database');
        db.prepare(`
          INSERT INTO owned_cards (user_id, card_id, quantity, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(user_id, card_id) DO UPDATE SET quantity=excluded.quantity, updated_at=excluded.updated_at
        `).run(owned.user_id, card.id, owned.quantity, owned.created_at, owned.updated_at);
        results.owned_cards++;
      } catch (e) {
        results.errors.push(`Owned card ${owned.card_name}: ${e.message}`);
      }
    }

    const getPrintingId = db.prepare('SELECT id FROM printings WHERE uuid = ? LIMIT 1');
    for (const owned of (backupData.data.owned_printings || []).filter(o => restoredUserIds.includes(Number(o.user_id)))) {
      try {
        const printing = getPrintingId.get(owned.printing_uuid);
        if (!printing) throw new Error('printing not found in current database');
        db.prepare(`
          INSERT INTO owned_printings (user_id, printing_id, quantity, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(user_id, printing_id) DO UPDATE SET quantity=excluded.quantity, updated_at=excluded.updated_at
        `).run(owned.user_id, printing.id, owned.quantity, owned.created_at, owned.updated_at);
        results.owned_printings++;
      } catch (e) {
        results.errors.push(`Owned printing ${owned.printing_uuid}: ${e.message}`);
      }
    }

    const deckMap = new Map();
    const decks = (backupData.data.decks || []).filter(d => restoredUserIds.includes(Number(d.user_id)));
    for (const deck of decks) {
      try {
        let newId = deck.id;
        const collision = db.prepare('SELECT user_id FROM decks WHERE id = ?').get(deck.id);
        if (userId !== null && collision && Number(collision.user_id) !== Number(userId)) {
          const inserted = db.prepare(`INSERT INTO decks (user_id, name, format, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
            .run(userId, deck.name, deck.format, deck.description, deck.created_at, deck.updated_at);
          newId = Number(inserted.lastInsertRowid);
        } else {
          db.prepare(`
            INSERT INTO decks (id, user_id, name, format, description, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET user_id=excluded.user_id, name=excluded.name, format=excluded.format,
              description=excluded.description, updated_at=excluded.updated_at
          `).run(deck.id, deck.user_id, deck.name, deck.format, deck.description, deck.created_at, deck.updated_at);
        }
        deckMap.set(Number(deck.id), Number(newId));
        results.decks++;
      } catch (e) {
        results.errors.push(`Deck ${deck.name}: ${e.message}`);
      }
    }

    for (const card of backupData.data.deck_cards || []) {
      const mappedDeckId = deckMap.get(Number(card.deck_id));
      if (!mappedDeckId) continue;
      try {
        const printing = getPrintingId.get(card.printing_uuid);
        if (!printing) throw new Error('printing not found in current database');
        const boardType = card.board_type || (card.is_sideboard ? 'sideboard' : 'mainboard');
        db.prepare(`
          INSERT INTO deck_cards (deck_id, printing_id, quantity, is_sideboard, is_commander, board_type, added_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(deck_id, printing_id, is_sideboard) DO UPDATE SET
            quantity=excluded.quantity, is_commander=excluded.is_commander, board_type=excluded.board_type
        `).run(mappedDeckId, printing.id, card.quantity, card.is_sideboard || 0, card.is_commander || 0, boardType, card.added_at);
        results.deck_cards++;
      } catch (e) {
        results.errors.push(`Deck card ${card.printing_uuid}: ${e.message}`);
      }
    }

    for (const share of backupData.data.deck_shares || []) {
      const mappedDeckId = deckMap.get(Number(share.deck_id));
      if (!mappedDeckId) continue;
      try {
        db.prepare(`INSERT OR IGNORE INTO deck_shares (deck_id, user_id, share_token, is_active, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(mappedDeckId, share.user_id, share.share_token, share.is_active, share.created_at, share.expires_at);
        results.deck_shares++;
      } catch (e) {
        results.errors.push(`Deck share: ${e.message}`);
      }
    }

    const watchMap = new Map();
    for (const watch of (backupData.data.price_watches || []).filter(w => restoredUserIds.includes(Number(w.user_id)))) {
      try {
        const values = [watch.user_id, watch.card_name, watch.max_price, watch.condition, watch.notes, watch.is_active,
          watch.expires_at, watch.last_checked, watch.last_price, watch.last_notified, watch.created_at,
          watch.card_id, watch.scryfall_id, watch.image_url, watch.set_code, watch.set_name];
        let newId = watch.id;
        const collision = db.prepare('SELECT user_id FROM price_watches WHERE id = ?').get(watch.id);
        if (userId !== null && collision && Number(collision.user_id) !== Number(userId)) {
          const inserted = db.prepare(`
            INSERT INTO price_watches (user_id, card_name, max_price, condition, notes, is_active, expires_at,
              last_checked, last_price, last_notified, created_at, card_id, scryfall_id, image_url, set_code, set_name)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(...values);
          newId = Number(inserted.lastInsertRowid);
        } else {
          db.prepare(`
            INSERT INTO price_watches (id, user_id, card_name, max_price, condition, notes, is_active, expires_at,
              last_checked, last_price, last_notified, created_at, card_id, scryfall_id, image_url, set_code, set_name)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET card_name=excluded.card_name, max_price=excluded.max_price,
              condition=excluded.condition, notes=excluded.notes, is_active=excluded.is_active, expires_at=excluded.expires_at,
              last_checked=excluded.last_checked, last_price=excluded.last_price, last_notified=excluded.last_notified,
              card_id=excluded.card_id, scryfall_id=excluded.scryfall_id, image_url=excluded.image_url,
              set_code=excluded.set_code, set_name=excluded.set_name
          `).run(watch.id, ...values);
        }
        watchMap.set(Number(watch.id), Number(newId));
        results.price_watches++;
      } catch (e) {
        results.errors.push(`Price watch ${watch.card_name}: ${e.message}`);
      }
    }

    for (const log of backupData.data.price_check_log || []) {
      const mappedWatchId = watchMap.get(Number(log.watch_id));
      if (!mappedWatchId) continue;
      try {
        db.prepare(`INSERT INTO price_check_log (watch_id, checked_at, found_price, notified) VALUES (?, ?, ?, ?)`)
          .run(mappedWatchId, log.checked_at, log.found_price, log.notified || 0);
        results.price_check_log++;
      } catch (e) {
        results.errors.push(`Price history: ${e.message}`);
      }
    }
  });

  restore();
  return results;
}

export function exportBackupToFile(backupData, filePath) {
  fs.writeFileSync(filePath, JSON.stringify(backupData, null, 2), 'utf8');
}

export function importBackupFromFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export function createScheduledBackup() {
  const backup = createBackup();
  const timestamp = new Date().toISOString().split('T')[0];
  const filename = `scheduled-backup-${timestamp}-${Date.now()}.json`;
  const filepath = safeBackupPath(filename);
  exportBackupToFile(backup, filepath);
  backupConfig.lastRun = new Date().toISOString();
  persistBackupConfig();
  cleanupOldBackups();
  console.log(`✓ Scheduled backup created: ${filename}`);
  return { filename, filepath, timestamp: backup.timestamp };
}

export function cleanupOldBackups() {
  try {
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('scheduled-backup-') && f.endsWith('.json'))
      .map(name => ({ name, mtime: fs.statSync(safeBackupPath(name)).mtime.getTime() }))
      .sort((a, b) => b.mtime - a.mtime);

    for (const file of files.slice(backupConfig.retainCount)) fs.unlinkSync(safeBackupPath(file.name));
  } catch (error) {
    console.error('Error cleaning up old backups:', error.message);
  }
}

export function listBackups() {
  return fs.readdirSync(BACKUP_DIR)
    .filter(f => f.endsWith('.json') && path.basename(f) === f)
    .map(filename => {
      const stats = fs.statSync(safeBackupPath(filename));
      return {
        filename,
        size: stats.size,
        created: stats.mtime.toISOString(),
        type: filename.startsWith('scheduled-backup-') ? 'scheduled' : filename.startsWith('pre-sync-safety') ? 'pre-sync' : 'manual',
      };
    })
    .sort((a, b) => new Date(b.created) - new Date(a.created));
}

export function loadBackupFile(filename) {
  const filepath = safeBackupPath(filename);
  if (!fs.existsSync(filepath)) throw new Error(`Backup file not found: ${filename}`);
  return importBackupFromFile(filepath);
}

export function deleteBackupFile(filename) {
  const filepath = safeBackupPath(filename);
  if (!fs.existsSync(filepath)) throw new Error(`Backup file not found: ${filename}`);
  fs.unlinkSync(filepath);
  return { success: true };
}

function scheduleExpression(frequency) {
  switch (frequency) {
    case '6hours': return '0 */6 * * *';
    case '12hours': return '0 */12 * * *';
    case 'weekly': return '0 2 * * 0';
    case 'daily': return '0 2 * * *';
    default: throw new Error('Invalid backup frequency');
  }
}

export function configureScheduledBackups(config = {}) {
  if (config.enabled !== undefined) backupConfig.enabled = !!config.enabled;
  if (config.frequency !== undefined) backupConfig.frequency = config.frequency;
  if (config.retainCount !== undefined) {
    const retainCount = Number(config.retainCount);
    if (!Number.isInteger(retainCount) || retainCount < 1 || retainCount > 100) throw new Error('retainCount must be between 1 and 100');
    backupConfig.retainCount = retainCount;
  }

  if (scheduledBackupJob) {
    scheduledBackupJob.stop();
    scheduledBackupJob = null;
  }

  if (backupConfig.enabled) {
    scheduledBackupJob = cron.schedule(scheduleExpression(backupConfig.frequency), () => {
      try { createScheduledBackup(); } catch (error) { console.error('Scheduled backup failed:', error.message); }
    });
  }

  persistBackupConfig();
  return getBackupConfig();
}

export function setupScheduledBackups() {
  configureScheduledBackups(backupConfig);
}

export function getBackupConfig() {
  return { ...backupConfig };
}
