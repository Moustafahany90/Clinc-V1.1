# Phase 9.7 / 9.8 — Production Blocker Register

**Date:** 2026-11-21  
**Branch / HEAD at original assessment:** `fix/phase9-remediation` @ `a828bcf0efed9e061f9fb4fbd32d496d63c28309`  
**Branch / HEAD after Phase 9.8 repository remediation:** `fix/phase9-8-operational-defects` (local commits only)  
**Scope:** Consolidated register of every Production blocker inherited from Phase 9.2–9.7 plus the repository-only Phase 9.8 remediation of PB-11 and PB-25–PB-31.

> **Phase 9.8 update:** Repository defects are corrected and proved only with synthetic, disposable fixtures. Blockers whose acceptance criteria require target-host evidence, owner approval, installation, DNS/TLS, image scanning, or a restore drill remain **BLOCKED** or **OPEN**. No GitHub Actions run has occurred on the Phase 9.8 branch, and no Production operation was performed.

> This register is a preparation artefact. It does **not** authorize deployment, migration, backup, restore, WAL pruning, certificate issuance, DNS changes, timer installation, or any other Production operation. No blocker in this register may be marked CLOSED on documentation or assumption alone.

## 1. Status legend

| Status | Meaning |
|---|---|
| **CLOSED** | Verified in this phase with local evidence; no target-host evidence is required for the specific item. |
| **OPEN** | Unresolved in the repository or awaiting an owner decision; no Production access was needed to identify it. |
| **BLOCKED** | Cannot be closed without authorized target-host/Production access, evidence, or a separately approved change window. |
| **ACCEPTED RISK** | Only usable when an explicit, recorded owner acceptance exists. Not used in this register. |

## 2. Consolidated register

### PB-01 — Production WAL mount and filesystem identity

- **Severity:** High
- **Component:** WAL archive host mount (`/mnt/clinic-backups/wal-archive`), `docker-compose.pitr.yml`, `deploy/wal-archive.sh`
- **Description:** The WAL mount on the target host has not been independently verified. UUID, filesystem type, capacity, UID/GID ownership, and container access remain unproven for the current deployment target.
- **Current evidence:** Phase 9.6 closed the container-side defect (correct archive command `/bin/sh /clinic/deploy/wal-archive.sh %p %f`, `./deploy:/clinic/deploy:ro`, fail-closed UUID branch) and ran 8/8 archiver scenarios as UID/GID `70:70` in `postgres:16-alpine`. The overlay and `.env.example` deliberately leave `WAL_ARCHIVE_EXPECTED_UUID` empty and use a placeholder host path. `scripts/backup-common.sh` and `deploy/monitor.env.example` carry a backup-disk UUID; that is a different configuration field and must not be copied into the WAL setting. `docs/backup-restore.md:82` records a historically documented UUID; it is not re-verified here.
- **Missing evidence:** Authorized target-host `findmnt`/`blkid`/`stat`/`df` output for the actual mount; expected UUID recorded by the owner; free-space floor confirmed; UID/GID with write access confirmed from the actual image.
- **Exact action required:** Run the Section 4 target-host preflight of `docs/PRODUCTION_READINESS_PHASE9_7.md`, record outputs in the change record, and set `WAL_ARCHIVE_HOST_DIR`, `WAL_ARCHIVE_EXPECTED_UUID`, `WAL_ARCHIVE_EXPECTED_FSTYPE` from verified values only.
- **Production authorization required:** Yes — read-only target-host access plus owner approval of the recorded values.
- **Acceptance criteria:** Dedicated mount exists; UUID and filesystem match owner-approved values; minimum free space met; PostgreSQL runtime UID/GID can write `0700` directory; `p7-check-wal.sh` and `p7-check-pitr.sh` report `ok` on the target.
- **Final status:** **BLOCKED**

### PB-02 — WAL freshness, thresholds, and backlog response on target

- **Severity:** High
- **Component:** `scripts/p7-check-wal.sh`, `scripts/p7-check-pitr.sh`, `deploy/monitor.env.example`
- **Description:** Local thresholds are configured but no target-host WAL backlog, archive delay, or free-space operating point has been measured.
- **Current evidence:** Phase 9.6 harness produced `ok` / `critical` / `critical` with exit codes `0` / `3` / `3` for healthy, missing-WAL, and invalid-checksum cases. `archive_timeout` default is `300` seconds (the `30` in Phase 9.6 was an isolated override).
- **Missing evidence:** Target-host archive-delay distribution, backlog depth, capacity alarm thresholds, and a tested response to archive failure and disk exhaustion.
- **Exact action required:** Install monitoring, capture baseline WAL metrics, confirm thresholds, and rehearse the WAL-archiving-failure and disk-exhaustion procedures in `docs/PRODUCTION_ROLLBACK_RUNBOOK.md`.
- **Production authorization required:** Yes.
- **Acceptance criteria:** Measured archive delay within owner-approved bound; alerts fire on injected synthetic faults; disk-exhaustion and WAL-backlog runbooks executed in a drill.
- **Final status:** **BLOCKED**

### PB-03 — PITR base age and required WAL range on target

