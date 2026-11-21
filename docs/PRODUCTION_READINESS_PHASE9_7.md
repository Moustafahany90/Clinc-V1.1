# Phase 9.7 — Final Deployment Gate & Operational Runbook

**Date:** 2026-11-21  
**Branch / HEAD at assessment:** `fix/phase9-remediation` @ `a828bcf0efed9e061f9fb4fbd32d496d63c28309`  
**Scope:** Repository-only preparation and verification after Phase 9.6. No Production access or Production-affecting operation was performed.

> **Final verdict: PARTIAL.** Repository implementation and synthetic evidence are substantial, but Production-facing WAL mount, migration data validity, real TLS/DNS, scheduler/monitoring installation, image scanning, resource measurement, and RTO/RPO remain unresolved. **This document does not authorize deployment.** Separate explicit approval is required for every Production action.

---

## 1. Safety boundary and preservation

### 1.1 What was and was not done

All work was performed in the existing repository and, for validation, through local read-only checks. No Production system, credential, database, host, volume, container, patient record, backup, WAL archive, DNS zone, certificate authority, or alert sink was accessed or modified.

Explicitly not performed:

- Production login, query, backup, restore, migration, WAL cleanup, or database operation.
- Container deploy, restart, recreate, image pull, or replacement.
- Installation or enablement of systemd units, timers, cron, monitoring, or alert delivery.
- Real certificate issuance, public DNS change, or reverse-proxy configuration change.
- Dependency upgrade, lockfile change, Prisma version change, or change to the documented advisory exception.
- Commit, push, merge, branch switch, reset, rebase, or history rewrite.
- Deletion or modification of any pre-existing modified or untracked file.

### 1.2 Repository state recorded before changes

| Item | Value |
|---|---|
| Branch | `fix/phase9-remediation` (tracking `origin/fix/phase9-remediation`) |
| HEAD | `a828bcf0efed9e061f9fb4fbd32d496d63c28309` |
| Pre-existing changed tracked files | 13 (`.env.example`, `deploy/Caddyfile`, `deploy/monitor.env.example`, `docker-compose.limits.yml`, `docker-compose.monitoring.yml`, `docker-compose.tls.yml`, `docs/backup-restore.md`, `scripts/backup-common.sh`, `scripts/backup-verify.sh`, `scripts/backup.sh`, `scripts/p7-check-backup.sh`, `scripts/p7-monitor.sh`, `scripts/restore-drill.sh`) |
| Pre-existing untracked files | 27 (Phase 9.2–9.6 reports, timer and WAL templates, PITR/backup scripts) |
| Total pre-existing entries | 40 |

All 40 pre-existing entries were preserved. Files created by this phase are listed in Section 12.

---

## 2. Historical review and unresolved findings

Reports reviewed: Phase 9.2, 9.2.1, 9.2.2, 9.2.3, 9.3, 9.4, 9.5, 9.6, plus `docs/backup-restore.md`, `docs/monitoring-runbook.md`, and the dependency-remediation report.

| Report | Verdict then | Current interpretation |
|---|---|---|
| Phase 9.2 / 9.2.2 | BLOCKED (remote base, CI, p72 harness, proxy spoof risk) | Remote/CI gates later cleared in Phase 9.3; proxy spoof risk remains target-host BLOCKED. |
| Phase 9.2.3 | PASS — ready for push authorization | Historical; superseded by PR merge/CI evidence. |
| Phase 9.3 | NO-GO | Recovery, migration, topology, and advisory blockers inherited. |
| Phase 9.4 | NO-GO (synthetic-only backup PASS) | Backup scripts verified in isolation; production RTO/RPO still unmeasured. |
| Phase 9.5 | PASS (repository implementation and isolated PITR only) | Explicitly not a production-readiness claim; contains stale path/tooling text. |
| Phase 9.6 | PARTIAL | Newest phase report; nine remaining blockers carried into this register. |

Historical drift is handled in Section 11 without rewriting prior results.

---

## 3. Consolidated blocker position

Full detail, including severity, evidence, missing evidence, required action, authorization, and acceptance criteria, is in `docs/PRODUCTION_BLOCKER_REGISTER.md`.

| Status | Count | Meaning |
|---|---:|---|
| CLOSED | 2 | Repository documentation clarification and repository-invariant preflight only. |
| OPEN | 10 | Repository defects or owner decisions (including unsafe rollback guidance, Prisma acceptance, CI on final HEAD, and six scheduling/monitoring defects). |
| BLOCKED | 19 | Require authorized target-host access or approval. |
| ACCEPTED RISK | 0 | No recorded owner acceptance was available. |

**No Production blocker is CLOSED.** A repository-only PASS is never Production readiness.

---

## 4. WAL/PITR production preflight

### 4.1 Implemented behavior (repository evidence)

| Area | Implemented behavior | Evidence |
|---|---|---|
| Overlay | `docker-compose.pitr.yml` is optional and not applied by the base stack; adds no public listener. | `docker-compose.pitr.yml:1-21` |
| PostgreSQL settings | `wal_level=replica`, `archive_mode=on`, `archive_timeout=${WAL_ARCHIVE_TIMEOUT_SECONDS:-300}`, `max_wal_senders`, `wal_keep_size`. | `docker-compose.pitr.yml:24-39` |
| Archive command | `/bin/sh /clinic/deploy/wal-archive.sh %p %f`; `./deploy:/clinic/deploy:ro` mounts the helper. | `docker-compose.pitr.yml:33,50-56`; Phase 9.6 `:85,175` |
| Archiver | POSIX sh; detects real mount via `/proc/self/mountinfo`, filesystem via `/proc/self/mounts`; stages mode `0600`; writes `<segment>.sha256`; publishes with atomic hard links; refuses conflicting content; checks free space; exits non-zero so PostgreSQL retries. | `deploy/wal-archive.sh`; Phase 9.6 `:86-89,128-129` |
| UUID behavior | Fail-closed when an expected UUID is supplied; empty by default in-container because `/dev/disk/by-uuid` is not normally available. `WAL_ARCHIVE_SKIP_MOUNT_CHECK=0` in overlay. | `docker-compose.pitr.yml:44-48`; Phase 9.6 `:179` |
| Restore helper | Requires valid SHA-256 sidecar, handles PostgreSQL temporary `%p` paths, verifies size/checksum, publishes atomically into `pg_wal`, fails closed. | `deploy/wal-restore.sh`; Phase 9.5 `:92` |
| Base backup | `pg_basebackup -Fp -X stream`; manifest `pitr-base-1` records LSNs, timeline, required WAL range, per-segment SHA-256, base artifact hash/size, encryption mode; publishes only after full WAL verification. | `scripts/pitr-base-backup.sh`; Phase 9.5 `:96-106` |
| PITR restore | Validates before creating target; requires `_restore`/`_drill`/`_test` suffix and matching confirmation; refuses `5432`/`55432` and production-like paths; uses `recovery.signal`, `restore_command`, `recovery_target_action='pause'`. | `scripts/pitr-restore.sh`; Phase 9.5 `:110-112` |
| Monitoring | `p7-check-pitr.sh` checks base age, required WAL presence/sidecars, and newest-segment freshness; `pitr` is in the default check set. | `scripts/p7-check-pitr.sh`; Phase 9.6 `:100-103` |

