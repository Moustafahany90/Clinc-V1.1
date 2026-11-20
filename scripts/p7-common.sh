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

# Phase 7.1 local sink rotation. 0 disables rotation; KEEP counts retained
# rotated files in addition to the live sink. Only files named exactly
# "<sink>.<number>" that this code created are ever renamed or removed.
P7_SINK_MAX_BYTES="${P7_SINK_MAX_BYTES:-1048576}"
P7_SINK_KEEP="${P7_SINK_KEEP:-5}"
case "$P7_SINK_MAX_BYTES" in ''|*[!0-9]*) P7_SINK_MAX_BYTES=1048576 ;; esac
case "$P7_SINK_KEEP" in ''|*[!0-9]*) P7_SINK_KEEP=5 ;; esac

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

# Rotate before writing so the newest line is never left in a full file.
p7_sink_rotate() {
  [ -n "$P7_ALERT_SINK" ] || return 0
  [ "$P7_SINK_MAX_BYTES" -gt 0 ] 2>/dev/null || return 0
  [ -f "$P7_ALERT_SINK" ] || return 0
  size="$(wc -c <"$P7_ALERT_SINK" 2>/dev/null || printf '0')"
  [ "${size:-0}" -ge "$P7_SINK_MAX_BYTES" ] || return 0
  if [ "$P7_SINK_KEEP" -le 1 ]; then
    # Keep exactly one rotated file; overwrite it rather than lose the lines
    # that are still within retention.
    mv -f "$P7_ALERT_SINK" "${P7_ALERT_SINK}.1"
    return 0
  fi
  rm -f "${P7_ALERT_SINK}.${P7_SINK_KEEP}"
  i=$((P7_SINK_KEEP - 1))
  while [ "$i" -ge 1 ]; do
    if [ -f "${P7_ALERT_SINK}.${i}" ]; then
      mv -f "${P7_ALERT_SINK}.${i}" "${P7_ALERT_SINK}.$((i + 1))"
    fi
    i=$((i - 1))
  done
  mv -f "$P7_ALERT_SINK" "${P7_ALERT_SINK}.1"
}

p7_alert() {
  [ -n "$P7_ALERT_SINK" ] || return 0
  p7_sink_rotate
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
