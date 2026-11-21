#!/usr/bin/env bash
# Read-only clock / NTP sanity check. No network time requests are made.
# P7_EXPECTED_EPOCH may be supplied by a trusted external check if available.
# Exit: 0=ok 1=warn 2=high 3=critical 4=unknown.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=p7-common.sh
. "${SCRIPT_DIR}/p7-common.sh"

DRIFT_WARN="${P7_TIME_DRIFT_WARN_SECONDS:-60}"
DRIFT_HIGH="${P7_TIME_DRIFT_HIGH_SECONDS:-300}"
DRIFT_CRIT="${P7_TIME_DRIFT_CRITICAL_SECONDS:-900}"
now="$(p7_now)"

ntp="unknown"
ntp_available=0
if command -v timedatectl >/dev/null 2>&1; then
  value="$(timedatectl show -p NTPSynchronized --value 2>/dev/null || true)"
  case "$value" in
    yes) ntp="yes"; ntp_available=1 ;;
    no) ntp="no"; ntp_available=1 ;;
  esac
fi

drift="null"
abs_drift=0
if [ -n "${P7_EXPECTED_EPOCH:-}" ]; then
  drift=$((now - P7_EXPECTED_EPOCH))
  case "$drift" in
    -*) abs_drift="${drift#-}" ;;
    *) abs_drift="$drift" ;;
  esac
fi

status="ok"; severity="info"; message="local clock sanity check passed"
if [ "$drift" != "null" ] && [ "$abs_drift" -ge "$DRIFT_CRIT" ]; then
  status="critical"; severity="page"; message="system clock drift exceeds critical threshold"
elif [ "$drift" != "null" ] && [ "$abs_drift" -ge "$DRIFT_HIGH" ]; then
  status="high"; severity="warn"; message="system clock drift exceeds high threshold"
elif [ "$drift" != "null" ] && [ "$abs_drift" -ge "$DRIFT_WARN" ]; then
  status="warn"; severity="info"; message="system clock drift exceeds warning threshold"
elif [ "$ntp" = "no" ]; then
  status="warn"; severity="info"; message="NTP reports unsynchronised; certificate checks may be unreliable"
elif [ "$ntp_available" -eq 0 ] && [ -z "${P7_EXPECTED_EPOCH:-}" ]; then
  # Fail closed: without an authoritative NTP signal or a trusted external
  # epoch there is no evidence that the clock is correct.
  status="unknown"; severity="unknown"; message="clock synchronisation is unverifiable (no timedatectl signal and no P7_EXPECTED_EPOCH)"
fi

extra="\"utc\":\"$(p7_iso "$now")\",\"timezone\":\"$(p7_json_escape "$(date +%Z 2>/dev/null || printf 'unknown')")\",\"driftSeconds\":${drift},\"ntpSynchronized\":\"$(p7_json_escape "$ntp")\",\"runbook\":\"docs/monitoring-runbook.md#clock\""
p7_emit system.time "$status" "$severity" "$message" "$extra"
p7_exit_for "$status"
