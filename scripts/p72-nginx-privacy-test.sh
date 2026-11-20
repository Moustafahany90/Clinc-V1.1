#!/usr/bin/env bash
# Phase 7.2 isolated nginx error/access-log privacy regression.
#
# Uses only already-local images, synthetic markers and throwaway p72*
# containers/network. No production container, volume, port or config is used.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
CONF="${ROOT}/web/nginx.conf"
WEB_IMAGE="${P72_WEB_IMAGE:-ultrasound-clinic-web:latest}"
CADDY_IMAGE="${P72_CADDY_IMAGE:-caddy:2.11-alpine}"
NODE_IMAGE="${P72_NODE_IMAGE:-node:22-alpine}"
RUN_ID="p72-nginx-$$"
TMP="$(mktemp -d "${P72_TMP_ROOT:-${TMPDIR:-/tmp}}/${RUN_ID}.XXXXXX")"
NET="${RUN_ID}-net"
NGINX="${RUN_ID}-nginx"
MOCK="${RUN_ID}-upstream"
CURL="${RUN_ID}-curl"
DOCKER="${P72_DOCKER:-docker}" # allow Windows hosts to pass docker.exe explicitly

host_path() {
  case "$DOCKER" in
    *.exe)
      if command -v wslpath >/dev/null 2>&1; then wslpath -w "$1"; else printf '%s' "$1"; fi
      ;;
    *) printf '%s' "$1" ;;
  esac
}

cleanup() {
  "$DOCKER" rm -f "$NGINX" "$MOCK" "$CURL" >/dev/null 2>&1 || true
  "$DOCKER" network rm "$NET" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

fail() {
  printf 'p72-nginx: FAIL: %s\n' "$*" >&2
  exit 1
}

assert_no_markers() {
  logdir="$1"
  marker="$2"
  for field in QUERY TOKEN REFERRER AUTH COOKIE; do
    if grep -R -F -q "P7${field}-${marker}" "$logdir" 2>/dev/null; then
      fail "P7${field}-${marker} leaked into persistent nginx logs"
    fi
  done
  if grep -F -q '[error]' "${logdir}/error.log" 2>/dev/null; then
    fail "request-bearing nginx error message reached error.log"
  fi
}

assert_failure_class() {
  logfile="$1"
  class="$2"
  grep -F -q "\"class\":\"${class}\"" "$logfile" || fail "missing failure class ${class}"
}

assert_upstream_received_full_request() {
  mocklog="$1"
  marker="$2"
  for field in QUERY TOKEN AUTH COOKIE REFERRER; do
    grep -F -q "P7${field}-${marker}" "$mocklog" || fail "upstream did not receive P7${field}-${marker}"
  done
}

request() {
  alias="$1"
  marker="$2"
  "$DOCKER" run --rm --pull=never --network "$NET" --name "$CURL" "$CADDY_IMAGE" \
    curl -sS -o /dev/null -w '%{http_code}' \
    -H "Authorization: Bearer P7AUTH-${marker}-1234567890" \
    -H "Cookie: session=P7COOKIE-${marker}-1234567890" \
    -H "Referer: https://clinic.test/report?q=P7REFERRER-${marker}-1234567890" \
    "http://${alias}/api/v1/reports?q=P7QUERY-${marker}-1234567890&token=P7TOKEN-${marker}-1234567890"
}

mkdir -p "$TMP/refusal/logs" "$TMP/http500/logs" "$TMP/http500/mock" "$TMP/timeout/logs" "$TMP/timeout/mock"

cat >"${TMP}/upstream.mjs" <<'EOF'
import http from 'node:http';
import { appendFileSync } from 'node:fs';
const mode = process.env.P72_MOCK_MODE ?? '500';
const logPath = process.env.P72_MOCK_LOG ?? '/app/logs/upstream.jsonl';
http
  .createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      appendFileSync(
        logPath,
        `${JSON.stringify({
          url: req.url,
          authorization: req.headers.authorization ?? null,
          cookie: req.headers.cookie ?? null,
          referer: req.headers.referer ?? null,
          body: Buffer.concat(chunks).toString('utf8').slice(0, 1000),
        })}\n`,
      );
      if (mode === 'timeout') return;
      const status = mode === '500' ? 500 : 200;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ mock: true, status }));
    });
  })
  .listen(4000, '0.0.0.0');