- **Severity:** High
- **Component:** `scripts/pitr-base-backup.sh`, `scripts/p7-check-pitr.sh`, PITR manifests
- **Description:** No target-host PITR base backup exists, so base age and required WAL range completeness cannot be verified.
- **Current evidence:** Phase 9.5 12/12 synthetic scenarios and a full before/after drill; manifests include required WAL start/end and per-segment SHA-256. The harness cleanup traps remove their temporary directories, so no durable log artifact was retained; these remain historical report claims, not re-verified evidence.
- **Missing evidence:** At least one target-host `pitr_ready=true` base set with complete verified WAL range and recorded age.
- **Exact action required:** After authorization, create the first PITR base set and confirm `p7-check-pitr.sh` reports `ok` for base age and every required segment.
- **Production authorization required:** Yes.
- **Acceptance criteria:** `pitr_ready=true`; all required segments plus sidecars present and checksum-valid; base age below the owner-approved warn threshold.
- **Final status:** **BLOCKED**

### PB-04 — Fresh verified backup before migration

- **Severity:** Critical
- **Component:** `scripts/backup.sh`, `scripts/backup-verify.sh`, migration window
- **Description:** No Pre-deployment backup of the current Production state has been taken or verified.
- **Current evidence:** Format-4 backup implementation and 18/18 synthetic assertions; Phase 9.4 full restore drill measured 341 ms backup / 1003 ms restore (synthetic only).
- **Missing evidence:** A verified format-4 backup ID created inside the authorized change window, with `backup-verify.sh` output, `SHA256SUMS`, decrypted hashes, and a current restore rehearsal.
- **Exact action required:** Take and verify a fresh backup immediately before migration; record the backup ID and verification output in the change record.
- **Production authorization required:** Yes.
- **Acceptance criteria:** `backup_format=4`, `encryption_status=encrypted`, verifier exit 0, published manifest and hashes intact, isolated restore rehearsal passed.
- **Final status:** **BLOCKED**

### PB-05 — Encryption key escrow and backup account model

- **Severity:** High
- **Component:** age key escrow, `clinicbackup` / `clinicmonitor` service accounts
- **Description:** Age private-key escrow retrieval and least-privilege account/ACL model were never verified on the target host.
- **Current evidence:** Synthetic keys created and destroyed in temp directories during Phase 9.4/9.5. `docs/backup-restore.md` records the recommended account model as a requirement, not an implemented state.
- **Missing evidence:** Owner-approved escrow procedure, ACL listing, and a restore using only escrowed key material.
- **Exact action required:** Verify escrow retrieval and permissions on the target; never place private keys on the backup host.
- **Production authorization required:** Yes.
- **Acceptance criteria:** Documented key custodian; restore succeeds with escrowed key; no private key present on backup or monitoring host; ACLs least-privilege.
- **Final status:** **BLOCKED**

### PB-06 — Logical backup schedule installation

- **Severity:** High
- **Component:** `deploy/clinic-backup-full.timer`, `deploy/clinic-backup-verify.timer`, `scripts/backup-scheduler.sh`
- **Description:** Timer templates exist in the repository but no timer has been installed, enabled, or observed on the target host.
- **Current evidence:** Phase 9.6 dispatcher harness 7/7; verified local preflight confirms no Clinic timers installed on this machine.
- **Missing evidence:** Installed units, named job owners, state/lock directories, observed successful runs and failure notifications.
- **Exact action required:** Follow Section 9 of `docs/PRODUCTION_READINESS_PHASE9_7.md` under a separate authorization; do not install from this phase.
- **Production authorization required:** Yes.
- **Acceptance criteria:** `systemctl list-timers` shows expected units; first full and verify runs succeeded; failure path sends alert.
- **Final status:** **BLOCKED**

### PB-07 — PITR base / retention / WAL-prune schedule installation

- **Severity:** High
- **Component:** `deploy/clinic-backup-pitr-base.timer`, `clinic-backup-retention.timer`, `clinic-wal-prune.timer`
- **Description:** Same as PB-06 for PITR base, retention, and WAL pruning; additionally, retention and pruning must remain dry-run until an owner explicitly authorizes `--apply --confirm DELETE`.
- **Current evidence:** Repository preflight verifies timer `ExecStart` lines contain no mutation flags and comments document the manual gated command.
- **Missing evidence:** Installed units, dry-run outputs reviewed by owner, retention limits approved, WAL dependency-aware pruning verified against retained PITR manifests.
- **Exact action required:** Install and observe dry runs; obtain separate written approval before any deletion.
- **Production authorization required:** Yes, plus a second approval for deletion.
- **Acceptance criteria:** Dry-run outputs reviewed; no WAL segment required by any retained PITR set is deleted; newest archived segment preserved; `--apply` never used without a recorded decision.
- **Final status:** **BLOCKED**

### PB-08 — Monitoring, alert delivery, and heartbeat installation

