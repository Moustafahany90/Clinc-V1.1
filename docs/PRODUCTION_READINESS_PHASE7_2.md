# Phase 7.2 — Residual Privacy, Scrubber and HTTP 422 Remediation

**Date:** 2026-11-20
**Branch / HEAD at audit:** `feature/clinic-quick-actions` @ `0d79b7d98962b204806e3e2cf2caf1ac381f1026`
**Working tree:** Phase 7.1 and earlier work remained uncommitted and was preserved. No reset, clean, stash, discard, commit or push was performed.
**Overall status:** **Complete for review. STOP for review — Phase 8 NOT STARTED.**
**Production state:** **UNTOUCHED.** No production container, volume, port, credential, deployment, timer, cron, systemd unit, logrotate activation, migration, WAL/PITR operation or external provider call was performed or verified.

Phase 7.2 is a repository-only follow-up to Phase 7.1. It closes the three residual findings recorded in `docs/PRODUCTION_READINESS_PHASE7_1.md` §8, revalidates Telegram/heartbeat/rotation/proxy behavior with local mocks only, updates the active readiness documentation, and records final validation evidence.

---

## 1. Scope and preservation

### Initial state preserved

`git status --short` was captured before any edit. The following pre-existing modifications/untracked files were preserved, not overwritten:

- Modified: `deploy/Caddyfile`, `docker-compose.monitoring.yml`, `docs/PRODUCTION_READINESS_BASELINE.md`, `docs/monitoring-runbook.md`, `docs/operations.md`, `scripts/p7-common.sh`, `scripts/p7-monitor.sh`, `web/nginx.conf`.
- Untracked: `backend/tests/phase7-route-redaction.test.ts`, `deploy/clinic-monitor.logrotate`, `deploy/monitor.env.example`, `docs/PRODUCTION_READINESS_PHASE7_1.md`, `scripts/p7-deliver-telegram.sh`, `scripts/p7-heartbeat-hook.sh`.

`backup.patch` is tracked, UTF-16, 439,292 bytes and remained clean (`git diff --quiet -- backup.patch` exit 0). It was not modified. No `.env` file was opened, copied or inspected; Compose validation used a separate synthetic env file.

### Files changed by Phase 7.2

| File | Change |
|---|---|
| `web/nginx.conf` | Added sanitized upstream-failure logging and limited `error_log` to `crit`. Logging only. |
| `backend/src/lib/logger.ts` | Added UUID tokenisation in `scrubText()` before all scrubbers and phone redaction, then restoration. |
| `backend/tests/p72-scrubber-regression.test.ts` | New in-process phone/UUID precision regression. |
| `backend/tests/p72-http-422.test.ts` | New focused HTTP 422 error-contract/redaction proof. |
| `scripts/p72-nginx-privacy-test.sh` | New isolated nginx privacy regression using local images and synthetic markers. |
| `scripts/p72-phase7-regression.sh` | New local-mock Telegram/heartbeat/rotation/redaction regression. |
| `docs/PRODUCTION_READINESS_PHASE7_1.md` | Linked Phase 7.2 remediation and changed residual finding statuses. |
| `docs/monitoring-runbook.md` | Added Phase 7.2 scope, regression commands and corrected storage wording. |
| `docs/operations.md` | Updated nginx error-log status, Phase 7.2 references and corrected storage wording. |
| `docs/PRODUCTION_READINESS_BASELINE.md` | Added Phase 7.2 status/test evidence/changelog and corrected storage wording. |
| `docs/PRODUCTION_READINESS_PHASE6.md` | Added a Phase 7.2 supersession note for historical storage wording. |
| `docs/PRODUCTION_READINESS_PHASE6_1.md` | Added a Phase 7.2 supersession note for historical storage wording. |
| `docs/PRODUCTION_READINESS_PHASE7.md` | Corrected manual Ubuntu action wording to the internal backup HDD. |
| `docs/backup-restore.md` | Corrected active storage wording for consistency with the approved architecture. |
| `docs/PRODUCTION_READINESS_PHASE7_2.md` | This report. |

