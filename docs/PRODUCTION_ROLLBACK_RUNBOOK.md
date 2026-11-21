# Phase 9.7 — Production Rollback Runbook

**Date:** 2026-11-21  
**Status:** DRAFT — awaiting owner approval. This document does **not** authorize rollback, restore, or any other Production action.  
**Assessment branch / HEAD:** `fix/phase9-remediation` @ `a828bcf0efed9e061f9fb4fbd32d496d63c28309`  
**Companion documents:** `docs/PRODUCTION_DEPLOYMENT_RUNBOOK.md`, `docs/PRODUCTION_READINESS_PHASE9_7.md`, `docs/PRODUCTION_BLOCKER_REGISTER.md`, `docs/backup-restore.md`

> The Phase 9.7 verdict is **PARTIAL**. Every procedure below requires a named approval, a recorded change ID, and evidence preservation. No rollback, restore, database query, WAL cleanup, container restart, DNS change, certificate change, or other Production operation was performed while preparing this document.

---

## 1. Non-negotiable rules

1. **Never restore an older database over a newer database as a routine rollback.** A full restore overwrites transactions created after the backup. Default to an application rollback, a forward fix, or an isolated PITR/data-export reconciliation.
2. **Application rollback and database rollback are different decisions.** Application rollback redeploys a previous reviewed artifact/configuration. It does not undo committed schema or data changes.
3. **Never edit `_prisma_migrations` directly.** Use `prisma migrate resolve --rolled-back` or `--applied` only after verifying actual database state, or author a new forward migration. The `DELETE FROM "_prisma_migrations"` text in the historical migration rollback file is unsafe and must not be followed.
4. **Never bypass fail-closed checks.** Do not set `WAL_ARCHIVE_SKIP_MOUNT_CHECK=1`, `BACKUP_*_SKIP_MOUNT_CHECK=1`, or equivalent test overrides on a Production host.
5. **Never delete backups, WAL segments, logs, or evidence during an incident** unless a separate, recorded owner decision authorizes it.
6. **Never place patient data, private keys, tokens, cookies, phone numbers, QR payloads, or raw request bodies in tickets or chat.**
7. **Never promote an isolated restore target to Production** without a separate written decision and a current-state backup of the database being replaced.
8. **Stop and escalate when the trigger is a suspected PHI exposure.** Incident containment takes priority over restoring service.

---

## 2. Roles and escalation

| Role | Decision authority |
|---|---|
| **Change Owner (CO)** | Declares rollback, approves scope, accepts data loss if any, and signs closure. |
| **Database Owner (DBO)** | Decides migration ledger state, schema compatibility, PITR target/time, and any database restoration. |
| **Application Owner (AO)** | Confirms previous artifact compatibility and performs application/config rollback. |
| **Infrastructure Operator (IO)** | Handles Compose, containers, storage, DNS, and TLS changes. |
| **Backup/Recovery Operator (BRO)** | Produces backup IDs, verifies manifests, manages escrowed keys, and runs isolated restore/PITR. |
| **Security Owner (SO)** | Owns secrets, exposure assessment, log review, and credential rotation. |
| **Monitoring Owner (MO)** | Confirms alert delivery, heartbeat, and failure visibility. |
| **Privacy/Incident Owner** | Required for suspected patient-data exposure; co-signs containment and notification decisions. |

Escalate immediately to CO + DBO for any committed migration, destructive schema change, data corruption, failed restore, or PHI exposure. Escalate to SO + Privacy/Incident Owner before any action involving potentially exposed patient data.

---

## 3. Application versus database rollback

| Situation | Application rollback | Database rollback | Default action |
|---|---|---|---|
| Bad image/config, schema unchanged | Yes, to prior reviewed artifact and env | No | Redeploy previous app artifact; keep database. |
| Bad image/config after migration committed | Only if prior app is compatible with new schema | Only if data/schema corruption proven | DBO + AO decide; prefer forward fix. |
| Failed migration transaction | Yes, if needed after verification | Usually no; transaction should be atomic | Verify catalog/ledger, then decide. |
| Destructive migration #6/#7 committed | Cannot recover dropped columns/table by app rollback | Requires isolated restore/PITR and data reconciliation | Do not overwrite live DB; preserve current state first. |
| Invalid/corrupt data | May reduce further writes | Isolated PITR/restore or forward repair | Freeze writers, quantify, then owner decision. |
| WAL/backup failure without data loss | Not required | Not required | Fix storage/archive path; RPO remains unclaimed until proven. |
| TLS/auth outage | Often config/secret rollback | No | Restore prior protected config; rotate only with approval. |

**Application rollback procedure (only with CO approval):**

