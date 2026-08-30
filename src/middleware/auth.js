import { verifyAccessToken } from '../utils/jwt.js';
import { validateApiKey, getUserById } from '../services/authService.js';

function authenticateJwt(authHeader) {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const decoded = verifyAccessToken(authHeader.substring(7));
  if (!decoded) return null;

  // The token proves identity, but current account state is authoritative for
  // authorization. This makes deletions and admin demotions effective
  // immediately instead of waiting for a seven-day access token to expire.
  const user = getUserById(decoded.userId);
  if (!user) return null;

  return {
    id: user.id,
    username: user.username,
    email: user.email,
    is_admin: !!user.is_admin,
  };
}

function authenticateApiKey(apiKey) {
  if (!apiKey) return null;
  const user = validateApiKey(apiKey);
  if (!user) return null;
  return {
    id: user.user_id,
    username: user.username,
    email: user.email,
    is_admin: !!user.is_admin,
  };
}

/** Authentication middleware - supports access JWTs and API keys. */
export function authenticate(req, res, next) {
  const jwtUser = authenticateJwt(req.headers.authorization);
  if (jwtUser) {
    req.user = jwtUser;
    return next();
  }

  const apiUser = authenticateApiKey(req.headers['x-api-key']);
  if (apiUser) {
    req.user = apiUser;
    return next();
  }

  return res.status(401).json({ error: 'Authentication required' });
}

/** Optional authentication - doesn't fail if no auth provided. */
export function optionalAuthenticate(req, res, next) {
  const jwtUser = authenticateJwt(req.headers.authorization);
  if (jwtUser) {
    req.user = jwtUser;
    return next();
  }

  const apiUser = authenticateApiKey(req.headers['x-api-key']);
  if (apiUser) req.user = apiUser;
  next();
}
