import jwt from 'jsonwebtoken';

const DEFAULT_JWT_SECRET = 'your-secret-key-change-this-in-production';
const JWT_SECRET = process.env.JWT_SECRET || DEFAULT_JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';
const JWT_REFRESH_EXPIRES_IN = process.env.JWT_REFRESH_EXPIRES_IN || '30d';

if (
  process.env.NODE_ENV === 'production' &&
  (!process.env.JWT_SECRET || JWT_SECRET === DEFAULT_JWT_SECRET || JWT_SECRET.length < 32)
) {
  throw new Error('JWT_SECRET must be set to a unique secret of at least 32 characters in production');
}

export function generateAccessToken(payload) {
  return jwt.sign({ ...payload, tokenType: 'access' }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

export function generateRefreshToken(payload) {
  return jwt.sign({ ...payload, tokenType: 'refresh' }, JWT_SECRET, { expiresIn: JWT_REFRESH_EXPIRES_IN });
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

export function verifyAccessToken(token) {
  const decoded = verifyToken(token);
  if (!decoded) return null;

  // Accept pre-hardening access tokens until they naturally expire, but never
  // accept an explicitly tagged refresh token for API authentication.
  if (decoded.tokenType && decoded.tokenType !== 'access') return null;
  return decoded;
}

export function verifyRefreshToken(token) {
  const decoded = verifyToken(token);
  if (!decoded || decoded.tokenType !== 'refresh') return null;
  return decoded;
}

export function generateTokens(payload) {
  return {
    accessToken: generateAccessToken(payload),
    refreshToken: generateRefreshToken(payload),
  };
}
