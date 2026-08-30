import cron from 'node-cron';
import { getDb } from '../db/connection.js';
import { getLowestPrice as manaPoolPrice, isConfigured as manaPoolConfigured } from './manaPoolService.js';
import { getLowestPrice as tcgPlayerPrice, isConfigured as tcgConfigured } from './tcgplayerService.js';
import { sendPriceAlert } from './notificationService.js';

const VALID_CONDITIONS = new Set(['nm', 'lp', 'mp', 'hp', 'dm', 'any']);

async function getLowestPrice(cardName, condition, scryfallId = null) {
  if (manaPoolConfigured()) return manaPoolPrice(cardName, condition, scryfallId);
  if (tcgConfigured()) return tcgPlayerPrice(cardName, condition);
  throw new Error('No price source configured — set MANAPOOL_API_TOKEN or TCGPlayer credentials');
}

export function getWatches(userId) {
  const db = getDb();
  return db.prepare(`
    SELECT w.*,
           (SELECT found_price FROM price_check_log WHERE watch_id = w.id ORDER BY checked_at DESC LIMIT 1) AS latest_price
    FROM price_watches w
    WHERE w.user_id = ?
    ORDER BY w.created_at DESC
  `).all(userId);
}

export function createWatch(userId, { cardName, maxPrice, condition = 'nm', notes, expiresAt, cardId, scryfallId, imageUrl, setCode, setName }) {
  if (!cardName?.trim()) throw new Error('card_name is required');
  if (!VALID_CONDITIONS.has(condition)) throw new Error('Invalid condition');

  const parsedMax = maxPrice != null && maxPrice !== '' ? parseFloat(maxPrice) : null;
  if (parsedMax !== null && (!Number.isFinite(parsedMax) || parsedMax <= 0)) {
    throw new Error('max_price must be a positive number');
  }

  const db = getDb();
  const result = db.prepare(`
    INSERT INTO price_watches (user_id, card_name, max_price, condition, notes, expires_at, card_id, scryfall_id, image_url, set_code, set_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(userId, cardName.trim(), parsedMax, condition, notes || null, expiresAt || null,
    cardId || null, scryfallId || null, imageUrl || null, setCode || null, setName || null);

  return db.prepare('SELECT * FROM price_watches WHERE id = ?').get(result.lastInsertRowid);
}

export function updateWatch(userId, watchId, updates) {
  const db = getDb();
  const watch = db.prepare('SELECT * FROM price_watches WHERE id = ? AND user_id = ?').get(watchId, userId);
  if (!watch) throw new Error('Watch not found');

  const fields = [];
  const values = [];

  if (updates.maxPrice !== undefined) {
    const v = updates.maxPrice != null && updates.maxPrice !== '' ? parseFloat(updates.maxPrice) : null;
    if (v !== null && (!Number.isFinite(v) || v <= 0)) throw new Error('max_price must be a positive number');
    fields.push('max_price = ?');
    values.push(v);
  }
  if (updates.condition !== undefined) {
    if (!VALID_CONDITIONS.has(updates.condition)) throw new Error('Invalid condition');
    fields.push('condition = ?');
    values.push(updates.condition);
  }
  if (updates.notes !== undefined) {
    fields.push('notes = ?');
    values.push(updates.notes || null);
  }
  if (updates.expiresAt !== undefined) {
    fields.push('expires_at = ?');
    values.push(updates.expiresAt || null);
  }
  if (updates.isActive !== undefined) {
    fields.push('is_active = ?');
    values.push(updates.isActive ? 1 : 0);
  }

  if (!fields.length) return watch;
  values.push(watchId, userId);
  db.prepare(`UPDATE price_watches SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`).run(...values);
  return db.prepare('SELECT * FROM price_watches WHERE id = ? AND user_id = ?').get(watchId, userId);
}

export function deleteWatch(userId, watchId) {
  const db = getDb();
  const result = db.prepare('DELETE FROM price_watches WHERE id = ? AND user_id = ?').run(watchId, userId);
  if (!result.changes) throw new Error('Watch not found');
}

export function getWatchHistory(userId, watchId, limit = 50) {
  const db = getDb();
  const watch = db.prepare('SELECT id FROM price_watches WHERE id = ? AND user_id = ?').get(watchId, userId);
  if (!watch) throw new Error('Watch not found');
  const safeLimit = Math.min(Math.max(parseInt(limit) || 50, 1), 500);
  return db.prepare(`SELECT * FROM price_check_log WHERE watch_id = ? ORDER BY checked_at DESC LIMIT ?`).all(watchId, safeLimit);
}

async function checkWatch(watch) {
  const db = getDb();
  try {
    const conditionArg = watch.condition === 'any' ? null : watch.condition;
    const result = await getLowestPrice(watch.card_name, conditionArg ?? 'nm', watch.scryfall_id || null);
    const foundPrice = result?.lowPrice ?? null;
    let notified = 0;

    if (foundPrice !== null) {
      if (watch.max_price !== null) {
        notified = foundPrice <= watch.max_price ? 1 : 0;
      } else {
        const prevLog = db.prepare(`
          SELECT found_price FROM price_check_log
          WHERE watch_id = ? AND found_price IS NOT NULL
          ORDER BY checked_at DESC LIMIT 1
        `).get(watch.id);
        if (prevLog && foundPrice < prevLog.found_price) notified = 1;
      }
    }

    db.prepare(`INSERT INTO price_check_log (watch_id, found_price, notified) VALUES (?, ?, ?)`)
      .run(watch.id, foundPrice, notified);
    db.prepare(`UPDATE price_watches SET last_checked = datetime('now'), last_price = ? WHERE id = ?`)
      .run(foundPrice, watch.id);

    if (notified) {
      const lastNotified = watch.last_notified ? new Date(watch.last_notified) : null;
      const hoursSinceLast = lastNotified ? (Date.now() - lastNotified.getTime()) / 3_600_000 : Infinity;
      if (hoursSinceLast > 24) {
        await sendPriceAlert({
          cardName: watch.card_name,
          foundPrice,
          threshold: watch.max_price,
          condition: watch.condition,
        });
        db.prepare(`UPDATE price_watches SET last_notified = datetime('now') WHERE id = ?`).run(watch.id);
        console.log(`  ✓ Alert sent: ${watch.card_name} @ $${foundPrice}`);
      }
    }

    return { id: watch.id, cardName: watch.card_name, foundPrice, notified: !!notified };
  } catch (err) {
    console.error(`  ✗ Failed to check "${watch.card_name}": ${err.message}`);
    return { id: watch.id, cardName: watch.card_name, error: err.message };
  }
}

/**
 * Run price checks. Scheduled server jobs pass no userId and check everyone;
 * manual API requests pass the authenticated userId and can only check that user.
 */
export async function runPriceChecks(userId = null) {
  const db = getDb();
  const userClause = userId === null ? '' : 'AND user_id = ?';
  const watches = db.prepare(`
    SELECT * FROM price_watches
    WHERE is_active = 1
      AND (expires_at IS NULL OR expires_at > datetime('now'))
      ${userClause}
    ORDER BY last_checked ASC NULLS FIRST
  `).all(...(userId === null ? [] : [userId]));

  if (!watches.length) return [];

  const results = [];
  for (const watch of watches) {
    results.push(await checkWatch(watch));
    await new Promise(resolve => setTimeout(resolve, 1500));
  }

  const expireSql = userId === null
    ? `UPDATE price_watches SET is_active = 0 WHERE is_active = 1 AND expires_at IS NOT NULL AND expires_at <= datetime('now')`
    : `UPDATE price_watches SET is_active = 0 WHERE user_id = ? AND is_active = 1 AND expires_at IS NOT NULL AND expires_at <= datetime('now')`;
  db.prepare(expireSql).run(...(userId === null ? [] : [userId]));

  return results;
}

let activeScheduleJob = null;
let activeScheduleExpression = process.env.PRICE_CHECK_SCHEDULE || '0 */6 * * *';

export function getPriceCheckSchedule() {
  return activeScheduleExpression;
}

export function setPriceCheckSchedule(expression) {
  if (!cron.validate(expression)) throw new Error(`Invalid cron expression: ${expression}`);
  const isReschedule = !!activeScheduleJob;
  if (activeScheduleJob) {
    activeScheduleJob.stop();
    activeScheduleJob = null;
  }
  activeScheduleExpression = expression;
  activeScheduleJob = cron.schedule(expression, async () => {
    console.log('\n⏰ Running scheduled price checks...');
    try { await runPriceChecks(); } catch (err) { console.error('Scheduled price check failed:', err.message); }
  });
  console.log(`✓ Price monitoring ${isReschedule ? 'rescheduled' : 'scheduled'} (${expression})`);
}

export function setupPriceMonitoringSchedule() {
  setPriceCheckSchedule(activeScheduleExpression);
}
