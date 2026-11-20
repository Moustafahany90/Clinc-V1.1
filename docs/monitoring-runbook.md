# Monitoring Runbook — Phase 7 / 7.1 / 7.2

**Status:** local/opt-in only. No scheduler, service, external account or
production alert destination is installed by the audit. Phase 7.1 adds an
**opt-in** Telegram adapter and external dead-man's-switch hook; both are inert
unless their environment variables are supplied from a protected env file, and
both were validated only against a local mock. Phase 7.2 revalidated them with
local Python HTTP mocks and added repeatable regression scripts. Uninstalled
systemd templates are provided in `deploy/` for after approval. See
`docs/PRODUCTION_READINESS_PHASE7.md` §8,
`docs/PRODUCTION_READINESS_PHASE7_1.md` §9 and
`docs/PRODUCTION_READINESS_PHASE7_2.md` for the manual Ubuntu actions and current
status. **No Ubuntu deployment or production rollout has been performed or
verified.**

## Common conventions

All checks are read-only with respect to application data. They write state only
under `P7_STATE_DIR` (default `/var/lib/clinic-monitor`) and append alerts to
`P7_ALERT_SINK` (default `<state>/alerts.jsonl`).

```bash
export P7_STATE_DIR=/var/lib/clinic-monitor
export P7_ALERT_SINK="${P7_STATE_DIR}/alerts.jsonl"
export P7_HEARTBEAT_FILE="${P7_STATE_DIR}/heartbeat"

# Read-only check, one JSON line per finding:
bash scripts/p7-check-<name>.sh

# Full local pass (writes heartbeat, dedups alerts, appends to sink):
bash scripts/p7-monitor.sh

# Run a subset while commissioning:
P7_MONITOR_CHECKS='backup capacity containers' bash scripts/p7-monitor.sh

# Opt-in overlay mode (only when a scheduler/container is explicitly enabled):
P7_INTERVAL_SEC=300 bash scripts/p7-monitor.sh --loop
```

Exit codes:

| Code | Meaning | Action |
|---:|---|---|
| 0 | ok | No action |
| 1 | warn | Review in business hours |
| 2 | high | Action required soon |
| 3 | critical | Page/act immediately |
| 4 | unknown | Check configuration or tooling; do not assume healthy |

JSON lines contain `at`, `check`, `status`, `severity`, `message` and
check-specific fields. They never contain PHI, full paths to patient data, query
strings, tokens or private keys.

The local JSONL sink rotates itself (Phase 7.1): `P7_SINK_MAX_BYTES` (default
1 MiB, `0` disables) and `P7_SINK_KEEP` (default 5) are set in the same env file.
Only files named exactly `<sink>.<number>` are renamed/removed; no other file is
ever touched. Alternatively set `P7_SINK_MAX_BYTES=0` and use the optional
`deploy/clinic-monitor.logrotate` template on the host.

Phase 7.2 added repeatable isolated regressions (no real provider, no active
scheduler, no production resource):

```bash
bash scripts/p72-phase7-regression.sh          # local-mock delivery/heartbeat/rotation/redaction
bash scripts/p72-nginx-privacy-test.sh         # nginx failure-log privacy, local images only
```

On Windows/WSL hosts where `docker` is only available as `docker.exe`, pass
`P72_DOCKER='/mnt/c/Program Files/Docker/Docker/resources/bin/docker.exe'` and a
Windows-visible `P72_TMP_ROOT` to the nginx script.

---

## <a id="backup"></a>Backup age, mount and verification

**Current storage architecture (Phase 7.2 correction):** the approved backup
destination is a dedicated **500 GB internal SATA HDD** mounted by UUID at
`/mnt/clinic-backups`. It is **local backup storage only**; no off-site provider
or rclone remote is configured. A separate **USB flash drive is reserved solely
for age private-key escrow**, not for backup or WAL data. No Ubuntu deployment or
production rollout has been performed or verified.

Phase 8.3.1 revalidated the disk on the host and aligned the check to the real
layout. The check validates the **real mount** (mountpoint, UUID
`0f21089c-c507-4903-96e5-daf637100d53`, `ext4`, required directory structure,
containment and writability) before looking for backups. An existing mount-point
directory alone is never treated as a mounted disk.

```bash
export P7_BACKUP_ROOT=/mnt/clinic-backups
export P7_BACKUP_UUID=0f21089c-c507-4903-96e5-daf637100d53
export P7_BACKUP_FSTYPE=ext4
export P7_MAX_AGE_HOURS=26
bash scripts/p7-check-backup.sh
```

- Manifests are discovered as `MANIFEST.txt` inside
  `clinic-<tier>-<STAMP>` directories under `daily/`, `weekly/` and `monthly/`.
  The newest set is chosen by its declared `created_utc`.
