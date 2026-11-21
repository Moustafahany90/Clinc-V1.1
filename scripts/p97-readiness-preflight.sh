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

printf 'Phase 9.7 read-only repository preflight\n'
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
  scripts/backup.sh scripts/backup-common.sh scripts/backup-verify.sh \
  scripts/backup-retention.sh scripts/backup-scheduler.sh \
  scripts/pitr-base-backup.sh scripts/pitr-restore.sh \
  scripts/p7-check-pitr.sh scripts/p7-check-wal.sh scripts/p7-monitor.sh \
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
for s in scripts/backup-scheduler.sh scripts/backup-retention.sh; do
  if grep -qE -- '--apply|--confirm DELETE' "$ROOT/$s" 2>/dev/null; then
    pass "$s contains explicit mutation gates (review required before use)"
  else
    fail "$s has no visible mutation gates"
  fi
done

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

if [ "$FAILURES" -eq 0 ]; then
  printf 'RESULT  PASS (repository invariants only; NOT Production readiness)\n'
  exit 0
fi
printf 'RESULT  FAIL (%d failed invariant(s))\n' "$FAILURES"
exit 1
