# Clinic-V1.1 — Production Readiness Phase 7: Logging, Monitoring and Alerting

**Date:** 2026-11-20
**Scope:** Phase 7 Part A (read-only audit) and Part B (allowlisted repo-only implementation and isolated validation)
**Branch / HEAD:** `feature/clinic-quick-actions` @ `fd128f5b74b69dcc7d87157e60abb92decfe327d`
**Overall status:** **Complete for review. Production validation NOT PERFORMED. Alert-channel decision pending approval.**
**Related runbook:** `docs/monitoring-runbook.md`

---

## 1. Safety and pre-flight

Recorded before work began:

```text
git branch --show-current        -> feature/clinic-quick-actions
git rev-parse HEAD               -> fd128f5b74b69dcc7d87157e60abb92decfe327d
git status --short               -> 41 modified tracked files + pre-existing untracked Phase 5/6 work
git diff --stat                  -> 48 tracked files changed, 2897 insertions(+), 776 deletions(-)
```

All pre-existing dirty/untracked work was preserved. No commits, pushes, resets,
clean operations, destructive Docker commands, migrations, report/template
changes, business-logic changes or Phase 8 work were performed.

Docker Desktop was **not started**. A pre-flight probe returned:

```text
failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine
Compose v5.7.0
```

Starting it could auto-restart production containers, so all runtime validation
used in-process tests, synthetic files and stubbed binaries under
`%TEMP%\opencode\p7audit-*`. Compose file syntax was validated with
`docker compose config --quiet` (no daemon required).

---

## 2. Part A — read-only inventory findings

### 2.1 Logging before Phase 7

| Area | Finding before | Risk |
|---|---|---|
| Logger | No pino/winston/morgan. Only `console.*` in `index.ts`, `audit.ts`, `error.ts`, `env.ts`. | Unstructured, unbounded, no redaction or level control. |
| Request telemetry | No per-request status, duration, route template, request id, user id or role. | Security and availability failures were invisible. |
| Error path | `request.failed` used raw `req.path`. | Raw paths can contain identifiers/PHI-like values and query strings. |
| Prisma | Prisma client used default logging configuration. | Query/error logging can include bound parameters (PHI/secrets). |
| Reverse proxy | nginx/Caddy access logs include request URI and query string. | Query strings may carry PHI or tokens. **Not fixed** — outside B0 allowlist. |
| Audit log | DB `AuditLog` with actor/action/entity/patient/metadata/ip/userAgent/createdAt; readable via `GET /api/v1/audit` with `AUDIT_READ`. | Adequate for write actions, but not a substitute for operational logs. Reads of many clinical records are not audited. |
| Auth/security signals | Code has lockout after 8 failures/15 min and refresh-reuse family revocation, but no dedicated alert events. | Brute-force/session-reuse was not visible to operations. |
| Infrastructure signals | Phase 5 configured `json-file` logging `10m × 5` on every service. No `daemon.json` guidance existed. Backend healthcheck used `/healthz`; Caddy had no healthcheck. | Local disk growth bounded per container but no host-wide cap or Caddy liveness. |
| Existing alerting | None in repository. Phase 6/6.1 backup checks and thresholds existed but no scheduler or channel. | Silent backup/capacity/WAL/certificate failures possible. |

### 2.2 Health endpoints confirmed

- `GET /healthz` — process + database readiness; `503` if Postgres unreachable; includes `audit.writeFailures` and `lastFailureAt`.
- `GET /api/v1/health` — lightweight legacy liveness.
- `GET /api/v1/health/db` — explicit database check.
- `GET /api/v1/readyz` — same payload as `/healthz` under the API prefix.

### 2.3 Severity of Part A findings

