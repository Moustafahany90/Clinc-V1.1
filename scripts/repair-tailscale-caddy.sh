#!/usr/bin/env bash
# Repair the Tailscale-only Caddy ingress in place, from GitHub main only.
#
# This script is intentionally narrow:
#   - it requires the currently deployed commit and the new pinned commit;
#   - it proves the new commit is the current GitHub main tip;
#   - it validates the commit-pinned Caddyfile and Compose port shape;
#   - it restarts ONLY the caddy service;
#   - it never touches db, migrate, backend, web, evolution, volumes, DNS,
#     firewall, Tailscale configuration, migrations, or protected env values.
#
# Default mode is read-only. A production change requires BOTH --apply and
# --confirm REPAIR. No .env value, private key, token, cookie, or patient
# record is ever printed.
set -Eeuo pipefail

REPO_URL="https://github.com/Moustafahany90/Clinc-V1.1.git"
APP_ROOT="/opt/clinic"
ENV_FILE="/etc/clinic/clinic.env"
COMPOSE_FILES=(-f docker-compose.yml -f docker-compose.tailscale.yml)
CADDY_SERVICE="caddy"
PROJECT_LABEL="com.docker.compose.project=ultrasound-clinic"

COMMIT=""
EXPECTED_CURRENT=""
APPLY=0
CONFIRM=""
TAILSCALE_IP=""

pass() { printf 'PASS  %s\n' "$*"; }
info() { printf 'INFO  %s\n' "$*"; }
warn() { printf 'WARN  %s\n' "$*" >&2; }
die() { printf 'ERROR %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage:
  bash scripts/repair-tailscale-caddy.sh \
    --commit <40-hex-sha> \
    --expected-current <40-hex-sha> \
    [--env-file <path>] [--apply --confirm REPAIR]

Options:
  --commit <sha>            New pinned commit; must be current GitHub main tip.
  --expected-current <sha>  Commit currently deployed at /opt/clinic.
  --env-file <path>         Protected env source. Default: /etc/clinic/clinic.env
  --apply                   Actually restart Caddy. Default is dry-run only.
  --confirm REPAIR          Required together with --apply.

The repair checks out the pinned commit from the approved GitHub repository and
runs: docker compose ... up -d --no-deps --force-recreate caddy
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --commit)
      [ "$#" -ge 2 ] || die "--commit requires a value"
      COMMIT="$2"
      shift 2
      ;;
    --expected-current)
      [ "$#" -ge 2 ] || die "--expected-current requires a value"
      EXPECTED_CURRENT="$2"
      shift 2
      ;;
    --env-file)
      [ "$#" -ge 2 ] || die "--env-file requires a value"
      ENV_FILE="$2"
      shift 2
      ;;
    --apply)
      APPLY=1
      shift
      ;;
    --confirm)
      [ "$#" -ge 2 ] || die "--confirm requires a value"
      CONFIRM="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

