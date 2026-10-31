import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, badRequest, conflict, notFound } from '../../lib/errors.js';
import { checkPasswordStrength, hashPassword } from '../../lib/password.js';
import {
  CLINICAL_PERMISSIONS,
  PERMISSIONS,
  defaultPermissionsForRole,
} from '../../lib/permissions.js';
import { parseBody, paginationSchema, parseQuery, uuidSchema } from '../../lib/validate.js';
import { authenticate, currentUser, requirePermission } from '../../middleware/auth.js';
import { issuePasswordSetup } from '../../lib/invites.js';
import { auditFromRequest } from '../../lib/audit.js';
import { emailConfigured } from '../../lib/email.js';

export const usersRouter = Router();
usersRouter.use(authenticate);

const permissionSchema = z.enum(PERMISSIONS);
const roleSchema = z.enum(['ADMIN', 'RECEPTIONIST', 'DOCTOR']);

function sanitisePermissions(role: string, requested: string[] | undefined): string[] {
  const base = requested ?? defaultPermissionsForRole(role);
  const unique = [...new Set(base)];
  if (role === 'RECEPTIONIST') {
    return unique.filter((p) => !CLINICAL_PERMISSIONS.includes(p as never));
  }
  if (role === 'DOCTOR') {
    // Doctors always own clinical ability; finance permissions are never
    // granted implicitly by role.
    const merged = new Set([...unique, 'CLINICAL_READ', 'CLINICAL_WRITE', 'REPORTS_FINALIZE']);
    return [...merged].filter((p) => p !== 'USERS_MANAGE');
  }
  return unique;
}

type SessionStore = Pick<Prisma.TransactionClient, 'refreshToken' | 'passwordSetupToken'>;

/**
 * End every session for an account: rotating refresh tokens and any unused
 * password-setup links. Access tokens stop working immediately because
 * authentication reloads the user and rejects inactive accounts.
 */
async function revokeSessions(
  store: SessionStore,
  userId: string,
): Promise<{ refreshTokens: number; invites: number }> {
  const refreshTokens = await store.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  const invites = await store.passwordSetupToken.updateMany({
    where: { userId, revokedAt: null, usedAt: null },
    data: { revokedAt: new Date() },
  });
  return { refreshTokens: refreshTokens.count, invites: invites.count };
}

/** Minimal doctor directory for scheduling. No clinical or contact secrets. */
usersRouter.get(
  '/doctors',
  requirePermission('APPOINTMENTS_READ', 'USERS_MANAGE'),
  asyncHandler(async (_req, res) => {
    const doctors = await prisma.user.findMany({
      where: { role: 'DOCTOR', isActive: true },
      select: { id: true, firstName: true, lastName: true },
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
    });
    res.json({ doctors });
  }),
);

