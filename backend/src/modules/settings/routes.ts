import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { env } from '../../config/env.js';
import { asyncHandler, badRequest, notFound } from '../../lib/errors.js';
import { parseBody, parseParams, parseQuery, uuidSchema } from '../../lib/validate.js';
import { authenticate, currentUser, requirePermission } from '../../middleware/auth.js';
import { auditFromRequest } from '../../lib/audit.js';
import { getClinicSettings } from '../../lib/clinic.js';
import { clinicDateString, dateOnlyToDb, setClinicTimezone } from '../../lib/time.js';
import { emailConfigured, sendMail } from '../../lib/email.js';
import {
  whatsappConfigured,
  getEvolutionStatus,
  getEvolutionQrCode,
  disconnectEvolution,
  WhatsAppError,
} from '../../lib/whatsapp.js';
import { AppError } from '../../lib/errors.js';
import { dateOnlySchema } from '../../lib/validate.js';

export const settingsRouter = Router();
settingsRouter.use(authenticate);

function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

settingsRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const clinic = await getClinicSettings();
    res.json({
      clinic: {
        name: clinic.name,
        legalName: clinic.legalName,
        phone: clinic.phone,
        email: clinic.email,
        address: clinic.address,
        timezone: clinic.timezone,
        currency: clinic.currency,
        defaultAppointmentMinutes: clinic.defaultAppointmentMinutes,
        slotIntervalMinutes: clinic.slotIntervalMinutes,
        emailEnabled: clinic.emailEnabled,
        emailProvider: clinic.emailProvider,
        emailFromAddress: clinic.emailFromAddress,
        dailyDoctorDigest: clinic.dailyDoctorDigest,
        digestSendHour: clinic.digestSendHour,
        setupCompletedAt: clinic.setupCompletedAt,
      },
      emailConfigured: emailConfigured(),
      emailWarning:
        clinic.emailEnabled && !emailConfigured()
          ? 'Email is enabled in settings but SMTP/Graph credentials are missing. Clinic operations continue normally.'
          : null,
      serverTimezone: env.APP_TIMEZONE,
    });
  }),
);

const updateSettingsSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  legalName: z.string().trim().max(160).nullable().optional(),
  phone: z.string().trim().max(30).nullable().optional(),
  email: z.string().trim().toLowerCase().email().nullable().optional().or(z.literal('')),
  address: z.string().trim().max(400).nullable().optional(),
  timezone: z.string().trim().optional(),
  currency: z.string().trim().length(3).optional(),
  defaultAppointmentMinutes: z.number().int().min(5).max(120).optional(),
  slotIntervalMinutes: z.number().int().min(5).max(60).optional(),
  emailEnabled: z.boolean().optional(),
  emailProvider: z.enum(['smtp', 'graph']).optional(),
  emailFromAddress: z.string().trim().email().nullable().optional().or(z.literal('')),
  dailyDoctorDigest: z.boolean().optional(),
  digestSendHour: z.number().int().min(0).max(23).optional(),
});

settingsRouter.patch(
  '/',
  requirePermission('SETTINGS_MANAGE'),
  asyncHandler(async (req, res) => {
    const payload = parseBody(updateSettingsSchema, req);
    if (payload.timezone && !validTimezone(payload.timezone)) {
      throw badRequest('That timezone is not recognised.');
    }

    const clinic = await prisma.clinicSettings.upsert({
      where: { id: 1 },
      create: {
        id: 1,
        ...payload,
        email: payload.email || null,
        emailFromAddress: payload.emailFromAddress || null,
        currency: payload.currency?.toUpperCase(),
      },
      update: {
        ...payload,
        email: payload.email === undefined ? undefined : payload.email || null,
        emailFromAddress:
          payload.emailFromAddress === undefined ? undefined : payload.emailFromAddress || null,
        currency: payload.currency?.toUpperCase(),
      },
    });

    if (payload.timezone) setClinicTimezone(clinic.timezone);

    await auditFromRequest(req, {
      action: 'settings.updated',
      entityType: 'ClinicSettings',
      entityId: '1',
      metadata: { fields: Object.keys(payload) },
    });

    res.json({ clinic, emailConfigured: emailConfigured() });
  }),
);

