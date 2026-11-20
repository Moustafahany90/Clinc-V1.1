# Clinic-V1.1 — Production Readiness Baseline

**Last updated:** 2026-11-20 (Phase 7.2 repository-only remediation complete for review: nginx error-log privacy, UUID-aware scrubber, HTTP 422 proof, local-mock Telegram/heartbeat/rotation/proxy regression and final validation; no production deployment, external account, scheduler or real Ubuntu host verification)
**Project:** Ultrasound Clinic Management System
**Branch / HEAD at last audit record:** `feature/clinic-quick-actions` @ `0d79b7d` (Phase 7.1 changes uncommitted; recorded 2026-11-20) — `[verify]` re-run `git status` / `git log -1` and update before relying on this.
**Overall status:** **NOT production-ready. Deployment NOT verified.** Phases 0–7, 6.1, 7.1 and 7.2 audited/validated; Phases 8–12 pending; go-live blockers listed in §2. Phase 6 proved restore mechanics; Phase 6.1 added the H6 code fix and isolated PITR, Ubuntu permission, `age`, `rclone`, legacy and full-drill evidence. Phase 7 added redacting structured logs, opt-in read-only checks and a local JSONL alert sink. Phase 7.1 added the approved Telegram delivery channel (local mock only), proxy access-log redaction, sink rotation, an external dead-man's-switch hook and route-level/API-contract regression proof. Phase 7.2 closed the residual nginx error-log, UUID scrubber and HTTP 422 gaps and revalidated Telegram/heartbeat/rotation/proxy behavior with local mocks only. Production deployment, scheduler installation, real external alert/heartbeat configuration, WAL/PITR and internal backup HDD mount verification remain not configured. Stop gate: **review Phase 7.2 before Phase 8.**

---

## 1. Phase Status

| Phase | Scope | Status | Date | Report |
|---|---|---|---|---|
| 0 | Baseline discovery and checks | Complete | 2026-11-16 | This file |
| 1 | AuthZ / doctor-isolation / IDOR | **Partial** — critical paths tested, not exhaustive | 2026-11-16 | §9 |
| 2 | Database integrity audit | Complete (audit only; no schema changes) | 2026-11-16 | §7 |
| 3 | Clinical & financial workflow audit | Report published `[verify status wording in report]` | 2026-11-17 | PRODUCTION_READINESS_PHASE3.md |
| 4 | Frontend quality, tests, UX/A11y, bundle | Complete for review | 2026-11-17 | PRODUCTION_READINESS_PHASE4.md |
| 4b | Frontend dependency remediation | Investigation complete; **no fix applied** (accepted dev-only risk) | 2026-11-17 | PRODUCTION_READINESS_DEPENDENCY_REMEDIATION.md |
| 5 | Docker, deployment, infrastructure security | Complete for review (local/isolated only) | 2026-11-17 | PRODUCTION_READINESS_PHASE5.md |
| 6 | Backup, restore, disaster recovery | **Complete for review; repo remediation applied** — restores verified on isolated synthetic data; hardened scripts/docs not deployed or configured | 2026-11-18 | PRODUCTION_READINESS_PHASE6.md |
| 6.1 | Backup/DR remediation validation | **Complete for review** — H6 Compose fix, isolated PITR, Ubuntu permissions, age/rclone success paths, legacy compatibility, full drill RTO 386 s; production validation `NOT PERFORMED` | 2026-11-18 | PRODUCTION_READINESS_PHASE6_1.md |
| 7 | Logging, monitoring, alerting | **Complete for review** — redacting structured logs, opt-in checks, local JSONL sink and isolated injection validation; no external channel/scheduler installed; production validation `NOT PERFORMED` | 2026-11-20 | PRODUCTION_READINESS_PHASE7.md, monitoring-runbook.md |
| 7.1 | Delivery, redaction, rotation, heartbeat, regression proof | **Complete for review** — Telegram adapter (local mock only), proxy access-log redaction, sink rotation, external heartbeat hook, route-level redaction test (149/149 full suite) and disposable real-container injection; production validation `NOT PERFORMED` | 2026-11-20 | PRODUCTION_READINESS_PHASE7_1.md |
| 7.2 | Residual privacy, scrubber and 422 remediation | **Complete for review** — nginx error-log hardening, UUID-aware scrubber, HTTP 422 middleware proof, local-mock delivery/heartbeat/rotation/proxy regression, final 152/152 backend suite; production validation `NOT PERFORMED`; **STOP for review** | 2026-11-20 | PRODUCTION_READINESS_PHASE7_2.md |
| 8 | CI/CD | Pending | — | — |
| 9 | Performance, load, concurrency | Pending | — | — |
| 10 | Documentation hardening | Pending | — | — |
| 11 | Full synthetic E2E acceptance | Pending | — | — |
| 12 | Deployment verification (real environment) | Pending | — | — |