usersRouter.get(
  '/',
  requirePermission('USERS_MANAGE'),
  asyncHandler(async (req, res) => {
    const { page, pageSize } = parseQuery(paginationSchema, req);
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const role = typeof req.query.role === 'string' && roleSchema.safeParse(req.query.role).success
      ? (req.query.role as 'ADMIN' | 'RECEPTIONIST' | 'DOCTOR')
      : undefined;

    const where = {
      ...(role ? { role } : {}),
      ...(search
        ? {
            OR: [
              { firstName: { contains: search, mode: 'insensitive' as const } },
              { lastName: { contains: search, mode: 'insensitive' as const } },
              { email: { contains: search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };

    const [total, users] = await prisma.$transaction([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          phone: true,
          role: true,
          permissions: true,
          isActive: true,
          mustChangePassword: true,
          lastLoginAt: true,
          createdAt: true,
        },
        orderBy: [{ createdAt: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    res.json({ users, total, page, pageSize });
  }),
);

const createUserSchema = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  email: z.string().trim().toLowerCase().email(),
  phone: z.string().trim().max(30).optional().or(z.literal('')),
  role: roleSchema,
  permissions: z.array(permissionSchema).optional(),
  password: z.string().min(1).optional(),
  sendInvite: z.boolean().default(true),
});

usersRouter.post(
  '/',
  requirePermission('USERS_MANAGE'),
  asyncHandler(async (req, res) => {
    const payload = parseBody(createUserSchema, req);

    const existing = await prisma.user.findUnique({ where: { email: payload.email } });
    if (existing) throw conflict('An account with this email already exists.');

    let passwordHash: string | null = null;
    if (payload.password) {
      const strength = checkPasswordStrength(payload.password);
      if (!strength.ok) throw badRequest(strength.message ?? 'Choose a stronger password.');
      passwordHash = await hashPassword(payload.password);
    }

    const user = await prisma.user.create({
      data: {
        email: payload.email,
        firstName: payload.firstName,
        lastName: payload.lastName,
        phone: payload.phone || null,
        role: payload.role,
        permissions: sanitisePermissions(payload.role, payload.permissions),
        // Password-less accounts cannot sign in until the invite is used.
        passwordHash:
          passwordHash ??
          // Random unusable hash; replaced when the invite is completed.
          'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' +
            'A'.repeat(88),
        mustChangePassword: !passwordHash,
        isActive: true,
      },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        permissions: true,
        isActive: true,
      },
    });

    let invite: { url?: string; emailed: boolean } | null = null;
    if (!passwordHash && payload.sendInvite) {
      const issued = await issuePasswordSetup(user.id, currentUser(req).id);
      invite = {
        emailed: issued.emailed,
        ...(issued.emailed ? {} : { url: issued.url }),
      };
    }

    await auditFromRequest(req, {
      action: 'user.created',
      entityType: 'User',
      entityId: user.id,
      metadata: { role: user.role, permissions: user.permissions },
    });

    res.status(201).json({ user, invite, emailConfigured: emailConfigured() });
  }),
);

const updateUserSchema = z.object({
  firstName: z.string().trim().min(1).max(80).optional(),
  lastName: z.string().trim().min(1).max(80).optional(),
  phone: z.string().trim().max(30).nullable().optional(),
  role: roleSchema.optional(),
  permissions: z.array(permissionSchema).optional(),
  isActive: z.boolean().optional(),
});

usersRouter.patch(
  '/:id',
  requirePermission('USERS_MANAGE'),
  asyncHandler(async (req, res) => {
    const { id } = z.object({ id: uuidSchema }).parse(req.params);
    const payload = parseBody(updateUserSchema, req);
    const me = currentUser(req);

    const target = await prisma.user.findUnique({ where: { id } });
    if (!target) throw notFound('Account not found');

    if (target.id === me.id && payload.isActive === false) {
      throw badRequest('You cannot deactivate your own account.');
    }

    const nextRole = payload.role ?? target.role;
    if (target.id === me.id && nextRole !== 'ADMIN') {
      throw badRequest('You cannot remove your own administrator role.');
    }

    // Never allow the last active administrator to be demoted or disabled.
    if (target.role === 'ADMIN' && (nextRole !== 'ADMIN' || payload.isActive === false)) {
      const activeAdmins = await prisma.user.count({
        where: { role: 'ADMIN', isActive: true, id: { not: target.id } },
      });
      if (activeAdmins === 0) {
        throw badRequest('The clinic must keep at least one active administrator.');
      }
    }

    const permissions =
      payload.permissions !== undefined || payload.role !== undefined
        ? sanitisePermissions(nextRole, payload.permissions ?? (payload.role ? undefined : target.permissions))
        : undefined;

    const { updated, revokedSessions } = await prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id },
        data: {
          firstName: payload.firstName,
          lastName: payload.lastName,
          phone: payload.phone === undefined ? undefined : payload.phone || null,
          role: payload.role,
          permissions,
          isActive: payload.isActive,
          ...(payload.isActive !== undefined && payload.isActive !== target.isActive
            ? { tokenVersion: { increment: 1 } }
            : {}),
        },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          phone: true,
          role: true,
          permissions: true,
          isActive: true,
        },
      });

      const revoked = payload.isActive === false ? await revokeSessions(tx, id) : null;
      return { updated, revokedSessions: revoked };
    });

    await auditFromRequest(req, {
      action: 'user.updated',
      entityType: 'User',
      entityId: id,
      metadata: {
        role: updated.role,
        isActive: updated.isActive,
        permissions: updated.permissions,
        ...(revokedSessions
          ? {
              revokedRefreshTokens: revokedSessions.refreshTokens,
              revokedInvites: revokedSessions.invites,
            }
          : {}),
      },
    });

    res.json({ user: updated });
  }),
);

/**
 * Archive an account. Staff records (visits, reports, payments, audit trail)
 * are never deleted, so removal is a soft delete. Sessions and pending invites
 * are revoked in the same transaction.
 */
usersRouter.delete(
  '/:id',
  requirePermission('USERS_MANAGE'),
  asyncHandler(async (req, res) => {
    const { id } = z.object({ id: uuidSchema }).parse(req.params);
    const me = currentUser(req);

    if (id === me.id) {
      throw badRequest('You cannot remove your own account.');
    }

    const target = await prisma.user.findUnique({
      where: { id },
      select: { id: true, role: true, isActive: true },
    });
    if (!target) throw notFound('Account not found');

    // Idempotent: removing an already archived account is a no-op.
    if (!target.isActive) {
      res.status(204).end();
      return;
    }

    if (target.role === 'ADMIN') {
      const otherActiveAdmins = await prisma.user.count({
        where: { role: 'ADMIN', isActive: true, id: { not: id } },
      });
      if (otherActiveAdmins === 0) {
        throw badRequest('The clinic must keep at least one active administrator.');
      }
    }

    const revoked = await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id },
        data: { isActive: false, tokenVersion: { increment: 1 } },
      });
      return revokeSessions(tx, id);
    });

    await auditFromRequest(req, {
      action: 'user.removed',
      entityType: 'User',
      entityId: id,
      metadata: {
        role: target.role,
        mode: 'archived',
        revokedRefreshTokens: revoked.refreshTokens,
        revokedInvites: revoked.invites,
      },
    });

    res.status(204).end();
  }),
);

usersRouter.post(
  '/:id/password-reset',
  requirePermission('USERS_MANAGE'),
  asyncHandler(async (req, res) => {
    const { id } = z.object({ id: uuidSchema }).parse(req.params);
    const me = currentUser(req);
    const target = await prisma.user.findUnique({ where: { id } });
    if (!target) throw notFound('Account not found');
    if (!target.isActive) {
      throw badRequest('Restore this account before sending a password link.');
    }

    const issued = await issuePasswordSetup(id, me.id);
    await prisma.user.update({
      where: { id },
      data: { tokenVersion: { increment: 1 } },
    });
    await prisma.refreshToken.updateMany({
      where: { userId: id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await auditFromRequest(req, {
      action: 'user.password_reset_requested',
      entityType: 'User',
      entityId: id,
    });

    res.json({
      emailed: issued.emailed,
      emailConfigured: emailConfigured(),
      ...(issued.emailed ? {} : { url: issued.url }),
    });
  }),
);