- **Severity:** High
- **Component:** `docker-compose.monitoring.yml`, `deploy/clinic-monitor.*`, `deploy/clinic-heartbeat-check.*`, `scripts/p7-deliver-telegram.sh`
- **Description:** Monitoring is profile-gated and local only; no alert sink, heartbeat, or target-host state directory is configured.
- **Current evidence:** Phase 9.6 added `pitr` to the default check set; checks are read-only with respect to application, backup, and WAL data (the WAL check may update the monitor state directory); no external notification was enabled. `docs/monitoring-runbook.md` has a WAL section but no PITR section, so the runbook is not yet a complete operator reference.
- **Missing evidence:** Alert sink ownership, credentials (out of band), heartbeat schedule, delivery verification, log rotation, a PITR section in the operator runbook, and failure-notification drill.
- **Exact action required:** Install and verify under separate authorization; test with synthetic alert only.
- **Production authorization required:** Yes.
- **Acceptance criteria:** All checks report status; synthetic alert delivered; heartbeat observed; expired alert path verified; no PHI in payloads or logs.
- **Final status:** **BLOCKED**

### PB-09 — Target migration inventory and drift

- **Severity:** Critical
- **Component:** `_prisma_migrations`, target database schema
- **Description:** It is unknown which of the nine migrations are already applied on the target and whether schema drift exists.
- **Current evidence:** All nine apply cleanly to synthetic databases; `schema.prisma` is consistent with the migration chain; no target query was performed.
- **Missing evidence:** Read-only inventory of applied migration names, checksums, finished/rolled-back state, and catalog check for the 43 expected CHECK constraints and four indexes.
- **Exact action required:** Authorized read-only inventory using the queries in Section 5 of `docs/PRODUCTION_READINESS_PHASE9_7.md`; reconcile drift before any `migrate deploy`.
- **Production authorization required:** Yes.
- **Acceptance criteria:** Exact nine-row inventory or documented owner-approved reconciliation; no unexpected schema drift; no unfinished migration rows.
- **Final status:** **BLOCKED**

### PB-10 — Migration #8 data validity (38 new CHECKs + 5 amount checks)

- **Severity:** Critical
- **Component:** `20261120222405_db_integrity_constraints`
- **Description:** `ADD CONSTRAINT ... NOT VALID` followed by `VALIDATE` in the same transaction fails atomically on any violating Production row, and holds `ACCESS EXCLUSIVE` on 17 tables throughout.
- **Current evidence:** Drill evidence in `PHASE_M.md:242` (`P3018` / `23514`, no partial constraints). Read-only violation queries are provided in `docs/PRODUCTION_READINESS_PHASE9_7.md`.
- **Missing evidence:** Zero-row results for all 43 read-only violation queries against the target; table sizes and lock budget.
- **Exact action required:** Run all read-only queries under authorization, record zero-row results, obtain owner approval for the write-freeze window, and take a verified backup.
- **Production authorization required:** Yes.
- **Acceptance criteria:** All violation queries return zero rows; post-deploy catalog shows 38 `convalidated=true` constraints (43 with baseline); no failed migration row.
- **Final status:** **BLOCKED**

### PB-11 — Unsafe `_prisma_migrations` guidance in migration 8 rollback file

- **Severity:** High
- **Component:** `backend/prisma/migrations/20261120222405_db_integrity_constraints/rollback.sql:5-13`; historical `PHASE9_3.md:40`
- **Description:** The rollback file proposed a direct SQL deletion of a row in the Prisma migration ledger for a successful migration. Direct ledger edits are unsafe and must never be used.
- **Current evidence:** Phase 9.8 replaced the unsafe SQL in `rollback.sql` with Prisma-native reconciliation only and updated the live rollback runbook. The historical Phase M quote remains solely as an explicitly marked `UNSAFE / SUPERSEDED` example. `scripts/p97-readiness-preflight.sh` assembles the forbidden command at runtime, rejects any unmarked reintroduction, and exits 0 on the current repository. Commit `93509a2`.
- **Missing evidence:** None for this repository-only item. Any actual ledger reconciliation remains a separately authorized target-host operation.
- **Exact action required:** Re-run the preflight before a change window; use `prisma migrate resolve --rolled-back` / `--applied` or a new forward migration only under separate approval.
- **Production authorization required:** No for the repository correction; yes for any target-host reconciliation.
- **Acceptance criteria:** No live Production procedure references direct ledger edits; any reconciliation uses Prisma CLI commands and is recorded.
- **Final status:** **CLOSED** (repository-only defect; no Production action performed)

### PB-12 — Migration #9 plain `CREATE INDEX` on populated tables

- **Severity:** Critical
- **Component:** `20261121220000_phase91_performance_indexes`
- **Description:** Four plain `CREATE INDEX` statements take `SHARE` locks, blocking all writes on `Refund` and `Measurement` and `FileAsset` for the transaction duration if tables are populated.
- **Current evidence:** Exact SQL verified: `Refund_refundedAt_idx`, `Refund_paymentId_idx`, `Measurement_visitId_measuredAt_idx`, `FileAsset_patientId_createdAt_idx`. `CREATE INDEX CONCURRENTLY` is not usable unchanged because Prisma wraps migrations in a transaction; PostgreSQL rejects it inside a transaction block.
- **Missing evidence:** Target table sizes, existing index names, lock-budget approval, and a populated-table staging rehearsal.
- **Exact action required:** Perform read-only size/index inventory; if tables are non-empty, obtain an approved maintenance window and rehearsal. Do **not** edit the migration to `CONCURRENTLY` automatically.
- **Production authorization required:** Yes.
- **Acceptance criteria:** Owner-approved approach documented; measured build time on production-shaped data; write block within approved window or an approved non-transactional procedure with managed Prisma history.
- **Final status:** **BLOCKED**

