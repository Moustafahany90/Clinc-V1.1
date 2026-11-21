import type { ErrorRequestHandler, RequestHandler } from 'express';
import { Prisma } from '@prisma/client';
import { MulterError } from 'multer';
import { ZodError } from 'zod';
import { AppError } from '../lib/errors.js';
import { env } from '../config/env.js';
import { log, safeRoute } from '../lib/logger.js';

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({
    error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.originalUrl}` },
  });
};

const APPOINTMENT_OVERLAP_SQLSTATE = '23P01';
const APPOINTMENT_OVERLAP_CONSTRAINT = 'appointment_no_doctor_overlap';

const APPOINTMENT_OVERLAP_RESPONSE = {
  error: {
    code: 'APPOINTMENT_CONFLICT',
    message: 'This doctor already has an appointment overlapping that time.',
  },
} as const;

/** Prisma sometimes embeds the driver error in `message` without a `cause`. */
const ERROR_CHAIN_KEYS = ['cause', 'originalError', 'wrappedError', 'meta'] as const;

// Both pieces are required: a bare SQLSTATE or a bare constraint name is not
// enough to reclassify an otherwise unclassified error.
const SQLSTATE_FIELD_PATTERN =
  /(?<![A-Za-z0-9_])(?:\\?["'])?code(?:\\?["'])?\s*[:=]\s*(?:\\?["'])?23P01(?:\\?["'])?/;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const CONSTRAINT_FIELD_PATTERN = new RegExp(
  `(?<![A-Za-z0-9_])constraint(?:Name|_name)?\\s*(?:[:=]\\s*)?(?:\\\\?["'])?` +
    `(?<![A-Za-z0-9_])${escapeRegExp(APPOINTMENT_OVERLAP_CONSTRAINT)}` +
    `(?![A-Za-z0-9_])(?:\\\\?["'])?`,
  'i',
);

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' ? (value as UnknownRecord) : null;
}

/** Walk nested/wrapped errors once, ignoring cycles. */
function errorChain(err: unknown): unknown[] {
  const seen = new Set<unknown>();
  const result: unknown[] = [];
  const queue: unknown[] = [err];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    result.push(current);
    const record = asRecord(current);
    if (!record) continue;
    for (const key of ERROR_CHAIN_KEYS) {
      const nested = record[key];
      if (nested && typeof nested === 'object') queue.push(nested);
    }
  }
  return result;
}

/** Structured PostgreSQL SQLSTATE anywhere in the error chain. */
function hasStructuredOverlap(err: unknown): boolean {
  return errorChain(err).some((node) => asRecord(node)?.code === APPOINTMENT_OVERLAP_SQLSTATE);
}

/** Message-only fallback used when Prisma embeds the driver error as text. */
function hasMessageOverlap(err: unknown): boolean {
  return errorChain(err).some((node) => {
    const message = asRecord(node)?.message;
    return (
      typeof message === 'string' &&
      SQLSTATE_FIELD_PATTERN.test(message) &&
      CONSTRAINT_FIELD_PATTERN.test(message)
    );
  });
}

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (res.headersSent) return;

  if (err instanceof AppError) {
    res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Please check the submitted values.',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    });
    return;
  }

  if (err instanceof MulterError) {
    const message =
      err.code === 'LIMIT_FILE_SIZE'
        ? `File is larger than the ${env.MAX_UPLOAD_MB} MB limit.`
        : 'The upload could not be accepted.';
    res.status(400).json({ error: { code: 'UPLOAD_ERROR', message } });
    return;
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      const target = Array.isArray(err.meta?.target)
        ? (err.meta?.target as string[]).join(', ')
        : 'value';
      res.status(409).json({
        error: { code: 'DUPLICATE', message: `This ${target} is already in use.` },
      });
      return;
    }
    if (err.code === 'P2025') {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Resource not found.' } });
      return;
    }
    if (err.code === 'P2003') {
      res.status(409).json({
        error: {
          code: 'IN_USE',
          message: 'This record is referenced by other data and cannot be changed that way.',
        },
      });
      return;
    }
  }

  // Postgres exclusion constraint = overlapping appointment for a doctor.
  // Handle the plain driver error, a structured nested cause, and Prisma's
  // text-wrapped connector error through the same classification path.
  const dbCode = (err as { code?: string }).code;
  if (
    dbCode === APPOINTMENT_OVERLAP_SQLSTATE ||
    hasStructuredOverlap(err) ||
    hasMessageOverlap(err)
  ) {
    res.status(409).json(APPOINTMENT_OVERLAP_RESPONSE);
    return;
  }

  if (dbCode === '23505') {
    res.status(409).json({ error: { code: 'DUPLICATE', message: 'Duplicate record.' } });
    return;
  }

  // Never log request bodies, query strings, or raw error messages: they can
  // contain PHI, credentials or tokens. Keep just enough for correlation.
  log('error', 'request.failed', {
    requestId: req.requestId ?? null,
    method: req.method,
    route: safeRoute(req),
    error: (err as Error)?.name ?? 'Error',
    errorCode:
      typeof (err as { code?: unknown }).code === 'string'
        ? (err as { code: string }).code
        : null,
  });
  res.status(500).json({
    error: {
      code: 'INTERNAL',
      message: 'Something went wrong. Please try again.',
      ...(env.isProduction ? {} : { detail: (err as Error)?.message }),
    },
  });
};
