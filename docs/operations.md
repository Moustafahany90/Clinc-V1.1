# Operations: TLS, Health, Backups, Monitoring

## Deployment topology

```
Browser --HTTPS--> Caddy (443) --HTTP--> web/nginx --/api/v1--> backend --> Postgres
```

Only Caddy is exposed publicly. The base compose file binds web (`127.0.0.1:8080`),
backend (container-only), and Postgres (`127.0.0.1:55432`) to localhost. Do not
change `WEB_BIND` or `POSTGRES_BIND` to `0.0.0.0` on a production host.

## First production start

1. Copy `.env.example` to `.env`; do not commit it.
2. Set at minimum:
   ```dotenv
   NODE_ENV=production
   APP_ORIGIN=https://clinic.example.com
   COOKIE_SECURE=true
   TRUST_PROXY=1
   POSTGRES_PASSWORD=<random>
   JWT_ACCESS_SECRET=<random 48+ bytes>
   JWT_REFRESH_SECRET=<different random 48+ bytes>
   CLINIC_DOMAIN=clinic.example.com
   ```
3. Validate the rendered compose file and start with TLS:
   ```bash
   docker compose config >/dev/null
   CLINIC_DOMAIN=clinic.example.com docker compose \
     -f docker-compose.yml -f docker-compose.tls.yml up -d --build
   ```
4. Complete the first-run setup wizard at `https://clinic.example.com`.
5. Confirm `curl -fsS https://clinic.example.com/healthz` returns `status: ok`
   and `database: reachable`.

The backend exits on startup if production configuration is unsafe: HTTP
`APP_ORIGIN`, `COOKIE_SECURE=false`, `TRUST_PROXY=0`, identical/placeholder JWT
secrets, or a placeholder Evolution API key. This is intentional; fix the config
instead of bypassing it.

For a LAN-only hostname without public DNS, add `tls internal` inside
`deploy/Caddyfile` and install Caddy's local root certificate on clinic devices.
The browser must still use an HTTPS origin.

## Health and readiness

- `GET /healthz` — process + database readiness. Returns `503` if Postgres is
  unreachable; includes an `audit` object with `writeFailures` and
  `lastFailureAt`.
- `GET /api/v1/health` — lightweight legacy liveness.
- `GET /api/v1/health/db` — explicit database check.
- `GET /api/v1/readyz` — same payload as `/healthz` under the API prefix.

Docker uses `/healthz` for the backend healthcheck. A backend container that is
running but cannot reach the database is unhealthy.

## Logs and monitoring

- All services use Docker `json-file` logging capped at 10 MB × 5 files.
- The backend emits one JSON object per line on stdout: UTC `ts`, `level`,
  `event`, `service`, plus an allowlisted set of fields. `LOG_LEVEL` defaults to
  `info`; `debug` is clamped to `info` in production. Request logs include
  request id, method, route template, status, duration, user id and role — never
  raw paths, query strings, bodies, headers or stack traces.
- Use `docker compose logs --since 1h backend` or ship stdout/stderr to the
  clinic's log platform. Never log full request bodies, report content, tokens,
  passwords, WhatsApp keys, QR/session data, or full phone numbers.
- Audit write failures emit one structured JSON line:
  `{"event":"audit.write_failed", ...}` with a hashed entity id, and increment
  `/healthz`'s `audit.writeFailures`. Alert on any increase and on `/healthz`
  returning 503.
- Phase 7 adds opt-in, read-only checks for backup age/mount/verification,
  capacity, container health, certificate expiry, WAL backlog, clock sanity and
  a monitor heartbeat. They are enabled with the `monitoring` Compose profile
  or run directly. The local JSONL sink remains authoritative.
- Phase 7.1 adds an opt-in Telegram adapter and external dead-man's-switch hook.
  Both are inert unless their env variables are supplied from a protected
  `/etc/clinic/monitor.env` (template in `deploy/monitor.env.example`); both were
  validated only against a local mock and revalidated in Phase 7.2 with
  `scripts/p72-phase7-regression.sh`. Telegram messages are a strict allowlist
  and failures never block a check.