### 4.2 Target-host preflight procedure (read-only; requires separate authorization)

Use placeholders. **Do not invent a UUID, hostname, IP, or domain.** The UUID recorded historically in `docs/backup-restore.md:82` is not reasserted as current; it must be independently verified by the owner.

| # | Check | Command pattern (read-only) | Required result |
|---:|---|---|---|
| 1 | Dedicated mount exists | `findmnt -T <WAL_MOUNT> -o TARGET,SOURCE,FSTYPE,OPTIONS` | `<WAL_MOUNT>` is its own dedicated mount, not a directory on `/` or the container data disk. |
| 2 | Filesystem UUID | `blkid -s UUID -o value <DEVICE>` | Matches `<OWNER_APPROVED_UUID>` recorded in the change record; no assumption from historical docs. |
| 3 | Filesystem type | `findmnt -no FSTYPE <WAL_MOUNT>` | Matches `<OWNER_APPROVED_FSTYPE>` (historically `ext4`); `WAL_ARCHIVE_EXPECTED_FSTYPE` set accordingly. |
| 4 | Capacity | `df -h <WAL_MOUNT>`; `df -i <WAL_MOUNT>` | Free space exceeds `WAL_ARCHIVE_MIN_FREE_MB` (default 512), `PITR_BASE_MIN_FREE_MB` (default 512), and dispatcher `SCHED_MIN_FREE_MB` (default 1024); monitor thresholds 70/85/95 % understood and owner-approved. |
| 5 | Ownership / mode | `stat -c '%U:%G %a' <WAL_MOUNT>` | Directory is `0700` and writable by the verified PostgreSQL runtime UID/GID. Phase 9.6 used `70:70` in `postgres:16-alpine`; verify the actual deployed image rather than hardcoding. |
| 6 | Container access | Authorized isolated `docker run` / `docker compose` probe as the `db` runtime user, writing only a synthetic test file to a disposable directory, then removing it. | Read/write access to the mounted directory; no Production WAL touched. |
| 7 | Archive command | Inspect running config (authorized): `SHOW archive_command; SHOW archive_mode; SHOW wal_level; SHOW archive_timeout;` | Command is exactly `/bin/sh /clinic/deploy/wal-archive.sh %p %f`; settings match the overlay. |
| 8 | Retry behavior | Force a WAL switch only in an authorized drill; inspect PostgreSQL log for non-zero archiver exit and retry. | Failure retains and retries the segment; no silent success. |
| 9 | Segments and sidecars | `sha256sum -c` against `<segment>.sha256` for sampled segments; `stat` mode. | Every archived segment has a valid sidecar; mode `0600`; no conflicting content. |
| 10 | Freshness | `scripts/p7-check-wal.sh`, `scripts/p7-check-pitr.sh` with target env | Newest segment age below 600 s warn / 1200 s high / 1800 s critical; no `unknown`. |
| 11 | Base backup age | `p7-check-pitr.sh` | Newest `pitr_ready=true` base below 72 h warn / 168 h high / 336 h critical. |
| 12 | Required WAL range | `p7-check-pitr.sh` | Every segment from `required_wal_start` to `required_wal_end` present, size-valid, checksum-valid. |
| 13 | Retention dependencies | Read retained manifests; compute floor from every `required_wal_start`. | No pruning candidate below any retained base's floor; newest segment always preserved. |
| 14 | Safe pruning | Dry run only: `backup-scheduler.sh wal-prune --dry-run` | Plan is reviewed; deletion requires separate `--apply --confirm DELETE` and PB-27 must be closed first. |

### 4.3 Checks possible locally vs only on target host

| Check | Locally | Target host only |
|---|---|---|
| Repository files, archive script path, fail-closed branches, no hardcoded UUID | Yes (`scripts/p97-readiness-preflight.sh`) | — |
| `bash -n` / `sh -n`, Compose render, Caddy validation | Yes | — |
| WAL archiver as UID 70 in `postgres:16-alpine`, checksums, sidecars, mount detection | Yes (Phase 9.6 isolated) | Re-verify with actual image and mount. |
| Mount UUID, filesystem, capacity, ownership, container bind access | No | **Yes** |
| Archive freshness, real backlog, WAL range completeness for real base | No | **Yes** |
| Pruning dry-run against retained manifests | Synthetic only | **Yes** |

### 4.4 Read-only validation scripts

- `scripts/p97-readiness-preflight.sh` (added in this phase): strictly read-only repository invariant check. It never creates, deletes, moves, modifies, mounts, starts, or queries anything; exits 1 on any failed invariant. Executed here: `RESULT PASS` (repository invariants only).
- `scripts/p7-check-pitr.sh` and `scripts/p7-check-wal.sh`: read-only target-host monitor checks. They emit JSON and do not delete WAL. Fail-closed for missing/invalid WAL and misconfiguration, with known coverage gaps recorded in blocker PB-29/PB-30.
- These scripts do **not** create, delete, move, or modify Production files. `scripts/p7-check-wal.sh` may update its worst-status rank under the authorized monitor state directory; it does not alter application, backup, or WAL data. Never set `WAL_ARCHIVE_SKIP_MOUNT_CHECK=1` or `BACKUP_*_SKIP_MOUNT_CHECK=1` on a target host.

### 4.5 Additional repository-only WAL/PITR audit clarifications

A separate repository-only audit was completed during this phase. It found no implementation defect that changes the PARTIAL verdict, but it tightened the evidence interpretation:

1. **The overlay is opt-in, not already enabled.** `docker-compose.pitr.yml` explicitly says it is repository configuration only. Applying it to Production requires a separate authorization and a controlled database restart; the base stack has no `archive_*` settings.
2. **Historical harness logs are not durable evidence.** The Phase 9.5/9.6 harnesses write disposable temporary directories and remove them on exit. Their reported timings and pass counts remain historical report claims; no persisted log was re-verified here. This reinforces PB-21 rather than closing it.
3. **The operational monitoring runbook is incomplete.** `pitr` is in the default `p7-monitor.sh` check set, but `docs/monitoring-runbook.md` has a WAL section without a PITR section. Until PB-08/PB-29 are closed, operators must run and interpret `scripts/p7-check-pitr.sh` directly and must not assume the runbook covers PITR.
4. **UUID configuration fields are distinct.** `docker-compose.pitr.yml` and `.env.example` intentionally leave `WAL_ARCHIVE_EXPECTED_UUID` empty, while `scripts/backup-common.sh` and `deploy/monitor.env.example` carry backup-disk UUIDs. Do not copy a backup-disk UUID into the WAL field; the preflight deliberately rejects a hardcoded WAL UUID.
5. **Retention verification scopes differ.** Logical retention/verification accepts only `backup_format=3|4`; PITR base sets use `backup_format=pitr-base-1` and are checked by the PITR monitor. WAL pruning reads retained PITR manifests separately. This is the gap already recorded as PB-30.
6. **Current operational text remains authoritative.** `docs/backup-restore.md` is the current reference. Older Phase 9.5 path/tooling wording and Phase 6.1 storage wording remain historical drift; see Section 11.

These clarifications do not authorize any target-host action and do not change any status in `docs/PRODUCTION_BLOCKER_REGISTER.md`.