### PB-13 — Destructive migrations #6 and #7

- **Severity:** Critical
- **Component:** `20261102120000_patient_referring_doctor`, `20261113135000_remove_email_delivery`
- **Description:** Migration #6 drops `Patient.email`. Migration #7 drops five `ClinicSettings` email columns and the entire `EmailLog` table. Data loss is irreversible without restore.
- **Current evidence:** Exact SQL and dropped-object inventory verified in this phase; no Production backup or owner approval exists.
- **Missing evidence:** Verified pre-drop backup, isolated restore proving the dropped data is recoverable, row counts/hashes, stale-code grep, written owner approval naming operator and backup ID.
- **Exact action required:** Complete PB-04 and PB-05, record the preflight counts, obtain explicit written approval before either destructive operation.
- **Production authorization required:** Yes — separate explicit approval per destructive migration.
- **Acceptance criteria:** Backup ID and restore drill recorded; approval signed; row counts captured; no application query references dropped objects.
- **Final status:** **BLOCKED**

### PB-14 — Permission backfill edge case (migrations #4 and #5)

- **Severity:** Medium
- **Component:** `20261031120000_token_version_and_override_permissions`, `20261101120000_report_whatsapp_delivery`
- **Description:** Rows with `permissions IS NULL` are silently skipped by the `array_append`/`= ANY` guards; the backfills are permanent and have no reverse statement.
- **Current evidence:** SQL and nullable `permissions` column verified; `ReportDelivery.attempts` default is `0` while migration #8 requires `>= 1`.
- **Missing evidence:** Target counts of NULL permissions, affected ADMIN/DOCTOR rows, and any persisted `attempts = 0` rows.
- **Exact action required:** Run read-only counts; record expected permission changes; verify no `attempts = 0` rows.
- **Production authorization required:** Yes for the target queries.
- **Acceptance criteria:** Counts recorded and accepted by owner; zero `ReportDelivery` rows with `attempts < 1`.
- **Final status:** **BLOCKED**

### PB-15 — Prisma four-high advisory cluster

- **Severity:** High
- **Component:** `prisma` / `@prisma/config` 6.18.0, `deepmerge-ts` 7.1.5, `effect` 3.18.4
- **Description:** Four High advisories remain under the exact CI exception. `scripts/dependency-audit.mjs` accepts only the four-package cluster and fails closed on any change.
- **Current evidence:** Live `npm --prefix backend audit --json` re-run in this phase: 4 high / 0 critical / 0 total others; installed versions confirmed; authoritative GHSA pages verified (GHSA-ggr8-5vv4-36mx, GHSA-38f7-945m-qr2g, GHSA-7589-6fvf-x4pw). Runtime image removes CLI-only packages; no runtime source imports them.
- **Missing evidence:** Explicit formal owner risk acceptance for the accepted exception, or an approved Prisma 7 migration with compatibility evidence.
- **Exact action required:** Owner signs the exception or schedules a separately approved upgrade. Do not upgrade, change lockfiles, suppress findings, or expand the exception here.
- **Production authorization required:** No for acceptance; yes for any upgrade/change window.
- **Acceptance criteria:** Signed acceptance recorded with expiry/recheck trigger, or verified remediation; audit output remains exactly the documented cluster until then.
- **Final status:** **OPEN**

### PB-16 — Real DNS, public certificate, and browser trust

- **Severity:** High
- **Component:** `deploy/Caddyfile`, `docker-compose.tls.yml`, public DNS/ACME
- **Description:** No domain ownership proof, DNS record, public certificate, chain, or browser-trust validation exists.
- **Current evidence:** `caddy validate` and a throwaway `tls internal` local test produced 301 redirect and HSTS; no ACME call was made.
- **Missing evidence:** Owner-provided domain, DNS A/AAAA records, issued certificate chain, renewal proof, and browser trust check.
- **Exact action required:** Target-environment checklist in Section 8 of `docs/PRODUCTION_READINESS_PHASE9_7.md`.
- **Production authorization required:** Yes.
- **Acceptance criteria:** Domain owned; DNS resolves to approved host; certificate chain trusted; auto-renewal verified; expiry monitor configured.
- **Final status:** **BLOCKED**

### PB-17 — Full reverse-proxy path and trust settings on target

- **Severity:** High
- **Component:** Caddy → nginx → web/backend, `APP_ORIGIN`, `COOKIE_SECURE`, `TRUST_PROXY`
- **Description:** Spoof-safety was proven only with Caddy in front; the target values of the three security settings and the full traffic path are unverified.
- **Current evidence:** `web/nginx.conf` forwards client-supplied `X-Forwarded-For`, `X-Real-IP`, `X-Forwarded-Proto` unchanged; backend trusts `TRUST_PROXY`. Caddy sets `X-Real-IP {remote_host}`.
- **Missing evidence:** Target env values, the anti-spoofing probe through the real chain, and `/api` behavior under real traffic.
- **Exact action required:** Verify settings are `APP_ORIGIN=https://<approved-domain>`, `COOKIE_SECURE=true`, `TRUST_PROXY=1`, and that nginx is not directly reachable; run the proxy verification in the deployment runbook.
- **Production authorization required:** Yes.
- **Acceptance criteria:** Client-supplied forwarded headers cannot influence `req.ip`; `/api/v1` routes and cookies behave correctly over HTTPS; secure cookie attributes observed.
- **Final status:** **BLOCKED**

