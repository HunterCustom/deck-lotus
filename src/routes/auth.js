import express from 'express';
import rateLimit from 'express-rate-limit';
import {
  registerUser,
  loginUser,
  generateApiKey,
  getUserApiKeys,
  revokeApiKey,
  getUserById,
} from '../services/authService.js';
import { authenticate } from '../middleware/auth.js';
import { verifyRefreshToken, generateTokens } from '../utils/jwt.js';
import { isRegistrationEnabled } from '../services/settingsService.js';
import db from '../db/connection.js';

const router = express.Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts. Please try again later.' },
});

/**
 * GET /api/auth/config
 * Public auth-related config (used by the client to hide the Register option).
 */
router.get('/config', (req, res) => {
  res.json({ registrationEnabled: isRegistrationEnabled() });
});

/**
 * POST /api/auth/register
 * Register a new user
 */
router.post('/register', authLimiter, async (req, res, next) => {
  try {
    if (!isRegistrationEnabled()) {
      return res.status(403).json({ error: 'Registration is disabled on this server' });
    }

    const { username, email, password } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({ error: 'Username, email, and password are required' });
    }

    const result = await registerUser(username, email, password);
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/auth/login
 * Login user
 */
router.post('/login', authLimiter, async (req, res, next) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const result = await loginUser(username, password);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/auth/refresh
 * Refresh access token using refresh token
 */
router.post('/refresh', authLimiter, (req, res, next) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(400).json({ error: 'Refresh token is required' });
    }

    const decoded = verifyRefreshToken(refreshToken);

    if (!decoded) {
      return res.status(401).json({ error: 'Invalid refresh token' });
    }

    const user = getUserById(decoded.userId);
    if (!user) {
      return res.status(401).json({ error: 'User no longer exists' });
    }

    // Reload current account state so privilege changes take effect immediately.
    const tokens = generateTokens({
      userId: user.id,
      username: user.username,
      isAdmin: !!user.is_admin
    });
    res.json(tokens);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/auth/me
 * Get current user info
 */
router.get('/me', authenticate, (req, res, next) => {
  try {
    const user = getUserById(req.user.id);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ user });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/auth/stats
 * Get current user statistics
 */
router.get('/stats', authenticate, (req, res, next) => {
  try {
    // Get deck count
    const deckCount = db.get(
      'SELECT COUNT(*) as count FROM decks WHERE user_id = ?',
      [req.user.id]
    );

    // Get total cards across all decks
    const cardCount = db.get(
      `SELECT SUM(dc.quantity) as count
       FROM deck_cards dc
       JOIN decks d ON dc.deck_id = d.id
       WHERE d.user_id = ?`,
      [req.user.id]
    );

    // Get API key count
    const apiKeyCount = db.get(
      'SELECT COUNT(*) as count FROM api_keys WHERE user_id = ?',
      [req.user.id]
    );

    // Get shared deck count
    const sharedDeckCount = db.get(
      `SELECT COUNT(DISTINCT ds.deck_id) as count
       FROM deck_shares ds
       JOIN decks d ON ds.deck_id = d.id
       WHERE d.user_id = ? AND ds.is_active = 1`,
      [req.user.id]
    );

    res.json({
      stats: {
        deckCount: deckCount.count || 0,
        cardCount: cardCount.count || 0,
        apiKeyCount: apiKeyCount.count || 0,
        sharedDeckCount: sharedDeckCount.count || 0
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/auth/api-keys
 * Get user's API keys
 */
router.get('/api-keys', authenticate, (req, res, next) => {
  try {
    const keys = getUserApiKeys(req.user.id);
    res.json({ apiKeys: keys });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/auth/api-keys
 * Generate new API key
 */
router.post('/api-keys', authenticate, (req, res, next) => {
  try {
    const { name } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'API key name is required' });
    }

    const apiKey = generateApiKey(req.user.id, name);

    res.status(201).json({
      apiKey,
      message: 'API key generated successfully. Save it now, it will not be shown again.',
    });
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/auth/api-keys/:id
 * Revoke API key
 */
router.delete('/api-keys/:id', authenticate, (req, res, next) => {
  try {
    const keyId = parseInt(req.params.id);
    const success = revokeApiKey(req.user.id, keyId);

    if (!success) {
      return res.status(404).json({ error: 'API key not found' });
    }

    res.json({ message: 'API key revoked successfully' });
  } catch (error) {
    next(error);
  }
});

export default router;
