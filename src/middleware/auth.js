import { verifyToken } from '../utils/jwt.js';
import { validateApiKey } from '../services/authService.js';

function userFromDecoded(decoded) {
  return {
    id: decoded.userId,
    username: decoded.username,
    is_admin: decoded.isAdmin || false,
  };
}

function userFromApiKey(user) {
  return {
    id: user.user_id,
    username: user.username,
    email: user.email,
    is_admin: user.is_admin || false,
  };
}

/**
 * Authentication middleware - supports access JWTs and API keys.
 * Refresh JWTs are intentionally rejected here.
 */
export function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const decoded = verifyToken(authHeader.substring(7), 'access');
    if (decoded) {
      req.user = userFromDecoded(decoded);
      return next();
    }
  }

  const apiKey = req.headers['x-api-key'];
  if (apiKey) {
    const user = validateApiKey(apiKey);
    if (user) {
      req.user = userFromApiKey(user);
      return next();
    }
  }

  return res.status(401).json({ error: 'Authentication required' });
}

export function optionalAuthenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const decoded = verifyToken(authHeader.substring(7), 'access');
    if (decoded) req.user = userFromDecoded(decoded);
  } else {
    const apiKey = req.headers['x-api-key'];
    if (apiKey) {
      const user = validateApiKey(apiKey);
      if (user) req.user = userFromApiKey(user);
    }
  }

  next();
}
