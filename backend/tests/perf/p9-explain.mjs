/**
 * Phase 9 query-plan harness.
 *
 * Run from backend/ against the disposable synthetic database:
 *   node tests/perf/p9-explain.mjs clinic_p9_test
 *
 * Proposed-index drill (clinic_p9_drill only; indexes are dropped in finally):
 *   node tests/perf/p9-explain.mjs clinic_p9_drill --with-proposed-indexes
 *
 * No application code, schema, migrations, indexes or configuration are changed.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';

const dbName = process.argv[2] ?? 'clinic_p9_test';
assert.match(dbName, /^clinic_p9_(test|drill)$/, 'P9 EXPLAIN only accepts _test/_drill databases');
const withIndexes = process.argv.includes('--with-proposed-indexes');
if (withIndexes) {
  assert.equal(dbName, 'clinic_p9_drill', 'Proposed indexes may only be tested in clinic_p9_drill');
}

const databaseUrl = process.env.DATABASE_URL ?? '';
assert.ok(
  new URL(databaseUrl).pathname.includes(`/${dbName}`),
  `DATABASE_URL must target ${dbName}`,
);

function uuid(prefix, i) {
  const h = (start, length) =>
    createHash('md5').update(`${prefix}-${i}`).digest('hex').slice(start, start + length);
  return `${h(0, 8)}-${h(8, 4)}-4${h(12, 3)}-a${h(16, 3)}-${h(18, 12)}`;
}

const P9 = {
  patient: uuid('pat', 1),
  doctor: uuid('user', 2),
  report: uuid('rep', 1),
  visit: uuid('vis', 1),
};

const queries = [
  {
    id: 'patient_search_contains_insensitive',
    note: 'patients list OR ILIKE search from patients/routes.ts lines 53-79',
    sql: `SELECT id FROM "Patient"
      WHERE "isActive" = true AND (
        "firstName" ILIKE '%P9First%' OR
        "lastName" ILIKE '%P9Last%' OR
        "patientNumber" ILIKE '%P9-P-%' OR
        "phone" LIKE '%0010%')
      ORDER BY "createdAt" DESC LIMIT 20`,
  },
  {
    id: 'patient_duplicate_equals_insensitive',
    note: 'patients duplicates lookup from patients/routes.ts lines 103-128',
    sql: `SELECT id, "patientNumber", "firstName", "lastName", "phone"
      FROM "Patient"
      WHERE "isActive" = true AND (
        "phoneNormalized" = '0100000001' OR
        ("firstName" ILIKE 'P9First1' AND "lastName" ILIKE 'P9Last1'))
      ORDER BY "createdAt" DESC LIMIT 10`,
  },
  {
    id: 'patient_ledger_charges',
    note: 'unbounded patient ledger charge read from patients/routes.ts lines 321-329',
    sql: `SELECT c.id, c."amountMinor", c.status, a."amountMinor" AS allocationMinor
      FROM "Charge" c LEFT JOIN "PaymentAllocation" a ON a."chargeId" = c.id
      WHERE c."patientId" = '${P9.patient}'
      ORDER BY c."createdAt" DESC`,
  },
  {
    id: 'patient_ledger_payments',
    note: 'unbounded patient ledger payment read from patients/routes.ts lines 330-338',
    sql: `SELECT p.id, p."amountMinor", p.status, r."amountMinor" AS refundMinor
      FROM "Payment" p LEFT JOIN "Refund" r ON r."paymentId" = p.id
      WHERE p."patientId" = '${P9.patient}'
      ORDER BY p."receivedAt" DESC`,
  },
  {
    id: 'finance_position_charges',
    note: 'all-time position charge aggregate from financial/routes.ts lines 20-29',
    sql: `SELECT COALESCE(SUM("amountMinor"), 0) AS total FROM "Charge" WHERE status <> 'VOID'`,
  },
  {
    id: 'finance_position_payments',
    note: 'all-time position payment aggregate from financial/routes.ts lines 20-29',
    sql: `SELECT COALESCE(SUM("amountMinor"), 0) AS total FROM "Payment" WHERE status = 'COMPLETED'`,
  },
  {
    id: 'finance_position_refunds',
    note: 'all-time position refund aggregate from financial/routes.ts lines 20-29',
    sql: `SELECT COALESCE(SUM("amountMinor"), 0) AS total FROM "Refund"`,
  },
  {
    id: 'finance_position_allocations',
    note: 'all-time position allocation aggregate with charge filter',
    sql: `SELECT COALESCE(SUM(a."amountMinor"), 0) AS total
      FROM "PaymentAllocation" a JOIN "Charge" c ON c.id = a."chargeId"
      WHERE c.status <> 'VOID'`,
  },
  {
    id: 'finance_monthly_payments',
    note: 'monthly finance wide-range payment read from financial/routes.ts lines 78-98',
    sql: `SELECT "amountMinor", "receivedAt", "methodKey" FROM "Payment"
      WHERE status = 'COMPLETED' AND "receivedAt" >= TIMESTAMPTZ '2022-01-01 00:00:00+00'
        AND "receivedAt" < TIMESTAMPTZ '2023-01-01 00:00:00+00'`,
  },
  {
    id: 'finance_monthly_refunds',
    note: 'monthly finance refund read; refundedAt has no standalone index',
    sql: `SELECT "amountMinor", "refundedAt" FROM "Refund"
      WHERE "refundedAt" >= TIMESTAMPTZ '2022-01-01 00:00:00+00'
        AND "refundedAt" < TIMESTAMPTZ '2023-01-01 00:00:00+00'`,
  },
  {
    id: 'report_versions_by_report',
    note: 'report version history from reports/routes.ts lines 971+',
    sql: `SELECT id, "versionNumber", content, "createdAt" FROM "ReportVersion"
      WHERE "reportId" = '${P9.report}' ORDER BY "createdAt" DESC`,
  },
  {
    id: 'measurements_by_visit_measured_at',
    note: 'measurement read ordered by measuredAt; only visitId index exists',
    sql: `SELECT id, label, value, "measuredAt" FROM "Measurement"
      WHERE "visitId" = '${P9.visit}' ORDER BY "measuredAt" DESC`,
  },
  {
    id: 'appointments_by_doctor_range',
    note: 'doctor agenda read from appointments/service.ts lines 416+',
    sql: `SELECT id, "startAt", "endAt", status FROM "Appointment"
      WHERE "doctorId" = '${P9.doctor}'
        AND "startAt" >= TIMESTAMPTZ '2022-01-01 00:00:00+00'
        AND "startAt" < TIMESTAMPTZ '2023-01-01 00:00:00+00'
      ORDER BY "startAt" ASC`,
  },
  {
    id: 'queue_by_date_doctor',
    note: 'queue list aggregate shape from queue/routes.ts lines 47-82',
    sql: `SELECT status, count(*) FROM "QueueEntry"
      WHERE "queueDate" >= DATE '2022-01-01' AND "queueDate" < DATE '2023-01-01'
        AND "doctorId" = '${P9.doctor}'
      GROUP BY status`,
  },
  {
    id: 'audit_action_contains',
    note: 'audit log search from audit/routes.ts lines 32-45',
    sql: `SELECT id, action, "createdAt" FROM "AuditLog"
      WHERE action ILIKE '%P9_ACTION_1%'
      ORDER BY "createdAt" DESC LIMIT 50`,
  },
  {
    id: 'files_by_patient_recent',
    note: 'patient file listing; only patientId index exists',
    sql: `SELECT id, "originalName", "createdAt" FROM "FileAsset"
      WHERE "patientId" = '${P9.patient}' ORDER BY "createdAt" DESC LIMIT 50`,
  },
];

const proposedIndexes = [
  `CREATE INDEX IF NOT EXISTS "P9_Refund_paymentId_idx" ON "Refund"("paymentId")`,
  `CREATE INDEX IF NOT EXISTS "P9_Refund_refundedAt_idx" ON "Refund"("refundedAt")`,
  `CREATE INDEX IF NOT EXISTS "P9_Measurement_visitId_measuredAt_idx" ON "Measurement"("visitId", "measuredAt")`,
  `CREATE INDEX IF NOT EXISTS "P9_Measurement_visitId_createdAt_idx" ON "Measurement"("visitId", "createdAt")`,
  `CREATE INDEX IF NOT EXISTS "P9_Report_visitId_createdAt_idx" ON "Report"("visitId", "createdAt")`,
  `CREATE INDEX IF NOT EXISTS "P9_FileAsset_patientId_createdAt_idx" ON "FileAsset"("patientId", "createdAt")`,
];
const droppedIndexes = proposedIndexes.map((statement) =>
  statement.replace('CREATE INDEX IF NOT EXISTS', 'DROP INDEX IF EXISTS').replace(' ON "', ' ON "').replace(/ ON "[^"]+"\([^)]*\)$/, ''),
);

// Drop statements are explicit to avoid parsing the CREATE text.
const explicitDrops = [
  'DROP INDEX IF EXISTS "P9_Refund_paymentId_idx"',
  'DROP INDEX IF EXISTS "P9_Refund_refundedAt_idx"',
  'DROP INDEX IF EXISTS "P9_Measurement_visitId_measuredAt_idx"',
  'DROP INDEX IF EXISTS "P9_Measurement_visitId_createdAt_idx"',
  'DROP INDEX IF EXISTS "P9_Report_visitId_createdAt_idx"',
  'DROP INDEX IF EXISTS "P9_FileAsset_patientId_createdAt_idx"',
];
void droppedIndexes;

function summarizePlan(planRoot, rawRow) {
  let seqScans = 0;
  let sorts = 0;
  let nestedLoops = 0;
  let indexScans = 0;
  let bitmapHeapScans = 0;
  let rowsRemovedByFilter = 0;
  let sharedHitBlocks = 0;
  let sharedReadBlocks = 0;

  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    const type = String(node['Node Type'] ?? '');
    if (type === 'Seq Scan') seqScans += 1;
    if (type === 'Sort') sorts += 1;
    if (type === 'Nested Loop') nestedLoops += 1;
    if (type.includes('Index Scan') || type === 'Index Only Scan') indexScans += 1;
    if (type === 'Bitmap Heap Scan') bitmapHeapScans += 1;
    rowsRemovedByFilter += Number(node['Rows Removed by Filter'] ?? 0);
    sharedHitBlocks += Number(node['Shared Hit Blocks'] ?? 0);
    sharedReadBlocks += Number(node['Shared Read Blocks'] ?? 0);
    for (const child of node.Plans ?? []) visit(child);
  };
  visit(planRoot);

  return {
    planningTimeMs: Number(rawRow['Planning Time'] ?? 0),
    executionTimeMs: Number(rawRow['Execution Time'] ?? 0),
    rootActualRows: Number(planRoot?.['Actual Rows'] ?? 0),
    rootActualLoops: Number(planRoot?.['Actual Loops'] ?? 0),
    seqScans,
    sorts,
    nestedLoops,
    indexScans,
    bitmapHeapScans,
    rowsRemovedByFilter,
    sharedHitBlocks,
    sharedReadBlocks,
  };
}

const prisma = new PrismaClient({ log: [] });
const out = {
  tool: 'p9-explain',
  database: dbName,
  seed: 9112026,
  withProposedIndexes: withIndexes,
  startedAt: new Date().toISOString(),
  queries: [],
};

async function main() {
  if (withIndexes) {
    for (const statement of proposedIndexes) await prisma.$executeRawUnsafe(statement);
  }

  for (const query of queries) {
    const started = performance.now();
    const rows = await prisma.$queryRawUnsafe(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.sql}`,
    );
    const rawRow = rows[0] ?? {};
    const wrapped = rawRow['QUERY PLAN'] ?? rawRow.Plan ?? rawRow;
    const timingRow = Array.isArray(wrapped) ? (wrapped[0] ?? {}) : wrapped;
    const planRoot = timingRow.Plan ?? wrapped.Plan ?? null;
    const summary = summarizePlan(planRoot, timingRow);
    out.queries.push({
      id: query.id,
      note: query.note,
      sql: query.sql,
      wallMs: Math.round(performance.now() - started),
      summary,
      plan: planRoot,
    });
    process.stdout.write(
      `[p9-explain] ${query.id}: exec=${summary.executionTimeMs.toFixed(2)}ms ` +
        `rows=${summary.rootActualRows} seq=${summary.seqScans} sorts=${summary.sorts} ` +
        `hit=${summary.sharedHitBlocks} read=${summary.sharedReadBlocks}\n`,
    );
  }

  out.finishedAt = new Date().toISOString();
  const target =
    process.env.P9_OUT ??
    `C:/Users/Moustafa/AppData/Local/Temp/opencode/p9/out/explain${withIndexes ? '-drill-indexes' : ''}.json`;
  writeFileSync(target, JSON.stringify(out, null, 2));
  process.stdout.write(`[p9-explain] WROTE ${target}\n`);
}

main()
  .catch((error) => {
    process.stderr.write(`[p9-explain] FAILED: ${error.stack ?? error}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (withIndexes) {
      for (const statement of explicitDrops) {
        await prisma.$executeRawUnsafe(statement).catch(() => undefined);
      }
      process.stdout.write('[p9-explain] dropped transient P9_* indexes from clinic_p9_drill\n');
    }
    await prisma.$disconnect();
  });