EOF

sed 's/proxy_read_timeout 120s;/proxy_read_timeout 1s;/; s/proxy_send_timeout 120s;/proxy_send_timeout 1s;/' \
  "$CONF" >"${TMP}/nginx-timeout.conf"

"$DOCKER" network create "$NET" >/dev/null

# 1. Upstream connection refusal.
"$DOCKER" run -d --pull=never --name "$NGINX" --network "$NET" --network-alias web \
  --add-host backend:127.0.0.1 \
  -v "$(host_path "$CONF"):/etc/nginx/conf.d/default.conf:ro" \
  -v "$(host_path "$TMP/refusal/logs"):/var/log/nginx" "$WEB_IMAGE" >/dev/null
sleep 2
[ "$(request web REFUSAL)" = '502' ] || fail 'refusal status was not 502'
assert_no_markers "$TMP/refusal/logs" REFUSAL
assert_failure_class "$TMP/refusal/logs/upstream-failures.log" upstream_connect_failure
"$DOCKER" rm -f "$NGINX" "$CURL" >/dev/null 2>&1 || true

# 2. Upstream HTTP failure.
"$DOCKER" run -d --pull=never --name "$NGINX" --network "$NET" --network-alias web \
  -v "$(host_path "$TMP/nginx-timeout.conf"):/etc/nginx/conf.d/default.conf:ro" \
  -v "$(host_path "$TMP/http500/logs"):/var/log/nginx" "$WEB_IMAGE" >/dev/null
"$DOCKER" run -d --pull=never --name "$MOCK" --network "$NET" --network-alias backend \
  -e P72_MOCK_MODE=500 -e P72_MOCK_LOG=/app/logs/upstream.jsonl \
  -v "$(host_path "$TMP/upstream.mjs"):/app/upstream.mjs:ro" \
  -v "$(host_path "$TMP/http500/mock"):/app/logs" "$NODE_IMAGE" node /app/upstream.mjs >/dev/null
sleep 2
[ "$(request web HTTP500)" = '500' ] || fail 'upstream 500 status was not 500'
assert_no_markers "$TMP/http500/logs" HTTP500
assert_failure_class "$TMP/http500/logs/upstream-failures.log" upstream_http_failure
assert_upstream_received_full_request "$TMP/http500/mock/upstream.jsonl" HTTP500
"$DOCKER" rm -f "$NGINX" "$MOCK" "$CURL" >/dev/null 2>&1 || true

# 3. Upstream read timeout.
"$DOCKER" run -d --pull=never --name "$NGINX" --network "$NET" --network-alias web \
  -v "$(host_path "$TMP/nginx-timeout.conf"):/etc/nginx/conf.d/default.conf:ro" \
  -v "$(host_path "$TMP/timeout/logs"):/var/log/nginx" "$WEB_IMAGE" >/dev/null
"$DOCKER" run -d --pull=never --name "$MOCK" --network "$NET" --network-alias backend \
  -e P72_MOCK_MODE=timeout -e P72_MOCK_LOG=/app/logs/upstream.jsonl \
  -v "$(host_path "$TMP/upstream.mjs"):/app/upstream.mjs:ro" \
  -v "$(host_path "$TMP/timeout/mock"):/app/logs" "$NODE_IMAGE" node /app/upstream.mjs >/dev/null
sleep 2
[ "$(request web TIMEOUT)" = '504' ] || fail 'timeout status was not 504'
assert_no_markers "$TMP/timeout/logs" TIMEOUT
assert_failure_class "$TMP/timeout/logs/upstream-failures.log" upstream_timeout
assert_upstream_received_full_request "$TMP/timeout/mock/upstream.jsonl" TIMEOUT

printf 'p72-nginx: PASS refusal=502 upstream_http_failure=500 timeout=504 secrets_in_logs=0 upstream_full_request=1\n'