---

## 2. Open Blockers and Risk Register

### Go-live blockers
| ID | Item | Status / next step |
|---|---|---|
| B1 | 2 failing backend tests (after-hours Quick Actions timing) | Pre-existing. Determine whether the bug is in the test (current-time dependency) or in the code (timezone handling). Fix before go-live. |
| B2 | Work uncommitted on feature branch (20 modified, 1 untracked at Phase 0, plus later audit/test/doc additions) | Commit in logical units, merge, tag a release; deploy from the tag only. |
| B3 | Backup/recovery unproven: no executed restore drill, backups unencrypted, no off-host copy, no schedule/monitoring | **Phase 6.1 complete for review (2026-11-18).** Phase 6 restore mechanics and repo remediation remain verified. Phase 6.1 added the H6 Compose fix, isolated PITR proof, Ubuntu permission validation, age/rclone success paths through the real `backup.sh`, legacy compatibility, and a full fresh-stack drill (RTO 386 s synthetic). **Not deployed or configured on production:** no schedule/monitoring, no key/off-site destination, old dump remains unverified, WAL/PITR is not enabled, Windows ACLs unchanged, and production key rotation was not performed. See `PRODUCTION_READINESS_PHASE6_1.md`. |
| B4 | No CI (`.github/` has no workflows) | Phase 8. Minimum: typecheck, build, backend tests on Postgres, web tests, `npm audit --omit=dev`. |
| B5 | Backend `npm audit` not recorded; image CVE scan not performed (no scanner installed) | Run `npm audit --omit=dev` in `backend`; install a scanner and scan the 3 images. |
| B6 | No secret scan of git history; `.env` presence confirmed but not inspected | Run a history secret scan; confirm `.env` is ignored. |
| B7 | Target deployment environment not defined/verified (see §3) | Decide OS, domain, TLS, deploy owner. |
| B8 | No real deployment verification, monitoring, or alerting | **Phase 7 + 7.1 + 7.2 complete for review (2026-11-20):** redacting logs, healthchecks, opt-in read-only checks, local JSONL sink, Telegram adapter, proxy access-log/error-log redaction, sink rotation and heartbeat hook validated only in isolation/local mock. Still not deployed; no scheduler, real external channel, log shipping or production exercise. Phase 12 remains required. |
| B9 | Alert channel and scheduler installation not approved | **Telegram approved (2026-11-20):** Phase 7.1 implemented the adapter and Phase 7.2 revalidated success/retry/degradation only against a local mock; no account/credential or external call was made. Still required before production: create bot/chat, populate the 0600 env file, choose a dead-man's-switch provider (see Phase 7.1 §5) and install a scheduler. Reverse-proxy logging hardening is implemented and validated but not rolled out. |

### Should fix before or right after go-live
| ID | Item | Notes |
|---|---|---|
| M1 | AuthZ/IDOR evidence not exhaustive | Not covered: all settings sub-resources, all file download/delete paths, all user/session admin mutations, all appointment/payment edge mutations, every quick-action variant. |
| M2 | DB `CHECK` constraints not applied | `amountMinor` positivity, refund/allocation bounds, string-status values, `closeMinute > openMinute`. Cheaper to add via reviewed migration before real data exists. |
| M3 | String-typed statuses (`Charge.status`, `Expense.status`, `ReportUpdateRequest.status`, `FileAsset.kind`) | Enums or CHECKs in the same migration. |
| M4 | Concurrency not proven under load | Phase 9 (simultaneous allocations/refunds/voids/amendments/deliveries). |
| M5 | No `EXPLAIN`-based index validation | Phase 9. |
| M6 | Phase 5 infra residuals | No resource limits, no `no-new-privileges`, tag-pinned (not digest-pinned) base images, single flat network, nginx master runs as root (workers non-root). Hardening documented, not applied (approval-gated). Caddy healthcheck added in Phase 7 repo config but not deployed. |
| M7 | Evolution/WhatsApp operations | Session volume `ultrasound_clinic_evolution_instances` needs backup and must never be removed/recreated; key management; target-environment verification. |
| M8 | Legal/privacy review | Health data; Egyptian Personal Data Protection Law No. 151 of 2020 — retention, access logging, consent, off-site hosting. Needs a human legal review. |
| M9 | No go-live checklist / rollback plan / staging dry-run | Add before Phase 12. |