// ---------------------------------------------------------------------------
// Working hours
// ---------------------------------------------------------------------------

settingsRouter.get(
  '/working-hours',
  requirePermission('APPOINTMENTS_READ', 'SETTINGS_MANAGE'),
  asyncHandler(async (_req, res) => {
    const hours = await prisma.workingHours.findMany({ orderBy: { dayOfWeek: 'asc' } });
    res.json({ workingHours: hours });
  }),
);

const hoursSchema = z.object({
  workingHours: z
    .array(
      z.object({
        dayOfWeek: z.number().int().min(1).max(7),
        isOpen: z.boolean(),
        openMinute: z.number().int().min(0).max(1439),
        closeMinute: z.number().int().min(1).max(1440),
        breakStartMinute: z.number().int().min(0).max(1439).nullable().optional(),
        breakEndMinute: z.number().int().min(0).max(1440).nullable().optional(),
      }),
    )
    .length(7),
});

settingsRouter.put(
  '/working-hours',
  requirePermission('SETTINGS_MANAGE'),
  asyncHandler(async (req, res) => {
    const { workingHours } = parseBody(hoursSchema, req);
    const seen = new Set<number>();
    for (const day of workingHours) {
      if (seen.has(day.dayOfWeek)) throw badRequest('Each weekday can only appear once.');
      seen.add(day.dayOfWeek);
      if (day.isOpen && day.openMinute >= day.closeMinute) {
        throw badRequest('Opening time must be before closing time.');
      }
      if (
        day.isOpen &&
        day.breakStartMinute != null &&
        day.breakEndMinute != null &&
        (day.breakStartMinute >= day.breakEndMinute ||
          day.breakStartMinute < day.openMinute ||
          day.breakEndMinute > day.closeMinute)
      ) {
        throw badRequest('The break must fall inside the opening hours.');
      }
    }

    await prisma.$transaction(
      workingHours.map((day) =>
        prisma.workingHours.upsert({
          where: { dayOfWeek: day.dayOfWeek },
          create: {
            dayOfWeek: day.dayOfWeek,
            isOpen: day.isOpen,
            openMinute: day.openMinute,
            closeMinute: day.closeMinute,
            breakStartMinute: day.isOpen ? (day.breakStartMinute ?? null) : null,
            breakEndMinute: day.isOpen ? (day.breakEndMinute ?? null) : null,
          },
          update: {
            isOpen: day.isOpen,
            openMinute: day.openMinute,
            closeMinute: day.closeMinute,
            breakStartMinute: day.isOpen ? (day.breakStartMinute ?? null) : null,
            breakEndMinute: day.isOpen ? (day.breakEndMinute ?? null) : null,
          },
        }),
      ),
    );

    await auditFromRequest(req, {
      action: 'settings.working_hours_updated',
      entityType: 'ClinicSettings',
      entityId: '1',
    });

    const hours = await prisma.workingHours.findMany({ orderBy: { dayOfWeek: 'asc' } });
    res.json({ workingHours: hours });
  }),
);

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

settingsRouter.get(
  '/services',
  requirePermission('APPOINTMENTS_READ', 'SETTINGS_MANAGE'),
  asyncHandler(async (_req, res) => {
    const services = await prisma.service.findMany({ orderBy: [{ isActive: 'desc' }, { name: 'asc' }] });
    res.json({ services });
  }),
);

const serviceSchema = z.object({
  name: z.string().trim().min(1).max(160),
  durationMinutes: z.number().int().min(5).max(240),
  priceMinor: z.number().int().min(0).max(1_000_000_000).default(0),
  description: z.string().trim().max(400).optional().or(z.literal('')),
  isActive: z.boolean().default(true),
});