1. Identify the last known-good commit SHA, image digests, and protected env version.
2. Confirm with DBO that the previous artifact is compatible with the current schema.
3. Redeploy only the application/proxy services using the previously approved Compose files and digests.
4. Do not roll back `db`, `db_data`, `clinic_storage`, or `evolution_instances` as a routine step.
5. Verify `/healthz`, migration status, logs, and user-facing smoke tests.

**Database rollback procedure (only with CO + DBO approval):**

1. Take a fresh backup of the current database state before any restorative action.
2. Verify the chosen backup/PITR set and key material.
3. Restore only into a new, explicitly confirmed isolated target using `restore-backup.sh` or `pitr-restore.sh`.
4. Reconcile row counts, constraints, file checksums, and the exact point-in-time requirement.
5. If replacement is still approved, use a separately signed procedure that names the target, point in time, data-loss acceptance, and current-state backup ID. Never overwrite a newer Production database with an older one by default.

---

## 4. Evidence preservation checklist

For every rollback trigger, capture before changing anything:

- Change ID; UTC timestamps; operator and approver names; affected services.
- Trigger signal, first observed time, and user/business impact.
- `docker compose ps`, container IDs/images/digests, restart counts, and health status.
- Redacted logs covering the failure window; never copy PHI into the record.
- `/healthz` and `/api/v1/readyz` payloads; audit `writeFailures` value.
- Migration status, applied migrations, catalog state for the affected constraints/indexes, and exact error codes such as `P3018`/`23514`.
- Backup ID, `MANIFEST.txt` hash, `SHA256SUMS` result, and isolated restore evidence.
- WAL segment names, sidecar validation results, mount UUID/filesystem/capacity, and archiver exit/retry lines.
- TLS certificate fingerprint/serial, DNS records, and browser/proxy error class.
- Alert IDs, heartbeat state, and delivery confirmations.

Preserve evidence in the approved change record and approved log store. Do not delete or rewrite logs to "clean up" an incident.

---

## 5. Common containment steps

Apply before the scenario-specific procedure unless the trigger itself requires immediate incident containment:

1. Announce the rollback decision through the approved channel; name the CO and DBO.
2. Freeze further deployments, migrations, WAL pruning, retention deletion, and secret rotation unless specifically authorized.
3. Stop new application writes if continued writes would worsen the corruption or data-loss window; never stop `db` as a routine rollback step.
4. Capture Section 4 evidence.
5. Decide whether public traffic should be paused. Prefer pausing Caddy at the approved proxy layer over exposing internal services.
6. Choose the narrowest rollback that resolves the trigger: config, application artifact, schema reconciliation, or isolated data recovery.

---

## 6. Scenario procedures

### R1 — Failed Compose deployment

- **Trigger:** Container restart loop, unhealthy `db`/`backend`, failed `migrate` gate, unexpected public port, or startup failure after `docker compose up -d --build`.
- **Immediate containment:** Stop further `up`/`restart` attempts after one investigated retry. Keep `db` running. Record container status and redacted logs.
- **Application rollback:** With CO approval, redeploy the last known-good commit/image digests and protected env version. Do not change schema or volumes.
- **Database rollback:** None unless DBO proves migration or data damage.
- **Recovery/verification:** Confirm `docker compose ps`, `/healthz`, migration status, no failed migration row, expected listeners, and no PHI in logs.
- **Abort/escalation:** Abort if the database is unhealthy, a public bind changed unexpectedly, or the previous artifact is incompatible with the current schema. Escalate to CO + DBO + IO.
- **Evidence:** Compose diff, image IDs/digests, exit codes, health payloads, and the last known-good artifact record.

### R2 — Failed migration

- **Trigger:** `prisma migrate deploy` exits non-zero, `P3018`/`23514`, lock timeout, OOM, partial DDL suspicion, or failed `_prisma_migrations` row.
- **Immediate containment:** Do not start application services against an uncertain schema. Do not retry blindly. Record the migration name and exact error.
- **Application rollback:** Return the application to the last known-good artifact only after DBO confirms schema compatibility.
- **Database rollback:** Normally none: migration #8 validation failures should roll back atomically. Verify the catalog for the expected constraints/indexes and check `_prisma_migrations` state. If DDL is absent but a failed row exists, use:
  ```bash
  npx prisma migrate resolve --rolled-back <MIGRATION_NAME>
  ```
  If DDL is present but the ledger row is missing/invalid, use:
  ```bash
  npx prisma migrate resolve --applied <MIGRATION_NAME>
  ```
  Never edit `_prisma_migrations` with SQL. To intentionally remove applied constraints, author a new forward migration.
- **Recovery/verification:** Confirm 43 CHECK constraints and four indexes as applicable; confirm no failed migration row; verify application health and smoke tests.
- **Abort/escalation:** Abort if DDL state and ledger cannot be reconciled, or if migration #6/#7 committed and dropped data. Escalate to DBO + CO before any restore.
- **Evidence:** Full migration output, violation query results, catalog query output, backup ID, and ledger state.