### Accepted risks
| ID | Item | Rationale | Review |
|---|---|---|---|
| A1 | `web` dev-tooling advisory: picomatch ReDoS (CVE-2026-112366 / GHSA-fc5q-39xc-vjpf), 5 high-severity `npm audit` findings | No patched release (latest 4.0.7). `npm audit --omit=dev` = 0 vulnerabilities; affected packages are not in the production bundle; no untrusted input reaches them. The only npm-proposed fix is a breaking `--force` downgrade (vitest 3.1.4 / vite 6.2.7), not applied. | Recheck when picomatch > 4.0.7 is published; then prefer a minimal `overrides` bump. `[set a calendar review date]` |

### Low / informational
- Dead `serviceId` expression in `VisitDetailPage.tsx`.
- Backend image is 2.31 GB (Playwright/Chromium): slows deploy and rollback.
- (Phase 7.2, resolved) nginx `error_log` request-bearing upstream detail is suppressed at `crit`; sanitized upstream diagnostics go to a path-only `upstream-failures.log`.
- (Phase 7.2, resolved) Logger preserves valid UUIDs while redacting all supported Egyptian phone formats.
- (Phase 7.2, resolved) HTTP `422` is now exercised through the unchanged error middleware on a real route path; no production endpoint was invented.

---

## 3. Target Deployment Environment

| Item | Value |
|---|---|
| Server OS | `Ubuntu` |
| Domain / DNS | `` |
| TLS | Caddy auto-TLS config validated syntactically (`Valid configuration`); not tested on a real domain |
| Deploy owner / method | `` |
| Repo assumptions | Docker Compose, bash scripts (`scripts/backup.sh`, `scripts/restore-drill.sh`), Linux paths, cron-style scheduling |

If the server is Windows Server, the bash scripts and cron assumptions need a Docker Desktop/WSL2 plan, Task Scheduler, and path/line-ending/permission review. That affects Phases 5, 6 and 7, so decide this first.

---

## 4. Repository / Git State

- **Working tree at Phase 0:** 20 modified tracked files and 1 untracked file (quick-actions/finance UI, quick-actions backend and tests); nothing reverted.
  - Modified: `backend/src/modules/quick-actions/routes.ts`, `service.ts`, `backend/tests/quick-actions-appointments.test.ts`, `web/src/components/ui.tsx`, `web/src/lib/api.ts`, `web/src/lib/quickActions.ts`, `web/src/routes/ExpensesPage.tsx`, `FinancePage.tsx`, `PaymentsPage.tsx`, and 11 files under `web/src/routes/quick-actions/`.
  - Untracked: `web/src/components/RangePresets.tsx`.
- **Added by later phases (uncommitted unless committed since):** `backend/tests/authorization-idor.test.ts`, `docker-compose.yml` changes, `docs/operations.md`, Phase 3/4/4b/5 reports, the web Vitest setup.
- **Recent commits at Phase 0:** fd128f5, 640dedb, 34b255b, 8e1e448, 9d258b1, 03d291b, e3f466b, 3e00daf, 1fe6a05, baf801f (quick-actions series).
- **CI:** none. **`.env`:** present locally, must never be committed.

---

## 5. Stack and Structure