No application routing, proxy, TLS, upload, response-body, status-code, migration or deployment behavior was changed.

---

## 2. Scope A — nginx error-log privacy

### Problem reproduced before the fix

A request with synthetic markers was sent through the repository nginx config in a disposable container:

- Query: `P7QUERY-BEFORE`, token: `P7TOKEN-BEFORE`
- Referer: `P7REFERRER-BEFORE`
- Authorization/Cookie: `P7AUTH-BEFORE`, `P7COOKIE-BEFORE`

The redacted `access.log` contained only method/path/status/duration/request id, but `error.log` contained the full request line, query string and Referer on a 502 upstream-connect failure. The residual Phase 7.1 finding was confirmed.

### Fix applied

`web/nginx.conf` now:

- defines `log_format clinic_upstream_failure` with method, path, status, failure class, upstream address/status, timing fields, duration and request id;
- maps `5xx` statuses to a dedicated `upstream-failures.log` via `if=$clinic_upstream_failure`;
- maps status classes to `upstream_connect_failure`, `upstream_http_failure`, `upstream_unavailable` and `upstream_timeout`;
- sets `error_log /var/log/nginx/error.log crit;` so request-bearing `error`-level upstream messages are not persisted;
- uses no `$request`, `$request_uri`, `$http_referer`, `Authorization` or `Cookie` variable in either log format.

This does **not** disable `error_log`; critical nginx errors remain. No routing, proxy, TLS, upload or response directive was changed.

### Evidence

Isolated nginx regression (`scripts/p72-nginx-privacy-test.sh`):

```text
p72-nginx: PASS refusal=502 upstream_http_failure=500 timeout=504 secrets_in_logs=0 upstream_full_request=1
```

Scenarios:

- Upstream refusal → HTTP 502, class `upstream_connect_failure`.
- Upstream HTTP 500 → HTTP 500, class `upstream_http_failure`.
- Upstream read timeout → HTTP 504, class `upstream_timeout`.
- Synthetic query/token/Referer/Authorization/Cookie markers were absent from every persistent nginx log.
- The local upstream still received the full query string and headers, proving proxy pass-through was unchanged.

`nginx -t` on the final repository config: `syntax is ok` / `test is successful`.

---

## 3. Scope B — UUID scrubber precision

### Problem reproduced before the fix

The real backend logger over-redacted all-digit UUIDs and the `userId` field:

```text
UUID_DIGITS=12345678-1234-1234-1234-123456789012 → [REDACTED_PHONE]
userId=12345678-1234-1234-1234-123456789012 → [REDACTED_PHONE]
```

Lowercase and uppercase hex UUIDs survived, but a valid all-digit UUID did not. The root cause was in `backend/src/lib/logger.ts`, not in `scripts/p7-common.sh`.

### Fix applied

`scrubText()` now:

- tokenises valid UUIDs matching the canonical 8-4-4-4-12 pattern with `UUID_PATTERN` before any scrubber or phone pass;
- stores each UUID in memory and replaces it with an internal marker;
- applies the existing key/text scrubbers and phone redaction;
- restores every valid UUID verbatim.

A valid UUID is a correlation identifier, not PHI. Invalid digit runs are still redacted, so ambiguity is resolved in favor of privacy.

### Evidence

`backend/tests/p72-scrubber-regression.test.ts` — focused run:

```text
# tests 2
# pass 2
# fail 0
```

Verified after the fix:

- Lowercase, uppercase, all-digit and v4-like UUIDs remain readable in both free text and structured fields.
- `+20`, `0020`, local, spaced, hyphenated and parenthesized phone formats remain redacted.
- Mixed text preserves UUIDs while redacting adjacent phone numbers.

The over-redaction visible in the pre-change full-suite output (`requestId`/`userId` split by `[REDACTED_PHONE]`) did not recur in the final suite.

---

## 4. Scope C — HTTP 422 coverage

### Constraint observed

