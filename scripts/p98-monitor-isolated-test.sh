#!/usr/bin/env bash
# Phase 9.8 isolated, synthetic monitoring proof (PB-26 and PB-29).
# No production host, no real endpoint, no credential, no installed unit.
# All disposable resources are named p98* and removed by the EXIT trap.
set -uo pipefail
export MSYS_NO_PATHCONV=1

REPO="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/p98-monitor-tests.XXXXXX")" || {
  printf 'BLOCKED: could not create disposable p98 temp directory\n' >&2; exit 1
}
[ -n "$TMP" ] && [ -d "$TMP" ] || {
  printf 'BLOCKED: disposable p98 temp directory is unusable\n' >&2; exit 1
}
PASS_COUNT=0
FAIL_COUNT=0
DOCKER_NAME="p98-monitor-perms"
OPENSSL_PID=""
# In Git Bash on Windows the `docker` shim delegates to a WSL distro that may
# not have Docker integration. docker.exe is the native CLI and can reach the
# already-running local daemon without any pull or host mutation.
if [ -n "${P98_DOCKER_BIN:-}" ]; then
  DOCKER_BIN="$P98_DOCKER_BIN"
elif command -v docker.exe >/dev/null 2>&1; then
  DOCKER_BIN=docker.exe
else
  DOCKER_BIN=docker
fi

cleanup() {
  [ -z "$OPENSSL_PID" ] || kill "$OPENSSL_PID" 2>/dev/null || true
  if "$DOCKER_BIN" ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "$DOCKER_NAME"; then
    "$DOCKER_BIN" rm -f "$DOCKER_NAME" >/dev/null 2>&1 || true
  fi
  rm -rf -- "$TMP"
}
trap cleanup EXIT

ok() { printf 'PASS  %s\n' "$1"; PASS_COUNT=$((PASS_COUNT + 1)); }
bad() { printf 'FAIL  %s\n' "$1"; FAIL_COUNT=$((FAIL_COUNT + 1)); }
check() { if [ "$1" -eq "$2" ]; then ok "$3 ($1)"; else bad "$3 (expected $2, got $1)"; fi; }

