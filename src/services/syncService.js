import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import cron from 'node-cron';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let isRunning = false;
let lastRun = null;
let lastError = null;

function runImportProcess(scriptPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      stdio: 'inherit',
      env: { ...process.env, FORCE_REIMPORT: 'true' },
    });

    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) return resolve();
      reject(new Error(signal
        ? `MTGJSON sync terminated by signal ${signal}`
        : `MTGJSON sync exited with code ${code}`));
    });
  });
}

/**
 * Run the MTGJSON import/update in a child process. The web process remains
 * responsive so it can return an explicit maintenance response while the
 * destructive refresh is in progress instead of appearing hung.
 */
export async function runSync() {
  if (isRunning) throw new Error('Sync already in progress');

  isRunning = true;
  lastError = null;
  try {
    console.log('\n🔄 Starting MTGJSON sync...');
    const scriptPath = join(__dirname, '../../scripts/import-mtgjson.js');
    await runImportProcess(scriptPath);
    lastRun = new Date();
    console.log('✓ Sync completed successfully');
    return { success: true, lastRun };
  } catch (error) {
    lastError = error.message;
    console.error('✗ Sync failed:', error.message);
    throw error;
  } finally {
    isRunning = false;
  }
}

export function getSyncStatus() {
  return { isRunning, lastRun, lastError };
}

export function setupDailySync() {
  cron.schedule('0 3 * * 0', async () => {
    console.log('\n⏰ Running scheduled weekly sync...');
    try { await runSync(); } catch (error) { console.error('Scheduled sync failed:', error.message); }
  });
  console.log('✓ Weekly sync scheduled for Sundays at 3:00 AM');
}
