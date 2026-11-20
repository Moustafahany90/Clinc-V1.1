# Production Readiness — Phase M: Database Integrity Constraints (2026-11-21)

## 1. Scope and verdict

**Verdict: ready for owner review; no production change has been made.**

Phase M adds one reviewed, backward-compatible Prisma migration,
`backend/prisma/migrations/20261120222405_db_integrity_constraints`, which
introduces **38 CHECK constraints** and no other DDL. It closes the
string-status/ranges portion of Baseline item **M3** at the database layer
without changing business behavior.

Work was performed only on local branch `feature/db-constraints`, created from
`main` at `69c5c6d5b5ff7121558f23888c85e335f1f3a2d9`. Nothing was pushed, no PR
was opened, and nothing was deployed. No existing migration, schema model, CI
file, script or template was edited.

---

## 2. Design decisions

- **CHECK-in-list, not native PostgreSQL enums.** Every affected column remains
  `TEXT`, so the allowed set can be evolved with a small future migration. A
  native enum would require `ALTER TYPE` and keeps Prisma enum drift in the
  loop for no benefit here. Genuine Prisma enums (`AppointmentStatus`,
  `QueueStatus`, `VisitStatus`, `ReportStatus`, `PaymentStatus`,
  `ReportDeliveryStatus`, etc.) are already DB-enforced and were left alone.
- **No duplication.** `20261026085618_init` already enforces
  `amountMinor > 0` on `Charge`, `Payment`, `Refund`, `Expense` and
  `PaymentAllocation`, plus `appointment_no_doctor_overlap`. Those were not
  re-added.
- **`ADD CONSTRAINT ... NOT VALID` followed by `VALIDATE CONSTRAINT` in the same
  transaction.** Existing rows are checked; if any row offends, the transaction
  rolls back and no partial constraint is left behind. This was drill-tested
  (§6).
- **The only application change** is a validation mirror in the setup wizard
  (§7), required because the new CHECK exposed a 500-producing gap on that
  path.

---

## 3. Constraint inventory and risk classification

### 3.1 String status / kind allow-lists (7)

| Constraint | Rule | Risk / justification |
|---|---|---|
| `Charge_status_allowed` | `OPEN, SETTLED, VOID` | All writers use these exactly. |
| `Expense_status_allowed` | `RECORDED, VOID` | Status is never client-settable. |
| `ReportUpdateRequest_status_allowed` | `OPEN, RESOLVED` | No application writer exists; these are the schema default and the `resolvedAt` lifecycle. A future writer must be reviewed. |
| `FileAsset_kind_allowed` | `CLINICAL` | The only writer hard-codes `CLINICAL`. |
| `Charge_void_fields_consistent` | void fields present iff status `VOID` | Void route sets both fields together. |
| `Expense_void_fields_consistent` | void fields present iff status `VOID` | Void route sets both fields together. |
| `ReportUpdateRequest_resolved_fields_consistent` | `resolvedAt` only with status `RESOLVED` | Matches the intended lifecycle; no writer today. |

### 3.2 Numeric and simple ordering checks (17)

| Constraint | Rule | Risk / justification |
|---|---|---|
| `Service_price_nonnegative` | `priceMinor >= 0` | **Zero is legal** (free services); negative is not. |
| `Service_duration_positive` | `durationMinutes > 0` | Zod already requires 5..240. Also blocks a derived zero-length appointment. |
| `ClinicSettings_appointment_minutes_positive`, `ClinicSettings_slot_interval_positive` | `> 0` | Zod requires 5..120 / 5..60. |
| `FileAsset_size_positive` | `sizeBytes > 0` | Sniffing requires at least 12 bytes. |
| `Appointment_duration_positive`, `Appointment_end_after_start` | duration `> 0`, `endAt > startAt` | Create path already rejects `endAt <= startAt`; reschedule derives duration from a positive service. |
| `Report_version_positive`, `ReportVersion_version_positive`, `ReportDelivery_version_positive` | `versionNumber > 0` | All writers start at 1. |
| `ReportDelivery_attempts_positive` | `attempts >= 1` | Every writer sets 1 or increments; the schema default 0 is never persisted. |
| `QueueEntry_position_positive`, `QueueEntry_timestamp_order` | position `NULL` or `> 0`; timestamp chain ordered | Position is assigned from a count + 1; queue sync leaves it `NULL`. |
| `User_failed_login_count_nonnegative`, `User_token_version_nonnegative` | `>= 0` | Defaults 0, increments/resets only. |
| `Sequence_value_nonnegative`, `PaymentMethod_sort_order_nonnegative` | `>= 0` | Sequence starts at 1; sort order defaults 0. |

