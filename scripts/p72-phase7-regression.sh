#!/usr/bin/env bash
# Phase 7.2 isolated Phase 7.1 regression: local-mock delivery, heartbeat,
# rotation, redaction and monitor orchestration.
#
# Uses only local Python HTTP mocks, synthetic credentials and a throwaway state
# directory. No real Telegram/heartbeat provider, production container, service,
# timer or credential is used or activated.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d "${P72_TMP_ROOT:-${TMPDIR:-/tmp}}/p72-phase7.XXXXXX")"
PIDS=()

cleanup() {
  for pid in "${PIDS[@]:-}"; do
    kill "$pid" >/dev/null 2>&1 || true
  done
  rm -rf "$TMP"
}
trap cleanup EXIT

fail() {
  printf 'p72-phase7: FAIL: %s\n' "$*" >&2
  exit 1
}

assert_contains() {
  file="$1"; needle="$2"; label="$3"
  grep -F -q -- "$needle" "$file" || fail "$label: missing ${needle}"
}

assert_absent() {
  file="$1"; needle="$2"; label="$3"
  if grep -F -q -- "$needle" "$file" 2>/dev/null; then
    fail "$label: unexpected ${needle}"
  fi
}

count_lines() {
  grep -F -c -- "$2" "$1" 2>/dev/null || printf '0'
}

assert_body_contains() {
  file="$1"; needle="$2"; label="$3"
  python3 - "$file" "$needle" "$label" <<'PY'
import json
import sys

path, needle, label = sys.argv[1:4]
with open(path, encoding='utf-8') as fh:
    for line in fh:
        if needle in json.loads(line).get('body', ''):
            break
    else:
        raise SystemExit(f'p72-phase7: FAIL: {label}: missing {needle}')
PY
}

cat >"${TMP}/mock.py" <<'PY'
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

mode, port_file, log_file = sys.argv[1:4]


class Handler(BaseHTTPRequestHandler):
    def _record(self):
        length = int(self.headers.get('Content-Length') or 0)
        body = self.rfile.read(length).decode('utf-8', 'replace') if length else ''
        with open(log_file, 'a', encoding='utf-8') as fh:
            fh.write(json.dumps({
                'method': self.command,
                'path': self.path,
                'body': body,
            }) + '\n')
        return body

    def do_POST(self):
        body = self._record()
        if '/sendMessage' in self.path and mode in ('telegram_fail', 'all_fail'):
            self.send_response(500)
        elif '/sendMessage' in self.path:
            self.send_response(200)
        else:
            self.send_response(404)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(b'{"ok":true}' if mode != 'telegram_fail' else b'{"ok":false}')

    def do_GET(self):
        self._record()
        self.send_response(500 if mode == 'all_fail' else 200)
        self.send_header('Content-Type', 'text/plain')
        self.end_headers()
        self.wfile.write(b'p72-mock')

    def log_message(self, *_):
        pass


server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
with open(port_file, 'w', encoding='utf-8') as fh:
    fh.write(str(server.server_address[1]))
server.serve_forever()
PY

start_mock() {
  name="$1"; mode="$2"
  port_file="${TMP}/${name}.port"
  log_file="${TMP}/${name}.jsonl"
  python3 "${TMP}/mock.py" "$mode" "$port_file" "$log_file" \
    >"${TMP}/${name}.stdout" 2>"${TMP}/${name}.stderr" &
  PIDS+=("$!")
  for _ in $(seq 1 100); do
    [ -s "$port_file" ] && break
    sleep 0.05
  done
  [ -s "$port_file" ] || fail "${name}: mock did not start"
  printf '%s' "$port_file"
}

