#!/usr/bin/env bash
# Phase 7/7.1 local monitor orchestrator. Runs read-only checks, writes a
# heartbeat, deduplicates/rate-limits alerts, and appends to a local JSONL
# sink. Optional, opt-in Telegram delivery and external heartbeat hooks are
# called only from this script and can never block a check. No timer or service
# is installed.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=p7-common.sh
. "${SCRIPT_DIR}/p7-common.sh"

STATE_DIR="$(p7_state_dir)"
CHECKS="${P7_MONITOR_CHECKS:-backup pitr capacity containers cert wal time heartbeat}"
WINDOW="${P7_DEDUP_WINDOW_SECONDS:-${P7_ALERT_REPEAT_SEC:-300}}"
MAX_PER_WINDOW="${P7_MAX_ALERTS_PER_WINDOW:-10}"
INTERVAL="${P7_INTERVAL_SEC:-300}"
case "$WINDOW" in ''|*[!0-9]*|0) WINDOW=300 ;; esac
case "$MAX_PER_WINDOW" in ''|*[!0-9]*) MAX_PER_WINDOW=10 ;; esac
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
  # Delivery is best-effort and strictly after the local sink write. Any
  # failure is swallowed so the check pass itself is never affected.
  if [ -f "${SCRIPT_DIR}/p7-deliver-telegram.sh" ]; then
    printf '%s\n' "$1" | bash "${SCRIPT_DIR}/p7-deliver-telegram.sh" >/dev/null || true
  fi
}

# The rate limit is global per time window; deduplication remains per check.
# A per-check counter let N distinct checks emit N alerts under a cap of 2.
window_id=0
window_count=0
load_window_budget() {
  local stored_window stored_count
  window_id=$((now / WINDOW))
  stored_window="$(cat "${STATE_DIR}/p7-window-id" 2>/dev/null || true)"
  stored_count="$(cat "${STATE_DIR}/p7-window-count" 2>/dev/null || true)"
  case "$stored_count" in ''|*[!0-9]*) stored_count=0 ;; esac

  if [ "$stored_window" != "$window_id" ]; then
    window_count=0
    printf '%s' "$window_id" >"${STATE_DIR}/p7-window-id"
    printf '0' >"${STATE_DIR}/p7-window-count"
  else
    window_count="$stored_count"
  fi
}

forward_within_budget() {
  if [ "$window_count" -lt "$MAX_PER_WINDOW" ]; then
    forward "$1"
    window_count=$((window_count + 1))
    printf '%s' "$window_count" >"${STATE_DIR}/p7-window-count"
  else
    suppressed=$((suppressed + 1))
  fi
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

  load_window_budget

  if [ "$status" = "ok" ]; then
    previous="$(cat "$status_file" 2>/dev/null || true)"
    if [ -n "$previous" ] && [ "$previous" != "ok" ]; then
      recovery="$(p7_emit monitor.recovery ok info "alert cleared" "\"check\":\"$(p7_json_escape "$check")\",\"previousStatus\":\"$(p7_json_escape "$previous")\",\"runbook\":\"docs/monitoring-runbook.md#recovery\"")"
      forward_within_budget "$recovery"
      recoveries=$((recoveries + 1))
    fi
    printf 'ok' >"$status_file"
    rm -f "$last_file"
    return 0
  fi

  previous="$(cat "$status_file" 2>/dev/null || true)"
  previous_rank="$(rank_for "$previous")"
  current_rank="$(rank_for "$status")"
  if [ "$previous" != "$status" ]; then printf '%s' "$status" >"$status_file"; fi

  last=0
  if [ -f "$last_file" ]; then last="$(cat "$last_file" 2>/dev/null || printf '0')"; fi
  case "$last" in ''|*[!0-9]*) last=0 ;; esac

  escalated=0
  if [ -n "$previous" ] && [ "$current_rank" -gt "$previous_rank" ]; then escalated=1; fi

  due=0
  if [ "$last" -eq 0 ] || [ $((now - last)) -ge "$WINDOW" ]; then due=1; fi
  if [ "$escalated" -eq 1 ]; then due=1; fi

  if [ "$due" -eq 1 ]; then
    forward_within_budget "$line"
    printf '%s' "$now" >"$last_file"
  else
    suppressed=$((suppressed + 1))
  fi
}

run_once() {
  # Test-only skip path: no heartbeat file update and no external ping.
  if [ "${P7_SKIP_CYCLE:-0}" = "1" ]; then
    printf '%s\n' "p7-monitor: cycle skipped (P7_SKIP_CYCLE=1); no heartbeat ping"
    return 0
  fi

  alerts=0
  suppressed=0
  recoveries=0

  # Rotate before any write so a full sink cannot lose the newest alert.
  p7_sink_rotate

  # Write the heartbeat before checks so the dead-man's switch sees a fresh run.
  now="$(p7_now)"
  printf '%s' "$now" >"$P7_HEARTBEAT_FILE"

  for check_name in $CHECKS; do
    script="${SCRIPT_DIR}/p7-check-${check_name}.sh"
    if [ -f "$script" ]; then
      # Checks normally append to the sink; disable that here so this monitor
      # can apply deduplication and rate limiting to every emitted line.
      if output="$(P7_ALERT_SINK="" bash "$script" 2>&1)"; then rc=0; else rc=$?; fi
    else
      output="$(p7_emit "check:${check_name}" unknown unknown "check script is missing" "\"runbook\":\"docs/monitoring-runbook.md\"")"
      rc=4
    fi

    emitted=0
    while IFS= read -r line; do
      case "$line" in \{*) emitted=1 ;; esac
      process_line "$line"
    done <<<"$output"

    # A crashing check that emitted nothing must not disappear from monitoring.
    if [ "$emitted" -eq 0 ] && [ "$rc" -ne 0 ]; then
      crash="$(p7_emit "check:${check_name}" unknown unknown "check produced no result and exited ${rc}" "\"exitCode\":${rc},\"runbook\":\"docs/monitoring-runbook.md\"")"
      process_line "$crash"
    fi
  done

  p7_emit monitor.complete ok info "monitor pass complete" "\"checks\":\"$(p7_json_escape "$CHECKS")\",\"alerts\":${alerts},\"suppressed\":${suppressed},\"recoveries\":${recoveries},\"heartbeat\":\"$(p7_json_escape "$(basename "$P7_HEARTBEAT_FILE")")\",\"runbook\":\"docs/monitoring-runbook.md\""

  # Only a completed cycle pings the external dead-man's switch. If the monitor
  # aborts earlier, no ping is sent and the service detects the silence.
  if [ -f "${SCRIPT_DIR}/p7-heartbeat-hook.sh" ]; then
    bash "${SCRIPT_DIR}/p7-heartbeat-hook.sh" >/dev/null || true
  fi
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
