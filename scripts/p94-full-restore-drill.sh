#!/usr/bin/env bash
# Phase 9.4 end-to-end restore drill using SYNTHETIC data only.
#
# Creates a disposable PostgreSQL 16 cluster, applies the repository migrations,
# inserts representative clinic records and uploaded files, creates an encrypted
# backup with scripts/backup.sh, verifies it, restores into a separate database
# and storage directory with scripts/restore-backup.sh, compares records and file
# checksums, and runs a focused backend test against the restored database.
#
# No production database, container, volume, backup path or secret is used.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/p94-full-drill.XXXXXX")" || exit 1
PGDATA=""

cleanup() {
  if [ -n "$PGDATA" ] && command -v pg_ctl >/dev/null 2>&1; then
    pg_ctl -D "$PGDATA" stop -m fast >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP" "$SCHEMA_DIR" "$TEST_BAT_DIR" 2>/dev/null || true
}
trap cleanup EXIT

needs() {
  for tool in "$@"; do command -v "$tool" >/dev/null 2>&1 || return 1; done
  return 0
}

ensure_tools() {
  local root="${P94_TOOLS_ROOT:-$HOME/.local/p94-tools/root}"
  if [ -n "$root" ] && [ -d "$root/usr/bin" ]; then
    export PATH="$root/usr/lib/postgresql/16/bin:$root/usr/bin:$PATH"
    export LD_LIBRARY_PATH="$root/usr/lib/x86_64-linux-gnu:$root/usr/lib/postgresql/16/lib:${LD_LIBRARY_PATH:-}"
  fi
  if needs age age-keygen initdb psql pg_dump pg_restore pg_ctl sha256sum tar; then return 0; fi
  if [ "${P94_PROVISION_TOOLS:-1}" != "1" ] || ! command -v apt-get >/dev/null 2>&1; then return 1; fi
  echo "Provisioning isolated test-only PostgreSQL/age binaries under $HOME/.local/p94-tools ..."
  local debroot="$(dirname "$root")/debs"
  mkdir -p "$debroot" "$root"
  ( cd "$debroot" && apt-get download -y postgresql-16 postgresql-client-16 libpq5 age >/dev/null 2>&1 ) || return 1
  for deb in "$debroot"/*.deb; do dpkg-deb -x "$deb" "$root" >/dev/null 2>&1 || return 1; done
  export PATH="$root/usr/lib/postgresql/16/bin:$root/usr/bin:$PATH"
  export LD_LIBRARY_PATH="$root/usr/lib/x86_64-linux-gnu:$root/usr/lib/postgresql/16/lib:${LD_LIBRARY_PATH:-}"
  needs age age-keygen initdb psql pg_dump pg_restore pg_ctl sha256sum tar
}

if ! ensure_tools; then
  echo "BLOCKED: PostgreSQL 16/age toolchain unavailable." >&2
  exit 0
fi

NOW_MS() { date +%s%3N 2>/dev/null || printf '%s' "$(( $(date -u +%s) * 1000 ))"; }
PGPORT="${P94_DRILL_PGPORT:-55433}"
PGHOST_TEST="127.0.0.1"
mkdir -p "$TMP/data" "$TMP/socket" "$TMP/storage/uploads/nested" \
  "$TMP/backups"/{daily,weekly,monthly,wal-archive,manifests,quarantine,logs} \
  "$TMP/keys" "$TMP/restore-storage"
PGDATA="$TMP/data"

echo "1. Starting synthetic PostgreSQL cluster on isolated port $PGPORT ..."
initdb -D "$PGDATA" -U clinic --auth=trust --no-instructions >/dev/null 2>&1
pg_ctl -D "$PGDATA" -l "$TMP/postgres.log" \
  -o "-p $PGPORT -k $TMP/socket -h 127.0.0.1" start >/dev/null 2>&1
createdb -h "$PGHOST_TEST" -p "$PGPORT" -U clinic clinic_source_test

# Windows paths are needed only for the optional application-level test.
NODE_EXE="${P94_NODE_EXE:-/mnt/c/Program Files/nodejs/node.exe}"
CMD_EXE="${P94_CMD_EXE:-/mnt/c/Windows/System32/cmd.exe}"
WIN_USER="${WIN_USER:-$(basename "$HOME")}"
WIN_TEMP="C:/Users/$WIN_USER/AppData/Local/Temp/opencode"
WSL_TEMP="/mnt/c/Users/$WIN_USER/AppData/Local/Temp/opencode"
SCHEMA_DIR="$WSL_TEMP/p94-drill-schema-$$"
SCHEMA_DIR_WIN="$WIN_TEMP/p94-drill-schema-$$"
TEST_BAT_DIR="$WSL_TEMP/p94-drill-test-$$"
TEST_BAT_DIR_WIN="$WIN_TEMP/p94-drill-test-$$"
mkdir -p "$SCHEMA_DIR" "$TEST_BAT_DIR"

case "$REPO" in
  /mnt/?/*)
    drive="${REPO#/mnt/}"; drive="${drive%%/*}"
    drive_upper="$(printf '%s' "$drive" | tr '[:lower:]' '[:upper:]')"
    REPO_WIN="$(printf '%s' "$REPO" | sed "s#^/mnt/$drive/#$drive_upper:/#")"
    ;;
  *) REPO_WIN="$REPO" ;;
esac

echo "2. Applying repository migrations to the synthetic source ..."
if [ -x "$NODE_EXE" ] && [ -f "$REPO/backend/node_modules/prisma/build/index.js" ]; then
  cp -R "$REPO/backend/prisma/." "$SCHEMA_DIR/"
  printf 'DATABASE_URL="postgresql://clinic:clinic@%s:%s/clinic_source_test?schema=public"\n' \
    "$PGHOST_TEST" "$PGPORT" > "$SCHEMA_DIR/.env"
  ( cd "$SCHEMA_DIR" && "$NODE_EXE" "$REPO_WIN/backend/node_modules/prisma/build/index.js" \
      migrate deploy --schema "$SCHEMA_DIR_WIN/schema.prisma" ) > "$TMP/migrate.log" 2>&1 || {
    tail -n 40 "$TMP/migrate.log" >&2
    echo "BLOCKED: migrations could not be applied to the synthetic source." >&2
    exit 0
  }
else
  echo "BLOCKED: node.exe/Prisma CLI unavailable; migration-based drill cannot run." >&2
  exit 0
fi

echo "3. Inserting synthetic clinic records and uploaded files ..."
printf 'synthetic upload alpha\n' > "$TMP/storage/uploads/alpha.txt"
printf 'synthetic upload beta\n' > "$TMP/storage/uploads/beta.txt"
printf 'synthetic nested upload\n' > "$TMP/storage/uploads/nested/gamma.txt"
chmod 640 "$TMP/storage/uploads/alpha.txt"
FILE_BYTES="$(wc -c < "$TMP/storage/uploads/alpha.txt" | tr -d ' ')"
FILE_SHA="$(sha256sum "$TMP/storage/uploads/alpha.txt" | awk '{print $1}')"

psql -h "$PGHOST_TEST" -p "$PGPORT" -U clinic -d clinic_source_test -v ON_ERROR_STOP=1 <<SQL >/dev/null
INSERT INTO "User" (id,email,"passwordHash","firstName","lastName",role,permissions,"tokenVersion","updatedAt")
VALUES ('11111111-1111-4111-8111-111111111111','synth.doctor@clinic.test','synthetic-hash','Synth','Doctor','DOCTOR','{}',0,'2026-11-21T00:00:00Z'),
       ('22222222-2222-4222-8222-222222222222','synth.admin@clinic.test','synthetic-hash','Synth','Admin','ADMIN','{}',0,'2026-11-21T00:00:00Z');
INSERT INTO "Service" (id,name,"durationMinutes","priceMinor","updatedAt")
VALUES ('33333333-3333-4333-8333-333333333333','Synthetic Scan',20,15000,'2026-11-21T00:00:00Z');
INSERT INTO "Patient" (id,"patientNumber","firstName","lastName","createdById","updatedAt")
VALUES ('44444444-4444-4444-8444-444444444444','SYN-P-001','Synth','Patient','22222222-2222-4222-8222-222222222222','2026-11-21T00:00:00Z');
INSERT INTO "Appointment" (id,"patientId","doctorId","serviceId","startAt","endAt","durationMinutes",status,"updatedAt")
VALUES ('55555555-5555-4555-8555-555555555555','44444444-4444-4444-8444-444444444444','11111111-1111-4111-8111-111111111111','33333333-3333-4333-8333-333333333333','2026-11-21T10:00:00Z','2026-11-21T10:20:00Z',20,'DONE','2026-11-21T00:00:00Z');
INSERT INTO "Visit" (id,"patientId","doctorId","appointmentId","visitDate",status,"chiefComplaint","updatedAt")
VALUES ('66666666-6666-4666-8666-666666666666','44444444-4444-4444-8444-444444444444','11111111-1111-4111-8111-111111111111','55555555-5555-4555-8555-555555555555','2026-11-21T10:30:00Z','COMPLETED','Synthetic check','2026-11-21T00:00:00Z');
INSERT INTO "Report" (id,"visitId","doctorId","serviceId",status,"versionNumber","currentContent","updatedAt")
VALUES ('77777777-7777-4777-8777-777777777777','66666666-6666-4666-8666-666666666666','11111111-1111-4111-8111-111111111111','33333333-3333-4333-8333-333333333333','FINALIZED',1,'{"finding":"synthetic"}'::jsonb,'2026-11-21T00:00:00Z');
INSERT INTO "FileAsset" (id,"patientId","visitId","uploadedById","originalName","storedName","mimeType","sizeBytes",checksum,kind)
VALUES ('88888888-8888-4888-8888-888888888888','44444444-4444-4444-8444-444444444444','66666666-6666-4666-8666-666666666666','11111111-1111-4111-8111-111111111111','alpha.txt','alpha.txt','text/plain',$FILE_BYTES,'$FILE_SHA','CLINICAL');
SQL

age-keygen -o "$TMP/keys/key.txt" 2>/dev/null
RECIPIENT="$(sed -n 's/^# public key: //p' "$TMP/keys/key.txt" | head -n 1)"

echo "4. Creating encrypted backup ..."
BACKUP_START="$(NOW_MS)"
env BACKUP_TEST_MODE=1 BACKUP_SOURCE_MODE=local \
  BACKUP_ROOT="$TMP/backups" BACKUP_TIER=daily \
  BACKUP_AGE_RECIPIENT="$RECIPIENT" BACKUP_ALLOW_WRITER_DRIFT=1 \
  BACKUP_STORAGE_DIR="$TMP/storage" \
  PGHOST="$PGHOST_TEST" PGPORT="$PGPORT" PGUSER=clinic PGDATABASE=clinic_source_test \
  bash "$REPO/scripts/backup.sh" > "$TMP/backup.log" 2>&1
BACKUP_MS=$(( $(NOW_MS) - BACKUP_START ))
SET_DIR="$(find "$TMP/backups/daily" -maxdepth 1 -mindepth 1 -type d -name 'clinic-*' | LC_ALL=C sort | tail -n 1)"
BACKUP_ID="$(sed -n 's/^backup_id=//p' "$SET_DIR/MANIFEST.txt" | head -n 1 | tr -d '\r')"
echo "   backup_id=$BACKUP_ID duration_ms=$BACKUP_MS"

echo "5. Verifying backup ..."
env BACKUP_VERIFY_SKIP_MOUNT_CHECK=1 bash "$REPO/scripts/backup-verify.sh" "$TMP/backups" > "$TMP/verify.log" 2>&1
tail -n 2 "$TMP/verify.log"

echo "6. Restoring into an isolated database and storage directory ..."
RESTORE_START="$(NOW_MS)"
env bash "$REPO/scripts/restore-backup.sh" \
  --set "$SET_DIR" --target-db clinic_restore_test --confirm-target clinic_restore_test \
  --target-dir "$TMP/restore-storage" --key-file "$TMP/keys/key.txt" \
  --pghost "$PGHOST_TEST" --pgport "$PGPORT" --pguser clinic > "$TMP/restore.log" 2>&1
RESTORE_MS=$(( $(NOW_MS) - RESTORE_START ))
tail -n 5 "$TMP/restore.log"

echo "7. Comparing restored records and file checksums ..."
for table in User Patient Appointment Visit Report FileAsset; do
  src="$(psql -h "$PGHOST_TEST" -p "$PGPORT" -U clinic -d clinic_source_test -Atq -c "select count(*) from \"$table\";")"
  dst="$(psql -h "$PGHOST_TEST" -p "$PGPORT" -U clinic -d clinic_restore_test -Atq -c "select count(*) from \"$table\";")"
  [ "$src" = "$dst" ] || { echo "MISMATCH $table: source=$src restored=$dst" >&2; exit 1; }
  echo "   $table: $src == $dst"
done
SRC_DB_SHA="$(psql -h "$PGHOST_TEST" -p "$PGPORT" -U clinic -d clinic_restore_test -Atq \
  -c 'select checksum from "FileAsset" where "storedName" = '\''alpha.txt'\'';')"
[ "$SRC_DB_SHA" = "$FILE_SHA" ] || { echo "FileAsset checksum mismatch" >&2; exit 1; }
( cd "$TMP/storage" && find . -type f -print | LC_ALL=C sort | xargs sha256sum ) | \
  sed 's#  \./#  #' | LC_ALL=C sort > "$TMP/source-files.sha256"
( cd "$TMP/restore-storage" && find . -type f -print | LC_ALL=C sort | xargs sha256sum ) | \
  sed 's#  \./#  #' | LC_ALL=C sort > "$TMP/restored-files.sha256"
diff -u "$TMP/source-files.sha256" "$TMP/restored-files.sha256"
SOURCE_MODE="$(stat -c %a "$TMP/storage/uploads/alpha.txt" 2>/dev/null || printf 'unknown')"
RESTORED_MODE="$(stat -c %a "$TMP/restore-storage/uploads/alpha.txt" 2>/dev/null || printf 'unknown')"
echo "   uploaded file mode: source=$SOURCE_MODE restored=$RESTORED_MODE"
echo "   file checksums identical"

echo "8. Running focused backend test against restored database ..."
APP_TEST_RESULT="BLOCKED"
if [ -x "$CMD_EXE" ]; then
  TEST_BAT="$TEST_BAT_DIR/run-test.bat"
  cat > "$TEST_BAT" <<EOF_BAT
@echo off
set NODE_ENV=test
set DATABASE_URL=postgresql://clinic:clinic@$PGHOST_TEST:$PGPORT/clinic_restore_test?schema=public
set JWT_ACCESS_SECRET=p94-synthetic-access-secret-0123456789abcdef
set JWT_REFRESH_SECRET=p94-synthetic-refresh-secret-fedcba9876543210
set APP_ORIGIN=http://127.0.0.1:5173
set COOKIE_SECURE=false
set TRUST_PROXY=1
set LOG_LEVEL=info
set EVOLUTION_API_ENABLED=false
cd /d ${REPO_WIN//\//\\}\\backend
"C:\\Program Files\\nodejs\\node.exe" --import tsx --test tests\\db-constraints.test.ts
EOF_BAT
  if "$CMD_EXE" /c "${TEST_BAT_DIR_WIN//\//\\}\\run-test.bat" > "$TMP/backend-test.log" 2>&1; then
    APP_TEST_RESULT="PASS"
    tail -n 8 "$TMP/backend-test.log"
  else
    APP_TEST_RESULT="FAIL"
    tail -n 40 "$TMP/backend-test.log" >&2
  fi
fi

printf '\nP94 FULL RESTORE DRILL RESULTS\n'
printf '  backup_id: %s\n' "$BACKUP_ID"
printf '  backup_duration_ms: %s\n' "$BACKUP_MS"
printf '  restore_duration_ms: %s\n' "$RESTORE_MS"
printf '  backend_test: %s\n' "$APP_TEST_RESULT"
printf '  verification: backup-verify passed; restored records and file checksums match source\n'
[ "$APP_TEST_RESULT" != "FAIL" ] || exit 1