---

## 5. Migration safety assessment

### 5.1 Inventory and risk classification

Provider is PostgreSQL (`migration_lock.toml:3`). All nine migrations are tracked and unmodified. Prisma wraps each migration in a transaction; there is no automatic compensating rollback.

| # | Migration | Schema / data change | Destructive | Locking and impact | Rollback | Risk |
|---:|---|---|---|---|---|---|
| 1 | `20261026085618_init` | 7 enums, ~30 tables, ~80 indexes, 45 FKs, GiST exclusion, 5 amount CHECKs | No (creates only) | Heavy DDL; fails on pre-existing names; needs `btree_gist` | No `rollback.sql`; transaction rollback | Medium if target not empty |
| 2 | `20261029120000_add_token_blacklist` | `TokenBlacklist` + expiry index (`IF NOT EXISTS`) | No | Brief; can silently skip a wrongly-shaped existing object | No `rollback.sql` | Low |
| 3 | `20261030120000_report_template_pinning` | 4 columns + 1 index; no backfill for snapshot/version | No | Metadata-only `NOT NULL DEFAULT false`; brief lock | No `rollback.sql` | Low |
| 4 | `20261031120000_token_version_and_override_permissions` | `User.tokenVersion DEFAULT 0`; two ADM IN permission backfills | No drop, but permanent data change | Two full `User` scans; rows with `permissions IS NULL` are skipped | No `rollback.sql`; no reverse SQL | Medium |
| 5 | `20261101120000_report_whatsapp_delivery` | 2 enums, `ReportDelivery`, 3 indexes, 3 FKs, DOCTOR `REPORTS_SEND` backfill | No drop | FK validation and `User` scan | No `rollback.sql` | Medium |
| 6 | `20261102120000_patient_referring_doctor` | **DROP `Patient.email`**; add `referringDoctor` | **Yes** | `ACCESS EXCLUSIVE` on `Patient`; instant but full block | No `rollback.sql`; data gone after commit | **Critical** |
| 7 | `20261113135000_remove_email_delivery` | **DROP 5 `ClinicSettings` email columns; DROP `EmailLog`** | **Yes** | `ACCESS EXCLUSIVE`; no `CASCADE` | No `rollback.sql`; data gone after commit | **Critical** |
| 8 | `20261120222405_db_integrity_constraints` | 38 CHECK constraints `NOT VALID`, then all validated | No DDL drop, but fails on dirty rows | `ACCESS EXCLUSIVE` on 17 tables held through 38 scans | `rollback.sql` exists; unsafe ledger guidance inside | **Critical** |
| 9 | `20261121220000_phase91_performance_indexes` | 4 plain `CREATE INDEX` on 3 tables | No | `SHARE` locks block all writes if tables populated | No committed `rollback.sql` | **Critical** if populated |

### 5.2 Migration #8 — integrity constraints

**Exact effect.** Adds 38 CHECK constraints as `NOT VALID` (lines 24–178) and validates all 38 in the same transaction (lines 184–221). Tables affected (17): `Charge`, `Expense`, `ReportUpdateRequest`, `FileAsset`, `Service`, `ClinicSettings`, `Appointment`, `Report`, `ReportVersion`, `ReportDelivery`, `QueueEntry`, `User`, `Sequence`, `PaymentMethod`, `WorkingHours`, `DoctorAvailability`, `ScheduleException`.

**How invalid rows affect validation.** Each `VALIDATE CONSTRAINT` scans existing rows. Any row where the predicate evaluates to `FALSE` raises SQLSTATE `23514` (surfaced by Prisma as `P3018`), aborting the whole transaction. `NOT VALID` postpones the check but does not waive it, because validation is in the same transaction. Phase M drill evidence (`PHASE_M.md:242`) injected `Service.durationMinutes = 0`, observed `P3018/23514`, and left no partial constraints.

**Locking.** Every `ADD CONSTRAINT ... NOT VALID` takes `ACCESS EXCLUSIVE` on its table; because Prisma uses one transaction, all 17 locks are held until commit while the 38 validation scans run. Expect a full write freeze on those tables for the migration duration.

**Read-only violation queries** (SELECT only; `(predicate) IS FALSE` mirrors PostgreSQL CHECK semantics — `NULL` passes). Zero rows means clean.