### PB-18 — Phase 7.2 nginx privacy runtime harness

- **Severity:** Medium
- **Component:** `scripts/p72-nginx-privacy-test.sh`
- **Description:** The full runtime harness remained environment-blocked; only partial historical/local evidence exists.
- **Current evidence:** `nginx -t` passed in Phase 9.6; refusal scenario passed once historically; upstream-500 scenario could not start reliably because of Docker/WSL path interop. In-suite p72 tests pass in the 202/202 backend runs.
- **Missing evidence:** Full harness result on a host where Docker bind mounts work correctly.
- **Exact action required:** Run the harness on the authorized target or an equivalent disposable host and record results.
- **Production authorization required:** Yes (target host) or use an isolated equivalent environment.
- **Acceptance criteria:** Full harness passes with redacted logs and no PHI/secret leakage markers.
- **Final status:** **BLOCKED**

### PB-19 — Resource limits measured under load

- **Severity:** Medium
- **Component:** `docker-compose.limits.yml`, `docker-compose.tls.yml`, host capacity
- **Description:** CPU/memory/pids caps are conservative configuration defaults, not measurements. Caddy caps were render-validated only; no host telemetry or load test exists.
- **Current evidence:** Phase 9.6 `docker inspect` verified non-TLS containers; arithmetic: 3.75 vCPU steady, 4.50 during migration, ~8.5 GB ceiling. `p7-check-capacity.sh` covers disk/inodes only, not CPU/RAM.
- **Missing evidence:** Target host CPU/RAM/disk telemetry, migration burst observation, Caddy runtime usage, and load test at representative concurrency.
- **Exact action required:** Measure on an authorized staging/target-shaped host during a drill.
- **Production authorization required:** Yes.
- **Acceptance criteria:** Observed headroom under representative load; no OOM kills or throttling; Caddy limits exercised.
- **Final status:** **BLOCKED**

### PB-20 — Image security and provenance

- **Severity:** High
- **Component:** Compose image tags, build stage, registry artifacts
- **Description:** No image CVE scan, digest pinning, signature check, SBOM, or provenance assertion has been performed.
- **Current evidence:** Images referenced by mutable or version tags only; no scanner installed; Phase 8.2 requires owner-provided immutable digests before an approved scan.
- **Missing evidence:** Scanned image digests, CVE report, provenance/attestation, and owner acceptance of remaining findings.
- **Exact action required:** Use an approved scanner in an isolated environment against the exact digests intended for deployment; record results.
- **Production authorization required:** Yes for target deployment; scanning itself can be isolated.
- **Acceptance criteria:** Every deployed image identified by digest; scan report attached; no unaccepted High/Critical findings.
- **Final status:** **BLOCKED**

### PB-21 — RTO/RPO measurement and production-shaped restore drill

- **Severity:** Critical
- **Component:** Backup, PITR, recovery procedures
- **Description:** No production-shaped timing or restore drill exists. A five-minute RPO or any specific RTO must not be claimed.
- **Current evidence:** Synthetic 341 ms backup / 1003 ms restore (Phase 9.4); 2596 ms base backup, 1972 ms archive delay, 2491/2372 ms restore (Phase 9.5). These exclude human, transfer, provisioning, and promotion steps.
- **Missing evidence:** Authorized target-host restore drill on production-shaped synthetic data, measured end-to-end RTO and demonstrated RPO, including database-to-uploaded-file consistency.
- **Exact action required:** Execute the separate-authorization restore drill in Section 6 of `docs/PRODUCTION_READINESS_PHASE9_7.md`.
- **Production authorization required:** Yes — separate explicit approval.
- **Acceptance criteria:** Measured RTO/RPO recorded with scope and exclusions; consistency checks pass; drill report approved.
- **Final status:** **BLOCKED**

### PB-22 — CI on the exact final worktree content

- **Severity:** Medium
- **Component:** Git/CI state
- **Description:** CI is green on merged `main` (`766c889...`), but the Phase 9.4–9.7 work is uncommitted in this worktree and has not been through CI.
- **Current evidence:** Phase 9.3 CI evidence; current worktree has 40 pre-existing modified/untracked entries plus this phase's new files.
- **Missing evidence:** Commit/PR authorization and green CI on the exact final HEAD.
- **Exact action required:** Owner authorizes commit/PR; run the full CI matrix on that exact HEAD. No commit or push was performed in this phase.
- **Production authorization required:** Yes for commit/push/PR.
- **Acceptance criteria:** All required checks green on the exact deployment commit.
- **Final status:** **OPEN**

### PB-23 — Historical stale references (Phase 9.4/9.5/9.6)