| Severity | Finding | Disposition |
|---|---|---|
| High | Prisma query/parameter logging could leak PHI into operational logs. | Fixed: `log: []` in `backend/src/lib/prisma.ts`. |
| High | No alerting for backup, capacity, container, WAL, certificate or heartbeat failures. | Fixed locally via opt-in checks + JSONL sink; external channel approval-gated. |
| Medium | Raw `req.path` in error logs. | Fixed: `safeRoute(req)` emits route templates only. |
| Medium | No structured request telemetry. | Fixed: `http.request` with requestId/method/safe route/status/duration/userId/role. |
| Medium | Audit write failures had only a counter. | Improved: structured `audit.write_failed` line with hashed entity id. |
| Medium | nginx/Caddy access logs include query strings. | **Requires approval** — `web/nginx.conf` and `deploy/Caddyfile` are outside the B0 allowlist. |
| Low | Caddy had no healthcheck. | Fixed in `docker-compose.tls.yml`. |
| Low | Local monitor sink is append-only JSONL with no built-in rotation. | Documented; ship/rotate under host log policy before enabling continuously. |

---

## 3. Part B — files changed

### 3.1 Created

**Backend / logging**

- `backend/src/lib/logger.ts`
- `backend/tests/phase7-log-redaction.test.ts`

**Compose**

- `docker-compose.monitoring.yml` (opt-in `monitoring` profile, local monitor + JSONL sink, read-only script mount, read-only Docker socket, inline log rotation)

**Scripts**

- `scripts/p7-common.sh`
- `scripts/p7-check-backup.sh`
- `scripts/p7-check-capacity.sh`
- `scripts/p7-check-containers.sh`
- `scripts/p7-check-cert.sh`
- `scripts/p7-check-wal.sh`
- `scripts/p7-check-time.sh`
- `scripts/p7-check-heartbeat.sh`
- `scripts/p7-monitor.sh`

**Deployment templates (created, not installed)**

- `deploy/clinic-monitor.service`
- `deploy/clinic-monitor.timer`
- `deploy/clinic-heartbeat-check.service`
- `deploy/clinic-heartbeat-check.timer`

**Docs**

- `docs/PRODUCTION_READINESS_PHASE7.md` (this file)
- `docs/monitoring-runbook.md`

### 3.2 Modified

- `backend/src/config/env.ts` — added `LOG_LEVEL` enum, default `info`.
- `backend/src/app.ts` — request logger; debug-only health probe logging.
- `backend/src/middleware/error.ts` — `request.failed` via `log()` + `safeRoute()`.
- `backend/src/lib/audit.ts` — `audit.write_failed` via `log()` + `hashIdentifier()`.
- `backend/src/index.ts` — structured `api.listening`, `api.shutting_down`, `api.start_failed`.
- `backend/src/lib/prisma.ts` — `log: []`; removed unused `env` import.
- `docker-compose.yml` — passes `LOG_LEVEL`; Phase 5 log rotation retained.
- `docker-compose.tls.yml` — Caddy healthcheck.
- `docs/operations.md` — Phase 7 monitoring section and references.
- `docs/PRODUCTION_READINESS_BASELINE.md` — Phase 7 status, B8 update, changelog.

**Not modified:** `.env.example`, `web/nginx.conf`, `deploy/Caddyfile`, any
migration, report block/template, finalized-report code, clinic workflow code,
production host, Docker volumes, schedules or credentials.

---

## 4. Leakage controls — before/after

### 4.1 Before (static)

Potential leak paths identified before the fix:

1. `request.failed` logged raw `req.path`.
2. Prisma configuration did not explicitly disable query/parameter logging.
3. nginx/Caddy access logs include full request URI and query string.
4. No redaction layer existed for free-text error fields.

### 4.2 After (tested)

`backend/tests/phase7-log-redaction.test.ts` uses synthetic markers:

```text
P7-PHI-NAME-JaneDoe
P7-PHI-PHONE-12025550123
patient.p7@example.test
eyJhbGci... (fake JWT)
sk_live_p7abcd1234efgh
p7PlaintextPassword123
```

Result:

```text
node --test --test-concurrency=1 --import tsx tests/phase7-log-redaction.test.ts
# tests 4
# pass 4
# fail 0
```

Representative captured line:

```json
{"ts":"2026-11-20T...Z","level":"info","event":"phase7.test","service":"ultrasound-clinic-api","message":"token=[REDACTED_JWT] apiKey=[REDACTED_SECRET] password=[REDACTED]"}
```