```sql
-- Status/kind and void-field checks (7)
SELECT 'Charge_status_allowed' AS constraint_name, "id"::text AS row_id FROM "Charge" WHERE ("status" IN ('OPEN','SETTLED','VOID')) IS FALSE
UNION ALL SELECT 'Charge_void_fields_consistent','id'::text FROM "Charge" WHERE (("status"='VOID' AND "voidedAt" IS NOT NULL AND "voidReason" IS NOT NULL) OR ("status"<> 'VOID' AND "voidedAt" IS NULL AND "voidReason" IS NULL)) IS FALSE
UNION ALL SELECT 'Expense_status_allowed','id'::text FROM "Expense" WHERE ("status" IN ('RECORDED','VOID')) IS FALSE
UNION ALL SELECT 'Expense_void_fields_consistent','id'::text FROM "Expense" WHERE (("status"='VOID' AND "voidedAt" IS NOT NULL AND "voidReason" IS NOT NULL) OR ("status"<> 'VOID' AND "voidedAt" IS NULL AND "voidReason" IS NULL)) IS FALSE
UNION ALL SELECT 'ReportUpdateRequest_status_allowed','id'::text FROM "ReportUpdateRequest" WHERE ("status" IN ('OPEN','RESOLVED')) IS FALSE
UNION ALL SELECT 'ReportUpdateRequest_resolved_fields_consistent','id'::text FROM "ReportUpdateRequest" WHERE ("resolvedAt" IS NULL OR "status"='RESOLVED') IS FALSE
UNION ALL SELECT 'FileAsset_kind_allowed','id'::text FROM "FileAsset" WHERE ("kind" IN ('CLINICAL')) IS FALSE;

-- Numeric/order checks (17)
SELECT 'Service_price_nonnegative' AS constraint_name,'id'::text AS row_id FROM "Service" WHERE ("priceMinor">=0) IS FALSE
UNION ALL SELECT 'Service_duration_positive','id'::text FROM "Service" WHERE ("durationMinutes">0) IS FALSE
UNION ALL SELECT 'ClinicSettings_appointment_minutes_positive','id'::text FROM "ClinicSettings" WHERE ("defaultAppointmentMinutes">0) IS FALSE
UNION ALL SELECT 'ClinicSettings_slot_interval_positive','id'::text FROM "ClinicSettings" WHERE ("slotIntervalMinutes">0) IS FALSE
UNION ALL SELECT 'FileAsset_size_positive','id'::text FROM "FileAsset" WHERE ("sizeBytes">0) IS FALSE
UNION ALL SELECT 'Appointment_duration_positive','id'::text FROM "Appointment" WHERE ("durationMinutes">0) IS FALSE
UNION ALL SELECT 'Appointment_end_after_start','id'::text FROM "Appointment" WHERE ("endAt">"startAt") IS FALSE
UNION ALL SELECT 'Report_version_positive','id'::text FROM "Report" WHERE ("versionNumber">0) IS FALSE
UNION ALL SELECT 'ReportVersion_version_positive','id'::text FROM "ReportVersion" WHERE ("versionNumber">0) IS FALSE
UNION ALL SELECT 'ReportDelivery_version_positive','id'::text FROM "ReportDelivery" WHERE ("versionNumber">0) IS FALSE
UNION ALL SELECT 'ReportDelivery_attempts_positive','id'::text FROM "ReportDelivery" WHERE ("attempts">=1) IS FALSE
UNION ALL SELECT 'QueueEntry_position_positive','id'::text FROM "QueueEntry" WHERE ("position" IS NULL OR "position">0) IS FALSE
UNION ALL SELECT 'QueueEntry_timestamp_order','id'::text FROM "QueueEntry"
  WHERE (("arrivedAt" IS NULL OR "calledAt" IS NULL OR "arrivedAt"<="calledAt")
     AND ("calledAt" IS NULL OR "examStartedAt" IS NULL OR "calledAt"<="examStartedAt")
     AND ("examStartedAt" IS NULL OR "examEndedAt" IS NULL OR "examStartedAt"<="examEndedAt")) IS FALSE
UNION ALL SELECT 'User_failed_login_count_nonnegative','id'::text FROM "User" WHERE ("failedLoginCount">=0) IS FALSE
UNION ALL SELECT 'User_token_version_nonnegative','id'::text FROM "User" WHERE ("tokenVersion">=0) IS FALSE
UNION ALL SELECT 'Sequence_value_nonnegative','name'::text FROM "Sequence" WHERE ("value">=0) IS FALSE
UNION ALL SELECT 'PaymentMethod_sort_order_nonnegative','id'::text FROM "PaymentMethod" WHERE ("sortOrder">=0) IS FALSE;

-- Time-window checks (14)
SELECT 'WorkingHours_day_of_week_range' AS constraint_name,'id'::text AS row_id FROM "WorkingHours" WHERE ("dayOfWeek" BETWEEN 1 AND 7) IS FALSE
UNION ALL SELECT 'WorkingHours_open_minute_range','id'::text FROM "WorkingHours" WHERE ("openMinute" BETWEEN 0 AND 1439) IS FALSE
UNION ALL SELECT 'WorkingHours_close_minute_range','id'::text FROM "WorkingHours" WHERE ("closeMinute" BETWEEN 1 AND 1440) IS FALSE
UNION ALL SELECT 'WorkingHours_break_start_range','id'::text FROM "WorkingHours" WHERE ("breakStartMinute" IS NULL OR "breakStartMinute" BETWEEN 0 AND 1439) IS FALSE
UNION ALL SELECT 'WorkingHours_break_end_range','id'::text FROM "WorkingHours" WHERE ("breakEndMinute" IS NULL OR "breakEndMinute" BETWEEN 1 AND 1440) IS FALSE
UNION ALL SELECT 'WorkingHours_open_before_close','id'::text FROM "WorkingHours" WHERE ("isOpen"=false OR "closeMinute">"openMinute") IS FALSE
UNION ALL SELECT 'WorkingHours_break_order_and_window','id'::text FROM "WorkingHours"
  WHERE ("isOpen"=false OR "breakStartMinute" IS NULL OR "breakEndMinute" IS NULL
      OR ("breakEndMinute">"breakStartMinute" AND "breakStartMinute">="openMinute" AND "breakEndMinute"<="closeMinute")) IS FALSE
UNION ALL SELECT 'DoctorAvailability_day_of_week_range','id'::text FROM "DoctorAvailability" WHERE ("dayOfWeek" BETWEEN 1 AND 7) IS FALSE
UNION ALL SELECT 'DoctorAvailability_open_minute_range','id'::text FROM "DoctorAvailability" WHERE ("openMinute" BETWEEN 0 AND 1439) IS FALSE
UNION ALL SELECT 'DoctorAvailability_close_minute_range','id'::text FROM "DoctorAvailability" WHERE ("closeMinute" BETWEEN 1 AND 1440) IS FALSE
UNION ALL SELECT 'DoctorAvailability_open_before_close','id'::text FROM "DoctorAvailability" WHERE ("isWorking"=false OR "closeMinute">"openMinute") IS FALSE
UNION ALL SELECT 'ScheduleException_open_minute_range','id'::text FROM "ScheduleException" WHERE ("openMinute" IS NULL OR "openMinute" BETWEEN 0 AND 1439) IS FALSE
UNION ALL SELECT 'ScheduleException_close_minute_range','id'::text FROM "ScheduleException" WHERE ("closeMinute" IS NULL OR "closeMinute" BETWEEN 1 AND 1440) IS FALSE
UNION ALL SELECT 'ScheduleException_open_before_close','id'::text FROM "ScheduleException" WHERE ("openMinute" IS NULL OR "closeMinute" IS NULL OR "closeMinute">"openMinute") IS FALSE;

-- Five baseline amount checks (from migration #1)
SELECT 'Charge_amount_positive' AS constraint_name,'id'::text AS row_id FROM "Charge" WHERE ("amountMinor">0) IS FALSE
UNION ALL SELECT 'Payment_amount_positive','id'::text FROM "Payment" WHERE ("amountMinor">0) IS FALSE
UNION ALL SELECT 'Refund_amount_positive','id'::text FROM "Refund" WHERE ("amountMinor">0) IS FALSE
UNION ALL SELECT 'Expense_amount_positive','id'::text FROM "Expense" WHERE ("amountMinor">0) IS FALSE
UNION ALL SELECT 'PaymentAllocation_amount_positive','id'::text FROM "PaymentAllocation" WHERE ("amountMinor">0) IS FALSE;

-- Post-deploy catalog verification (expect 38 new, all convalidated)
SELECT conname, convalidated FROM pg_constraint
WHERE connamespace='public'::regnamespace AND contype='c'
  AND conname LIKE '%allowed%' OR conname IN (
    'Charge_void_fields_consistent','Expense_void_fields_consistent',
    'ReportUpdateRequest_resolved_fields_consistent','Service_price_nonnegative',
    'Service_duration_positive','ClinicSettings_appointment_minutes_positive',
    'ClinicSettings_slot_interval_positive','FileAsset_size_positive',
    'Appointment_duration_positive','Appointment_end_after_start',
    'Report_version_positive','ReportVersion_version_positive',
    'ReportDelivery_version_positive','ReportDelivery_attempts_positive',
    'QueueEntry_position_positive','QueueEntry_timestamp_order',
    'User_failed_login_count_nonnegative','User_token_version_nonnegative',
    'Sequence_value_nonnegative','PaymentMethod_sort_order_nonnegative',
    'WorkingHours_day_of_week_range','WorkingHours_open_minute_range',
    'WorkingHours_close_minute_range','WorkingHours_break_start_range',
    'WorkingHours_break_end_range','WorkingHours_open_before_close',
    'WorkingHours_break_order_and_window','DoctorAvailability_day_of_week_range',
    'DoctorAvailability_open_minute_range','DoctorAvailability_close_minute_range',
    'DoctorAvailability_open_before_close','ScheduleException_open_minute_range',
    'ScheduleException_close_minute_range','ScheduleException_open_before_close')
ORDER BY 1;
```

