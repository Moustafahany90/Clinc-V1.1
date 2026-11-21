#!/usr/bin/env bash
# Phase 9.7 read-only repository readiness preflight.
#
# Safety: this script ONLY reads files and prints findings. It never creates,
# deletes, moves, modifies, mounts, starts, stops, deploys, or queries anything.
# It does not access Production, credentials, patient data, or a database.
# It fails closed: any failed repository invariant exits 1.
#
# It validates repository state only. A PASS here is NOT Production readiness.
set -uo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
FAILURES=0

pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
info() { printf 'INFO  %s\n' "$1"; }
require_file() {
  if [ -f "$ROOT/$1" ] && [ -r "$ROOT/$1" ]; then
    pass "present/readable: $1"
  else
    fail "missing or unreadable: $1"
  fi
}
require_text() {
  local needle="$1" file="$2" label="$3"
  if grep -qF -- "$needle" "$ROOT/$file" 2>/dev/null; then
    pass "$label"
  else
    fail "$label"
  fi
}

# Needles are assembled at runtime so this script does not itself contain the
# forbidden strings as a copy-pasteable literal.
UNSAFE_LEDGER_NEEDLE="DELETE FROM \"_prisma_mig""rations\""
LEGACY_ROOT_NEEDLE="/opt/clinic/Clinc-V1"".1"

check_unsafe_ledger_guidance() {
  local hits hit file rest line context allowed
  hits="$(grep -R -n -F -e "$UNSAFE_LEDGER_NEEDLE" \
    --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.next \
    "$ROOT" 2>/dev/null || true)"
  if [ -z "$hits" ]; then
    pass 'no copy-pasteable direct migration-ledger deletion remains in tracked files'
    return 0
  fi
  while IFS= read -r hit; do
    [ -n "$hit" ] || continue
    file="${hit%%:*}"
    rest="${hit#*:}"
    line="${rest%%:*}"
    rel_file="${file#${ROOT}/}"
    allowed=0
    # Historical reports may quote the unsafe command only inside a section
    # explicitly marked UNSAFE / SUPERSEDED. Live runbooks and rollback files
    # are never exempt.
    case "$rel_file" in
      docs/PRODUCTION_READINESS_PHASE_M.md|docs/PRODUCTION_READINESS_PHASE9_7.md)
        context="$(sed -n "$((line > 12 ? line - 12 : 1)),${line}p" "$file" 2>/dev/null)"
        if printf '%s\n' "$context" | grep -qiE 'UNSAFE|SUPERSEDED|Never edit'; then
          allowed=1
        fi
        ;;
    esac
    if [ "$allowed" -eq 1 ]; then
      info "historical unsafe quote is explicitly marked (line ${line}): $rel_file"
    else
      fail "unsafe migration-ledger guidance at ${rel_file}:${line}"
    fi
  done <<<"$hits"
}

check_single_application_root() {
  local f found=0 hits
  # Historical Phase 8/9 readiness reports are deliberately not rewritten;
  # this invariant covers live units, scripts, compose files and runbooks.
  info 'legacy nested application-root path is checked in active config/docs only'
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    hits="$(grep -n -F "$LEGACY_ROOT_NEEDLE" "$ROOT/$f" 2>/dev/null || true)"
    [ -n "$hits" ] || continue
    found=1
    fail "legacy application root still referenced in $f"
  done < <(cd "$ROOT" && git ls-files -- \
    'deploy/*' 'scripts/*' 'docker-compose*.yml' \
    'docs/PRODUCTION_DEPLOYMENT_RUNBOOK.md' \
    'docs/PRODUCTION_ROLLBACK_RUNBOOK.md' \
    'docs/PRODUCTION_BLOCKER_REGISTER.md' \
    'docs/backup-restore.md' 'docs/monitoring-runbook.md' \
    'docs/PRODUCTION_READINESS_PHASE9_8.md')
  [ "$found" -eq 0 ] && pass 'all active units/scripts/docs use the single /opt/clinic application root'
}

printf 'Phase 9.7/9.8 read-only repository preflight\n'
printf 'Repository: %s\n' "$ROOT"
if [ -d "$ROOT/.git" ]; then
  pass 'repository .git directory present'
  info "branch: $(git -C "$ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || printf 'unknown')"
  info "HEAD:   $(git -C "$ROOT" rev-parse HEAD 2>/dev/null || printf 'unknown')"
else
  fail 'repository .git directory missing'
fi

