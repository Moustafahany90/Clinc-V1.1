import type { Request, RequestHandler } from 'express';
import { AppError, forbidden, unauthorized } from '../lib/errors.js';
import { verifyAccessToken } from '../lib/tokens.js';
import { prisma } from '../lib/prisma.js';
import { hasPermission, type Permission } from '../lib/permissions.js';
import { AUTH_USER_SELECT, type AuthUser } from '../lib/authTypes.js';

async function loadUser(id: string): Promise<AuthUser> {
  const user = await prisma.user.findUnique({
    where: { id },
    select: { ...AUTH_USER_SELECT, lockedUntil: true },
  });
  if (!user || !user.isActive) {
    throw unauthorized('Your account is not active');
  }
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    throw forbidden('Your account is temporarily locked');
  }
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    role: user.role,
    permissions: user.permissions,
    isActive: user.isActive,
    mustChangePassword: user.mustChangePassword,
    tokenVersion: user.tokenVersion,
  };
}

/**
 * Endpoints a user with a temporary password may still reach. Everything else
 * is blocked server-side until the password is changed, not just in the SPA.
 */
const PASSWORD_CHANGE_PATHS = [
  '/api/v1/auth/me',
  '/api/v1/auth/change-password',
  '/api/v1/auth/logout',
  '/api/v1/auth/sessions',
  '/api/v1/sessions',
];

function pathAllowedBeforePasswordChange(originalUrl: string): boolean {
  const path = (originalUrl.split('?')[0] ?? '').replace(/\/+$/, '') || '/';
  return PASSWORD_CHANGE_PATHS.some(
    (allowed) => path === allowed || path.startsWith(`${allowed}/`),
  );
}

export const authenticate: RequestHandler = (req, _res, next) => {
  const header = req.get('authorization') ?? '';
  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    next(unauthorized());
    return;
  }
  let claims;
  try {
    claims = verifyAccessToken(token);
  } catch {
    next(unauthorized('Session expired, please sign in again'));
    return;
  }
  prisma.tokenBlacklist
    .findUnique({ where: { jti: claims.jti } })
    .then((blacklisted) => {
      if (blacklisted) throw unauthorized('Session expired, please sign in again');
      return loadUser(claims.sub);
    })
    .then((user) => {
      if (user.tokenVersion !== claims.tv) {
        throw unauthorized('Session expired, please sign in again');
      }
      if (user.mustChangePassword && !pathAllowedBeforePasswordChange(req.originalUrl)) {
        throw new AppError(
          403,
          'PASSWORD_CHANGE_REQUIRED',
          'Change your temporary password before continuing.',
          { mustChangePassword: true },
        );
      }
      req.user = user;
      next();
    })
    .catch(next);
};

/** Requires any one of the given permissions. Clinical perms are explicit. */
export function requirePermission(...permissions: Permission[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.user) {
      next(unauthorized());
      return;
    }
    const ok = permissions.some((p) => hasPermission(req.user, p));
    if (!ok) {
      next(new AppError(403, 'FORBIDDEN', 'This action requires additional permission'));
      return;
    }
    next();
  };
}

export function currentUser(req: Request): AuthUser {
  if (!req.user) throw unauthorized();
  return req.user;
}
