import type { Prisma } from '@prisma/client';
import { prisma } from './prisma.js';

/**
 * Idempotent, non-sensitive defaults only:
 *  - payment methods (no tax types, no invoice series)
 *  - basic expense categories
 *  - common ultrasound exam types with durations and zero price
 *  - clinic opening template (Sat/Sun 13:00, Mon-Wed 14:30, Thu/Fri closed
 *    until an administrator configures them)
 *
 * Never seeds patients, reports, payments, staff accounts or credentials.
 */
export async function ensureDefaults(
  tx: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<void> {
  await tx.paymentMethod.createMany({
    data: [
      { key: 'CASH', label: 'Cash', requiresReference: false, sortOrder: 1 },
      { key: 'INSTAPAY', label: 'InstaPay', requiresReference: true, sortOrder: 2 },
      { key: 'BANK_TRANSFER', label: 'Bank transfer', requiresReference: true, sortOrder: 3 },
    ],
    skipDuplicates: true,
  });

  await tx.expenseCategory.createMany({
    data: [
      { name: 'Supplies' },
      { name: 'Equipment' },
      { name: 'Rent' },
      { name: 'Utilities' },
      { name: 'Salaries' },
      { name: 'Maintenance' },
      { name: 'Other' },
    ],
    skipDuplicates: true,
  });

  await tx.service.createMany({
    data: [
      { name: 'Abdominal ultrasound', durationMinutes: 20 },
      { name: 'Pelvic ultrasound', durationMinutes: 20 },
      { name: 'Obstetric ultrasound', durationMinutes: 20 },
      { name: 'Thyroid ultrasound', durationMinutes: 15 },
      { name: 'Breast ultrasound', durationMinutes: 20 },
      { name: 'Doppler ultrasound', durationMinutes: 30 },
    ],
    skipDuplicates: true,
  });

  await tx.workingHours.createMany({
    data: [
      { dayOfWeek: 1, isOpen: true, openMinute: 870, closeMinute: 1260 },
      { dayOfWeek: 2, isOpen: true, openMinute: 870, closeMinute: 1260 },
      { dayOfWeek: 3, isOpen: true, openMinute: 870, closeMinute: 1260 },
      { dayOfWeek: 4, isOpen: false, openMinute: 870, closeMinute: 1260 },
      { dayOfWeek: 5, isOpen: false, openMinute: 870, closeMinute: 1260 },
      { dayOfWeek: 6, isOpen: true, openMinute: 780, closeMinute: 1260 },
      { dayOfWeek: 7, isOpen: true, openMinute: 780, closeMinute: 1260 },
    ],
    skipDuplicates: true,
  });

  await tx.reportTemplate.createMany({
    data: [
      {
        name: 'General ultrasound report',
        description: 'Baseline structured ultrasound report with free-text findings.',
        fields: [
          { key: 'indication', label: 'Clinical indication', type: 'textarea', required: true },
          { key: 'findings', label: 'Findings', type: 'textarea', required: true },
          { key: 'measurements', label: 'Measurements', type: 'text', required: false },
          { key: 'impression', label: 'Impression / conclusion', type: 'textarea', required: true },
          { key: 'recommendations', label: 'Recommendations', type: 'textarea', required: false },
        ],
      },
    ],
    skipDuplicates: true,
  });
}