### 3.3 Time-window / cross-column checks (14)

| Constraint | Rule | Risk / justification |
|---|---|---|
| `WorkingHours_day_of_week_range` | 1..7 | Matches Zod. |
| `WorkingHours_open_minute_range`, `WorkingHours_close_minute_range` | 0..1439 / 1..**1440** | 1440 (midnight) is explicitly allowed by Zod. |
| `WorkingHours_break_start_range`, `WorkingHours_break_end_range` | nullable; 0..1439 / 1..**1440** | Same boundary. |
| `WorkingHours_open_before_close` | only when `isOpen` | Closed days keep stored minutes; rule is conditional to avoid rejecting history. |
| `WorkingHours_break_order_and_window` | break inside window when both bounds present | Mirrors the settings route. |
| `DoctorAvailability_day_of_week_range`, `DoctorAvailability_open_minute_range`, `DoctorAvailability_close_minute_range` | same ranges | Mirror the settings route. |
| `DoctorAvailability_open_before_close` | only when `isWorking` | Conditional for the same reason. |
| `ScheduleException_open_minute_range`, `ScheduleException_close_minute_range` | nullable ranges | One-sided windows are legal on closed exceptions. |
| `ScheduleException_open_before_close` | only when both endpoints present | Mirrors the settings route. |

### 3.4 Deliberately **not** expressible as CHECK constraints

These remain application invariants enforced under advisory locks and covered
by `phase3-financial-workflow.test.ts` / `phase3-concurrency.test.ts`:

- sum of allocations for a payment `<= payment.amountMinor`;
- sum of allocations for a charge `<= charge.amountMinor`;
- sum of refunds for a payment `<= payment.amountMinor`.

A CHECK sees only one row; none of these can be encoded without triggers or
materialised state, which would be a larger behavioral change than Phase M
permits.

---

## 4. Migration and rollback mechanics

- Migration: `backend/prisma/migrations/20261120222405_db_integrity_constraints/migration.sql`
  — 38 `ADD CONSTRAINT ... NOT VALID` statements followed by 38
  `VALIDATE CONSTRAINT` statements. Verified counts: adds=38, validates=38.
- Rollback: `backend/prisma/migrations/20261120222405_db_integrity_constraints/rollback.sql`
  — 38 matching `DROP CONSTRAINT IF EXISTS` statements; existing constraints
  and all data are untouched. Verified count: drops=38.
- No existing migration was edited. `migration_lock.toml` was restored byte-for-byte
  to its `main` content after Prisma rewrote line endings.
- Both SQL files were checked for encoding: no NUL bytes, no UTF-8 BOM.

**Rollback bookkeeping (verified on a disposable DB):**

- If deploy **failed**, Prisma leaves the migration in a failed state and
  `npx prisma migrate resolve --rolled-back 20261120222405_db_integrity_constraints`
  is valid.
- If the migration **succeeded** and you are undoing it deliberately, that
  command is rejected with **P3012**. Remove only this migration's bookkeeping
  row instead, then redeploy:

```sql
DELETE FROM "_prisma_migrations"
WHERE migration_name = '20261120222405_db_integrity_constraints';
```

---

## 5. Pre-deployment check queries

