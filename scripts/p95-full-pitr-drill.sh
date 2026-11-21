#!/usr/bin/env bash
# Phase 9.5 end-to-end PITR drill using SYNTHETIC data only.
#
# 1. disposable PostgreSQL 16 with WAL archiving
# 2. repository Prisma migrations applied to the disposable source
# 3. synthetic transaction A committed, then a PITR base backup
# 4. synthetic transaction B committed after the base backup
# 5. synthetic sentinel C bounds the after-B recovery target
# 6. isolated PITR restore before B (A present, B absent)
# 7. isolated PITR restore after B (A and B present, C absent)
# 8. integrity + migration checks and timing report
#
# No production database, container, volume, backup, WAL archive or secret is
# accessed. Nothing is deployed and no application migration runs against
# anything except the disposable source cluster created here.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=p95-pitr-common.sh
. "${REPO}/scripts/p95-pitr-common.sh"
# shellcheck source=backup-common.sh
. "${REPO}/scripts/backup-common.sh"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/p95-full-drill.XXXXXX")" || exit 1
SOURCE_PGDATA=""
RESTORE_PGDATAS=()
SCHEMA_DIR=""
TEST_BAT_DIR=""

cleanup() {
  local d
  for d in "${RESTORE_PGDATAS[@]:-}"; do p95_stop_cluster "$d"; done
  p95_stop_cluster "$SOURCE_PGDATA"
  rm -rf -- "$TMP" "$SCHEMA_DIR" "$TEST_BAT_DIR" 2>/dev/null || true
}
trap cleanup EXIT

fail_drill() {
  printf 'PITR DRILL FAILURE: %s\n' "$*" >&2
  exit 1
}

if ! p95_ensure_tools; then
  echo "BLOCKED: isolated PostgreSQL 16/age toolchain unavailable." >&2
  exit 0
fi

umask 077
PGPORT="${P95_DRILL_PGPORT:-55436}"
PGHOST_TEST="127.0.0.1"
SOURCE_DB="clinic_pitr_source"
ARCHIVE="${TMP}/archive"
BACKUP_ROOT="${TMP}/backups"
SOURCE_PGDATA="${TMP}/source/data"
SOCKET_DIR="${TMP}/source/socket"
mkdir -p "$ARCHIVE" "${BACKUP_ROOT}/"{daily,weekly,monthly,wal-archive,manifests,quarantine,logs} \
  "$SOURCE_PGDATA" "$SOCKET_DIR" "${TMP}/keys" "${TMP}/logs"

echo "1. Starting disposable PostgreSQL cluster with WAL archiving on port ${PGPORT} ..."
age-keygen -o "${TMP}/keys/key.txt" 2>/dev/null || fail_drill "could not create synthetic age key."
RECIPIENT="$(sed -n 's/^# public key: //p' "${TMP}/keys/key.txt" | head -n 1)"
[ -n "$RECIPIENT" ] || fail_drill "could not read synthetic age recipient."

initdb -D "$SOURCE_PGDATA" -U clinic --auth=trust --no-instructions >/dev/null 2>&1 || \
  fail_drill "could not initialise disposable source cluster."
export WAL_ARCHIVE_DIR="$ARCHIVE"
export WAL_ARCHIVE_SKIP_MOUNT_CHECK=1
export WAL_SEGMENT_SIZE=16777216
ARCHIVE_CMD="sh ${REPO}/deploy/wal-archive.sh %p %f"
pg_ctl -D "$SOURCE_PGDATA" -l "${TMP}/logs/source-postgres.log" -w \
  -o "-p ${PGPORT} -k ${SOCKET_DIR} -h 127.0.0.1 -c wal_level=replica -c archive_mode=on -c archive_command='${ARCHIVE_CMD}' -c archive_timeout=2 -c max_wal_senders=10 -c wal_keep_size=128MB -c track_commit_timestamp=on" \
  start > "${TMP}/logs/source-pgctl.log" 2>&1 || {
  p95_log_tail "${TMP}/logs/source-postgres.log"
  fail_drill "could not start disposable source cluster."
}

adminpsql() {
  psql -h "$PGHOST_TEST" -p "$PGPORT" -U clinic -d postgres -v ON_ERROR_STOP=1 -Atq "$@"
}
srcpsql() {
  psql -h "$PGHOST_TEST" -p "$PGPORT" -U clinic -d "$SOURCE_DB" -v ON_ERROR_STOP=1 -Atq "$@"
}
commit_ts_of() {
  srcpsql -c "select to_char(pg_xact_commit_timestamp('$1'::xid) AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')"
}

adminpsql -c "CREATE DATABASE ${SOURCE_DB};" >/dev/null
srcpsql -c 'CREATE EXTENSION IF NOT EXISTS amcheck' >/dev/null || \
  fail_drill "could not install amcheck in the disposable source database."

