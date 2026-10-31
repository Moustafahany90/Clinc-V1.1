import { Router, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { env } from '../../config/env.js';
import { badRequest, forbidden, unauthorized } from '../../lib/errors.js';
import { checkPasswordStrength, hashPassword, verifyPassword } from '../../lib/password.js';
import {
  createRefreshToken,
  hashToken,
  REFRESH_COOKIE,
  signAccessToken,
  verifyAccessToken,
} from '../../lib/tokens.js';
import { parseBody } from '../../lib/validate.js';
import { asyncHandler } from '../../lib/errors.js';
import { authenticate, currentUser, requirePermission } from '../../middleware/auth.js';
import { hasPermission } from '../../lib/permissions.js';
import { loginLimiter, passwordSetupLimiter, refreshLimiter } from '../../middleware/rateLimit.js';
import { AUTH_USER_SELECT, publicUser } from '../../lib/authTypes.js';
import { auditFromRequest } from '../../lib/audit.js';

export const authRouter = Router();
export const sessionsRouter = Router();
export const adminSessionsRouter = Router();

const MAX_FAILED_LOGINS = 8;
const LOCK_MINUTES = 15;

function refreshCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: env.COOKIE_SECURE,
    domain: env.COOKIE_DOMAIN || undefined,
    path: '/api/v1/auth',
    maxAge: env.refreshTokenTtlMs,
  };
}

function setRefreshCookie(res: Response, token: string) {
  res.cookie(REFRESH_COOKIE, token, refreshCookieOptions());
}

function clearRefreshCookie(res: Response) {
  res.clearCookie(REFRESH_COOKIE, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.COOKIE_SECURE,
    domain: env.COOKIE_DOMAIN || undefined,
    path: '/api/v1/auth',
  });
}

async function issueSession(
  user: { id: string; role: string; tokenVersion: number },
  meta: { ip?: string; userAgent?: string; familyId?: string },
) {
  const { token, tokenHash, familyId } = createRefreshToken();
  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash,
      familyId: meta.familyId ?? familyId,
      expiresAt: new Date(Date.now() + env.refreshTokenTtlMs),
      ip: meta.ip ?? null,
      userAgent: meta.userAgent?.slice(0, 400) ?? null,
    },
  });
  return { accessToken: signAccessToken(user), refreshToken: token };
}

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address'),
  password: z.string().min(1, 'Password is required').max(200),
});

authRouter.post(
  '/login',
  loginLimiter,
  asyncHandler(async (req, res) => {
    const { email, password } = parseBody(loginSchema, req);
    const user = await prisma.user.findUnique({ where: { email } });

    // Constant-ish response regardless of whether the account exists.
    const genericFailure = () => {
      throw unauthorized('Invalid email or password');
    };

    if (!user) {
      await verifyPassword(password, 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA');
      genericFailure();
      return;
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw forbidden('This account is temporarily locked. Try again later.');
    }

    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) {
      const failed = user.failedLoginCount + 1;
      const lock = failed >= MAX_FAILED_LOGINS;
      await prisma.user.update({
        where: { id: user.id },
        data: {
          failedLoginCount: lock ? 0 : failed,
          lockedUntil: lock ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null,
        },
      });
      genericFailure();
      return;
    }

    if (!user.isActive) {
      // Do not reveal whether the address exists or that the account was
      // archived. The credentials are valid but the session must not start.
      genericFailure();
      return;
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
    });

    const session = await issueSession(user, {
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });

    setRefreshCookie(res, session.refreshToken);
    await auditFromRequest(req, {
      action: 'auth.login',
      entityType: 'User',
      entityId: user.id,
    });

    res.json({
      accessToken: session.accessToken,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        permissions: user.permissions,
        mustChangePassword: user.mustChangePassword,
      },
    });
  }),
);

