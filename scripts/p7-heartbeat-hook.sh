#!/usr/bin/env bash
# Phase 7.1 external dead-man's-switch hook (optional).
#
# Sends one lightweight HTTPS GET after a COMPLETED monitor cycle. The URL is
# treated as a secret: it is written only into a 0600 curl config file and is
# never placed in argv, stdout, stderr or the JSONL sink. Failure never blocks
# the cycle and the script always exits 0.
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=p7-common.sh
. "${SCRIPT_DIR}/p7-common.sh"

URL="${P7_HEARTBEAT_URL:-}"
ALLOW_INSECURE="${P7_ALLOW_INSECURE_TEST:-0}"
TIMEOUT="${P7_HEARTBEAT_TIMEOUT_SEC:-5}"
ESCALATE_AFTER="${P7_HEARTBEAT_FAIL_ESCALATE_AFTER:-3}"
STATE_DIR="$(p7_state_dir)"
FAIL_FILE="${STATE_DIR}/p7-heartbeat-consecutive-failures"
DEGRADED_FILE="${STATE_DIR}/p7-heartbeat-delivery-degraded"

case "$TIMEOUT" in ''|*[!0-9]*) TIMEOUT=5 ;; esac
case "$ESCALATE_AFTER" in ''|*[!0-9]*) ESCALATE_AFTER=3 ;; esac

local_log() {
  printf 'p7-heartbeat: %s\n' "$*" >&2
}

emit_local() {
  status="$1"; severity="$2"; reason="$3"; attempts="$4"
  if [ -n "$P7_ALERT_SINK" ]; then
    p7_alert "$(p7_emit "heartbeat.$reason" "$status" "$severity" "external heartbeat event" \
      "\"channel\":\"heartbeat\",\"reason\":\"$(p7_json_escape "$reason")\",\"attempts\":${attempts},\"runbook\":\"docs/monitoring-runbook.md#heartbeat\"")"
  fi
}

[ -n "$URL" ] || exit 0

case "$URL" in
  https://*) ;;
  http://*)
    if [ "$ALLOW_INSECURE" != "1" ]; then
      local_log "refusing non-HTTPS heartbeat URL; set P7_ALLOW_INSECURE_TEST=1 only for a local mock"
      exit 0
    fi
    ;;
  *)
    local_log "refusing invalid heartbeat URL; monitor cycle is unaffected"
    exit 0
    ;;
esac

work="$(mktemp -d "${TMPDIR:-/tmp}/p71-hb.XXXXXX" 2>/dev/null)" || {
  local_log "cannot create private temp directory; monitor cycle is unaffected"
  exit 0
}
chmod 700 "$work" 2>/dev/null || true
trap 'rm -rf "$work"' EXIT

cfg="${work}/curl.cfg"
url_escaped="$(printf '%s' "$URL" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')"
{
  printf 'url = "%s"\n' "$url_escaped"
  printf 'connect-timeout = "3"\n'
  printf 'max-time = "%s"\n' "$TIMEOUT"
  printf 'silent\n'
  printf 'output = "%s"\n' "${work}/response"
  printf 'write-out = "%%{http_code}"\n'
} >"$cfg"
chmod 600 "$cfg" 2>/dev/null || true

was_degraded=0
[ -f "$DEGRADED_FILE" ] && was_degraded=1
code="$(curl -K "$cfg" 2>/dev/null || printf '000')"
code="$(printf '%s' "$code" | cut -c1-3)"

case "$code" in
  2??)
    rm -f "$FAIL_FILE" "$DEGRADED_FILE"
    if [ "$was_degraded" -eq 1 ]; then
      emit_local ok info restored 1
    fi
    exit 0
    ;;
  *)
    fails=0
    if [ -f "$FAIL_FILE" ]; then
      fails="$(cat "$FAIL_FILE" 2>/dev/null || printf '0')"
    fi
    case "$fails" in ''|*[!0-9]*) fails=0 ;; esac
    fails=$((fails + 1))
    printf '%s' "$fails" >"$FAIL_FILE"
    emit_local warn warn "failed_http_${code}" 1
    local_log "ping failed (HTTP ${code}); monitor cycle is unaffected"
    if [ "$fails" -ge "$ESCALATE_AFTER" ] && [ "$was_degraded" -eq 0 ]; then
      printf '1' >"$DEGRADED_FILE"
      if [ -n "$P7_ALERT_SINK" ]; then
        p7_alert "$(p7_emit "heartbeat.delivery_degraded" high high "external heartbeat unreachable" \
          "\"channel\":\"heartbeat\",\"consecutive\":${fails},\"runbook\":\"docs/monitoring-runbook.md#heartbeat\"")"
      fi
      local_log "local escalation raised after ${fails} consecutive ping failures"
    fi
    exit 0
    ;;
esac