Run against the target database **before** deployment. Every `bad` count must be
`0`. These mirror the CHECKs; they are read-only.

```sql
-- 1. Statuses, kinds and void-field pairing
SELECT 'Charge_status_allowed' AS check_name, count(*)::bigint AS bad FROM "Charge"
  WHERE "status" NOT IN ('OPEN','SETTLED','VOID')
UNION ALL SELECT 'Expense_status_allowed', count(*) FROM "Expense"
  WHERE "status" NOT IN ('RECORDED','VOID')
UNION ALL SELECT 'ReportUpdateRequest_status_allowed', count(*) FROM "ReportUpdateRequest"
  WHERE "status" NOT IN ('OPEN','RESOLVED')
UNION ALL SELECT 'FileAsset_kind_allowed', count(*) FROM "FileAsset"
  WHERE "kind" <> 'CLINICAL'
UNION ALL SELECT 'Charge_void_fields_consistent', count(*) FROM "Charge"
  WHERE ("status" = 'VOID' AND ("voidedAt" IS NULL OR "voidReason" IS NULL))
     OR ("status" <> 'VOID' AND ("voidedAt" IS NOT NULL OR "voidReason" IS NOT NULL))
UNION ALL SELECT 'Expense_void_fields_consistent', count(*) FROM "Expense"
  WHERE ("status" = 'VOID' AND ("voidedAt" IS NULL OR "voidReason" IS NULL))
     OR ("status" <> 'VOID' AND ("voidedAt" IS NOT NULL OR "voidReason" IS NOT NULL))
UNION ALL SELECT 'ReportUpdateRequest_resolved_fields_consistent', count(*) FROM "ReportUpdateRequest"
  WHERE "resolvedAt" IS NOT NULL AND "status" <> 'RESOLVED'
ORDER BY 1;

-- 2. Numeric / ordering checks
SELECT 'Service_price_nonnegative' AS check_name, count(*)::bigint AS bad FROM "Service" WHERE "priceMinor" < 0
UNION ALL SELECT 'Service_duration_positive', count(*) FROM "Service" WHERE "durationMinutes" <= 0
UNION ALL SELECT 'ClinicSettings_appointment_minutes_positive', count(*) FROM "ClinicSettings" WHERE "defaultAppointmentMinutes" <= 0
UNION ALL SELECT 'ClinicSettings_slot_interval_positive', count(*) FROM "ClinicSettings" WHERE "slotIntervalMinutes" <= 0
UNION ALL SELECT 'FileAsset_size_positive', count(*) FROM "FileAsset" WHERE "sizeBytes" <= 0
UNION ALL SELECT 'Appointment_duration_positive', count(*) FROM "Appointment" WHERE "durationMinutes" <= 0
UNION ALL SELECT 'Appointment_end_after_start', count(*) FROM "Appointment" WHERE "endAt" <= "startAt"
UNION ALL SELECT 'Report_version_positive', count(*) FROM "Report" WHERE "versionNumber" <= 0
UNION ALL SELECT 'ReportVersion_version_positive', count(*) FROM "ReportVersion" WHERE "versionNumber" <= 0
UNION ALL SELECT 'ReportDelivery_version_positive', count(*) FROM "ReportDelivery" WHERE "versionNumber" <= 0
UNION ALL SELECT 'ReportDelivery_attempts_positive', count(*) FROM "ReportDelivery" WHERE "attempts" < 1
UNION ALL SELECT 'QueueEntry_position_positive', count(*) FROM "QueueEntry" WHERE "position" IS NOT NULL AND "position" <= 0
UNION ALL SELECT 'QueueEntry_timestamp_order', count(*) FROM "QueueEntry"
  WHERE ("arrivedAt" IS NOT NULL AND "calledAt" IS NOT NULL AND "arrivedAt" > "calledAt")
     OR ("calledAt" IS NOT NULL AND "examStartedAt" IS NOT NULL AND "calledAt" > "examStartedAt")
     OR ("examStartedAt" IS NOT NULL AND "examEndedAt" IS NOT NULL AND "examStartedAt" > "examEndedAt")
UNION ALL SELECT 'User_failed_login_count_nonnegative', count(*) FROM "User" WHERE "failedLoginCount" < 0
UNION ALL SELECT 'User_token_version_nonnegative', count(*) FROM "User" WHERE "tokenVersion" < 0
UNION ALL SELECT 'Sequence_value_nonnegative', count(*) FROM "Sequence" WHERE "value" < 0
UNION ALL SELECT 'PaymentMethod_sort_order_nonnegative', count(*) FROM "PaymentMethod" WHERE "sortOrder" < 0
ORDER BY 1;

-- 3. Time-window checks
SELECT 'WorkingHours_day_of_week_range' AS check_name, count(*)::bigint AS bad FROM "WorkingHours" WHERE "dayOfWeek" NOT BETWEEN 1 AND 7
UNION ALL SELECT 'WorkingHours_open_minute_range', count(*) FROM "WorkingHours" WHERE "openMinute" NOT BETWEEN 0 AND 1439
UNION ALL SELECT 'WorkingHours_close_minute_range', count(*) FROM "WorkingHours" WHERE "closeMinute" NOT BETWEEN 1 AND 1440
UNION ALL SELECT 'WorkingHours_break_start_range', count(*) FROM "WorkingHours" WHERE "breakStartMinute" IS NOT NULL AND "breakStartMinute" NOT BETWEEN 0 AND 1439
UNION ALL SELECT 'WorkingHours_break_end_range', count(*) FROM "WorkingHours" WHERE "breakEndMinute" IS NOT NULL AND "breakEndMinute" NOT BETWEEN 1 AND 1440
UNION ALL SELECT 'WorkingHours_open_before_close', count(*) FROM "WorkingHours" WHERE "isOpen" AND "closeMinute" <= "openMinute"
UNION ALL SELECT 'WorkingHours_break_order_and_window', count(*) FROM "WorkingHours"
  WHERE "isOpen" AND "breakStartMinute" IS NOT NULL AND "breakEndMinute" IS NOT NULL
    AND ("breakEndMinute" <= "breakStartMinute" OR "breakStartMinute" < "openMinute" OR "breakEndMinute" > "closeMinute")
UNION ALL SELECT 'DoctorAvailability_day_of_week_range', count(*) FROM "DoctorAvailability" WHERE "dayOfWeek" NOT BETWEEN 1 AND 7
UNION ALL SELECT 'DoctorAvailability_open_minute_range', count(*) FROM "DoctorAvailability" WHERE "openMinute" NOT BETWEEN 0 AND 1439
UNION ALL SELECT 'DoctorAvailability_close_minute_range', count(*) FROM "DoctorAvailability" WHERE "closeMinute" NOT BETWEEN 1 AND 1440
UNION ALL SELECT 'DoctorAvailability_open_before_close', count(*) FROM "DoctorAvailability" WHERE "isWorking" AND "closeMinute" <= "openMinute"
UNION ALL SELECT 'ScheduleException_open_minute_range', count(*) FROM "ScheduleException" WHERE "openMinute" IS NOT NULL AND "openMinute" NOT BETWEEN 0 AND 1439
UNION ALL SELECT 'ScheduleException_close_minute_range', count(*) FROM "ScheduleException" WHERE "closeMinute" IS NOT NULL AND "closeMinute" NOT BETWEEN 1 AND 1440
UNION ALL SELECT 'ScheduleException_open_before_close', count(*) FROM "ScheduleException"
  WHERE "openMinute" IS NOT NULL AND "closeMinute" IS NOT NULL AND "closeMinute" <= "openMinute"
ORDER BY 1;

-- 4. Pre-existing money checks (must also be clean)
SELECT 'Charge_amount_positive' AS check_name, count(*)::bigint AS bad FROM "Charge" WHERE "amountMinor" <= 0
UNION ALL SELECT 'Payment_amount_positive', count(*) FROM "Payment" WHERE "amountMinor" <= 0
UNION ALL SELECT 'Refund_amount_positive', count(*) FROM "Refund" WHERE "amountMinor" <= 0
UNION ALL SELECT 'Expense_amount_positive', count(*) FROM "Expense" WHERE "amountMinor" <= 0
UNION ALL SELECT 'PaymentAllocation_amount_positive', count(*) FROM "PaymentAllocation" WHERE "amountMinor" <= 0
ORDER BY 1;

-- 5. Post-deploy verification: 38 new checks present and validated
SELECT conname, convalidated
FROM pg_constraint
WHERE connamespace = 'public'::regnamespace
  AND contype = 'c'
  AND conname IN ('Charge_status_allowed','Charge_void_fields_consistent','Expense_status_allowed',
    'Expense_void_fields_consistent','ReportUpdateRequest_status_allowed',
    'ReportUpdateRequest_resolved_fields_consistent','FileAsset_kind_allowed','Service_price_nonnegative',
    'Service_duration_positive','ClinicSettings_appointment_minutes_positive',
    'ClinicSettings_slot_interval_positive','FileAsset_size_positive','Appointment_duration_positive',
    'Appointment_end_after_start','Report_version_positive','ReportVersion_version_positive',
    'ReportDelivery_version_positive','ReportDelivery_attempts_positive','QueueEntry_position_positive',
    'QueueEntry_timestamp_order','User_failed_login_count_nonnegative','User_token_version_nonnegative',
    'Sequence_value_nonnegative','PaymentMethod_sort_order_nonnegative','WorkingHours_day_of_week_range',
    'WorkingHours_open_minute_range','WorkingHours_close_minute_range','WorkingHours_break_start_range',
    'WorkingHours_break_end_range','WorkingHours_open_before_close','WorkingHours_break_order_and_window',
    'DoctorAvailability_day_of_week_range','DoctorAvailability_open_minute_range',
    'DoctorAvailability_close_minute_range','DoctorAvailability_open_before_close',
    'ScheduleException_open_minute_range','ScheduleException_close_minute_range',
    'ScheduleException_open_before_close')
ORDER BY 1;
-- Expect 38 rows, all convalidated = true.
```