[[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || die "--commit must be a 40-character lowercase SHA"
[[ "$EXPECTED_CURRENT" =~ ^[0-9a-f]{40}$ ]] || die "--expected-current must be a 40-character lowercase SHA"
[ "$COMMIT" = "$EXPECTED_CURRENT" ] && die "new commit must differ from the currently deployed commit"

if [ "$APPLY" -eq 0 ]; then
  info "DRY RUN: --apply was not supplied; no checkout, container, volume or port change will be made"
elif [ "$CONFIRM" != "REPAIR" ]; then
  die "apply requires --confirm REPAIR"
else
  info "GATED REPAIR: Caddy-only restart requested"
fi

for tool in git tailscale ss python3 stat; do
  command -v "$tool" >/dev/null 2>&1 || die "required tool not found: $tool"
done

ROOT_CMD=()
if [ "$EUID" -ne 0 ]; then
  sudo -n true || die "non-interactive sudo is required for protected paths and Docker"
  ROOT_CMD=(sudo -n)
fi
run_root() { "${ROOT_CMD[@]}" "$@"; }

DOCKER_CMD=()
if docker info >/dev/null 2>&1; then
  DOCKER_CMD=(docker)
elif sudo -n docker info >/dev/null 2>&1; then
  DOCKER_CMD=(sudo -n docker)
else
  die "Docker CLI is unavailable or the daemon cannot be reached"
fi
pass "Docker access available"

# --- Artifact identity: GitHub main only ------------------------------------
MAIN_SHA="$(git ls-remote "$REPO_URL" refs/heads/main | awk 'NR==1 {print $1}')"
[ -n "$MAIN_SHA" ] || die "could not read refs/heads/main from GitHub"
[ "$MAIN_SHA" = "$COMMIT" ] || die "commit $COMMIT is not the current GitHub main tip ($MAIN_SHA)"
pass "GitHub main tip matches the pinned repair commit"

if command -v tailscale >/dev/null 2>&1; then
  TAILSCALE_IP="$(tailscale ip -4 2>/dev/null | head -n 1 || true)"
else
  TAILSCALE_IP="$(run_root tailscale ip -4 2>/dev/null | head -n 1 || true)"
fi
[ -n "$TAILSCALE_IP" ] || die "could not determine this host's tailnet IPv4"
python3 -c '
import ipaddress, sys
address = ipaddress.ip_address(sys.argv[1])
if address.version != 4 or address not in ipaddress.ip_network("100.64.0.0/10"):
    raise SystemExit(1)
' "$TAILSCALE_IP" || die "tailnet address is not an IPv4 CGNAT address"
pass "tailnet bind address detected"

# --- Protected env and certificate checks (values not displayed) ------------
run_root test -r "$ENV_FILE" || die "protected env source is missing or unreadable: $ENV_FILE"
pass "protected env source is readable (values not displayed)"

read_env_value() {
  run_root awk -v key="$1" '
    index($0, key "=") == 1 {
      value = substr($0, length(key) + 2)
      sub(/\r$/, "", value)
      print value
      exit
    }
  ' "$ENV_FILE"
}

ENV_TAILSCALE_IP="$(read_env_value TAILSCALE_IP)"
[ "$ENV_TAILSCALE_IP" = "$TAILSCALE_IP" ] || die "TAILSCALE_IP in protected env does not match detected tailnet address"
CLINIC_DOMAIN="$(read_env_value CLINIC_DOMAIN)"
CERT_DIR="$(read_env_value TAILSCALE_CERT_DIR)"
[ -n "$CLINIC_DOMAIN" ] || die "CLINIC_DOMAIN is missing from protected env"
[ -n "$CERT_DIR" ] || die "TAILSCALE_CERT_DIR is missing from protected env"
pass "protected ingress variables are internally consistent (values not displayed)"

run_root test -r "$CERT_DIR/$CLINIC_DOMAIN.crt" || die "Tailscale certificate file is missing or unreadable"
run_root test -r "$CERT_DIR/$CLINIC_DOMAIN.key" || die "Tailscale private key file is missing or unreadable"
KEY_MODE="$(run_root stat -c %a "$CERT_DIR/$CLINIC_DOMAIN.key")"
[ "$KEY_MODE" = "600" ] || die "Tailscale private key must be mode 0600"
pass "Tailscale certificate files are present and private key is 0600"

# --- Existing deployment identity -------------------------------------------
run_root test -d "$APP_ROOT/.git" || die "$APP_ROOT is not the approved Git checkout"
REMOTE="$(run_root git -C "$APP_ROOT" remote get-url origin 2>/dev/null || true)"
[ "$REMOTE" = "$REPO_URL" ] || die "existing checkout remote is not the approved GitHub repository"
CURRENT_HEAD="$(run_root git -C "$APP_ROOT" rev-parse HEAD 2>/dev/null || true)"
[ "$CURRENT_HEAD" = "$EXPECTED_CURRENT" ] || die "deployed HEAD does not match --expected-current"
DIRTY="$(run_root git -C "$APP_ROOT" status --porcelain 2>/dev/null || true)"
[ -z "$DIRTY" ] || die "existing checkout is not clean; refusing to overwrite local changes"
run_root cmp -s "$ENV_FILE" "$APP_ROOT/.env" || die "existing .env differs from protected env source"
pass "installed checkout is clean, pinned to $EXPECTED_CURRENT, and uses the approved env source"

# --- GitHub-only validation clone -------------------------------------------
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/clinic-caddy-repair.XXXXXX")" || die "could not create temporary validation directory"
cleanup() { rm -rf -- "$STAGE"; }
trap cleanup EXIT

git init -q -b main "$STAGE"
git -C "$STAGE" remote add origin "$REPO_URL"
git -C "$STAGE" fetch -q --no-tags --depth 1 origin "$COMMIT"
git -C "$STAGE" checkout -q --detach FETCH_HEAD

[ "$(git -C "$STAGE" rev-parse HEAD)" = "$COMMIT" ] || die "temporary clone HEAD does not match pinned commit"
[ -z "$(git -C "$STAGE" status --porcelain)" ] || die "temporary clone is not clean"
pass "temporary GitHub clone is clean and pinned to $COMMIT"

check_ingress_files() {
  local dir="$1"
  local caddyfile="$dir/deploy/Caddyfile.tailscale"
  [ -f "$dir/docker-compose.tailscale.yml" ] || die "docker-compose.tailscale.yml missing from pinned commit"
  [ -f "$caddyfile" ] || die "deploy/Caddyfile.tailscale missing from pinned commit"
  grep -q 'auto_https off' "$caddyfile" || die "Tailscale Caddyfile does not disable automatic HTTPS"
  grep -q 'https://{$CLINIC_DOMAIN}' "$caddyfile" || die "Tailscale Caddyfile has no HTTPS site block"
  grep -Fq 'tls /etc/tailscale/certs/{$CLINIC_DOMAIN}.crt /etc/tailscale/certs/{$CLINIC_DOMAIN}.key' "$caddyfile" \
    || die "Tailscale Caddyfile does not use the mounted container cert path"
  if grep -Fq 'tls {$TAILSCALE_CERT_DIR}' "$caddyfile"; then
    die "Tailscale Caddyfile still uses the host cert path inside the container"
  fi
  if grep -Eq '^[[:space:]]*http://' "$caddyfile"; then
    die "Tailscale Caddyfile contains an HTTP site block"
  fi
  if grep -Eq '^[[:space:]]*redir' "$caddyfile"; then
    die "Tailscale Caddyfile contains an unexpected redirect"
  fi
  if grep -q 'tls internal' "$caddyfile"; then
    die "Tailscale Caddyfile uses the wrong TLS mode"
  fi
  pass "Tailscale ingress files fail closed and use the mounted cert path"
}
check_ingress_files "$STAGE"

run_root install -m 0600 "$ENV_FILE" "$STAGE/.env"

validate_ports() {
  local dir="$1" rendered
  rendered="$(
    cd "$dir"
    "${DOCKER_CMD[@]}" compose "${COMPOSE_FILES[@]}" config --format json
  )"
  printf '%s' "$rendered" | python3 -c '
import ipaddress, json, sys

tail = ipaddress.ip_address(sys.argv[1])
loopback = {
    ipaddress.ip_address("127.0.0.1"),
    ipaddress.ip_address("::1"),
}
try:
    config = json.load(sys.stdin)
except Exception:
    print("FAIL  rendered Compose JSON could not be parsed")
    raise SystemExit(1)

services = config.get("services", {})
problems = []
for required in ("db", "web", "caddy"):
    if required not in services:
        problems.append("missing service: " + required)

caddy_ports = []
for name, service in services.items():
    for port in service.get("ports") or []:
        published = str(port.get("published", ""))
        target = str(port.get("target", ""))
        protocol = str(port.get("protocol", "tcp"))
        host_ip_text = str(port.get("host_ip", ""))
        try:
            host_ip = ipaddress.ip_address(host_ip_text)
        except ValueError:
            problems.append(name + ": published port has no valid host_ip")
            continue
        if published == "80":
            problems.append(name + ": port 80 is published")
        if name == "caddy":
            caddy_ports.append(port)
            if host_ip != tail:
                problems.append("caddy: 443 is not bound to TAILSCALE_IP")
            if published != "443" or target != "443" or protocol != "tcp":
                problems.append("caddy: expected tcp 443:443 only")
        elif name in ("db", "web"):
            if host_ip not in loopback:
                problems.append(name + ": published port is not bound to loopback")
        else:
            problems.append(name + ": no host port is permitted")

if len(caddy_ports) != 1:
    problems.append("expected exactly one caddy published port")

if problems:
    for problem in problems:
        print("FAIL  " + problem)
    raise SystemExit(1)
print("PASS  rendered Compose publishes only caddy 443 on tailnet plus loopback db/web")
' "$TAILSCALE_IP"
}

validate_compose() {
  local dir="$1"
  (
    cd "$dir"
    "${DOCKER_CMD[@]}" compose "${COMPOSE_FILES[@]}" config --quiet
  ) || die "Compose configuration failed in $dir"
  pass "Compose configuration renders in $dir"
  validate_ports "$dir"
}

validate_compose "$STAGE"

if [ "$APPLY" -eq 0 ]; then
  info "DRY RUN complete: no checkout, container, volume, network, DNS, TLS or firewall change"
  exit 0
fi

# --- Gated Caddy-only repair -------------------------------------------------
run_root git -C "$APP_ROOT" fetch -q --no-tags --depth 1 origin "$COMMIT"
run_root git -C "$APP_ROOT" checkout -q --detach "$COMMIT"

[ "$(run_root git -C "$APP_ROOT" rev-parse HEAD)" = "$COMMIT" ] || die "installed checkout HEAD does not match pinned repair commit"
[ -z "$(run_root git -C "$APP_ROOT" status --porcelain)" ] || die "installed checkout is not clean after checkout"
run_root cmp -s "$ENV_FILE" "$APP_ROOT/.env" || die "protected env changed during repair"
pass "installed checkout is clean and pinned to $COMMIT"

validate_compose "$APP_ROOT"

(
  cd "$APP_ROOT"
  "${DOCKER_CMD[@]}" compose "${COMPOSE_FILES[@]}" up -d --no-deps --force-recreate "$CADDY_SERVICE"
) || die "Caddy-only Compose restart failed"
pass "Caddy restarted from $COMMIT without recreating other services"

CADDY_ID="$(
  cd "$APP_ROOT"
  "${DOCKER_CMD[@]}" compose "${COMPOSE_FILES[@]}" ps -q "$CADDY_SERVICE"
)"
[ -n "$CADDY_ID" ] || die "could not resolve the Caddy container ID"