settingsRouter.post(
  '/services',
  requirePermission('SETTINGS_MANAGE'),
  asyncHandler(async (req, res) => {
    const payload = parseBody(serviceSchema, req);
    const service = await prisma.service.create({
      data: {
        name: payload.name,
        durationMinutes: payload.durationMinutes,
        priceMinor: payload.priceMinor,
        description: payload.description || null,
        isActive: payload.isActive,
      },
    });
    await auditFromRequest(req, {
      action: 'service.created',
      entityType: 'Service',
      entityId: service.id,
      metadata: { name: service.name, durationMinutes: service.durationMinutes },
    });
    res.status(201).json({ service });
  }),
);

settingsRouter.patch(
  '/services/:id',
  requirePermission('SETTINGS_MANAGE'),
  asyncHandler(async (req, res) => {
    const { id } = parseParams(z.object({ id: uuidSchema }), req);
    const payload = parseBody(serviceSchema.partial(), req);
    const service = await prisma.service.update({
      where: { id },
      data: {
        ...payload,
        description: payload.description === undefined ? undefined : payload.description || null,
      },
    });
    await auditFromRequest(req, {
      action: 'service.updated',
      entityType: 'Service',
      entityId: id,
      metadata: { fields: Object.keys(payload) },
    });
    res.json({ service });
  }),
);

settingsRouter.delete(
  '/services/:id',
  requirePermission('SETTINGS_MANAGE'),
  asyncHandler(async (req, res) => {
    const { id } = parseParams(z.object({ id: uuidSchema }), req);
    const service = await prisma.service.findUnique({ where: { id } });
    if (!service) throw notFound('Service not found');

    await prisma.service.delete({ where: { id } });

    await auditFromRequest(req, {
      action: 'service.deleted',
      entityType: 'Service',
      entityId: id,
      metadata: { name: service.name },
    });

    res.status(204).end();
  }),
);

// ---------------------------------------------------------------------------
// Payment methods and expense categories
// ---------------------------------------------------------------------------

settingsRouter.get(
  '/payment-methods',
  requirePermission('PAYMENTS_READ', 'PAYMENTS_WRITE', 'SETTINGS_MANAGE'),
  asyncHandler(async (_req, res) => {
    const paymentMethods = await prisma.paymentMethod.findMany({ orderBy: { sortOrder: 'asc' } });
    res.json({ paymentMethods });
  }),
);

settingsRouter.patch(
  '/payment-methods/:key',
  requirePermission('SETTINGS_MANAGE'),
  asyncHandler(async (req, res) => {
    const key = String(req.params.key ?? '');
    const payload = parseBody(
      z.object({
        label: z.string().trim().min(1).max(80).optional(),
        requiresReference: z.boolean().optional(),
        isActive: z.boolean().optional(),
        sortOrder: z.number().int().min(0).max(100).optional(),
      }),
      req,
    );
    const method = await prisma.paymentMethod.update({ where: { key }, data: payload });
    await auditFromRequest(req, {
      action: 'payment_method.updated',
      entityType: 'PaymentMethod',
      entityId: key,
      metadata: { fields: Object.keys(payload) },
    });
    res.json({ paymentMethod: method });
  }),
);

settingsRouter.get(
  '/expense-categories',
  requirePermission('EXPENSES_READ', 'EXPENSES_WRITE', 'SETTINGS_MANAGE'),
  asyncHandler(async (_req, res) => {
    const expenseCategories = await prisma.expenseCategory.findMany({
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
    });
    res.json({ expenseCategories });
  }),
);

settingsRouter.post(
  '/expense-categories',
  requirePermission('SETTINGS_MANAGE', 'EXPENSES_WRITE'),
  asyncHandler(async (req, res) => {
    const payload = parseBody(
      z.object({ name: z.string().trim().min(1).max(80) }),
      req,
    );
    const category = await prisma.expenseCategory.create({ data: { name: payload.name } });
    await auditFromRequest(req, {
      action: 'expense_category.created',
      entityType: 'ExpenseCategory',
      entityId: category.id,
      metadata: { name: category.name },
    });
    res.status(201).json({ expenseCategory: category });
  }),
);

