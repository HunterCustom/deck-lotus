import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { runMigrations, closeDb, getDb } from './db/index.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';

import authRoutes from './routes/auth.js';
import cardRoutes from './routes/cards.js';
import deckRoutes from './routes/decks.js';
import setRoutes from './routes/sets.js';
import adminRoutes from './routes/admin.js';
import shoppingRoutes from './routes/shopping.js';
import inventoryRoutes from './routes/inventory.js';
import priceMonitoringRoutes from './routes/priceMonitoring.js';
import manapoolRoutes from './routes/manapool.js';
import { setupDailySync } from './services/syncService.js';
import { setupPriceMonitoringSchedule } from './services/priceMonitoringService.js';
import { setupScheduledBackups } from './services/backupService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(compression());
app.use(express.json({ limit: '10mb' }));

// Authentication endpoints are the only internet-facing operations where
// repeated requests are rarely legitimate. Keep the limit generous for LAN use.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts. Please try again later.' },
});
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/auth/refresh', authLimiter);

if (process.env.NODE_ENV === 'production') {
  const clientBuildPath = join(__dirname, '../client/dist');
  app.use(express.static(clientBuildPath));
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/api/auth', authRoutes);
app.use('/api/cards', cardRoutes);
app.use('/api/decks', deckRoutes);
app.use('/api/sets', setRoutes);
app.use('/api/shopping', shoppingRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/price-monitoring', priceMonitoringRoutes);
app.use('/api/manapool', manapoolRoutes);
app.use('/api/admin', adminRoutes);

if (process.env.NODE_ENV === 'production') {
  const clientBuildPath = join(__dirname, '../client/dist');
  app.get('*', (req, res) => res.sendFile(join(clientBuildPath, 'index.html')));
}

app.use(notFoundHandler);
app.use(errorHandler);

async function ensureAdminUser() {
  const { createAdminUser } = await import('./services/authService.js');
  const crypto = await import('crypto');
  const db = getDb();
  const adminExists = db.prepare('SELECT id FROM users WHERE is_admin = 1 LIMIT 1').get();
  if (adminExists) {
    console.log('✓ Admin user exists');
    return;
  }

  console.log('\n⚠️  No admin user found in database!');

  if (process.env.ADMIN_USERNAME && process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
    const existingUser = db.prepare('SELECT id, is_admin FROM users WHERE username = ?').get(process.env.ADMIN_USERNAME);
    if (existingUser && !existingUser.is_admin) {
      db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(existingUser.id);
      console.log(`✓ User '${process.env.ADMIN_USERNAME}' promoted to admin`);
      return;
    }

    if (!existingUser) {
      await createAdminUser(process.env.ADMIN_USERNAME, process.env.ADMIN_EMAIL, process.env.ADMIN_PASSWORD);
      console.log(`✓ Admin user created: ${process.env.ADMIN_USERNAME}`);
      console.log(`   Email: ${process.env.ADMIN_EMAIL}`);
      console.log('   Password supplied through ADMIN_PASSWORD (not written to logs).');
      return;
    }
  }

  const autoUsername = 'admin';
  const autoEmail = 'admin@localhost';
  const autoPassword = crypto.randomBytes(16).toString('hex');
  await createAdminUser(autoUsername, autoEmail, autoPassword);

  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  AUTO-GENERATED ADMIN CREDENTIALS                          ║');
  console.log('╠════════════════════════════════════════════════════════════╣');
  console.log(`║  Username: ${autoUsername.padEnd(47)} ║`);
  console.log(`║  Email:    ${autoEmail.padEnd(47)} ║`);
  console.log(`║  Password: ${autoPassword.padEnd(47)} ║`);
  console.log('╠════════════════════════════════════════════════════════════╣');
  console.log('║  Save these credentials now; they will not be shown again. ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');
}

async function ensureCardData() {
  const db = getDb();
  const cardCount = db.prepare('SELECT COUNT(*) as count FROM cards').get();
  const priceCount = db.prepare('SELECT COUNT(*) as count FROM prices').get();
  const setCount = db.prepare('SELECT COUNT(*) as count FROM sets').get();

  if (cardCount.count > 0 && priceCount.count > 0 && setCount.count > 0) {
    console.log(`✓ Found ${cardCount.count} cards, ${priceCount.count} prices, ${setCount.count} sets in database`);
    return;
  }

  console.log('\n⚠️  Missing card data detected. Importing from MTGJSON...');
  console.log(`   Cards: ${cardCount.count}, Prices: ${priceCount.count}, Sets: ${setCount.count}`);

  try {
    const { execSync } = await import('child_process');
    const scriptPath = join(__dirname, '../scripts/import-mtgjson.js');
    execSync(`node "${scriptPath}"`, { stdio: 'inherit', env: { ...process.env } });
    console.log('✓ Data imported successfully');
  } catch (error) {
    console.error('⚠️  Failed to auto-import data:', error.message);
    console.log('   You can manually import later by running: node scripts/import-mtgjson.js');
  }
}

async function start() {
  try {
    console.log('Initializing database...');
    await runMigrations();
    console.log('✓ Database initialized');

    try {
      await ensureAdminUser();
    } catch (error) {
      console.error('⚠️  Failed to check/create admin user:', error.message);
    }

    await ensureCardData();

    setupDailySync();
    setupPriceMonitoringSchedule();
    setupScheduledBackups();

    app.listen(PORT, '0.0.0.0', () => {
      console.log(`\n🚀 Deck Lotus server running on port ${PORT}`);
      console.log(`   Health check: http://0.0.0.0:${PORT}/health`);
      console.log(`   API: http://0.0.0.0:${PORT}/api`);
      if (process.env.NODE_ENV === 'development') console.log('\n📝 Development mode enabled');
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

function shutdown(signal) {
  console.log(`\n${signal} signal received: closing database`);
  closeDb();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start();