authRouter.post(
  '/refresh',
  refreshLimiter,
  asyncHandler(async (req, res) => {
    const raw = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
    if (!raw) throw unauthorized('Session expired');

    const tokenHash = hashToken(raw);
    const stored = await prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: { select: { ...AUTH_USER_SELECT, lockedUntil: true } } },
    });

    if (!stored) {
      clearRefreshCookie(res);
      throw unauthorized('Session expired');
    }

    // Re-use of a rotated token means it leaked: kill the whole family.
    if (stored.revokedAt) {
      if (stored.replacedBy) {
        await prisma.refreshToken.updateMany({
          where: { familyId: stored.familyId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }
      clearRefreshCookie(res);
      throw unauthorized('Session expired');
    }

    if (stored.expiresAt <= new Date()) {
      await prisma.refreshToken.update({
        where: { id: stored.id },
        data: { revokedAt: new Date() },
      });
      clearRefreshCookie(res);
      throw unauthorized('Session expired');
    }

    if (!stored.user.isActive) {
      await prisma.refreshToken.updateMany({
        where: { userId: stored.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      clearRefreshCookie(res);
      throw unauthorized('Session expired');
    }

    const session = await issueSession(stored.user, {
      ip: req.ip,
      userAgent: req.get('user-agent'),
      familyId: stored.familyId,
    });

    const rotated = await prisma.refreshToken.findUnique({
      where: { tokenHash: hashToken(session.refreshToken) },
      select: { id: true },
    });

    await prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date(), replacedBy: rotated?.id ?? null },
    });

    setRefreshCookie(res, session.refreshToken);
    res.json({
      accessToken: session.accessToken,
      user: {
        id: stored.user.id,
        email: stored.user.email,
        firstName: stored.user.firstName,
        lastName: stored.user.lastName,
        role: stored.user.role,
        permissions: stored.user.permissions,
        mustChangePassword: stored.user.mustChangePassword,
      },
    });
  }),
);

authRouter.post(
  '/logout',
  asyncHandler(async (req, res) => {
    const raw = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
    if (raw) {
      await prisma.refreshToken.updateMany({
        where: { tokenHash: hashToken(raw), revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }

    const header = req.get('authorization') ?? '';
    const [scheme, token] = header.split(' ');
    if (scheme?.toLowerCase() === 'bearer' && token) {
      try {
        const claims = verifyAccessToken(token);
        const exp = (claims as any).exp ? new Date((claims as any).exp * 1000) : new Date(Date.now() + 15 * 60 * 1000);
        await prisma.tokenBlacklist.upsert({
          where: { jti: claims.jti },
          create: { jti: claims.jti, userId: claims.sub, expiresAt: exp },
          update: {},
        });
      } catch {
        // ignore invalid/expired tokens on logout
      }
    }

    clearRefreshCookie(res);
    res.status(204).end();
  }),
);

authRouter.get(
  '/me',
  authenticate,
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const dbUser = await prisma.user.findUnique({
      where: { id: user.id },
      select: { mustChangePassword: true, phone: true, createdAt: true },
    });
    res.json({
      user: {
        ...publicUser(user),
        phone: dbUser?.phone ?? null,
        mustChangePassword: dbUser?.mustChangePassword ?? false,
        createdAt: dbUser?.createdAt,
      },
    });
  }),
);

// Session handlers supporting both /sessions, /admin/sessions and /auth/sessions
const listMySessions = asyncHandler(async (req, res) => {
  const me = currentUser(req);
  const sessions = await prisma.refreshToken.findMany({
    where: {
      userId: me.id,
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      ip: true,
      userAgent: true,
      createdAt: true,
      expiresAt: true,
      familyId: true,
    },
  });
  res.json({ sessions });
});

const listAdminSessions = asyncHandler(async (_req, res) => {
  const sessions = await prisma.refreshToken.findMany({
    where: {
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: 'desc' },
    include: {
      user: { select: { id: true, email: true, firstName: true, lastName: true, role: true } },
    },
  });
  res.json({ sessions });
});

const terminateSession = asyncHandler(async (req, res) => {
  const me = currentUser(req);
  const sessionId = req.params.id;
  const canManageUsers = hasPermission(me, 'USERS_MANAGE');
  const session = await prisma.refreshToken.findFirst({
    where: canManageUsers ? { id: sessionId } : { id: sessionId, userId: me.id },
  });
  if (!session) throw badRequest('Session not found');
  if (!session.revokedAt) {
    await prisma.refreshToken.update({
      where: { id: session.id },
      data: { revokedAt: new Date() },
    });
  }
  res.status(204).end();
});

// Dedicated /sessions routes
sessionsRouter.use(authenticate);
sessionsRouter.get('/', listMySessions);
sessionsRouter.delete('/:id', terminateSession);

// Dedicated /admin/sessions routes
adminSessionsRouter.use(authenticate, requirePermission('USERS_MANAGE'));
adminSessionsRouter.get('/', listAdminSessions);
adminSessionsRouter.delete('/:id', terminateSession);

// Backward-compatible /auth/sessions aliases
authRouter.get('/sessions', authenticate, listMySessions);
authRouter.get('/admin/sessions', authenticate, requirePermission('USERS_MANAGE'), listAdminSessions);
authRouter.delete('/sessions/:id', authenticate, terminateSession);

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(1),
});

