# Phase 7.1 — Alert Delivery, Log Redaction, Rotation, Heartbeat and Regression Proof

**Date:** 2026-11-20
**Branch / HEAD at audit:** `feature/clinic-quick-actions` @ `0d79b7d` (all Phase 7.1 changes are uncommitted)
**Overall status:** **Complete for review. Residual items were remediated in Phase 7.2. STOP for review — no Phase 8 work started.**
**Production state:** **UNTOUCHED.** No production container, volume, port, credential, deployment, timer, cron, systemd unit or external service was created or modified. No commits, pushes, resets or cleans.

**Phase 7.2 follow-up (2026-11-20):** the three residual findings in §8 (nginx `error_log` detail, UUID over-redaction, HTTP 422 coverage) are resolved in `docs/PRODUCTION_READINESS_PHASE7_2.md`. The Phase 7.1 evidence below remains historical; the Phase 7.2 report is authoritative for the current repository state.

Phase 7.1 completes the Phase 7 stop-gate items that were previously deferred: Telegram delivery (channel now approved by the clinic), proxy access-log redaction, local sink rotation, an optional external dead-man's-switch hook, a route-level redaction proof, an API-contract regression proof, and a disposable real-container injection exercise. All delivery tests used a **local mock**; no request was ever made to `api.telegram.org` or any external host. All credentials used were synthetic markers.

---

## 1. Files changed

Modified (tracked):

| File | Change |
|---|---|
| `scripts/p7-common.sh` | Added size-based `P7_SINK_MAX_BYTES` / `P7_SINK_KEEP` and `p7_sink_rotate()`; `p7_alert()` rotates before appending. |
| `scripts/p7-monitor.sh` | Calls the Telegram adapter after each sink write, rotates at cycle start, calls the external heartbeat hook only after a completed cycle, and adds a test-only `P7_SKIP_CYCLE=1` path. |
| `web/nginx.conf` | Added `clinic_access` JSON log format using path-only `$uri` and a server-level `access_log`. Logging only — no routing/security/TLS/upload change. |
| `deploy/Caddyfile` | Added a logging-only `format filter` block that strips the query string from the logged URI and deletes `Authorization`/`Cookie` from logged headers. No routing/header/TLS/proxy change. |
| `docker-compose.monitoring.yml` | Added opt-in env plumbing for rotation, Telegram and heartbeat variables. Keeps the `monitoring` profile and default-disabled behavior. |

New (untracked):

| File | Purpose |
|---|---|
| `scripts/p7-deliver-telegram.sh` | Allowlisted, best-effort Telegram adapter. |
| `scripts/p7-heartbeat-hook.sh` | Optional external dead-man's-switch ping, secret-URL-safe. |
| `deploy/monitor.env.example` | Blank-value 0600 env-file template (never commit a populated copy). |
| `deploy/clinic-monitor.logrotate` | Optional host-side logrotate template (alternative to built-in rotation). |
| `backend/tests/phase7-route-redaction.test.ts` | Route-level PHI/secret redaction proof on an isolated `_test` DB. |
| `docs/PRODUCTION_READINESS_PHASE7_1.md` | This report. |

No backend **source** file was changed: the Phase 7 diff for `app.ts`, `middleware/error.ts`, `lib/audit.ts`, `lib/prisma.ts` and `index.ts` was reviewed and confirmed to contain only logging changes with no response body or status changes.

---

## 2. Telegram delivery

### 2.1 Design (all requirements)

- **Config is env-only:** `P7_TELEGRAM_BOT_TOKEN`, `P7_TELEGRAM_CHAT_ID`, optional `P7_TELEGRAM_API_BASE`, `P7_HOST_LABEL`. Missing token/chat disables delivery cleanly (`delivery disabled ...; local sink still records all alerts`, 0 mock requests).
- **Secret handling:** the token is written only into a `0600` curl config file inside a `0700` `mktemp -d` directory and passed to curl as `-K <cfg>`. It is never placed in argv, stdout, stderr, the JSONL sink, docs or test output. Curl errors are discarded.
- **HTTPS gate:** only `https://` API bases are accepted unless `P7_ALLOW_INSECURE_TEST=1` is set, which is documented as local-mock-only. An insecure base without the flag was refused with 0 mock requests.
- **Non-blocking:** every failure path exits 0; short `connect-timeout=3` / `max-time` (default 5 s), bounded `P7_TELEGRAM_MAX_ATTEMPTS` (default 3) with bounded backoff and `retry_after` capped at 10 s.
- **Allowlist message only:** fixed format
  `[SEVERITY] check status=STATUS host=LABEL at=UTC runbook=docs/monitoring-runbook.md`,
  truncated to 300 characters, plain text (`parse_mode` absent). Raw check `message`, PHI, paths, artifact names, tokens, JWTs, emails and phone numbers are never forwarded. A second scrubber pattern pass removes JWT/email/secret/phone shapes as belt-and-braces.
