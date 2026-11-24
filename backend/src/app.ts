import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { randomUUID } from 'node:crypto';
import { env } from './config/env.js';
import { apiRouter } from './routes.js';
import { prisma } from './lib/prisma.js';
import { auditHealth } from './lib/audit.js';
import { BUILD_SHA } from './lib/buildInfo.js';
import { log, safeRoute } from './lib/logger.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { apiLimiter } from './middleware/rateLimit.js';

export function createApp(): express.Express {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY);

  app.use(
    helmet({
      // The API returns JSON and authorized file streams; the SPA sets its own
      // headers via Nginx.
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'same-site' },
      referrerPolicy: { policy: 'no-referrer' },
      strictTransportSecurity: env.isProduction
        ? { maxAge: 31_536_000, includeSubDomains: true, preload: false }
        : false,
    }),
  );

  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || env.corsOrigins.includes(origin)) return callback(null, true);
        return callback(new Error('Origin not allowed'));
      },
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
    }),
  );

  app.use(cookieParser());
  app.use(express.json({ limit: env.BODY_LIMIT }));
  app.use(express.urlencoded({ extended: false, limit: env.BODY_LIMIT }));

  app.use((req, res, next) => {
    const id = req.get('x-request-id') ?? randomUUID();
    req.requestId = id;
    res.setHeader('x-request-id', id);
    next();
  });

  // One structured line per completed request. No bodies, headers, query
  // strings or raw URLs are captured; the route template is used instead.
  app.use((req, res, next) => {
    const started = Date.now();
    res.once('finish', () => {
      const probe =
        req.path === '/healthz' ||
        req.path.startsWith('/api/v1/health') ||
        req.path === '/api/v1/readyz';
      const level = probe
        ? 'debug'
        : res.statusCode >= 500
          ? 'error'
          : res.statusCode >= 400
            ? 'warn'
            : 'info';
      log(level, 'http.request', {
        requestId: req.requestId ?? null,
        method: req.method,
        route: safeRoute(req),
        status: res.statusCode,
        durationMs: Date.now() - started,
        userId: req.user?.id ?? null,
        role: req.user?.role ?? null,
      });
    });
    next();
  });

  app.use('/api', apiLimiter);
  app.use('/api/v1', apiRouter);

  app.get('/healthz', async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const audit = auditHealth();
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({
        status: 'ok',
        service: 'ultrasound-clinic-api',
        database: 'reachable',
        uptime: process.uptime(),
        audit,
        buildSha: BUILD_SHA,
      });
    } catch {
      res.status(503).json({
        status: 'unavailable',
        service: 'ultrasound-clinic-api',
        database: 'unreachable',
        audit,
        buildSha: BUILD_SHA,
      });
    }
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
