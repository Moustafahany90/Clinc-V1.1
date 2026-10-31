import rateLimit from 'express-rate-limit';
import type { RequestHandler } from 'express';

function jsonLimit(limit: number, windowMs: number): RequestHandler {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many attempts. Please wait and try again.',
        },
      });
    },
  });
}

/** Broad limiter for the whole API. */
export const apiLimiter = jsonLimit(600, 60_000);

/** Login: per-IP. Account-level lockout is enforced separately in the service. */
export const loginLimiter = jsonLimit(10, 15 * 60_000);

export const refreshLimiter = jsonLimit(120, 15 * 60_000);

/** Public password-setup and invite acceptance endpoints. */
export const passwordSetupLimiter = jsonLimit(20, 60 * 60_000);

/** Setup wizard: only usable before bootstrap anyway, but keep it cheap. */
export const setupLimiter = jsonLimit(10, 60 * 60_000);

export const uploadLimiter = jsonLimit(60, 10 * 60_000);

/** Finalized-report delivery is deliberately manual and low-volume. */
export const reportDeliveryLimiter = jsonLimit(20, 10 * 60_000);
