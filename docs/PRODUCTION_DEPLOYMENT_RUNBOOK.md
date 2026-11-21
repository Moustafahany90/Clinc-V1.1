# Phase 9.7 — Production Deployment Runbook

**Date:** 2026-11-21  
**Status:** DRAFT — awaiting owner approval. This document does **not** authorize deployment.  
**Assessment branch / HEAD:** `fix/phase9-remediation` @ `a828bcf0efed9e061f9fb4fbd32d496d63c28309`  
**Companion documents:** `docs/PRODUCTION_READINESS_PHASE9_7.md`, `docs/PRODUCTION_BLOCKER_REGISTER.md`, `docs/PRODUCTION_ROLLBACK_RUNBOOK.md`, `docs/backup-restore.md`

> **NO-GO by default.** The Phase 9.7 verdict is **PARTIAL**. Every Production action below requires a separate named approval, a recorded change window, and closure of the relevant blocker in `docs/PRODUCTION_BLOCKER_REGISTER.md`. No step was executed while preparing this runbook.

---

## 1. Scope and safety boundary

This runbook is a future procedure only. Preparation did not include Production login, database queries, migration, backup, restore, WAL pruning, container deployment, restart, DNS change, certificate issuance, timer installation, alert delivery, secret access, patient-data access, commit, push, merge, branch switch, reset, or history rewrite.

Commands shown are **patterns with placeholders**. Replace only with values supplied by the owner in the change record. Do not invent UUIDs, domains, digests, credentials, ports, or backup IDs.

Never perform these actions:

- Do not set `WAL_ARCHIVE_SKIP_MOUNT_CHECK=1` or any `BACKUP_*_SKIP_MOUNT_CHECK=1` on a Production host.
- Do not expose `web` or `db` beyond loopback. Only the TLS proxy may listen publicly.
- Do not edit `_prisma_migrations` directly. Use Prisma-native reconciliation only.
- Do not run `prisma migrate reset`, `prisma db push`, `prisma migrate dev`, or an ad-hoc destructive SQL script in Production.
- Do not restore an older database over a newer database.
- Do not expand the four-high dependency exception, upgrade Lockfiles, or change Prisma versions inside this change window.
- Do not bypass the backend's production guards (`APP_ORIGIN`, `COOKIE_SECURE`, `TRUST_PROXY`, JWT secrets, Evolution key).

---

## 2. Roles

| Role | Responsibility |
|---|---|
| **Change Owner (CO)** | Owns the change record, approvals, abort decision, and final sign-off. |
| **Infrastructure Operator (IO)** | Host, storage, Docker/Compose, DNS, TLS, timers, and monitoring installation. |
| **Database Owner (DBO)** | Migration inventory, data-validity queries, lock budget, backup verification, and database decisions. |
| **Backup/Recovery Operator (BRO)** | Backup ID, verifier output, key escrow, PITR base artifacts, and restore evidence. |
| **Security Owner (SO)** | Secrets, image scan/provenance, advisory acceptance, TLS/proxy security checks, and PHI-log review. |
| **Application Owner (AO)** | Application health, smoke tests, release artifact identity, and user-facing verification. |
| **Monitoring Owner (MO)** | Alert sink, heartbeat, state-directory permissions, and synthetic alert delivery. |

One person may not self-approve a destructive migration or a Production database restore. The CO records each approver and timestamp.

---

## 3. Global gates

Proceed only when all applicable gates hold:

| Gate | Requirement |
|---|---|
| **G-1** | Written authorization, maintenance window, named operators, and abort thresholds are recorded. |
| **G-2** | Deployment artifact is a clean, CI-green commit; exact commit SHA and image digests are recorded. |
| **G-3** | Every blocker required for this specific change is CLOSED or explicitly ACCEPTED RISK with owner signature in the register. |
| **G-4** | Fresh `backup_format=4` backup exists, `backup-verify.sh` exit 0, and an isolated restore rehearsal passed. |
| **G-5** | Migration inventory, data-validity results, table sizes, and lock budget are recorded. |
| **G-6** | WAL mount is independently verified if the PITR overlay is in scope; PB-25/PB-27 are fixed before any PITR timer runs. |
| **G-7** | Real DNS, certificate issuance plan, and approved domain are available if TLS is in scope. |
| **G-8** | Monitoring/timer defects PB-25–PB-31 are closed for any unit being installed. |
| **G-9** | `docs/PRODUCTION_ROLLBACK_RUNBOOK.md` is approved and the rollback decision owner is on standby. |