- **Backend:** Node 20+, TypeScript 5, Express 4, Prisma 6.18, PostgreSQL 16, Zod, JWT access+refresh, Multer, pdfkit + Playwright Chromium (`htmlPdf`/`gyn4d`) for HTML→PDF. Tests: `node --test --import tsx` in `backend/tests/`.
- **Web:** React 18, TypeScript 5.6, Vite 7, React Router v7, Tailwind v4, Radix, Axios. Tests: Vitest/RTL/jsdom (`npm test`, `npm run test:run`).
- **Infra:** `docker-compose.yml` (db, migrate, backend, web, evolution), `docker-compose.tls.yml` + `deploy/Caddyfile`, `scripts/backup.sh`, `scripts/restore-drill.sh`, `scripts/backup-verify.sh`.
- **Reports:** report-blocks (`backend/src/lib/report-blocks/*`, `backend/prisma/report-templates/*`), `gyn4d.ts` and logo, template pinning/snapshots, WhatsApp delivery routes.
- **Migrations (7 + lock):** init, token_blacklist, report_template_pinning, token_version_and_override_permissions, report_whatsapp_delivery, patient_referring_doctor, remove_email_delivery.

---

## 6. Latest Verified Checks

| Check | Result | As of | Notes |
|---|---|---|---|
| `backend` typecheck / build | typecheck PASS; build last verified 2026-11-16 | 2026-11-20 (typecheck) | Re-run build before release |
| `web` typecheck / build / tests | PASS; **42/42 tests (7 suites)** | 2026-11-17 | Entry chunk 230.40 kB (down from 733.88 kB) |
| `backend` full test suite | **152 tests: 152 pass, 0 fail, 0 skipped** | 2026-11-20 (Phase 7.2) | Isolated `p72_phase_test`; B1 timing failures did not reproduce |
| `web npm audit` | 5 high (dev-only, A1) | 2026-11-17 | `--omit=dev` = 0 |
| `backend npm audit` | **Not recorded** | — | B5 |
| Docker | Compose combinations (base/TLS/Evolution/combined) validated; 3 images built; isolated stack healthy; setup→login passed; restart/reboot persistence OK; logs scanned, no secret leakage; Caddyfile valid | 2026-11-17 | No Critical/High infra finding. Image CVE scan not performed |
| Backup/restore drill | **PASS on synthetic data** — counts/hashes/invariants matched; clean re-restore and fresh-cluster restore verified | 2026-11-18 | Isolated `phase6audit`; real scripts, synthetic data. DR program gaps remain (Phase 6) |
| Phase 7.2 local regressions | PASS: nginx `refusal=502 upstream_http_failure=500 timeout=504 secrets_in_logs=0`; Phase 7 mocks `telegram_success=1 telegram_retry=2 heartbeat_cycle=1 heartbeat_retry=2 rotation_keep=2 redaction_markers=0` | 2026-11-20 | Local mocks and disposable `p72*` resources only; no real provider |
| Config validation | PASS: `bash -n`, Compose monitoring overlay, `nginx -t`, `caddy validate` | 2026-11-20 | Compose used a synthetic env file; `.env` not read or inspected |

Backend DB tests must run against a disposable DB whose name ends in `_test` (the suites refuse otherwise), after `prisma migrate deploy`.

---

## 7. Database and Migration Observations (Phase 2)

**Controls observed**
- Committed migrations only; compose `migrate` service runs `prisma migrate deploy` before the backend; docs forbid `db push`/`reset` in production.
- UUID keys; FKs with deliberate `onDelete` (`Restrict` for financial/clinical ownership, `Cascade` for dependent children, `SetNull` for optional actor refs).
- Uniques: `User.email`, `RefreshToken.tokenHash`, `PasswordSetupToken.tokenHash`, `WorkingHours.dayOfWeek`, `DoctorAvailability(doctorId,dayOfWeek)`, `ReportVersion(reportId,versionNumber)`, `PaymentAllocation(paymentId,chargeId)`, `Charge.appointmentId`, `Payment.idempotencyKey`, `Expense.idempotencyKey`, `ReportDelivery(reportId,versionNumber,channel)`.
- Money as integer minor units (`amountMinor`); no float/decimal money columns.
- Extensive `$transaction` usage; advisory locks (`pg_advisory_xact_lock(hashtext(patientId))` on payment/ledger paths, appointment/doctor-calendar locking, setup bootstrap).
- Idempotency: unique keys on payments/expenses, deterministic `booking:<appointmentId>` key, WhatsApp delivery claim/timeout logic.
- Append-only/correction patterns: refunds and report versions create new records; finalized reports protected from in-place mutation; charges/expenses are voided with reasons.