# --- Migration inventory (exact nine, in order) ------------------------------
MIGRATIONS="
20261026085618_init
20261029120000_add_token_blacklist
20261030120000_report_template_pinning
20261031120000_token_version_and_override_permissions
20261101120000_report_whatsapp_delivery
20261102120000_patient_referring_doctor
20261113135000_remove_email_delivery
20261120222405_db_integrity_constraints
20261121220000_phase91_performance_indexes
"
mcount=0
for m in $MIGRATIONS; do
  require_file "backend/prisma/migrations/$m/migration.sql"
  mcount=$((mcount + 1))
done
actual="$(find "$ROOT/backend/prisma/migrations" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')"
if [ "$actual" = "$mcount" ]; then
  pass "migration directory count = $actual (expected $mcount)"
else
  fail "migration directory count = $actual (expected $mcount)"
fi
require_file 'backend/prisma/migrations/migration_lock.toml'
require_file 'backend/prisma/migrations/20261120222405_db_integrity_constraints/rollback.sql'

# --- Required implementation files ------------------------------------------
for f in \
  docker-compose.yml docker-compose.tls.yml docker-compose.pitr.yml \
  docker-compose.limits.yml docker-compose.monitoring.yml \
  deploy/Caddyfile deploy/wal-archive.sh deploy/wal-restore.sh \
  deploy/clinic-backup-schedule@.service \
  deploy/clinic-backup-full.timer deploy/clinic-backup-pitr-base.timer \
  deploy/clinic-backup-verify.timer deploy/clinic-backup-retention.timer \
  deploy/clinic-wal-prune.timer \
  deploy/clinic-backup-alert@.service \
  scripts/backup.sh scripts/backup-common.sh scripts/backup-verify.sh \
  scripts/backup-retention.sh scripts/backup-scheduler.sh \
  scripts/verify-pitr-base.sh scripts/pitr-base-backup.sh scripts/pitr-restore.sh \
  scripts/p7-check-pitr.sh scripts/p7-check-wal.sh scripts/p7-monitor.sh \
  scripts/p7-check-cert.sh scripts/p7-check-time.sh scripts/p7-check-containers.sh \
  scripts/p98-backup-isolated-test.sh scripts/p98-monitor-isolated-test.sh \
  deploy/backup.env.example deploy/monitor.env.example \
  docs/backup-restore.md docs/monitoring-runbook.md \
  docs/PRODUCTION_READINESS_PHASE9_6.md; do
  require_file "$f"
done

# --- WAL overlay fail-closed invariants --------------------------------------
if grep -qF 'archive_command=/bin/sh /clinic/deploy/wal-archive.sh %p %f' \
    "$ROOT/docker-compose.pitr.yml" 2>/dev/null; then
  pass 'PITR overlay uses the corrected /clinic/deploy archive command path'
else
  fail 'PITR overlay archive command path is missing or regressed'
fi
if grep -qF './deploy:/clinic/deploy:ro' "$ROOT/docker-compose.pitr.yml" 2>/dev/null; then
  pass 'PITR overlay mounts deploy/ read-only for the archiver'
else
  fail 'PITR overlay does not mount deploy/ read-only'
fi
if grep -qE 'WAL_ARCHIVE_EXPECTED_UUID:[[:space:]]*"?[0-9a-fA-F]{8}-' \
    "$ROOT/docker-compose.pitr.yml" 2>/dev/null; then
  fail 'PITR overlay hardcodes a filesystem UUID; use a placeholder and target-host verification'
else
  pass 'PITR overlay does not hardcode a filesystem UUID'
fi
if grep -qE 'WAL_ARCHIVE_SKIP_MOUNT_CHECK:[[:space:]]*"1"' \
    "$ROOT/docker-compose.pitr.yml" 2>/dev/null; then
  fail 'PITR overlay disables the mount check; this must never be a production setting'
else
  pass 'PITR overlay keeps the WAL mount check enabled'
fi

# --- Retention / WAL pruning must remain dry-run by default ------------------
for u in clinic-backup-retention.timer clinic-wal-prune.timer; do
  # Comments in these timers document the manual mutation command; only an
  # actual ExecStart line invoking it would break the dry-run guarantee.
  if grep -E '^[[:space:]]*ExecStart=' "$ROOT/deploy/$u" 2>/dev/null | grep -qE -- '--apply|--confirm[[:space:]]+DELETE'; then
    fail "$u invokes mutation flags directly; timers must use dry-run defaults"
  else
    pass "$u ExecStart does not invoke --apply / --confirm DELETE"
  fi
done
if grep -qF 'ExecStart=/bin/bash /opt/clinic/scripts/backup-scheduler.sh %i' \
    "$ROOT/deploy/clinic-backup-schedule@.service" 2>/dev/null; then
  pass 'dispatcher service invokes the scheduler with a job placeholder only'
