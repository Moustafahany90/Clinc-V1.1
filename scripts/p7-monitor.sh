#!/usr/bin/env bash
# Phase 7 local monitor orchestrator. Runs read-only checks, writes a
# heartbeat, deduplicates/rate-limits alerts, and appends to a local JSONL
# sink. No external channel is contacted. No timer or service is installed.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=p7-common.sh
. "${SCRIPT_DIR}/p7-common.sh"

STATE_DIR="$(p7_state_dir)"
CHECKS="${P7_MONITOR_CHECKS:-backup capacity containers cert wal time heartbeat}"
WINDOW="${P7_DEDUP_WINDOW_SECONDS:-${P7_ALERT_REPEAT_SEC:-300}}"
MAX_PER_WINDOW="${P7_MAX_ALERTS_PER_WINDOW:-10}"
INTERVAL="${P7_INTERVAL_SEC:-300}"
mkdir -p "$(dirname "$P7_HEARTBEAT_FILE")"

alerts=0
suppressed=0
recoveries=0

json_field() {
  printf '%s' "$1" | sed -n "s/.*\"$2\":\"\([^\"]*\)\".*/\1/p"
}

key_for() {
  printf '%s' "$1" | cksum | awk '{print $1}'
}

rank_for() {
  case "$1" in
    critical|unknown) printf '4' ;;
    high) printf '3' ;;
    warn) printf '2' ;;
    ok) printf '0' ;;
    *) printf '1' ;;
  esac
}

forward() {
  printf '%s\n' "$1"
  p7_alert "$1"
  alerts=$((alerts + 1))
}

process_line() {
  line="$1"
  case "$line" in
    \{*) ;;
    *) printf '%s\n' "$line"; return 0 ;;
  esac

  check="$(json_field "$line" check)"
  status="$(json_field "$line" status)"
  [ -n "$check" ] || return 0

  key="$(key_for "$check")"
  status_file="${STATE_DIR}/p7-status-${key}"
  last_file="${STATE_DIR}/p7-last-${key}"
  count_file="${STATE_DIR}/p7-count-${key}"

  if [ "$status" = "ok" ]; then
    previous="$(cat "$status_file" 2>/dev/null || true)"
    if [ -n "$previous" ] && [ "$previous" != "ok" ]; then
      recovery="$(p7_emit monitor.recovery ok info "alert cleared" "\"check\":\"$(p7_json_escape "$check")\",\"previousStatus\":\"$(p7_json_escape "$previous")\",\"runbook\":\"docs/monitoring-runbook.md#recovery\"")"
      forward "$recovery"
      recoveries=$((recoveries + 1))
    fi
    printf 'ok' >"$status_file"
    rm -f "$last_file" "$count_file"
    return 0
  fi

  previous="$(cat "$status_file" 2>/dev/null || true)"
  previous_rank="$(rank_for "$previous")"
  current_rank="$(rank_for "$status")"
  if [ "$previous" != "$status" ]; then printf '%s' "$status" >"$status_file"; fi

  last=0
  if [ -f "$last_file" ]; then last="$(cat "$last_file" 2>/dev/null || printf '0')"; fi
  count=0
  if [ -f "$count_file" ]; then count="$(cat "$count_file" 2>/dev/null || printf '0')"; fi

  escalated=0
  if [ -n "$previous" ] && [ "$current_rank" -gt "$previous_rank" ]; then escalated=1; fi

  if [ "$escalated" -eq 1 ] || [ "$last" -eq 0 ] || [ $((now - last)) -ge "$WINDOW" ]; then
    count=0
    if [ "$count" -lt "$MAX_PER_WINDOW" ]; then
      forward "$line"
      count=$((count + 1))
    else
      suppressed=$((suppressed + 1))
    fi
    printf '%s' "$now" >"$last_file"
    printf '%s' "$count" >"$count_file"
  else
    suppressed=$((suppressed + 1))
  fi
}

run_once() {
  alerts=0
  suppressed=0
  recoveries=0

  # Write the heartbeat before checks so the dead-man's switch sees a fresh run.
  now="$(p7_now)"
  printf '%s' "$now" >"$P7_HEARTBEAT_FILE"

  for check_name in $CHECKS; do
    script="${SCRIPT_DIR}/p7-check-${check_name}.sh"
    if [ -f "$script" ]; then
      # Checks normally append to the sink; disable that here so this monitor
      # can apply deduplication and rate limiting to every emitted line.
      output="$(P7_ALERT_SINK="" bash "$script" 2>&1 || true)"
    else
      output="$(p7_emit "check:${check_name}" unknown unknown "check script is missing" "\"runbook\":\"docs/monitoring-runbook.md\"")"
    fi
    while IFS= read -r line; do
      process_line "$line"
    done <<<"$output"
  done

  p7_emit monitor.complete ok info "monitor pass complete" "\"checks\":\"$(p7_json_escape "$CHECKS")\",\"alerts\":${alerts},\"suppressed\":${suppressed},\"recoveries\":${recoveries},\"heartbeat\":\"$(p7_json_escape "$(basename "$P7_HEARTBEAT_FILE")")\",\"runbook\":\"docs/monitoring-runbook.md\""
}

if [ "${1:-}" = "--loop" ]; then
  trap 'exit 0' TERM INT
  while :; do
    run_once
    sleep "$INTERVAL"
  done
else
  run_once
fi
