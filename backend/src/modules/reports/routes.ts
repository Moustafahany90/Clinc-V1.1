import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { Prisma as PrismaRuntime } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import {
  AppError,
  asyncHandler,
  badRequest,
  conflict,
  forbidden,
  notFound,
} from '../../lib/errors.js';
import {
  paginationSchema,
  parseBody,
  parseParams,
  parseQuery,
  uuidSchema,
} from '../../lib/validate.js';
import { authenticate, currentUser, requirePermission } from '../../middleware/auth.js';
import { auditFromRequest } from '../../lib/audit.js';
import { assertClinicalRead, assertClinicalWrite, forcedDoctorId } from '../../lib/clinical.js';
import { getClinicSettings } from '../../lib/clinic.js';
import { renderReportPdf } from '../../lib/reportPdf.js';
import {
  templateFieldsFromSnapshot,
  templateLayoutFromSnapshot,
  type TemplateSnapshot,
} from '../../lib/reportTypes.js';
import {
  sendWhatsAppDocument,
  toWhatsAppRecipient,
  whatsappConfigured,
  WhatsAppError,
} from '../../lib/whatsapp.js';
import { reportDeliveryLimiter } from '../../middleware/rateLimit.js';

export const reportsRouter = Router();
reportsRouter.use(authenticate);

const contentSchema = z.record(
  z.string().max(120),
  z.union([
    z.string().max(20_000),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(z.string().max(2_000)).max(50),
  ]),
);

function assertContentSize(content: Record<string, unknown>): void {
  const size = Buffer.byteLength(JSON.stringify(content), 'utf8');
  if (size > 200_000) throw badRequest('Report content is too large.');
}

const templateFieldSchema = z.object({
  key: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .regex(
      /^[A-Za-z][A-Za-z0-9_]*$/,
      'Field keys must start with a letter and use only letters, numbers and underscores.',
    ),
  label: z.string().trim().min(1).max(160),
  type: z.enum(['text', 'textarea', 'number', 'date', 'select']).default('text'),
  required: z.boolean().default(false),
  visible: z.boolean().optional(),
  placeholder: z.string().trim().max(200).optional(),
});