- **Severity:** Low
- **Component:** `docs/PRODUCTION_READINESS_PHASE9_4.md`, `PHASE9_5.md`, `PHASE9_6.md`, older resource/CHECK-count claims
- **Description:** Older reports contain historically accurate but now stale tooling/path/threshold/arithmetic claims (old archive path, `bash`/`findmnt` description, `archive_timeout=10s` vs `300`, 4.75/5.75 vCPU and "Caddy uncapped", "45 CHECK constraints" vs verified 43).
- **Current evidence:** Phase 9.6 already flagged Phase 9.5 as historical drift; this register and `docs/PRODUCTION_READINESS_PHASE9_7.md` add a clearly labeled historical clarification section without rewriting test claims. The additional audit found `docs/monitoring-runbook.md` lacks a PITR section; that omission is also recorded under PB-08/PB-29 and is covered by the Phase 9.7 clarification, not by rewriting historical reports.
- **Missing evidence:** None for the clarification itself; historical evidence remains unchanged by design.
- **Exact action required:** Use `docs/backup-restore.md` as the current operational reference and the Phase 9.7 clarification section for interpretation.
- **Production authorization required:** No.
- **Acceptance criteria:** Clarification present; no prior report result altered.
- **Final status:** **CLOSED**

### PB-24 — Repository invariant preflight

- **Severity:** Low
- **Component:** `scripts/p97-readiness-preflight.sh` (added in this phase)
- **Description:** Repository-only readiness invariants were not consolidated into one fail-closed read-only check.
- **Current evidence:** New script added; `bash -n` passed; executed successfully with `RESULT PASS`; verifies nine migrations, required implementation files, corrected archive path/mount, no hardcoded UUID, mount check enabled, dry-run timer defaults, and no installed timers on this host.
- **Missing evidence:** None for this repository-only item.
- **Exact action required:** None. Re-run before any future change window.
- **Production authorization required:** No.
- **Acceptance criteria:** Script exits 0 on the current repository and exits 1 on a failed invariant.
- **Final status:** **CLOSED**

### PB-25 — Weekly PITR-base timer cannot supply mandatory arguments

- **Severity:** High
- **Component:** `deploy/clinic-backup-schedule@.service`, `scripts/backup-scheduler.sh:165-167`, `scripts/pitr-base-backup.sh:66-69`
- **Description:** The dispatcher invokes `pitr-base-backup.sh` with no arguments, but that script requires `--pghost`, `--pgport`, `--pguser`, and `--wal-archive-dir`. As shipped, the Sunday job exits with usage error 2 every time.
- **Current evidence:** Phase 9.8 changed the dispatcher to supply job-specific arguments. `--pghost`, `--pgport`, `--pguser` and `--wal-archive-dir` come from explicit flags or the protected `PITR_*` / `WAL_ARCHIVE_DIR` environment contract documented in `deploy/backup.env.example`. `bash scripts/p98-backup-isolated-test.sh` proves the mandatory values are passed and that an absent value fails closed (28/28 checks for the full backup group). Commit `62be9b6`.
- **Missing evidence:** A target-host protected env file with owner-approved values, and one successful scheduled or staged run producing a real `pitr_ready=true` manifest. The isolated proof uses a stubbed producer and does not create a real base backup.
- **Exact action required:** Populate the protected env file from verified target values and run one staged `pitr-base` job with real PostgreSQL before enabling the timer. Do not install the timer as-is.
- **Production authorization required:** No for the repository correction; yes for target-host installation and the staged run.
- **Acceptance criteria:** `pitr-base` job completes successfully with a `pitr_ready=true` manifest on an authorized target-shaped host.
- **Final status:** **BLOCKED** (repository contract fixed; target-host evidence still required)

### PB-26 — Monitor state directory ownership conflict

- **Severity:** High
- **Component:** `deploy/clinic-monitor.service`, `deploy/clinic-heartbeat-check.service`, `/var/lib/clinic-monitor`
- **Description:** The monitor runs as `root:root` and writes the heartbeat file, while the heartbeat check runs as `clinc_server:clinc_server` and must `stat` it. A `0700 root:root` state directory makes the independent heartbeat check return `unknown`.
- **Current evidence:** Phase 9.8 sets `Group=clinc_server` and `UMask=0007` on `clinic-monitor.service`, runs `clinic-heartbeat-check.service` as `clinc_server:clinc_server`, and documents the `0750 root:clinc_server` state directory in `deploy/monitor.env.example` and `docs/monitoring-runbook.md#monitor-state-directory`. `bash scripts/p98-monitor-isolated-test.sh` proves in a disposable container that a group member can `stat` the heartbeat while a non-member is denied (37/37 monitor checks). Commit `3ace484`.
- **Missing evidence:** Target-host creation/verification of `/var/lib/clinic-monitor` with the documented owner and mode, plus an observed heartbeat check from the real `clinc_server` account.
- **Exact action required:** Create and verify the state directory under separate authorization, then observe both services before declaring the operational path healthy.
- **Production authorization required:** No for the repository plan; yes for target-host permission changes and installation.
- **Acceptance criteria:** Heartbeat check reports `ok` from `clinc_server` while the monitor remains root-only for backup-disk reads.
- **Final status:** **BLOCKED** (repository model fixed and synthetically proved; target-host permission evidence still required)

### PB-27 — WAL-prune path lacks mount fail-closed validation