If any gate fails, stop. Do not "continue and fix later".

---

## 4. Evidence to record for every step

Create a change-record entry with:

- Change ID, UTC timestamps, operator role, and approver.
- Exact command or procedure executed, with secrets redacted.
- Exit code and relevant output summary.
- Artifact identifiers: commit SHA, image digests, backup ID, migration names, WAL segments, certificate serial/fingerprint.
- Health, migration, constraint, and proxy verification results.
- Link to the relevant blocker IDs closed or still open.

Never paste patient data, full tokens, cookies, phone numbers, QR payloads, private keys, or raw request bodies into the change record.

---

## 5. Ordered deployment steps

Each step must satisfy its expected result before the next step starts.

### Step 1 — Confirm written authorization and change window

- **Preconditions:** A numbered change record exists; CO, IO, DBO, BRO, SO, AO, and MO are named.
- **Command/procedure:** Review and sign the change record. State explicitly which actions are authorized: Compose restart, migrations, destructive migrations #6/#7, PITR overlay, DNS/TLS change, timer installation, alert delivery. Record the abort thresholds and rollback decision owner. Confirm no Production action has occurred before this authorization.
- **Expected result:** Signed authorization covers every Production action planned in Steps 2–18; scope boundaries and abort criteria are unambiguous.
- **Failure condition:** Any action lacks approval, an owner is absent, or the scope is ambiguous.
- **Abort criteria:** No approval, no named rollback owner, or an attempt to expand scope mid-window. Stop and re-authorize.
- **Responsible role:** Change Owner.

### Step 2 — Verify the exact deployment artifact and Git state

- **Preconditions:** Step 1 signed.
- **Command/procedure:** From the approved checkout, record:
  ```bash
  git status --porcelain -uall
  git rev-parse HEAD
  git log -1 --format='%H %s'
  ```
  Verify CI is green on this exact SHA, the worktree contains no unintended changes, and the deployment images correspond to this artifact. Do not commit, push, merge, switch branches, reset, or rewrite history.
- **Expected result:** Exact commit SHA and worktree state are recorded; CI evidence matches that SHA; no unapproved local change is present.
- **Failure condition:** Dirty/unexpected worktree, CI not green on the exact SHA, or image/content mismatch.
- **Abort criteria:** PB-22 remains open for the deployment commit. Stop until commit/PR and CI evidence exist.
- **Responsible role:** Application Owner + Change Owner.

### Step 3 — Run repository invariant and static checks

- **Preconditions:** Step 2 passed.
- **Command/procedure:** Run only read-only checks:
  ```bash
  bash scripts/p97-readiness-preflight.sh
  bash -n scripts/*.sh deploy/*.sh
  node scripts/secret-scan.mjs
  node --test scripts/secret-scan-regression.test.mjs
  npm --prefix backend audit --json > <change-dir>/backend-audit.json
  node scripts/dependency-audit.mjs <change-dir>/backend-audit.json
  ```
  Render every approved overlay combination with `docker compose <approved -f files> config --quiet`. Use a synthetic domain only for render validation; do not treat it as real TLS configuration.
- **Expected result:** Preflight exits 0 with the explicit "repository invariants only" limitation; shell syntax passes; secret scan has no actionable finding; dependency audit accepts exactly the documented four-high cluster; all approved Compose files render.
- **Failure condition:** Any non-zero exit, new advisory, secret finding, or render error.
- **Abort criteria:** A failed invariant indicates the repository is not the reviewed artifact. Do not repair Production configuration to compensate.
- **Responsible role:** Application Owner + Security Owner.

### Step 4 — Verify target storage, backup mount, and key escrow

