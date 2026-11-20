#!/usr/bin/env bash
# Shared helpers for the Phase 7 read-only monitor checks.
# No check script ever writes into a backup directory, deletes files, or
# restarts a container/service. State is written only under P7_STATE_DIR.

P7_STATE_DIR="${P7_STATE_DIR:-/var/lib/clinic-monitor}"
# An explicitly empty P7_ALERT_SINK disables direct writes; the monitor uses
# this to own deduplication. An unset variable gets the default local sink.
if [ "${P7_ALERT_SINK+set}" = "set" ]; then
  :
else
  P7_ALERT_SINK="${P7_STATE_DIR}/alerts.jsonl"
fi
P7_HEARTBEAT_FILE="${P7_HEARTBEAT_FILE:-${P7_STATE_DIR}/heartbeat}"

# Test-only shim directory (for isolated failure injection). Never set in production.
if [ -n "${P7_BIN_DIR:-}" ]; then
  case ":${PATH}:" in
    *":${P7_BIN_DIR}:"*) ;;
    *) PATH="${P7_BIN_DIR}:${PATH}" ;;
  esac
fi
export PATH

p7_now() {
  if [ -n "${P7_NOW_EPOCH:-}" ]; then
    printf '%s' "$P7_NOW_EPOCH"
  else
    date -u +%s
  fi
}

p7_iso() {
  epoch="$1"
  if command -v date >/dev/null 2>&1 && date -u -d "@${epoch}" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null; then
    return 0
  fi
  printf '1970-01-01T00:00:00Z'
}

p7_json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\t/\\t/g' -e 's/\r//g'
}

# emit <check> <status> <severity> <message> [extra JSON fields without braces]
p7_emit() {
  check="$1"; status="$2"; severity="$3"; message="$4"; extra="${5:-}"
  at="$(p7_iso "$(p7_now)")"
  prefix="\"at\":\"${at}\",\"check\":\"$(p7_json_escape "$check")\",\"status\":\"$(p7_json_escape "$status")\",\"severity\":\"$(p7_json_escape "$severity")\",\"message\":\"$(p7_json_escape "$message")\""
  if [ -n "$extra" ]; then
    printf '{%s,%s}\n' "$prefix" "$extra"
  else
    printf '{%s}\n' "$prefix"
  fi
}

p7_alert() {
  [ -n "$P7_ALERT_SINK" ] || return 0
  mkdir -p "$(dirname "$P7_ALERT_SINK")"
  printf '%s\n' "$1" >>"$P7_ALERT_SINK"
}

p7_state_dir() {
  mkdir -p "$P7_STATE_DIR"
  printf '%s' "$P7_STATE_DIR"
}

p7_exit_for() {
  case "$1" in
    ok) exit 0 ;;
    warn) exit 1 ;;
    high) exit 2 ;;
    critical) exit 3 ;;
    *) exit 4 ;;
  esac
}