settingsRouter.patch(
  '/expense-categories/:id',
  requirePermission('SETTINGS_MANAGE'),
  asyncHandler(async (req, res) => {
    const { id } = parseParams(z.object({ id: uuidSchema }), req);
    const payload = parseBody(
      z.object({ name: z.string().trim().min(1).max(80).optional(), isActive: z.boolean().optional() }),
      req,
    );
    const category = await prisma.expenseCategory.update({ where: { id }, data: payload });
    await auditFromRequest(req, {
      action: 'expense_category.updated',
      entityType: 'ExpenseCategory',
      entityId: id,
    });
    res.json({ expenseCategory: category });
  }),
);

// ---------------------------------------------------------------------------
// Doctor availability and date exceptions
// ---------------------------------------------------------------------------

settingsRouter.get(
  '/doctors/:doctorId/availability',
  requirePermission('SETTINGS_MANAGE'),
  asyncHandler(async (req, res) => {
    const { doctorId } = parseParams(z.object({ doctorId: uuidSchema }), req);
    const doctor = await prisma.user.findFirst({
      where: { id: doctorId, role: 'DOCTOR' },
      select: { id: true, firstName: true, lastName: true },
    });
    if (!doctor) throw notFound('Doctor not found');
    const availability = await prisma.doctorAvailability.findMany({
      where: { doctorId },
      orderBy: { dayOfWeek: 'asc' },
    });
    const exceptions = await prisma.scheduleException.findMany({
      where: { doctorId, date: { gte: dateOnlyToDb(clinicDateString()) } },
      orderBy: { date: 'asc' },
      take: 100,
    });
    res.json({ doctor, availability, exceptions });
  }),
);

settingsRouter.put(
  '/doctors/:doctorId/availability',
  requirePermission('SETTINGS_MANAGE'),
  asyncHandler(async (req, res) => {
    const { doctorId } = parseParams(z.object({ doctorId: uuidSchema }), req);
    const { availability } = parseBody(
      z.object({
        availability: z
          .array(
            z.object({
              dayOfWeek: z.number().int().min(1).max(7),
              isWorking: z.boolean(),
              openMinute: z.number().int().min(0).max(1439),
              closeMinute: z.number().int().min(1).max(1440),
            }),
          )
          .length(7),
      }),
      req,
    );

    const seen = new Set<number>();
    for (const day of availability) {
      if (seen.has(day.dayOfWeek)) throw badRequest('Each weekday can only appear once.');
      seen.add(day.dayOfWeek);
      if (day.isWorking && day.openMinute >= day.closeMinute) {
        throw badRequest('A doctor’s start time must be before their end time.');
      }
    }

    const doctor = await prisma.user.findFirst({ where: { id: doctorId, role: 'DOCTOR' } });
    if (!doctor) throw notFound('Doctor not found');

    await prisma.$transaction(
      availability.map((day) =>
        prisma.doctorAvailability.upsert({
          where: { doctorId_dayOfWeek: { doctorId, dayOfWeek: day.dayOfWeek } },
          create: {
            doctorId,
            dayOfWeek: day.dayOfWeek,
            isWorking: day.isWorking,
            openMinute: day.openMinute,
            closeMinute: day.closeMinute,
          },
          update: {
            isWorking: day.isWorking,
            openMinute: day.openMinute,
            closeMinute: day.closeMinute,
          },
        }),
      ),
    );

    await auditFromRequest(req, {
      action: 'doctor.availability_updated',
      entityType: 'User',
      entityId: doctorId,
    });

    const rows = await prisma.doctorAvailability.findMany({
      where: { doctorId },
      orderBy: { dayOfWeek: 'asc' },
    });
    res.json({ availability: rows });
  }),
);

/**
 * Remove all per-doctor overrides so the doctor follows the clinic hours again.
 */
