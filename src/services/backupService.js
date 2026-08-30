import { getDb } from '../db/index.js';
import fs from 'fs';
import path from 'path';
import cron from 'node-cron';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Backup configuration
const DATA_DIR = process.env.DATA_PATH || path.join(__dirname, '../../data');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const BACKUP_CONFIG_FILE = path.join(DATA_DIR, 'backup-config.json');

if (!fs.existsSync(BACKUP_DIR)) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

const DEFAULT_BACKUP_CONFIG = {
  enabled: false,
  frequency: 'daily',
  retainCount: 10,
  lastRun: null,
};

const ALLOWED_FREQUENCIES = new Set(['6hours', '12hours', 'daily', 'weekly']);

function loadBackupConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(BACKUP_CONFIG_FILE, 'utf8'));
    return {
      ...DEFAULT_BACKUP_CONFIG,
      ...(parsed && typeof parsed === 'object' ? parsed : {}),
    };
  } catch {
    return { ...DEFAULT_BACKUP_CONFIG };
  }
}

function persistBackupConfig() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(BACKUP_CONFIG_FILE, JSON.stringify(backupConfig, null, 2), 'utf8');
}

function resolveBackupPath(filename) {
  if (typeof filename !== 'string' || !filename || path.basename(filename) !== filename) {
    throw new Error('Invalid backup filename');
  }
  if (!filename.endsWith('.json')) {
    throw new Error('Backup filename must end with .json');
  }

  const backupRoot = path.resolve(BACKUP_DIR);
  const resolved = path.resolve(BACKUP_DIR, filename);
  if (resolved !== path.join(backupRoot, filename) || !resolved.startsWith(backupRoot + path.sep)) {
    throw new Error('Invalid backup filename');
  }
  return resolved;
}

function placeholders(values) {
  return values.map(() => '?').join(',');
}

let scheduledBackupJob = null;
let backupConfig = loadBackupConfig();

/**
 * Create a backup of user-owned data.
 * If userId is provided, only that user's data is included.
 */
export function createBackup(userId = null) {
  const db = getDb();

  const backup = {
    version: '1.1',
    timestamp: new Date().toISOString(),
    data: {}
  };

  if (userId !== null) {
    backup.data.users = db.prepare(`
      SELECT id, username, email, password_hash, is_admin, created_at, updated_at
      FROM users
      WHERE id = ?
    `).all(userId);
  } else {
    backup.data.users = db.prepare(`
      SELECT id, username, email, password_hash, is_admin, created_at, updated_at
      FROM users
    `).all();
  }

  const userIds = backup.data.users.map(u => u.id);
  if (userIds.length === 0) {
    backup.data.api_keys = [];
    backup.data.owned_cards = [];
    backup.data.owned_printings = [];
    backup.data.decks = [];
    backup.data.deck_cards = [];
    backup.data.deck_shares = [];
    backup.data.price_watches = [];
    backup.data.price_check_log = [];
    return backup;
  }

  const userSql = placeholders(userIds);

  backup.data.api_keys = db.prepare(`
    SELECT id, user_id, key_hash, name, last_used, created_at
    FROM api_keys
    WHERE user_id IN (${userSql})
  `).all(...userIds);

  backup.data.owned_cards = db.prepare(`
    SELECT oc.user_id, oc.quantity, oc.created_at, oc.updated_at,
           c.name as card_name
    FROM owned_cards oc
    JOIN cards c ON oc.card_id = c.id
    WHERE oc.user_id IN (${userSql})
  `).all(...userIds);

  backup.data.owned_printings = db.prepare(`
    SELECT op.user_id, op.quantity, op.created_at, op.updated_at,
           p.uuid as printing_uuid
    FROM owned_printings op
    JOIN printings p ON op.printing_id = p.id
    WHERE op.user_id IN (${userSql})
  `).all(...userIds);

  backup.data.decks = db.prepare(`
    SELECT id, user_id, name, format, description, created_at, updated_at
    FROM decks
    WHERE user_id IN (${userSql})
  `).all(...userIds);

  const deckIds = backup.data.decks.map(d => d.id);
  if (deckIds.length > 0) {
    const deckSql = placeholders(deckIds);

    backup.data.deck_cards = db.prepare(`
      SELECT dc.deck_id, dc.quantity, dc.is_sideboard, dc.is_commander,
             dc.board_type, dc.added_at, p.uuid as printing_uuid
      FROM deck_cards dc
      JOIN printings p ON dc.printing_id = p.id
      WHERE dc.deck_id IN (${deckSql})
    `).all(...deckIds);

    backup.data.deck_shares = db.prepare(`
      SELECT id, deck_id, user_id, share_token, is_active, created_at, expires_at
      FROM deck_shares
      WHERE deck_id IN (${deckSql})
    `).all(...deckIds);
  } else {
    backup.data.deck_cards = [];
    backup.data.deck_shares = [];
  }

  backup.data.price_watches = db.prepare(`
    SELECT *
    FROM price_watches
    WHERE user_id IN (${userSql})
  `).all(...userIds);

  const watchIds = backup.data.price_watches.map(w => w.id);
  if (watchIds.length > 0) {
    const watchSql = placeholders(watchIds);
    backup.data.price_check_log = db.prepare(`
      SELECT *
      FROM price_check_log
      WHERE watch_id IN (${watchSql})
    `).all(...watchIds);
  } else {
    backup.data.price_check_log = [];
  }

  return backup;
}