- The read-only `scripts/backup-verify.sh` is invoked with the same root.
- It never writes into the backup directory. On a missing/invalid mount it
  returns `critical` without running the verifier.
- `P7_SKIP_VERIFY=1` is test-only and yields `warn`. The former
  `P7_MOUNT_PRESENT` override was removed: use stubbed `mountpoint`/`findmnt`
  in `P7_BIN_DIR` for isolated tests instead.
- A containerised monitor needs a read-only bind mount of `/mnt/clinic-backups`
  (added to `docker-compose.monitoring.yml`); the host-systemd path is still
  the workable design because the disk is `root:root 0700`.

**Triage**

| Status | Meaning | Response |
|---|---|---|
| critical | Mount missing or invalid (wrong UUID/filesystem), no complete manifest, or newest backup > 26 h | Treat as a backup outage. Verify the internal backup HDD mount/UUID, disk health and scheduler. Do not delete old sets. Run `scripts/backup-verify.sh` and a restore drill when available. `actualUuid`/`actualFstype` in the JSON line show what the monitor saw. |
| high | Verification non-zero | Inspect `<state>/backup-verify-last.log`; stop relying on that set; investigate checksums/artifacts. |
| warn | Verification skipped | Commissioning/test only; not acceptable as a steady state. |

---

## <a id="capacity"></a>Disk and inode capacity

```bash
export P7_PATHS='/ /var/lib/docker /mnt/clinic-backups'
export P7_CAP_WARN=70 P7_CAP_HIGH=85 P7_CAP_CRIT=95
bash scripts/p7-check-capacity.sh
```

Uses `df -P` and `df -iP`. One JSON line per path. An absent path is `high`
because it usually means the internal backup HDD mount disappeared.

**Triage**

- 70%: plan cleanup/capacity review.
- 85%: act during the current shift; identify large Docker logs/images and
  backup growth. Do not remove backup artifacts without approval.
- 95%: backup creation aborts by design (`scripts/backup.sh`); act immediately.
- Inode exhaustion follows the same thresholds even when byte usage is low.

---

## <a id="containers"></a>Container health, restarts and OOM

```bash
export P7_COMPOSE_PROJECT=ultrasound-clinic
bash scripts/p7-check-containers.sh
```

Uses only `docker ps -a` and `docker inspect`. It never stops, starts or removes
containers. Restart counts are compared with small state files under
`P7_STATE_DIR`.

**Triage**

| Finding | Status | Response |
|---|---|---|
| OOM-killed container | critical | Check memory limits/host RAM. Review recent `docker compose logs --since 30m <service>`. Do not blindly restart loops. |
| Core `db`/`backend` not running or unhealthy | critical | Check `/healthz`, database connectivity, recent deployments and config. Restore service before clinical use. |
| Other service unhealthy | high | Inspect that service only; avoid touching volumes. |
| Restart delta >= 1 | high | Investigate crash loop; inspect exit codes/logs. |
| Evolution unhealthy | warn | WhatsApp delivery only. Core clinic workflows continue. Check session volume and API key; never delete/recreate the session volume. |

---

## <a id="certificates"></a>TLS certificate expiry

```bash
export P7_CERT_FILES=$'/etc/ssl/clinic/fullchain.pem\n/path/to/other.pem'
bash scripts/p7-check-cert.sh
```

Paths are newline-separated public certificate files only. The check uses local
`openssl x509` and makes no network connection.

Thresholds: 30 days `warn`, 14 days `high`, 7 days `critical`.

**Triage:** renew/reissue before the high threshold. Confirm the host clock is
correct (see `#clock`) before trusting expiry output. Do not point this check at
private keys.

---

## <a id="wal"></a>WAL backlog

```bash
export P7_WAL_DIRS=$'/var/lib/postgresql/16/main/pg_wal\n/mnt/clinic-backups/wal-archive'
bash scripts/p7-check-wal.sh
```

Filesystem-only check: WAL file count and oldest-file age. No database
connection, archiving or deletion is performed.

Thresholds:

| Signal | warn | high | critical |
|---|---:|---:|---:|
| File count | 50 | 200 | 500 |
| Oldest age | 900 s | 3600 s | 7200 s |

**Triage:** a growing backlog means archiving is stalled or the internal backup
HDD is missing/full. Check mount, `archive_command`, disk capacity and Postgres
logs. Do not delete WAL files manually.

---

## <a id="clock"></a>Clock and NTP sanity

```bash
# Optional trusted reference supplied by another approved check:
export P7_EXPECTED_EPOCH=<unix-seconds>
bash scripts/p7-check-time.sh
```

The check never queries a network time server. It reports UTC, timezone, drift
(if a reference is supplied) and `timedatectl` NTP state where available.

Thresholds: 60 s `warn`, 300 s `high`, 900 s `critical`. NTP unsynchronised is
`warn` even without a reference.