Assertions verify that:

- none of the synthetic PHI markers, phone digits, email, JWT, API key or password value appear in stdout;
- sensitive keys (`patientName`, `phone`, `email`, `token`, `apiKey`, `password`, `body`, `query`, `headers`) are dropped by the allowlist;
- `safeRoute()` emits `/api/v1/patients/:id`, never raw paths/query strings, and replaces UUIDs with `:id`;
- `hashIdentifier()` emits only `h_<12 hex>` and is deterministic;
- Prisma query logging is disabled in source.

Also verified:

```text
npm run typecheck  -> PASS
npm run build      -> PASS
```

**Remaining exposure (approval-gated):** reverse-proxy access logs still contain
request URIs/query strings because `web/nginx.conf` and `deploy/Caddyfile` are
not in the B0 allowlist. Proposed change: redact or omit `$args`/`{uri}` query
components after approval.

---

## 5. Alert catalog

Exit codes used by all check scripts:

| Status | Exit | Severity label | Meaning |
|---|---:|---|---|
| ok | 0 | info | Within thresholds |
| warn | 1 | info/warn | Early warning or non-blocking |
| high | 2 | warn | Action required soon |
| critical | 3 | page | Immediate operational action |
| unknown | 4 | unknown | Check could not be performed |

| Check | Trigger | Status | Runbook |
|---|---|---|---|
| `backup` | Required mount missing; no complete manifest; newest backup > 26 h | critical | `#backup` |
| `backup` | `backup-verify.sh` non-zero | high | `#backup` |
| `backup` | Verification skipped (test only) | warn | `#backup` |
| `capacity` | Disk/inode >= 70% / 85% / 95% | warn / high / critical | `#capacity` |
| `capacity` | Configured path absent | high | `#capacity` |
| `container:*` | OOM-killed, not running, or core db/backend unhealthy | critical | `#containers` |
| `container:*` | Restart delta >= 1, non-core unhealthy | high | `#containers` |
| `container:*` | Evolution unhealthy | warn (non-blocking; WhatsApp only) | `#containers` |
| `cert:*` | Expiry within 7 / 14 / 30 days | critical / high / warn | `#certificates` |
| `wal:*` | Count >= 50/200/500 or oldest age >= 900/3600/7200 s | warn / high / critical | `#wal` |
| `system.time` | Drift >= 60/300/900 s; NTP unsynchronised | warn / high / critical | `#clock` |
| `monitor.heartbeat` | Missing or stale > 600/1800/3600 s | critical / high / warn | `#dead-mans-switch` |
| `monitor.recovery` | Non-ok condition cleared | ok/info | `#recovery` |

`p7-monitor.sh` additionally emits `monitor.complete` to stdout (not to the
alert sink) with alert/suppressed/recovery counts. It runs one pass by default;
the opt-in Compose overlay calls it with `--loop` and `P7_INTERVAL_SEC`
(default 300 s). Dedup window defaults to 300 s (the overlay maps
`P7_ALERT_REPEAT_SEC` to it); max alerts per check per window defaults to 10;
escalation bypasses dedup. Recovery notices are emitted once when a check
returns to `ok`.

No external channel is contacted. All forwarded alerts go only to the local
JSONL sink (`P7_ALERT_SINK`, default `/var/lib/clinic-monitor/alerts.jsonl`).

---

## 6. Isolated validation and injection results

All checks ran against synthetic directories and stubbed `df`/`docker` binaries
under `/mnt/c/Users/.../Temp/opencode/p7audit-20261120-1610`. Time was fixed at
`2026-11-20T12:00:00Z` (`P7_NOW_EPOCH=1795176000`). Detection time below is the
measured wall-clock duration of the individual check/monitor invocation, not a
production mean-time-to-detect.

### 6.1 Baseline and failure injection

