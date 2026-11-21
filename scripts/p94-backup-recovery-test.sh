#!/usr/bin/env bash
# Phase 9.4 isolated backup/recovery tests. Synthetic PostgreSQL, synthetic
# files, temporary directories and a test-only backup root only.
#
# No production path, container, volume, database, backup or key is touched.
# The script provisions its own PostgreSQL 16 + age toolchain under
# $HOME/.local/p94-tools when those binaries are not already on PATH.
set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/p94-backup-tests.XXXXXX")" || exit 1
TESTS=0; PASSED=0; FAILED=0; BLOCKED=0

pass()   { TESTS=$((TESTS + 1)); PASSED=$((PASSED + 1)); printf 'PASS  %s\n' "$1"; }
fail()   { TESTS=$((TESTS + 1)); FAILED=$((FAILED + 1)); printf 'FAIL  %s\n' "$1" >&2; }
blocked(){ TESTS=$((TESTS + 1)); BLOCKED=$((BLOCKED + 1)); printf 'BLOCKED  %s\n' "$1"; }

cleanup() {
  if [ -n "${PGDATA:-}" ] && [ -x "$(command -v pg_ctl 2>/dev/null || printf 'false')" ]; then
    pg_ctl -D "$PGDATA" stop -m fast >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT

needs() {
  for tool in "$@"; do
    command -v "$tool" >/dev/null 2>&1 || return 1
  done
  return 0
}

ensure_tools() {
  local root="${P94_TOOLS_ROOT:-$HOME/.local/p94-tools/root}"
  if [ -n "$root" ] && [ -d "$root/usr/bin" ]; then
    export PATH="$root/usr/lib/postgresql/16/bin:$root/usr/bin:$PATH"
    export LD_LIBRARY_PATH="$root/usr/lib/x86_64-linux-gnu:$root/usr/lib/postgresql/16/lib:${LD_LIBRARY_PATH:-}"
  fi
  if needs age age-keygen initdb psql pg_dump pg_restore sha256sum tar; then
    return 0
  fi
  if [ "${P94_PROVISION_TOOLS:-1}" != "1" ] || ! command -v apt-get >/dev/null 2>&1; then
    return 1
  fi
  echo "Provisioning isolated test-only PostgreSQL/age binaries under $HOME/.local/p94-tools ..."
  local pkgroot="${P94_TOOLS_ROOT:-$HOME/.local/p94-tools/root}"
  local debroot="$(dirname "$pkgroot")/debs"
  mkdir -p "$debroot" "$pkgroot"
  ( cd "$debroot" && apt-get download -y postgresql-16 postgresql-client-16 libpq5 age >/dev/null 2>&1 ) || return 1
  for deb in "$debroot"/*.deb; do
    dpkg-deb -x "$deb" "$pkgroot" >/dev/null 2>&1 || return 1
  done
  export PATH="$pkgroot/usr/lib/postgresql/16/bin:$pkgroot/usr/bin:$PATH"
  export LD_LIBRARY_PATH="$pkgroot/usr/lib/x86_64-linux-gnu:$pkgroot/usr/lib/postgresql/16/lib:${LD_LIBRARY_PATH:-}"
  needs age age-keygen initdb psql pg_dump pg_restore sha256sum tar
}

if ! ensure_tools; then
  echo "Test toolchain unavailable; install PostgreSQL 16 client/server tools and age, or allow P94_PROVISION_TOOLS=1." >&2
  printf '\np94-backup-recovery: %d passed, %d failed, %d blocked, %d total\n' \
    "$PASSED" "$FAILED" "$BLOCKED" "$TESTS"
  exit 0
fi

umask 077
PGPORT="${P94_TEST_PGPORT:-55434}"
PGHOST_TEST="127.0.0.1"
ROOT="$TMP/backups"
STORAGE="$TMP/storage"
mkdir -p "$ROOT"/{daily,weekly,monthly,wal-archive,manifests,quarantine,logs} \
  "$STORAGE/uploads/nested" "$TMP/pg/data" "$TMP/pg/socket" "$TMP/keys"

PGDATA="$TMP/pg/data"
initdb -D "$PGDATA" -U clinic --auth=trust --no-instructions >/dev/null 2>&1 || {
  echo "BLOCKED: could not initialise the isolated PostgreSQL cluster." >&2
  exit 0
}
pg_ctl -D "$PGDATA" -l "$TMP/pg/postgres.log" \
  -o "-p $PGPORT -k $TMP/pg/socket -h 127.0.0.1" start >/dev/null 2>&1 || {
  echo "BLOCKED: could not start the isolated PostgreSQL cluster." >&2
  exit 0
}

psql -h "$PGHOST_TEST" -p "$PGPORT" -U clinic -d postgres -v ON_ERROR_STOP=1 <<'SQL' >/dev/null 2>&1
CREATE DATABASE clinic_source_test;
SQL
psql -h "$PGHOST_TEST" -p "$PGPORT" -U clinic -d clinic_source_test -v ON_ERROR_STOP=1 <<'SQL' >/dev/null 2>&1
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
VALUES ('p94-synthetic', 'synthetic', now(), 'p94_synthetic');
CREATE TABLE "Patient" (id uuid PRIMARY KEY, "patientNumber" text NOT NULL UNIQUE, "firstName" text NOT NULL);
INSERT INTO "Patient" VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'P94-SYN-001', 'Synthetic');
CREATE TABLE "Visit" (id uuid PRIMARY KEY, "patientId" uuid REFERENCES "Patient"(id), status text NOT NULL);
INSERT INTO "Visit" VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'COMPLETED');
SQL

printf 'synthetic upload A\n' > "$STORAGE/uploads/a.txt"
printf 'synthetic upload B\n' > "$STORAGE/uploads/b.txt"
printf 'synthetic nested upload\n' > "$STORAGE/uploads/nested/c.txt"
chmod 640 "$STORAGE/uploads/a.txt"

age-keygen -o "$TMP/keys/key.txt" 2>/dev/null
RECIPIENT="$(sed -n 's/^# public key: //p' "$TMP/keys/key.txt" | head -n 1)"
age-keygen -o "$TMP/keys/wrong-key.txt" 2>/dev/null

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}
manifest_get() { sed -n "s/^$2=//p" "$1/MANIFEST.txt" | head -n 1 | tr -d '\r'; }

run_backup() {
  local label="$1"; shift
  env "$@" \
    BACKUP_TEST_MODE=1 BACKUP_SOURCE_MODE=local \
    BACKUP_ROOT="$ROOT" BACKUP_TIER=daily BACKUP_LABEL="$label" \
    BACKUP_AGE_RECIPIENT="$RECIPIENT" BACKUP_ALLOW_WRITER_DRIFT=1 \
    BACKUP_STORAGE_DIR="$STORAGE" \
    PGHOST="$PGHOST_TEST" PGPORT="$PGPORT" PGUSER=clinic PGDATABASE=clinic_source_test \
    bash "$REPO/scripts/backup.sh" > "$TMP/backup-${label}.log" 2>&1
}

set_for_label() {
  find "$ROOT/daily" -maxdepth 1 -mindepth 1 -type d -name "*-${1}" -print | LC_ALL=C sort | tail -n 1
}

verify_root() { env BACKUP_VERIFY_SKIP_MOUNT_CHECK=1 bash "$REPO/scripts/backup-verify.sh" "$1"; }

run_restore() {
  local set="$1" key="$2" db="$3" dir="$4"
  env bash "$REPO/scripts/restore-backup.sh" \
    --set "$set" --target-db "$db" --confirm-target "$db" \
    --target-dir "$dir" --key-file "$key" \
    --pghost "$PGHOST_TEST" --pgport "$PGPORT" --pguser clinic
}

copy_root() { mkdir -p "$1"; cp -R "$ROOT/." "$1/"; }

db_exists() {
  local count
  count="$(psql -h "$PGHOST_TEST" -p "$PGPORT" -U clinic -d postgres -Atq \
    -c "select count(*) from pg_database where datname='$1';" 2>/dev/null)"
  [ "$count" = "1" ]
}

# --- 1-3: real encrypted database + storage backup -------------------------
BASE_LABEL="base"
if run_backup "$BASE_LABEL" && [ -n "$(set_for_label "$BASE_LABEL")" ]; then
  BASE_SET="$(set_for_label "$BASE_LABEL")"
  pass "1 successful database backup"
  pass "2 successful storage backup"
  pass "3 successful encrypted backup"
else
  fail "1 successful database backup"; fail "2 successful storage backup"; fail "3 successful encrypted backup"
  printf '\np94-backup-recovery: %d passed, %d failed, %d blocked, %d total\n' \
    "$PASSED" "$FAILED" "$BLOCKED" "$TESTS"
  exit 1
fi

DB_ART="$(manifest_get "$BASE_SET" database_dump)"
ST_ART="$(manifest_get "$BASE_SET" storage_archive)"
FILES_ART="$(manifest_get "$BASE_SET" storage_files_checksums)"
case "$DB_ART$ST_ART$FILES_ART" in
  *.age*.age*.age) : ;;
  *) fail "3 successful encrypted backup (artifact suffix check)" ;;
esac
age -d -i "$TMP/keys/key.txt" -o "$TMP/db.dump" "$BASE_SET/$DB_ART" 2>/dev/null && \
  [ "$(head -c 5 "$TMP/db.dump")" = "PGDMP" ] && pass "1 database dump is a valid custom-format archive" || \
  fail "1 database dump is a valid custom-format archive"
age -d -i "$TMP/keys/key.txt" -o "$TMP/storage.tar.gz" "$BASE_SET/$ST_ART" 2>/dev/null && \
  tar tzf "$TMP/storage.tar.gz" >/dev/null 2>&1 && pass "2 storage archive is readable" || \
  fail "2 storage archive is readable"
age -d -i "$TMP/keys/wrong-key.txt" -o "$TMP/wrong.out" "$BASE_SET/$DB_ART" >/dev/null 2>&1 && \
  fail "3 wrong key is rejected" || pass "3 wrong key is rejected"

# --- 4: complete restore ----------------------------------------------------
mkdir -p "$TMP/restore-ok"
if run_restore "$BASE_SET" "$TMP/keys/key.txt" clinic_ok_restore "$TMP/restore-ok" > "$TMP/restore-ok.log" 2>&1; then
  restored_rows="$(psql -h "$PGHOST_TEST" -p "$PGPORT" -U clinic -d clinic_ok_restore -Atq -c 'select count(*) from "Patient";')"
  [ "$restored_rows" = "1" ] && pass "4 successful complete restore" || fail "4 successful complete restore (row count)"
else
  fail "4 successful complete restore"; cat "$TMP/restore-ok.log" >&2
fi

# --- 5: corrupted archive detection ----------------------------------------
mkdir -p "$TMP/corrupt-root"; copy_root "$TMP/corrupt-root"
CORRUPT_SET="$(find "$TMP/corrupt-root/daily" -maxdepth 1 -mindepth 1 -type d -name '*-base' | head -n 1)"
printf 'tampered' >> "$CORRUPT_SET/$(manifest_get "$CORRUPT_SET" storage_archive)"
mkdir -p "$TMP/restore-corrupt"
if ! verify_root "$TMP/corrupt-root" > "$TMP/corrupt-verify.log" 2>&1 &&
   ! run_restore "$CORRUPT_SET" "$TMP/keys/key.txt" clinic_corrupt_restore "$TMP/restore-corrupt" > "$TMP/corrupt-restore.log" 2>&1; then
  pass "5 corrupted archive detection"
else
  fail "5 corrupted archive detection"
fi

# --- 6: checksum mismatch detection ----------------------------------------
mkdir -p "$TMP/sums-root"; copy_root "$TMP/sums-root"
SUMS_SET="$(find "$TMP/sums-root/daily" -maxdepth 1 -mindepth 1 -type d -name '*-base' | head -n 1)"
sed -i '1s/^/0/' "$SUMS_SET/SHA256SUMS"
if ! verify_root "$TMP/sums-root" > "$TMP/sums-verify.log" 2>&1; then
  pass "6 checksum mismatch detection"
else
  fail "6 checksum mismatch detection"; cat "$TMP/sums-verify.log" >&2
fi

# --- 7: missing database backup --------------------------------------------
mkdir -p "$TMP/missing-db-root"; copy_root "$TMP/missing-db-root"
MISSING_DB_SET="$(find "$TMP/missing-db-root/daily" -maxdepth 1 -mindepth 1 -type d -name '*-base' | head -n 1)"
rm -f "$MISSING_DB_SET/$(manifest_get "$MISSING_DB_SET" database_dump)"
mkdir -p "$TMP/restore-missing-db"
if ! run_restore "$MISSING_DB_SET" "$TMP/keys/key.txt" clinic_missing_db_restore "$TMP/restore-missing-db" > "$TMP/missing-db.log" 2>&1 &&
   grep -q 'database artifact .* is missing' "$TMP/missing-db.log"; then
  pass "7 missing database backup"
else
  fail "7 missing database backup"; cat "$TMP/missing-db.log" >&2
fi

# --- 8: missing storage archive --------------------------------------------
mkdir -p "$TMP/missing-st-root"; copy_root "$TMP/missing-st-root"
MISSING_ST_SET="$(find "$TMP/missing-st-root/daily" -maxdepth 1 -mindepth 1 -type d -name '*-base' | head -n 1)"
rm -f "$MISSING_ST_SET/$(manifest_get "$MISSING_ST_SET" storage_archive)"
mkdir -p "$TMP/restore-missing-st"
if ! run_restore "$MISSING_ST_SET" "$TMP/keys/key.txt" clinic_missing_st_restore "$TMP/restore-missing-st" > "$TMP/missing-st.log" 2>&1 &&
   grep -q 'storage artifact .* is missing' "$TMP/missing-st.log"; then
  pass "8 missing storage archive"
else
  fail "8 missing storage archive"; cat "$TMP/missing-st.log" >&2
fi

# --- 9 + 13: invalid key, source and target untouched ----------------------
BEFORE_HASH="$(find "$BASE_SET" -type f -exec sha256sum {} \; | sed "s#$BASE_SET#SET#" | LC_ALL=C sort | sha256sum | awk '{print $1}')"
mkdir -p "$TMP/restore-badkey"
if ! run_restore "$BASE_SET" "$TMP/keys/wrong-key.txt" clinic_badkey_restore "$TMP/restore-badkey" > "$TMP/badkey.log" 2>&1 &&
   grep -q 'decryption failed' "$TMP/badkey.log"; then
  pass "9 invalid encryption key"
else
  fail "9 invalid encryption key"; cat "$TMP/badkey.log" >&2
fi
AFTER_HASH="$(find "$BASE_SET" -type f -exec sha256sum {} \; | sed "s#$BASE_SET#SET#" | LC_ALL=C sort | sha256sum | awk '{print $1}')"
SOURCE_ROWS="$(psql -h "$PGHOST_TEST" -p "$PGPORT" -U clinic -d clinic_source_test -Atq -c 'select count(*) from "Patient";')"
if [ "$BEFORE_HASH" = "$AFTER_HASH" ] && [ "$SOURCE_ROWS" = "1" ] && ! db_exists clinic_badkey_restore &&
   [ -z "$(find "$TMP/restore-badkey" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
  pass "13 failed restore without damaging the original source"
else
  fail "13 failed restore without damaging the original source"
fi

# --- 10: interrupted backup cleanup ----------------------------------------
mkdir -p "$TMP/stub-bin"
cat > "$TMP/stub-bin/age" <<'EOF_STUB'
#!/usr/bin/env bash
echo "synthetic age failure (no secrets)" >&2
exit 1
EOF_STUB
chmod +x "$TMP/stub-bin/age"
if ! env PATH="$TMP/stub-bin:$PATH" run_backup interrupted > "$TMP/interrupted.log" 2>&1 &&
   [ -z "$(find "$ROOT/daily" -maxdepth 1 -name '.stage-interrupted-*' -print -quit)" ] &&
   [ -z "$(find "$ROOT/daily" -maxdepth 1 -name '*-interrupted' -print -quit)" ]; then
  pass "10 interrupted backup cleanup"
else
  fail "10 interrupted backup cleanup"; cat "$TMP/interrupted.log" >&2
fi

# --- 11: insufficient disk space -------------------------------------------
set +e
run_backup nodisk BACKUP_MIN_FREE_MB=999999999
nodisk_rc=$?
set -e
if [ "$nodisk_rc" -ne 0 ] &&
   grep -q 'not enough free space' "$TMP/backup-nodisk.log" &&
   [ -z "$(find "$ROOT/daily" -maxdepth 1 -name '.stage-nodisk-*' -print -quit)" ]; then
  pass "11 insufficient disk space"
else
  fail "11 insufficient disk space"; cat "$TMP/backup-nodisk.log" >&2
fi

# --- 12: retention keeps the latest valid backup ---------------------------
RET="$TMP/ret-root"
mkdir -p "$RET"/{daily,weekly,monthly,wal-archive,manifests,quarantine,logs}
for stamp in 20260101T000000Z 20260102T000000Z 20260103T000000Z; do
  dir="$RET/daily/clinic-daily-$stamp"
  cp -R "$BASE_SET" "$dir"
  sed -i "s/^set_directory=.*/set_directory=clinic-daily-$stamp/; s/^created_utc=.*/created_utc=$stamp/" "$dir/MANIFEST.txt"
done
INVALID="$RET/daily/clinic-daily-20251231T000000Z-invalid"
cp -R "$BASE_SET" "$INVALID"
rm -f "$INVALID/$(manifest_get "$INVALID" database_dump)"
if env BACKUP_VERIFY_SKIP_MOUNT_CHECK=1 bash "$REPO/scripts/backup-retention.sh" --root "$RET" \
     --keep-daily 1 > "$TMP/ret-dry.log" 2>&1 &&
   [ -d "$RET/daily/clinic-daily-20260101T000000Z" ]; then
  pass "12 retention dry run performs no deletion"
else
  fail "12 retention dry run performs no deletion"; cat "$TMP/ret-dry.log" >&2
fi
if env BACKUP_VERIFY_SKIP_MOUNT_CHECK=1 bash "$REPO/scripts/backup-retention.sh" --root "$RET" \
     --keep-daily 1 --apply --confirm DELETE > "$TMP/ret-apply.log" 2>&1 &&
   [ -d "$RET/daily/clinic-daily-20260103T000000Z" ] &&
   [ ! -d "$RET/daily/clinic-daily-20260102T000000Z" ] &&
   [ ! -d "$RET/daily/clinic-daily-20260101T000000Z" ] &&
   [ -d "$INVALID" ]; then
  pass "12 retention cleanup without deleting the latest valid backup"
else
  fail "12 retention cleanup without deleting the latest valid backup"; cat "$TMP/ret-apply.log" >&2
fi

# --- 14: manifest validation ------------------------------------------------
mkdir -p "$TMP/manifest-root"; copy_root "$TMP/manifest-root"
MAN_SET="$(find "$TMP/manifest-root/daily" -maxdepth 1 -mindepth 1 -type d -name '*-base' | head -n 1)"
sed -i 's/^set_directory=.*/set_directory=wrong-name/' "$MAN_SET/MANIFEST.txt"
mkdir -p "$TMP/restore-manifest"
if ! run_restore "$MAN_SET" "$TMP/keys/key.txt" clinic_manifest_restore "$TMP/restore-manifest" > "$TMP/manifest.log" 2>&1 &&
   grep -q 'does not match' "$TMP/manifest.log"; then
  pass "14 manifest validation"
else
  fail "14 manifest validation"; cat "$TMP/manifest.log" >&2
fi

printf '\np94-backup-recovery: %d passed, %d failed, %d blocked, %d total\n' \
  "$PASSED" "$FAILED" "$BLOCKED" "$TESTS"
[ "$FAILED" -eq 0 ] || exit 1
printf 'p94-backup-recovery: PASS %d/%d\n' "$PASSED" "$TESTS"
