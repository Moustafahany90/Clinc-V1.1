import { createApp } from './app.js';
import { env } from './config/env.js';
import { prisma } from './lib/prisma.js';
import { getClinicSettings } from './lib/clinic.js';
import { clinicTimezoneName } from './lib/time.js';
import { log } from './lib/logger.js';
import { ensureStorage } from './modules/files/routes.js';
import { closeHtmlPdfBrowser } from './lib/htmlPdf.js';
import { createShutdownController } from './lib/gracefulShutdown.js';

async function main(): Promise<void> {
  await ensureStorage();

  // Apply the administrator-configured clinic timezone before serving traffic.
  // A transient database outage must not prevent the API from starting.
  await getClinicSettings().catch(() => undefined);

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    log('info', 'api.listening', {
      message: 'api listening',
      port: env.PORT,
      environment: env.NODE_ENV,
      timezone: clinicTimezoneName(),
    });
  });

  const shutdownController = createShutdownController({
    closeServer: () => server.close(() => undefined),
    closeBrowser: () => closeHtmlPdfBrowser(),
    disconnectDatabase: () => prisma.$disconnect(),
    log,
    schedule: (callback, delayMs) => setTimeout(callback, delayMs),
    cancel: (timer) => clearTimeout(timer as unknown as NodeJS.Timeout),
    forceExit: (code) => process.exit(code),
  });

  process.on('SIGTERM', () => void shutdownController.shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdownController.shutdown('SIGINT'));
}

main().catch((err) => {
  log('fatal', 'api.start_failed', {
    message: 'failed to start API',
    error: (err as Error)?.name ?? 'Error',
    errorCode:
      typeof (err as { code?: unknown }).code === 'string'
        ? (err as { code: string }).code
        : null,
  });
  process.exit(1);
});