---

## 6. Evidence and validation results

All disposable databases lived in container `pm-ci-postgres`
(`postgres:16.4-alpine`, host port `55436`) and ended in `_test`.

| Check | Result |
|---|---|
| Fresh DB, 7 existing migrations applied, `migrate status` up to date | pass |
| Baseline `prisma migrate diff --exit-code` (shadow `clinic_pm_shadow_test`) | empty script, exit 0 |
| Deploy with new migration on `clinic_pm_test` | 8 migrations applied, exit 0 |
| Catalog on `clinic_pm_test` | public CHECKs = 43 (38 new + 5 pre-existing), all `convalidated = true`; FKs 52, PKs 31, EXCLUDE 1 |
| Post-migration `prisma migrate diff --exit-code` | empty script, exit 0 — no Prisma drift |
| Seeded-invalid DB `clinic_pm_seed_test` (`Service.durationMinutes = 0`) | deploy failed with **P3018 / 23514**, naming `Service_duration_positive`; 0 new constraints left behind; no applied migration record |
| Rollback drill on `clinic_pm_rollback_test` | `rollback.sql` dropped all 38; `--rolled-back` returned P3012 as documented; after deleting the one bookkeeping row, `migrate deploy` re-applied cleanly and restored 43 public CHECKs |
| New `backend/tests/db-constraints.test.ts` | 8/8 pass |
| Full backend suite with `TZ=UTC` (CI env) | **164/164 pass**, 0 fail, ~69.5 s |
| Full backend suite with `TZ=Africa/Cairo` (CI env) | **164/164 pass**, 0 fail, ~68.5 s |
| `npm run typecheck`, `npm run build` | pass |
| Web tests (`npm run test:run -- --reporter=dot`) | 42/42 pass |
| Secret scan | 0 actionable; 2 allowlisted test fixtures |
| Secret scanner regression | 10/10 pass |
| Root audit / web audit | 0 vulnerabilities each |
| Backend audit wrapper | documented Prisma 6.x 4-high exception only; no unexpected findings |
| `docker compose config --quiet` base / base+monitoring | pass / pass |