`unprocessable()` exists in `backend/src/lib/errors.ts` but is not called by any production route. No endpoint was invented and no application behavior was changed.

### Test approach

`backend/tests/p72-http-422.test.ts`:

- starts the real in-process Express app on an ephemeral loopback port;
- uses the isolated synthetic `p72_phase_test` database whose name ends in `_test`;
- performs a real `PATCH /patients/:id` request with authentication;
- injects `unprocessable()` from `prisma.patient.findUnique` through a directly awaited delegate, then restores it in `finally`;
- asserts the unchanged error contract: HTTP 422, `code=UNPROCESSABLE`, message and details preserved;
- asserts synthetic PHI, JWT, API key, email, cookie and query markers appear in neither the response nor operational logs;
- asserts the structured `http.request` line uses a route template and not the raw UUID.

### Evidence

Focused run:

```text
Phase 7.2 HTTP 422 evidence: status=422 code=UNPROCESSABLE route=/:id sensitive_markers_in_logs=0
# tests 1
# pass 1
# fail 0
```

The observed route template is the nested router form `/:id`; either `/:id` or `/api/v1/patients/:id` is accepted by the test because neither contains the raw patient UUID. No `AppError` was converted into a 500-style `request.failed` event.

---

## 5. Scopes D/E/F — local-mock regression of Telegram, heartbeat, rotation, redaction and proxy behavior

All delivery/heartbeat tests used `scripts/p72-phase7-regression.sh` with local Python HTTP mocks bound to `127.0.0.1`, synthetic token/chat/heartbeat values and throwaway state directories. No request was made to Telegram, any hosted heartbeat provider, or any external host.

```text
p72-phase7: PASS telegram_success=1 telegram_retry=2 heartbeat_cycle=1 heartbeat_retry=2 rotation_keep=2 redaction_markers=0 secrets_in_output=0
```

Validated:

- **Telegram success:** one POST to `/bot<synthetic-token>/sendMessage`; allowlisted message contains severity/check/status/host/UTC/runbook and `disable_notification=false` for a page; no PHI, phone, email, JWT or API-key marker reached the mock.
- **Telegram failure:** two synthetic 500 responses with `MAX_ATTEMPTS=1`; exactly two requests, exit 0 each time, `telegram.delivery_failed` and `telegram.delivery_degraded` written locally.
- **Monitor orchestration:** a synthetic critical clock check produced one Telegram forward and exactly one completed-cycle heartbeat GET; the heartbeat file contained the cycle epoch; `monitor.complete` was emitted.
- **Heartbeat failure:** two synthetic 500 GETs produced `heartbeat.failed_http_500` and `heartbeat.delivery_degraded`, with exit 0 and non-blocking behavior.
- **Secret hygiene:** the synthetic Telegram token and heartbeat URL did not appear in stdout, stderr or the local JSONL sink.
- **Rotation:** five synthetic lines with `P7_SINK_MAX_BYTES=40`, `P7_SINK_KEEP=2` retained the newest live file plus exactly `.1` and `.2`; `.3` was absent.
- **Redaction:** the raw check message was retained in the protected local sink but was not forwarded in the Telegram body.
- **Proxy behavior:** covered by Scope A's isolated nginx script — full request data reached the upstream while persistent logs remained path-only and failure statuses/classes were preserved.

No external heartbeat provider was selected or configured. Telegram remains the approved channel, but no real bot, chat, token or account was used.

---

## 6. Scope G — validation evidence

All results below are actual runs on 2026-11-20.

### Backend

| Check | Result |
|---|---|
| `npm run typecheck` | PASS (`tsc -p tsconfig.json --noEmit`) |
| Focused Phase 7.2 tests (`p72-scrubber-regression`, `p72-http-422`) | **3 tests, 3 pass, 0 fail** |
| Full backend suite, pre-change baseline on isolated DB | **149 tests, 149 pass, 0 fail**, 59.007 s |
| Full backend suite, final code | **152 tests, 152 pass, 0 fail**, 61.999 s |
| B1 two timing failures | Did not reproduce in the isolated Phase 7.2 runs; not fixed |