- **Preconditions:** Step 3 passed; read-only target access authorized.
- **Command/procedure:** Record `findmnt`, `blkid`, `df -h`, `df -i`, and `stat` output for the approved backup mount. Verify owner-approved UUID, filesystem, capacity, `0700` permissions, and service-account access. Verify the age public recipient and demonstrate that the private key is retrievable only from approved escrow, never from the backup host.
- **Expected result:** Mount identity, capacity, permissions, and escrow procedure match the change record; no placeholder UUID is reused.
- **Failure condition:** Unmounted/incorrect filesystem, insufficient capacity, incorrect ownership, or unavailable escrow.
- **Abort criteria:** PB-04 or PB-05 not satisfied. Stop before any migration or container change.
- **Responsible role:** Backup/Recovery Operator + Infrastructure Operator.

### Step 5 — Verify WAL mount and PITR preflight if in scope

- **Preconditions:** Step 4 passed; PITR overlay change explicitly authorized.
- **Command/procedure:** Execute checks 1–14 in `docs/PRODUCTION_READINESS_PHASE9_7.md` Section 4.2. Inspect mount, UUID, filesystem, capacity, runtime UID/GID, container access, archive settings, sidecars, freshness, base age, required WAL range, retention floor, and dry-run pruning. Do not apply the overlay or force a WAL switch outside an authorized drill.
- **Expected result:** Dedicated `0700` WAL mount, valid sidecars, no `unknown` monitor status, and a reviewed dry-run pruning plan.
- **Failure condition:** Missing/corrupt WAL, failed container write probe, low capacity, or skipped mount checks.
- **Abort criteria:** PB-01/PB-02/PB-03 not closed for the in-scope host, or PB-25/PB-27 still open for scheduled jobs. Leave the overlay unapplied.
- **Responsible role:** Backup/Recovery Operator + Database Owner.

### Step 6 — Complete migration inventory and data-validity checks

- **Preconditions:** Steps 4–5 passed as applicable; read-only database access authorized.
- **Command/procedure:** Record `_prisma_migrations` names, checksums, and states. Run the read-only violation queries and catalog checks in Sections 5.2–5.5 of the readiness report, plus table-size/index queries for migration #9 and NULL-permission/attempt counts for PB-14. Verify no stale application references to objects dropped by migrations #6/#7.
- **Expected result:** Exact nine-migration inventory or owner-approved reconciliation; all 43 violation queries return zero rows; table sizes and lock budget are recorded; counts for destructive changes are recorded and accepted.
- **Failure condition:** Unexpected migration state, schema drift, violating rows, oversized tables without a lock window, or stale code references.
- **Abort criteria:** PB-09, PB-10, PB-12, PB-13, or PB-14 unresolved for the target data. Do not start migration.
- **Responsible role:** Database Owner + Application Owner.

### Step 7 — Close security, image, DNS, and TLS prerequisites

- **Preconditions:** Step 6 passed.
- **Command/procedure:** Record exact image digests, scan report, provenance/attestation, and owner acceptance of residual findings. Verify the approved domain, DNS A/AAAA records, certificate issuance path, and the production guard values: `APP_ORIGIN=https://<APPROVED_DOMAIN>`, `COOKIE_SECURE=true`, `TRUST_PROXY=1`, distinct random JWT secrets, and a real Evolution API key. Verify the four-high Prisma exception has a signed acceptance or remediation plan.
- **Expected result:** Every deployed image identified by digest with an accepted scan; domain/DNS approved; production guards correct; PB-15 and PB-20 accepted or closed.
- **Failure condition:** Mutable/unscanned image, unaccepted High/Critical CVE, placeholder secret, HTTP origin, or unapproved domain.
- **Abort criteria:** No owner acceptance for the advisory cluster or image findings; no authoritative domain control. Stop before TLS or container changes.
- **Responsible role:** Security Owner + Infrastructure Operator.

### Step 8 — Validate host capacity and resource budgets

