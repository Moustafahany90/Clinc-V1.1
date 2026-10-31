import type { ErrorRequestHandler, RequestHandler } from 'express';
import { Prisma } from '@prisma/client';
import { MulterError } from 'multer';
import { ZodError } from 'zod';
import { AppError } from '../lib/errors.js';
import { env } from '../config/env.js';

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({
    error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.originalUrl}` },
  });
};

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
  const dbCode = (err as { code?: string }).code;
  if (dbCode === '23P01') {
    res.status(409).json({
      error: {
        code: 'APPOINTMENT_CONFLICT',
        message: 'This doctor already has an appointment overlapping that time.',
      },
    });
    return;
  }

  if (dbCode === '23505') {
    res.status(409).json({ error: { code: 'DUPLICATE', message: 'Duplicate record.' } });
    return;
  }

  // Never log request bodies, query strings, or raw error messages: they can
  // contain PHI, credentials or tokens. Keep just enough for correlation.
  // eslint-disable-next-line no-console
  console.error(
    JSON.stringify({
      level: 'error',
      event: 'request.failed',
      requestId: req.requestId ?? null,
      method: req.method,
      path: req.path,
      error: (err as Error)?.name ?? 'Error',
      errorCode:
        typeof (err as { code?: unknown }).code === 'string'
          ? (err as { code: string }).code
          : null,
    }),
  );
  res.status(500).json({
    error: {
      code: 'INTERNAL',
      message: 'Something went wrong. Please try again.',
      ...(env.isProduction ? {} : { detail: (err as Error)?.message }),
    },
  });
};