- Approved thresholds: backup age 26 h; capacity 70/85/95%; certificate expiry
  30/14/7 days; WAL count 50/200/500 and age 900/3600/7200 s; clock drift
  60/300/900 s; heartbeat 600/1800/3600 s.
- No timer, cron job, systemd unit, external account or production channel is
  installed by the audit. No Ubuntu deployment or production rollout has been
  performed or verified. See `docs/monitoring-runbook.md` for operation and
  `docs/PRODUCTION_READINESS_PHASE7_2.md` for current validation evidence and the
  remaining manual Ubuntu actions.
- Reverse-proxy **access** logs are redacted in `web/nginx.conf` and
  `deploy/Caddyfile`: path-only (no query string), no Referer/Authorization/Cookie.
  Both configs validate (`nginx -t`, `caddy validate`) and functional proxy
  behavior was proven unchanged in disposable containers. Phase 7.2 also limited
  nginx `error_log` to `crit` and added a path-only structured
  `upstream-failures.log`, so upstream diagnostics do not leak query strings or
  Referer values. See `docs/PRODUCTION_READINESS_PHASE7_2.md` §2.
- Retain logs according to clinic policy and protect them as PHI-adjacent data.
  The local monitor sink rotates itself (`P7_SINK_MAX_BYTES`, `P7_SINK_KEEP`);
  `deploy/clinic-monitor.logrotate` is an optional host-managed alternative.

## WhatsApp report delivery

Evolution API is **mandatory core infrastructure**. It starts automatically
with the standard stack command; there is no profile flag to remember:

```bash
docker compose up -d
```

No Compose profile or profile environment variable is needed for Evolution
startup. Evolution runs on the internal `clinic_net` only (no host port is
published) and is reached by the backend at `http://evolution:8080`. API-key
authentication is always enabled. Delivery itself remains an opt-in application
feature: it is active only when `EVOLUTION_API_ENABLED=true`. Sending is a
manual action on a finalized report; there is no automatic send after
finalization. The server generates a PDF from the pinned report snapshot and
sends it through the self-hosted Evolution API (WhatsApp/Baileys, QR pairing).
Only the provider message id, status and the recipient's last four digits are
stored with the delivery record; the PDF is not written to clinic storage.

Required configuration (server side only, never exposed to the browser):

```dotenv
EVOLUTION_API_ENABLED=true
EVOLUTION_API_URL=http://evolution:8080
EVOLUTION_API_KEY=<required shared secret; used by the evolution service and the backend>
EVOLUTION_INSTANCE_NAME=ultrasound_clinic
EVOLUTION_API_TIMEOUT_MS=30000
EVOLUTION_DEFAULT_COUNTRY_CODE=20
```

`EVOLUTION_API_KEY` is required by Compose; `docker compose up -d` fails fast if
it is unset. The same value configures `AUTHENTICATION_API_KEY` on the evolution
service and the backend client. Replace the placeholder in `.env.example`
before production.

Setup and operation:

- Start / restart the whole stack with `docker compose up -d`. Evolution starts
  automatically, waits for the database to be healthy, and has a health check
  (unauthenticated `GET /manager/` → HTTP 200). The backend deliberately does
  **not** wait for Evolution health: a slow or unhealthy provider cannot block
  the clinic backend, web app, or core workflows. WhatsApp calls retry safe
  transient failures and then return a clear `WHATSAPP_*` error; they recover
  once Evolution is available again. The pinned image
  (`evoapicloud/evolution-api:v2.3.7`) is unchanged; no separate Evolution
  database or Redis is introduced (the local cache is used).
- The paired WhatsApp session is kept in the
  `ultrasound_clinic_evolution_instances` volume. Never delete or recreate this
  volume; back it up whenever the database is backed up, because without it the
  phone must be paired again. Container and stack restarts preserve it.