> Note: the final catalog query's `LIKE '%allowed%'` branch is a convenience filter; use the explicit 38-name list from `docs/PRODUCTION_BLOCKER_REGISTER.md` / migration SQL for an exact audit. `prisma migrate diff --exit-code` does **not** prove CHECK constraints exist because they are not representable in `schema.prisma`.

**Failed-migration recovery and history reconciliation.**

1. If validation fails, the transaction rolls back atomically; verify in the catalog that no partial constraints remain.
2. Use `npx prisma migrate resolve --rolled-back 20261120222405_db_integrity_constraints` only after confirming DDL is absent.
3. If the DDL is present but the history row is missing/invalid, use `npx prisma migrate resolve --applied 20261120222405_db_integrity_constraints`.
4. To intentionally remove applied constraints, author a **new forward migration** with the 38 `DROP CONSTRAINT` statements.
5. **Never edit `_prisma_migrations` directly.** The `DELETE FROM "_prisma_migrations"` text in `rollback.sql:5-13` and `PHASE9_3.md:40` is unsafe historical guidance and must not be followed (blocker PB-11).

### 5.3 Migration #9 — performance indexes

Exact SQL:

```sql
CREATE INDEX "Refund_refundedAt_idx" ON "Refund"("refundedAt");
CREATE INDEX "Refund_paymentId_idx" ON "Refund"("paymentId");
CREATE INDEX "Measurement_visitId_measuredAt_idx" ON "Measurement"("visitId", "measuredAt");
CREATE INDEX "FileAsset_patientId_createdAt_idx" ON "FileAsset"("patientId", "createdAt");
```

| Table | Index |
|---|---|
| `Refund` | `Refund_refundedAt_idx`, `Refund_paymentId_idx` |
| `Measurement` | `Measurement_visitId_measuredAt_idx` |
| `FileAsset` | `FileAsset_patientId_createdAt_idx` |

**Plain `CREATE INDEX` locking:** takes `SHARE`, which allows `SELECT` but conflicts with `ROW EXCLUSIVE` (all `INSERT`/`UPDATE`/`DELETE`/`COPY`). Prisma's transaction extends the block to commit.

**`CREATE INDEX CONCURRENTLY`:** takes `SHARE UPDATE EXCLUSIVE` twice and permits writes, but is slower, can leave an `INVALID` index on failure, and **cannot run inside a transaction block**. Prisma Migrate wraps PostgreSQL migrations in a transaction, so simply adding `CONCURRENTLY` would break `prisma migrate deploy`. Do not change the migration automatically. Any alternative requires owner approval, staging rehearsal on production-shaped data, and a documented history-management procedure.

Required read-only preflight:

```sql
SELECT relname, n_live_tup, pg_size_pretty(pg_total_relation_size(relid)) AS total_size
FROM pg_stat_user_tables WHERE relname IN ('Refund','Measurement','FileAsset');

SELECT indexname, tablename, indexdef FROM pg_indexes
WHERE schemaname='public' AND indexname IN (
  'Refund_refundedAt_idx','Refund_paymentId_idx',
  'Measurement_visitId_measuredAt_idx','FileAsset_patientId_createdAt_idx');

SELECT pid, state, age(clock_timestamp(), xact_start) AS xact_age, left(query,120) AS query
FROM pg_stat_activity WHERE xact_start IS NOT NULL AND state <> 'idle' ORDER BY xact_start;
```

### 5.4 Migrations #6 and #7 — destructive changes

```sql
-- #6
ALTER TABLE "Patient" DROP COLUMN "email";
ALTER TABLE "Patient" ADD COLUMN "referringDoctor" TEXT;

-- #7
ALTER TABLE "ClinicSettings"
  DROP COLUMN "emailEnabled", DROP COLUMN "emailProvider",
  DROP COLUMN "emailFromAddress", DROP COLUMN "dailyDoctorDigest",
  DROP COLUMN "digestSendHour";
DROP TABLE "EmailLog";
```

Permanently lost: all `Patient.email` values; all five `ClinicSettings` email configuration fields; the entire `EmailLog` audit trail (`toAddress`, `subject`, `template`, `status`, `error`, `attempts`, `createdAt`, `sentAt`). `ClinicSettings.email` is **not** dropped.

Pre-migration requirements:

1. Fresh verified format-4 backup (PB-04) with `backup-verify.sh` exit 0, `SHA256SUMS`, and decrypted hash check.
2. Isolated restore proving the dropped objects are recoverable; record row counts and hashes for `Patient.email`, `EmailLog`, and the five settings fields.
3. Read-only counts: `SELECT count("email") FROM "Patient";`, `SELECT count(*) FROM "EmailLog";`, and non-null counts for dropped settings fields.
4. Grep application code for stale references to dropped columns/table.
5. Explicit written owner approval naming operator, timestamp, backup ID, and restore evidence — one approval per destructive migration.

### 5.5 Generic preflight per migration

| Item | Required |
|---|---|
| Migration inventory | Read-only `_prisma_migrations` names/state/checksums; no unfinished or rolled-back rows. |
| Backup evidence | Verified format-4 backup taken inside the change window. |
| Data checks | Migration-specific read-only queries above; all must return expected results. |
| Lock budget | Table sizes and maintenance window approved; migration #9 especially. |
| Owner approval | Written, with named operator and rollback decision point. |
| Rollback rehearsal | Isolated rehearsal of the specific failure path; no Production restore over a newer database. |

---

## 6. Backup, restore, RTO and RPO

### 6.1 Classification of claims

| Category | Status | Detail |
|---|---|---|
| **Implemented behavior** | Verified in repository | Format-4 encrypted sets; atomic staging/publication; verifier with strict `SHA256SUMS` parsing; retention dry-run default with `--apply --confirm DELETE`; isolated restore scripts; WAL archiving/PITR helpers; PITR manifest linking; read-only monitors. |
| **Locally validated** | Synthetic only | Phase 9.4: 18/18 assertions, full restore drill (341 ms backup / 1003 ms restore). Phase 9.5: 12/12 PITR scenarios, full before/after drill (2596 ms base, 1972 ms archive delay, 2491/2372 ms restore). Phase 9.6: 8/8 archiver scenarios, scheduler 7/7, PITR monitor 0/3/3. |
| **Production configuration still required** | BLOCKED | WAL mount and UUID, age key escrow, backup accounts/ACLs, timer installation, alert sink, target env files, DNS/TLS. |
| **Measured RTO/RPO** | Synthetic only | Numbers above are small-data drill timings excluding human, transfer, provisioning, and promotion steps. |
| **Unmeasured RTO/RPO** | Production | No production-shaped restore, no target-host timing, no demonstrated finite RPO. **Do not claim a five-minute RPO or any specific RTO.** |

### 6.2 Operational schedules (templates only, not installed)

| Timer | Schedule (Cairo) | Behavior |
|---|---|---|
| `clinic-backup-full.timer` | Daily 02:00, `Persistent=true`, 10 m jitter | Full logical format-4 backup via dispatcher job `full`. |
| `clinic-backup-pitr-base.timer` | Weekly Sun 03:00, persistent, 10 m jitter | PITR base via job `pitr-base` — **currently broken by PB-25**. |
| `clinic-backup-verify.timer` | Daily 04:00, persistent, 10 m jitter | Verify newest logical set; PITR base not covered (PB-30). |
| `clinic-backup-retention.timer` | Daily 05:00, persistent, 10 m jitter | **Dry run**; deletion only with explicit `--apply --confirm DELETE`. |
| `clinic-wal-prune.timer` | Daily 05:30, persistent, 10 m jitter | **Dry run**; dependency-aware floor from retained PITR manifests; newest segment preserved. |