- **Preconditions:** Step 7 passed.
- **Command/procedure:** Record host CPU, RAM, disk, inode, and container telemetry. Confirm the limits-overlay budget: 3.75 vCPU steady, 4.50 during migration, about 8.5 GiB container memory ceiling. Verify disk/inode thresholds and Caddy runtime caps on an authorized target-shaped host. Do not assume synthetic numbers apply.
- **Expected result:** Observed headroom under representative load; no OOM kills or throttling; Caddy caps exercised if TLS is in scope.
- **Failure condition:** Resource exhaustion, missing telemetry, or an untested Caddy configuration.
- **Abort criteria:** PB-19 unresolved for the deployment host. Do not apply limits as a substitute for capacity evidence.
- **Responsible role:** Infrastructure Operator + Application Owner.

### Step 9 — Fix and prepare scheduler/monitoring configuration

- **Preconditions:** Step 8 passed.
- **Command/procedure:** Resolve PB-25–PB-31 in the reviewed artifact: PITR-base mandatory arguments, monitor state ownership, WAL-prune mount validation, dispatcher argument contract, `P7_CERT_FILES`, verifier crash visibility, alert cap, fail-open fallbacks, single repository path, failure notification, and visible overlap skips. Prepare protected `/etc/clinic/*.env` files with owner-approved values and mode `0600`. Do not install units in this step.
- **Expected result:** Reviewed configuration passes isolated fault-injection tests; all referenced paths agree; no populated env file is committed.
- **Failure condition:** Any shipped scheduler defect remains for a unit that will run, or a state-directory permission conflict remains.
- **Abort criteria:** A timer would run with broken arguments or without mount fail-closed behavior. Do not install it.
- **Responsible role:** Infrastructure Operator + Monitoring Owner.

### Step 10 — Take and verify the fresh pre-change backup

- **Preconditions:** Steps 4 and 9 passed; backup window authorized.
- **Command/procedure:** With writers quiesced by default and `db` never in the quiesce list, take a format-4 backup:
  ```bash
  ./scripts/backup.sh
  ./scripts/backup-verify.sh <SET_DIR>
  ```
  Decrypt in an isolated rehearsal target using only escrowed key material; reconcile database row counts and per-file storage checksums. Record `backup_id`, `backup_format=4`, `encryption_status=encrypted`, `SHA256SUMS`, verifier exit 0, and restore evidence.
- **Expected result:** A current, verified backup exists inside the change window and was successfully restored in isolation.
- **Failure condition:** Non-zero verifier, incomplete manifest, checksum mismatch, failed isolated restore, or writer drift without explicit test acknowledgement outside Production.
- **Abort criteria:** PB-04/PB-05/PB-21 not satisfied for this change. Stop before migration.
- **Responsible role:** Backup/Recovery Operator + Database Owner.

### Step 11 — Create and validate an optional PITR base set

- **Preconditions:** Step 10 passed; PITR explicitly authorized; PB-25 fixed.
- **Command/procedure:** After the WAL archive is enabled in an approved window, run the reviewed invocation with explicit arguments (not the broken no-argument timer):
  ```bash
  ./scripts/pitr-base-backup.sh \
    --pghost <APPROVED_PG_HOST> --pgport <APPROVED_PG_PORT> \
    --pguser <APPROVED_PG_USER> --pgdatabase <APPROVED_DB> \
    --wal-archive-dir <APPROVED_WAL_DIR> --backup-root <APPROVED_BACKUP_ROOT> \
    --tier daily [--age-recipient <AGE_PUBLIC_RECIPIENT>]
  ./scripts/p7-check-pitr.sh   # with target-host monitor environment
  ```
- **Expected result:** Manifest is `backup_format=pitr-base-1` with `pitr_ready=true`; required WAL range, sidecars, base artifact hash, and size all validate; monitor reports `ok`.
- **Failure condition:** Missing WAL, invalid sidecar, base hash mismatch, or `pitr_ready=false`.
- **Abort criteria:** Any PITR set not fully validated may not be used as a recovery point. Do not mark it ready or prune WAL against it.
- **Responsible role:** Backup/Recovery Operator.

### Step 12 — Freeze and approve the final Compose configuration