else
  fail 'dispatcher service ExecStart regressed or is missing'
fi
if grep -qF 'OnFailure=clinic-backup-alert@%i.service' \
    "$ROOT/deploy/clinic-backup-schedule@.service" 2>/dev/null; then
  pass 'dispatcher service has a visible OnFailure notification target'
else
  fail 'dispatcher service has no OnFailure notification target'
fi
if grep -q '^\[Install\]' "$ROOT/deploy/clinic-backup-schedule@.service" 2>/dev/null; then
  pass 'dispatcher service declares an [Install] section'
else
  fail 'dispatcher service has no [Install] section'
fi
if grep -R -q -E '^[[:space:]]*SCHED_SKIP_MOUNT_CHECK=1([[:space:]]|$)' \
    "$ROOT/deploy" "$ROOT"/docker-compose*.yml 2>/dev/null; then
  fail 'SCHED_SKIP_MOUNT_CHECK=1 must never appear in shipped configuration'
else
  pass 'shipped configuration never enables the test-only mount-check bypass'
fi
for s in scripts/backup-scheduler.sh scripts/backup-retention.sh; do
  if grep -qE -- '--apply|--confirm DELETE' "$ROOT/$s" 2>/dev/null; then
    pass "$s contains explicit mutation gates (review required before use)"
  else
    fail "$s has no visible mutation gates"
  fi
done

# --- Phase 9.8 monitoring invariants (PB-26 and PB-29) -----------------------
require_text 'Group=clinc_server' \
  'deploy/clinic-monitor.service' \
  'PB-26: monitor unit uses the clinc_server primary group'
require_text 'UMask=0007' \
  'deploy/clinic-monitor.service' \
  'PB-26: monitor unit creates group-readable state'
require_text 'User=clinc_server' \
  'deploy/clinic-heartbeat-check.service' \
  'PB-26: heartbeat check runs as clinc_server'
require_text '0750 root:clinc_server' \
  'deploy/monitor.env.example' \
  'PB-26: monitor env template documents the 0750 state directory'

require_text 'P7_CERT_FILES' \
  'deploy/monitor.env.example' \
  'PB-29: monitor env template declares P7_CERT_FILES'
require_text 'P7_CERT_ENDPOINTS' \
  'deploy/monitor.env.example' \
  'PB-29: monitor env template declares P7_CERT_ENDPOINTS'
require_text 'P7_CERT_ENDPOINT_TIMEOUT_SEC' \
  'deploy/monitor.env.example' \
  'PB-29: monitor env template declares a bounded endpoint timeout'
require_text 'P7_CERT_ENDPOINTS' \
  'docker-compose.monitoring.yml' \
  'PB-29: monitoring compose overlay declares P7_CERT_ENDPOINTS'
require_text 'P7_CERT_WARN_DAYS' \
  'docker-compose.monitoring.yml' \
  'PB-29: monitoring compose overlay declares certificate thresholds'
require_text 'openssl s_client' \
  'scripts/p7-check-cert.sh' \
  'PB-29: certificate check supports explicit TLS endpoint mode'
require_text 'ntp_available' \
  'scripts/p7-check-time.sh' \
  'PB-29: time check tracks whether NTP is verifiable'
require_text 'docker ps failed' \
  'scripts/p7-check-containers.sh' \
  'PB-29: container check fails closed on docker errors'
require_text 'p7-window-count' \
  'scripts/p7-monitor.sh' \
  'PB-29: monitor uses a global per-window alert counter'

# --- No target-host installation is assumed ---------------------------------
installed=0
for d in /etc/systemd/system /etc/systemd/system/timers.target.wants; do
  for u in clinic-backup-full.timer clinic-backup-pitr-base.timer \
           clinic-backup-verify.timer clinic-backup-retention.timer \
           clinic-wal-prune.timer clinic-monitor.timer clinic-heartbeat-check.timer; do
    [ -e "$d/$u" ] && installed=$((installed + 1))
  done
done
if [ "$installed" -eq 0 ]; then
  pass 'no Clinic timer units found installed on this host'
else
  fail "found $installed installed Clinic timer unit(s); this preflight must not assume a clean host"
fi

# --- Phase 9.8 documentation/path invariants --------------------------------
check_unsafe_ledger_guidance
check_single_application_root

if [ "$FAILURES" -eq 0 ]; then
  printf 'RESULT  PASS (repository invariants only; NOT Production readiness)\n'
  exit 0
fi
printf 'RESULT  FAIL (%d failed invariant(s))\n' "$FAILURES"
exit 1
