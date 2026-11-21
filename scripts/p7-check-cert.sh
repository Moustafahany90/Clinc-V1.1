#!/usr/bin/env bash
# Read-only TLS certificate expiry check. Two additive, independent modes:
#
#   P7_CERT_FILES      newline-separated local public certificate paths
#   P7_CERT_ENDPOINTS  newline-separated host:port TLS endpoints
#
# Both modes are optional; when both are set, every configured target is
# checked. No private keys are read, no certificate is issued or renewed, and
# no DNS/ACME lookup is performed. Endpoint mode opens a TLS connection only to
# the addresses the operator explicitly configured.
# Exit: 0=ok 1=warn 2=high 3=critical 4=unknown.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=p7-common.sh
. "${SCRIPT_DIR}/p7-common.sh"

CERT_FILES="${P7_CERT_FILES:-}"
CERT_ENDPOINTS="${P7_CERT_ENDPOINTS:-}"
WARN_DAYS="${P7_CERT_WARN_DAYS:-30}"
HIGH_DAYS="${P7_CERT_HIGH_DAYS:-14}"
CRIT_DAYS="${P7_CERT_CRITICAL_DAYS:-7}"
ENDPOINT_TIMEOUT="${P7_CERT_ENDPOINT_TIMEOUT_SEC:-10}"
STATE_DIR="$(p7_state_dir)"
WORST_FILE="${STATE_DIR}/cert-worst"
printf '0' >"$WORST_FILE"

for v in WARN_DAYS HIGH_DAYS CRIT_DAYS; do
  val="${!v}"
  case "$val" in ''|*[!0-9]*) val=0 ;; esac
  printf -v "$v" '%s' "$val"
done
case "$ENDPOINT_TIMEOUT" in ''|*[!0-9]*) ENDPOINT_TIMEOUT=10 ;; esac

note_worst() {
  local rank=$1 current
  current="$(cat "$WORST_FILE" 2>/dev/null || printf '0')"
  [ "$rank" -le "$current" ] || printf '%s' "$rank" >"$WORST_FILE"
}

emit_target() {
  # emit_target <check-name> <label> <notAfter|empty> <extra-json>
  local check_name=$1 label=$2 not_after=$3 extra=$4
  local days="null" end_epoch status severity message rank

  if [ -n "$not_after" ] && end_epoch="$(date -u -d "$not_after" +%s 2>/dev/null)"; then
    days=$(( (end_epoch - $(p7_now)) / 86400 ))
    status="ok"; severity="info"; message="certificate validity is healthy"; rank=0
    if [ "$days" -lt 0 ]; then
      status="critical"; severity="page"; message="certificate has expired"; rank=3
    elif [ "$days" -lt "$CRIT_DAYS" ]; then
      status="critical"; severity="page"; message="certificate expires within ${CRIT_DAYS} day(s)"; rank=3
    elif [ "$days" -lt "$HIGH_DAYS" ]; then
      status="high"; severity="warn"; message="certificate expires within ${HIGH_DAYS} day(s)"; rank=2
    elif [ "$days" -lt "$WARN_DAYS" ]; then
      status="warn"; severity="info"; message="certificate expires within ${WARN_DAYS} day(s)"; rank=1
    fi
  else
    status="unknown"; severity="unknown"; message="certificate expiry could not be determined"; rank=4
  fi

  local line
  line="$(p7_emit "$check_name" "$status" "$severity" "$message" \
    "\"target\":\"$(p7_json_escape "$label")\",\"daysRemaining\":${days},\"notAfter\":\"$(p7_json_escape "$not_after")\",\"runbook\":\"docs/monitoring-runbook.md#certificates\",${extra:-}")"
  printf '%s\n' "$line"
  note_worst "$rank"
}

if [ -z "$CERT_FILES" ] && [ -z "$CERT_ENDPOINTS" ]; then
  p7_emit tls.cert unknown unknown "no local certificate paths or endpoints configured (set P7_CERT_FILES and/or P7_CERT_ENDPOINTS)" "\"runbook\":\"docs/monitoring-runbook.md#certificates\""
  exit 4
fi

if ! command -v openssl >/dev/null 2>&1; then
  p7_emit tls.cert unknown unknown "openssl is unavailable; cannot inspect certificates" "\"runbook\":\"docs/monitoring-runbook.md#certificates\""
  exit 4
fi
if [ -n "$CERT_ENDPOINTS" ] && ! command -v timeout >/dev/null 2>&1; then
  p7_emit tls.cert unknown unknown "endpoint mode requires the timeout utility" "\"runbook\":\"docs/monitoring-runbook.md#certificates\""
  exit 4
fi

if [ -n "$CERT_FILES" ]; then
  while IFS= read -r cert_file; do
    [ -n "$cert_file" ] || continue
    name="$(basename "$cert_file")"
    if [ ! -f "$cert_file" ]; then
      line="$(p7_emit "cert:${name}" unknown unknown "certificate file is missing" "\"file\":\"$(p7_json_escape "$name")\",\"runbook\":\"docs/monitoring-runbook.md#certificates\"")"
      printf '%s\n' "$line"
      note_worst 4
      continue
    fi
    not_after="$(openssl x509 -enddate -noout -in "$cert_file" 2>/dev/null | sed 's/^notAfter=//' || true)"
    emit_target "cert:${name}" "$name" "$not_after" "\"mode\":\"file\""
  done <<<"$CERT_FILES"
fi

if [ -n "$CERT_ENDPOINTS" ]; then
  while IFS= read -r endpoint; do
    [ -n "$endpoint" ] || continue
    case "$endpoint" in
      *:*) host="${endpoint%:*}"; port="${endpoint##*:}" ;;
      *) host=""; port="" ;;
    esac
    case "$port" in ''|*[!0-9]*) host=""; port="" ;; esac
    if [ -z "$host" ] || [ -z "$port" ]; then
      line="$(p7_emit "cert:endpoint:${endpoint}" unknown unknown "invalid endpoint; expected host:port" "\"endpoint\":\"$(p7_json_escape "$endpoint")\",\"runbook\":\"docs/monitoring-runbook.md#certificates\"")"
      printf '%s\n' "$line"
      note_worst 4
      continue
    fi
    pem="$(timeout "$ENDPOINT_TIMEOUT" openssl s_client -connect "${host}:${port}" -servername "$host" </dev/null 2>/dev/null || true)"
    not_after="$(printf '%s\n' "$pem" | openssl x509 -enddate -noout 2>/dev/null | sed 's/^notAfter=//' || true)"
    emit_target "cert:endpoint:${host}:${port}" "${host}:${port}" "$not_after" "\"mode\":\"endpoint\""
  done <<<"$CERT_ENDPOINTS"
fi

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