Retention defaults: daily 7, weekly 4, monthly 12; limits clamped to at least one, so the newest valid set is always kept. Invalid or checksum-dirty sets are never deleted.

### 6.3 Backup and WAL requirements

- Logical backups: `BACKUP_ROOT=/mnt/clinic-backups`, one approved mount, backup root and UUID validated before every run; writers quiesced by default (`backend web evolution`), `db` refused.
- WAL archiving: continuous, fail-closed; `archive_timeout=300` default means a partially filled segment can take up to roughly five minutes plus I/O/retry delay. This is why five minutes is only a **design target**, not a measured RPO.
- Retention dependency: a PITR base set may be deleted only after every WAL segment it requires is outside all retained sets' requirements; WAL pruning computes the minimum required segment across retained `pitr_ready` manifests.
- Encryption: age public-key encryption for artifacts; private key in separate escrow, never on the backup host; key escrow verification is BLOCKED (PB-05).
- Integrity: manifest written last; `SHA256SUMS`; decrypted hashes; strict 64-hex line validation; verifier exit 0 required.
- Restore isolation: `restore-backup.sh` and `pitr-restore.sh` require explicitly confirmed non-production targets, suffixes, and non-production ports; no default production target.
- DB/file consistency: format-4 manifest includes database and storage plaintext hashes plus per-file checksums; restore drill reconciles row counts and uploaded-file checksums.

### 6.4 Recovery verification checklist (target-host, authorization required)

1. Confirm owner approval, operator, and change window.
2. Identify backup ID and `pitr_ready` base; verify manifests and checksums.
3. Confirm key escrow retrieval without placing private key on backup host.
4. Restore to a new isolated target with matching confirmation and non-production port.
5. Verify database row counts, `pg_amcheck`/integrity, migrated schema/constraints, and uploaded-file checksums.
6. Verify application health and focused smoke tests against the isolated target.
7. Record elapsed time per phase; produce measured RTO/RPO with explicit scope and exclusions.
8. Destroy only the disposable drill target after evidence capture; never overwrite a newer Production database.

### 6.5 Production restore drill procedure (separate authorization only)

**Not executable in this phase.** With written approval, on an authorized host, using a production-shaped **synthetic** dataset:

1. Snapshot the current state and record backup ID; do not alter the source beyond the approved drill setup.
2. Create a fresh format-4 backup and PITR base; verify both.
3. Advance synthetic transactions and force a WAL switch at a recorded timestamp.
4. Restore a logical backup to an isolated target; reconcile DB + files.
5. Perform PITR to before and after the recorded transaction; verify expected row presence/absence.
6. Measure and document end-to-end elapsed time, including human steps separately.
7. Produce a signed drill report; update RTO/RPO claims only after that report exists.

---

## 7. Prisma security advisory assessment

### 7.1 Verified current audit state (this phase)

Live read-only checks: `npm --prefix backend audit --json` → `{"info":0,"low":0,"moderate":0,"high":4,"critical":0,"total":4}`; `scripts/dependency-audit.mjs` accepted exactly the documented cluster and emitted the non-blocking warning. Installed versions: `prisma 6.18.0`, `@prisma/client 6.18.0`, `@prisma/config 6.18.0`, `deepmerge-ts 7.1.5`, `effect 3.18.4`. No dependency, lockfile, exception, or Prisma version was changed.

Authoritative advisory pages were consulted for all three named GHSAs (GitHub Advisory Database, accessed 2026-11-21). This supersedes older reports' offline-verification limitation.

### 7.2 Per-advisory assessment

| Advisory | Affected package/version | Functionality | App usage / exposure | Mitigation options | Residual risk |
|---|---|---|---|---|---|
| **GHSA-ggr8-5vv4-36mx** / CVE-2026-40345; High CVSS 4.0 8.2; `< 8.0.0`, patched 8.0.0 | `deepmerge-ts` 7.1.5 via `@prisma/config` | `deepmerge()` / `deepmergeInto()` recurse without cycle detection on self-referential object graphs → stack exhaustion (availability). | No runtime source import; runtime image deletes the package. Reachable only through CLI/config merge with attacker-controlled recursive objects — no HTTP path. Build/migrate stage still contains it. | Patch to 8.0.0 upstream or accept via the exact CI exception; a Prisma 7.10.1 major upgrade is the npm-suggested CLI fix (not applied). | Open in lockfile/build/migrate stage; low practical runtime exposure; owner acceptance required. |
| **GHSA-38f7-945m-qr2g** / CVE-2026-32887; High CVSS 3.1 7.4; `< 3.20.0`, patched 3.20.0 | `effect` 3.18.4 via `@prisma/config` | `MixedScheduler` drains fibers in one ALS context; under concurrent RPC load a request can read another request's context (confidentiality/integrity). | No runtime source import; runtime image deletes the package. Requires concurrent RPC/ALS load in Prisma CLI/config path, not the Express API. | Upgrade `effect` upstream or Prisma 7 major upgrade; no in-app workaround used. | Open in build/migrate stage; low practical exposure but high theoretical impact; exception applies. |
| **GHSA-7589-6fvf-x4pw** / CVE-2026-121707; High CVSS 4.0 8.7; `<= 3.22.0`, patched 3.22.1 | `effect` 3.18.4 (same chain) | `Schema.TemplateLiteral` compiles multiple `Schema.String` spans to ambiguous lazy wildcards → cubic backtracking / ReDoS on non-matching input. | No runtime source import; no app schema decoder path found; build/migrate stage only. | Patch `effect` 3.22.1 or Prisma 7 major upgrade; request-size limits would mitigate only if an untrusted path existed. | Open in lockfile/build/migrate stage; low practical exposure; exception applies. |
| **CLI-high assignment through `@prisma/config` / `prisma`** | `prisma` 6.18.0 and `@prisma/config` 6.18.0; npm range `6.13.0-dev.1 - 7.10.0` (plus 8.x dev/rc ranges) | npm assigns High to the CLI packages because they transitively carry the two `effect` advisories and `deepmerge-ts`; no distinct GHSA ID is assigned by npm audit for this assignment. `cli-high` is not a package in the lockfile. | CLI/build/migrate stage; not imported by runtime source; runtime image removes CLI-only packages (`backend/Dockerfile:38-48`). Migration executes trusted local SQL, not untrusted input. | `npm audit` fix available is `prisma@7.10.1`, `isSemVerMajor=true`; every 6.x is inside the range, so no 6.x patch exists. | Open; needs formal owner risk acceptance or a separately validated Prisma 7 migration. |

### 7.3 Exception mechanism and constraints

`scripts/dependency-audit.mjs` fails closed on anything other than exactly four vulnerabilities with names `@prisma/config`, `deepmerge-ts`, `effect`, `prisma`, all High, no other severities. It emits a non-blocking warning for the accepted cluster. Do not expand it, suppress findings, change lockfiles, or upgrade dependencies in this phase. Formal owner acceptance is recorded as blocker PB-15.

