#!/usr/bin/env bash
# Read-only disk and inode capacity check for root, Docker root and backup mount.
# One JSON line per path; exit code is the worst status across all paths.
# 0=ok 1=warn 2=high 3=critical 4=unknown.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=p7-common.sh
. "${SCRIPT_DIR}/p7-common.sh"

PATHS="${P7_PATHS:-/ /var/lib/docker /mnt/clinic-backups}"
WARN="${P7_CAP_WARN:-70}"
HIGH="${P7_CAP_HIGH:-85}"
CRIT="${P7_CAP_CRIT:-95}"

worst=0
for path in $PATHS; do
  status="ok"; severity="info"; message="capacity within limits"
  used="null"; inodes="null"; exists=1
  if [ ! -d "$path" ]; then
    exists=0
  else
    used="$(df -P "$path" 2>/dev/null | awk 'NR==2 {gsub(/%/,"",$5); print $5}' || true)"
    inodes="$(df -iP "$path" 2>/dev/null | awk 'NR==2 {gsub(/%/,"",$5); print $5}' || true)"
    [ -n "$used" ] || used="null"
    [ -n "$inodes" ] || inodes="null"
    for value in "$used" "$inodes"; do
      if [ "$value" != "null" ]; then
        if awk -v v="$value" -v c="$CRIT" 'BEGIN { exit !(v>=c) }'; then
          status="critical"; severity="page"; message="capacity >= ${CRIT}% on ${path}"
        elif awk -v v="$value" -v h="$HIGH" 'BEGIN { exit !(v>=h) }'; then
          if [ "$status" != "critical" ]; then
            status="high"; severity="warn"; message="capacity >= ${HIGH}% on ${path}"
          fi
        elif awk -v v="$value" -v w="$WARN" 'BEGIN { exit !(v>=w) }'; then
          if [ "$status" = "ok" ]; then
            status="warn"; severity="info"; message="capacity >= ${WARN}% on ${path}"
          fi
        fi
      fi
    done
  fi

  if [ "$exists" = "0" ]; then
    status="high"; severity="warn"; message="path ${path} is absent (mount missing?)"
  fi

  extra="\"path\":\"$(p7_json_escape "$path")\",\"exists\":${exists},\"usedPercent\":${used},\"inodePercent\":${inodes},\"thresholds\":{\"warn\":${WARN},\"high\":${HIGH},\"critical\":${CRIT}},\"runbook\":\"docs/monitoring-runbook.md#capacity\""
  line="$(p7_emit "capacity:${path}" "$status" "$severity" "$message" "$extra")"
  printf '%s\n' "$line"
  p7_alert "$line"
  case "$status" in
    critical) worst=3 ;;
    high) if [ "$worst" -lt 2 ]; then worst=2; fi ;;
    warn) if [ "$worst" -lt 1 ]; then worst=1; fi ;;
  esac
done
exit "$worst"