- **Severity:** High
- **Component:** `scripts/backup-scheduler.sh:57,100-103,117-159`
- **Description:** `mkdir -p "$LOG_DIR"` runs before the disk preflight and `prune_wal()` never calls the shared mount/UUID validator. If the backup disk is unmounted, the job can create directories on the root filesystem, pass a root-capacity preflight, and report "nothing pruned" with exit 0 instead of a storage outage.
- **Current evidence:** Phase 9.8 validates the mount, UUID and filesystem before creating any scheduler log directory or evaluating WAL candidates. The isolated proof shows an unmounted synthetic disk makes `wal-prune` exit non-zero, creates no log file, and deletes nothing. It also refuses when no validated `pitr_ready` base exists, when a retained base artifact is tampered with, and when `--apply` lacks `--confirm DELETE`. Commit `62be9b6`.
- **Missing evidence:** None for this repository-only fail-closed defect. Target-host installation remains covered by PB-07.
- **Exact action required:** Re-run `scripts/p98-backup-isolated-test.sh` after any scheduler change; install only under the separate change authorization.
- **Production authorization required:** No for the repository correction; yes for target-host installation.
- **Acceptance criteria:** Simulated unmounted backup disk makes the `wal-prune` job exit non-zero and delete nothing.
- **Final status:** **CLOSED** (repository-only defect; installation remains separately BLOCKED under PB-07)

### PB-28 — Dispatcher argument passthrough incompatibilities

- **Severity:** Medium
- **Component:** `scripts/backup-scheduler.sh:33-43,162-180`
- **Description:** `--dry-run` is forwarded to `backup-retention.sh`, which does not accept that flag; positional arguments are also forwarded to `backup.sh` and `pitr-base-backup.sh`, which do not accept them. An operator following the dispatcher help can get an exit-2 usage error.
- **Current evidence:** Phase 9.8 rewrote the dispatcher with explicit per-job allowlists. All five jobs (`full`, `pitr-base`, `verify`, `retention`, `wal-prune`) run with documented flags in `scripts/p98-backup-isolated-test.sh` with no usage errors; unsupported flags are rejected. Commit `62be9b6`.
- **Missing evidence:** None for this repository-only argument-contract defect. Target-host installation remains covered by PB-06/PB-07.
- **Exact action required:** Re-run the isolated proof after any dispatcher change; install only under the separate change authorization.
- **Production authorization required:** No for the repository correction; yes for target-host installation.
- **Acceptance criteria:** All five dispatcher jobs run with their documented flags and no usage errors.
- **Final status:** **CLOSED** (repository-only defect; installation remains separately BLOCKED under PB-06/PB-07)

### PB-29 — Monitoring blind spots in shipped configuration

- **Severity:** Medium
- **Component:** `deploy/monitor.env.example`, `docker-compose.monitoring.yml`, `scripts/p7-monitor.sh:90-105,129-137`, `scripts/p7-check-time.sh`, `scripts/p7-check-containers.sh`
- **Description:** `P7_CERT_FILES` is missing from the shipped env/compose config although `cert` is a default check, so that check reports `unknown`. The time check can stay `ok` when `timedatectl` is unavailable. Check exit codes are discarded and only JSON lines are forwarded, so a crashing check can be invisible. The per-window alert cap is ineffective because the counter is reset on every send path. `docker inspect` failure substitutes default health values.
- **Current evidence:** Phase 9.8 adds `P7_CERT_FILES`, additive `P7_CERT_ENDPOINTS`, thresholds and a bounded timeout to both `deploy/monitor.env.example` and `docker-compose.monitoring.yml`; the certificate check supports local public files and explicitly configured TLS endpoints with no DNS/ACME call or private-key read. The time and container checks now fail closed, non-emitting crashing checks produce a visible alert, and the monitor uses a global per-window counter with per-check dedup. `scripts/p98-monitor-isolated-test.sh` reports 37/37 including fault injection and a local synthetic TLS endpoint. Commit `3ace484`.
- **Missing evidence:** Target-host values for the protected env file, an actually configured certificate source, and an observed alert/heartbeat drill. No real endpoint was contacted in this phase.
- **Exact action required:** Populate the protected monitor env from approved target values, create the state directory under PB-26, then run the synthetic alert and heartbeat drill before sign-off.
- **Production authorization required:** No for the repository correction; yes for target-host configuration and installation.
- **Acceptance criteria:** No unintended `unknown` on a correctly configured host; injected check crash produces an alert; alert cap enforced.
- **Final status:** **BLOCKED** (repository config/hardening fixed; target-host configuration evidence still required)

### PB-30 — Scheduled verification does not cover PITR base artifacts

