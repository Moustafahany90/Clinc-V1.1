import type { Prisma } from '@prisma/client';
import { prisma } from './prisma.js';

/**
 * Atomic counter using Postgres UPSERT ... RETURNING, so concurrent patient
 * creation can never produce a duplicate number.
 */
export async function nextSequence(
  name: string,
  tx: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<number> {
  const rows = await tx.$queryRaw<Array<{ value: number }>>`
    INSERT INTO "Sequence" ("name", "value")
    VALUES (${name}, 1)
    ON CONFLICT ("name") DO UPDATE SET "value" = "Sequence"."value" + 1
    RETURNING "value"
  `;
  const value = rows[0]?.value;
  if (typeof value !== 'number') throw new Error(`Sequence ${name} failed`);
  return value;
}

export async function nextPatientNumber(
  tx: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<string> {
  const value = await nextSequence('patient', tx);
  return `P-${String(value).padStart(6, '0')}`;
}
