/**
 * Phase 9 deterministic synthetic dataset seed.
 *
 * Run from backend/:
 *   node tests/perf/p9-seed.mjs [clinic_p9_test|clinic_p9_drill]
 *
 * Only writes to a disposable database whose name ends in _test or _drill.
 * All patient/marker strings start with "P9-". Fixed hash seed P9_SEED below
 * makes every run byte-identical (no Math.random, no clock dependence except
 * createdAt spreads derived from fixed epochs).
 *
 * No new dependencies: Prisma Client is already a backend dependency.
 */

import assert from 'node:assert/strict';
import { scryptSync } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { writeFileSync } from 'node:fs';

const P9_SEED = 9112026;
const dbName = process.argv[2] ?? 'clinic_p9_test';
assert.match(dbName, /_test$|_drill$/, 'P9 seed only accepts _test/_drill databases');

const url = process.env.DATABASE_URL ?? '';
assert.ok(url.includes(`/${dbName}?`) || url.includes(`/${dbName}`), `DATABASE_URL must target ${dbName}`);

const prisma = new PrismaClient({ log: [] });
const out = {
  seed: P9_SEED,
  database: dbName,
  startedAt: new Date().toISOString(),
  counts: {},
  timingsMs: {},
};

function sql(text) {
  return prisma.$executeRawUnsafe(text);
}

async function timed(name, text) {
  const t0 = performance.now();
  const affected = await sql(text);
  out.timingsMs[name] = Math.round(performance.now() - t0);
  out.counts[name] = affected;
  process.stdout.write(`[p9-seed] ${name}: ${affected} rows in ${out.timingsMs[name]} ms\n`);
}

// Replicate backend/src/lib/password.ts hashPassword with a FIXED salt so the
// dataset is deterministic but still accepts the real verifyPassword().
function fixedPasswordHash(password, saltHex) {
  const salt = Buffer.from(saltHex, 'hex');
  const hash = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
  return ['scrypt', 16384, 8, 1, salt.toString('base64'), hash.toString('base64')].join('$');
}

const ADMIN_PERMS = [
  'PATIENTS_READ', 'PATIENTS_WRITE', 'APPOINTMENTS_READ', 'APPOINTMENTS_WRITE',
  'APPOINTMENTS_OVERRIDE', 'QUEUE_READ', 'QUEUE_WRITE', 'PAYMENTS_READ',
  'PAYMENTS_WRITE', 'REFUNDS_WRITE', 'EXPENSES_READ', 'EXPENSES_WRITE',
  'FINANCE_READ', 'FINANCE_EXPORT', 'USERS_MANAGE', 'SETTINGS_MANAGE',
  'AUDIT_READ', 'VISITS_OVERRIDE',
];
const DOCTOR_PERMS = [
  'PATIENTS_READ', 'APPOINTMENTS_READ', 'QUEUE_READ', 'CLINICAL_READ',
  'CLINICAL_WRITE', 'REPORTS_FINALIZE', 'REPORTS_SEND',
];
const RECEPTION_PERMS = [
  'PATIENTS_READ', 'PATIENTS_WRITE', 'APPOINTMENTS_READ', 'APPOINTMENTS_WRITE',
  'QUEUE_READ', 'QUEUE_WRITE', 'PAYMENTS_READ', 'PAYMENTS_WRITE',
];

function pgArray(values) {
  return `'{${values.join(',')}}'`;
}
function lit(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}
const uuid = (prefix, i) => `p9_uuid(${lit(prefix)}, ${i}::bigint)`;

