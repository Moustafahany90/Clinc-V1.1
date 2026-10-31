/**
 * Seeds only non-sensitive defaults.
 *
 * This script deliberately creates NO users, patients, reports, payments or
 * credentials. The first administrator is created through the setup wizard.
 */
import { prisma } from '../src/lib/prisma.js';
import { ensureDefaults } from '../src/lib/defaults.js';

async function main(): Promise<void> {
  await ensureDefaults();
  const [methods, categories, services, hours] = await Promise.all([
    prisma.paymentMethod.count(),
    prisma.expenseCategory.count(),
    prisma.service.count(),
    prisma.workingHours.count(),
  ]);
  // eslint-disable-next-line no-console
  console.log(
    `Defaults ready: ${methods} payment methods, ${categories} expense categories, ${services} services, ${hours} working-hour rows.`,
  );
  // eslint-disable-next-line no-console
  console.log('No accounts were created. Complete setup in the web app.');
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