- **Severity:** Medium
- **Component:** `scripts/backup-scheduler.sh:107-115,168-173`, `scripts/p7-check-pitr.sh`
- **Description:** The scheduler's `verify` job selects only logical format-3/4 manifests; the PITR check validates age, WAL range, and sidecars but not the base artifact's own SHA-256/size. A corrupted base artifact can therefore pass scheduled verification.
- **Current evidence:** Phase 9.8 added `scripts/verify-pitr-base.sh` and wired it into the scheduler `verify` job. It checks `base_sha256`, `base_bytes`, `SHA256SUMS`, the full multi-line required WAL list, and every WAL sidecar. `scripts/p98-backup-isolated-test.sh` now reports 30/30, including a direct verifier run against a tampered synthetic base that fails closed and names the SHA-256 mismatch. WAL pruning also refuses the same tampered base. Commits `62be9b6`, `f84d358`.
- **Missing evidence:** None for this repository-only coverage defect. A real target-host PITR base must still pass this verifier under PB-03/PB-11 installation gates.
- **Exact action required:** Re-run the isolated proof after any verifier change and execute the verifier against the first real target-host base under separate authorization.
- **Production authorization required:** No for the repository correction; yes for the target-host gate.
- **Acceptance criteria:** A tampered base artifact is detected by a scheduled or mandatory manual check before deployment.
- **Final status:** **CLOSED** (repository-only coverage defect; real base verification remains separately BLOCKED under PB-03)

### PB-31 — Dispatcher unit path mismatch and silent overlap skips

- **Severity:** Medium
- **Component:** `deploy/clinic-backup-schedule@.service`, `deploy/clinic-monitor.service`, `scripts/backup-scheduler.sh:64-72`
- **Description:** Backup and monitor units used conflicting repository roots, and the dispatcher had no `[Install]` section, no `OnFailure=`, and treated `flock -n` contention as a successful skip; with `Persistent=true` and 10-minute jitter, a slow job could silently suppress another job's run.
- **Current evidence:** Phase 9.8 reconciled every active unit to the single approved root `/opt/clinic`, added an `[Install]` section, an `OnFailure=clinic-backup-alert@%i.service` target and a dedicated journal-only alert unit, and made repeated lock contention emit a structured monitor alert and fail closed. `scripts/p98-backup-isolated-test.sh` proves the overlap path (exit 75 plus structured alert), and `scripts/p97-readiness-preflight.sh` enforces the single root and unit invariants. Commit `62be9b6`.
- **Missing evidence:** Owner approval of `/opt/clinic` as the target-host checkout root; target-host installation and a scheduled overlap/failure drill.
- **Exact action required:** Confirm the single root on the target host, install the reconciled units under explicit authorization, and verify that a forced overlap produces a visible alert.
- **Production authorization required:** No for the plan; yes for target-host installation.
- **Acceptance criteria:** All units reference one approved path; an overlap skip produces a visible alert or documented acceptable outcome.
- **Final status:** **BLOCKED** (repository reconciliation proved; owner path approval and target-host drill still required)

## 3. Counts by status

| Status | Count |
|---|---:|
| CLOSED | 6 (PB-11, PB-23, PB-24, PB-27, PB-28, PB-30) |
| OPEN | 2 (PB-15, PB-22) |
| BLOCKED | 23 (PB-01–10, PB-12–14, PB-16–21, PB-25, PB-26, PB-29, PB-31) |
| ACCEPTED RISK | 0 |

No Production blocker is CLOSED on documentation or assumption alone. The six CLOSED items are repository-only corrections with local synthetic evidence; none authorizes a target-host operation. PB-25, PB-26, PB-29 and PB-31 have corrected repository code/config but remain BLOCKED because their own acceptance criteria require target-host values, installation, or an observed drill. A repository-only PASS must never be presented as Production readiness.

## 4. Sign-off rule

The final acceptance gate remains **PARTIAL** until every BLOCKED item has target-host evidence and every OPEN item has an owner decision. Deployment requires a separate explicit approval after this register is updated with that evidence.

## 5. Phase 9.8 repository remediation changelog

| Commit | Scope | Evidence |
|---|---|---|
| `93509a2` | PB-11 — removed unsafe migration-ledger SQL from the live rollback helper, updated the live rollback runbook, and marked the historical Phase M quote as `UNSAFE / SUPERSEDED`. | `scripts/p97-readiness-preflight.sh` fails on an unmarked reintroduction; no `migration.sql` or schema file changed. |
| `62be9b6` | PB-25/27/28/30/31 — job-specific dispatcher arguments, protected PITR env contract, fail-closed mount and WAL-prune gating, PITR base hash/size verification, single `/opt/clinic` root, `OnFailure` notification, visible overlap alerts. | `bash scripts/p98-backup-isolated-test.sh` (30/30 after the follow-up below); repository preflight PASS. |
| `3ace484` | PB-26/29 — monitor state ownership model, additive certificate file/endpoint checks, fail-closed time and container checks, global alert cap, crashing-check visibility, config keys in env/compose templates. | `bash scripts/p98-monitor-isolated-test.sh` (37/37) including a disposable Linux-user permission proof and local synthetic TLS endpoint; no real endpoint contacted. |
| `f84d358` | PB-30 — direct scheduled-verifier proof against a tampered PITR base artifact. | Isolated verifier exits non-zero and reports `SHA-256 mismatch`; backup suite result becomes 30/30. |
| final documentation commit | Register statuses/counts, live runbooks, and `docs/PRODUCTION_READINESS_PHASE9_8.md`. | Repository-only report; no target-host or CI claim. |

All commits are local on `fix/phase9-8-operational-defects`. Nothing was pushed, no PR or merge was created, `main` was not modified, and no unit, timer, cron job, or external notification was installed or enabled.
