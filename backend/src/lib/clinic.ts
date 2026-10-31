import { prisma } from './prisma.js';
import { setClinicTimezone } from './time.js';

/** The clinic settings row is a singleton with id = 1. */
export async function getClinicSettings() {
  const settings = await prisma.clinicSettings.upsert({
    where: { id: 1 },
    create: { id: 1 },
    update: {},
  });
  // Keep the scheduling helpers on the same timezone the administrator chose.
  setClinicTimezone(settings.timezone);
  return settings;
}

export async function isSetupRequired(): Promise<boolean> {
  const [userCount, settings] = await Promise.all([
    prisma.user.count(),
    prisma.clinicSettings.findUnique({ where: { id: 1 } }),
  ]);
  return userCount === 0 || !settings?.setupCompletedAt;
}