**Gaps:** see M2–M5.

---

## 8. Security and Configuration Observations

- **Env validation (`backend/src/config/env.ts`):** production guards for HTTPS origins, `COOKIE_SECURE`, `TRUST_PROXY>=1`, distinct non-placeholder JWT secrets, and Evolution key placeholder rejection when enabled.
- **Evolution:** the container is **mandatory core infrastructure**: no Compose profile, no host port (internal `clinic_net` only), API-key auth always enabled, HTTP healthcheck, `unless-stopped`. The backend has **no `depends_on` on Evolution health**, so provider failure cannot block core workflows; WhatsApp fails soft. `EVOLUTION_API_ENABLED` (default `false` in schema/compose/`.env.example`) gates only the **application feature**, not the container. See `docs/operations.md`.
- **Auth:** JWT verified with issuer/audience/type/jti/tv; blacklist checked; refresh rotation with family revocation on reuse; refresh cookie scoped to `/api/v1/auth`; `mustChangePassword` enforced server-side; login lockout with generic failures; password strength checks; session termination routes.
- **Doctor isolation:** clinical modules enforce ownership via `assertClinicalRead`/`assertClinicalWrite`/`forcedDoctorId`; reception excluded from clinical records; admin clinical access needs explicit permission. Scheduling/queue scope doctors to their own data. Quick-actions aggregate services are scoped via `scopedDoctorId(me)`. Finance/admin modules are permission-gated (`requirePermission`).
- **File uploads:** MIME sniffing (JPEG/PNG/WebP/TIFF/PDF), generated names with traversal guard, sanitized `Content-Disposition`, `Cache-Control: private, no-store`, `nosniff`, `CSP: default-src 'none'; sandbox`; nginx `client_max_body_size 32m`.
- **HTTP:** Helmet (HSTS in prod; CSP off on API), strict CORS allowlist, body limits, API/auth/upload/delivery rate limiters, request IDs, readiness endpoint with DB check.
- **Frontend:** nginx security headers and CSP (`frame-ancestors 'none'`); block-report iframe sandbox excludes `allow-scripts`. Full report/print/XSS review not completed `[verify against Phase 3/4 reports]`.

---

## 9. Phase 1 Evidence: `backend/tests/authorization-idor.test.ts` (11 tests)

Synthetic ADMIN/DOCTOR/RECEPTIONIST accounts. Scenarios: unauthenticated, insufficient permission, permitted access, direct-object access, manipulated resource/doctor IDs, unauthorized exports and mutations. Denied mutations verified with DB state unchanged; sensitive values asserted absent from denied responses.

- **Payments:** `GET /payments`, `GET /payments/:id`, `POST /payments`, `GET /payments/charges/list`, `POST /payments/charges`, `POST /payments/:id/refund`, `POST /payments/charges/:id/void`
- **Expenses:** `GET /expenses`, `POST /expenses`, `POST /expenses/:id/void`
- **Financial reports:** `daily`, `monthly`, `position`, `statement`, `accounting-export/preview`, `accounting-export/run`
- **Patients:** `GET /patients/:id`, `GET /patients/:id/ledger`
- **Dashboard:** `GET /dashboard`
- **Settings/staff:** `GET /settings` (unauth), `GET /users`, `POST /users`, `PATCH /settings`
- **Audit:** `GET /audit`
- **Quick Actions:** availability/today, appointments/today, today-summary, queue/status, patients/today-summary, week-summary (incl. manipulated `doctorId`)
- **WhatsApp:** `GET /settings/whatsapp`, `POST /settings/whatsapp/test`, `POST /reports/:id/whatsapp` (cross-doctor send denied, no delivery record)
- **Reports:** `GET /reports/:id`, `PATCH /reports/:id` (other doctor cannot read or mutate)

**Fixed finding:** quick-actions aggregate services lacked doctor scoping; now constrained via `scopedDoctorId(me)`. No other exploitable authz/IDOR finding confirmed in covered paths. Remaining coverage gaps: M1.

---

## 10. Backups and Recovery

### State before Phase 6