The full suite used a disposable `p72_phase_test` database created from a schema-only dump of the non-production `phase5audit_db_data` volume copied into `p72-test-db-data`. No patient data was copied and no Prisma migration was run. A synthetic password was set only on that isolated copy. The database container and volume were deleted after validation.

### Syntax and config

| Check | Result |
|---|---|
| `bash -n scripts/p7-*.sh scripts/p72-*.sh` | PASS |
| Compose config (`docker-compose.yml` + `docker-compose.monitoring.yml`, `--profile monitoring`, synthetic env file) | PASS |
| `nginx -t` with final `web/nginx.conf` | `syntax is ok` / `test is successful` |
| `caddy validate` with `CLINIC_DOMAIN=clinic.example.test` | `Valid configuration` |

Compose validation used a separate synthetic env file containing only validation placeholders. The repository `.env` was not read or inspected.

---

## 7. Scope H — documentation and storage wording

Updated:

- `docs/PRODUCTION_READINESS_PHASE7_1.md` — residual findings marked resolved in Phase 7.2; current stop-gate pointer added.
- `docs/monitoring-runbook.md` — Phase 7.2 scope, local regression commands and corrected storage wording.
- `docs/operations.md` — hardened nginx error-log status, Phase 7.2 references and corrected storage wording.
- `docs/PRODUCTION_READINESS_BASELINE.md` — phase status, blocker/changelog and verified-check updates plus corrected storage wording.
- `docs/PRODUCTION_READINESS_PHASE6.md` and `docs/PRODUCTION_READINESS_PHASE6_1.md` — Phase 7.2 supersession notes placed above historical "external USB HDD" wording.
- `docs/PRODUCTION_READINESS_PHASE7.md` — manual Ubuntu action wording corrected to the internal backup HDD.
- `docs/backup-restore.md` — active backup architecture wording corrected for consistency.
- Created this report.

Corrected active storage wording:

- The approved production backup destination is a dedicated **500 GB internal SATA HDD** mounted by UUID at `/mnt/clinic-backups`.
- It is **local backup storage only**; no off-site provider or rclone remote is configured.
- A separate **USB flash drive is reserved solely for age private-key escrow**, not for backup or WAL data.
- **No Ubuntu deployment or production rollout has been performed or verified.**
- Historical Phase 6/6.1 execution-plan wording is explicitly marked as superseded both in the historical reports themselves and in the current baseline; the Phase 7 manual Ubuntu actions now use the corrected wording.

---

## 8. Production state, cleanup and review stop gate

### Not performed

No deploy, production container/volume/port operation, migration, `.env` access, real Telegram send, real heartbeat ping, external account creation, systemd/cron/logrotate activation, WAL/PITR activation, backup deletion, destructive Docker or Git command, commit, push, history rewrite or Phase 8 work was performed.

The production-looking containers `ultrasound-clinic-backend-1`, `ultrasound-clinic-db-1`, `ultrasound-clinic-evolution-1` and `ultrasound-clinic-web-1` remained running and untouched.

### Disposable resources created and removed

Only exact `p72*` names were used:

- Containers: `p72-nginx-before`, `p72-nginx-candidate`, `p72-nginx-candidate2`, `p72-nginx-repo`, `p72-backend-timeout`, `p72-test-db`.
- Network: `p72-nginx-net`.
- Volume: `p72-test-db-data`.
- Scratch workspace: `C:\Users\Moustafa\AppData\Local\Temp\opencode\p72audit-20261120-1900`.

After evidence capture, `docker ps/network ls/volume ls` filters for `^p72` returned empty lists. The scratch workspace was removed after this report was written. No `ultrasound-clinic-*` resource was targeted.

### Stop gate

Phase 7.2 is complete for review. **Stop here.** Await explicit review/approval before Phase 8 (CI/CD), deployment, scheduler installation, real provider configuration or any production rollout.
