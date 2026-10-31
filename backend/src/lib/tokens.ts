import { createHash, randomBytes, randomUUID } from 'node:crypto';
import jwt, { type SignOptions } from 'jsonwebtoken';
import { env } from '../config/env.js';

export interface AccessClaims {
  sub: string;
  role: string;
  typ: 'access';
  jti: string;
  /** Token version; compared with User.tokenVersion on every request. */
  tv: number;
}

export function signAccessToken(user: {
  id: string;
  role: string;
  tokenVersion: number;
}): string {
  return jwt.sign(
    {
      sub: user.id,
      role: user.role,
      typ: 'access',
      jti: randomUUID(),
      tv: user.tokenVersion,
    },
    env.JWT_ACCESS_SECRET,
    {
      expiresIn: env.ACCESS_TOKEN_TTL as SignOptions['expiresIn'],
      issuer: 'ultrasound-clinic',
      audience: 'ultrasound-clinic-web',
    },
  );
}

export function verifyAccessToken(token: string): AccessClaims {
  const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET, {
    issuer: 'ultrasound-clinic',
    audience: 'ultrasound-clinic-web',
  });
  if (
    typeof decoded === 'string' ||
    decoded.typ !== 'access' ||
    !decoded.sub ||
    !decoded.jti ||
    typeof decoded.tv !== 'number'
  ) {
    throw new Error('Invalid token type');
  }
  return decoded as unknown as AccessClaims;
}

/** Opaque refresh token - only its SHA-256 digest is persisted. */
export function createRefreshToken(): { token: string; tokenHash: string; familyId: string } {
  const token = randomBytes(48).toString('base64url');
  return {
    token,
    tokenHash: hashToken(token),
    familyId: randomUUID(),
  };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function createOpaqueToken(bytes = 32): { token: string; tokenHash: string } {
  const token = randomBytes(bytes).toString('base64url');
  return { token, tokenHash: hashToken(token) };
}

export const REFRESH_COOKIE = 'uc_refresh';