TG_TOKEN='p72-synthetic-token-do-not-use'
TG_CHAT='p72-synthetic-chat-id'
TG_SECRET='p72-telegram-secret-marker'
HB_SECRET='p72-heartbeat-secret-marker'
PHI_MARKERS=(
  'P72-PHI-NAME-JaneDoe'
  '9876543210'
  'patient.p72@example.test'
  'eyJhbGciOiJIUzI1NiJ9.p72header.p72signature'
  'p72-live-secret-marker'
)

tg_port_file="$(start_mock tg_success success)"
tg_port="$(cat "$tg_port_file")"
tg_log="${TMP}/tg_success.jsonl"
fail_port_file="$(start_mock fail_mocks all_fail)"
fail_port="$(cat "$fail_port_file")"
fail_log="${TMP}/fail_mocks.jsonl"

# 1. Telegram success: raw PHI/secret message is never forwarded, only allowlist fields.
tg_state="${TMP}/tg-success-state"; mkdir -p "$tg_state"
tg_alert='{"at":"2026-11-20T12:00:00Z","check":"system.time","status":"critical","severity":"page","message":"P72-PHI-NAME-JaneDoe phone +20 987 654 3210 patient.p72@example.test eyJhbGciOiJIUzI1NiJ9.p72header.p72signature p72-live-secret-marker"}'
if ! printf '%s\n' "$tg_alert" | env \
  P7_STATE_DIR="$tg_state" \
  P7_ALERT_SINK="${tg_state}/alerts.jsonl" \
  P7_TELEGRAM_BOT_TOKEN="$TG_TOKEN" \
  P7_TELEGRAM_CHAT_ID="$TG_CHAT" \
  P7_TELEGRAM_API_BASE="http://127.0.0.1:${tg_port}" \
  P7_TELEGRAM_MAX_ATTEMPTS=1 \
  P7_TELEGRAM_TIMEOUT_SEC=2 \
  P7_TELEGRAM_BACKOFF_SEC=0 \
  P7_HOST_LABEL='P72HOST' \
  P7_ALLOW_INSECURE_TEST=1 \
  bash "${SCRIPT_DIR}/p7-deliver-telegram.sh" >"${TMP}/tg.out" 2>"${TMP}/tg.err"; then
  fail 'telegram success adapter exited non-zero'
fi
assert_contains "$tg_log" "/bot${TG_TOKEN}/sendMessage" 'telegram success'
assert_body_contains "$tg_log" 'system.time' 'telegram success'
assert_body_contains "$tg_log" 'status=CRITICAL' 'telegram success'
assert_body_contains "$tg_log" 'host=P72HOST' 'telegram success'
assert_body_contains "$tg_log" '"disable_notification":false' 'telegram success paging'
for marker in "${PHI_MARKERS[@]}"; do
  assert_absent "$tg_log" "$marker" 'telegram delivery redaction'
  assert_absent "${tg_state}/alerts.jsonl" "$marker" 'telegram delivery redaction'
done
assert_absent "${TMP}/tg.out" "$TG_TOKEN" 'telegram token hygiene'
assert_absent "${TMP}/tg.err" "$TG_TOKEN" 'telegram token hygiene'
assert_absent "${tg_state}/alerts.jsonl" "$TG_TOKEN" 'telegram token hygiene'
[ "$(count_lines "$tg_log" '/sendMessage')" -eq 1 ] || fail 'telegram success did not send exactly one message'

# 2. Telegram failure: retries are bounded, exit stays 0, local degradation is raised.
tg_fail_state="${TMP}/tg-fail-state"; mkdir -p "$tg_fail_state"
for _ in 1 2; do
  if ! printf '%s\n' "$tg_alert" | env \
    P7_STATE_DIR="$tg_fail_state" \
    P7_ALERT_SINK="${tg_fail_state}/alerts.jsonl" \
    P7_TELEGRAM_BOT_TOKEN="$TG_TOKEN" \
    P7_TELEGRAM_CHAT_ID="$TG_CHAT" \
    P7_TELEGRAM_API_BASE="http://127.0.0.1:${fail_port}" \
    P7_TELEGRAM_MAX_ATTEMPTS=1 \
    P7_TELEGRAM_TIMEOUT_SEC=2 \
    P7_TELEGRAM_BACKOFF_SEC=0 \
    P7_TELEGRAM_FAIL_ESCALATE_AFTER=2 \
    P7_ALLOW_INSECURE_TEST=1 \
    bash "${SCRIPT_DIR}/p7-deliver-telegram.sh" >"${TMP}/tgfail.out" 2>"${TMP}/tgfail.err"; then
    fail 'telegram failure adapter exited non-zero'
  fi
