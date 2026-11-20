#!/usr/bin/env bash
# Read-only local TLS certificate expiry check. Accepts newline-separated
# certificate paths in P7_CERT_FILES. Never contacts a network endpoint and
# never reads private keys.
# Exit: 0=ok 1=warn 2=high 3=critical 4=unknown.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=p7-common.sh
. "${SCRIPT_DIR}/p7-common.sh"

CERT_FILES="${P7_CERT_FILES:-}"
WARN_DAYS="${P7_CERT_WARN_DAYS:-30}"
HIGH_DAYS="${P7_CERT_HIGH_DAYS:-14}"
CRIT_DAYS="${P7_CERT_CRITICAL_DAYS:-7}"
STATE_DIR="$(p7_state_dir)"
WORST_FILE="${STATE_DIR}/cert-worst"
printf '0' >"$WORST_FILE"

if [ -z "$CERT_FILES" ]; then
  p7_emit tls.cert unknown unknown "no local certificate paths configured (set P7_CERT_FILES)" "\"runbook\":\"docs/monitoring-runbook.md#certificates\""
  exit 4
fi

if ! command -v openssl >/dev/null 2>&1; then
  p7_emit tls.cert unknown unknown "openssl is unavailable; cannot inspect certificates" "\"runbook\":\"docs/monitoring-runbook.md#certificates\""
  exit 4
fi

printf '%s\n' "$CERT_FILES" | while IFS= read -r cert_file; do
  [ -n "$cert_file" ] || continue
  name="$(basename "$cert_file")"

  if [ ! -f "$cert_file" ]; then
    p7_emit "cert:${name}" unknown unknown "certificate file is missing" "\"file\":\"$(p7_json_escape "$name")\",\"runbook\":\"docs/monitoring-runbook.md#certificates\""
    printf '4' >"$WORST_FILE"
    continue
  fi

  not_after="$(openssl x509 -enddate -noout -in "$cert_file" 2>/dev/null | sed 's/^notAfter=//' || true)"
  if [ -z "$not_after" ]; then
    p7_emit "cert:${name}" unknown unknown "certificate could not be parsed" "\"file\":\"$(p7_json_escape "$name")\",\"runbook\":\"docs/monitoring-runbook.md#certificates\""
    printf '4' >"$WORST_FILE"
    continue
  fi

  days="null"
  now="$(p7_now)"
  if end_epoch="$(date -u -d "$not_after" +%s 2>/dev/null)"; then
    days=$(( (end_epoch - now) / 86400 ))
  fi

  status="ok"; severity="info"; message="certificate validity is healthy"; rank=0
  if ! openssl x509 -checkend "$((CRIT_DAYS * 86400))" -noout -in "$cert_file" >/dev/null 2>&1; then
    status="critical"; severity="page"; message="certificate expires within ${CRIT_DAYS} day(s)"; rank=3
  elif ! openssl x509 -checkend "$((HIGH_DAYS * 86400))" -noout -in "$cert_file" >/dev/null 2>&1; then
    status="high"; severity="warn"; message="certificate expires within ${HIGH_DAYS} day(s)"; rank=2
  elif ! openssl x509 -checkend "$((WARN_DAYS * 86400))" -noout -in "$cert_file" >/dev/null 2>&1; then
    status="warn"; severity="info"; message="certificate expires within ${WARN_DAYS} day(s)"; rank=1
  fi

  extra="\"file\":\"$(p7_json_escape "$name")\",\"daysRemaining\":${days},\"notAfter\":\"$(p7_json_escape "$not_after")\",\"runbook\":\"docs/monitoring-runbook.md#certificates\""
  p7_emit "cert:${name}" "$status" "$severity" "$message" "$extra"

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
p7_emit "tls.cert" "$worst" "$worst" "certificate expiry summary" "\"worst\":\"$(p7_json_escape "$worst")\",\"runbook\":\"docs/monitoring-runbook.md#certificates\""
p7_exit_for "$worst"
