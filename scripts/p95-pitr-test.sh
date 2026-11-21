#!/usr/bin/env bash
# Phase 9.5 automated PITR tests. Isolated synthetic PostgreSQL only.
#
# No production database, container, volume, backup, WAL archive or secret is
# accessed. Every cluster is created with initdb under a temporary directory.
set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=p95-pitr-common.sh
. "${REPO}/scripts/p95-pitr-common.sh"
# shellcheck source=backup-common.sh
. "${REPO}/scripts/backup-common.sh"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/p95-pitr-tests.XXXXXX")" || exit 1
TESTS=0; PASSED=0; FAILED=0; BLOCKED=0
SOURCE_PGDATA=""
RESTORE_PGDATAS=()

pass()   { TESTS=$((TESTS + 1)); PASSED=$((PASSED + 1)); printf 'PASS  %s\n' "$1"; }
fail()   { TESTS=$((TESTS + 1)); FAILED=$((FAILED + 1)); printf 'FAIL  %s\n' "$1" >&2; }
blocked(){ TESTS=$((TESTS + 1)); BLOCKED=$((BLOCKED + 1)); printf 'BLOCKED  %s\n' "$1"; }

summary() {
  printf '\np95-pitr: %d passed, %d failed, %d blocked, %d total\n' \
    "$PASSED" "$FAILED" "$BLOCKED" "$TESTS"
}

cleanup() {
  local d
  for d in "${RESTORE_PGDATAS[@]:-}"; do p95_stop_cluster "$d"; done
  p95_stop_cluster "$SOURCE_PGDATA"
  rm -rf -- "$TMP"
}
trap cleanup EXIT

setup_fail() {
  printf 'SETUP FAILURE: %s\n' "$*" >&2
  summary
  exit 1
}

if ! p95_ensure_tools; then
  blocked "isolated PostgreSQL 16/age toolchain"
  summary
  exit 0
fi

umask 077
PGPORT="${P95_SOURCE_PGPORT:-55436}"
PGHOST_TEST="127.0.0.1"
TEST_DB="pitr_source_test"
ARCHIVE="${TMP}/archive"
BACKUP_ROOT="${TMP}/backups"
SOURCE_PGDATA="${TMP}/source/data"
SOCKET_DIR="${TMP}/source/socket"
mkdir -p "$ARCHIVE" "${BACKUP_ROOT}/"{daily,weekly,monthly,wal-archive,manifests,quarantine,logs} \
  "$SOURCE_PGDATA" "$SOCKET_DIR" "${TMP}/keys" "${TMP}/logs"

age-keygen -o "${TMP}/keys/key.txt" 2>/dev/null || setup_fail "could not create synthetic age key."
RECIPIENT="$(sed -n 's/^# public key: //p' "${TMP}/keys/key.txt" | head -n 1)"
[ -n "$RECIPIENT" ] || setup_fail "could not read synthetic age recipient."

initdb -D "$SOURCE_PGDATA" -U clinic --auth=trust --no-instructions >/dev/null 2>&1 || \
  setup_fail "could not initialise isolated source cluster."

export WAL_ARCHIVE_DIR="$ARCHIVE"
export WAL_ARCHIVE_SKIP_MOUNT_CHECK=1
export WAL_SEGMENT_SIZE=16777216
ARCHIVE_CMD="sh ${REPO}/deploy/wal-archive.sh %p %f"
pg_ctl -D "$SOURCE_PGDATA" -l "${TMP}/logs/source-postgres.log" -w \
  -o "-p ${PGPORT} -k ${SOCKET_DIR} -h 127.0.0.1 -c wal_level=replica -c archive_mode=on -c archive_command='${ARCHIVE_CMD}' -c archive_timeout=2 -c max_wal_senders=10 -c wal_keep_size=128MB -c track_commit_timestamp=on" \
  start > "${TMP}/logs/source-pgctl.log" 2>&1 || {
  p95_log_tail "${TMP}/logs/source-postgres.log"
  setup_fail "could not start isolated source cluster with WAL archiving."
}