done
[ "$(count_lines "$fail_log" '/sendMessage')" -eq 2 ] || fail 'telegram failure retry count was not 2'
assert_contains "${tg_fail_state}/alerts.jsonl" 'telegram.delivery_failed' 'telegram failure state'
assert_contains "${tg_fail_state}/alerts.jsonl" 'telegram.delivery_degraded' 'telegram degradation'
[ -f "${tg_fail_state}/p7-telegram-delivery-degraded" ] || fail 'telegram degraded marker was not created'
assert_absent "${TMP}/tgfail.out" "$TG_TOKEN" 'telegram failure token hygiene'
assert_absent "${TMP}/tgfail.err" "$TG_TOKEN" 'telegram failure token hygiene'

# 3. Monitor cycle: a critical check forwards to Telegram and pings heartbeat once.
mon_port_file="$(start_mock monitor success)"
mon_port="$(cat "$mon_port_file")"
mon_log="${TMP}/monitor.jsonl"
mon_state="${TMP}/monitor-state"; mkdir -p "$mon_state"
now="$(date -u +%s)"
if ! env \
  P7_STATE_DIR="$mon_state" \
  P7_ALERT_SINK="${mon_state}/alerts.jsonl" \
  P7_HEARTBEAT_FILE="${mon_state}/heartbeat" \
  P7_MONITOR_CHECKS='time' \
  P7_NOW_EPOCH="$now" \
  P7_EXPECTED_EPOCH=0 \
  P7_TELEGRAM_BOT_TOKEN="$TG_TOKEN" \
  P7_TELEGRAM_CHAT_ID="$TG_CHAT" \
  P7_TELEGRAM_API_BASE="http://127.0.0.1:${mon_port}" \
  P7_TELEGRAM_MAX_ATTEMPTS=1 \
  P7_TELEGRAM_TIMEOUT_SEC=2 \
  P7_TELEGRAM_BACKOFF_SEC=0 \
  P7_HOST_LABEL='P72HOST' \
  P7_HEARTBEAT_URL="http://127.0.0.1:${mon_port}/hb/${HB_SECRET}" \
  P7_HEARTBEAT_TIMEOUT_SEC=2 \
  P7_ALLOW_INSECURE_TEST=1 \
  bash "${SCRIPT_DIR}/p7-monitor.sh" >"${TMP}/monitor.out" 2>"${TMP}/monitor.err"; then
  fail 'monitor cycle exited non-zero'
fi
[ "$(count_lines "$mon_log" '/sendMessage')" -eq 1 ] || fail 'monitor did not forward one critical alert to Telegram'
[ "$(count_lines "$mon_log" '/hb/')" -eq 1 ] || fail 'monitor did not ping heartbeat exactly once'
[ "$(cat "${mon_state}/heartbeat" 2>/dev/null)" = "$now" ] || fail 'heartbeat file was not updated with cycle epoch'
assert_contains "${TMP}/monitor.out" 'monitor.complete' 'monitor completion'
assert_contains "$mon_log" 'system.time' 'monitor telegram content'
assert_absent "${TMP}/monitor.out" "$TG_TOKEN" 'monitor token hygiene'
assert_absent "${TMP}/monitor.err" "$TG_TOKEN" 'monitor token hygiene'
assert_absent "${mon_state}/alerts.jsonl" "$TG_TOKEN" 'monitor token hygiene'
assert_absent "${TMP}/monitor.out" "$HB_SECRET" 'monitor heartbeat URL hygiene'
assert_absent "${TMP}/monitor.err" "$HB_SECRET" 'monitor heartbeat URL hygiene'
assert_absent "${mon_state}/alerts.jsonl" "$HB_SECRET" 'monitor heartbeat URL hygiene'

