#!/usr/bin/env bash
# Deploy Clinic-V1.1 from GitHub main, pinned to an exact commit.
#
# Repository-only artifact. It performs no production change unless BOTH
# --apply and --confirm DEPLOY are supplied. The default mode is a read-only
# preflight plus a temporary validation clone.
#
# Never deploys from a desktop checkout and never prints .env values.
set -Eeuo pipefail

REPO_URL="https://github.com/Moustafahany90/Clinc-V1.1.git"
APP_ROOT="/opt/clinic"
ENV_FILE="/etc/clinic/clinic.env"
COMPOSE_FILES=(-f docker-compose.yml -f docker-compose.tailscale.yml)

COMMIT=""
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
  bash scripts/deploy-github-main.sh --commit <40-hex-sha> [options]

Options:
  --commit <sha>       Exact main-branch commit to deploy (required).
  --env-file <path>    Protected env source outside Git.
                       Default: /etc/clinic/clinic.env
  --apply              Actually install and start the stack. Without this flag
                       the script only performs preflight and validation.
  --confirm DEPLOY     Required together with --apply.
  -h, --help           Show this help.

The exact commit must equal the current GitHub main tip. The script clones only
from https://github.com/Moustafahany90/Clinc-V1.1.git. It refuses to proceed if
Clinic containers or project-managed volumes already exist. The legacy volume
clinc_postgres_data is reported and preserved, never deleted or reused.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --commit)
      [ "$#" -ge 2 ] || die "--commit requires a value"
      COMMIT="${2,,}"
      shift 2
      ;;
    --commit=*)
      COMMIT="${1#*=}"
      COMMIT="${COMMIT,,}"
      shift
      ;;
    --env-file)
      [ "$#" -ge 2 ] || die "--env-file requires a path"
      ENV_FILE="$2"
      shift 2
      ;;
    --env-file=*)
      ENV_FILE="${1#*=}"
      shift
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
    --confirm=*)
      CONFIRM="${1#*=}"
      shift
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

