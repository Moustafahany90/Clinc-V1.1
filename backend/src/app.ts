import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { randomUUID } from 'node:crypto';
import { env } from './config/env.js';
import { apiRouter } from './routes.js';
import { prisma } from './lib/prisma.js';
import { auditHealth } from './lib/audit.js';
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
      });
    } catch {
      res.status(503).json({
        status: 'unavailable',
        service: 'ultrasound-clinic-api',
        database: 'unreachable',
        audit,
      });
    }
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