| Scenario | Check | Exit | Measured time | Expected/observed result |
|---|---|---:|---:|---|
| baseline | backup | 0 | 83 ms | valid manifest, mount override, verify pass |
| baseline | capacity | 0 | 203 ms | 10% disk/inodes |
| baseline | containers | 0 | 217 ms | db/backend/evolution healthy |
| baseline | cert | 0 | 145 ms | 60-day synthetic certificate |
| baseline | wal | 0 | 77 ms | 2 fresh WAL files |
| baseline | time | 0 | 57 ms | clock matches expected epoch |
| backup-stale | backup | 3 | 84 ms | oldest manifest 1 day 12 h old |
| backup-verify-fail | backup | 2 | 80 ms | verifier stub exits non-zero |
| capacity-critical | capacity | 3 | 181 ms | 97% disk, 20% inodes |
| capacity-missing-mount | capacity | 2 | 98 ms | absent path |
| containers-core-unhealthy | containers | 3 | 225 ms | db unhealthy |
| containers-restart | containers | 2 | 237 ms | backend restart delta 2 |
| containers-oom | containers | 3 | 226 ms | backend OOM flag |
| containers-evolution-warn | containers | 1 | 232 ms | Evolution unhealthy, non-blocking |
| cert-expiring | cert | 3 | 121 ms | 3-day synthetic certificate |
| wal-stale | wal | 3 | 84 ms | oldest WAL 2.5 h old |
| time-drift | time | 3 | 48 ms | 1200 s drift |
| heartbeat-missing | heartbeat | 3 | 34 ms | no heartbeat file |

### 6.2 Monitor dedup / rate-limit / recovery

| Scenario | Monitor time | Sink lines after | Observation |
|---|---:|---:|---|
| monitor-first | 600 ms | 5 | 3 capacity failures + 1 restart failure + 1 summary |
| monitor-repeat | 646 ms | 7 | No repeated failure alerts; 2 recovery notices as transient conditions cleared |
| monitor-recovery | 666 ms | 10 | 3 additional capacity recovery notices |

Compose syntax validation:

```text
docker compose -f docker-compose.yml -f docker-compose.monitoring.yml config --quiet                         -> PASS
CLINIC_DOMAIN=p7-test.local docker compose -f docker-compose.yml -f docker-compose.tls.yml -f docker-compose.monitoring.yml config --quiet -> PASS
```

### 6.3 Validation limitations

- No running Docker daemon: no real container stop/OOM injection, no real
  container log shipping, no end-to-end container exercise with PHI-shaped data.
- No production host, backup HDD, certificate store, Postgres WAL directory or
  NTP source was accessed.
- The monitor overlay uses a read-only Docker socket mount; this was validated
  by Compose rendering only, not by a live Docker session.
- External alert channels are intentionally not implemented.

---

## 7. Audit-log and retention findings

- `AuditLog` remains the authoritative, access-controlled audit trail. The new
  operational logger is deliberately not a shadow audit log: it uses a
  default-deny key allowlist, hashes entity ids and never emits raw request
  bodies, headers, query strings or stack traces.
- Audit write failures now produce `audit.write_failed` and increment the
  `/healthz` `audit.writeFailures` counter. The clinical action is not rolled
  back, but the failure is visible.
- Gaps remain: reads of many clinical records are not audited, and there are no
  dedicated alert events for auth lockout or refresh-token reuse. These are
  application-level visibility gaps, not fixed under this Phase 7 allowlist.
- Docker `json-file` logging is capped at `10m × 5` per service (Phase 5).
  No host-level `daemon.json` cap exists in the repo.
- The local monitor JSONL sink has no built-in rotation. It must be shipped or
  rotated under the host log policy before continuous use.
- Backup retention remains unimplemented (Phase 6/6.1). Capacity and backup-age
  checks are in place, but no automatic deletion was added.

---

## 8. Manual Ubuntu actions before this can protect production

1. Deploy the updated Compose files only after explicit review. Keep
   `LOG_LEVEL=info` (or `warn`); do not use `debug` in production.
2. Create `/var/lib/clinic-monitor` mode `0700`, owned by the deploy account.
   The monitor writes only heartbeat, dedup state and `alerts.jsonl` there.
