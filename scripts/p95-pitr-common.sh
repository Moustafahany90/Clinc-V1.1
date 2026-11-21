#!/usr/bin/env bash
# Shared helpers for the isolated Phase 9.5 PITR test harnesses.
# Test-only: no production paths, containers, databases, backups or secrets.
# Sourced by scripts/p95-pitr-test.sh and scripts/p95-full-pitr-drill.sh.

p95_needs() {
  for tool in "$@"; do
    command -v "$tool" >/dev/null 2>&1 || return 1
  done
  return 0
}

p95_ensure_tools() {
  local root="${P95_TOOLS_ROOT:-${P94_TOOLS_ROOT:-$HOME/.local/p94-tools/root}}"
  if [ -n "$root" ] && [ -d "$root/usr/bin" ]; then
    export PATH="$root/usr/lib/postgresql/16/bin:$root/usr/bin:$PATH"
    export LD_LIBRARY_PATH="$root/usr/lib/x86_64-linux-gnu:$root/usr/lib/postgresql/16/lib:${LD_LIBRARY_PATH:-}"
  fi
  if p95_needs age age-keygen initdb psql pg_basebackup pg_ctl tar sha256sum; then
    return 0
  fi
  if [ "${P95_PROVISION_TOOLS:-1}" != "1" ] || ! command -v apt-get >/dev/null 2>&1; then
    return 1
  fi
  echo "Provisioning isolated test-only PostgreSQL 16/age binaries under ${root} ..."
  local debroot
  debroot="$(dirname "$root")/debs"
  mkdir -p "$debroot" "$root"
  ( cd "$debroot" && apt-get download -y postgresql-16 postgresql-client-16 libpq5 age >/dev/null 2>&1 ) || return 1
  for deb in "$debroot"/*.deb; do
    dpkg-deb -x "$deb" "$root" >/dev/null 2>&1 || return 1
  done
  export PATH="$root/usr/lib/postgresql/16/bin:$root/usr/bin:$PATH"
  export LD_LIBRARY_PATH="$root/usr/lib/x86_64-linux-gnu:$root/usr/lib/postgresql/16/lib:${LD_LIBRARY_PATH:-}"
  p95_needs age age-keygen initdb psql pg_basebackup pg_ctl tar sha256sum
}

p95_now_ms() {
  date +%s%3N 2>/dev/null || printf '%s' "$(( $(date -u +%s) * 1000 ))"
}

p95_manifest_get() {
  sed -n "s/^$2=//p" "$1" | head -n 1 | tr -d '\r'
}

p95_wait_for_wal() {
  local archive="$1" file="$2" timeout="${3:-30}" start
  start="$(date -u +%s)"
  while :; do
    if [ -f "${archive}/${file}" ] && [ -f "${archive}/${file}.sha256" ]; then
      return 0
    fi
    [ "$(( $(date -u +%s) - start ))" -lt "$timeout" ] || return 1
    sleep 0.2
  done
}

p95_stop_cluster() {
  local datadir="$1"
  [ -n "$datadir" ] || return 0
  command -v pg_ctl >/dev/null 2>&1 || return 0
  pg_ctl -D "$datadir" stop -m fast >/dev/null 2>&1 || true
}

p95_log_tail() {
  local logfile="$1" lines="${2:-50}"
  [ -f "$logfile" ] && tail -n "$lines" "$logfile" >&2 || true
}
