import type { Request } from 'express';
import { z, type ZodTypeAny } from 'zod';
import { badRequest } from './errors.js';

/**
 * Parse + validate explicitly inside handlers. Avoids mutating Express
 * request properties that are getter-only in Express 5 upgrades.
 */
export function parseBody<T extends ZodTypeAny>(schema: T, req: Request): z.infer<T> {
  const result = schema.safeParse(req.body);
  if (!result.success) {
    throw badRequest('Please check the submitted values.', fieldErrors(result.error));
  }
  return result.data;
}

export function parseQuery<T extends ZodTypeAny>(schema: T, req: Request): z.infer<T> {
  const result = schema.safeParse(req.query);
  if (!result.success) {
    throw badRequest('Invalid query parameters.', fieldErrors(result.error));
  }
  return result.data;
}

export function parseParams<T extends ZodTypeAny>(schema: T, req: Request): z.infer<T> {
  const result = schema.safeParse(req.params);
  if (!result.success) {
    throw badRequest('Invalid route parameters.', fieldErrors(result.error));
  }
  return result.data;
}

function fieldErrors(error: z.ZodError) {
  return error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
}

export const dateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'Invalid calendar date');

export const uuidSchema = z.string().uuid('Invalid identifier');

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