- Evolution has no host port. For local development, run the backend in Docker
  (`docker compose up -d`) so it can reach `http://evolution:8080` internally.
  If direct host access is ever needed for debugging, add a temporary loopback
  mapping in a local override file (not in the committed Compose config) and
  remove it afterwards.
- The backend retries only safe transient failures (connection refused/reset,
  idempotent status-read timeouts) with a small bounded backoff, and reports a
  clear `WHATSAPP_*` error when it exhausts them. A timed-out document send is
  never automatically replayed, because the provider may already have accepted
  it; use the explicit resend flow instead.
- Pair the clinic phone from **Settings → WhatsApp delivery → Connect**, then
  scan the QR code with WhatsApp on that phone. The status shows
  `open` when the session is active. `Disconnect` logs the device out and
  requires a new scan.
- Keep `EVOLUTION_API_KEY` secret and rotate it if it is ever shared; never
  paste it into logs, screenshots or tickets. Audit events do not include keys,
  QR payloads or full phone numbers. Changing the key requires restarting the
  stack so both Evolution and the backend pick it up.
- Obtain the clinic's patient-consent policy before enabling the feature. The
  UI requires a deliberate consent acknowledgement for every send.
- Patient phone numbers are converted to digits-only international form using
  `EVOLUTION_DEFAULT_COUNTRY_CODE`. A missing or invalid number returns a
  validation error; no full number is written to the delivery record or audit
  metadata.
- Monitor `report.whatsapp_sent` / `report.whatsapp_failed` audit events. A
  failed provider call leaves a `FAILED` delivery row and can be retried from
  the report screen; a successful send requires an explicit resend confirmation.
- Test with a synthetic patient and the clinic's test number before enabling
  the feature for real patients. Never use a real report for testing.

## Backups

Run the database and every persistent volume together:

```bash
./scripts/backup.sh
```

The script writes one complete, encrypted, checksummed set directory to the
verified destination:
`/mnt/clinic-backups/<tier>/clinic-<tier>-<STAMP>/`. It contains the encrypted
database dump, uploads archive, Evolution session archive and Caddy TLS
archives when present, plus `SHA256SUMS` and `MANIFEST.txt`. Artifacts are
staged and verified before publication, so a failed run does not leave a
normal-looking partial set. The manifest is written last and marks a complete
set. The script never deletes old backups.

Backups contain PHI. The approved production destination is a dedicated **500 GB
internal SATA HDD** mounted by UUID at `/mnt/clinic-backups`. It is **local backup
storage only**; no off-site provider or rclone remote is configured. A separate
**USB flash drive is reserved solely for age private-key escrow**, not for backup
or WAL data. No Ubuntu deployment or production rollout has been performed or
verified.

```bash
# In /etc/clinic/backup.env (mode 0600, root:root), public recipient only:
BACKUP_ROOT=/mnt/clinic-backups
BACKUP_TIER=daily
BACKUP_EXPECTED_UUID=0f21089c-c507-4903-96e5-daf637100d53
BACKUP_EXPECTED_FSTYPE=ext4
BACKUP_AGE_RECIPIENT=age1...
BACKUP_REQUIRE_ENCRYPTION=1
BACKUP_QUIESCE_SERVICES='backend web evolution'

./scripts/backup.sh
```

`BACKUP_QUIESCE_SERVICES` stops application writers for the dump/tar window and
restarts them on success or failure; never include `db`. Before creating any
directory, the script validates the real mount, approved UUID (`0f21089c-…`),
`ext4` filesystem, required directory structure, destination containment and
writability. A missing age recipient or `age` binary also fails closed. There is
no fallback to the root filesystem and no plaintext output. Store the age
private key in escrow on a separate USB flash drive (`docs/backup-restore.md`).

Schedule: daily at 02:00 `Africa/Cairo`, plus before upgrades and migrations.
Capacity alerts fire at 70%, 85%, and 95%; 95% aborts backup creation. Retention
will be proposed after measuring real set sizes, growth, and WAL generation. No
automatic deletion occurs until dependency-aware retention is implemented and
tested.

### Verify backups (read-only, suitable for monitoring)