### R3 — Invalid or corrupt data discovered after migration

- **Trigger:** Application errors, reconciliation mismatch, or read-only query finds invalid rows after a migration or deployment.
- **Immediate containment:** Freeze writers if safe; stop batch jobs; preserve the current database state with a fresh verified backup before any repair.
- **Application rollback:** Optional only if it prevents further invalid writes and remains schema-compatible.
- **Database rollback:** Prefer a forward repair migration or application-level correction. If data must be reconstructed, restore or PITR into an isolated target and export the corrected rows after DBO comparison. Do not restore an older backup over the newer Production database as a reflex.
- **Recovery/verification:** Re-run all affected read-only validation queries; verify constraints/indexes; reconcile row counts, per-file storage checksums, and audit trail continuity.
- **Abort/escalation:** Abort if the corruption scope is unknown or if dropped data from migration #6/#7 is involved. Escalate to CO + DBO; privacy review if patient records may be affected.
- **Evidence:** Query outputs with row IDs only as needed for repair, counts, timestamps, backup ID, and isolated restore/PITR report.

### R4 — WAL archiving failure

- **Trigger:** Archiver exit non-zero, WAL backlog/freshness alert, missing sidecar, low space, or invalid mount detection.
- **Immediate containment:** Treat RPO as unbounded until proven otherwise. Do not disable `archive_mode`, skip mount checks, or delete WAL manually.
- **Application rollback:** None for an archive failure alone.
- **Database rollback:** None for an archive failure alone.
- **Recovery/verification:** Inspect mount, UUID, filesystem, free space, ownership, helper path, and PostgreSQL retry logs on an authorized host. Fix the storage/path issue, confirm segments are archived with valid SHA-256 sidecars, and run `p7-check-wal.sh`/`p7-check-pitr.sh`. If writes must stop to protect an RPO decision, CO authorizes the stop.
- **Abort/escalation:** Abort any PITR-dependent deployment if PB-01/PB-02/PB-03 are not closed. Escalate to BRO + DBO + IO.
- **Evidence:** Archiver stderr, retry lines, segment names, sidecar checks, `df`/`findmnt`/`stat` output, and alert timeline.

### R5 — Missing or corrupt WAL

- **Trigger:** Required WAL segment absent, size mismatch, invalid sidecar name/content, checksum failure, or a base set not marked `pitr_ready=true`.
- **Immediate containment:** Mark the affected set unsuitable for PITR. Do not run `pitr-restore.sh` against it. Preserve the suspect segment and sidecar; do not overwrite or delete them.
- **Application rollback:** None solely because of a bad WAL set.
- **Database rollback:** None. Do not promote any target recovered from incomplete WAL.
- **Recovery/verification:** After the archive path is repaired and validated, create a fresh PITR base set with explicit arguments, verify every required segment and sidecar, and confirm monitor status `ok`. Review pruning dry-run output before any deletion, and never prune segments required by a retained base.
- **Abort/escalation:** Abort PITR-dependent cutover. Escalate to BRO + DBO; second approval required for any pruning deletion.
- **Evidence:** Manifest, required WAL range, sidecar contents/checksums, file sizes, timestamps, and the decision marking the set unusable.

### R6 — Failed restore

- **Trigger:** `restore-backup.sh` or `pitr-restore.sh` exits non-zero, checksum/decryption failure, invalid manifest, connection failure, or verification mismatch in the isolated target.
- **Immediate containment:** Do not promote the target. Do not retry against the same target path. The scripts remove a target they created on failure; preserve logs before any cleanup.
- **Application rollback:** None; Production application was not the restore target.
- **Database rollback:** None. Restores are to isolated targets only. Never point a restore script at the Production database, `db` service, port `55432`, or a production-like path.
- **Recovery/verification:** Verify key escrow, manifest, `SHA256SUMS`, plaintext hashes, base artifact hash, and required WAL range. Retry only into a new, confirmed disposable target with a corrected input.
- **Abort/escalation:** Abort if the backup set is corrupt, the key is unavailable, or the failure reason is unknown. Escalate to BRO + DBO.
- **Evidence:** Restore command with secrets redacted, exit code, validation stage failure, key identifier (not key material), and target path.

### R7 — Disk exhaustion

