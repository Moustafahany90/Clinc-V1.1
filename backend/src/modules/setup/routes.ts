import { Router, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { env } from '../../config/env.js';
import { asyncHandler, badRequest, conflict } from '../../lib/errors.js';
import { checkPasswordStrength, hashPassword } from '../../lib/password.js';
import { defaultPermissionsForRole } from '../../lib/permissions.js';
import { createRefreshToken, REFRESH_COOKIE, signAccessToken } from '../../lib/tokens.js';
import { parseBody } from '../../lib/validate.js';
import { requirePermission } from '../../middleware/auth.js';
import { setupLimiter } from '../../middleware/rateLimit.js';
import { ensureDefaults } from '../../lib/defaults.js';
import { getClinicSettings, isSetupRequired } from '../../lib/clinic.js';
import { emailConfigured } from '../../lib/email.js';
import { auditFromRequest } from '../../lib/audit.js';

export const setupRouter = Router();

const SETUP_LOCK = 918_273_645;

function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

setupRouter.get(
  '/status',
  asyncHandler(async (_req, res) => {
    const required = await isSetupRequired();
    const settings = await getClinicSettings();
    const userCount = await prisma.user.count();
    res.json({
      setupRequired: required,
      hasAnyUser: userCount > 0,
      emailConfigured: emailConfigured(),
      clinic: {
        name: settings.name,
        timezone: settings.timezone,
        currency: settings.currency,
        defaultAppointmentMinutes: settings.defaultAppointmentMinutes,
      },
      defaults: {
        timezone: 'Africa/Cairo',
        currency: 'EGP',
      },
    });
  }),
);

const workingHourSchema = z.object({
  dayOfWeek: z.number().int().min(1).max(7),
  isOpen: z.boolean(),
  openMinute: z.number().int().min(0).max(1439),
  closeMinute: z.number().int().min(1).max(1440),
  breakStartMinute: z.number().int().min(0).max(1439).nullable().optional(),
  breakEndMinute: z.number().int().min(0).max(1440).nullable().optional(),
});

const setupSchema = z.object({
  admin: z.object({
    firstName: z.string().trim().min(1).max(80),
    lastName: z.string().trim().min(1).max(80),
    email: z.string().trim().toLowerCase().email(),
    password: z.string().min(1),
    phone: z.string().trim().max(30).optional().or(z.literal('')),
  }),
  clinic: z.object({
    name: z.string().trim().min(1).max(160),
    phone: z.string().trim().max(30).optional().or(z.literal('')),
    email: z.string().trim().toLowerCase().email().optional().or(z.literal('')),
    address: z.string().trim().max(400).optional().or(z.literal('')),
    timezone: z.string().trim().default('Africa/Cairo'),
    currency: z.string().trim().min(3).max(3).default('EGP'),
    defaultAppointmentMinutes: z.number().int().min(5).max(120).default(15),
  }),
  workingHours: z.array(workingHourSchema).max(7).optional(),
  firstPatient: z
    .object({
      firstName: z.string().trim().min(1).max(80),
      lastName: z.string().trim().min(1).max(80),
      phone: z.string().trim().max(30).optional().or(z.literal('')),
    })
    .optional(),
});

setupRouter.post(
  '/',
  setupLimiter,
  asyncHandler(async (req, res) => {
    const payload = parseBody(setupSchema, req);

    if (!validTimezone(payload.clinic.timezone)) {
      throw badRequest('That timezone is not recognised.');
    }
    const strength = checkPasswordStrength(payload.admin.password);
    if (!strength.ok) {
      throw badRequest(strength.message ?? 'Choose a stronger password.');
    }

    const passwordHash = await hashPassword(payload.admin.password);

    const result = await prisma.$transaction(async (tx) => {
      // Serialise bootstrap attempts so two requests cannot both win.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SETUP_LOCK})`;

      const existingUsers = await tx.user.count();
      if (existingUsers > 0) {
        throw conflict('Setup has already been completed.');
      }

      const admin = await tx.user.create({
        data: {
          email: payload.admin.email,
          passwordHash,
          firstName: payload.admin.firstName,
          lastName: payload.admin.lastName,
          phone: payload.admin.phone || null,
          role: 'ADMIN',
          permissions: defaultPermissionsForRole('ADMIN'),
          mustChangePassword: false,
        },
      });

      const settings = await tx.clinicSettings.upsert({
        where: { id: 1 },
        create: {
          id: 1,
          name: payload.clinic.name,
          phone: payload.clinic.phone || null,
          email: payload.clinic.email || null,
          address: payload.clinic.address || null,
          timezone: payload.clinic.timezone,
          currency: payload.clinic.currency.toUpperCase(),
          defaultAppointmentMinutes: payload.clinic.defaultAppointmentMinutes,
          setupCompletedAt: new Date(),
        },
        update: {
          name: payload.clinic.name,
          phone: payload.clinic.phone || null,
          email: payload.clinic.email || null,
          address: payload.clinic.address || null,
          timezone: payload.clinic.timezone,
          currency: payload.clinic.currency.toUpperCase(),
          defaultAppointmentMinutes: payload.clinic.defaultAppointmentMinutes,
          setupCompletedAt: new Date(),
        },
      });

      if (payload.workingHours && payload.workingHours.length > 0) {
        for (const day of payload.workingHours) {
          await tx.workingHours.upsert({
            where: { dayOfWeek: day.dayOfWeek },
            create: {
              dayOfWeek: day.dayOfWeek,
              isOpen: day.isOpen,
              openMinute: day.openMinute,
              closeMinute: day.closeMinute,
              breakStartMinute: day.breakStartMinute ?? null,
              breakEndMinute: day.breakEndMinute ?? null,
            },
            update: {
              isOpen: day.isOpen,
              openMinute: day.openMinute,
              closeMinute: day.closeMinute,
              breakStartMinute: day.breakStartMinute ?? null,
              breakEndMinute: day.breakEndMinute ?? null,
            },
          });
        }
      }

      await ensureDefaults(tx);

      let firstPatientId: string | null = null;
      if (payload.firstPatient) {
        const seq = await tx.$queryRaw<Array<{ value: number }>>`
          INSERT INTO "Sequence" ("name", "value") VALUES ('patient', 1)
          ON CONFLICT ("name") DO UPDATE SET "value" = "Sequence"."value" + 1
          RETURNING "value"
        `;
        const number = seq[0]?.value ?? 1;
        const patient = await tx.patient.create({
          data: {
            patientNumber: `P-${String(number).padStart(6, '0')}`,
            firstName: payload.firstPatient.firstName,
            lastName: payload.firstPatient.lastName,
            phone: payload.firstPatient.phone || null,
            phoneNormalized: normalisePhone(payload.firstPatient.phone),
            createdById: admin.id,
          },
        });
        firstPatientId = patient.id;
      }

      return { admin, settings, firstPatientId };
    });

    // Session cookie: the wizard continues straight into the dashboard.
    const { token, tokenHash, familyId } = createRefreshToken();
    await prisma.refreshToken.create({
      data: {
        userId: result.admin.id,
        tokenHash,
        familyId,
        expiresAt: new Date(Date.now() + env.refreshTokenTtlMs),
        ip: req.ip,
        userAgent: req.get('user-agent')?.slice(0, 400) ?? null,
      },
    });

    setRefreshCookie(res, token);

    await auditFromRequest(req, {
      action: 'setup.completed',
      entityType: 'ClinicSettings',
      entityId: '1',
      metadata: { adminEmail: result.admin.email },
    });

    res.status(201).json({
      accessToken: signAccessToken(result.admin),
      user: {
        id: result.admin.id,
        email: result.admin.email,
        firstName: result.admin.firstName,
        lastName: result.admin.lastName,
        role: result.admin.role,
        permissions: result.admin.permissions,
        mustChangePassword: false,
      },
      clinic: {
        name: result.settings.name,
        timezone: result.settings.timezone,
        currency: result.settings.currency,
      },
      firstPatientId: result.firstPatientId,
    });
  }),
);

/** Re-runs the safe defaults; useful after restores. Admin only. */
setupRouter.post(
  '/seed-defaults',
  requirePermission('SETTINGS_MANAGE'),
  asyncHandler(async (req, res) => {
    await ensureDefaults();
    await auditFromRequest(req, {
      action: 'setup.seed_defaults',
      entityType: 'ClinicSettings',
      entityId: '1',
    });
    res.json({ ok: true });
  }),
);

function normalisePhone(phone?: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/[^\d+]/g, '');
  if (digits.length < 4) return null;
  return digits;
}

function setRefreshCookie(res: Response, token: string) {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.COOKIE_SECURE,
    domain: env.COOKIE_DOMAIN || undefined,
    path: '/api/v1/auth',
    maxAge: env.refreshTokenTtlMs,
  });
}