# 4. Heartbeat failure: failure stays non-blocking and raises local degradation.
hb_fail_state="${TMP}/hb-fail-state"; mkdir -p "$hb_fail_state"
for _ in 1 2; do
  if ! env \
    P7_STATE_DIR="$hb_fail_state" \
    P7_ALERT_SINK="${hb_fail_state}/alerts.jsonl" \
    P7_HEARTBEAT_URL="http://127.0.0.1:${fail_port}/hb/${HB_SECRET}" \
    P7_HEARTBEAT_TIMEOUT_SEC=2 \
    P7_HEARTBEAT_FAIL_ESCALATE_AFTER=2 \
    P7_ALLOW_INSECURE_TEST=1 \
    bash "${SCRIPT_DIR}/p7-heartbeat-hook.sh" >"${TMP}/hbfail.out" 2>"${TMP}/hbfail.err"; then
    fail 'heartbeat failure hook exited non-zero'
  fi
done
[ "$(count_lines "$fail_log" '/hb/')" -eq 2 ] || fail 'heartbeat failure ping count was not 2'
assert_contains "${hb_fail_state}/alerts.jsonl" 'heartbeat.failed_http_500' 'heartbeat failure state'
assert_contains "${hb_fail_state}/alerts.jsonl" 'heartbeat.delivery_degraded' 'heartbeat degradation'
[ -f "${hb_fail_state}/p7-heartbeat-delivery-degraded" ] || fail 'heartbeat degraded marker was not created'
assert_absent "${TMP}/hbfail.out" "$HB_SECRET" 'heartbeat URL hygiene'
assert_absent "${TMP}/hbfail.err" "$HB_SECRET" 'heartbeat URL hygiene'
assert_absent "${hb_fail_state}/alerts.jsonl" "$HB_SECRET" 'heartbeat URL hygiene'

# 5. Local sink rotation keeps only the configured number of rotated files.
rot_state="${TMP}/rotate-state"; mkdir -p "$rot_state"
for n in 1 2 3 4 5; do
  P7_STATE_DIR="$rot_state" \
  P7_ALERT_SINK="${rot_state}/alerts.jsonl" \
  P7_SINK_MAX_BYTES=40 \
  P7_SINK_KEEP=2 \
  bash -c '. "$1"; p7_alert "$2"' bash "${SCRIPT_DIR}/p7-common.sh" "p72-rotation-line-${n}-with-extra-padding-to-force-rotation"
done
[ -f "${rot_state}/alerts.jsonl" ] || fail 'live sink missing after rotation'
[ -f "${rot_state}/alerts.jsonl.1" ] || fail 'rotated sink .1 missing'
[ -f "${rot_state}/alerts.jsonl.2" ] || fail 'rotated sink .2 missing'
[ ! -e "${rot_state}/alerts.jsonl.3" ] || fail 'rotated sink .3 exceeded P7_SINK_KEEP'
assert_contains "${rot_state}/alerts.jsonl" 'p72-rotation-line-5' 'rotation newest line'
assert_contains "${rot_state}/alerts.jsonl.1" 'p72-rotation-line-4' 'rotation .1 line'
assert_contains "${rot_state}/alerts.jsonl.2" 'p72-rotation-line-3' 'rotation .2 line'

printf 'p72-phase7: PASS telegram_success=1 telegram_retry=2 heartbeat_cycle=1 heartbeat_retry=2 rotation_keep=2 redaction_markers=0 secrets_in_output=0\n'