- **Trigger:** Capacity alerts at 70/85/95 %, backup preflight failure, archiver low-space failure, `pg_wal` growth, or inode exhaustion.
- **Immediate containment:** Stop new backup jobs and retention/pruning mutations. Do not delete artifacts to regain space. Determine whether the backup/WAL mount or the database volume is affected.
- **Application rollback:** None unless writes are worsening volume exhaustion; CO may authorize temporary writer quiescence.
- **Database rollback:** None as a reflex. If the database volume is full, DBO handles it as a database incident.
- **Recovery/verification:** Obtain approved capacity increase or cleanup decision. Preserve the newest valid backup, PITR base, and newest WAL segments. After capacity is restored, rerun verifier and monitor checks. Any deletion requires a second written approval naming exact artifacts and dependency checks.
- **Abort/escalation:** Abort deployment/migration while capacity preflights fail. Escalate to IO + BRO + DBO + CO.
- **Evidence:** `df -h`, `df -i`, `findmnt`, affected directory inventory, preflight output, and owner-approved capacity decision.

### R8 — TLS failure

- **Trigger:** Invalid/untrusted certificate, ACME failure, HTTP not redirecting, missing HSTS, wrong domain, browser trust error, or unexpected public listener.
- **Immediate containment:** Pause public traffic at the approved proxy/firewall layer if PHI could be exposed. Keep `web` and `db` bound to loopback. Do not set `tls internal` in Production without explicit owner approval.
- **Application rollback:** Restore the last approved Caddyfile/TLS overlay configuration and protected env values; keep `APP_ORIGIN=https://<APPROVED_DOMAIN>` and `COOKIE_SECURE=true`.
- **Database rollback:** None.
- **Recovery/verification:** Verify DNS ownership/resolution, certificate chain and expiry, redirect, HSTS, secure cookies, proxy routing, and spoof resistance. Confirm no secret was logged.
- **Abort/escalation:** Abort if domain control is unverified or client-supplied forwarded headers influence `req.ip`. Escalate to SO + IO.
- **Evidence:** Certificate fingerprint/serial, DNS records, browser/proxy error class, Caddy/nginx config diff, and redacted access logs.

### R9 — Auth outage

- **Trigger:** Login/session failures, backend refusing to start on production guards, JWT secret mismatch, DB authentication failure, or Evolution API key failure.
- **Immediate containment:** Do not disable production guards, log secrets, or reuse placeholder values. Pause public traffic if authentication cannot be trusted.
- **Application rollback:** Restore the last approved protected env file and application/Evolution artifact, then restart only affected application services. If a secret may have been exposed, SO approves rotation and invalidates affected sessions.
- **Database rollback:** None for configuration/secret failure. If DB password rotation caused the outage, DBO coordinates the exact credential change; do not alter database users ad hoc.
- **Recovery/verification:** Verify health endpoints, a synthetic login/logout flow, cookie attributes, audit events, and that secrets remain out of logs and tickets.
- **Abort/escalation:** Abort if session integrity is uncertain or secrets were exposed. Escalate to SO + AO + DBO as applicable.
- **Evidence:** Guard failure messages with secrets redacted, env version identifier, rotation decision, and synthetic auth test result.

### R10 — Suspected patient-data exposure

- **Trigger:** PHI appears in logs/tickets/screenshots, unauthorized access is suspected, public endpoint returns patient data, credential leak, or any report of possible patient-data exposure.
- **Immediate containment:** Declare an incident. Stop the suspected exposure path through the approved proxy/firewall or service stop; preserve all logs and backups. Do not delete, rewrite, or "sanitize" evidence.
- **Application rollback:** Only if it closes the exposure path and is approved by SO + CO. Never use rollback to hide evidence.
- **Database rollback:** None until scope is known. Do not overwrite databases or restore older data as a first response.
- **Recovery/verification:** Preserve evidence, identify affected records and time window, rotate exposed credentials/certs if SO approves, verify log redaction and access controls, and document notification decisions with the Privacy/Incident Owner.
- **Abort/escalation:** Always escalate to CO + SO + Privacy/Incident Owner. Do not place patient identifiers in chat, tickets, or screenshots; use hashed/minimized identifiers where needed.
- **Evidence:** Incident timeline, source/destination of exposure, minimized record identifiers, preserved logs, access-control state, and all approvals.

---

## 7. Post-rollback verification and closure

After any rollback:

1. Verify `/healthz`, `/api/v1/readyz`, container health, migration status, and audit failure count.
2. Verify TLS/proxy behavior and that no unintended listener exists.
3. Verify backup/WAL monitor status and confirm that no deletion occurred without approval.
4. Confirm no PHI or secrets appeared in logs, alerts, tickets, or change records.
5. Record whether the rollback was application-only, configuration-only, or database-involving, and list what was **not** rolled back.
6. Re-open or update the relevant blocker register entries; a successful rollback is not evidence that the original blocker is closed.
7. Obtain CO signature with the incident/change ID, final state, residual risk, and follow-up owner.

No rollback, restore, migration, WAL cleanup, deployment, or Production operation was performed in preparing this runbook.
