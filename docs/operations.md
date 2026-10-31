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
secrets, or incomplete email settings. This is intentional; fix the config
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
- Use `docker compose logs --since 1h backend` or ship stdout/stderr to the
  clinic's log platform. Never log full request bodies, report content, tokens,
  passwords, WhatsApp keys, QR/session data, or full phone numbers.
- Audit write failures emit one structured JSON line:
  `{"event":"audit.write_failed", ...}` and increment `/healthz`'s
  `audit.writeFailures`. Alert on any increase and on `/healthz` returning 503.
- Suggest alerts: backend unhealthy > 2 minutes, database unreachable, disk
  usage > 80%, backup missing for > 24 hours, audit failure counter > 0.
- Retain logs according to clinic policy and protect them as PHI-adjacent data.

## WhatsApp report delivery

This is optional and disabled unless `EVOLUTION_API_ENABLED=true`. Sending is a
manual action on a finalized report; there is no automatic send after
finalization. The server generates a PDF from the pinned report snapshot and
sends it through the self-hosted Evolution API (WhatsApp/Baileys, QR pairing).
Only the provider message id, status and the recipient's last four digits are
stored with the delivery record; the PDF is not written to clinic storage.

Required configuration (server side only, never exposed to the browser):

```dotenv
EVOLUTION_API_ENABLED=true
EVOLUTION_API_URL=http://evolution:8080   # http://localhost:8085 when the backend runs outside Docker
EVOLUTION_API_KEY=<shared secret; must equal AUTHENTICATION_API_KEY of the evolution service>
EVOLUTION_INSTANCE_NAME=ultrasound_clinic
EVOLUTION_API_TIMEOUT_MS=30000
EVOLUTION_DEFAULT_COUNTRY_CODE=20
```

Setup and operation:

- `docker compose up -d evolution` starts Evolution API on `127.0.0.1:8085`
  (container port 8080) and keeps the paired session in the
  `ultrasound_clinic_evolution_instances` volume. Back that volume up whenever
  the database is backed up; without it the phone must be paired again.
- For local development the backend reads `backend/.env`, so set
  `EVOLUTION_API_URL=http://localhost:8085` there and use the same
  `EVOLUTION_API_KEY` as the root `.env`. Inside Docker the URL is
  `http://evolution:8080`.
- Pair the clinic phone from **Settings → WhatsApp delivery → Connect**, then
  scan the QR code with WhatsApp on that phone. The status shows
  `open` when the session is active. `Disconnect` logs the device out and
  requires a new scan.
- Keep `EVOLUTION_API_KEY` secret and rotate it if it is ever shared; never
  paste it into logs, screenshots or tickets. Audit events do not include keys,
  QR payloads or full phone numbers.
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

Run both database and uploads together:

```bash
./scripts/backup.sh
```

Backups are written to `backups/` with mode 0700 and SHA-256 checksums, but they
are **not encrypted by this script**. Encrypt them before copying off-host
(for example with `age` or `gpg`) and store them in an access-controlled
location. A backup that has never been restored is not a backup.

Suggested schedule: nightly at 02:00 clinic time, plus before upgrades and
before any migration. Keep at least 7 daily, 4 weekly, and 3 monthly copies,
subject to the clinic's retention policy.

### Restore drill (non-destructive)

```bash
./scripts/restore-drill.sh backups/db-<timestamp>.dump
```

This creates/restores only a database whose name ends in `_drill`, verifies
migration/user/patient/report counts, then drops it (set `KEEP_DRILL_DB=1` to
keep it for inspection). It never touches the clinic database. Record the date,
dump file, counts, and operator in the clinic's operations log.
Run a drill at least quarterly and after any change to the backup process.

### Full restore (requires explicit approval)

Follow `docs/backup-restore.md`. Stop writes first, take a fresh backup, restore
the database and storage from the same snapshot, then start the stack and verify
`/healthz`, a test login, and a known report. Do not delete Docker volumes
without the clinic owner's written approval; prefer restoring into the existing
database with `pg_restore --clean --if-exists`.

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
