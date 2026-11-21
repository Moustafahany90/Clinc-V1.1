import rateLimit from 'express-rate-limit';
import type { RequestHandler } from 'express';

const rateLimitedHandler: RequestHandler = (_req, res) => {
  res.status(429).json({
    error: {
      code: 'RATE_LIMITED',
      message: 'Too many attempts. Please wait and try again.',
    },
  });
};

function jsonLimit(limit: number, windowMs: number): RequestHandler {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: rateLimitedHandler,
  });
}

/** Broad limiter for the whole API. */
export const apiLimiter = jsonLimit(600, 60_000);

/**
 * Login IP ceiling. Kept deliberately generous because a clinic's staff can
 * share one public IP; per-account abuse is handled by `loginAccountLimiter`.
 */
export const loginLimiter = jsonLimit(100, 15 * 60_000);

/**
 * Per-account login limiter keyed by the normalised email supplied by the
 * client. This stops credential stuffing against one account without locking
 * out unrelated accounts that happen to share the same NAT/IP. Requests with
 * a missing or non-string email fall back to the IP key so malformed clients
 * cannot bypass the limit.
 */
export const loginAccountLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: rateLimitedHandler,
  keyGenerator: (req) => {
    const raw = (req.body as { email?: unknown } | undefined)?.email;
    const normalized = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    return normalized || `no-email:${req.ip ?? 'unknown'}`;
  },
});

export const refreshLimiter = jsonLimit(120, 15 * 60_000);

/** Public password-setup and invite acceptance endpoints. */
export const passwordSetupLimiter = jsonLimit(20, 60 * 60_000);

/** Setup wizard: only usable before bootstrap anyway, but keep it cheap. */
export const setupLimiter = jsonLimit(10, 60 * 60_000);

export const uploadLimiter = jsonLimit(60, 10 * 60_000);

/** Finalized-report delivery is deliberately manual and low-volume. */
export const reportDeliveryLimiter = jsonLimit(20, 10 * 60_000);