GitHub Actions was **not** run; no CI pass is claimed. All results above are
local, CI-equivalent reproduction on the exact commands and env from
`.github/workflows/ci.yml`.

---

## 7. Conflicts found and how they were handled

1. **Setup wizard accepted invalid working hours** that the new CHECK rejects.
   Proof: before the app fix, an invalid setup POST returned **500** with
   `WorkingHours_open_before_close` (not 400). App fix: mirror the settings
   route's duplicate-day, open-before-close and break-containment validation in
   `backend/src/modules/setup/routes.ts` before the transaction. The test now
   asserts 400 and zero persisted rows, then a valid setup succeeds. This is
   the only application change in Phase M.
2. **Appointment reschedule** has no explicit `endAt > startAt` check, but its
   duration comes from `Service.durationMinutes` (now CHECKed positive) or a
   Zod-validated 5..240 override, so a zero/negative derived duration cannot
   reach the DB. No app fix was needed.
3. **Multi-row sum invariants** (allocations/refunds) cannot be CHECKed; left to
   application locks and documented in §3.4.
4. **Legitimate values preserved:** `Service.priceMinor = 0` (free services),
   `closeMinute/breakEndMinute = 1440`, `QUEUE` rows with `position IS NULL`,
   `ReportUpdateRequest` with no writer, and booking-payment literals
   `PENDING|DEPOSIT|PAID` (which are not DB `Payment.status` values).

