import express from 'express';
import { runSync, getSyncStatus } from '../services/syncService.js';
import {
  createBackup,
  restoreBackup,
  createScheduledBackup,
  listBackups,
  loadBackupFile,
  deleteBackupFile,
  configureScheduledBackups,
  getBackupConfig
} from '../services/backupService.js';
import { getAllUsers, updateUser, deleteUser, resetUserPassword } from '../services/authService.js';
import { getSettings, updateSettings } from '../services/settingsService.js';
import { authenticate } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/adminAuth.js';

const router = express.Router();

router.get('/settings', authenticate, requireAdmin, (req, res, next) => {
  try { res.json(getSettings()); } catch (error) { next(error); }
});

router.put('/settings', authenticate, requireAdmin, (req, res, next) => {
  try { res.json(updateSettings(req.body || {})); } catch (error) { next(error); }
});

router.post('/sync', authenticate, requireAdmin, async (req, res, next) => {
  try {
    res.json(await runSync());
  } catch (error) {
    if (error.message === 'Sync already in progress') return res.status(409).json({ error: error.message });
    next(error);
  }
});

router.get('/sync-status', authenticate, requireAdmin, (req, res, next) => {
  try { res.json(getSyncStatus()); } catch (error) { next(error); }
});

/**
 * Download a backup. Admins may back up all users or a selected user;
 * non-admin users may only download their own data.
 */
router.post('/backup', authenticate, (req, res, next) => {
  try {
    const backupUserId = req.user.is_admin
      ? (req.query.userId ? parseInt(req.query.userId) : null)
      : req.user.id;

    const backup = createBackup(backupUserId);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="deck-lotus-backup-${new Date().toISOString().split('T')[0]}.json"`);
    res.json(backup);
  } catch (error) { next(error); }
});

/**
 * Restore uploaded backup data. A non-admin restore is forcibly scoped to the
 * authenticated user and backupService preserves their current admin status.
 */
router.post('/restore', authenticate, (req, res, next) => {
  try {
    const { backup, overwrite = false } = req.body;
    if (!backup?.data) return res.status(400).json({ error: 'Invalid backup data' });

    const restoreUserId = req.user.is_admin ? null : req.user.id;
    const results = restoreBackup(backup, { overwrite: !!overwrite, userId: restoreUserId });
    res.json({ success: true, message: 'Backup restored successfully', results });
  } catch (error) { next(error); }
});

// Stored backup files and server-wide backup scheduling are admin-only.
router.get('/backups', authenticate, requireAdmin, (req, res, next) => {
  try { res.json({ backups: listBackups() }); } catch (error) { next(error); }
});

router.get('/backups/:filename', authenticate, requireAdmin, (req, res, next) => {
  try {
    const backup = loadBackupFile(req.params.filename);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.filename}"`);
    res.json(backup);
  } catch (error) { next(error); }
});

router.delete('/backups/:filename', authenticate, requireAdmin, (req, res, next) => {
  try {
    deleteBackupFile(req.params.filename);
    res.json({ success: true, message: 'Backup deleted successfully' });
  } catch (error) { next(error); }
});

router.post('/backup/create', authenticate, requireAdmin, (req, res, next) => {
  try { res.json({ success: true, ...createScheduledBackup() }); } catch (error) { next(error); }
});

router.post('/restore-from-file', authenticate, requireAdmin, (req, res, next) => {
  try {
    const { filename, overwrite = false } = req.body;
    if (!filename) return res.status(400).json({ error: 'Filename is required' });
    const results = restoreBackup(loadBackupFile(filename), { overwrite: !!overwrite, userId: null });
    res.json({ success: true, message: `Restored from ${filename}`, results });
  } catch (error) { next(error); }
});

router.get('/backup-config', authenticate, requireAdmin, (req, res, next) => {
  try { res.json(getBackupConfig()); } catch (error) { next(error); }
});

router.post('/backup-config', authenticate, requireAdmin, (req, res, next) => {
  try {
    const config = configureScheduledBackups(req.body || {});
    res.json({ success: true, message: 'Backup configuration updated', config });
  } catch (error) { next(error); }
});

router.get('/users', authenticate, requireAdmin, (req, res, next) => {
  try { res.json({ users: getAllUsers() }); } catch (error) { next(error); }
});

router.put('/users/:id', authenticate, requireAdmin, (req, res, next) => {
  try {
    const userId = parseInt(req.params.id);
    const updates = req.body || {};
    if (userId === req.user.id && (updates.is_admin === 0 || updates.is_admin === false)) {
      return res.status(400).json({ error: 'Cannot remove your own admin status' });
    }
    if (!updateUser(userId, updates)) return res.status(404).json({ error: 'User not found' });
    res.json({ message: 'User updated successfully' });
  } catch (error) { next(error); }
});

router.delete('/users/:id', authenticate, requireAdmin, (req, res, next) => {
  try {
    const userId = parseInt(req.params.id);
    if (userId === req.user.id) return res.status(400).json({ error: 'Cannot delete your own account' });
    if (!deleteUser(userId)) return res.status(404).json({ error: 'User not found' });
    res.json({ message: 'User deleted successfully' });
  } catch (error) { next(error); }
});

router.post('/users/:id/reset-password', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const userId = parseInt(req.params.id);
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'Password is required' });
    if (!await resetUserPassword(userId, password)) return res.status(404).json({ error: 'User not found' });
    res.json({ message: 'Password reset successfully' });
  } catch (error) {
    if (error.message.includes('Password must be')) return res.status(400).json({ error: error.message });
    next(error);
  }
});

export default router;
