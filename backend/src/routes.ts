import { Router } from 'express';
import { prisma } from './lib/prisma.js';
import { auditHealth } from './lib/audit.js';
import { adminSessionsRouter, authRouter, sessionsRouter } from './modules/auth/routes.js';
import { setupRouter } from './modules/setup/routes.js';
import { usersRouter } from './modules/users/routes.js';
import { patientsRouter } from './modules/patients/routes.js';
import { appointmentsRouter } from './modules/appointments/routes.js';
import { queueRouter } from './modules/queue/routes.js';
import { visitsRouter } from './modules/visits/routes.js';
import { reportsRouter } from './modules/reports/routes.js';
import { filesRouter } from './modules/files/routes.js';
import { paymentsRouter } from './modules/payments/routes.js';
import { expensesRouter } from './modules/expenses/routes.js';
import { financialRouter } from './modules/financial/routes.js';
import { settingsRouter } from './modules/settings/routes.js';
import { dashboardRouter } from './modules/dashboard/routes.js';
import { auditRouter } from './modules/audit/routes.js';

export const apiRouter = Router();

apiRouter.get('/health', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ status: 'ok', service: 'ultrasound-clinic-api', uptime: process.uptime() });
});

apiRouter.get('/health/db', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.setHeader('Cache-Control', 'no-store');
    res.json({ status: 'ok', database: 'reachable' });
  } catch {
    res.status(503).json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Database unreachable.' } });
  }
});

/**
 * Readiness probe used by the container healthcheck. It deliberately verifies
 * the database, not just that the Node process is alive.
 */
async function readiness(res: import('express').Response): Promise<void> {
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
}

apiRouter.get('/readyz', async (_req, res) => {
  await readiness(res);
});

apiRouter.use('/auth', authRouter);
apiRouter.use('/sessions', sessionsRouter);
apiRouter.use('/admin/sessions', adminSessionsRouter);
apiRouter.use('/setup', setupRouter);
apiRouter.use('/users', usersRouter);
apiRouter.use('/patients', patientsRouter);
apiRouter.use('/appointments', appointmentsRouter);
apiRouter.use('/queue', queueRouter);
apiRouter.use('/visits', visitsRouter);
apiRouter.use('/reports', reportsRouter);
apiRouter.use('/files', filesRouter);
apiRouter.use('/payments', paymentsRouter);
apiRouter.use('/expenses', expensesRouter);
apiRouter.use('/financial-reports', financialRouter);
apiRouter.use('/settings', settingsRouter);
apiRouter.use('/dashboard', dashboardRouter);
apiRouter.use('/audit', auditRouter);
