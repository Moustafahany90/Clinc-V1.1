import { createApp } from './app.js';
import { env } from './config/env.js';
import { prisma } from './lib/prisma.js';
import { getClinicSettings } from './lib/clinic.js';
import { clinicTimezoneName } from './lib/time.js';
import { ensureStorage } from './modules/files/routes.js';

async function main(): Promise<void> {
  await ensureStorage();

  // Apply the administrator-configured clinic timezone before serving traffic.
  // A transient database outage must not prevent the API from starting.
  await getClinicSettings().catch(() => undefined);

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        level: 'info',
        message: 'api listening',
        port: env.PORT,
        env: env.NODE_ENV,
        timezone: clinicTimezoneName(),
      }),
    );
  });

  const shutdown = async (signal: string) => {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ level: 'info', message: 'shutting down', signal }));
    server.close(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
    setTimeout(() => process.exit(0), 5_000).unref();
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(
    JSON.stringify({
      level: 'fatal',
      message: 'failed to start API',
      error: (err as Error)?.name ?? 'Error',
      errorCode:
        typeof (err as { code?: unknown }).code === 'string'
          ? (err as { code: string }).code
          : null,
    }),
  );
  process.exit(1);
});