---

## 8. TLS, DNS and reverse proxy readiness

### 8.1 Local validation already performed

- `caddy validate --config deploy/Caddyfile` OK; `nginx -t` OK.
- Throwaway Caddy with `tls internal` and synthetic responder: HTTP → `301 https://...`; HTTPS → `200` with `strict-transport-security: max-age=31536000; includeSubDomains`.
- Log filtering reviewed: Caddy strips query strings and deletes `Authorization`/`Cookie`; nginx logs URI paths only; backend logs route templates with no bodies/headers/query.

This proves redirect/HSTS behavior and local config syntax only. It does **not** prove public certificate trust, DNS, or the real traffic path.

### 8.2 Target-environment checklist (not executed)

| Item | Required evidence | Status |
|---|---|---|
| Domain ownership | Owner-provided domain; no placeholder in production config | BLOCKED |
| DNS records | A/AAAA records point to approved host; propagation confirmed | BLOCKED |
| Public certificate | ACME issuance for `<APPROVED_DOMAIN>`; chain and browser trust verified | BLOCKED |
| Renewal/expiry | Caddy auto-renewal observed or documented; `P7_CERT_FILES` configured and `p7-check-cert.sh` green (PB-29) | BLOCKED |
| HTTP→HTTPS | Real request returns permanent redirect to canonical HTTPS host | BLOCKED |
| HSTS | Header present on real HTTPS responses; `APP_ORIGIN` all HTTPS | BLOCKED |
| Caddy→nginx→Web | `reverse_proxy web:80`; nginx `/api/` → `backend:4000`; SPA fallback; real traffic probe | BLOCKED |
| `/api` proxy | `/api/v1` routes, cookies, uploads, 32 MB body limit, timeouts verified | BLOCKED |
| Forwarded headers / spoofing | Caddy sets `X-Real-IP {remote_host}`; nginx must not be directly reachable; client-supplied XFF/X-Real-IP must not influence `req.ip` | BLOCKED |
| `APP_ORIGIN` | `https://<APPROVED_DOMAIN>`; production guard requires HTTPS origins | BLOCKED |
| `COOKIE_SECURE` | `true`; secure cookie attributes observed in browser | BLOCKED |
| `TRUST_PROXY` | `1` only with Caddy as the single trusted hop | BLOCKED |
| Secure cookies | `httpOnly`, `SameSite=Lax`, `secure=true`, scoped path | BLOCKED |
| Sanitized logs / PHI | Synthetic PHI probe shows no query strings, tokens, cookies, or patient data in Caddy/nginx/backend logs | BLOCKED |

No certificate was issued and no DNS record was changed.

---

## 9. Monitoring and scheduling operations

### 9.1 Implemented templates (not installed)

| Unit | Schedule / role |
|---|---|
| `clinic-backup-full.timer` | Daily 02:00 Cairo → `clinic-backup-schedule@full.service` |
| `clinic-backup-pitr-base.timer` | Weekly Sun 03:00 Cairo → `@pitr-base` (broken by PB-25) |
| `clinic-backup-verify.timer` | Daily 04:00 → `@verify` |
| `clinic-backup-retention.timer` | Daily 05:00 → `@retention` (dry run) |
| `clinic-wal-prune.timer` | Daily 05:30 → `@wal-prune` (dry run) |
| `clinic-backup-schedule@.service` | `Type=oneshot`, `User=root`, `WorkingDirectory=/opt/clinic`, `EnvironmentFile=-/etc/clinic/backup.env`, `TimeoutStartSec=2h`, no `[Install]`. |
| `clinic-monitor.timer` / `.service` | Every 5 min; `root:root`; `WorkingDirectory=/opt/clinic/Clinc-V1.1`; hardening `NoNewPrivileges`, `PrivateTmp`, `ProtectSystem=strict`, `ProtectHome`, `ReadWritePaths=/var/lib/clinic-monitor`. |
| `clinic-heartbeat-check.timer` / `.service` | Every 10 min; `clinc_server:clinc_server`; independent stopped-monitor detection. |

### 9.2 Deployment instructions (future, authorization required only)

1. **Owners and permissions:** backup dispatcher `root`; monitor `root:root`; heartbeat check `clinc_server:clinc_server`. Reconcile the state directory so both users work (PB-26).
2. **Directories:** `/etc/clinic` for `0600 root:root` env files; `/var/lib/clinic-monitor` for state/heartbeat/alerts; `/run/lock/clinic-backup.lock`; `<BACKUP_ROOT>/logs`; dedicated `0700` WAL mount.
3. **Environment:** copy `deploy/monitor.env.example` → `/etc/clinic/monitor.env` with real values (including `P7_CERT_FILES`, PB-29); populate `/etc/clinic/backup.env` with approved values; never commit populated files.
4. **Paths:** reconcile `/opt/clinic` vs `/opt/clinic/Clinc-V1.1` to a single approved root (PB-31).
5. **Fix repository defects first:** PB-25–PB-31.
6. **Install units:** copy templates into `/etc/systemd/system/`; enable only the seven timers (`systemctl enable --now clinic-backup-*.timer clinic-wal-prune.timer clinic-monitor.timer clinic-heartbeat-check.timer`); do not enable oneshot services.
7. **Retry / failure:** no automatic retry by design; failures are visible via job `exit_code`, journal, `p7-check-backup`, `p7-check-pitr`, capacity and heartbeat checks. Add explicit failure notification per PB-31.
8. **Overlap:** one non-blocking `flock` for all backup jobs; currently a skip exits 0 silently (PB-31 must be closed).
9. **Disk exhaustion:** thresholds 70/85/95 % for bytes and inodes; producer/dispatcher preflights fail before staging; never delete backup artifacts without approval.
10. **WAL backlog:** count 50/200/500 and oldest age 900/3600/7200 s; freshness 600/1200/1800 s is the actionable stalled-archiver signal; never delete WAL manually; pruning is dependency-aware and dry-run by default.
11. **Alert delivery:** blank placeholders keep delivery disabled; real token/chat/heartbeat URL must be `0600` and HTTPS-only; send one synthetic test alert, verify allowlisted fields only, three-failure degradation, sink rotation, and one ping per completed cycle.

No unit was installed, enabled, or executed on any target host in this phase.

---

## 10. Docker and resource readiness

### 10.1 Supported overlay combinations

Validated by `docker compose ... config --quiet` in this phase (7/7 with synthetic `CLINIC_DOMAIN=clinic.test`; TLS combos require that placeholder):

1. base
2. base + TLS
3. base + PITR
4. base + limits
5. base + monitoring (profile-gated)
6. base + TLS + limits
7. base + TLS + PITR + limits + monitoring

Isolated runtime evidence in Phase 9.6 used base + PITR + limits. The TLS overlay was not started (would require DNS/cert issuance).

### 10.2 Resource limits (configuration, not measurement)