- `scripts/backup.sh`: `pg_dump` custom format + storage tar + SHA256 + manifest, mode 0700. **Unencrypted. Manual. No off-host copy. No retention automation or alerting evidenced.**
- `scripts/restore-drill.sh`: restores into a disposable `*_drill` DB, verifies counts, drops by default. Safe design, **never executed with evidence**.
- Evolution session volume `ultrasound_clinic_evolution_instances` must be included in backups; `caddy_data` (TLS state) should be inventoried.
- No RPO/RTO measured. Phase 6 is the gate for B3.

### Phase 6 results (2026-11-18)

See `PRODUCTION_READINESS_PHASE6.md` for the full report, severity findings and exact recovery procedures. Summary:

- **Restore mechanics proven on synthetic data:** real scripts executed unchanged against an isolated `phase6audit` stack. Small and scale datasets restored into `*_drill` databases with all per-table counts/hashes matching, 7 public migrations, 37 Evolution tables/57 migrations, and identical critical financial/clinical invariants. FK/unique/NOT NULL probes passed.
- **Clean re-restore and fresh cluster:** documented `--clean --if-exists --no-owner` restore succeeded twice; an empty PostgreSQL 16 cluster restored end-to-end in 7.69 s. The only fingerprint difference was `timestamptz` text rendering (`Africa/Cairo` vs UTC); epoch sums were identical.
- **Integrity:** SHA-256/gzip/TOC checks passed; a tampered dump and a missing archive were both detected (`sha256sum -c` exit 1); no production secrets found in dump/manifest/storage.
- **Storage:** 6/6 and 206/206 files restored with identical SHA-256/size; simulated database↔file gaps were detected. The app stores `checksum: null` on every upload, so automatic drift detection is still absent.
- **Measured (synthetic):** backup 1.65 s small / 1.98 s scale; restore 4.38 s small / 4.58 s scale; clean re-restore 4.18 s; fresh cluster 7.69 s; storage extraction 3.32 s. Not representative of real multi-GB uploads.
- **Not production-ready:** backups remain unencrypted, single-copy and same-host; no schedule/retention/monitoring; Evolution session volume and Caddy data are not backed up; `backup.sh` can leave a partial unmanifested set; the documented restore is non-atomic and leaves Evolution running; no WAL/PITR; Windows ACLs expose `.env`/backups; hardcoded Evolution API-key fallback in tracked Compose. All fixes are approval-gated.
- **Production was untouched:** production DB never queried; no production volume written or deleted. One accidental empty `ultrasound_clinic_caddy_data` volume was created during read-only inspection and removed immediately.

### Repo remediation after review (2026-11-18, not deployed)

The owner approved repo fixes only. Implemented on the current branch, with no production change:

- `scripts/backup.sh`: single staged set published only after checksums pass; disk-space precheck; optional writer quiesce; optional age encryption (`BACKUP_AGE_RECIPIENT`, `BACKUP_REQUIRE_ENCRYPTION`); optional rclone copy+check (`BACKUP_OFFSITE_REMOTE`); storage, Evolution and Caddy volume archives; manifest with sizes/versions/volume names/format.
- `scripts/restore-drill.sh`: rejects `.age`; verifies matching `SHA256SUMS`; `--single-transaction --exit-on-error`; per-table counts/sums; migration and Evolution schema checks; optional storage extraction with `FileAsset` missing/orphan/size reconciliation.
- `scripts/backup-verify.sh`: read-only set/inventory verification with optional `BACKUP_MAX_AGE_HOURS` monitoring gate and encryption requirement.
- `.gitattributes`: `*.sh`/`*.sql`/Dockerfiles forced to LF; scripts verified LF in the working tree.
- `docs/backup-restore.md` / `docs/operations.md`: encrypted local-only workflow, verification, exact full restore (including Evolution/Caddy), session invalidation, fresh-host and re-pair procedures. No off-site provider is configured; the USB flash drive is reserved for age key escrow only.

Phase 6.1 validation (2026-11-18, isolated only): H6 fallback removed from `docker-compose.yml` with fail-closed Compose tests; WAL/PITR restore proved by name and time on a disposable PostgreSQL cluster; Ubuntu `0700`/`0600` permission model verified; `age` and `rclone` success paths proved standalone and through the real `backup.sh` (7/7 off-site SHA-256 matches, encrypted verifier pass); legacy dump-only/manifest-less compatibility verified; fresh-stack recovery drill measured 386 s RTO on synthetic data. Production operational validation remains `NOT PERFORMED`. Key outputs and the 15-item review gate are in `docs/PRODUCTION_READINESS_PHASE6_1.md`.

