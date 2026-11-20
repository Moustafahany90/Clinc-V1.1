#!/usr/bin/env bash
# Phase 7.1 Telegram delivery adapter.
#
# Reads ONE Phase 7 JSONL alert on stdin and sends a strict allowlist message
# to Telegram's sendMessage endpoint. The bot token is written only into a
# 0600 curl config file and is never placed in argv, stdout, stderr or the sink.
# Every failure path exits 0: delivery can never block or fail a monitor check.
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=p7-common.sh
. "${SCRIPT_DIR}/p7-common.sh"

TOKEN="${P7_TELEGRAM_BOT_TOKEN:-}"
CHAT="${P7_TELEGRAM_CHAT_ID:-}"
BASE="${P7_TELEGRAM_API_BASE:-https://api.telegram.org}"
HOST_LABEL="${P7_HOST_LABEL:-clinic-host}"
ALLOW_INSECURE="${P7_ALLOW_INSECURE_TEST:-0}"
MAX_ATTEMPTS="${P7_TELEGRAM_MAX_ATTEMPTS:-3}"
TIMEOUT="${P7_TELEGRAM_TIMEOUT_SEC:-5}"
BACKOFF="${P7_TELEGRAM_BACKOFF_SEC:-1}"
ESCALATE_AFTER="${P7_TELEGRAM_FAIL_ESCALATE_AFTER:-3}"
STATE_DIR="$(p7_state_dir)"
FAIL_FILE="${STATE_DIR}/p7-telegram-consecutive-failures"
DEGRADED_FILE="${STATE_DIR}/p7-telegram-delivery-degraded"

case "$MAX_ATTEMPTS" in ''|*[!0-9]*) MAX_ATTEMPTS=3 ;; esac
case "$TIMEOUT" in ''|*[!0-9]*) TIMEOUT=5 ;; esac
case "$ESCALATE_AFTER" in ''|*[!0-9]*) ESCALATE_AFTER=3 ;; esac

local_log() {
  printf 'p7-telegram: %s\n' "$*" >&2
}

json_field() {
  printf '%s' "$1" | sed -n "s/.*\"$2\":\"\([^\"]*\)\".*/\1/p"
}

# Keep only characters that can appear in an allowlisted field. This alone
# removes paths, URLs, artifact names, emails, JWTs and phone numbers; the
# second stage below is belt-and-braces pattern scrubbing.
allowlist_chars() {
  printf '%s' "$1" | tr -cd '[:alnum:] ._-' | cut -c1-64
}

scrub_patterns() {
  printf '%s' "$1" | sed -E \
    -e 's/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/[REDACTED_JWT]/g' \
    -e 's/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/[REDACTED_EMAIL]/g' \
    -e 's/(sk_live|sk_test|api[_-]?key|token)[A-Za-z0-9_-]*/[REDACTED_SECRET]/Ig' \
    -e 's/\+?[0-9]{7,15}/[REDACTED_PHONE]/g'
}

emit_local() {
  check_name="$1"; status="$2"; severity="$3"; reason="$4"; attempts="$5"
  if [ -n "$P7_ALERT_SINK" ]; then
    p7_alert "$(p7_emit "$check_name" "$status" "$severity" "telegram delivery event" \
      "\"channel\":\"telegram\",\"reason\":\"$(p7_json_escape "$reason")\",\"attempts\":${attempts},\"runbook\":\"docs/monitoring-runbook.md#telegram\"")"
  fi
}

if [ -z "$TOKEN" ] || [ -z "$CHAT" ]; then
  local_log "delivery disabled (token or chat id not configured); local sink still records all alerts"
  exit 0
fi

case "$BASE" in
  https://*) ;;
  http://*)
    if [ "$ALLOW_INSECURE" != "1" ]; then
      local_log "refusing non-HTTPS API base; set P7_ALLOW_INSECURE_TEST=1 only for a local mock"
      exit 0
    fi
    ;;
  *)
    local_log "refusing invalid API base; local sink still records all alerts"
    exit 0
    ;;
esac

line="$(cat)"
check_name="$(allowlist_chars "$(json_field "$line" check)")"
status="$(allowlist_chars "$(json_field "$line" status)")"
severity="$(allowlist_chars "$(json_field "$line" severity)")"
at="$(json_field "$line" at)"
[ -n "$check_name" ] || check_name="monitor"
[ -n "$status" ] || status="unknown"
[ -n "$severity" ] || severity="info"

case "$at" in
  [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z) ;;
  *) at="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || printf '1970-01-01T00:00:00Z')" ;;
esac

status_code="$(printf '%s' "$status" | tr '[:lower:]' '[:upper:]' | cut -c1-16)"
sev_code="$(printf '%s' "$severity" | tr '[:lower:]' '[:upper:]' | cut -c1-16)"
host="$(allowlist_chars "$HOST_LABEL" | cut -c1-32)"
[ -n "$host" ] || host="clinic-host"