---

## 8. Diff and commits

- Base: `69c5c6d5b5ff7121558f23888c85e335f1f3a2d9` (`main`)
- Implementation: `7869c7b929dcb3aba69491ac34225cf45779f59e`
  (`feat(db): add reviewed integrity CHECK migration and tests`)
- Report: committed separately on this branch after this document was written.

```
 backend/prisma/migrations/20261120222405_db_integrity_constraints/migration.sql | 221 ++++++++++++++++++++++++++++++++++++
 backend/prisma/migrations/20261120222405_db_integrity_constraints/rollback.sql  |  52 +++++++++
 backend/src/modules/setup/routes.ts                                             |  21 ++++
 backend/tests/db-constraints.test.ts                                            | 693 ++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
 docs/PRODUCTION_READINESS_PHASE_M.md                                            | 320 +++++++++++++++++++++++++++++++++++++++++++++++++++
 5 files changed, 1307 insertions(+)
```

---

## 9. Owner next steps (no action taken by this session)

1. Review the two local commits on `feature/db-constraints` and the SQL in §4–§5.
2. Run the §5 pre-deployment queries against the real database; all `bad`
   counts must be zero.
3. Take a backup, then deploy with `npx prisma migrate deploy` (never `migrate
   reset`, `db push`, or a manual edit of applied migrations).
4. Verify 38 validated constraints with query §5.5 and watch application logs
   for `23514` rejections during the first business day.
5. If rollback is needed, use the exact `rollback.sql` in this migration folder
   plus the bookkeeping step in §4. Do not push, open a PR or deploy from this
   session.

**Safety confirmation:** no commit/push/PR/deploy to `main`; no existing
migration edited; no `migrate reset`/`db push` outside disposable `pm_*`
containers and `_test`/`_drill` databases; no CI, scripts, `.gitignore`,
templates, other phases, resets, clean, rebase, force, or `git add -A`.
The disposable container `pm-ci-postgres` (databases `clinic_pm_test`,
`clinic_pm_shadow_test`, `clinic_pm_seed_test`, `clinic_pm_rollback_test`) is
removed only after the final review handoff, with its exact name printed first.