SCRIPTS="${TMP}/p98-scripts"
BIN="${TMP}/p98-bin"
STATE="${TMP}/p98-state"
mkdir -p "$SCRIPTS" "$BIN" "$STATE"
cp "$REPO"/scripts/*.sh "$SCRIPTS/"
# Delivery hooks are inert here and must not make any external call.
rm -f "$SCRIPTS/p7-deliver-telegram.sh" "$SCRIPTS/p7-heartbeat-hook.sh"

run_cert() {
  env P7_STATE_DIR="$STATE" P7_ALERT_SINK='' \
    P7_NOW_EPOCH="${P98_NOW_EPOCH:-$(date -u +%s)}" \
    P7_CERT_FILES="${P98_CERT_FILES:-}" P7_CERT_ENDPOINTS="${P98_CERT_ENDPOINTS:-}" \
    P7_CERT_WARN_DAYS=30 P7_CERT_HIGH_DAYS=14 P7_CERT_CRITICAL_DAYS=7 \
    P7_CERT_ENDPOINT_TIMEOUT_SEC=3 \
    bash "$SCRIPTS/p7-check-cert.sh" "$@"
}

printf 'Phase 9.8 isolated monitoring proof (synthetic p98 fixtures)\n'

# --- PB-29: certificate file mode with deterministic time injection ----------
openssl req -x509 -newkey rsa:2048 -nodes -days 60 -subj '/CN=p98-healthy.test' \
  -keyout "${TMP}/healthy.key" -out "${TMP}/healthy.pem" >/dev/null 2>&1
openssl req -x509 -newkey rsa:2048 -nodes -days 20 -subj '/CN=p98-warn.test' \
  -keyout "${TMP}/warn.key" -out "${TMP}/warn.pem" >/dev/null 2>&1
openssl req -x509 -newkey rsa:2048 -nodes -days 3 -subj '/CN=p98-soon.test' \
  -keyout "${TMP}/soon.key" -out "${TMP}/soon.pem" >/dev/null 2>&1
[ -f "${TMP}/healthy.pem" ] && [ -f "${TMP}/warn.pem" ] && [ -f "${TMP}/soon.pem" ]
check $? 0 'synthetic self-signed certificates generated locally'

P98_CERT_FILES="${TMP}/healthy.pem" run_cert >"${TMP}/cert60.out" 2>&1
check $? 0 '60-day certificate reports ok'
grep -q '"status":"ok"' "${TMP}/cert60.out"
check $? 0 '60-day certificate emits ok status line'

P98_CERT_FILES="${TMP}/warn.pem" run_cert >"${TMP}/cert20.out" 2>&1
[ "$?" -ne 0 ]
check $? 0 '20-day certificate fails closed at warn threshold'
grep -q '"status":"warn"' "${TMP}/cert20.out"
check $? 0 '20-day certificate is classified warn'

P98_CERT_FILES="${TMP}/soon.pem" run_cert >"${TMP}/cert3.out" 2>&1
[ "$?" -ne 0 ]
check $? 0 '3-day certificate fails closed'
grep -q '"status":"critical"' "${TMP}/cert3.out"
check $? 0 '3-day certificate is classified critical'

FUTURE_NOW=$(( $(date -u +%s) + 25 * 86400 ))
P98_NOW_EPOCH="$FUTURE_NOW" P98_CERT_FILES="${TMP}/warn.pem" run_cert >"${TMP}/certexpired.out" 2>&1
[ "$?" -ne 0 ]
check $? 0 'expired certificate fails closed'
grep -q 'certificate has expired' "${TMP}/certexpired.out"
check $? 0 'expired certificate is reported as expired'

P98_CERT_FILES="${TMP}/missing.pem" run_cert >"${TMP}/certmissing.out" 2>&1
[ "$?" -ne 0 ]
check $? 0 'missing certificate file fails closed'
grep -q '"status":"unknown"' "${TMP}/certmissing.out"
check $? 0 'missing certificate file emits unknown status'

# --- PB-29: additive endpoint mode against a local synthetic TLS server -----
PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()' 2>/dev/null || printf '0')"
if [ "$PORT" -gt 0 ] 2>/dev/null; then
  openssl s_server -accept "$PORT" -cert "${TMP}/healthy.pem" -key "${TMP}/healthy.key" -quiet \
    >/dev/null 2>&1 &
  OPENSSL_PID=$!
  sleep 1
  P98_CERT_ENDPOINTS="127.0.0.1:${PORT}" run_cert >"${TMP}/endpoint.out" 2>&1
  check $? 0 'local synthetic TLS endpoint reports ok'
  grep -q '"mode":"endpoint"' "${TMP}/endpoint.out"
  check $? 0 'endpoint mode emits an endpoint-labelled status'
  kill "$OPENSSL_PID" 2>/dev/null || true
  OPENSSL_PID=""
  wait "$OPENSSL_PID" 2>/dev/null || true

  CLOSED_PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()' 2>/dev/null || printf '0')"
  P98_CERT_ENDPOINTS="127.0.0.1:${CLOSED_PORT}" run_cert >"${TMP}/closed.out" 2>&1
  [ "$?" -ne 0 ]
  check $? 0 'closed TLS port fails closed'
  grep -q '"status":"unknown"' "${TMP}/closed.out"
  check $? 0 'closed TLS port emits unknown status'
else
  bad 'synthetic TLS endpoint tests (python3 unavailable)'
  bad 'endpoint mode emits an endpoint-labelled status'
  bad 'closed TLS port fails closed'
  bad 'closed TLS port emits unknown status'
fi

# --- PB-29: time check fails closed without an authoritative signal ----------
cat >"${BIN}/timedatectl" <<'EOF_STUB'
#!/bin/sh
exit 1
EOF_STUB
chmod +x "${BIN}/timedatectl"
env PATH="${BIN}:${PATH}" P7_BIN_DIR="$BIN" P7_STATE_DIR="$STATE" P7_ALERT_SINK='' \
  bash "$SCRIPTS/p7-check-time.sh" >"${TMP}/time.out" 2>&1
[ "$?" -ne 0 ]
check $? 0 'time check fails closed without NTP or external epoch'
grep -q '"status":"unknown"' "${TMP}/time.out"
check $? 0 'time check emits unknown status'

env PATH="${BIN}:${PATH}" P7_BIN_DIR="$BIN" P7_STATE_DIR="$STATE" P7_ALERT_SINK='' \
  P7_EXPECTED_EPOCH="$(date -u +%s)" \
  bash "$SCRIPTS/p7-check-time.sh" >"${TMP}/timeok.out" 2>&1
check $? 0 'time check accepts a trusted external epoch'

# --- PB-29: container check fails closed on docker command errors ------------
cat >"${BIN}/docker" <<'EOF_STUB'
#!/bin/sh
case "${1:-}" in
  ps)
    [ "${P98_DOCKER_MODE:-}" = psfail ] && exit 1
    printf 'p98_backend|Up 5 minutes|running\n'
    ;;
  inspect)
    [ "${P98_DOCKER_MODE:-}" = inspectfail ] && exit 1
    printf 'healthy|0|false\n'
    ;;
esac
exit 0
EOF_STUB
chmod +x "${BIN}/docker"

run_containers() {
  env PATH="${BIN}:${PATH}" P7_BIN_DIR="$BIN" P7_STATE_DIR="$STATE" P7_ALERT_SINK='' \
    P7_COMPOSE_PROJECT=p98 P98_DOCKER_MODE="${P98_DOCKER_MODE:-${1:-}}" \
    bash "$SCRIPTS/p7-check-containers.sh"
}
P98_DOCKER_MODE=psfail run_containers >"${TMP}/containers-ps.out" 2>&1
[ "$?" -ne 0 ]
check $? 0 'docker ps failure fails closed'
grep -q '"status":"unknown"' "${TMP}/containers-ps.out"
check $? 0 'docker ps failure emits unknown status'

P98_DOCKER_MODE=inspectfail run_containers >"${TMP}/containers-inspect.out" 2>&1
[ "$?" -ne 0 ]
check $? 0 'docker inspect failure fails closed'
grep -q '"status":"unknown"' "${TMP}/containers-inspect.out"
check $? 0 'docker inspect failure is not replaced by healthy defaults'

run_containers >"${TMP}/containers-ok.out" 2>&1
check $? 0 'synthetic healthy container reports ok'

# --- PB-29: monitor alert cap and crashing-check visibility ------------------
cat >"${SCRIPTS}/p7-check-p98cap.sh" <<'EOF_CAP'
#!/usr/bin/env bash
. "$(dirname "$0")/p7-common.sh"
p7_emit p98.cap.1 high warn "synthetic alert one"
p7_emit p98.cap.2 high warn "synthetic alert two"
p7_emit p98.cap.3 high warn "synthetic alert three"
p7_emit p98.cap.4 high warn "synthetic alert four"
EOF_CAP
cat >"${SCRIPTS}/p7-check-p98crash.sh" <<'EOF_CRASH'
#!/usr/bin/env bash
exit 2
EOF_CRASH
chmod +x "${SCRIPTS}/p7-check-p98cap.sh" "${SCRIPTS}/p7-check-p98crash.sh"

CAP_STATE="${TMP}/p98-cap-state"
mkdir -p "$CAP_STATE"
env P7_STATE_DIR="$CAP_STATE" P7_ALERT_SINK="${CAP_STATE}/alerts.jsonl" \
  P7_NOW_EPOCH="$(date -u +%s)" P7_MONITOR_CHECKS='p98cap' \
  P7_DEDUP_WINDOW_SECONDS=3600 P7_MAX_ALERTS_PER_WINDOW=2 \
  bash "$SCRIPTS/p7-monitor.sh" >"${TMP}/cap.out" 2>&1
check $? 0 'monitor completes with capped synthetic alerts'
cap_count="$(grep -c '"check":"p98.cap.' "${CAP_STATE}/alerts.jsonl" 2>/dev/null || printf '0')"
check "$cap_count" 2 'per-window alert cap is enforced'

CRASH_STATE="${TMP}/p98-crash-state"
mkdir -p "$CRASH_STATE"
env P7_STATE_DIR="$CRASH_STATE" P7_ALERT_SINK='' P7_NOW_EPOCH="$(date -u +%s)" \
  P7_MONITOR_CHECKS='p98crash' bash "$SCRIPTS/p7-monitor.sh" >"${TMP}/crash.out" 2>&1
check $? 0 'monitor completes after a crashing check'
grep -q '"check":"check:p98crash"' "${TMP}/crash.out"
check $? 0 'non-emitting crashing check produces a visible alert'

# --- PB-26: ownership model proved with synthetic Linux users -----------------
cat >"${TMP}/p98-perms.sh" <<'EOF_PERMS'
#!/bin/bash
set -eu
groupadd -f p98clinic
groupadd -f p98outsider
id -u p98member >/dev/null 2>&1 || useradd -M -g p98clinic p98member
id -u p98outsider >/dev/null 2>&1 || useradd -M -g p98outsider p98outsider
rm -rf /tmp/p98-state
install -d -o root -g p98clinic -m 0750 /tmp/p98-state
printf '%s\n' "$(date -u +%s)" >/tmp/p98-state/heartbeat
chown root:p98clinic /tmp/p98-state/heartbeat
chmod 0660 /tmp/p98-state/heartbeat
[ "$(stat -c %a /tmp/p98-state)" = 750 ]
printf 'p98-perms: state directory is 0750 root:p98clinic\n'
runuser -u p98member -- stat -c %Y /tmp/p98-state/heartbeat >/dev/null
printf 'p98-perms: group member can stat the heartbeat\n'
if runuser -u p98outsider -- stat -c %Y /tmp/p98-state/heartbeat >/dev/null 2>&1; then
  printf 'p98-perms: non-member unexpectedly read the heartbeat\n' >&2
  exit 1
fi
printf 'p98-perms: non-member is denied\n'
EOF_PERMS
chmod +x "${TMP}/p98-perms.sh"

if "$DOCKER_BIN" run -i --rm --pull=never --name "$DOCKER_NAME" --user 0 \
    --entrypoint /bin/bash ubuntu:24.04 -s <"${TMP}/p98-perms.sh" \
    >"${TMP}/perms.out" 2>&1; then
  ok 'PB-26 ownership model proved in a disposable synthetic container'
  grep -q 'state directory is 0750' "${TMP}/perms.out"
  check $? 0 'state directory mode is 0750'
  grep -q 'group member can stat' "${TMP}/perms.out"
  check $? 0 'clinc_server-equivalent member can stat the heartbeat'
  grep -q 'non-member is denied' "${TMP}/perms.out"
  check $? 0 'non-member deny proof passed'
else
  bad 'PB-26 ownership model proved in a disposable synthetic container'
  bad 'state directory mode is 0750'
  bad 'clinc_server-equivalent member can stat the heartbeat'
  bad 'non-member deny proof passed'
  printf 'DEBUG === perms.out ===\n' >&2
  cat "${TMP}/perms.out" >&2
fi

# --- PB-26/PB-31: unit and config invariants ---------------------------------
unit_dir="$REPO/deploy"
grep -q '^Group=clinc_server$' "$unit_dir/clinic-monitor.service"
check $? 0 'monitor unit uses the clinc_server primary group'
grep -q '^UMask=0007$' "$unit_dir/clinic-monitor.service"
check $? 0 'monitor unit creates group-readable state with UMask=0007'
grep -q '^User=clinc_server$' "$unit_dir/clinic-heartbeat-check.service"
check $? 0 'heartbeat check runs as clinc_server'
grep -q 'P7_CERT_FILES' "$unit_dir/monitor.env.example"
check $? 0 'monitor env example declares P7_CERT_FILES'
grep -q 'P7_CERT_ENDPOINTS' "$unit_dir/monitor.env.example"
check $? 0 'monitor env example declares P7_CERT_ENDPOINTS'
grep -q 'P7_CERT_ENDPOINTS' "$REPO/docker-compose.monitoring.yml"
check $? 0 'monitoring compose overlay declares P7_CERT_ENDPOINTS'

if [ "${P98_DEBUG:-0}" = "1" ] && [ "$FAIL_COUNT" -gt 0 ]; then
  for out_file in "$TMP"/*.out; do
    [ -f "$out_file" ] || continue
    printf 'DEBUG === %s ===\n' "$(basename "$out_file")"
    cat "$out_file"
  done
fi

printf 'RESULT  p98-monitor: %d passed, %d failed\n' "$PASS_COUNT" "$FAIL_COUNT"
[ "$FAIL_COUNT" -eq 0 ]