Remaining production work: deploy the H6 Compose fix and rotate `EVOLUTION_API_KEY`; configure age key escrow on a separate USB flash drive and the approved 500 GB internal SATA HDD at `/mnt/clinic-backups` (local backup storage only, no off-site provider); schedule backup + verifier with capacity/failure alerts; deploy the hardened scripts to the Ubuntu host and verify permissions; enable/monitor WAL archiving on the internal backup HDD and re-test PITR; run a real-host isolated drill with representative storage; quarantine the unverified 2026-11-13 dump; and resolve the still-open infrastructure findings (H4/H5 environment portions). No Ubuntu deployment or production rollout has been performed or verified.


---

## 11. Functionality to Preserve

Auth/users/setup, patients, appointments/agenda, queue, visits, reports (standard + block + gyn4d + PDF/print), files/images, payments/expenses/finance, settings, audit, dashboard, quick-actions, WhatsApp delivery plumbing. Report architecture, templates, `gyn4d.ts` and report-blocks must stay intact.

---

## 12. Next Actions (priority order)

1. Resolve B1 (failing tests) and record a fresh green run with date and command.
2. Decide the target OS (B7); re-check Phase 5/6/7 assumptions against it.
3. Commit/merge/tag; run a git-history secret scan (B2, B6).
4. Phase 6 repo remediation and Phase 6.1 validation are complete but not deployed: deploy the H6 fix and rotate the key; configure age escrow on a USB flash drive and the 500 GB internal SATA HDD at `/mnt/clinic-backups`; schedule `backup.sh` + `backup-verify.sh`; alert on failure/age/capacity; verify Ubuntu permissions; enable WAL/PITR on the internal backup HDD; run a real-host isolated drill with representative storage before relying on recovery. Phases 7, 7.1 and 7.2 are complete for review but also not deployed: choose the alert channel (B9), provision state/log directories, install the scheduler only after approval, and roll out the redacted proxy logging only after approval.
5. Backend `npm audit --omit=dev` and image CVE scan (B5).
6. Phase 8: CI.
7. Reviewed migration for DB CHECKs/enums (M2, M3).
8. Phases 9–12; add go-live checklist, rollback plan, and a staging dry-run (M9).

---

## 13. Changelog