| Service | Memory | CPU quota | CPU shares | pids |
|---|---:|---:|---:|---:|
| `db` | 4 GiB | 1.5 | 1024 | 200 |
| `backend` | 3 GiB | 1.0 | 2048 | 300 |
| `web` | 256 MiB | 0.25 | 128 | 100 |
| `evolution` | 1 GiB | 0.5 | 512 | 200 |
| `migrate` | 1 GiB | 0.75 | 512 | 100 |
| `caddy` | 256 MiB | 0.5 | 256 | 100 |

Steady budget 3.75 vCPU; migration burst 4.50 vCPU; memory ceiling ~8.5 GB. Caddy values are config-render validated only. These are defaults, **not** evidence of host adequacy (PB-19).

### 10.3 Migration resources and Caddy

- `migrate` uses the Prisma CLI build stage, heap `NODE_OPTIONS=--max-old-space-size=768`, 1 GiB cap, 0.75 CPU; migration failure blocks API start via `service_completed_successfully`.
- Caddy caps live in `docker-compose.tls.yml` so base + limits remains valid; runtime caps must be exercised on an authorized host.
- Host capacity checks available: `p7-check-capacity.sh` (disk/inodes only), `p7-check-containers.sh` (health/restart/OOM). No CPU/RAM telemetry or load test exists.

### 10.4 Image integrity, provenance, and scanning

- Images are tag-pinned (`postgres:16-alpine`, `caddy:2.11-alpine`, `evoapicloud/evolution-api:v2.3.7`, `bash:5-alpine`, plus Dockerfile base tags). No `@sha256:` digests, signatures, SBOMs, or provenance assertions were found.
- No image CVE scanner is installed (`trivy`, `grype`, `syft`, `docker-scan`, `dockle`, `hadolint`, `osv-scanner`, `snyk`, `clair`, `skopeo`, `crane`, `oras` all unavailable in earlier checks). Available scanners cover dependencies/source only (`npm audit`, `secret-scan.mjs`).
- **Limitation:** no image CVE scan or image-content assertion was performed. Recommend an owner-approved scanner in an isolated environment against exact immutable digests, with a recorded CVE report and acceptance of residual findings (PB-20).
- No Production image was pulled, replaced, or deployed.

---

## 11. Documentation cleanup and historical notes

Historical reports were not rewritten. The following clarifications are current operational guidance:

1. **Phase 9.5 archive path** `.../clinic/scripts/deploy/wal-archive.sh` is stale. Correct: `/bin/sh /clinic/deploy/wal-archive.sh %p %f` with `./deploy:/clinic/deploy:ro` (`backup-restore.md:377`, Phase 9.6 `:85`).
2. **Alpine tooling claim** in Phase 9.5 ("no bash/mountpoint/findmnt") is imprecise; Phase 9.6 validated POSIX-sh helpers using `/proc` as UID 70.
3. **`archive_timeout=10s`** in Phase 9.4 refers to the old Phase 6.1 disposable cluster; current overlay default is `300`.
4. **Resource arithmetic** 4.75/5.75 vCPU and "Caddy uncapped" in Phase 9.2/9.3 is superseded by 3.75/4.50 vCPU and Caddy `0.5`.
5. **"45 CHECK constraints"** in older reports is unverified drift; authoritative SQL gives 43 (38 new + 5 baseline).
6. **Unsafe `_prisma_migrations` DELETE** language in `rollback.sql` and Phase 9.3 is superseded by the Prisma-native reconciliation in Section 5.2.
7. **Phase 9.5 Docker-daemon-unavailable** and Phase 9.4 Compose-path limitations are historical environment facts; Phase 9.6 had a daemon and ran isolated stacks.
8. **`docs/backup-restore.md` remains the current operational reference.** These clarifications do not change any prior test claim.

---

## 12. Final acceptance gate

| Category | Required status | Current status | Evidence / blocker |
|---|---|---|---|
| WAL/PITR implementation | Verified | **Verified (repository/synthetic)** | Phase 9.5 12/12; Phase 9.6 8/8 archiver scenarios |
| Production WAL mount | Independently verified | **Not verified** | PB-01 |
| Backup and restore | Verified | **Verified (synthetic only)** | Phase 9.4 18/18 + full drill; PB-04, PB-21 |
| Migration safety | Approved | **Not approved** | PB-09–PB-14 |
| Prisma security | Accepted or remediated | **Neither recorded** | PB-15 |
| TLS and DNS | Verified | **Not verified** | PB-16 |
| Reverse proxy | Verified | **Not verified** | PB-17, PB-18 |
| Scheduling | Installed and verified | **Not installed** | PB-06, PB-07, PB-25–PB-31 |
| Monitoring and alerts | Verified | **Not verified** | PB-08, PB-29 |
| Docker resources | Measured | **Not measured** | PB-19 |
| Image security | Scanned | **Not scanned** | PB-20 |
| RTO/RPO | Measured | **Unmeasured in production** | PB-21 |
| Deployment runbook | Approved | **Draft, awaiting approval** | `docs/PRODUCTION_DEPLOYMENT_RUNBOOK.md` |
| Rollback plan | Approved | **Draft, awaiting approval** | `docs/PRODUCTION_ROLLBACK_RUNBOOK.md` |

### 12.1 Final verdict

**PARTIAL**

Some requirements are verified in the repository and isolated environments, but Production blockers remain. Every remaining blocker and the exact evidence needed to close it is listed in `docs/PRODUCTION_BLOCKER_REGISTER.md`. A repository-only PASS must not be presented as Production readiness. Completing this phase does not authorize deployment; deployment requires separate explicit approval for each Production action and a named change window.

---

## 13. Files created or modified by this phase

| File | Action |
|---|---|
| `docs/PRODUCTION_READINESS_PHASE9_7.md` | Created (this document) |
| `docs/PRODUCTION_DEPLOYMENT_RUNBOOK.md` | Created |
| `docs/PRODUCTION_ROLLBACK_RUNBOOK.md` | Created |
| `docs/PRODUCTION_BLOCKER_REGISTER.md` | Created |
| `scripts/p97-readiness-preflight.sh` | Created (read-only, fail-closed) |

No pre-existing file was modified by this phase.

### 13.1 Tests executed in this phase and results

| Check | Result |
|---|---|
| `git diff --check` | Exit 0 (benign LF→CRLF notice on `docker-compose.limits.yml`) |
| `bash -n` on all 31 shell scripts in `scripts/` and `deploy/` | 31/31 OK |
| `docker compose config --quiet` for 7 overlay combinations | 7/7 OK with synthetic `CLINIC_DOMAIN=clinic.test`; TLS combos fail without that placeholder |
| `node scripts/secret-scan.mjs` | 0 actionable; 2 allowlisted fixtures; exit 0 |
| `node --test scripts/secret-scan-regression.test.mjs` | 10/10 pass |
| Live `npm --prefix backend audit --json` | Exactly 4 high / 0 critical / 0 other; versions confirmed |
| `node scripts/dependency-audit.mjs <audit-json>` | Accepted documented cluster, exit 0 |
| `bash scripts/p97-readiness-preflight.sh` | `RESULT PASS` (repository invariants only) |
| Authoritative GHSA pages for the three named advisories | Verified via GitHub Advisory Database |
| Repository-only WAL/PITR audit | Completed; findings folded into Section 4.5 and the blocker register without status changes |

No database, container runtime workload, deployment, migration, backup, restore, or Production operation was executed.
