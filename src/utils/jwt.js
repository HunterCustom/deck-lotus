import jwt from 'jsonwebtoken';

const DEFAULT_SECRET = 'your-secret-key-change-this-in-production';
const COMPOSE_DEFAULT_SECRET = 'change-this-to-a-long-random-secret';
const JWT_SECRET = process.env.JWT_SECRET || DEFAULT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';
const JWT_REFRESH_EXPIRES_IN = process.env.JWT_REFRESH_EXPIRES_IN || '30d';

if (
  process.env.NODE_ENV === 'production' &&
  (!process.env.JWT_SECRET || JWT_SECRET === DEFAULT_SECRET || JWT_SECRET === COMPOSE_DEFAULT_SECRET)
) {
  throw new Error('JWT_SECRET must be set to a unique, non-default value in production');
}

export function generateAccessToken(payload) {
  return jwt.sign({ ...payload, tokenType: 'access' }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

export function generateRefreshToken(payload) {
  return jwt.sign({ ...payload, tokenType: 'refresh' }, JWT_SECRET, { expiresIn: JWT_REFRESH_EXPIRES_IN });
}

export function verifyToken(token, expectedType = null) {
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (expectedType && decoded.tokenType !== expectedType) return null;
    return decoded;
  } catch {
    return null;
  }
}

export function generateTokens(payload) {
  return {
    accessToken: generateAccessToken(payload),
    refreshToken: generateRefreshToken(payload),
  };
}