async function main() {
  // Refuse to seed a database that already has application tables.
  const existing = await prisma.$queryRawUnsafe(`SELECT count(*)::bigint::text AS n FROM "Patient"`);
  assert.equal(Number(existing[0].n), 0, 'Target database already has patients; refusing to overwrite');

  await sql(`CREATE EXTENSION IF NOT EXISTS btree_gist`);
  await sql(`
    CREATE OR REPLACE FUNCTION p9_rand(p_i bigint, p_salt text) RETURNS numeric
    LANGUAGE sql IMMUTABLE AS $fn$
      SELECT (hashtextextended('P9|' || p_i::text || '|' || p_salt, ${P9_SEED})::numeric
              + 9223372036854775808::numeric) / 18446744073709551616::numeric
    $fn$
  `);
  await sql(`
    CREATE OR REPLACE FUNCTION p9_uuid(p_prefix text, p_i bigint) RETURNS uuid
    LANGUAGE sql IMMUTABLE AS $fn$
      SELECT (substr(md5(p_prefix||'-'||p_i),1,8)||'-'||
              substr(md5(p_prefix||'-'||p_i),9,4)||'-4'||
              substr(md5(p_prefix||'-'||p_i),13,3)||'-a'||
              substr(md5(p_prefix||'-'||p_i),17,3)||'-'||
              substr(md5(p_prefix||'-'||p_i),19,12))::uuid
    $fn$
  `);

  const password = 'P9-Synthetic-Pass!';
  const hashes = {
    admin: fixedPasswordHash(password, '0102030405060708090a0b0c0d0e0f10'),
    doctor1: fixedPasswordHash(password, '1112131415161718191a1b1c1d1e1f20'),
    doctor2: fixedPasswordHash(password, '2122232425262728292a2b2c2d2e2f30'),
    reception: fixedPasswordHash(password, '3132333435363738393a3b3c3d3e3f40'),
  };

  await sql(`INSERT INTO "ClinicSettings"
    (id, name, timezone, currency, "defaultAppointmentMinutes", "slotIntervalMinutes", "setupCompletedAt", "updatedAt")
    VALUES (1, 'P9 Synthetic Clinic', 'Africa/Cairo', 'EGP', 15, 15,
            TIMESTAMPTZ '2018-01-01 00:00:00+00', TIMESTAMPTZ '2018-01-01 00:00:00+00')`);

  await sql(`INSERT INTO "WorkingHours"
    (id, "dayOfWeek", "isOpen", "openMinute", "closeMinute", "breakStartMinute", "breakEndMinute", "updatedAt")
    SELECT ${uuid('wh', 'd')}, d, true, 540, 1260, 720, 750,
           TIMESTAMPTZ '2018-01-01 00:00:00+00' FROM generate_series(1,7) d`);

  const users = [
    [1, 'P9Admin', 'Account', 'p9.admin@clinic.test', 'ADMIN', hashes.admin, ADMIN_PERMS],
    [2, 'P9Doctor', 'One', 'p9.doctor1@clinic.test', 'DOCTOR', hashes.doctor1, DOCTOR_PERMS],
    [3, 'P9Doctor', 'Two', 'p9.doctor2@clinic.test', 'DOCTOR', hashes.doctor2, DOCTOR_PERMS],
    [4, 'P9Reception', 'Desk', 'p9.reception@clinic.test', 'RECEPTIONIST', hashes.reception, RECEPTION_PERMS],
  ];
  for (const [i, first, last, email, role, hash, perms] of users) {
    await sql(`INSERT INTO "User" (id, email, "passwordHash", "firstName", "lastName", role, permissions, "updatedAt")
      VALUES (${uuid('user', i)}, ${lit(email)}, ${lit(hash)}, ${lit(first)}, ${lit(last)}, ${lit(role)},
              ${pgArray(perms)}::text[], TIMESTAMPTZ '2018-01-01 00:00:00+00')`);
  }

  const fixedUpdated = `TIMESTAMPTZ '2018-01-01 00:00:00+00'`;
  await sql(`INSERT INTO "Service" (id,name,"durationMinutes","priceMinor","updatedAt") VALUES
    (${uuid('svc',1)},'P9 Ultrasound',15,5000,${fixedUpdated}),
    (${uuid('svc',2)},'P9 OB/GYN',30,8000,${fixedUpdated}),
    (${uuid('svc',3)},'P9 Doppler',20,6500,${fixedUpdated}),
    (${uuid('svc',4)},'P9 Consultation',20,3000,${fixedUpdated})`);
  await sql(`INSERT INTO "PaymentMethod" (id,key,label,"sortOrder","updatedAt") VALUES
    (${uuid('pm',1)},'CASH','P9 Cash',0,${fixedUpdated}),
    (${uuid('pm',2)},'CARD','P9 Card',1,${fixedUpdated}),
    (${uuid('pm',3)},'BANK','P9 Bank Transfer',2,${fixedUpdated})`);
  await sql(`INSERT INTO "ExpenseCategory" (id,name,"updatedAt") VALUES
    (${uuid('ec',1)},'P9 Utilities',${fixedUpdated}),(${uuid('ec',2)},'P9 Supplies',${fixedUpdated})`);

  const admin = uuid('user', 1);
  const doctorOf = (i) => `CASE WHEN ${i} % 2 = 0 THEN ${uuid('user', 2)} ELSE ${uuid('user', 3)} END`;

  const serviceOf = (i) => `p9_uuid('svc', ((${i} % 4) + 1)::bigint)`;
  const startOf = (i) => `TIMESTAMPTZ '2018-01-02 08:00:00+00' + (${i}::bigint * interval '70 minutes')`;

  await timed('Expense', `INSERT INTO "Expense"
    (id,"expenseDate","amountMinor","categoryId",description,"methodKey",reference,"idempotencyKey",status,"recordedById","createdAt","updatedAt")
    SELECT ${uuid('exp','i')}, (${startOf('i')})::date, 1000 + (i%50)*100,
      CASE WHEN i%2=0 THEN ${uuid('ec',1)} ELSE ${uuid('ec',2)} END,
      'P9 expense '||i, CASE WHEN i%3=0 THEN 'CARD' ELSE 'CASH' END,
      'P9-EXP-REF-'||i, 'P9-EXPENSE-'||lpad(i::text,6,'0'), 'RECORDED',
      ${admin}, ${startOf('i')}, ${startOf('i')}
    FROM generate_series(1,20000) i`);

  await timed('Patient', `INSERT INTO "Patient"
    (id,"patientNumber","firstName","lastName",phone,"phoneNormalized",gender,"createdById","createdAt","updatedAt")
    SELECT ${uuid('pat','i')}, 'P9-P-'||lpad(i::text,6,'0'),
      'P9First'||(i%500)::text, 'P9Last'||(i%1000)::text,
      '01'||lpad((10000000+(i%89999999))::text,8,'0'),
      '01'||lpad((10000000+(i%89999999))::text,8,'0'),
      CASE WHEN i%2=0 THEN 'FEMALE' ELSE 'MALE' END,
      ${admin},
      TIMESTAMPTZ '2018-01-01 00:00:00+00' + (p9_rand(i,'ptime')*interval '2900 days'),
      TIMESTAMPTZ '2018-01-01 00:00:00+00' + (p9_rand(i,'ptime')*interval '2900 days')
    FROM generate_series(1,20000) i`);

  await timed('Appointment', `INSERT INTO "Appointment"
    (id,"patientId","doctorId","serviceId","startAt","endAt","durationMinutes",status,reason,"createdById","createdAt","updatedAt")
    SELECT ${uuid('apt','i')}, ${uuid('pat', '(i%20000)+1')}, ${doctorOf('i')}, ${serviceOf('i')},
      ${startOf('i')}, ${startOf('i')} + ((15 + 15*((i%3)::int)) * interval '1 minute'),
      15 + 15*(i%3), 'DONE', 'P9 synthetic appointment', ${admin}, ${startOf('i')} - interval '30 days', ${startOf('i')} - interval '30 days'
    FROM generate_series(1,60000) i`);

  await timed('QueueEntry', `INSERT INTO "QueueEntry"
    (id,"appointmentId","patientId","doctorId","queueDate",status,position,"arrivedAt","calledAt","examEndedAt","createdById","createdAt","updatedAt")
    SELECT ${uuid('qe','i')}, ${uuid('apt','i')}, ${uuid('pat','(i%20000)+1')}, ${doctorOf('i')},
      (${startOf('i')})::date, 'DONE'::"QueueStatus", ((i-1)%40)+1,
      ${startOf('i')} - interval '5 minutes', ${startOf('i')},
      ${startOf('i')} + interval '20 minutes', ${admin}, ${startOf('i')}, ${startOf('i')}
    FROM generate_series(1,30000) i`);

  await timed('Charge', `INSERT INTO "Charge"
    (id,"patientId","appointmentId","serviceId",description,"amountMinor",status,"voidReason","voidedAt","createdById","createdAt","updatedAt")
    SELECT ${uuid('chg','i')}, ${uuid('pat', '(i%20000)+1')}, ${uuid('apt','i')}, ${serviceOf('i')},
      'P9 charge '||i, 5000 + (i%10)*1500,
      CASE WHEN i%50=0 THEN 'VOID' WHEN i%5=0 THEN 'OPEN' ELSE 'SETTLED' END,
      CASE WHEN i%50=0 THEN 'P9 synthetic void' ELSE NULL END,
      CASE WHEN i%50=0 THEN ${startOf('i')} + interval '1 day' ELSE NULL END,
      ${admin}, ${startOf('i')}, ${startOf('i')}
    FROM generate_series(1,60000) i`);

  await timed('Payment', `INSERT INTO "Payment"
    (id,"patientId","methodKey","amountMinor","idempotencyKey","receivedById","receivedAt","status","voidedAt","voidReason")
    SELECT ${uuid('pay','i')}, ${uuid('pat', '(i%20000)+1')}, 'CASH', 5000 + (i%10)*1500,
      'P9-IDEM-'||lpad(i::text,6,'0'), ${admin}, ${startOf('i')} + interval '5 minutes',
      (CASE WHEN i%100=0 THEN 'VOIDED' ELSE 'COMPLETED' END)::"PaymentStatus",
      CASE WHEN i%100=0 THEN ${startOf('i')} + interval '2 days' ELSE NULL END,
      CASE WHEN i%100=0 THEN 'P9 synthetic payment void' ELSE NULL END
    FROM generate_series(1,60000) i`);

  await timed('PaymentAllocation', `INSERT INTO "PaymentAllocation" (id,"paymentId","chargeId","amountMinor")
    SELECT ${uuid('pa','i')}, ${uuid('pay','i')}, ${uuid('chg','i')}, 5000 + (i%10)*1500
    FROM generate_series(1,60000) i WHERE i%5<>0 AND i%50<>0`);

  await timed('Refund', `INSERT INTO "Refund" (id,"paymentId","patientId","amountMinor",reason,"refundedById","refundedAt")
    SELECT ${uuid('rf','i')}, ${uuid('pay','i')}, ${uuid('pat', '(i%20000)+1')},
      (5000 + (i%10)*1500)/10, 'P9 synthetic partial refund', ${admin}, ${startOf('i')} + interval '10 days'
    FROM generate_series(1,60000) i WHERE i%10=0 AND i%100<>0`);

  await timed('Visit', `INSERT INTO "Visit"
    (id,"patientId","doctorId","appointmentId","visitDate",status,"chiefComplaint","examinationType","updatedAt")
    SELECT ${uuid('vis','i')}, ${uuid('pat', '((i*2-1)%20000)+1')}, ${doctorOf('i*2')}, ${uuid('apt','i*2')},
      ${startOf('i*2')}, 'COMPLETED', 'P9 synthetic complaint', 'P9 ultrasound', ${startOf('i*2')}
    FROM generate_series(1,30000) i`);

  await timed('Measurement', `INSERT INTO "Measurement"
    (id,"visitId","doctorId",label,value,unit,"measuredAt","createdAt")
    SELECT ${uuid('ms','i')}, ${uuid('vis','((i-1)%30000)+1')}, ${doctorOf('i')},
      'P9 Measurement '||(i%12), 'P9 value '||(i%97), 'mm',
      (TIMESTAMPTZ '2018-01-02 08:00:00+00' + ((((i-1)%30000)+1)::bigint * interval '70 minutes') + ((i%6)::bigint * interval '5 minutes')),
      (TIMESTAMPTZ '2018-01-02 08:00:00+00' + ((((i-1)%30000)+1)::bigint * interval '70 minutes') + ((i%6)::bigint * interval '5 minutes'))
    FROM generate_series(1,60000) i`);

  await timed('Report', `INSERT INTO "Report"
    (id,"visitId","doctorId",status,"versionNumber","currentContent","finalizedAt","createdAt","updatedAt")
    SELECT ${uuid('rep','i')}, ${uuid('vis','i')}, ${doctorOf('i*2')},
      (CASE WHEN i%5=0 THEN 'DRAFT' WHEN i%7=0 THEN 'AMENDED' ELSE 'FINALIZED' END)::"ReportStatus",
      1 + (i%3),
      jsonb_build_object('findings','P9 findings '||i,'impression','P9 impression '||i,'marker','P9-REPORT'),
      CASE WHEN i%5=0 THEN NULL ELSE ${startOf('i*2')} + interval '1 hour' END,
      ${startOf('i*2')} + interval '30 minutes', ${startOf('i*2')} + interval '30 minutes'
    FROM generate_series(1,30000) i`);

  await timed('ReportVersion', `INSERT INTO "ReportVersion"
    (id,"reportId","versionNumber",content,"isFinal","authorId",reason,"createdAt")
    SELECT ${uuid('rv','i*10+j')}, ${uuid('rep','i')}, j,
      jsonb_build_object('findings','P9 findings '||i||' v'||j,'impression','P9 impression '||i||' v'||j),
      (j = 1 + (i%3) AND i%5<>0),
      ${doctorOf('i*2')},
      CASE WHEN j>1 THEN 'P9 synthetic amendment' ELSE NULL END,
      ${startOf('i*2')} + (j * interval '20 minutes')
    FROM generate_series(1,30000) i CROSS JOIN generate_series(1,3) j
    WHERE j <= 1 + (i%3)`);

  await timed('FileAsset', `INSERT INTO "FileAsset"
    (id,"patientId","uploadedById","originalName","storedName","mimeType","sizeBytes",kind,"createdAt")
    SELECT ${uuid('fa','i')}, ${uuid('pat','(i%20000)+1')}, ${admin},
      'P9-file-'||i||'.jpg', 'P9-store-'||lpad(i::text,8,'0')||'.jpg', 'image/jpeg',
      1024 + (i%100000), 'CLINICAL',
      TIMESTAMPTZ '2018-01-01 00:00:00+00' + (p9_rand(i,'fatime')*interval '2900 days')
    FROM generate_series(1,100000) i`);

  await timed('AuditLog', `INSERT INTO "AuditLog"
    (id,"actorId",action,"entityType","entityId","patientId",ip,"createdAt")
    SELECT ${uuid('al','i')}, ${admin}, 'P9_ACTION_'||(i%20), 'P9_ENTITY_'||(i%8),
      'P9-REF-'||i, ${uuid('pat','(i%20000)+1')}, '127.0.0.1',
      TIMESTAMPTZ '2018-01-01 00:00:00+00' + (p9_rand(i,'altime')*interval '2900 days')
    FROM generate_series(1,200000) i`);

  const tableCounts = await prisma.$queryRawUnsafe(`
    SELECT 'Patient' t, count(*)::bigint::text n FROM "Patient"
    UNION ALL SELECT 'Appointment', count(*)::text FROM "Appointment"
    UNION ALL SELECT 'QueueEntry', count(*)::text FROM "QueueEntry"
    UNION ALL SELECT 'Expense', count(*)::text FROM "Expense"
    UNION ALL SELECT 'Charge', count(*)::text FROM "Charge"
    UNION ALL SELECT 'Payment', count(*)::text FROM "Payment"
    UNION ALL SELECT 'PaymentAllocation', count(*)::text FROM "PaymentAllocation"
    UNION ALL SELECT 'Refund', count(*)::text FROM "Refund"
    UNION ALL SELECT 'Visit', count(*)::text FROM "Visit"
    UNION ALL SELECT 'Measurement', count(*)::text FROM "Measurement"
    UNION ALL SELECT 'Report', count(*)::text FROM "Report"
    UNION ALL SELECT 'ReportVersion', count(*)::text FROM "ReportVersion"
    UNION ALL SELECT 'FileAsset', count(*)::text FROM "FileAsset"
    UNION ALL SELECT 'AuditLog', count(*)::text FROM "AuditLog"
    ORDER BY 1`);
  out.tableCounts = Object.fromEntries(tableCounts.map((r) => [r.t, Number(r.n)]));
  out.finishedAt = new Date().toISOString();

  const target = process.env.P9_OUT ?? 'C:/Users/Moustafa/AppData/Local/Temp/opencode/p9/out/seed.json';
  writeFileSync(target, JSON.stringify(out, null, 2));
  process.stdout.write(`[p9-seed] WROTE ${target}\n`);
}

main()
  .catch((error) => {
    process.stderr.write(`[p9-seed] FAILED: ${error.stack ?? error}\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