- **Preconditions:** Steps 6–11 passed as applicable.
- **Command/procedure:** Write the final overlay list into the change record. Example for an approved TLS + limits deployment:
  ```bash
  COMPOSE_FILES="-f docker-compose.yml -f docker-compose.tls.yml -f docker-compose.limits.yml"
  docker compose $COMPOSE_FILES config > <change-dir>/rendered-compose.yaml
  docker compose $COMPOSE_FILES config --quiet
  ```
  Add `-f docker-compose.pitr.yml` only with separate PITR approval. Confirm `WEB_BIND`/`POSTGRES_BIND` remain loopback and only Caddy publishes `80`/`443`. Diff the rendered config against the previously approved version and obtain CO signature.
- **Expected result:** Rendered config matches the approved topology; no unexpected listener, mount, command, or environment value; CO signature recorded.
- **Failure condition:** Wrong bind, unexpected public port, missing approved overlay, stale env value, or unreviewed diff.
- **Abort criteria:** Any network-exposure change not explicitly approved. Stop before stopping services.
- **Responsible role:** Infrastructure Operator + Security Owner + Change Owner.

### Step 13 — Announce the window and quiesce application writers

- **Preconditions:** Step 12 signed; rollback team on standby.
- **Command/procedure:** Announce the maintenance window. Capture current `docker compose ps`, health payloads, recent redacted logs, current migration state, and the pre-change backup ID. Stop application writers only:
  ```bash
  docker compose $COMPOSE_FILES stop backend web evolution caddy
  ```
  Never include `db` in the writer list. Confirm writes are stopped and record the time.
- **Expected result:** Application writers stopped; database remains healthy; pre-change evidence captured.
- **Failure condition:** A writer refuses to stop, database health fails, or evidence capture is incomplete.
- **Abort criteria:** Loss of database health or inability to establish a quiesced state. Follow the rollback runbook; do not proceed to migration.
- **Responsible role:** Infrastructure Operator + Application Owner.

### Step 14 — Execute the approved migration window

- **Preconditions:** Step 13 passed; fresh verified backup ID recorded; explicit approval for each destructive migration.
- **Command/procedure:** Run the one-shot migration service only:
  ```bash
  docker compose $COMPOSE_FILES run --rm migrate
  ```
  Record full redacted output and exit code. On failure, stop; verify catalog state and use Prisma-native reconciliation only. Never retry blindly, never edit `_prisma_migrations`, and never use `migrate reset`, `db push`, or `migrate dev`.
- **Expected result:** `prisma migrate deploy` exits 0; post-deploy catalog shows 43 CHECK constraints convalidated and four indexes present; no failed migration row.
- **Failure condition:** Any non-zero exit, `P3018`/`23514`, lock timeout, OOM, partial DDL, or failed migration row.
- **Abort criteria:** Data violation, failed destructive migration, or unresolved ledger state. Invoke the rollback runbook; do not start application services against an uncertain schema.
- **Responsible role:** Database Owner.

### Step 15 — Apply the approved overlay set and start the stack

- **Preconditions:** Step 14 passed; final config still matches Step 12.
- **Command/procedure:** Start the exact approved combination:
  ```bash
  docker compose $COMPOSE_FILES up -d --build
  ```
  If the PITR overlay is first being enabled, perform the controlled database restart only inside this authorized window and verify `archive_mode`, `wal_level`, and `archive_command`. Start the monitoring service only with its profile if approved:
  ```bash
  docker compose $COMPOSE_FILES -f docker-compose.monitoring.yml \
    --profile monitoring up -d clinic-monitor
  ```
  Do not start unapproved profiles or services.
- **Expected result:** All expected containers are running or completed successfully; `migrate` completed; `db` healthy; only Caddy is public; WAL archiver starts without skipped mount checks if in scope.
- **Failure condition:** Restart loop, unhealthy `db`/`backend`, failed migration gate, unexpected container, or public bind outside Caddy.
- **Abort criteria:** Failed startup after one investigated attempt, or any exposure change. Follow the failed-Compose-deployment rollback procedure.
- **Responsible role:** Infrastructure Operator.