[[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || die "--commit must be a 40-character lowercase hex SHA"
[[ "$ENV_FILE" == /* ]] || die "--env-file must be an absolute path"
if [ "$APPLY" -eq 1 ]; then
  [ "$CONFIRM" = "DEPLOY" ] || die "--apply requires --confirm DEPLOY"
else
  info "DRY RUN: --apply was not supplied; no production change will be made"
fi

for tool in git python3 ss; do
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
pass "GitHub main tip matches the pinned commit"

# --- Tailnet bind address ---------------------------------------------------
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
' "$TAILSCALE_IP" || die "tailnet address $TAILSCALE_IP is not an IPv4 CGNAT address"
pass "tailnet bind address detected: $TAILSCALE_IP"

# --- Target-host preflight --------------------------------------------------
CONTAINERS="$(run_root docker ps -a --format '{{.Names}}' 2>/dev/null || true)"
CLINIC_CONTAINERS="$(printf '%s\n' "$CONTAINERS" | grep -Ei 'clinic|ultrasound' || true)"
[ -z "$CLINIC_CONTAINERS" ] || die "existing Clinic container(s) found; refusing to proceed"
pass "no existing Clinic containers"

VOLUMES="$(run_root docker volume ls --format '{{.Name}}' 2>/dev/null || true)"
while IFS= read -r volume; do
  [ -n "$volume" ] || continue
  case "$volume" in
    clinc_postgres_data)
      warn "legacy volume clinc_postgres_data exists; it will be preserved untouched"
      ;;
    ultrasound_clinic_*|clinic_*|*clinic*|*ultrasound*)
      die "existing project-managed volume $volume found; refusing to proceed"
      ;;
    *)
      ;;
  esac
done <<<"$VOLUMES"
pass "no project-managed Clinic volumes"

LISTENING="$(ss -ltnH 2>/dev/null | awk '{print $4}' || true)"
if printf '%s\n' "$LISTENING" | grep -Eq ':80$|:443$|:55432$|:8080$'; then
  die "a conflicting application port is already listening (80, 443, 55432, or 8080)"
fi
pass "no conflicting published application port"

run_root test -r "$ENV_FILE" || die "protected env source is missing or unreadable: $ENV_FILE"
pass "protected env source is readable (values not displayed)"

# --- GitHub-only validation clone ------------------------------------------
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/clinic-deploy.XXXXXX")" || die "could not create temporary validation directory"
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
  [ -f "$dir/docker-compose.tailscale.yml" ] || die "docker-compose.tailscale.yml missing from pinned commit"
  [ -f "$dir/deploy/Caddyfile.tailscale" ] || die "deploy/Caddyfile.tailscale missing from pinned commit"
  grep -q 'auto_https off' "$dir/deploy/Caddyfile.tailscale" || die "Tailscale Caddyfile does not disable automatic HTTPS"
  grep -q 'https://{$CLINIC_DOMAIN}' "$dir/deploy/Caddyfile.tailscale" || die "Tailscale Caddyfile has no HTTPS site block"
  if grep -Eq '^[[:space:]]*http://' "$dir/deploy/Caddyfile.tailscale"; then
    die "Tailscale Caddyfile contains an HTTP site block"
  fi
  if grep -Eq '^[[:space:]]*redir' "$dir/deploy/Caddyfile.tailscale"; then
    die "Tailscale Caddyfile contains an unexpected redirect"
  fi
  if grep -q 'tls internal' "$dir/deploy/Caddyfile.tailscale"; then
    die "Tailscale Caddyfile uses the wrong TLS mode"
  fi
  pass "Tailscale ingress files fail closed (no HTTP listener, no ACME)"
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
print("PASS  rendered Compose publishes only caddy 443 on " + str(tail) + " plus loopback db/web")
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

if [ "$APPLY" -ne 1 ]; then
  info "DRY RUN complete: no /opt/clinic change, no container, volume, network, DNS, TLS or firewall change"
  exit 0
fi

# --- Gated installation -----------------------------------------------------
run_root install -d -o root -g root -m 0755 "$APP_ROOT"

if run_root test -e "$APP_ROOT/.git"; then
  REMOTE="$(run_root git -C "$APP_ROOT" remote get-url origin 2>/dev/null || true)"
  [ "$REMOTE" = "$REPO_URL" ] || die "existing checkout remote is not the approved GitHub repository"
  DIRTY="$(run_root git -C "$APP_ROOT" status --porcelain 2>/dev/null || true)"
  [ -z "$DIRTY" ] || die "existing checkout is not clean; refusing to overwrite local changes"
  run_root git -C "$APP_ROOT" fetch -q --no-tags origin "$COMMIT"
  if [ "$(run_root git -C "$APP_ROOT" rev-parse HEAD)" != "$COMMIT" ]; then
    run_root git -C "$APP_ROOT" checkout -q --detach "$COMMIT"
  fi
else
  EXISTING="$(run_root find "$APP_ROOT" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null || true)"
  [ -z "$EXISTING" ] || die "$APP_ROOT is non-empty but is not the approved Git checkout"
  run_root git init -q -b main "$APP_ROOT"
  run_root git -C "$APP_ROOT" remote add origin "$REPO_URL"
  run_root git -C "$APP_ROOT" fetch -q --no-tags --depth 1 origin "$COMMIT"
  run_root git -C "$APP_ROOT" checkout -q --detach FETCH_HEAD
fi

[ "$(run_root git -C "$APP_ROOT" rev-parse HEAD)" = "$COMMIT" ] || die "installed checkout HEAD does not match pinned commit"
[ -z "$(run_root git -C "$APP_ROOT" status --porcelain)" ] || die "installed checkout is not clean"
pass "installed checkout is clean and pinned to $COMMIT"

if run_root test -e "$APP_ROOT/.env"; then
  if ! run_root cmp -s "$ENV_FILE" "$APP_ROOT/.env"; then
    die "existing $APP_ROOT/.env differs from $ENV_FILE; refusing to overwrite protected config"
  fi
  pass "existing .env matches approved source (values not displayed)"
else
  run_root install -m 0600 "$ENV_FILE" "$APP_ROOT/.env"
  pass "installed .env with mode 0600 (values not displayed)"
fi

validate_compose "$APP_ROOT"

(
  cd "$APP_ROOT"
  "${DOCKER_CMD[@]}" compose "${COMPOSE_FILES[@]}" up -d --build --remove-orphans
) || die "Compose up failed"
pass "Compose stack requested from $APP_ROOT"

LIVE_PORTS="$(run_root docker ps --filter label=com.docker.compose.project=ultrasound-clinic --format '{{.Ports}}' 2>/dev/null || true)"
if printf '%s\n' "$LIVE_PORTS" | grep -Eq '0\.0\.0\.0:(80|443)|:::(80|443)'; then
  die "a public 80/443 binding was detected after startup"
fi
if ! printf '%s\n' "$LIVE_PORTS" | grep -q "$TAILSCALE_IP:443"; then
  die "expected tailnet-only 443 binding was not found after startup"
fi
pass "live stack has no public 80/443 binding"

(
  cd "$APP_ROOT"
  "${DOCKER_CMD[@]}" compose "${COMPOSE_FILES[@]}" ps
)
info "APPLY complete. Record commit, host output, and owner approval in the change log."
