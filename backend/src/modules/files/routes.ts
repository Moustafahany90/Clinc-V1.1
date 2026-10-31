import { Router } from 'express';
import multer from 'multer';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { env } from '../../config/env.js';
import { asyncHandler, badRequest, forbidden, notFound } from '../../lib/errors.js';
import { parseParams, uuidSchema } from '../../lib/validate.js';
import { authenticate, currentUser, requirePermission } from '../../middleware/auth.js';
import { uploadLimiter } from '../../middleware/rateLimit.js';
import { auditFromRequest } from '../../lib/audit.js';
import { assertClinicalRead, assertClinicalWrite } from '../../lib/clinical.js';

export const filesRouter = Router();
filesRouter.use(authenticate);

const TMP_DIR = path.resolve(env.UPLOAD_DIR, 'tmp');
const STORAGE_ROOT = path.resolve(env.UPLOAD_DIR);

export async function ensureStorage(): Promise<void> {
  await mkdir(TMP_DIR, { recursive: true });
  await mkdir(path.join(STORAGE_ROOT, 'clinical'), { recursive: true });
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, TMP_DIR),
    filename: (_req, _file, cb) => cb(null, `${randomUUID()}.tmp`),
  }),
  limits: { fileSize: env.maxUploadBytes, files: 1 },
});

interface DetectedType {
  mime: string;
  ext: string;
}

/** Content sniffing - never trust the client-supplied mime type or name. */
function detectType(buffer: Buffer): DetectedType | null {
  if (buffer.length < 12) return null;

  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mime: 'image/jpeg', ext: 'jpg' };
  }
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mime: 'image/png', ext: 'png' };
  }
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { mime: 'image/webp', ext: 'webp' };
  }
  if (buffer.subarray(0, 4).toString('ascii') === '%PDF') {
    return { mime: 'application/pdf', ext: 'pdf' };
  }
  if (
    buffer.subarray(0, 4).equals(Buffer.from([0x49, 0x49, 0x2a, 0x00])) ||
    buffer.subarray(0, 4).equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2a]))
  ) {
    return { mime: 'image/tiff', ext: 'tiff' };
  }
  return null;
}

function storagePathFor(ext: string): { relative: string; absolute: string } {
  const now = new Date();
  const folder = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const name = `${randomUUID()}.${ext}`;
  const relative = path.posix.join('clinical', folder, name);
  return { relative, absolute: path.join(STORAGE_ROOT, relative) };
}

/** Guards against path traversal even though names are generated. */
function absoluteFromStoredName(storedName: string): string {
  const absolute = path.resolve(STORAGE_ROOT, storedName);
  if (!absolute.startsWith(STORAGE_ROOT + path.sep)) {
    throw forbidden('Invalid stored file reference.');
  }
  return absolute;
}

const uploadSchema = z.object({
  visitId: uuidSchema.optional(),
  reportId: uuidSchema.optional(),
});

