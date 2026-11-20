#!/usr/bin/env bash
# Read-only dead-man's switch check. Reads the monitor heartbeat timestamp and
# reports how stale it is. Run this from an external scheduler if desired; no
# timer is installed by this Phase.
# Exit: 0=ok 1=warn 2=high 3=critical 4=unknown.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=p7-common.sh
. "${SCRIPT_DIR}/p7-common.sh"

WARN_SECONDS="${P7_HEARTBEAT_WARN_SECONDS:-600}"
HIGH_SECONDS="${P7_HEARTBEAT_HIGH_SECONDS:-1800}"
CRIT_SECONDS="${P7_HEARTBEAT_CRITICAL_SECONDS:-3600}"
heartbeat="${P7_HEARTBEAT_FILE}"
now="$(p7_now)"

if [ ! -f "$heartbeat" ]; then
  p7_emit monitor.heartbeat critical page "monitor heartbeat file is missing" "\"path\":\"$(p7_json_escape "$(basename "$heartbeat")")\",\"runbook\":\"docs/monitoring-runbook.md#dead-mans-switch\""
  exit 3
fi

mtime="$(stat -c %Y "$heartbeat" 2>/dev/null || stat -f %m "$heartbeat" 2>/dev/null || true)"
if [ -z "$mtime" ]; then
  p7_emit monitor.heartbeat unknown unknown "heartbeat timestamp could not be read" "\"path\":\"$(p7_json_escape "$(basename "$heartbeat")")\",\"runbook\":\"docs/monitoring-runbook.md#dead-mans-switch\""
  exit 4
fi

age=$((now - mtime))
if [ "$age" -lt 0 ]; then age=0; fi

status="ok"; severity="info"; message="monitor heartbeat is fresh"
if [ "$age" -ge "$CRIT_SECONDS" ]; then
  status="critical"; severity="page"; message="monitor heartbeat is critically stale"
elif [ "$age" -ge "$HIGH_SECONDS" ]; then
  status="high"; severity="warn"; message="monitor heartbeat is stale"
elif [ "$age" -ge "$WARN_SECONDS" ]; then
  status="warn"; severity="info"; message="monitor heartbeat is aging"
fi

extra="\"heartbeatAgeSeconds\":${age},\"path\":\"$(p7_json_escape "$(basename "$heartbeat")")\",\"thresholdsSeconds\":[${WARN_SECONDS},${HIGH_SECONDS},${CRIT_SECONDS}],\"runbook\":\"docs/monitoring-runbook.md#dead-mans-switch\""
p7_emit monitor.heartbeat "$status" "$severity" "$message" "$extra"
p7_exit_for "$status"