/**
 * Restore data from a backup.
 * A scoped user restore never restores account privileges or API keys.
 */
export function restoreBackup(backupData, options = {}) {
  const db = getDb();
  const { overwrite = false, userId = null } = options;

  if (!backupData?.version || !backupData?.data) {
    throw new Error('Invalid backup format');
  }

  const sourceUsers = backupData.data.users || [];
  let usersToRestore = sourceUsers;

  if (userId !== null) {
    usersToRestore = sourceUsers.filter(u => u.id === userId);
    if (usersToRestore.length === 0) {
      throw new Error(`User ${userId} not found in backup`);
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
    errors: []
  };

  const restore = db.transaction(() => {
    if (overwrite && userId !== null) {
      db.prepare('DELETE FROM price_check_log WHERE watch_id IN (SELECT id FROM price_watches WHERE user_id = ?)').run(userId);
      db.prepare('DELETE FROM price_watches WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM deck_shares WHERE deck_id IN (SELECT id FROM decks WHERE user_id = ?)').run(userId);
      db.prepare('DELETE FROM deck_cards WHERE deck_id IN (SELECT id FROM decks WHERE user_id = ?)').run(userId);
      db.prepare('DELETE FROM decks WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM owned_printings WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM owned_cards WHERE user_id = ?').run(userId);
      // Keep the current user row and API keys so a self-restore cannot change
      // privileges or invalidate the credentials being used for the restore.
    } else if (overwrite) {
      db.prepare('DELETE FROM price_check_log').run();
      db.prepare('DELETE FROM price_watches').run();
      db.prepare('DELETE FROM deck_shares').run();
      db.prepare('DELETE FROM deck_cards').run();
      db.prepare('DELETE FROM decks').run();
      db.prepare('DELETE FROM owned_printings').run();
      db.prepare('DELETE FROM owned_cards').run();
      db.prepare('DELETE FROM api_keys').run();
      db.prepare('DELETE FROM users').run();
    }

    const restoredUserIds = userId !== null
      ? [userId]
      : usersToRestore.map(u => u.id);

    if (userId === null) {
      const upsertUser = db.prepare(`
        INSERT INTO users (id, username, email, password_hash, is_admin, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          username = excluded.username,
          email = excluded.email,
          password_hash = excluded.password_hash,
          is_admin = excluded.is_admin,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
      `);

      for (const user of usersToRestore) {
        try {
          upsertUser.run(
            user.id,
            user.username,
            user.email,
            user.password_hash,
            user.is_admin || 0,
            user.created_at,
            user.updated_at
          );
          results.users++;
        } catch (e) {
          results.errors.push(`User ${user.username}: ${e.message}`);
        }
      }

      const apiKeys = (backupData.data.api_keys || []).filter(k =>
        restoredUserIds.includes(k.user_id)
      );
      const upsertApiKey = db.prepare(`
        INSERT INTO api_keys (id, user_id, key_hash, name, last_used, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          user_id = excluded.user_id,
          key_hash = excluded.key_hash,
          name = excluded.name,
          last_used = excluded.last_used,
          created_at = excluded.created_at
      `);
      for (const key of apiKeys) {
        try {
          upsertApiKey.run(key.id, key.user_id, key.key_hash, key.name, key.last_used, key.created_at);
          results.api_keys++;
        } catch (e) {
          results.errors.push(`API key ${key.name}: ${e.message}`);
        }
      }
    }

    const sourceUserIds = new Set(usersToRestore.map(u => u.id));
    const mapUserId = backupUserId => {
      if (!sourceUserIds.has(backupUserId)) return null;
      return userId !== null ? userId : backupUserId;
    };

    const getCardId = db.prepare('SELECT id FROM cards WHERE name = ? LIMIT 1');
    const upsertOwnedCard = db.prepare(`
      INSERT INTO owned_cards (user_id, card_id, quantity, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, card_id) DO UPDATE SET
        quantity = excluded.quantity,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `);

    for (const ownedCard of backupData.data.owned_cards || []) {
      const targetUserId = mapUserId(ownedCard.user_id);
      if (targetUserId === null) continue;
      try {
        const card = getCardId.get(ownedCard.card_name);
        if (!card) {
          results.errors.push(`Card "${ownedCard.card_name}" not found in database`);
          continue;
        }
        upsertOwnedCard.run(
          targetUserId,
          card.id,
          ownedCard.quantity,
          ownedCard.created_at,
          ownedCard.updated_at
        );
        results.owned_cards++;
      } catch (e) {
        results.errors.push(`Owned card ${ownedCard.card_name}: ${e.message}`);
      }
    }

    const getPrintingId = db.prepare('SELECT id FROM printings WHERE uuid = ? LIMIT 1');
    const upsertOwnedPrinting = db.prepare(`
      INSERT INTO owned_printings (user_id, printing_id, quantity, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, printing_id) DO UPDATE SET
        quantity = excluded.quantity,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `);

    for (const ownedPrinting of backupData.data.owned_printings || []) {
      const targetUserId = mapUserId(ownedPrinting.user_id);
      if (targetUserId === null) continue;
      try {
        const printing = getPrintingId.get(ownedPrinting.printing_uuid);
        if (!printing) {
          results.errors.push(`Printing UUID ${ownedPrinting.printing_uuid} not found in database`);
          continue;
        }
        upsertOwnedPrinting.run(
          targetUserId,
          printing.id,
          ownedPrinting.quantity,
          ownedPrinting.created_at,
          ownedPrinting.updated_at
        );
        results.owned_printings++;
      } catch (e) {
        results.errors.push(`Owned printing ${ownedPrinting.printing_uuid}: ${e.message}`);
      }
    }

    const deckIdMap = new Map();
    const decks = (backupData.data.decks || []).filter(d => mapUserId(d.user_id) !== null);

    for (const deck of decks) {
      const targetUserId = mapUserId(deck.user_id);
      try {
        let targetDeckId = deck.id;

        if (userId !== null) {
          const existing = db.prepare('SELECT user_id FROM decks WHERE id = ?').get(deck.id);
          if (existing && existing.user_id !== targetUserId) {
            targetDeckId = null;
          }
        }

        if (targetDeckId !== null) {
          db.prepare(`
            INSERT INTO decks (id, user_id, name, format, description, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              user_id = excluded.user_id,
              name = excluded.name,
              format = excluded.format,
              description = excluded.description,
              created_at = excluded.created_at,
              updated_at = excluded.updated_at
          `).run(
            targetDeckId,
            targetUserId,
            deck.name,
            deck.format,
            deck.description,
            deck.created_at,
            deck.updated_at
          );
        } else {
          const inserted = db.prepare(`
            INSERT INTO decks (user_id, name, format, description, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(
            targetUserId,
            deck.name,
            deck.format,
            deck.description,
            deck.created_at,
            deck.updated_at
          );
          targetDeckId = Number(inserted.lastInsertRowid);
        }

        deckIdMap.set(deck.id, targetDeckId);
        results.decks++;
      } catch (e) {
        results.errors.push(`Deck ${deck.name}: ${e.message}`);
      }
    }

    const upsertDeckCard = db.prepare(`
      INSERT INTO deck_cards (deck_id, printing_id, quantity, is_sideboard, is_commander, board_type, added_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(deck_id, printing_id, is_sideboard) DO UPDATE SET
        quantity = excluded.quantity,
        is_commander = excluded.is_commander,
        board_type = excluded.board_type,
        added_at = excluded.added_at
    `);

    for (const deckCard of backupData.data.deck_cards || []) {
      const targetDeckId = deckIdMap.get(deckCard.deck_id);
      if (!targetDeckId) continue;
      try {
        const printing = getPrintingId.get(deckCard.printing_uuid);
        if (!printing) {
          results.errors.push(`Printing UUID ${deckCard.printing_uuid} not found in database`);
          continue;
        }
        upsertDeckCard.run(
          targetDeckId,
          printing.id,
          deckCard.quantity,
          deckCard.is_sideboard,
          deckCard.is_commander,
          deckCard.board_type || (deckCard.is_sideboard ? 'sideboard' : 'mainboard'),
          deckCard.added_at
        );
        results.deck_cards++;
      } catch (e) {
        results.errors.push(`Deck card: ${e.message}`);
      }
    }

    for (const share of backupData.data.deck_shares || []) {
      const targetDeckId = deckIdMap.get(share.deck_id);
      const targetUserId = mapUserId(share.user_id);
      if (!targetDeckId || targetUserId === null) continue;

      try {
        if (userId !== null) {
          const tokenOwner = db.prepare(`
            SELECT ds.user_id
            FROM deck_shares ds
            WHERE ds.share_token = ?
          `).get(share.share_token);

          if (tokenOwner && tokenOwner.user_id !== targetUserId) {
            results.errors.push('Skipped a deck share because its token is already in use');
            continue;
          }

          db.prepare(`
            INSERT INTO deck_shares (deck_id, user_id, share_token, is_active, created_at, expires_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(share_token) DO UPDATE SET
              deck_id = excluded.deck_id,
              user_id = excluded.user_id,
              is_active = excluded.is_active,
              created_at = excluded.created_at,
              expires_at = excluded.expires_at
          `).run(
            targetDeckId,
            targetUserId,
            share.share_token,
            share.is_active,
            share.created_at,
            share.expires_at
          );
        } else {
          db.prepare(`
            INSERT INTO deck_shares (id, deck_id, user_id, share_token, is_active, created_at, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              deck_id = excluded.deck_id,
              user_id = excluded.user_id,
              share_token = excluded.share_token,
              is_active = excluded.is_active,
              created_at = excluded.created_at,
              expires_at = excluded.expires_at
          `).run(
            share.id,
            targetDeckId,
            targetUserId,
            share.share_token,
            share.is_active,
            share.created_at,
            share.expires_at
          );
        }
        results.deck_shares++;
      } catch (e) {
        results.errors.push(`Deck share: ${e.message}`);
      }
    }

    const watchIdMap = new Map();
    for (const watch of backupData.data.price_watches || []) {
      const targetUserId = mapUserId(watch.user_id);
      if (targetUserId === null) continue;

      try {
        let targetWatchId = watch.id;

        if (userId !== null) {
          const existing = db.prepare('SELECT user_id FROM price_watches WHERE id = ?').get(watch.id);
          if (existing && existing.user_id !== targetUserId) {
            targetWatchId = null;
          }
        }

        const columns = [
          'user_id', 'card_name', 'max_price', 'condition', 'notes', 'is_active',
          'expires_at', 'last_checked', 'last_price', 'last_notified', 'created_at',
          'card_id', 'scryfall_id', 'image_url', 'set_code', 'set_name'
        ];
        const values = columns.map(col => col === 'user_id' ? targetUserId : (watch[col] ?? null));

        if (targetWatchId !== null) {
          const setters = columns.map(col => `${col} = excluded.${col}`).join(', ');
          db.prepare(`
            INSERT INTO price_watches (id, ${columns.join(', ')})
            VALUES (?, ${columns.map(() => '?').join(', ')})
            ON CONFLICT(id) DO UPDATE SET ${setters}
          `).run(targetWatchId, ...values);
        } else {
          const inserted = db.prepare(`
            INSERT INTO price_watches (${columns.join(', ')})
            VALUES (${columns.map(() => '?').join(', ')})
          `).run(...values);
          targetWatchId = Number(inserted.lastInsertRowid);
        }

        watchIdMap.set(watch.id, targetWatchId);
        results.price_watches++;
      } catch (e) {
        results.errors.push(`Price watch ${watch.card_name}: ${e.message}`);
      }
    }

    for (const log of backupData.data.price_check_log || []) {
      const targetWatchId = watchIdMap.get(log.watch_id);
      if (!targetWatchId) continue;

      try {
        if (userId === null) {
          db.prepare(`
            INSERT INTO price_check_log (id, watch_id, checked_at, found_price, notified)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              watch_id = excluded.watch_id,
              checked_at = excluded.checked_at,
              found_price = excluded.found_price,
              notified = excluded.notified
          `).run(log.id, targetWatchId, log.checked_at, log.found_price, log.notified);
        } else {
          db.prepare(`
            INSERT INTO price_check_log (watch_id, checked_at, found_price, notified)
            VALUES (?, ?, ?, ?)
          `).run(targetWatchId, log.checked_at, log.found_price, log.notified);
        }
        results.price_check_log++;
      } catch (e) {
        results.errors.push(`Price check log: ${e.message}`);
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
  const data = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(data);
}

export function createScheduledBackup() {
  const backup = createBackup();
  const timestamp = new Date().toISOString().split('T')[0];
  const filename = `scheduled-backup-${timestamp}-${Date.now()}.json`;
  const filepath = resolveBackupPath(filename);

  exportBackupToFile(backup, filepath);
  backupConfig.lastRun = new Date().toISOString();
  persistBackupConfig();

  console.log(`✓ Scheduled backup created: ${filename}`);
  cleanupOldBackups();

  return { filename, timestamp: backup.timestamp };
}

export function cleanupOldBackups() {
  try {
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('scheduled-backup-') && f.endsWith('.json'))
      .map(f => ({
        name: f,
        path: resolveBackupPath(f),
        mtime: fs.statSync(resolveBackupPath(f)).mtime.getTime()
      }))
      .sort((a, b) => b.mtime - a.mtime);

    const toDelete = files.slice(backupConfig.retainCount);
    for (const file of toDelete) {
      fs.unlinkSync(file.path);
      console.log(`  🗑️  Deleted old backup: ${file.name}`);
    }
  } catch (error) {
    console.error('Error cleaning up old backups:', error.message);
  }
}

export function listBackups() {
  try {
    return fs.readdirSync(BACKUP_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        const filepath = resolveBackupPath(f);
        const stats = fs.statSync(filepath);
        return {
          filename: f,
          size: stats.size,
          created: stats.mtime.toISOString(),
          type: f.startsWith('scheduled-backup-') ? 'scheduled' :
                f.startsWith('pre-sync-safety') ? 'pre-sync' : 'manual'
        };
      })
      .sort((a, b) => new Date(b.created) - new Date(a.created));
  } catch (error) {
    console.error('Error listing backups:', error.message);
    return [];
  }
}

export function loadBackupFile(filename) {
  const filepath = resolveBackupPath(filename);
  if (!fs.existsSync(filepath)) {
    throw new Error(`Backup file not found: ${filename}`);
  }
  return importBackupFromFile(filepath);
}

export function deleteBackupFile(filename) {
  const filepath = resolveBackupPath(filename);
  if (!fs.existsSync(filepath)) {
    throw new Error(`Backup file not found: ${filename}`);
  }
  fs.unlinkSync(filepath);
  console.log(`✓ Deleted backup: ${filename}`);
  return { success: true };
}

function scheduleConfiguredBackups() {
  if (scheduledBackupJob) {
    scheduledBackupJob.stop();
    scheduledBackupJob = null;
  }

  if (!backupConfig.enabled) {
    console.log('✓ Scheduled backups disabled');
    return;
  }

  const cronExpression = {
    '6hours': '0 */6 * * *',
    '12hours': '0 */12 * * *',
    daily: '0 2 * * *',
    weekly: '0 2 * * 0',
  }[backupConfig.frequency] || '0 2 * * *';

  scheduledBackupJob = cron.schedule(cronExpression, () => {
    console.log(`\n⏰ Running scheduled backup (${backupConfig.frequency})...`);
    try {
      createScheduledBackup();
    } catch (error) {
      console.error('Scheduled backup failed:', error.message);
    }
  });

  console.log(`✓ Scheduled backups enabled: ${backupConfig.frequency} (keeping last ${backupConfig.retainCount})`);
}

export function configureScheduledBackups(config = {}) {
  const next = { ...backupConfig };

  if (config.enabled !== undefined) {
    if (typeof config.enabled !== 'boolean') throw new Error('enabled must be a boolean');
    next.enabled = config.enabled;
  }
  if (config.frequency !== undefined) {
    if (!ALLOWED_FREQUENCIES.has(config.frequency)) throw new Error('Invalid backup frequency');
    next.frequency = config.frequency;
  }
  if (config.retainCount !== undefined) {
    const retainCount = Number(config.retainCount);
    if (!Number.isInteger(retainCount) || retainCount < 1 || retainCount > 100) {
      throw new Error('retainCount must be an integer between 1 and 100');
    }
    next.retainCount = retainCount;
  }

  backupConfig = next;
  persistBackupConfig();
  scheduleConfiguredBackups();
  return getBackupConfig();
}

export function setupScheduledBackups() {
  scheduleConfiguredBackups();
}

export function getBackupConfig() {
  return { ...backupConfig };
}