adminpsql() {
  psql -h "$PGHOST_TEST" -p "$PGPORT" -U clinic -d postgres -v ON_ERROR_STOP=1 -Atq "$@"
}
srcpsql() {
  psql -h "$PGHOST_TEST" -p "$PGPORT" -U clinic -d "$TEST_DB" -v ON_ERROR_STOP=1 -Atq "$@"
}

adminpsql -c "CREATE DATABASE ${TEST_DB};" >/dev/null || setup_fail "could not create synthetic source database."
srcpsql <<'SQL' >/dev/null || setup_fail "could not create synthetic tables."
CREATE TABLE pitr_events (
  id serial PRIMARY KEY,
  marker text NOT NULL,
  note text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE "_prisma_migrations" (
  id text PRIMARY KEY,
  checksum text NOT NULL,
  finished_at timestamptz,
  migration_name text NOT NULL,
  logs text,
  rolled_back_at timestamptz,
  started_at timestamptz NOT NULL DEFAULT now(),
  applied_steps_count integer NOT NULL DEFAULT 0
);
INSERT INTO "_prisma_migrations" (id, checksum, finished_at, migration_name)
VALUES ('p95-synthetic', 'synthetic', now(), 'p95_synthetic');
SQL

commit_ts_of() {
  srcpsql -c "select to_char(pg_xact_commit_timestamp('$1'::xid) AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')"
}
A_XMIN="$(srcpsql -c "INSERT INTO pitr_events(marker,note) VALUES ('P95_TXN_A','before-base-backup') RETURNING xmin::text")" || \
  setup_fail "could not commit synthetic transaction A."
A_TS="$(commit_ts_of "$A_XMIN")" || setup_fail "could not read transaction A commit timestamp."
sleep 1.2
A_WAL="$(adminpsql -c 'select pg_walfile_name(pg_current_wal_lsn())')" || setup_fail "could not read transaction A WAL file."
adminpsql -c 'select pg_switch_wal(); checkpoint;' >/dev/null || setup_fail "could not force pre-backup WAL switch."
p95_wait_for_wal "$ARCHIVE" "$A_WAL" 30 || setup_fail "transaction A WAL '$A_WAL' was not archived before the base backup."

BASE_START_MS="$(p95_now_ms)"
env WAL_ARCHIVE_DIR="$ARCHIVE" WAL_ARCHIVE_SKIP_MOUNT_CHECK=1 \
  bash "${REPO}/scripts/pitr-base-backup.sh" \
    --pghost "$PGHOST_TEST" --pgport "$PGPORT" --pguser clinic --pgdatabase "$TEST_DB" \
    --wal-archive-dir "$ARCHIVE" --backup-root "$BACKUP_ROOT" --tier daily \
    --label auto --age-recipient "$RECIPIENT" --skip-mount-check \
    > "${TMP}/logs/base-backup.log" 2>&1 || {
  cat "${TMP}/logs/base-backup.log" >&2
  setup_fail "PITR base backup failed."
}
BASE_MS=$(( $(p95_now_ms) - BASE_START_MS ))
BASE_SET="$(find "${BACKUP_ROOT}/daily" -maxdepth 1 -mindepth 1 -type d -name '*-pitr-auto' | LC_ALL=C sort | tail -n 1)"
[ -n "$BASE_SET" ] || setup_fail "base backup set was not published."
BACKUP_ID="$(p95_manifest_get "${BASE_SET}/MANIFEST.txt" backup_id)"

B_XMIN="$(srcpsql -c "INSERT INTO pitr_events(marker,note) VALUES ('P95_TXN_B','after-base-backup') RETURNING xmin::text")" || \
  setup_fail "could not commit synthetic transaction B."
B_TS="$(commit_ts_of "$B_XMIN")" || setup_fail "could not read transaction B commit timestamp."
B_LSN="$(srcpsql -c 'select pg_current_wal_lsn()::text')" || setup_fail "could not read transaction B LSN."
B_WAL="$(srcpsql -c "select pg_walfile_name('${B_LSN}'::pg_lsn)")" || setup_fail "could not map transaction B LSN to WAL."
sleep 0.3
C_XMIN="$(srcpsql -c "INSERT INTO pitr_events(marker,note) VALUES ('P95_TXN_C_SENTINEL','bounds-after-target') RETURNING xmin::text")" || \
  setup_fail "could not commit synthetic sentinel transaction C."
C_TS="$(commit_ts_of "$C_XMIN")" || setup_fail "could not read transaction C commit timestamp."
C_LSN="$(srcpsql -c 'select pg_current_wal_lsn()::text')" || setup_fail "could not read transaction C LSN."
C_WAL="$(srcpsql -c "select pg_walfile_name('${C_LSN}'::pg_lsn)")" || setup_fail "could not map transaction C LSN to WAL."
adminpsql -c 'select pg_switch_wal(); checkpoint; select pg_switch_wal();' >/dev/null || \
  setup_fail "could not force final WAL switches."
THROUGH_WAL="$(adminpsql -c 'select pg_walfile_name(pg_current_wal_lsn())')" || \
  setup_fail "could not read final WAL filename."
for wal_file in $(backup_wal_range "$C_WAL" "$THROUGH_WAL"); do
  p95_wait_for_wal "$ARCHIVE" "$wal_file" 30 || \
    setup_fail "post-transaction WAL '$wal_file' was not archived."
done

SOURCE_SNAPSHOT="$(srcpsql -c "select count(*) || ':' || string_agg(marker, ',' order by id) from pitr_events")"
SOURCE_RECOVERY="$(adminpsql -c 'select pg_is_in_recovery()')"
SOURCE_LSN="$(adminpsql -c 'select pg_current_wal_lsn()::text')"

TARGET_BEFORE="$(adminpsql -c "select to_char(('${B_TS}'::timestamptz - interval '0.05 second') AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')")"
TARGET_AFTER="$(adminpsql -c "select to_char(('${B_TS}'::timestamptz + ('${C_TS}'::timestamptz - '${B_TS}'::timestamptz) / 2) AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')")"

run_restore() {
  local set="$1" target="$2" port="$3" out="$4" target_time="$5"
  RESTORE_PGDATAS+=("${target}/data")
  env WAL_ARCHIVE_DIR="$ARCHIVE" WAL_ARCHIVE_SKIP_MOUNT_CHECK=1 \
    bash "${REPO}/scripts/pitr-restore.sh" \
      --set "$set" --target-time "$target_time" \
      --target-dir "$target" --confirm-target-dir "$target" \
      --pgport "$port" --pguser clinic --key-file "${TMP}/keys/key.txt" \
      --through-wal-file "$THROUGH_WAL" --skip-mount-check > "$out" 2>&1
}

# --- 1: WAL archiving starts successfully -----------------------------------
ARCHIVED_COUNT="$(adminpsql -c 'select archived_count::text from pg_stat_archiver')"
FAILED_COUNT="$(adminpsql -c 'select failed_count::text from pg_stat_archiver')"
LAST_ARCHIVED="$(adminpsql -c "select coalesce(last_archived_wal, 'none') from pg_stat_archiver")"
if [ "${ARCHIVED_COUNT:-0}" -gt 0 ] && [ "$FAILED_COUNT" = "0" ] && [ "$LAST_ARCHIVED" != "none" ]; then
  pass "1 WAL archiving starts successfully (archived_count=$ARCHIVED_COUNT failed_count=0)"
else
  fail "1 WAL archiving starts successfully (archived_count=${ARCHIVED_COUNT:-?} failed_count=${FAILED_COUNT:-?})"
fi

# --- 2: WAL files are archived ----------------------------------------------
SEGMENT_COUNT="$(find "$ARCHIVE" -maxdepth 1 -type f -name '0000000*' ! -name '*.sha256' | wc -l | tr -d '[:space:]')"
SIDECAR_COUNT="$(find "$ARCHIVE" -maxdepth 1 -type f -name '0000000*.sha256' | wc -l | tr -d '[:space:]')"
if [ "${SEGMENT_COUNT:-0}" -gt 0 ] && [ "$SEGMENT_COUNT" = "$SIDECAR_COUNT" ]; then
  pass "2 WAL files archived with checksum sidecars (segments=$SEGMENT_COUNT)"
else
  fail "2 WAL files archived with checksum sidecars (segments=$SEGMENT_COUNT sidecars=$SIDECAR_COUNT)"
fi

# --- 3: archive command failure is detected ---------------------------------
if bash "${REPO}/deploy/wal-archive.sh" "${TMP}/no-such-wal" 0000000100000000000000FF \
    > "${TMP}/logs/archive-failure.log" 2>&1; then
  fail "3 archive command failure is detected (missing source unexpectedly succeeded)"
elif grep -q 'BACKUP ERROR' "${TMP}/logs/archive-failure.log"; then
  pass "3 archive command failure is detected (non-zero with clear error)"
else
  fail "3 archive command failure is detected (non-zero but no clear error)"
fi

# --- 4: missing WAL is detected ---------------------------------------------
MISSING_ARCHIVE="${TMP}/missing-archive"
MISSING_SET="${TMP}/missing-set"
cp -R "$ARCHIVE" "$MISSING_ARCHIVE"
cp -R "$BASE_SET" "$MISSING_SET"
FIRST_WAL="$(p95_manifest_get "${BASE_SET}/MANIFEST.txt" required_wal_start)"
rm -f "${MISSING_ARCHIVE}/${FIRST_WAL}" "${MISSING_ARCHIVE}/${FIRST_WAL}.sha256"
sed -i "s#^wal_archive_dir=.*#wal_archive_dir=${MISSING_ARCHIVE}#" "${MISSING_SET}/MANIFEST.txt"
if env WAL_ARCHIVE_SKIP_MOUNT_CHECK=1 bash "${REPO}/scripts/pitr-restore.sh" \
    --set "$MISSING_SET" --target-time "$TARGET_BEFORE" \
    --target-dir "${TMP}/missing_restore" --confirm-target-dir "${TMP}/missing_restore" \
    --pgport 55437 --pguser clinic --key-file "${TMP}/keys/key.txt" \
    --skip-mount-check > "${TMP}/logs/missing-wal.log" 2>&1; then
  fail "4 missing WAL is detected (restore unexpectedly succeeded)"
elif grep -Eq 'missing WAL|not available' "${TMP}/logs/missing-wal.log"; then
  pass "4 missing WAL is detected before target creation"
else
  fail "4 missing WAL is detected (failed without expected message)"
fi

# --- 5: corrupted WAL is rejected -------------------------------------------
CORRUPT_ARCHIVE="${TMP}/corrupt-archive"
CORRUPT_SET="${TMP}/corrupt-set"
cp -R "$ARCHIVE" "$CORRUPT_ARCHIVE"
cp -R "$BASE_SET" "$CORRUPT_SET"
printf 'X' | dd of="${CORRUPT_ARCHIVE}/${FIRST_WAL}" bs=1 seek=0 conv=notrunc status=none
sed -i "s#^wal_archive_dir=.*#wal_archive_dir=${CORRUPT_ARCHIVE}#" "${CORRUPT_SET}/MANIFEST.txt"
if env WAL_ARCHIVE_SKIP_MOUNT_CHECK=1 bash "${REPO}/scripts/pitr-restore.sh" \
    --set "$CORRUPT_SET" --target-time "$TARGET_BEFORE" \
    --target-dir "${TMP}/corrupt_restore" --confirm-target-dir "${TMP}/corrupt_restore" \
    --pgport 55437 --pguser clinic --key-file "${TMP}/keys/key.txt" \
    --skip-mount-check > "${TMP}/logs/corrupt-wal.log" 2>&1; then
  fail "5 corrupted WAL is rejected (restore unexpectedly succeeded)"
elif grep -q 'corrupt WAL' "${TMP}/logs/corrupt-wal.log"; then
  pass "5 corrupted WAL is rejected by SHA-256 sidecar"
else
  fail "5 corrupted WAL is rejected (failed without expected message)"
fi

# --- 6: base backup is linked to the correct WAL sequence -------------------
MANIFEST="${BASE_SET}/MANIFEST.txt"
REQUIRED_FILES="$(p95_manifest_get "$MANIFEST" required_wal_files)"
REQUIRED_COUNT="$(p95_manifest_get "$MANIFEST" required_wal_count)"
LIST_COUNT="$(printf '%s\n' "$REQUIRED_FILES" | wc -w | tr -d '[:space:]')"
LINK_OK=1
[ "$(p95_manifest_get "$MANIFEST" backup_format)" = "pitr-base-1" ] || LINK_OK=0
[ "$(p95_manifest_get "$MANIFEST" pitr_ready)" = "true" ] || LINK_OK=0
[ -n "$(p95_manifest_get "$MANIFEST" pg_version)" ] || LINK_OK=0
[ -n "$(p95_manifest_get "$MANIFEST" start_lsn)" ] || LINK_OK=0
[ -n "$(p95_manifest_get "$MANIFEST" stop_lsn)" ] || LINK_OK=0
[ -n "$(p95_manifest_get "$MANIFEST" timeline)" ] || LINK_OK=0
[ -n "$(p95_manifest_get "$MANIFEST" wal_archive_dir)" ] || LINK_OK=0
[ "$REQUIRED_COUNT" = "$LIST_COUNT" ] && [ "${REQUIRED_COUNT:-0}" -gt 0 ] || LINK_OK=0
for wal_file in $REQUIRED_FILES; do
  declared="$(p95_manifest_get "$MANIFEST" "wal.sha256.${wal_file}")"
  actual="$(sha256sum "${ARCHIVE}/${wal_file}" | awk '{print $1}')"
  [ -n "$declared" ] && [ "$declared" = "$actual" ] || LINK_OK=0
done
if [ "$LINK_OK" = "1" ]; then
  pass "6 base backup linked to WAL sequence (backup_id=$BACKUP_ID files=$REQUIRED_COUNT)"
else
  fail "6 base backup linked to WAL sequence"
fi

# --- 7 + 8: recovery to a timestamp succeeds and stops there ----------------
BEFORE_DIR="${TMP}/before_restore"
BEFORE_LOG="${TMP}/logs/restore-before.log"
if run_restore "$BASE_SET" "$BEFORE_DIR" 55437 "$BEFORE_LOG" "$TARGET_BEFORE"; then
  pass "7 recovery to timestamp succeeds (target=$TARGET_BEFORE)"
else
  fail "7 recovery to timestamp succeeds"
  tail -n 40 "$BEFORE_LOG" >&2
fi
if [ -f "$BEFORE_LOG" ] && grep -q 'PITR RESTORE SUCCESS' "$BEFORE_LOG" && \
   grep -Eq 'recovery stopping before|reached recovery target|recovery target reached' \
     "${BEFORE_DIR}/postgres.log" && \
   [ "$(psql -h 127.0.0.1 -p 55437 -U clinic -d postgres -Atq -c 'select pg_is_in_recovery()' 2>/dev/null)" = "t" ]; then
  pass "8 recovery stops at the requested target (instance paused in recovery)"
else
  fail "8 recovery stops at the requested target"
fi

# --- 9: recovery before transaction B excludes B ----------------------------
if [ -d "${BEFORE_DIR}/data" ]; then
  A_COUNT="$(psql -h 127.0.0.1 -p 55437 -U clinic -d "$TEST_DB" -Atq \
    -c "select count(*) from pitr_events where marker='P95_TXN_A'" 2>/dev/null)"
  B_COUNT="$(psql -h 127.0.0.1 -p 55437 -U clinic -d "$TEST_DB" -Atq \
    -c "select count(*) from pitr_events where marker='P95_TXN_B'" 2>/dev/null)"
  if [ "$A_COUNT" = "1" ] && [ "$B_COUNT" = "0" ]; then
    pass "9 recovery before selected transaction excludes that transaction (A=1 B=0)"
  else
    fail "9 recovery before selected transaction excludes that transaction (A=${A_COUNT:-?} B=${B_COUNT:-?})"
  fi
else
  fail "9 recovery before selected transaction excludes that transaction (target missing)"
fi

# --- 10: recovery after transaction B includes B ----------------------------
AFTER_DIR="${TMP}/after_restore"
AFTER_LOG="${TMP}/logs/restore-after.log"
p95_stop_cluster "${BEFORE_DIR}/data"
if run_restore "$BASE_SET" "$AFTER_DIR" 55437 "$AFTER_LOG" "$TARGET_AFTER"; then
  A2_COUNT="$(psql -h 127.0.0.1 -p 55437 -U clinic -d "$TEST_DB" -Atq \
    -c "select count(*) from pitr_events where marker='P95_TXN_A'" 2>/dev/null)"
  B2_COUNT="$(psql -h 127.0.0.1 -p 55437 -U clinic -d "$TEST_DB" -Atq \
    -c "select count(*) from pitr_events where marker='P95_TXN_B'" 2>/dev/null)"
  C2_COUNT="$(psql -h 127.0.0.1 -p 55437 -U clinic -d "$TEST_DB" -Atq \
    -c "select count(*) from pitr_events where marker='P95_TXN_C_SENTINEL'" 2>/dev/null)"
  if [ "$A2_COUNT" = "1" ] && [ "$B2_COUNT" = "1" ] && [ "$C2_COUNT" = "0" ]; then
    pass "10 recovery after selected transaction includes that transaction (A=1 B=1 sentinel=0)"
  else
    fail "10 recovery after selected transaction includes that transaction (A=${A2_COUNT:-?} B=${B2_COUNT:-?} sentinel=${C2_COUNT:-?})"
  fi
else
  fail "10 recovery after selected transaction includes that transaction"
  tail -n 40 "$AFTER_LOG" >&2
fi
p95_stop_cluster "${AFTER_DIR}/data"

# --- 11: incomplete WAL sequence fails safely -------------------------------
INCOMPLETE_ARCHIVE="${TMP}/incomplete-archive"
INCOMPLETE_SET="${TMP}/incomplete-set"
cp -R "$ARCHIVE" "$INCOMPLETE_ARCHIVE"
cp -R "$BASE_SET" "$INCOMPLETE_SET"
rm -f "${INCOMPLETE_ARCHIVE}/${FIRST_WAL}" "${INCOMPLETE_ARCHIVE}/${FIRST_WAL}.sha256"
sed -i "s#^wal_archive_dir=.*#wal_archive_dir=${INCOMPLETE_ARCHIVE}#" "${INCOMPLETE_SET}/MANIFEST.txt"
if env WAL_ARCHIVE_SKIP_MOUNT_CHECK=1 bash "${REPO}/scripts/pitr-restore.sh" \
    --set "$INCOMPLETE_SET" --target-time "$TARGET_BEFORE" \
    --target-dir "${TMP}/incomplete_restore" --confirm-target-dir "${TMP}/incomplete_restore" \
    --pgport 55437 --pguser clinic --key-file "${TMP}/keys/key.txt" \
    --skip-mount-check > "${TMP}/logs/incomplete-wal.log" 2>&1; then
  fail "11 incomplete WAL sequence fails safely (restore unexpectedly succeeded)"
elif [ ! -e "${TMP}/incomplete_restore" ] && grep -q 'missing WAL segment' "${TMP}/logs/incomplete-wal.log"; then
  pass "11 incomplete WAL sequence fails safely before target creation"
else
  fail "11 incomplete WAL sequence fails safely"
fi

# --- 12: original source database remains unchanged -------------------------
SOURCE_AFTER="$(srcpsql -c "select count(*) || ':' || string_agg(marker, ',' order by id) from pitr_events")"
SOURCE_RECOVERY_AFTER="$(adminpsql -c 'select pg_is_in_recovery()')"
SOURCE_LSN_AFTER="$(adminpsql -c 'select pg_current_wal_lsn()::text')"
# LSN can advance through benign background WAL activity, so the unchanged
# proof is the synthetic row snapshot plus the source remaining not in recovery.
if [ "$SOURCE_SNAPSHOT" = "$SOURCE_AFTER" ] && [ "$SOURCE_RECOVERY" = "f" ] && \
   [ "$SOURCE_RECOVERY_AFTER" = "f" ]; then
  pass "12 original source database remains unchanged (snapshot=$SOURCE_AFTER)"
else
  fail "12 original source database remains unchanged (before=$SOURCE_SNAPSHOT after=$SOURCE_AFTER)"
fi

printf '\nAutomated PITR metadata\n'
printf '  backup_id: %s\n' "$BACKUP_ID"
printf '  base_backup_duration_ms: %s\n' "$BASE_MS"
printf '  source_wal_file_for_B: %s\n' "$B_WAL"
printf '  target_before_B: %s\n' "$TARGET_BEFORE"
printf '  target_after_B: %s\n' "$TARGET_AFTER"

summary
[ "$FAILED" -eq 0 ] || exit 1
exit 0