### Step 16 — Verify application health, schema, and logs

- **Preconditions:** Step 15 completed.
- **Command/procedure:** From the approved HTTPS origin, verify:
  ```bash
  curl -fsS https://<APPROVED_DOMAIN>/healthz
  curl -fsS https://<APPROVED_DOMAIN>/api/v1/readyz
  docker compose $COMPOSE_FILES ps
  docker compose $COMPOSE_FILES logs --since 30m backend
  ```
  Re-check migration status and catalog expectations. Confirm structured logs contain no PHI, query strings, tokens, cookies, or raw headers.
- **Expected result:** `/healthz` returns `status: ok` and `database: reachable`; audit write-failure count is unchanged; migrations clean; constraints/indexes present; logs redacted.
- **Failure condition:** 503/5xx responses, unhealthy containers, `audit.writeFailures` increase, missing constraints/indexes, or PHI/secret leakage in logs.
- **Abort criteria:** Database unreachable, audit write failure, or PHI exposure. Stop public traffic and invoke the rollback/incident procedure.
- **Responsible role:** Application Owner + Database Owner + Security Owner.

### Step 17 — Verify TLS, proxy, cookies, and spoof resistance

- **Preconditions:** Step 16 passed and real DNS/certificate are in place.
- **Command/procedure:** Verify HTTP→HTTPS permanent redirect, certificate chain and expiry, HSTS header, Caddy→nginx→backend routing, `/api/v1` behavior, 32 MB upload limit, secure cookie attributes, and that nginx is not directly reachable. Inject client-supplied `X-Forwarded-For`, `X-Real-IP`, and `X-Forwarded-Proto` and confirm `req.ip` is derived from Caddy's trusted hop only. Run a synthetic PHI-log probe.
- **Expected result:** Trusted HTTPS origin; permanent redirect; HSTS present; cookies `httpOnly`, `SameSite=Lax`, `secure`; spoofed forwarded headers ignored; no PHI/secret in logs.
- **Failure condition:** Untrusted certificate, HTTP fallback, missing HSTS, direct nginx access, spoof success, or PHI in logs.
- **Abort criteria:** A TLS trust or proxy spoof failure that could expose PHI. Remove public listener access and follow the TLS rollback procedure.
- **Responsible role:** Security Owner + Infrastructure Operator.

### Step 18 — Activate schedules/alerts and sign off

- **Preconditions:** Steps 16–17 passed; PB-25–PB-31 closed for every unit being installed; alert sink and heartbeat approved.
- **Command/procedure:** Install only reviewed unit files in the single approved repository path. Enable the seven approved timers and the monitoring/heartbeat timers; never enable oneshot services directly. Verify:
  ```bash
  systemctl list-timers 'clinic-*'
  systemctl is-active clinic-monitor.service
  ```
  Send one synthetic alert, verify heartbeat observation, confirm dry-run retention/WAL-prune output was reviewed, and record the first successful scheduled run. Do not enable deletion or WAL pruning with `--apply --confirm DELETE` without a second written decision.
- **Expected result:** Expected timers active; synthetic alert delivered; heartbeat observed; no unintended `unknown`; retention/pruning still dry-run until separately authorized; all evidence attached to the change record.
- **Failure condition:** Missing timer, failed alert, stale heartbeat, silent overlap skip, or unreviewed dry-run plan.
- **Abort criteria:** Monitoring cannot prove failure visibility. Do not declare deployment complete; keep the change open and escalate to CO.
- **Responsible role:** Monitoring Owner + Infrastructure Operator + Change Owner.

---

## 6. Completion criteria

The deployment is complete only when all of the following are true:

1. Every step above has a recorded result and approver.
2. The exact commit SHA, image digests, backup ID, migration output, and verification output are attached.
3. No blocker required for the change remains OPEN or BLOCKED without recorded owner acceptance.
4. Rollback evidence and on-call contacts are handed to the named operations owner.
5. The CO signs the change record with an explicit statement that this deployment, and only this deployment, is complete.

A repository-only PASS never satisfies these criteria. No Production operation has been performed in preparing this document.