settingsRouter.delete(
  '/doctors/:doctorId/availability',
  requirePermission('SETTINGS_MANAGE'),
  asyncHandler(async (req, res) => {
    const { doctorId } = parseParams(z.object({ doctorId: uuidSchema }), req);
    const doctor = await prisma.user.findFirst({ where: { id: doctorId, role: 'DOCTOR' } });
    if (!doctor) throw notFound('Doctor not found');

    const removed = await prisma.doctorAvailability.deleteMany({ where: { doctorId } });

    await auditFromRequest(req, {
      action: 'doctor.availability_reset',
      entityType: 'User',
      entityId: doctorId,
      metadata: { removedDays: removed.count },
    });

    res.status(204).end();
  }),
);

settingsRouter.get(
  '/exceptions',
  requirePermission('SETTINGS_MANAGE'),
  asyncHandler(async (req, res) => {
    const payload = parseQuery(
      z.object({ from: dateOnlySchema.optional(), to: dateOnlySchema.optional() }),
      req,
    );
    const exceptions = await prisma.scheduleException.findMany({
      where: {
        ...(payload.from || payload.to
          ? {
              date: {
                ...(payload.from ? { gte: new Date(`${payload.from}T00:00:00Z`) } : {}),
                ...(payload.to ? { lte: new Date(`${payload.to}T00:00:00Z`) } : {}),
              },
            }
          : {}),
      },
      include: { doctor: { select: { id: true, firstName: true, lastName: true } } },
      orderBy: { date: 'asc' },
      take: 200,
    });
    res.json({ exceptions });
  }),
);

settingsRouter.post(
  '/exceptions',
  requirePermission('SETTINGS_MANAGE'),
  asyncHandler(async (req, res) => {
    const payload = parseBody(
      z.object({
        date: dateOnlySchema,
        doctorId: uuidSchema.nullable().optional(),
        isClosed: z.boolean().default(true),
        openMinute: z.number().int().min(0).max(1439).optional(),
        closeMinute: z.number().int().min(1).max(1440).optional(),
        reason: z.string().trim().max(300).optional().or(z.literal('')),
      }),
      req,
    );
    if (!payload.isClosed) {
      const open = payload.openMinute ?? 0;
      const close = payload.closeMinute ?? 1440;
      if (open >= close) {
        throw badRequest('Special opening hours must start before they end.');
      }
    }
    const exception = await prisma.scheduleException.create({
      data: {
        date: dateOnlyToDb(payload.date),
        doctorId: payload.doctorId ?? null,
        isClosed: payload.isClosed,
        openMinute: payload.openMinute ?? null,
        closeMinute: payload.closeMinute ?? null,
        reason: payload.reason || null,
        createdById: req.user?.id ?? null,
      },
    });
    await auditFromRequest(req, {
      action: 'schedule_exception.created',
      entityType: 'ScheduleException',
      entityId: exception.id,
      metadata: { date: payload.date, doctorId: payload.doctorId ?? null },
    });
    res.status(201).json({ exception });
  }),
);

settingsRouter.delete(
  '/exceptions/:id',
  requirePermission('SETTINGS_MANAGE'),
  asyncHandler(async (req, res) => {
    const { id } = parseParams(z.object({ id: uuidSchema }), req);
    await prisma.scheduleException.delete({ where: { id } });
    await auditFromRequest(req, {
      action: 'schedule_exception.deleted',
      entityType: 'ScheduleException',
      entityId: id,
    });
    res.status(204).end();
  }),
);

// ---------------------------------------------------------------------------
// Onboarding checklist + email test
// ---------------------------------------------------------------------------

