import type { Prisma } from '@prisma/client';

/**
 * Queue-position allocation uses PostgreSQL's two-integer advisory key
 * namespace. PostgreSQL documents that the one-bigint and two-integer advisory
 * key spaces do not overlap, so this lock can never collide with the existing
 * one-argument `hashtext(...)` locks used for doctor calendars, patient
 * ledgers, reports and setup.
 *
 * `QUEUE_LOCK_DOMAIN_KEY` is the ASCII bytes "QLOC" (Queue LOCk) packed into a
 * signed 32-bit integer. `QUEUE_LOCK_ENTITY_KEY` is PostgreSQL's built-in
 * `hashtext` over a deterministic `YYYY-MM-DD|doctorId` identity. The two-int
 * pair is therefore derived identically by every caller.
 */
export const QUEUE_LOCK_DOMAIN_KEY = 1_363_955_523; // "QLOC"
export const QUEUE_LOCK_VERSION = 1;

export interface QueueLockIdentity {
  /** Fixed domain discriminator; never reused by another subsystem. */
  domainKey: number;
  /** Deterministic, domain-local logical queue identity. */
  identity: string;
  version: number;
}

/**
 * Canonical queue identity. `queueDateOnly` must already be a validated
 * `YYYY-MM-DD` clinic-local date; callers obtain it from `clinicDateString()`.
 */
export function queueLockIdentity(doctorId: string, queueDateOnly: string): QueueLockIdentity {
  return {
    domainKey: QUEUE_LOCK_DOMAIN_KEY,
    identity: `v${QUEUE_LOCK_VERSION}|${queueDateOnly}|${doctorId}`,
    version: QUEUE_LOCK_VERSION,
  };
}

/**
 * Acquire the transaction-scoped queue allocation lock. Must be called inside
 * the same `$transaction` that reads queue state and writes the queue entry.
 * The lock is released by PostgreSQL on COMMIT or ROLLBACK.
 */
export async function acquireQueueAllocationLock(
  tx: Prisma.TransactionClient,
  doctorId: string,
  queueDateOnly: string,
): Promise<void> {
  const { domainKey, identity } = queueLockIdentity(doctorId, queueDateOnly);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${domainKey}::int, hashtext(${identity})::int)`;
}

/**
 * Allocate the next queue position for a doctor and clinic-local date.
 * The caller must already hold `acquireQueueAllocationLock` on the same
 * transaction/client. `excludeQueueEntryId` is used when an existing row is
 * being moved into this queue and must not count itself.
 */
export async function allocateQueuePosition(
  tx: Prisma.TransactionClient,
  doctorId: string,
  queueDate: Date,
  excludeQueueEntryId?: string,
): Promise<number> {
  const occupied = await tx.queueEntry.count({
    where: {
      queueDate,
      doctorId,
      ...(excludeQueueEntryId ? { id: { not: excludeQueueEntryId } } : {}),
    },
  });
  return occupied + 1;
}