- **Severity routing:** `critical`, `high`, `page`, `unknown` severities and `critical`/`high` statuses are loud (`disable_notification=false`); `warn`, `info` and recoveries are silent (`true`). `page` was added deliberately because the Phase 7 dead-man's-switch check emits `severity=page, status=critical` — a page must not be muted.
- **Dedup/escalation/recovery preserved** by `p7-monitor.sh`; delivery only forwards lines that survived those rules.
- **Consecutive-failure escalation:** `telegram.delivery_failed` is written on every exhausted delivery; after `P7_TELEGRAM_FAIL_ESCALATE_AFTER` (default 3) consecutive failures a local `telegram.delivery_degraded` high event is written; a later success writes `telegram.delivery_restored`.

### 2.2 Evidence (local mock only)

Mock: `p71-tg-mock` (Node HTTP server, bound `127.0.0.1` on the host and reachable as `p71-tg-mock` on the isolated network). It never persisted the token, only `path=/bot<redacted>/sendMessage` and `token_present=true`.

| Scenario | Result |
|---|---|
| `critical`/`high` message | `disable_notification=false` |
| `warn` and recovery messages | `disable_notification=true` |
| Text | `[CRITICAL] backup status=CRITICAL host=clinic-ubuntu-01 at=2026-11-20T16:00:00Z runbook=docs/monitoring-runbook.md` — no PHI, JWT, API key, email, phone or path; `parse_mode` absent |
| Success | exit 0, `ok:true` accepted, failure counters cleared |
| 429 + `retry_after` | exit 0, 3 attempts, `telegram.delivery_failed` reason `http_429` |
| 5xx (503) | exit 0, 3 attempts, reason `http_5xx` |
| Timeout (no response) | exit 0, 3 attempts, reason `http_000` |
| Malformed 200 response | exit 0, 3 attempts, reason `malformed_response` |
| Degraded after 3 consecutive failures | `telegram.delivery_degraded` high written locally; restored event on next success |
| Missing config / insecure base without flag | clear local line, 0 mock requests |
| Secret scan of test artifacts | `token_hits_in_test_artifacts=0` |
| Live process scan during retry | `token_hits_in_process_argv=0`; curl argv observed as `-K <cfg>` only |
| No storm — sustained stale condition, 8 consecutive cycles | `1` Telegram message (dedup held) |
| Flapping 10/700/10/700/10 s | `4` messages (2 warn, 2 recovery) — dedup/escalation/recovery behavior preserved, no storm |

---

## 3. Proxy access-log redaction

**Validation:** `nginx -t` passed (using `--add-host backend:127.0.0.1` so the upstream name resolves during the offline test); `caddy validate` passed with `CLINIC_DOMAIN=clinic.test` (`Valid configuration`).

**Before → after, same request** (`?q=P7-PHI-NAME-1234&token=P7-FAKE-TOKEN`, fake `Authorization`/`Cookie`/`Referer`):

- Before (nginx default combined format):
  `172.17.0.1 - - [20/Nov/2026:16:54:49 +0000] "GET /api/v1/reports?q=P7-PHI-NAME-1234&token=P7-FAKE-TOKEN HTTP/1.1" 502 150 "https://clinic.test/report?q=P7-PHI-NAME-1234" "curl/8.22.0" "-"`
- After (redacted `clinic_access`):
  `{"time":"2026-11-20T16:52:09+00:00","remote":"172.17.0.1","method":"GET","path":"/api/v1/reports","status":502,"bytes":...,"duration":...,"request_id":...}`

The after-log contains no query string, Referer, Authorization or Cookie. Caddy's filter was proven in a disposable container: the logged `uri` became `/api/v1/reports` while the request still reached the upstream.

**Functional (non-logging) behavior is unchanged:** an isolated `p71-upstream` received the full URL with query string plus `Authorization: Bearer P7-FAKE-TOKEN` and `Cookie: session=P7-FAKE-COOKIE`, while the nginx access log still showed only `path=/api/v1/health`; SPA `/` returned 200. No security header, route, TLS, upload-body or proxy setting was altered.

---

## 4. Local sink rotation

