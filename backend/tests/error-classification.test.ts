import assert from 'node:assert/strict';
import type { NextFunction, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { MulterError } from 'multer';
import test from 'node:test';
import { z } from 'zod';
import { env } from '../src/config/env.js';
import { AppError } from '../src/lib/errors.js';
import { errorHandler, notFoundHandler } from '../src/middleware/error.js';

/**
 * Unit/characterisation tests for the central error middleware.
 *
 * These call the middleware directly with a mock Express request/response, so
 * they do not need a database. They lock every existing classification and
 * response body, then add the wrapped-23P01 cases fixed in Phase 9.1.
 */

interface Captured {
  status: number | null;
  body: unknown;
}

function mockRequest(): Request {
  return {
    requestId: 'req-phase91',
    method: 'POST',
    originalUrl: '/api/v1/queue/walk-in?ignored=1',
    baseUrl: '/api/v1',
    route: { path: '/queue/walk-in' },
    path: '/queue/walk-in',
    headers: {},
  } as unknown as Request;
}

function mockResponse(captured: Captured): Response {
  const response: {
    headersSent: boolean;
    status: (code: number) => unknown;
    json: (body: unknown) => unknown;
  } = {
    headersSent: false,
    status(code: number) {
      captured.status = code;
      return response;
    },
    json(body: unknown) {
      captured.body = body;
      return response;
    },
  };
  return response as unknown as Response;
}

function invoke(err: unknown, req: Request = mockRequest()): Captured {
  const captured: Captured = { status: null, body: null };
  errorHandler(
    err,
    req,
    mockResponse(captured),
    (() => undefined) as unknown as NextFunction,
  );
  assert.notEqual(captured.status, null, 'the error handler must send a response');
  return captured;
}

const overlapResponse = {
  error: {
    code: 'APPOINTMENT_CONFLICT',
    message: 'This doctor already has an appointment overlapping that time.',
  },
};

function internalResponse(detail?: string) {
  const error: Record<string, unknown> = {
    code: 'INTERNAL',
    message: 'Something went wrong. Please try again.',
  };
  if (!env.isProduction && detail !== undefined) error.detail = detail;
  return { error };
}

const wrappedPrismaMessage = [
  '',
  'Invalid `prisma.appointment.create()` invocation:',
  '',
  '',
  'Error occurred during query execution:',
  'ConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "23P01", message: "conflicting key value violates exclusion constraint \\"appointment_no_doctor_overlap\\"", severity: "ERROR", detail: Some("Key (\\"doctorId\\", tsrange(\\"startAt\\", \\"endAt\\", \'[)\'::text)) conflicts with existing key."), column: None, hint: None }), transient: false })',
].join('\n');

test('maps a text-wrapped Prisma unknown-request 23P01 violation to APPOINTMENT_CONFLICT', () => {
  const err = new Prisma.PrismaClientUnknownRequestError(wrappedPrismaMessage, {
    clientVersion: '6.18.0',
  });
  assert.equal((err as { code?: string }).code, undefined);
  assert.deepStrictEqual(invoke(err), { status: 409, body: overlapResponse });
});

test('maps a structured nested 23P01 cause to APPOINTMENT_CONFLICT', () => {
  const cause = Object.assign(new Error('exclusion violation'), { code: '23P01' });
  const err = Object.assign(new Error('wrapped'), { cause });
  assert.deepStrictEqual(invoke(err), { status: 409, body: overlapResponse });
});

test('maps a known-request error wrapping a structured 23P01 cause to APPOINTMENT_CONFLICT', () => {
  const err = new Prisma.PrismaClientKnownRequestError('transaction failed', {
    code: 'P2028',
    clientVersion: '6.18.0',
  });
  Object.assign(err, {
    cause: { code: '23P01', constraint: 'appointment_no_doctor_overlap' },
  });
  assert.deepStrictEqual(invoke(err), { status: 409, body: overlapResponse });
});

test('does not reclassify message text with only the SQLSTATE', () => {
  const message = 'PostgresError { code: "23P01", message: "conflicting key value" }';
  assert.deepStrictEqual(invoke(new Error(message)), {
    status: 500,
    body: internalResponse(message),
  });
});

test('does not reclassify message text with only the constraint name', () => {
  const message = 'exclusion constraint "appointment_no_doctor_overlap"';
  assert.deepStrictEqual(invoke(new Error(message)), {
    status: 500,
    body: internalResponse(message),
  });
});

test('does not reclassify a different exclusion constraint', () => {
  const message = 'PostgresError { code: "23P01", message: "constraint \\"other_exclusion\\"" }';
  assert.deepStrictEqual(invoke(new Error(message)), {
    status: 500,
    body: internalResponse(message),
  });
});

test('preserves the existing top-level 23P01 response', () => {
  assert.deepStrictEqual(invoke(Object.assign(new Error('overlap'), { code: '23P01' })), {
    status: 409,
    body: overlapResponse,
  });
});

test('preserves the existing top-level 23505 response', () => {
  assert.deepStrictEqual(invoke(Object.assign(new Error('duplicate'), { code: '23505' })), {
    status: 409,
    body: { error: { code: 'DUPLICATE', message: 'Duplicate record.' } },
  });
});

test('preserves P2002 with a target list', () => {
  const err = new Prisma.PrismaClientKnownRequestError('unique', {
    code: 'P2002',
    clientVersion: '6.18.0',
    meta: { target: ['email', 'clinicId'] },
  });
  assert.deepStrictEqual(invoke(err), {
    status: 409,
    body: { error: { code: 'DUPLICATE', message: 'This email, clinicId is already in use.' } },
  });
});

test('preserves P2002 without a target list', () => {
  const err = new Prisma.PrismaClientKnownRequestError('unique', {
    code: 'P2002',
    clientVersion: '6.18.0',
  });
  assert.deepStrictEqual(invoke(err), {
    status: 409,
    body: { error: { code: 'DUPLICATE', message: 'This value is already in use.' } },
  });
});

test('preserves P2025', () => {
  const err = new Prisma.PrismaClientKnownRequestError('missing', {
    code: 'P2025',
    clientVersion: '6.18.0',
  });
  assert.deepStrictEqual(invoke(err), {
    status: 404,
    body: { error: { code: 'NOT_FOUND', message: 'Resource not found.' } },
  });
});

test('preserves P2003', () => {
  const err = new Prisma.PrismaClientKnownRequestError('fk', {
    code: 'P2003',
    clientVersion: '6.18.0',
  });
  assert.deepStrictEqual(invoke(err), {
    status: 409,
    body: {
      error: {
        code: 'IN_USE',
        message: 'This record is referenced by other data and cannot be changed that way.',
      },
    },
  });
});

test('preserves AppError status, code, message and details', () => {
  const err = new AppError(422, 'CUSTOM', 'custom message', { field: 'value' });
  assert.deepStrictEqual(invoke(err), {
    status: 422,
    body: { error: { code: 'CUSTOM', message: 'custom message', details: { field: 'value' } } },
  });
});

test('preserves ZodError validation response', () => {
  const parsed = z.object({ email: z.string().email() }).safeParse({ email: 'not-an-email' });
  assert.equal(parsed.success, false);
  if (parsed.success) return;
  assert.deepStrictEqual(invoke(parsed.error), {
    status: 400,
    body: {
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Please check the submitted values.',
        details: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
    },
  });
});

test('preserves Multer upload responses', () => {
  const tooLarge = new MulterError('LIMIT_FILE_SIZE');
  assert.deepStrictEqual(invoke(tooLarge), {
    status: 400,
    body: {
      error: {
        code: 'UPLOAD_ERROR',
        message: `File is larger than the ${env.MAX_UPLOAD_MB} MB limit.`,
      },
    },
  });
  const other = new MulterError('LIMIT_FILE_COUNT');
  assert.deepStrictEqual(invoke(other), {
    status: 400,
    body: { error: { code: 'UPLOAD_ERROR', message: 'The upload could not be accepted.' } },
  });
});

test('preserves the generic 500 response', () => {
  const err = new Error('ordinary failure');
  assert.deepStrictEqual(invoke(err), { status: 500, body: internalResponse(err.message) });
});

test('does not send a second response once headers are sent', () => {
  const captured: Captured = { status: null, body: null };
  const response = mockResponse(captured);
  (response as { headersSent: boolean }).headersSent = true;
  errorHandler(new Error('late'), mockRequest(), response, (() => undefined) as unknown as NextFunction);
  assert.deepStrictEqual(captured, { status: null, body: null });
});

test('preserves the not-found response', () => {
  const captured: Captured = { status: null, body: null };
  notFoundHandler(mockRequest(), mockResponse(captured));
  assert.deepStrictEqual(captured, {
    status: 404,
    body: {
      error: {
        code: 'NOT_FOUND',
        message: 'No route for POST /api/v1/queue/walk-in?ignored=1',
      },
    },
  });
});