# Fixed allowlist: severity, check name, short status code, host label, UTC
# timestamp and a runbook anchor. The raw check message is never forwarded.
text="[${sev_code}] ${check_name} status=${status_code} host=${host} at=${at} runbook=docs/monitoring-runbook.md"
text="$(scrub_patterns "$text")"
text="$(printf '%s' "$text" | cut -c1-300)"

# Loud for actionable pages (critical/high/page/unknown severity, or a
# critical/high status). warn/info and recoveries stay silent. Phase 7's
# dead-man's-switch check reports severity=page with status=critical, so both
# fields are considered; a page must never be muted.
lseverity="$(printf '%s' "$severity" | tr '[:upper:]' '[:lower:]')"
lstatus="$(printf '%s' "$status" | tr '[:upper:]' '[:lower:]')"
case "$lseverity:$lstatus" in
  critical:*|high:*|page:*|unknown:*|*:critical|*:high) silent="false" ;;
  *) silent="true" ;;
esac

work="$(mktemp -d "${TMPDIR:-/tmp}/p71-tg.XXXXXX" 2>/dev/null)" || {
  local_log "cannot create private temp directory; local sink still records all alerts"
  exit 0
}
chmod 700 "$work" 2>/dev/null || true
trap 'rm -rf "$work"' EXIT

body="${work}/body.json"
cfg="${work}/curl.cfg"
response="${work}/response"
printf '%s' "{\"chat_id\":\"$(p7_json_escape "$CHAT")\",\"text\":\"$(p7_json_escape "$text")\",\"disable_notification\":${silent}}" >"$body"

# The token exists only inside this 0600 config file, read by curl via -K.
# No URL or token is ever echoed, including on curl failure (stderr discarded).
url="${BASE%/}/bot${TOKEN}/sendMessage"
url_escaped="$(printf '%s' "$url" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')"
{
  printf 'url = "%s"\n' "$url_escaped"
  printf 'request = "POST"\n'
  printf 'header = "Content-Type: application/json"\n'
  printf 'data-binary = "@%s"\n' "$body"
  printf 'connect-timeout = "3"\n'
  printf 'max-time = "%s"\n' "$TIMEOUT"
  printf 'silent\n'
  printf 'output = "%s"\n' "$response"
  printf 'write-out = "%%{http_code}"\n'
} >"$cfg"
chmod 600 "$cfg" "$body" 2>/dev/null || true

was_degraded=0
[ -f "$DEGRADED_FILE" ] && was_degraded=1

attempt=1
reason="unknown"
while [ "$attempt" -le "$MAX_ATTEMPTS" ]; do
  : >"$response"
  code="$(curl -K "$cfg" 2>/dev/null || printf '000')"
  code="$(printf '%s' "$code" | cut -c1-3)"
  case "$code" in
    200)
      if grep -Eq '"ok"[[:space:]]*:[[:space:]]*true' "$response" 2>/dev/null; then
        rm -f "$FAIL_FILE" "$DEGRADED_FILE"
        if [ "$was_degraded" -eq 1 ]; then
          emit_local "telegram.delivery_restored" ok info "restored" 0
        fi
        exit 0
      fi
      reason="malformed_response"
      ;;
    429)
      reason="http_429"
      retry_after="$(sed -n 's/.*"retry_after"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$response" 2>/dev/null | head -n 1)"
      case "$retry_after" in ''|*[!0-9]*) retry_after="$BACKOFF" ;; esac
      if [ "$retry_after" -gt 10 ]; then retry_after=10; fi
      sleep "$retry_after" 2>/dev/null || true
      ;;
    5*)
      reason="http_5xx"
      if [ "$attempt" -lt "$MAX_ATTEMPTS" ]; then
        sleep "$BACKOFF" 2>/dev/null || true
      fi
      ;;
    *)
      reason="http_${code}"
      if [ "$attempt" -lt "$MAX_ATTEMPTS" ]; then
        sleep "$BACKOFF" 2>/dev/null || true
      fi
      ;;
  esac
  attempt=$((attempt + 1))
done

fails=0
if [ -f "$FAIL_FILE" ]; then
  fails="$(cat "$FAIL_FILE" 2>/dev/null || printf '0')"
fi
case "$fails" in ''|*[!0-9]*) fails=0 ;; esac
fails=$((fails + 1))
printf '%s' "$fails" >"$FAIL_FILE"

emit_local "telegram.delivery_failed" warn warn "$reason" "$MAX_ATTEMPTS"
local_log "delivery failed (${reason}) after ${MAX_ATTEMPTS} attempt(s); local sink retains the alert"
if [ "$fails" -ge "$ESCALATE_AFTER" ] && [ "$was_degraded" -eq 0 ]; then
  printf '1' >"$DEGRADED_FILE"
  if [ -n "$P7_ALERT_SINK" ]; then
    p7_alert "$(p7_emit "telegram.delivery_degraded" high high "telegram delivery degraded" \
      "\"channel\":\"telegram\",\"consecutive\":${fails},\"runbook\":\"docs/monitoring-runbook.md#telegram\"")"
  fi
  local_log "local escalation raised after ${fails} consecutive failures"
fi
exit 0