- `P7_SINK_MAX_BYTES` (default 1048576) and `P7_SINK_KEEP` (default 5) live in `p7-common.sh`. `p7_sink_rotate()` renames only files named exactly `<sink>.<number>`; no unrelated file is ever deleted, and rotation happens before every append so the newest line is never lost. `P7_SINK_MAX_BYTES=0` disables built-in rotation for hosts that prefer `deploy/clinic-monitor.logrotate`.
- **Proof:** 60 synthetic lines with `P7_SINK_MAX_BYTES=50`, `P7_SINK_KEEP=3` produced 4 files of 54 bytes / 6 lines each; retained line numbers `37–60` were contiguous and distinct (24 lines). No unrelated files existed or were touched.

---

## 5. External dead-man's switch hook

- `scripts/p7-heartbeat-hook.sh` is optional (`P7_HEARTBEAT_URL`). It pings **only after a completed cycle** — never on a skipped cycle or a crashed/aborted pass.
- The URL is treated as a secret: it is written only into a `0600` curl config file and never appears in argv, logs or the sink. HTTPS-only unless `P7_ALLOW_INSECURE_TEST=1`; short timeout; failure is non-blocking (always exit 0) and records `heartbeat.failed_http_<code>` / `heartbeat.delivery_degraded` locally. Consecutive-failure local escalation mirrors Telegram.
- **Evidence:** completed cycle → 1 ping; `P7_SKIP_CYCLE=1` → 0 pings; artificially crashed monitor (bad heartbeat-file path) → 0 pings with monitor rc=1; unreachable ping → monitor rc=0 and `heartbeat.failed_http_000` in the sink; `secret_hits=0` across all test artifacts.

**Provider options (documentation only — no account was chosen, contacted or created):**

1. **Healthchecks.io** (hosted or self-hosted): a unique HTTPS ping URL per check, with silence-based alerts and a dashboard. Simple cron/systemd-friendly integration; hosted tier has data-retention/privacy considerations for a clinic.
2. **Cronitor** (hosted): similar ping/monitor model with richer scheduling and escalation; commercial and external.
3. **Self-hosted endpoint (e.g. a small internal service or an existing ntfy/uptime stack)**: keeps the callback inside clinic infrastructure and avoids a third party, but requires the clinic to operate and secure it.

The hook is provider-agnostic — it only needs one secret HTTPS URL. The clinic must decide the provider and supply the URL before any production use.

---

## 6. Backend route-level redaction and API-contract regression

- New `backend/tests/phase7-route-redaction.test.ts` runs a real in-process Express app against an isolated PostgreSQL database `p71_route_test` (name ends in `_test`; the test refuses any other name). It tees stdout/stderr and injects synthetic PHI/JWT/API-key/email/password markers into request bodies, query strings, headers, filenames and thrown service/Prisma errors, then asserts none reach operational log lines.
- Service-error injection uses `findFirst` (directly awaited by `GET /patients/:id`) rather than a delegate used inside `prisma.$transaction([...])`; the initial `findMany` patch created an unhandled rejection under `node:test` and was corrected. P2002 injection uses `findUnique` via `PATCH /patients/:id` with a neutral `meta.target`, so no PHI is echoed in the response either. Both patches are restored in `finally`.
- Evidence: `npm run typecheck` passed. Focused test: `1/1 pass`. Full suite on the isolated DB: **149 tests, 149 pass, 0 fail** versus baseline **148/148/0** — exactly one new test, no new failures. The 2 known B1 failures did not reproduce in either run; B1 is listed but not fixed.
- **Status coverage observed:** `401` (login failure, unauthenticated, fake JWT), `200` (patient search, patient update, report finalize, print-data), `201` (patient create, visit, file upload, report, payment), `409` (Prisma P2002), `500` (service error), `400` (validation and disabled WhatsApp provider), `404` (unmatched route), `403` (receptionist clinical access). `422` is **Not exercised** — the helper exists in `src/lib/errors.ts` but no route returns it.
- **API contract review:** the committed Phase 7 backend logging diff (`app.ts`, `middleware/error.ts`, `lib/audit.ts`, `lib/prisma.ts`, `index.ts`) changes only logging; no response body, status code or route behavior changed. The new test is a characterization proof of that contract, not a behavior change.

---

## 7. Disposable real-container injection

Only `p71*` resources and synthetic data were used. Because no local image has both bash and an HTTP client, a **test-only** `curl` shim in the mounted `bin/` directory implemented the exact `-K` subset using Bash `/dev/tcp` — it performs a real HTTP request to the local `p71-tg-mock` on the isolated `p71-proxy-net`. No production image, volume, container or port was used.

