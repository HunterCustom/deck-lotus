import express from 'express';
import {
  registerUser,
  loginUser,
  generateApiKey,
  getUserApiKeys,
  revokeApiKey,
  getUserById,
} from '../services/authService.js';
import { authenticate } from '../middleware/auth.js';
import { verifyToken, generateTokens } from '../utils/jwt.js';
import { isRegistrationEnabled } from '../services/settingsService.js';
import db from '../db/connection.js';

const router = express.Router();

router.get('/config', (req, res) => {
  res.json({ registrationEnabled: isRegistrationEnabled() });
});

router.post('/register', async (req, res, next) => {
  try {
    if (!isRegistrationEnabled()) {
      return res.status(403).json({ error: 'Registration is disabled on this server' });
    }
    const { username, email, password } = req.body;
    if (!username || !email || !password) {
      return res.status(400).json({ error: 'Username, email, and password are required' });
    }
    res.status(201).json(await registerUser(username, email, password));
  } catch (error) { next(error); }
});

router.post('/login', async (req, res, next) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }
    res.json(await loginUser(username, password));
  } catch (error) { next(error); }
});

router.post('/refresh', (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(400).json({ error: 'Refresh token is required' });

    const decoded = verifyToken(refreshToken, 'refresh');
    if (!decoded) return res.status(401).json({ error: 'Invalid refresh token' });

    // Reload the user so role changes and deleted accounts take effect instead
    // of perpetuating stale claims from an older token.
    const user = getUserById(decoded.userId);
    if (!user) return res.status(401).json({ error: 'User no longer exists' });

    res.json(generateTokens({
      userId: user.id,
      username: user.username,
      isAdmin: !!user.is_admin,
    }));
  } catch (error) { next(error); }
});

router.get('/me', authenticate, (req, res, next) => {
  try {
    const user = getUserById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ user });
  } catch (error) { next(error); }
});

router.get('/stats', authenticate, (req, res, next) => {
  try {
    const deckCount = db.get('SELECT COUNT(*) as count FROM decks WHERE user_id = ?', [req.user.id]);
    const cardCount = db.get(`SELECT SUM(dc.quantity) as count FROM deck_cards dc JOIN decks d ON dc.deck_id = d.id WHERE d.user_id = ?`, [req.user.id]);
    const apiKeyCount = db.get('SELECT COUNT(*) as count FROM api_keys WHERE user_id = ?', [req.user.id]);
    const sharedDeckCount = db.get(`SELECT COUNT(DISTINCT ds.deck_id) as count FROM deck_shares ds JOIN decks d ON ds.deck_id = d.id WHERE d.user_id = ? AND ds.is_active = 1`, [req.user.id]);

    res.json({
      stats: {
        deckCount: deckCount.count || 0,
        cardCount: cardCount.count || 0,
        apiKeyCount: apiKeyCount.count || 0,
        sharedDeckCount: sharedDeckCount.count || 0,
      },
    });
  } catch (error) { next(error); }
});

router.get('/api-keys', authenticate, (req, res, next) => {
  try { res.json({ apiKeys: getUserApiKeys(req.user.id) }); } catch (error) { next(error); }
});

router.post('/api-keys', authenticate, (req, res, next) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'API key name is required' });
    const apiKey = generateApiKey(req.user.id, name);
    res.status(201).json({ apiKey, message: 'API key generated successfully. Save it now, it will not be shown again.' });
  } catch (error) { next(error); }
});

router.delete('/api-keys/:id', authenticate, (req, res, next) => {
  try {
    if (!revokeApiKey(req.user.id, parseInt(req.params.id))) {
      return res.status(404).json({ error: 'API key not found' });
    }
    res.json({ message: 'API key revoked successfully' });
  } catch (error) { next(error); }
});

export default router;