**Triage:** correct time is required for certificate validation, backup age and
JWT/audit timestamps. Fix NTP before trusting other time-based alerts.

---

## <a id="dead-mans-switch"></a>Dead-man's switch (heartbeat)

```bash
bash scripts/p7-check-heartbeat.sh
```

`scripts/p7-monitor.sh` writes the heartbeat at the start of every pass. This
check should be run by a **separate** scheduler so a stopped monitor is visible.

Thresholds: 600 s `warn`, 1800 s `high`, 3600 s `critical`; missing file is
`critical`.

**Triage:** a stale heartbeat means the monitor itself stopped. Check the host,
the scheduler account and the state directory permissions. Do not assume that
"no alerts" means healthy.

---

## <a id="recovery"></a>Deduplication, rate limiting and recovery

The monitor suppresses repeated identical non-ok lines for
`P7_DEDUP_WINDOW_SECONDS` (default 300) and caps forwarded alerts per check at
`P7_MAX_ALERTS_PER_WINDOW` (default 10). Escalations bypass dedup.

When a check returns to `ok`, the monitor emits one `monitor.recovery` line
containing the original check name and previous status. Recovery lines go to
the same local sink. A recovery notice is not proof that the underlying cause
was fixed; confirm with the relevant check and, for backups, a verification run.

To inspect the local sink without modifying it:

```bash
tail -n 50 "$P7_ALERT_SINK"
```

---

## <a id="telegram"></a>Telegram alert delivery (opt-in, approved channel)

Telegram is the clinic-approved channel. It is delivered by
`scripts/p7-deliver-telegram.sh`, called by `p7-monitor.sh` **after** the local
sink write. Configure it in the protected env file (see
`deploy/monitor.env.example`):

```dotenv
P7_TELEGRAM_BOT_TOKEN=<bot token>          # secret; 0600 env file only
P7_TELEGRAM_CHAT_ID=<private chat id>
P7_HOST_LABEL=clinic-ubuntu-01             # short, non-sensitive label
# P7_TELEGRAM_API_BASE=https://api.telegram.org   # default; never change in production
```

- Missing token/chat disables delivery cleanly; the local sink still records every alert.
- **HTTPS is required.** `P7_ALLOW_INSECURE_TEST=1` exists only for a local mock and must be `0` in production.
- The bot token is written only into a `0600` curl config file, never into argv, stdout, stderr, the sink or tickets.
- Messages are a strict allowlist: `[SEVERITY] check status=CODE host=LABEL at=UTC runbook=...`, plain text, ≤300 chars. Raw check output, PHI, paths, artifact names, tokens, JWTs, emails and phone numbers are never forwarded.
- `critical`/`high`/`page`/`unknown` severities and `critical`/`high` statuses notify loudly; `warn`/`info`/recoveries are silent (`disable_notification=true`).
- Failures (429 with `retry_after`, 5xx, timeout, malformed response) are bounded and retried, then recorded as `telegram.delivery_failed` in the sink; they never fail a check. After 3 consecutive failures a local `telegram.delivery_degraded` high event is raised; a later success records `telegram.delivery_restored`.

**Triage:** a `telegram.delivery_*` event means delivery is degraded but the local sink is authoritative. Check the bot token/chat id, outbound HTTPS and the mock/test flag. Do not paste the token into tickets.

---

## <a id="heartbeat"></a>External dead-man's switch (opt-in)

`scripts/p7-heartbeat-hook.sh` sends one HTTPS GET to `P7_HEARTBEAT_URL` **only
after a completed monitor cycle**. A skipped cycle or a crashed monitor sends
nothing, so the provider sees silence and can alert. The URL is a secret: it is
written only into a `0600` curl config file and is never logged. HTTPS is
required (the same `P7_ALLOW_INSECURE_TEST=1` mock-only escape hatch applies).
Failures are non-blocking and recorded locally as `heartbeat.failed_http_<code>`
and, after repeated failures, `heartbeat.delivery_degraded`.

Provider options are documented in `docs/PRODUCTION_READINESS_PHASE7_1.md` §5
(hosted Healthchecks.io, hosted Cronitor, or a self-hosted endpoint). **No
provider was chosen or account created by the audit.** The hook only needs one
secret HTTPS URL.

---

## Alert-channel approval gate

The local JSONL sink is always authoritative. Telegram delivery and the external
heartbeat hook are implemented but were validated only against a local mock (most
recently by `scripts/p72-phase7-regression.sh`); they remain disabled until the
env file is populated on the Ubuntu host. Do not add SMTP, WhatsApp/Evolution or
any other external destination without explicit clinic approval and credentials
stored outside the repository. See `docs/PRODUCTION_READINESS_PHASE7_2.md` for
current evidence and `docs/PRODUCTION_READINESS_PHASE7_1.md` §9 for the remaining
manual Ubuntu actions.