filesRouter.post(
  '/',
  requirePermission('CLINICAL_WRITE'),
  uploadLimiter,
  upload.single('file'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const parsed = uploadSchema.safeParse({
      visitId: req.body?.visitId || undefined,
      reportId: req.body?.reportId || undefined,
    });
    if (!parsed.success) throw badRequest('Provide a visit or report to attach the file to.');
    const { visitId, reportId } = parsed.data;
    if (!visitId && !reportId) throw badRequest('Provide a visit or report to attach the file to.');

    const file = req.file;
    if (!file) throw badRequest('Select a file to upload.');

    const cleanup = async () => {
      await unlink(file.path).catch(() => undefined);
    };

    try {
      // Resolve ownership from the clinical parent, never from the client.
      const [visit, report] = await Promise.all([
        visitId ? prisma.visit.findUnique({ where: { id: visitId } }) : Promise.resolve(null),
        reportId
          ? prisma.report.findUnique({ where: { id: reportId }, include: { visit: true } })
          : Promise.resolve(null),
      ]);

      if (visitId && !visit) throw notFound('Visit not found');
      if (reportId && !report) throw notFound('Report not found');

      const doctorId = report?.doctorId ?? visit?.doctorId;
      const patientId = report?.visit.patientId ?? visit?.patientId;
      if (!doctorId || !patientId) throw badRequest('Unable to resolve the clinical record.');
      assertClinicalWrite(me, doctorId);

      if (visitId && report && report.visitId !== visitId) {
        throw badRequest('The report does not belong to that visit.');
      }

      if (
        (report && report.status !== 'DRAFT') ||
        (visit && visit.status === 'COMPLETED') ||
        (report && report.visit.status === 'COMPLETED')
      ) {
        throw forbidden('Files cannot be added to a finalized record.');
      }

      const buffer = await readFile(file.path);
      const detected = detectType(buffer);
      if (!detected) {
        throw badRequest('Only JPEG, PNG, WebP, TIFF or PDF files are accepted.');
      }

      const target = storagePathFor(detected.ext);
      await mkdir(path.dirname(target.absolute), { recursive: true });
      await writeFile(target.absolute, buffer, { flag: 'wx' });

      const asset = await prisma.fileAsset.create({
        data: {
          patientId,
          visitId: visitId ?? report?.visitId ?? null,
          reportId: reportId ?? null,
          doctorId,
          uploadedById: me.id,
          originalName: path.basename(file.originalname).slice(0, 255),
          storedName: target.relative,
          mimeType: detected.mime,
          sizeBytes: buffer.length,
          checksum: null,
          kind: 'CLINICAL',
        },
      });

      await auditFromRequest(req, {
        action: 'file.uploaded',
        entityType: 'FileAsset',
        entityId: asset.id,
        patientId,
        metadata: { mimeType: detected.mime, sizeBytes: asset.sizeBytes, reportId, visitId },
      });

      res.status(201).json({
        file: {
          id: asset.id,
          originalName: asset.originalName,
          mimeType: asset.mimeType,
          sizeBytes: asset.sizeBytes,
          createdAt: asset.createdAt,
        },
      });
    } finally {
      await cleanup();
    }
  }),
);

filesRouter.get(
  '/:id',
  requirePermission('CLINICAL_READ'),
  asyncHandler(async (req, res) => {
    const { id } = parseParams(z.object({ id: uuidSchema }), req);
    const me = currentUser(req);

    const asset = await prisma.fileAsset.findUnique({ where: { id } });
    if (!asset) throw notFound('File not found');
    if (!asset.doctorId) throw forbidden('This file is not attached to a clinical record.');
    assertClinicalRead(me, asset.doctorId);

    const absolute = absoluteFromStoredName(asset.storedName);
    const inline = asset.mimeType.startsWith('image/');

    await auditFromRequest(req, {
      action: 'file.downloaded',
      entityType: 'FileAsset',
      entityId: asset.id,
      patientId: asset.patientId,
    });

    res.setHeader('Content-Type', asset.mimeType);
    res.setHeader('Content-Length', String(asset.sizeBytes));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader(
      'Content-Disposition',
      `${inline ? 'inline' : 'attachment'}; filename="${sanitiseFilename(asset.originalName)}"`,
    );
    createReadStream(absolute).on('error', () => {
      if (!res.headersSent) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'File not found on disk.' } });
      } else {
        res.end();
      }
    }).pipe(res);
  }),
);

filesRouter.delete(
  '/:id',
  requirePermission('CLINICAL_WRITE'),
  asyncHandler(async (req, res) => {
    const { id } = parseParams(z.object({ id: uuidSchema }), req);
    const me = currentUser(req);

    const asset = await prisma.fileAsset.findUnique({
      where: { id },
      include: { report: { select: { status: true } }, visit: { select: { status: true } } },
    });
    if (!asset) throw notFound('File not found');
    if (!asset.doctorId) throw forbidden('This file is not attached to a clinical record.');
    assertClinicalWrite(me, asset.doctorId);

    if (asset.report?.status === 'FINALIZED' || asset.visit?.status === 'COMPLETED') {
      throw forbidden('Files on finalized records cannot be deleted.');
    }

    await prisma.fileAsset.delete({ where: { id } });
    await unlink(absoluteFromStoredName(asset.storedName)).catch(() => undefined);

    await auditFromRequest(req, {
      action: 'file.deleted',
      entityType: 'FileAsset',
      entityId: id,
      patientId: asset.patientId,
      metadata: { originalName: asset.originalName },
    });

    res.status(204).end();
  }),
);

function sanitiseFilename(name: string): string {
  return name.replace(/[^\w.\- ()]/g, '_').slice(0, 120);
}