i=0
while [ "$i" -lt 24 ]; do
  INSPECT="$(run_root docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$CADDY_ID" 2>/dev/null || true)"
  STATE="${INSPECT%% *}"
  HEALTH="${INSPECT##* }"
  if [ "$STATE" = "running" ] && [ "$HEALTH" = "healthy" ]; then
    break
  fi
  if [ "$STATE" != "running" ] && [ "$STATE" != "created" ] && [ -n "$STATE" ]; then
    die "Caddy entered state $STATE after repair"
  fi
  i=$((i + 1))
  sleep 5
done

[ "$STATE" = "running" ] && [ "$HEALTH" = "healthy" ] || die "Caddy did not become healthy within 120 seconds"
pass "Caddy container is running and healthy"

LIVE_PORTS="$(run_root docker ps --filter label="$PROJECT_LABEL" --format '{{.Ports}}' 2>/dev/null || true)"
if printf '%s\n' "$LIVE_PORTS" | grep -Eq '0\.0\.0\.0:(80|443)|:::(80|443)'; then
  die "a public 80/443 binding was detected after repair"
fi
if ! printf '%s\n' "$LIVE_PORTS" | grep -q "$TAILSCALE_IP:443"; then
  die "expected tailnet-only 443 binding was not found after repair"
fi
pass "live stack still has no public 80/443 binding"

(
  cd "$APP_ROOT"
  "${DOCKER_CMD[@]}" compose "${COMPOSE_FILES[@]}" ps
)
info "REPAIR complete. Verify HTTPS health from another Tailscale device with: curl -fsS https://$CLINIC_DOMAIN/healthz"