const templateFieldsSchema = z
  .array(templateFieldSchema)
  .min(1)
  .max(50)
  .superRefine((fields, ctx) => {
    const seen = new Set<string>();
    for (const field of fields) {
      if (seen.has(field.key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate field key: ${field.key}`,
          path: [],
        });
      }
      seen.add(field.key);
    }
  });

const templateLayoutSchema = z.object({
  headerNote: z.string().trim().max(500).optional(),
  footerNote: z.string().trim().max(1000).optional(),
  showMeasurements: z.boolean().optional(),
  showSignature: z.boolean().optional(),
});

const templateSchema = z.object({
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(500).optional().or(z.literal('')),
  serviceId: uuidSchema.optional().nullable(),
  fields: templateFieldsSchema,
  layout: templateLayoutSchema.nullable().optional(),
  isActive: z.boolean().default(true),
  isDefault: z.boolean().default(false),
});

const templatePatchSchema = templateSchema.partial();

function snapshotTemplate(template: {
  id: string;
  name: string;
  description: string | null;
  fields: Prisma.JsonValue;
  layout: Prisma.JsonValue;
  updatedAt: Date;
}): TemplateSnapshot {
  return {
    id: template.id,
    name: template.name,
    description: template.description,
    fields: template.fields,
    layout: template.layout,
    version: template.updatedAt.toISOString(),
  };
}

async function assertActiveService(serviceId: string | null | undefined): Promise<void> {
  if (!serviceId) return;
  const service = await prisma.service.findFirst({
    where: { id: serviceId, isActive: true },
    select: { id: true },
  });
  if (!service) throw badRequest('Select an active service.');
}

reportsRouter.get(
  '/templates',
  requirePermission('CLINICAL_READ', 'SETTINGS_MANAGE'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const canManage = me.permissions.includes('SETTINGS_MANAGE');
    const templates = await prisma.reportTemplate.findMany({
      where: canManage ? {} : { isActive: true },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
      include: { _count: { select: { reports: true } } },
    });
    res.json({ templates });
  }),
);

reportsRouter.post(
  '/templates',
  requirePermission('SETTINGS_MANAGE'),
  asyncHandler(async (req, res) => {
    const payload = parseBody(templateSchema, req);
    if (!payload.isActive && payload.isDefault) {
      throw badRequest('An archived template cannot be the default.');
    }
    await assertActiveService(payload.serviceId);

    const template = await prisma.$transaction(async (tx) => {
      const duplicate = await tx.reportTemplate.findUnique({ where: { name: payload.name } });
      if (duplicate) throw conflict('A template with this name already exists.');
      if (payload.isDefault) {
        await tx.reportTemplate.updateMany({
          where: { isDefault: true },
          data: { isDefault: false },
        });
      }
      return tx.reportTemplate.create({
        data: {
          name: payload.name,
          description: payload.description || null,
          serviceId: payload.serviceId ?? null,
          fields: payload.fields as unknown as Prisma.InputJsonValue,
          layout:
            payload.layout === undefined || payload.layout === null
              ? undefined
              : (payload.layout as unknown as Prisma.InputJsonValue),
          isActive: payload.isActive,
          isDefault: payload.isDefault,
        },
      });
    });

    await auditFromRequest(req, {
      action: 'report_template.created',
      entityType: 'ReportTemplate',
      entityId: template.id,
      metadata: {
        name: template.name,
        isDefault: template.isDefault,
        fieldCount: payload.fields.length,
      },
    });
    res.status(201).json({ template });
  }),
);

reportsRouter.patch(
  '/templates/:id',
  requirePermission('SETTINGS_MANAGE'),
  asyncHandler(async (req, res) => {
    const { id } = parseParams(z.object({ id: uuidSchema }), req);
    const payload = parseBody(templatePatchSchema, req);

    const existing = await prisma.reportTemplate.findUnique({ where: { id } });
    if (!existing) throw notFound('Template not found');

    if (payload.name && payload.name !== existing.name) {
      const duplicate = await prisma.reportTemplate.findUnique({ where: { name: payload.name } });
      if (duplicate) throw conflict('A template with this name already exists.');
    }
    await assertActiveService(payload.serviceId);

    const nextIsActive = payload.isActive ?? existing.isActive;
    let nextIsDefault = payload.isDefault ?? existing.isDefault;
    if (!nextIsActive) nextIsDefault = false;

    const template = await prisma.$transaction(async (tx) => {
      if (nextIsDefault && !existing.isDefault) {
        await tx.reportTemplate.updateMany({
          where: { isDefault: true, NOT: { id } },
          data: { isDefault: false },
        });
      }
      return tx.reportTemplate.update({
        where: { id },
        data: {
          name: payload.name,
          description:
            payload.description === undefined ? undefined : payload.description || null,
          serviceId: payload.serviceId === undefined ? undefined : payload.serviceId,
          fields:
            payload.fields === undefined
              ? undefined
              : (payload.fields as unknown as Prisma.InputJsonValue),
          layout:
            payload.layout === undefined
              ? undefined
              : payload.layout === null
                ? PrismaRuntime.DbNull
                : (payload.layout as unknown as Prisma.InputJsonValue),
          isActive: nextIsActive,
          isDefault: nextIsDefault,
        },
      });
    });

    await auditFromRequest(req, {
      action: 'report_template.updated',
      entityType: 'ReportTemplate',
      entityId: id,
      metadata: {
        name: template.name,
        isActive: template.isActive,
        isDefault: template.isDefault,
      },
    });
    res.json({ template });
  }),
);

/** Archive rather than delete so historical reports keep a resolvable reference. */
reportsRouter.delete(
  '/templates/:id',
  requirePermission('SETTINGS_MANAGE'),
  asyncHandler(async (req, res) => {
    const { id } = parseParams(z.object({ id: uuidSchema }), req);
    const existing = await prisma.reportTemplate.findUnique({ where: { id } });
    if (!existing) throw notFound('Template not found');

    await prisma.reportTemplate.update({
      where: { id },
      data: { isActive: false, isDefault: false },
    });
    await auditFromRequest(req, {
      action: 'report_template.archived',
      entityType: 'ReportTemplate',
      entityId: id,
      metadata: { name: existing.name },
    });
    res.status(204).end();
  }),
);

const listSchema = paginationSchema.extend({
  patientId: uuidSchema.optional(),
  visitId: uuidSchema.optional(),
  status: z.enum(['DRAFT', 'FINALIZED', 'AMENDED']).optional(),
});

reportsRouter.get(
  '/',
  requirePermission('CLINICAL_READ'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const { page, pageSize, patientId, visitId, status } = parseQuery(listSchema, req);
    const doctorId = forcedDoctorId(me);

    const where = {
      ...(doctorId ? { doctorId } : {}),
      ...(patientId ? { visit: { patientId } } : {}),
      ...(visitId ? { visitId } : {}),
      ...(status ? { status } : {}),
    };

    const [total, reports] = await prisma.$transaction([
      prisma.report.count({ where }),
      prisma.report.findMany({
        where,
        select: {
          id: true,
          visitId: true,
          doctorId: true,
          status: true,
          versionNumber: true,
          finalizedAt: true,
          lastAmendedAt: true,
          updatedAt: true,
          visit: {
            select: {
              id: true,
              visitDate: true,
              patient: { select: { id: true, patientNumber: true, firstName: true, lastName: true } },
            },
          },
        },
        orderBy: { updatedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    res.json({ reports, total, page, pageSize });
  }),
);

const createReportSchema = z.object({
  visitId: uuidSchema,
  templateId: uuidSchema.optional().nullable(),
  serviceId: uuidSchema.optional().nullable(),
  content: contentSchema,
});

reportsRouter.post(
  '/',
  requirePermission('CLINICAL_WRITE'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const payload = parseBody(createReportSchema, req);
    assertContentSize(payload.content);

    const visit = await prisma.visit.findUnique({
      where: { id: payload.visitId },
      include: { patient: { select: { id: true, patientNumber: true, firstName: true, lastName: true } } },
    });
    if (!visit) throw notFound('Visit not found');
    assertClinicalWrite(me, visit.doctorId);

    const existing = await prisma.report.findFirst({ where: { visitId: visit.id } });
    if (existing) throw conflict('This visit already has a report. Open it to continue editing.');

    await assertActiveService(payload.serviceId);

    // `templateId: null` explicitly means the standard field set; omitting the
    // field applies the clinic's default template when one is configured.
    let template = null;
    if (payload.templateId !== undefined) {
      if (payload.templateId) {
        template = await prisma.reportTemplate.findFirst({
          where: { id: payload.templateId, isActive: true },
        });
        if (!template) throw badRequest('Select an active report template.');
      }
    } else {
      template = await prisma.reportTemplate.findFirst({
        where: { isDefault: true, isActive: true },
        orderBy: { updatedAt: 'desc' },
      });
    }
    const snapshot = template ? snapshotTemplate(template) : null;

    const report = await prisma.$transaction(async (tx) => {
      const created = await tx.report.create({
        data: {
          visitId: visit.id,
          doctorId: visit.doctorId,
          templateId: template?.id ?? null,
          templateSnapshot: snapshot
            ? (snapshot as unknown as Prisma.InputJsonValue)
            : undefined,
          templateVersion: snapshot?.version ?? null,
          serviceId: payload.serviceId ?? null,
          currentContent: payload.content as Prisma.InputJsonValue,
          versionNumber: 1,
          status: 'DRAFT',
        },
      });
      await tx.reportVersion.create({
        data: {
          reportId: created.id,
          versionNumber: 1,
          content: payload.content as Prisma.InputJsonValue,
          isFinal: false,
          authorId: me.id,
        },
      });
      await tx.visit.update({
        where: { id: visit.id },
        data: { status: visit.status === 'DRAFT' ? 'IN_REVIEW' : visit.status },
      });
      return created;
    });

    await auditFromRequest(req, {
      action: 'report.created',
      entityType: 'Report',
      entityId: report.id,
      patientId: visit.patientId,
      metadata: {
        visitId: visit.id,
        templateId: report.templateId,
        templateVersion: report.templateVersion,
      },
    });

    res.status(201).json({ report });
  }),
);

reportsRouter.get(
  '/:id',
  requirePermission('CLINICAL_READ'),
  asyncHandler(async (req, res) => {
    const { id } = parseParams(z.object({ id: uuidSchema }), req);
    const me = currentUser(req);
    const report = await prisma.report.findUnique({
      where: { id },
      include: {
        versions: {
          orderBy: { versionNumber: 'desc' },
          select: {
            id: true,
            versionNumber: true,
            isFinal: true,
            reason: true,
            createdAt: true,
            author: { select: { id: true, firstName: true, lastName: true } },
          },
        },
        files: {
          select: {
            id: true,
            originalName: true,
            mimeType: true,
            sizeBytes: true,
            createdAt: true,
          },
        },
        deliveries: {
          orderBy: { updatedAt: 'desc' },
          take: 1,
          select: {
            id: true,
            versionNumber: true,
            channel: true,
            status: true,
            recipientLast4: true,
            provider: true,
            providerMessageId: true,
            errorCode: true,
            sentAt: true,
            createdAt: true,
            updatedAt: true,
          },
        },
        visit: {
          include: {
            patient: {
              select: {
                id: true,
                patientNumber: true,
                firstName: true,
                lastName: true,
                phone: true,
                dateOfBirth: true,
                gender: true,
              },
            },
            doctor: { select: { id: true, firstName: true, lastName: true } },
            measurements: { orderBy: { measuredAt: 'desc' } },
          },
        },
        template: true,
      },
    });
    if (!report) throw notFound('Report not found');
    assertClinicalRead(me, report.doctorId);
    res.json({ report });
  }),
);

const updateReportSchema = z.object({
  content: contentSchema,
});

reportsRouter.patch(
  '/:id',
  requirePermission('CLINICAL_WRITE'),
  asyncHandler(async (req, res) => {
    const { id } = parseParams(z.object({ id: uuidSchema }), req);
    const payload = parseBody(updateReportSchema, req);
    assertContentSize(payload.content);
    const me = currentUser(req);

    const existing = await prisma.report.findUnique({ where: { id } });
    if (!existing) throw notFound('Report not found');
    assertClinicalWrite(me, existing.doctorId);

    if (existing.status !== 'DRAFT') {
      throw forbidden('Finalized reports cannot be edited. Create an amendment instead.');
    }

    const report = await prisma.$transaction(async (tx) => {
      // Conditional update closes the race with a concurrent finalize: a draft
      // edit must never land after the report has been signed.
      const changed = await tx.report.updateMany({
        where: { id, status: 'DRAFT' },
        data: { currentContent: payload.content as Prisma.InputJsonValue },
      });
      if (changed.count !== 1) {
        throw conflict('This report was finalized while you were editing. Reload and amend it instead.');
      }
      await tx.reportVersion.updateMany({
        where: { reportId: id, versionNumber: existing.versionNumber, isFinal: false },
        data: { content: payload.content as Prisma.InputJsonValue, authorId: me.id },
      });
      return tx.report.findUniqueOrThrow({ where: { id } });
    });

    await auditFromRequest(req, {
      action: 'report.draft_updated',
      entityType: 'Report',
      entityId: id,
      patientId: (
        await prisma.visit.findUnique({ where: { id: existing.visitId }, select: { patientId: true } })
      )?.patientId,
      metadata: { versionNumber: existing.versionNumber },
    });

    res.json({ report });
  }),
);

reportsRouter.post(
  '/:id/finalize',
  requirePermission('REPORTS_FINALIZE'),
  asyncHandler(async (req, res) => {
    const { id } = parseParams(z.object({ id: uuidSchema }), req);
    const me = currentUser(req);

    const existing = await prisma.report.findUnique({
      where: { id },
      include: { visit: { select: { patientId: true } } },
    });
    if (!existing) throw notFound('Report not found');
    assertClinicalWrite(me, existing.doctorId);

    if (existing.status !== 'DRAFT') {
      throw conflict('This report is already finalized. Use an amendment to correct it.');
    }

    const report = await prisma.$transaction(async (tx) => {
      // Older drafts may predate template pinning. Pin on finalization so the
      // signed document can never be re-rendered with a later template.
      let snapshot: Prisma.InputJsonValue | undefined = existing.templateSnapshot
        ? (existing.templateSnapshot as Prisma.InputJsonValue)
        : undefined;
      let version = existing.templateVersion ?? undefined;
      if (!snapshot && existing.templateId) {
        const template = await tx.reportTemplate.findUnique({
          where: { id: existing.templateId },
        });
        if (template) {
          const pinned = snapshotTemplate(template);
          snapshot = pinned as unknown as Prisma.InputJsonValue;
          version = pinned.version;
        }
      }

      const updatedCount = await tx.report.updateMany({
        where: { id, status: 'DRAFT' },
        data: {
          status: 'FINALIZED',
          finalizedAt: new Date(),
          finalizedById: me.id,
          ...(snapshot ? { templateSnapshot: snapshot, templateVersion: version ?? null } : {}),
        },
      });
      if (updatedCount.count !== 1) {
        throw conflict('This report was finalized by another request. Reload to see the current version.');
      }
      await tx.reportVersion.updateMany({
        where: { reportId: id, versionNumber: existing.versionNumber, isFinal: false },
        data: { isFinal: true, reason: null },
      });
      await tx.visit.update({
        where: { id: existing.visitId },
        data: { status: 'COMPLETED' },
      });
      return tx.report.findUniqueOrThrow({ where: { id } });
    });

    await auditFromRequest(req, {
      action: 'report.finalized',
      entityType: 'Report',
      entityId: id,
      patientId: existing.visit.patientId,
      metadata: { versionNumber: existing.versionNumber },
    });

    res.json({ report });
  }),
);

/** Corrections never overwrite history: a new immutable version is added. */
reportsRouter.post(
  '/:id/amend',
  requirePermission('REPORTS_FINALIZE'),
  asyncHandler(async (req, res) => {
    const { id } = parseParams(z.object({ id: uuidSchema }), req);
    const payload = parseBody(
      z.object({
        content: contentSchema,
        reason: z.string().trim().min(3, 'Explain why the report is being amended.').max(500),
      }),
      req,
    );
    assertContentSize(payload.content);
    const me = currentUser(req);

    const existing = await prisma.report.findUnique({
      where: { id },
      include: { visit: { select: { patientId: true } } },
    });
    if (!existing) throw notFound('Report not found');
    assertClinicalWrite(me, existing.doctorId);
    if (existing.status === 'DRAFT') {
      throw badRequest('Draft reports are edited directly; finalize first to amend.');
    }

    const nextVersion = existing.versionNumber + 1;

    const report = await prisma.$transaction(async (tx) => {
      // Optimistic concurrency: only one amendment may extend this version.
      const changed = await tx.report.updateMany({
        where: { id, versionNumber: existing.versionNumber },
        data: {
          status: 'FINALIZED',
          versionNumber: nextVersion,
          currentContent: payload.content as Prisma.InputJsonValue,
          lastAmendedAt: new Date(),
        },
      });
      if (changed.count !== 1) {
        throw conflict('This report was amended by another request. Reload and try again.');
      }
      await tx.reportVersion.create({
        data: {
          reportId: id,
          versionNumber: nextVersion,
          content: payload.content as Prisma.InputJsonValue,
          isFinal: true,
          authorId: me.id,
          reason: payload.reason,
        },
      });
      return tx.report.findUniqueOrThrow({ where: { id } });
    });

    await auditFromRequest(req, {
      action: 'report.amended',
      entityType: 'Report',
      entityId: id,
      patientId: existing.visit.patientId,
      metadata: { fromVersion: existing.versionNumber, toVersion: nextVersion, reason: payload.reason },
    });

    res.json({ report });
  }),
);

reportsRouter.get(
  '/:id/versions',
  requirePermission('CLINICAL_READ'),
  asyncHandler(async (req, res) => {
    const { id } = parseParams(z.object({ id: uuidSchema }), req);
    const me = currentUser(req);
    const report = await prisma.report.findUnique({ where: { id }, select: { doctorId: true } });
    if (!report) throw notFound('Report not found');
    assertClinicalRead(me, report.doctorId);

    const versions = await prisma.reportVersion.findMany({
      where: { reportId: id },
      orderBy: { versionNumber: 'desc' },
      include: { author: { select: { id: true, firstName: true, lastName: true } } },
    });
    res.json({ versions });
  }),
);

/** Payload for the print-friendly report page (client renders + prints). */
reportsRouter.get(
  '/:id/print-data',
  requirePermission('CLINICAL_READ'),
  asyncHandler(async (req, res) => {
    const { id } = parseParams(z.object({ id: uuidSchema }), req);
    const me = currentUser(req);
    const report = await prisma.report.findUnique({
      where: { id },
      include: {
        visit: {
          include: {
            patient: true,
            doctor: { select: { firstName: true, lastName: true } },
            measurements: { orderBy: { measuredAt: 'asc' } },
          },
        },
        template: true,
        versions: { orderBy: { versionNumber: 'desc' }, select: { versionNumber: true, isFinal: true, createdAt: true } },
      },
    });
    if (!report) throw notFound('Report not found');
    assertClinicalRead(me, report.doctorId);

    const snapshot =
      report.templateSnapshot && typeof report.templateSnapshot === 'object'
        ? (report.templateSnapshot as unknown as {
            name?: string;
            fields?: Prisma.JsonValue;
            layout?: Prisma.JsonValue;
            version?: string;
          })
        : null;

    const clinic = await getClinicSettings();
    res.json({
      clinic: {
        name: clinic.name,
        phone: clinic.phone,
        email: clinic.email,
        address: clinic.address,
        timezone: clinic.timezone,
      },
      report: {
        id: report.id,
        status: report.status,
        versionNumber: report.versionNumber,
        finalizedAt: report.finalizedAt,
        lastAmendedAt: report.lastAmendedAt,
        content: report.currentContent,
        templateId: report.templateId,
        templateName: snapshot?.name ?? report.template?.name ?? null,
        templateVersion: report.templateVersion ?? snapshot?.version ?? null,
        templateFields: snapshot?.fields ?? report.template?.fields ?? null,
        templateLayout: snapshot?.layout ?? report.template?.layout ?? null,
      },
      patient: {
        patientNumber: report.visit.patient.patientNumber,
        firstName: report.visit.patient.firstName,
        lastName: report.visit.patient.lastName,
        dateOfBirth: report.visit.patient.dateOfBirth,
        gender: report.visit.patient.gender,
      },
      examination: {
        visitDate: report.visit.visitDate,
        doctor: `${report.visit.doctor.firstName} ${report.visit.doctor.lastName}`,
        examinationType: report.visit.examinationType,
        chiefComplaint: report.visit.chiefComplaint,
        measurements: report.visit.measurements,
      },
    });
  }),
);

const sendWhatsAppSchema = z.object({
  // Deliberate acknowledgement that clinical information is leaving the
  // clinic through a third-party messaging service.
  consent: z.literal(true),
  resend: z.boolean().default(false),
});

/** A process crash during a send must not block the report permanently. */
const DELIVERY_PENDING_TIMEOUT_MS = 5 * 60_000;

const deliverySelect = {
  id: true,
  reportId: true,
  versionNumber: true,
  channel: true,
  status: true,
  recipientLast4: true,
  provider: true,
  providerMessageId: true,
  errorCode: true,
  sentAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ReportDeliverySelect;

reportsRouter.get(
  '/:id/deliveries',
  requirePermission('CLINICAL_READ'),
  asyncHandler(async (req, res) => {
    const { id } = parseParams(z.object({ id: uuidSchema }), req);
    const me = currentUser(req);
    const report = await prisma.report.findUnique({
      where: { id },
      select: { doctorId: true },
    });
    if (!report) throw notFound('Report not found');
    assertClinicalRead(me, report.doctorId);

    const deliveries = await prisma.reportDelivery.findMany({
      where: { reportId: id },
      orderBy: { createdAt: 'desc' },
      select: deliverySelect,
    });
    res.json({ deliveries });
  }),
);

reportsRouter.post(
  '/:id/whatsapp',
  reportDeliveryLimiter,
  requirePermission('REPORTS_SEND'),
  asyncHandler(async (req, res) => {
    const { id } = parseParams(z.object({ id: uuidSchema }), req);
    const payload = parseBody(sendWhatsAppSchema, req);
    const me = currentUser(req);

    const report = await prisma.report.findUnique({
      where: { id },
      include: {
        template: true,
        visit: {
          include: {
            patient: true,
            doctor: { select: { firstName: true, lastName: true } },
            measurements: { orderBy: { measuredAt: 'asc' } },
          },
        },
      },
    });
    if (!report) throw notFound('Report not found');
    assertClinicalRead(me, report.doctorId);

    if (report.status === 'DRAFT') {
      throw conflict('Finalize the report before sending it to the patient.');
    }
    if (!whatsappConfigured()) {
      throw new AppError(
        503,
        'WHATSAPP_NOT_CONFIGURED',
        'WhatsApp delivery is not configured. Ask the clinic administrator to enable it.',
      );
    }

    const recipient = toWhatsAppRecipient(report.visit.patient.phone);
    if (!recipient) {
      throw badRequest(
        'The patient does not have a valid phone number for WhatsApp. Update the patient record and try again.',
      );
    }
    const recipientLast4 = recipient.slice(-4);

    const existing = await prisma.reportDelivery.findUnique({
      where: {
        reportId_versionNumber_channel: {
          reportId: report.id,
          versionNumber: report.versionNumber,
          channel: 'WHATSAPP',
        },
      },
    });

    const now = new Date();
    const pendingIsStale =
      existing?.status === 'PENDING' &&
      now.getTime() - existing.updatedAt.getTime() >= DELIVERY_PENDING_TIMEOUT_MS;
    if (existing?.status === 'PENDING' && !(payload.resend && pendingIsStale)) {
      throw conflict('A WhatsApp send is already in progress for this report version.');
    }
    if (existing?.status === 'SENT' && !payload.resend) {
      throw conflict(
        'This report version was already sent by WhatsApp. Confirm a resend only if the patient did not receive it.',
      );
    }

    let deliveryId: string;
    if (existing) {
      // The conditional update makes concurrent resends safe: only one request
      // can move the row out of its previous status.
      const claimed = await prisma.reportDelivery.updateMany({
        where: { id: existing.id, status: existing.status, updatedAt: existing.updatedAt },
        data: {
          status: 'PENDING',
          sentById: me.id,
          recipientLast4,
          attempts: { increment: 1 },
          lastAttemptAt: now,
          providerMessageId: null,
          errorCode: null,
          errorMessage: null,
          sentAt: null,
        },
      });
      if (claimed.count !== 1) {
        throw conflict('A WhatsApp send is already in progress for this report version.');
      }
      deliveryId = existing.id;
    } else {
      try {
        const created = await prisma.reportDelivery.create({
          data: {
            reportId: report.id,
            patientId: report.visit.patientId,
            sentById: me.id,
            versionNumber: report.versionNumber,
            channel: 'WHATSAPP',
            status: 'PENDING',
            provider: 'EVOLUTION_BAILEYS',
            recipientLast4,
            attempts: 1,
            lastAttemptAt: now,
          },
        });
        deliveryId = created.id;
      } catch (error) {
        if (
          error instanceof PrismaRuntime.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        ) {
          throw conflict('A WhatsApp send is already in progress for this report version.');
        }
        throw error;
      }
    }

    const snapshot =
      report.templateSnapshot && typeof report.templateSnapshot === 'object'
        ? (report.templateSnapshot as unknown as TemplateSnapshot)
        : null;
    const templateFields =
      templateFieldsFromSnapshot(snapshot) ??
      (Array.isArray(report.template?.fields)
        ? (report.template.fields as unknown as ReturnType<typeof templateFieldsFromSnapshot>)
        : null);
    const templateLayout =
      templateLayoutFromSnapshot(snapshot) ??
      (report.template?.layout && typeof report.template.layout === 'object'
        ? (report.template.layout as ReturnType<typeof templateLayoutFromSnapshot>)
        : null);

    try {
      const clinic = await getClinicSettings();
      const pdf = await renderReportPdf({
        clinic: {
          name: clinic.name,
          phone: clinic.phone,
          email: clinic.email,
          address: clinic.address,
          timezone: clinic.timezone,
        },
        report: {
          id: report.id,
          status: report.status,
          versionNumber: report.versionNumber,
          finalizedAt: report.finalizedAt,
          lastAmendedAt: report.lastAmendedAt,
          content: report.currentContent as Record<string, unknown>,
          templateName: snapshot?.name ?? report.template?.name ?? null,
          templateVersion: report.templateVersion ?? snapshot?.version ?? null,
          templateFields,
          templateLayout,
        },
        patient: {
          patientNumber: report.visit.patient.patientNumber,
          firstName: report.visit.patient.firstName,
          lastName: report.visit.patient.lastName,
          dateOfBirth: report.visit.patient.dateOfBirth,
          gender: report.visit.patient.gender,
        },
        examination: {
          visitDate: report.visit.visitDate,
          doctor: `${report.visit.doctor.firstName} ${report.visit.doctor.lastName}`,
          examinationType: report.visit.examinationType,
          chiefComplaint: report.visit.chiefComplaint,
        },
        measurements: report.visit.measurements,
      });

      const safePatientNumber = report.visit.patient.patientNumber.replace(/[^A-Za-z0-9._-]/g, '-');
      const sent = await sendWhatsAppDocument({
        to: recipient,
        filename: `ultrasound-report-${safePatientNumber}-v${report.versionNumber}.pdf`,
        pdf,
        caption: `Your ultrasound report from ${clinic.name} is attached.`,
      });

      const delivery = await prisma.reportDelivery.update({
        where: { id: deliveryId },
        data: {
          status: 'SENT',
          providerMessageId: sent.messageId,
          sentAt: new Date(),
          errorCode: null,
          errorMessage: null,
        },
        select: deliverySelect,
      });

      await auditFromRequest(req, {
        action: 'report.whatsapp_sent',
        entityType: 'Report',
        entityId: report.id,
        patientId: report.visit.patientId,
        metadata: {
          versionNumber: report.versionNumber,
          recipientLast4,
          provider: 'EVOLUTION_BAILEYS',
          consentAcknowledged: true,
          resend: Boolean(existing),
        },
      });

      res.json({ delivery });
    } catch (error) {
      const errorCode =
        error instanceof WhatsAppError ? error.code : 'DELIVERY_PREPARATION_FAILED';
      const errorMessage =
        error instanceof WhatsAppError
          ? 'WhatsApp delivery failed.'
          : 'The report could not be prepared for delivery.';
      await prisma.reportDelivery
        .update({
          where: { id: deliveryId },
          data: {
            status: 'FAILED',
            errorCode,
            errorMessage,
            lastAttemptAt: new Date(),
          },
        })
        .catch(() => undefined);

      await auditFromRequest(req, {
        action: 'report.whatsapp_failed',
        entityType: 'Report',
        entityId: report.id,
        patientId: report.visit.patientId,
        metadata: {
          versionNumber: report.versionNumber,
          recipientLast4,
          errorCode,
          resend: Boolean(existing),
        },
      });

      if (error instanceof WhatsAppError) {
        throw new AppError(
          502,
          error.code,
          error.message || 'WhatsApp delivery failed. The report was not sent.',
          { providerStatus: error.providerStatus ?? null },
        );
      }
      throw new AppError(
        500,
        'DELIVERY_PREPARATION_FAILED',
        'The report could not be prepared for delivery.',
      );
    }
  }),
);

reportsRouter.delete(
  '/:id',
  requirePermission('CLINICAL_WRITE'),
  asyncHandler(async (req, res) => {
    const { id } = parseParams(z.object({ id: uuidSchema }), req);
    const me = currentUser(req);
    const existing = await prisma.report.findUnique({
      where: { id },
      include: { visit: { select: { patientId: true } } },
    });
    if (!existing) throw notFound('Report not found');
    assertClinicalWrite(me, existing.doctorId);
    if (existing.status !== 'DRAFT') {
      throw forbidden('Finalized reports cannot be deleted.');
    }

    await prisma.report.delete({ where: { id } });
    await auditFromRequest(req, {
      action: 'report.draft_deleted',
      entityType: 'Report',
      entityId: id,
      patientId: existing.visit.patientId,
    });
    res.status(204).end();
  }),
);
