# Monitoring Runbook — Phase 7

**Status:** local/opt-in only. No scheduler, service or external alert channel is
installed by Phase 7. Uninstalled systemd templates are provided in `deploy/`
for after approval. See `docs/PRODUCTION_READINESS_PHASE7.md` §8 for the manual
Ubuntu actions and §9 for the pending alert-channel decision.

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

---

## <a id="backup"></a>Backup age, mount and verification

```bash
export P7_BACKUP_DIR=/mnt/clinic-backups/backups
export P7_BACKUP_MOUNT=/mnt/clinic-backups
export P7_REQUIRE_MOUNT=1
export P7_MAX_AGE_HOURS=26
bash scripts/p7-check-backup.sh
```

- The check reads the newest `MANIFEST-*.txt`, its declared `created_utc`, and
  invokes the read-only `scripts/backup-verify.sh`.
- It never writes into the backup directory.
- `P7_MOUNT_PRESENT` can override the mount probe for isolated tests only.
- `P7_SKIP_VERIFY=1` is test-only and yields `warn`.

**Triage**

| Status | Meaning | Response |
|---|---|---|
| critical | Mount missing, no complete manifest, or newest backup > 26 h | Treat as a backup outage. Verify USB mount/UUID, disk health and scheduler. Do not delete old sets. Run `scripts/backup-verify.sh` and a restore drill when available. |
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
because it usually means the USB backup mount disappeared.

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

**Triage:** a growing backlog means archiving is stalled or the USB HDD is
missing/full. Check mount, `archive_command`, disk capacity and Postgres logs.
Do not delete WAL files manually.

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

## Alert-channel approval gate

Only the local JSONL sink is implemented. Do not add SMTP, webhook, Telegram,
WhatsApp/Evolution or any external destination without explicit clinic approval
and credentials stored outside the repository. See
`docs/PRODUCTION_READINESS_PHASE7.md` §9.