| Scenario | Result |
|---|---|
| Stale heartbeat injected (age 7200 s) in `p71-monitor-inject` | `monitor.heartbeat` `critical`/`page` in sink; Telegram message `silent=false`; 1 heartbeat ping; monitor rc=0 |
| Skipped cycle (`P7_SKIP_CYCLE=1`) | 0 pings |
| Crashed monitor (invalid heartbeat-file path) | 0 pings; rc=1 |
| 429 from mock | 2 attempts, `telegram.delivery_failed` (`http_429`) in sink, monitor rc=0, no storm |
| Secret scan of container artifacts | `secret_hits=0` |

---

## 8. Findings

| Severity | Status | Finding |
|---|---|---|
| Medium | **Resolved in Phase 7.2** | nginx `error_log` included the full request URI and Referer on upstream failures. Phase 7.2 keeps only `crit` in that file and writes a path-only structured `upstream-failures.log`; see Phase 7.2 §2. |
| Low | **Resolved in Phase 7.2** | The logger's phone scrubber over-redacted long digit runs inside UUIDs. Phase 7.2 tokenises valid UUIDs before phone scrubbing and restores them afterwards; see Phase 7.2 §3. |
| Info | **Resolved in this phase** | Initial route test injected errors through a delegate used inside `$transaction`, causing an `unhandledRejection`; changed to directly-awaited delegates. |
| Info | **Resolved in this phase** | `severity=page` initial Telegram routing was silent; changed to loud for `page`/`unknown` and `critical`/`high` status. |
| Info | **Resolved in Phase 7.2** | HTTP `422` was not exercised because no production route returns it. Phase 7.2 adds a focused middleware test on a real route path without inventing an endpoint; see Phase 7.2 §4. |

---

## 9. Manual Ubuntu actions (NOT performed here)

All of the following remain for the clinic after approval and before production use:

1. Choose the alert channel/provider and, for Telegram, create the bot and obtain the chat id; populate `/etc/clinic/monitor.env` (mode `0600`, owner `deploy:deploy`) using `deploy/monitor.env.example`. Never commit it.
2. Set `P7_HOST_LABEL` to a short, non-sensitive host name.
3. Decide whether to use the built-in sink rotation or `deploy/clinic-monitor.logrotate`; if the latter, set `P7_SINK_MAX_BYTES=0`.
4. Install the `monitoring` Compose overlay and/or the uninstalled systemd templates in `deploy/` with a reviewed timer schedule; no timer/cron/service was installed by this audit.
5. Roll out the redacted/hardened `web/nginx.conf` and `deploy/Caddyfile` with the normal deployment process, then confirm access logs in production contain path-only entries and that no request-bearing upstream error detail is shipped. See Phase 7.2 §2.
6. Configure a separate external scheduler to run `p7-check-heartbeat.sh` so a stopped monitor is detectable.
7. Decide the dead-man's-switch provider and set `P7_HEARTBEAT_URL` (HTTPS) if used.
8. Resolve baseline blockers B1–B9 (in particular B1 failing tests, B4 CI and B9 approvals) before go-live.

---

## 10. Production-untouched confirmation and resource lifecycle

**Not touched:** the running `ultrasound-clinic-*` production-looking containers, any production volume, any production port, `.env` secrets, report blocks/templates/finalized reports, migrations or clinical workflows. No `docker compose down -v`, prune, volume deletion, migration against production, deploy, external call, credential use, timer, cron or systemd install was performed.

**Created for this phase (all disposable `p71*`):** containers `p71-caddy-logtest`, `p71-caddy-logtest2`, `p71-nginx-before`, `p71-nginx-after`, `p71-nginx-func`, `p71-upstream`, `p71-tg-mock`, `p71-backend-db`; network `p71-proxy-net`; temporary directory `C:\Users\Moustafa\AppData\Local\Temp\opencode\p71audit-20261120-1630`. Several `--rm` validation containers (`p71-caddy-adapt`, `p71-caddy-validate`, `p71-nginx-validate`, `p71-caddy-help`, `p71-caddy-modules`, `p71-*-probe`, `p71-monitor-*`) were ephemeral and already exited. All persistent resources are deleted only after this report is written, and only those exact names are targeted.

---

## 11. Review stop gate

Phase 7.1 is complete for review and its residuals were addressed in Phase 7.2. **Stop here.** No Phase 8 (CI/CD), deployment, scheduler installation or external account creation was started. Await review/approval before any further change.

---

## 12. Phase 7.2 remediation pointer

`docs/PRODUCTION_READINESS_PHASE7_2.md` records the repository-only remediation of the three residual findings above, the local-mock regression of Telegram/heartbeat/rotation/proxy behavior, the corrected backup-storage wording, and the final validation results. It is the current stop-gate report.