authRouter.post(
  '/change-password',
  authenticate,
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const { currentPassword, newPassword } = parseBody(changePasswordSchema, req);

    const user = await prisma.user.findUnique({ where: { id: me.id } });
    if (!user) throw unauthorized();

    const ok = await verifyPassword(currentPassword, user.passwordHash);
    if (!ok) throw badRequest('Your current password is not correct.');

    const strength = checkPasswordStrength(newPassword);
    if (!strength.ok) throw badRequest(strength.message ?? 'Choose a stronger password.');

    if (await verifyPassword(newPassword, user.passwordHash)) {
      throw badRequest('Choose a password you have not used before.');
    }

    const passwordHash = await hashPassword(newPassword);
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        mustChangePassword: false,
        tokenVersion: { increment: 1 },
      },
    });
    await prisma.refreshToken.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    const session = await issueSession(updated, { ip: req.ip, userAgent: req.get('user-agent') });
    setRefreshCookie(res, session.refreshToken);

    await auditFromRequest(req, {
      action: 'auth.password_changed',
      entityType: 'User',
      entityId: user.id,
    });

    res.json({ accessToken: session.accessToken });
  }),
);

const setupPasswordSchema = z.object({
  token: z.string().min(10),
  password: z.string().min(1),
});

authRouter.get(
  '/password-setup/:token',
  passwordSetupLimiter,
  asyncHandler(async (req, res) => {
    const token = String(req.params.token ?? '');
    const record = await prisma.passwordSetupToken.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { user: { select: { email: true, firstName: true, isActive: true } } },
    });
    if (
      !record ||
      record.usedAt ||
      record.revokedAt ||
      record.expiresAt <= new Date() ||
      !record.user.isActive
    ) {
      throw badRequest('This link is invalid or has expired. Ask an administrator for a new one.');
    }
    res.json({ valid: true, email: record.user.email, firstName: record.user.firstName });
  }),
);

authRouter.post(
  '/password-setup',
  passwordSetupLimiter,
  asyncHandler(async (req, res) => {
    const { token, password } = parseBody(setupPasswordSchema, req);

    const strength = checkPasswordStrength(password);
    if (!strength.ok) throw badRequest(strength.message ?? 'Choose a stronger password.');

    const record = await prisma.passwordSetupToken.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { user: true },
    });
    if (
      !record ||
      record.usedAt ||
      record.revokedAt ||
      record.expiresAt <= new Date() ||
      !record.user.isActive
    ) {
      throw badRequest('This link is invalid or has expired. Ask an administrator for a new one.');
    }

    const passwordHash = await hashPassword(password);
    await prisma.$transaction([
      prisma.user.update({
        where: { id: record.userId },
        data: {
          passwordHash,
          mustChangePassword: false,
          tokenVersion: { increment: 1 },
          failedLoginCount: 0,
          lockedUntil: null,
        },
      }),
      prisma.passwordSetupToken.update({
        where: { id: record.id },
        data: { usedAt: new Date() },
      }),
      prisma.refreshToken.updateMany({
        where: { userId: record.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);

    await auditFromRequest(req, {
      action: 'auth.password_setup_completed',
      entityType: 'User',
      entityId: record.userId,
    });

    res.json({ ok: true });
  }),
);
