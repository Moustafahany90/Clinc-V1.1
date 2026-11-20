#!/usr/bin/env bash
# Read-only WAL backlog check. Inspects local WAL directory file counts and
# oldest-file age only. No database connection, no deletion, no archiving.
# Exit: 0=ok 1=warn 2=high 3=critical 4=unknown.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=p7-common.sh
. "${SCRIPT_DIR}/p7-common.sh"

WAL_DIRS="${P7_WAL_DIRS:-}"
COUNT_WARN="${P7_WAL_COUNT_WARN:-50}"
COUNT_HIGH="${P7_WAL_COUNT_HIGH:-200}"
COUNT_CRIT="${P7_WAL_COUNT_CRITICAL:-500}"
AGE_WARN="${P7_WAL_AGE_WARN_SECONDS:-900}"
AGE_HIGH="${P7_WAL_AGE_HIGH_SECONDS:-3600}"
AGE_CRIT="${P7_WAL_AGE_CRITICAL_SECONDS:-7200}"
STATE_DIR="$(p7_state_dir)"
WORST_FILE="${STATE_DIR}/wal-worst"
printf '0' >"$WORST_FILE"

if [ -z "$WAL_DIRS" ]; then
  p7_emit db.wal unknown unknown "no local WAL directories configured (set P7_WAL_DIRS)" "\"runbook\":\"docs/monitoring-runbook.md#wal\""
  exit 4
fi

now="$(p7_now)"

printf '%s\n' "$WAL_DIRS" | while IFS= read -r wal_dir; do
  [ -n "$wal_dir" ] || continue
  name="$(basename "$wal_dir")"

  if [ ! -d "$wal_dir" ]; then
    p7_emit "wal:${name}" unknown unknown "WAL directory is missing or unreadable" "\"directory\":\"$(p7_json_escape "$name")\",\"runbook\":\"docs/monitoring-runbook.md#wal\""
    printf '4' >"$WORST_FILE"
    continue
  fi

  count="$(find "$wal_dir" -maxdepth 1 -type f 2>/dev/null | wc -l | tr -d '[:space:]')"
  oldest_epoch="$(find "$wal_dir" -maxdepth 1 -type f -printf '%T@\n' 2>/dev/null | sort -n | head -1 | awk -F. '{print $1}')"
  if [ -z "$oldest_epoch" ]; then
    oldest_line="$(find "$wal_dir" -maxdepth 1 -type f -exec stat -c '%Y %n' {} + 2>/dev/null | sort -n | head -1 || true)"
    oldest_epoch="$(printf '%s' "$oldest_line" | awk '{print $1}')"
  fi

  if [ -z "$oldest_epoch" ]; then
    p7_emit "wal:${name}" unknown unknown "could not determine oldest WAL file age" "\"directory\":\"$(p7_json_escape "$name")\",\"fileCount\":${count},\"runbook\":\"docs/monitoring-runbook.md#wal\""
    printf '4' >"$WORST_FILE"
    continue
  fi

  age=$((now - oldest_epoch))
  if [ "$age" -lt 0 ]; then age=0; fi

  status="ok"; severity="info"; message="WAL backlog is healthy"; rank=0
  if [ "$count" -ge "$COUNT_CRIT" ] || [ "$age" -ge "$AGE_CRIT" ]; then
    status="critical"; severity="page"; message="WAL backlog is critically large or stale"; rank=3
  elif [ "$count" -ge "$COUNT_HIGH" ] || [ "$age" -ge "$AGE_HIGH" ]; then
    status="high"; severity="warn"; message="WAL backlog is large or stale"; rank=2
  elif [ "$count" -ge "$COUNT_WARN" ] || [ "$age" -ge "$AGE_WARN" ]; then
    status="warn"; severity="info"; message="WAL backlog is growing"; rank=1
  fi

  extra="\"directory\":\"$(p7_json_escape "$name")\",\"fileCount\":${count},\"oldestAgeSeconds\":${age},\"countThresholds\":[${COUNT_WARN},${COUNT_HIGH},${COUNT_CRIT}],\"ageThresholdsSeconds\":[${AGE_WARN},${AGE_HIGH},${AGE_CRIT}],\"runbook\":\"docs/monitoring-runbook.md#wal\""
  p7_emit "wal:${name}" "$status" "$severity" "$message" "$extra"

  current="$(cat "$WORST_FILE" 2>/dev/null || printf '0')"
  if [ "$rank" -gt "$current" ]; then printf '%s' "$rank" >"$WORST_FILE"; fi
done

worst_rank="$(cat "$WORST_FILE" 2>/dev/null || printf '0')"
case "$worst_rank" in
  4) worst="unknown" ;;
  3) worst="critical" ;;
  2) worst="high" ;;
  1) worst="warn" ;;
  *) worst="ok" ;;
esac
p7_emit db.wal "$worst" "$worst" "WAL backlog summary" "\"worst\":\"$(p7_json_escape "$worst")\",\"runbook\":\"docs/monitoring-runbook.md#wal\""
p7_exit_for "$worst"