# Windows paths are only needed for the optional application-level migration
# command; the database itself is local to this WSL session.
NODE_EXE="${P95_NODE_EXE:-/mnt/c/Program Files/nodejs/node.exe}"
CMD_EXE="${P95_CMD_EXE:-/mnt/c/Windows/System32/cmd.exe}"
WIN_USER="${WIN_USER:-$(basename "$HOME")}"
WIN_TEMP="C:/Users/$WIN_USER/AppData/Local/Temp/opencode"
WSL_TEMP="/mnt/c/Users/$WIN_USER/AppData/Local/Temp/opencode"
SCHEMA_DIR="$WSL_TEMP/p95-drill-schema-$$"
SCHEMA_DIR_WIN="$WIN_TEMP/p95-drill-schema-$$"
mkdir -p "$SCHEMA_DIR"
case "$REPO" in
  /mnt/?/*)
    drive="${REPO#/mnt/}"; drive="${drive%%/*}"
    drive_upper="$(printf '%s' "$drive" | tr '[:lower:]' '[:upper:]')"
    REPO_WIN="$(printf '%s' "$REPO" | sed "s#^/mnt/$drive/#$drive_upper:/#")"
    ;;
  *) REPO_WIN="$REPO" ;;
esac

echo "2. Applying repository Prisma migrations to the disposable source ..."
if [ -x "$NODE_EXE" ] && [ -f "$REPO/backend/node_modules/prisma/build/index.js" ]; then
  cp -R "$REPO/backend/prisma/." "$SCHEMA_DIR/"
  printf 'DATABASE_URL="postgresql://clinic:clinic@%s:%s/%s?schema=public"\n' \
    "$PGHOST_TEST" "$PGPORT" "$SOURCE_DB" > "$SCHEMA_DIR/.env"
  ( cd "$SCHEMA_DIR" && "$NODE_EXE" "$REPO_WIN/backend/node_modules/prisma/build/index.js" \
      migrate deploy --schema "$SCHEMA_DIR_WIN/schema.prisma" ) > "${TMP}/logs/migrate.log" 2>&1 || {
    tail -n 40 "${TMP}/logs/migrate.log" >&2
    fail_drill "repository migrations could not be applied to the disposable source."
  }
else
  fail_drill "node.exe/Prisma CLI unavailable; this drill requires repository migrations."
fi

echo "3. Committing synthetic transaction A before the base backup ..."
A_XMIN="$(srcpsql -c "INSERT INTO \"Patient\" (id,\"patientNumber\",\"firstName\",\"lastName\",\"updatedAt\")
VALUES ('aaaaaaaa-a0a0-4a0a-8a0a-a0a0a0a0a0a0','SYN-P-A','Synth','BeforeBackup','2026-11-21T00:00:00Z')
RETURNING xmin::text")"
A_TS="$(commit_ts_of "$A_XMIN")"
A_LSN="$(srcpsql -c 'select pg_current_wal_lsn()::text')"
A_WAL="$(srcpsql -c "select pg_walfile_name('${A_LSN}'::pg_lsn)")"
adminpsql -c 'select pg_switch_wal(); checkpoint;' >/dev/null
p95_wait_for_wal "$ARCHIVE" "$A_WAL" 30 || fail_drill "transaction A WAL was not archived."

echo "4. Creating verified, age-encrypted PITR base backup ..."
BASE_START_MS="$(p95_now_ms)"
env WAL_ARCHIVE_DIR="$ARCHIVE" WAL_ARCHIVE_SKIP_MOUNT_CHECK=1 \
  bash "${REPO}/scripts/pitr-base-backup.sh" \
    --pghost "$PGHOST_TEST" --pgport "$PGPORT" --pguser clinic --pgdatabase "$SOURCE_DB" \
    --wal-archive-dir "$ARCHIVE" --backup-root "$BACKUP_ROOT" --tier daily \
    --label drill --age-recipient "$RECIPIENT" --skip-mount-check \
    > "${TMP}/logs/base-backup.log" 2>&1 || {
  cat "${TMP}/logs/base-backup.log" >&2
  fail_drill "PITR base backup failed."
}
BASE_MS=$(( $(p95_now_ms) - BASE_START_MS ))
SET_DIR="$(find "${BACKUP_ROOT}/daily" -maxdepth 1 -mindepth 1 -type d -name '*-pitr-drill' | LC_ALL=C sort | tail -n 1)"
[ -n "$SET_DIR" ] || fail_drill "base backup set was not published."
BACKUP_ID="$(p95_manifest_get "${SET_DIR}/MANIFEST.txt" backup_id)"

echo "5. Committing synthetic transaction B after the base backup ..."
B_START_MS="$(p95_now_ms)"
B_XMIN="$(srcpsql -c "INSERT INTO \"Patient\" (id,\"patientNumber\",\"firstName\",\"lastName\",\"updatedAt\")
VALUES ('bbbbbbbb-b0b0-4b0b-8b0b-b0b0b0b0b0b0','SYN-P-B','Synth','AfterBackup','2026-11-21T00:00:00Z')
RETURNING xmin::text")"
B_TS="$(commit_ts_of "$B_XMIN")"
B_LSN="$(srcpsql -c 'select pg_current_wal_lsn()::text')"
B_WAL="$(srcpsql -c "select pg_walfile_name('${B_LSN}'::pg_lsn)")"
p95_wait_for_wal "$ARCHIVE" "$B_WAL" 30 || fail_drill "transaction B WAL was not archived."
ARCHIVE_DELAY_MS=$(( $(p95_now_ms) - B_START_MS ))

sleep 0.3
C_XMIN="$(srcpsql -c "INSERT INTO \"Patient\" (id,\"patientNumber\",\"firstName\",\"lastName\",\"updatedAt\")
VALUES ('cccccccc-c0c0-4c0c-8c0c-c0c0c0c0c0c0','SYN-P-C','Synth','Sentinel','2026-11-21T00:00:00Z')
RETURNING xmin::text")"
C_TS="$(commit_ts_of "$C_XMIN")"
C_LSN="$(srcpsql -c 'select pg_current_wal_lsn()::text')"
C_WAL="$(srcpsql -c "select pg_walfile_name('${C_LSN}'::pg_lsn)")"
adminpsql -c 'select pg_switch_wal(); checkpoint; select pg_switch_wal();' >/dev/null
THROUGH_WAL="$(adminpsql -c 'select pg_walfile_name(pg_current_wal_lsn())')"
for wal_file in $(backup_wal_range "$C_WAL" "$THROUGH_WAL"); do
  p95_wait_for_wal "$ARCHIVE" "$wal_file" 30 || fail_drill "post-B WAL '$wal_file' was not archived."
done

TARGET_BEFORE="$(adminpsql -c "select to_char(('${B_TS}'::timestamptz - interval '0.05 second') AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')")"
TARGET_AFTER="$(adminpsql -c "select to_char(('${B_TS}'::timestamptz + ('${C_TS}'::timestamptz - '${B_TS}'::timestamptz) / 2) AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')")"

patient_count() {
  local port="$1" marker="$2"
  psql -h 127.0.0.1 -p "$port" -U clinic -d "$SOURCE_DB" -Atq \
    -c "select count(*) from \"Patient\" where \"patientNumber\"='$marker'" 2>/dev/null
}

check_migrations() {
  local port="$1" total unfinished
  total="$(psql -h 127.0.0.1 -p "$port" -U clinic -d "$SOURCE_DB" -Atq \
    -c 'select count(*) from "_prisma_migrations";' 2>/dev/null)"
  unfinished="$(psql -h 127.0.0.1 -p "$port" -U clinic -d "$SOURCE_DB" -Atq \
    -c 'select count(*) from "_prisma_migrations" where finished_at is null or rolled_back_at is not null;' 2>/dev/null)"
  [ -n "$total" ] && [ "$total" -gt 0 ] && [ "$unfinished" = "0" ]
}

check_integrity() {
  local port="$1"
  if command -v pg_amcheck >/dev/null 2>&1; then
    pg_amcheck -h 127.0.0.1 -p "$port" -U clinic "$SOURCE_DB" > "${TMP}/logs/amcheck-${port}.log" 2>&1 || {
      tail -n 30 "${TMP}/logs/amcheck-${port}.log" >&2
      return 1
    }
  else
    [ "$(psql -h 127.0.0.1 -p "$port" -U clinic -d "$SOURCE_DB" -Atq \
      -c 'select count(*) from pg_class' 2>/dev/null)" -gt 0 ]
  fi
}

run_restore() {
  local target="$1" port="$2" target_time="$3" out="$4"
  RESTORE_PGDATAS+=("${target}/data")
  env WAL_ARCHIVE_DIR="$ARCHIVE" WAL_ARCHIVE_SKIP_MOUNT_CHECK=1 \
    bash "${REPO}/scripts/pitr-restore.sh" \
      --set "$SET_DIR" --target-time "$target_time" \
      --target-dir "$target" --confirm-target-dir "$target" \
      --pgport "$port" --pguser clinic --key-file "${TMP}/keys/key.txt" \
      --through-wal-file "$THROUGH_WAL" --skip-mount-check > "$out" 2>&1
}

echo "6. Restoring to a point before transaction B ..."
BEFORE_DIR="${TMP}/restore-before_restore"
BEFORE_MS_START="$(p95_now_ms)"
if ! run_restore "$BEFORE_DIR" 55437 "$TARGET_BEFORE" "${TMP}/logs/restore-before.log"; then
  tail -n 60 "${TMP}/logs/restore-before.log" >&2
  fail_drill "PITR restore before B failed."
fi
RESTORE_BEFORE_MS=$(( $(p95_now_ms) - BEFORE_MS_START ))
A_BEFORE="$(patient_count 55437 SYN-P-A)"
B_BEFORE="$(patient_count 55437 SYN-P-B)"
C_BEFORE="$(patient_count 55437 SYN-P-C)"
[ "$A_BEFORE" = "1" ] && [ "$B_BEFORE" = "0" ] && [ "$C_BEFORE" = "0" ] || \
  fail_drill "before-B target has wrong rows: A=$A_BEFORE B=$B_BEFORE sentinel=$C_BEFORE"
check_migrations 55437 || fail_drill "before-B target migration state is invalid."
check_integrity 55437 || fail_drill "before-B target integrity check failed."
echo "   A=$A_BEFORE B=$B_BEFORE sentinel=$C_BEFORE; migrations and integrity OK"

echo "7. Restoring to a point after transaction B ..."
p95_stop_cluster "${BEFORE_DIR}/data"
AFTER_DIR="${TMP}/restore-after_restore"
AFTER_MS_START="$(p95_now_ms)"
if ! run_restore "$AFTER_DIR" 55438 "$TARGET_AFTER" "${TMP}/logs/restore-after.log"; then
  tail -n 60 "${TMP}/logs/restore-after.log" >&2
  fail_drill "PITR restore after B failed."
fi
RESTORE_AFTER_MS=$(( $(p95_now_ms) - AFTER_MS_START ))
A_AFTER="$(patient_count 55438 SYN-P-A)"
B_AFTER="$(patient_count 55438 SYN-P-B)"
C_AFTER="$(patient_count 55438 SYN-P-C)"
[ "$A_AFTER" = "1" ] && [ "$B_AFTER" = "1" ] && [ "$C_AFTER" = "0" ] || \
  fail_drill "after-B target has wrong rows: A=$A_AFTER B=$B_AFTER sentinel=$C_AFTER"
check_migrations 55438 || fail_drill "after-B target migration state is invalid."
check_integrity 55438 || fail_drill "after-B target integrity check failed."
echo "   A=$A_AFTER B=$B_AFTER sentinel=$C_AFTER; migrations and integrity OK"

SOURCE_A="$(patient_count "$PGPORT" SYN-P-A)"
SOURCE_B="$(patient_count "$PGPORT" SYN-P-B)"
SOURCE_C="$(patient_count "$PGPORT" SYN-P-C)"
[ "$SOURCE_A" = "1" ] && [ "$SOURCE_B" = "1" ] && [ "$SOURCE_C" = "1" ] || \
  fail_drill "source synthetic rows changed during drill."

printf '\nP95 FULL PITR DRILL RESULTS\n'
printf '  backup_id: %s\n' "$BACKUP_ID"
printf '  pg_version: %s\n' "$(p95_manifest_get "${SET_DIR}/MANIFEST.txt" pg_version)"
printf '  wal_archive_dir: %s\n' "$ARCHIVE"
printf '  transaction_A_commit: %s lsn=%s wal=%s\n' "$A_TS" "$A_LSN" "$A_WAL"
printf '  transaction_B_commit: %s lsn=%s wal=%s\n' "$B_TS" "$B_LSN" "$B_WAL"
printf '  sentinel_C_commit: %s wal=%s\n' "$C_TS" "$C_WAL"
printf '  target_before_B: %s\n' "$TARGET_BEFORE"
printf '  target_after_B: %s\n' "$TARGET_AFTER"
printf '  backup_duration_ms: %s\n' "$BASE_MS"
printf '  archive_delay_ms_for_B: %s\n' "$ARCHIVE_DELAY_MS"
printf '  restore_before_duration_ms: %s\n' "$RESTORE_BEFORE_MS"
printf '  restore_after_duration_ms: %s\n' "$RESTORE_AFTER_MS"
printf '  before_B_rows: A=%s B=%s sentinel=%s\n' "$A_BEFORE" "$B_BEFORE" "$C_BEFORE"
printf '  after_B_rows:  A=%s B=%s sentinel=%s\n' "$A_AFTER" "$B_AFTER" "$C_AFTER"
printf '  source_rows_after_drill: A=%s B=%s sentinel=%s\n' "$SOURCE_A" "$SOURCE_B" "$SOURCE_C"
printf '  integrity: pg_amcheck/basic catalog check passed on both restored instances\n'
printf '  migrations: applied rows > 0 and no unfinished/rolled-back rows on both targets\n'
printf '  result: PASS\n'