- **2026-11-20 (Phase 7.2)** — Remediated the Phase 7.1 residuals in the repository only: nginx `error_log` now keeps only `crit` while path-only upstream-failure diagnostics go to a dedicated structured access log; the backend scrubber tokenises valid UUIDs before phone redaction; a focused HTTP 422 proof exercises the unchanged error middleware on a real route path. Added isolated regression scripts for nginx privacy and Phase 7 local-mock delivery/heartbeat/rotation/redaction, and revalidated Telegram, heartbeat, rotation, proxy pass-through, typecheck, Compose/nginx/Caddy config and the full backend suite (152/152/0). Corrected active storage wording to a 500 GB internal SATA HDD, local backup only, a separate USB flash drive for age key escrow, no off-site provider, and no verified Ubuntu deployment/production rollout. Added `PRODUCTION_READINESS_PHASE7_2.md` and updated Phase 7.1/runbook/operations/baseline/backup-restore docs. **No production access, real provider call, scheduler, deploy, migration, `.env` access, commit or Phase 8 work was performed. STOP for review.**
- **2026-11-20 (Phase 7.1)** — Added the approved Telegram delivery adapter (allowlisted plain-text messages, env-only secrets via `-K`, HTTPS gate, bounded retries, silent warn/info/recovery and loud critical/high/page, local failure/degraded escalation), an optional secret-URL-safe external heartbeat hook (completed cycles only), size-based local sink rotation, proxy **access**-log redaction (`web/nginx.conf`, `deploy/Caddyfile`), and a route-level PHI/secret redaction test. Validated with local mocks and disposable `p71*` containers: nginx/caddy config validation, before/after log evidence, unchanged proxy behavior, all Telegram success/failure paths with zero token leakage, no-alert-storm, heartbeat skip/crash/no-ping, 149/149 full backend suite (baseline 148/148/0, B1 not fixed), and a real-container injection proving page alerts notify loudly and 429 failures stay non-blocking. Added `PRODUCTION_READINESS_PHASE7_1.md`; updated the runbook, operations and B8/B9. **No production access, external account/call, credential, scheduler, timer, deploy or Phase 8 work was performed. STOP for review.**
- **2026-11-20 (Phase 7)** — Added redacting structured request/error/audit logs, `LOG_LEVEL`, Prisma query-log suppression, Caddy healthcheck, an opt-in `monitoring` Compose overlay, and read-only checks for backup, capacity, containers, certificates, WAL, clock and heartbeat with a local deduplicated JSONL sink, plus uninstalled systemd templates in `deploy/`. Validated 4/4 redaction tests, typecheck/build, Compose rendering and isolated failure injections (baseline all ok; 12 failure scenarios produced expected exit codes; monitor dedup/recovery observed). Added `PRODUCTION_READINESS_PHASE7.md` and `monitoring-runbook.md`; updated operations and Phase 7/B8/B9 status. **No production access, Docker daemon start, scheduler, external channel, credential or deployment was performed. Alert-channel decision pending.**
- **2026-11-18 (Phase 6.1 execution-plan update; storage wording superseded by Phase 7.2)** — Replaced the cloud/off-site backup plan with a dedicated 500 GB backup disk mounted by UUID at `/mnt/clinic-backups` on the Ubuntu production host. Added fail-closed mount requirements to `scripts/backup.sh`, mount/capacity checks, capacity alerts at 70/85/95%, UUID/fstab template, systemd schedule/alert units, retention dry-run report, and a WAL archive overlay with `archive_timeout=300s`. Phase 7.2 corrects the active architecture wording to **internal SATA HDD**, local backup only, with a separate USB flash drive reserved for age key escrow and no off-site provider. Awaiting Ubuntu SSH access, disk survey, age escrow location, alert email, and maintenance window. **No production operation performed.**
- **2026-11-18 (Phase 6.1 validation)** — Added H6 Compose fix (`EVOLUTION_API_KEY` required for backend and Evolution; fallback removed) and validated fail-closed config. Completed isolated PITR recovery by restore point and time, Ubuntu permission model test, standalone and real-`backup.sh` age/rclone success paths, legacy compatibility, and a fresh-stack recovery drill with measured 386 s synthetic RTO. Added `PRODUCTION_READINESS_PHASE6_1.md` and updated Phase 6/baseline runbooks. **No production deployment, credential rotation, schedule, or off-site destination was configured. Stop gate awaits explicit approval.**
- **2026-11-18 (Phase 6 repo remediation)** — Applied the approved repo-only fixes: hardened `backup.sh` (atomic complete set, checksum verification, quiesce option, age encryption, rclone off-site copy, Evolution/Caddy volumes, richer manifest), rebuilt `restore-drill.sh` (checksum, counts/sums, migrations, Evolution, storage reconciliation), added `backup-verify.sh`, added `.gitattributes` with LF enforcement, and rewrote the backup/restore runbooks. Verified with syntax checks and a disposable end-to-end drill. **No production deployment, schedule, key, or off-site destination was configured.** H4/H5/H6 remain open.
- **2026-11-18 (Phase 6)** — Backup/restore/DR audit on an isolated synthetic stack: real scripts exercised; restore fidelity, clean re-restore, fresh-cluster restore, storage reconciliation, checksum-tamper detection and Evolution schema restore verified. Added Phase 6 report, phase status, B3 update, backup section and changelog. No production data, code or config changed.
- **2026-11-18** — Docs-only reorganization: added phase status table, blocker/risk register, target-environment section; corrected stale statements (Evolution profile-gating, "NOT RUN YET" audit/Docker rows, "Phases 3–12 pending", "Proceed to Phase 3"); unified test counts; fixed project-name typo.
- **2026-11-17** — Phase 3 report; Phase 4 (42 tests, bundle 733.88→230.40 kB); dependency investigation (picomatch, accepted); Phase 5 (Docker/infra, Evolution decoupled from backend startup, suite 144/142/2).
- **2026-11-16** — Phase 0 baseline; Phase 1 authz/IDOR tests (127/127 at the time); Phase 2 DB audit; Evolution moved from profile-gated to mandatory core.