3. Set `P7_BACKUP_DIR=/mnt/clinic-backups/backups`,
   `P7_BACKUP_MOUNT=/mnt/clinic-backups`, `P7_REQUIRE_MOUNT=1`,
   `P7_MAX_AGE_HOURS=26`, and verify the internal backup HDD UUID mount before enabling checks.
4. Enable WAL archiving on the internal backup HDD (`docs/PRODUCTION_READINESS_PHASE6_1.md`)
   and set `P7_WAL_DIRS` to the local WAL/archive directories to monitor.
5. Set `P7_CERT_FILES` to the public certificate files only; never point it at
   private keys.
6. Verify NTP synchronisation on the host. Optionally supply a trusted
   `P7_EXPECTED_EPOCH` from an independent source.
7. Install a scheduler only after approval. Templates are provided in
   `deploy/clinic-monitor.{service,timer}` (every 5 minutes) and
   `deploy/clinic-heartbeat-check.{service,timer}` (every 10 minutes, independent
   dead-man's switch), but they were **not installed**. Adjust
   `WorkingDirectory`, `User/Group`, `ReadWritePaths` and
   `/etc/clinic/monitor.env` for the target host before enabling. A deploy-user
   crontab is an alternative. **Phase 7 installed no timer, cron job or systemd
   unit.**
8. Configure log shipping/rotation for `alerts.jsonl` and application stdout.
9. Decide the alert channel (§9). Until then, alerts remain local only.
10. After approval, redact query strings in `web/nginx.conf` and
    `deploy/Caddyfile` access logs, then rebuild/restart the proxies in a
    maintenance window.

---

## 9. Approval gate — alert channel options

No credentials, paid services, external endpoints or WhatsApp/Evolution paths
were configured. Three options for the required decision:

1. **Email via existing SMTP relay (recommended)** — use the clinic's current
   relay and an ops mailbox. Durable and familiar; needs relay host/port/TLS,
   sender, recipient list and a mailbox credential stored outside the repo.
2. **Self-hosted ntfy** — small HTTP publish endpoint on clinic-controlled
   infrastructure; simple JSON/POST integration and good dedup support. Needs a
   host, TLS and access tokens; no third-party message retention.
3. **Telegram bot** — fastest to trial, but adds an external dependency and
   message retention outside the clinic. Needs a bot token and chat id; should
   be avoided unless explicitly accepted by the clinic.

A local mock/sink implementation is already present (`alerts.jsonl`) and can be
used to verify formatting while a decision is pending. **No external channel
will be implemented until the clinic chooses an option.**

---

## 10. Production-untouched confirmation

Confirmed for this Phase 7 work:

- No production host, SSH session or root access used.
- No production container, image, volume, network, schedule, credential or
  `/etc` file touched.
- Docker daemon was not started; no `docker compose up/down`, `volume rm`,
  `prune`, `system prune`, `migrate reset`, `db push` or restore was run.
- No external network request, upload, real WhatsApp message or paid service
  was used.
- No `git reset --hard`, `git clean -fd`, commit, push or branch change.
- All validation used uniquely named `p7audit`/`p7-test` resources under the
  temp directory. All pre-existing dirty/untracked work remains uncommitted and
  preserved.

---

## 11. Created/deleted inventory

**Repository files created:** see §3.1.
**Repository files modified:** see §3.2.
**Repository files deleted:** none.

**Temporary validation artifacts created:**

```text
%TEMP%\opencode\p7audit-setup.sh
%TEMP%\opencode\p7audit-run.sh
%TEMP%\opencode\p7-debug.mts
%TEMP%\opencode\p7audit-20261120-1610\  (stubs, synthetic manifests/certs/WAL files, state, logs, results)
```

These artifacts contain only synthetic data and stubs. They are deleted after
the results are recorded here; no production path is included.

---

## 12. Stop gate

Phase 7 implementation and isolated validation are complete. Work stops here
for explicit review and for the alert-channel decision in §9. Phase 8 (CI/CD),
deployment, scheduler installation and external alert delivery are **not**
started.