settingsRouter.get(
  '/getting-started',
  requirePermission('SETTINGS_MANAGE'),
  asyncHandler(async (_req, res) => {
    const clinic = await getClinicSettings();
    const [doctors, receptionists, patients, hours, services] = await Promise.all([
      prisma.user.count({ where: { role: 'DOCTOR', isActive: true } }),
      prisma.user.count({ where: { role: 'RECEPTIONIST', isActive: true } }),
      prisma.patient.count(),
      prisma.workingHours.count({ where: { isOpen: true } }),
      prisma.service.count({ where: { isActive: true } }),
    ]);

    const items = [
      { key: 'clinic', label: 'Clinic details', done: Boolean(clinic.name && clinic.phone) },
      { key: 'workingHours', label: 'Working hours', done: hours > 0 },
      { key: 'doctor', label: 'At least one doctor account', done: doctors > 0 },
      { key: 'receptionist', label: 'At least one receptionist account', done: receptionists > 0 },
      { key: 'services', label: 'Exam services', done: services > 0 },
      { key: 'email', label: 'Email delivery (optional)', done: emailConfigured(), optional: true },
      { key: 'patient', label: 'First patient (optional)', done: patients > 0, optional: true },
    ];

    res.json({
      items,
      completed: items.filter((i) => !i.optional).every((i) => i.done),
      emailConfigured: emailConfigured(),
    });
  }),
);

settingsRouter.post(
  '/test-email',
  requirePermission('SETTINGS_MANAGE'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const payload = parseBody(
      z.object({ to: z.string().trim().email().optional() }),
      req,
    );
    const to = payload.to ?? me.email;
    const result = await sendMail({
      to,
      subject: 'Clinic email test',
      template: 'test',
      text: 'This is a test message from your ultrasound clinic system. Email delivery is working.',
    });
    await auditFromRequest(req, {
      action: 'settings.test_email',
      entityType: 'ClinicSettings',
      entityId: '1',
      metadata: { sent: result.sent },
    });
    res.json({
      sent: result.sent,
      reason: result.reason ?? null,
      configured: emailConfigured(),
    });
  }),
);

// ---------------------------------------------------------------------------
// WhatsApp (Evolution API / Baileys) Settings & Pairing
// ---------------------------------------------------------------------------

settingsRouter.get(
  '/whatsapp',
  requirePermission('SETTINGS_MANAGE'),
  asyncHandler(async (_req, res) => {
    try {
      const status = await getEvolutionStatus();
      res.json(status);
    } catch (err) {
      if (err instanceof WhatsAppError) {
        throw new AppError(err.providerStatus || 502, err.code, err.message);
      }
      throw err;
    }
  }),
);

settingsRouter.post(
  '/whatsapp/connect',
  requirePermission('SETTINGS_MANAGE'),
  asyncHandler(async (req, res) => {
    try {
      const result = await getEvolutionQrCode();
      await auditFromRequest(req, {
        action: 'settings.whatsapp_connect_requested',
        entityType: 'ClinicSettings',
        entityId: '1',
        metadata: { state: result.state },
      });
      res.json(result);
    } catch (err) {
      if (err instanceof WhatsAppError) {
        throw new AppError(err.providerStatus || 502, err.code, err.message);
      }
      throw err;
    }
  }),
);

settingsRouter.post(
  '/whatsapp/disconnect',
  requirePermission('SETTINGS_MANAGE'),
  asyncHandler(async (req, res) => {
    try {
      const result = await disconnectEvolution();
      await auditFromRequest(req, {
        action: 'settings.whatsapp_disconnected',
        entityType: 'ClinicSettings',
        entityId: '1',
      });
      res.json(result);
    } catch (err) {
      if (err instanceof WhatsAppError) {
        throw new AppError(err.providerStatus || 502, err.code, err.message);
      }
      throw err;
    }
  }),
);

settingsRouter.post(
  '/whatsapp/test',
  requirePermission('SETTINGS_MANAGE'),
  asyncHandler(async (req, res) => {
    try {
      const status = await getEvolutionStatus();
      await auditFromRequest(req, {
        action: 'settings.whatsapp_tested',
        entityType: 'ClinicSettings',
        entityId: '1',
        metadata: { state: status.state, configured: status.configured },
      });
      res.json({
        success: status.state === 'open',
        state: status.state,
        configured: status.configured,
      });
    } catch (err) {
      if (err instanceof WhatsAppError) {
        throw new AppError(err.providerStatus || 502, err.code, err.message);
      }
      throw err;
    }
  }),
);
