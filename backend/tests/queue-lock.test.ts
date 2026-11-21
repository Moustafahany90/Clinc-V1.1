import assert from 'node:assert/strict';
import { Prisma } from '@prisma/client';
import test from 'node:test';
import { prisma } from '../src/lib/prisma.js';
import {
  QUEUE_LOCK_DOMAIN_KEY,
  acquireQueueAllocationLock,
  allocateQueuePosition,
  queueLockIdentity,
} from '../src/lib/queueLock.js';

const DOCTOR_ID = '11111111-2222-4333-8444-555555555555';
const QUEUE_DATE = '2031-05-01';

interface RawCall {
  strings: string[];
  values: unknown[];
}

function fakeTransaction(countResult = 4): {
  tx: Prisma.TransactionClient;
  rawCalls: RawCall[];
  countCalls: unknown[];
} {
  const rawCalls: RawCall[] = [];
  const countCalls: unknown[] = [];
  const tx = {
    $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
      rawCalls.push({ strings: [...strings], values });
      return Promise.resolve(1);
    },
    queueEntry: {
      count: (args: unknown) => {
        countCalls.push(args);
        return Promise.resolve(countResult);
      },
    },
  } as unknown as Prisma.TransactionClient;
  return { tx, rawCalls, countCalls };
}

test('queue lock identity is deterministic and domain separated', () => {
  const first = queueLockIdentity(DOCTOR_ID, QUEUE_DATE);
  const second = queueLockIdentity(DOCTOR_ID, QUEUE_DATE);
  assert.deepEqual(first, second);
  assert.equal(first.domainKey, QUEUE_LOCK_DOMAIN_KEY);
  assert.match(first.identity, /^v1\|2031-05-01\|11111111-2222-4333-8444-555555555555$/);
  assert.notDeepEqual(
    queueLockIdentity(DOCTOR_ID, QUEUE_DATE),
    queueLockIdentity(DOCTOR_ID, '2031-05-02'),
  );
  assert.notDeepEqual(
    queueLockIdentity(DOCTOR_ID, QUEUE_DATE),
    queueLockIdentity('99999999-2222-4333-8444-555555555555', QUEUE_DATE),
  );
});

test('queue lock uses the two-integer advisory key namespace', async () => {
  const { tx, rawCalls } = fakeTransaction();
  await acquireQueueAllocationLock(tx, DOCTOR_ID, QUEUE_DATE);

  assert.equal(rawCalls.length, 1);
  // The fake client records the raw template parts without Prisma's `$n`
  // placeholders, so assert the SQL shape and the bound values separately.
  const sql = rawCalls[0]!.strings.join('');
  assert.ok(sql.includes('pg_advisory_xact_lock('), sql);
  assert.ok(sql.includes('::int, hashtext('), sql);
  assert.ok(sql.includes(')::int)'), sql);
  assert.doesNotMatch(sql, /bigint/);
  assert.deepEqual(rawCalls[0]!.values, [
    QUEUE_LOCK_DOMAIN_KEY,
    queueLockIdentity(DOCTOR_ID, QUEUE_DATE).identity,
  ]);
});

test('position allocation counts only the target queue on the transaction client', async () => {
  const { tx, countCalls } = fakeTransaction(4);
  const queueDate = new Date(`${QUEUE_DATE}T00:00:00.000Z`);
  const movingId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

  assert.equal(await allocateQueuePosition(tx, DOCTOR_ID, queueDate, movingId), 5);
  assert.deepEqual(countCalls[0], {
    where: { queueDate, doctorId: DOCTOR_ID, id: { not: movingId } },
  });

  const { tx: plainTx, countCalls: plainCalls } = fakeTransaction(0);
  assert.equal(await allocateQueuePosition(plainTx, DOCTOR_ID, queueDate), 1);
  assert.deepEqual(plainCalls[0], { where: { queueDate, doctorId: DOCTOR_ID } });
});

const databaseUrl = process.env.DATABASE_URL ?? '';
const isDisposableTestDatabase = (() => {
  try {
    return new URL(databaseUrl).pathname.replace(/^\//, '').endsWith('_test');
  } catch {
    return false;
  }
})();

test(
  'PostgreSQL reports the queue lock with the documented two-int identity',
  { skip: !isDisposableTestDatabase && 'requires a disposable *_test database' },
  async () => {
    const identity = queueLockIdentity(DOCTOR_ID, QUEUE_DATE).identity;
    await prisma.$transaction(async (tx) => {
      await acquireQueueAllocationLock(tx, DOCTOR_ID, QUEUE_DATE);

      const expected = await tx.$queryRaw<Array<{ key: number }>>`
        SELECT hashtext(${identity})::int AS key
      `;
      const locks = await tx.$queryRaw<Array<{ classid: number; objid: number; objsubid: number }>>`
        SELECT classid::int AS classid, objid::int AS objid, objsubid::int AS objsubid
        FROM pg_locks
        WHERE locktype = 'advisory'
          AND pid = pg_backend_pid()
          AND granted
          AND classid = ${QUEUE_LOCK_DOMAIN_KEY}::int
      `;

      assert.equal(locks.length, 1);
      assert.equal(locks[0]!.classid, QUEUE_LOCK_DOMAIN_KEY);
      assert.equal(locks[0]!.objid, expected[0]!.key);
      // objsubid 2 is PostgreSQL's two-integer advisory key space; existing
      // application locks use objsubid 1 (one bigint key).
      assert.equal(locks[0]!.objsubid, 2);
    });

    const afterCommit = await prisma.$queryRaw<Array<{ count: number }>>`
      SELECT count(*)::int AS count
      FROM pg_locks
      WHERE locktype = 'advisory'
        AND granted
        AND classid = ${QUEUE_LOCK_DOMAIN_KEY}::int
        AND objid = (SELECT hashtext(${identity})::int)
        AND objsubid = 2
    `;
    assert.equal(afterCommit[0]!.count, 0);
  },
);