```bash
./scripts/backup-verify.sh
BACKUP_MAX_AGE_HOURS=26 BACKUP_VERIFY_REQUIRE_ENCRYPTION=1 \
  ./scripts/backup-verify.sh
```

The verifier discovers `clinic-<tier>-<STAMP>` sets under `daily/`, `weekly/`
and `monthly/`, validates the mount/UUID/filesystem assumptions, and checks
each `MANIFEST.txt`, every declared encrypted artifact, its SHA-256 and size,
`SHA256SUMS`, orphan artifacts, set age and permissions. Exit status is non-zero
on any error. Cron/systemd should run it after each backup and alert on failure;
the age check catches a silently stopped scheduler. No schedule is enabled by
this phase. The preserved legacy dump `backups/db-20261113T134414Z.dump` is
outside the approved layout and is not a recovery source.

### PITR and host permissions (Phase 6.1)

PITR was proved only in a disposable PostgreSQL 16 stack (base backup plus WAL
archive, restored by name and time). The approved production design places WAL
archives on the internal backup HDD under `/mnt/clinic-backups/wal-archive` with
`archive_timeout=300s` and a mount-checked `archive_command`. Production WAL
archiving is still off and the production RPO remains unbounded. Do not claim a
5-minute RPO until deployment, archive monitoring, retention and an isolated
target-host restore are proven and recorded. See
`docs/PRODUCTION_READINESS_PHASE6_1.md` §7 and §17.

Phase 8.3.1 verified the real host: backup root and all tier/support directories
are `root:root 0700`, only root can write, the recipient file is `root:root 0600`,
and the only non-system account is `clinc_server` (no `deploy`/`clinicdeploy`).
Backups and monitoring must therefore run as root until a dedicated least-
privilege service account is approved. **No host permissions were changed and no
Ubuntu deployment/production rollout was performed.** See
`docs/PRODUCTION_READINESS_PHASE8_3_1.md` §4.

### Restore drill (non-destructive)

```bash
./scripts/restore-drill.sh backups/db-<timestamp>.dump
# Or include the matching uploads archive for full reconciliation:
./scripts/restore-drill.sh backups/db-<timestamp>.dump \
  backups/storage-<timestamp>.tar.gz
```

The drill verifies the matching checksums, restores only into a database whose
name ends in `_drill`, prints per-table counts and a summary, checks migrations
and the Evolution schema, and (with the storage archive) checks every
`FileAsset` file and size while reporting orphans. It then drops the disposable
database unless `KEEP_DRILL_DB=1` is set. It never touches the clinic database.
`.age` inputs are rejected; decrypt them first on a trusted host. Record the
date, artifact names, counts, and operator in the clinic's operations log.
Run a drill at least quarterly and after any change to the backup process.
For old dump-only artifacts with no manifest or checksums, follow the staged
legacy verification path in `docs/backup-restore.md` (“Legacy backup sets”);
do not modify the original artifact.

### Full restore (requires explicit approval)

Follow `docs/backup-restore.md` exactly. Announce downtime, stop **web,
backend, Evolution, and Caddy (when the TLS overlay is used)**, take a fresh
verified backup, restore the database with
`--single-transaction --exit-on-error`, replace the uploads volume contents
from the matching archive, invalidate restored sessions, then start the stack
and verify `/healthz`, a known patient/report, audit history, and a file
download. Restore Evolution/Caddy volumes only if they were lost.
Do not delete Docker volumes without written approval; prefer restoring into
the existing database and never run `docker compose down -v`,
`docker volume prune`, or `docker system prune` on production.

## Migrations

Use only committed migrations:

```bash
docker compose run --rm migrate
```

Never run `prisma db push` against a shared or production database. The compose
`migrate` service runs `prisma migrate deploy` before the backend starts. CI
applies every migration to an empty Postgres database and checks for schema
drift.

## Credential rotation

See [SECURITY.md](../SECURITY.md). Password changes and account archive/restore
increment `User.tokenVersion`, so old access tokens stop working immediately;
JWT secret rotation invalidates all sessions at once.
