#!/usr/bin/env bash
# Phase 8.3.1 isolated backup/verification/monitoring tests.
# Synthetic data and temporary directories only. No production paths are
# touched, no Docker daemon is used, no real backup or restore is performed.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/p831-backup.XXXXXX")"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

STUB_STATE="$TMP/mount-state"
STUB_BIN="$TMP/bin"
FAKE_ROOT="$TMP/fake-mnt"
mkdir -p "$STUB_BIN" "$FAKE_ROOT" "$TMP/state"

cat > "$STUB_BIN/mountpoint" <<'EOF_STUB'
#!/usr/bin/env bash
. "$STUB_STATE"
[ "$MOUNT_PRESENT" = "1" ]
EOF_STUB
cat > "$STUB_BIN/findmnt" <<'EOF_STUB'
#!/usr/bin/env bash
. "$STUB_STATE"
field=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) shift; field="$1" ;;
    -M) shift ;;
  esac
  shift
done
case "$field" in
  UUID)   printf '%s\n' "$STUB_UUID" ;;
  FSTYPE) printf '%s\n' "$STUB_FSTYPE" ;;
  SOURCE) printf '%s\n' /dev/sda1 ;;
  *) exit 1 ;;
esac
EOF_STUB
chmod +x "$STUB_BIN/mountpoint" "$STUB_BIN/findmnt"
export STUB_STATE STUB_BIN
export PATH="${STUB_BIN}:${PATH}"

APPROVED_UUID="0f21089c-c507-4903-96e5-daf637100d53"
STAMP="20261120T153524Z"
export P7_STATE_DIR="$TMP/state" P7_ALERT_SINK="" P7_HEARTBEAT_FILE="$TMP/state/heartbeat"
export P7_BIN_DIR="$STUB_BIN"
export P7_NOW_EPOCH="$(date -u -d '2026-11-20T16:35:24Z' +%s 2>/dev/null || printf '1763646924')"

reset_mount() {
  printf 'MOUNT_PRESENT=1\nSTUB_UUID=%s\nSTUB_FSTYPE=ext4\n' "$APPROVED_UUID" > "$STUB_STATE"
}
reset_fixture() {
  rm -rf "$FAKE_ROOT"
  for d in daily weekly monthly wal-archive manifests quarantine logs; do
    mkdir -p "$FAKE_ROOT/$d"
  done
}
sha_of() { sha256sum "$1" 2>/dev/null | awk '{print $1}'; }

make_set() {
  tier="$1"
  dir="$FAKE_ROOT/$tier/clinic-${tier}-${STAMP}"
  mkdir -p "$dir"
  printf 'synthetic database payload\n' > "$dir/db-${STAMP}.dump.age"
  printf 'synthetic storage payload\n'  > "$dir/storage-${STAMP}.tar.gz.age"
  ( cd "$dir" && sha256sum "db-${STAMP}.dump.age" "storage-${STAMP}.tar.gz.age" > SHA256SUMS )
  db_sha="$(sha_of "$dir/db-${STAMP}.dump.age")"
  st_sha="$(sha_of "$dir/storage-${STAMP}.tar.gz.age")"
  cat > "$dir/MANIFEST.txt" <<EOF_MANIFEST
created_utc=${STAMP}
backup_root=${FAKE_ROOT}
backup_tier=${tier}
set_directory=clinic-${tier}-${STAMP}
mount_uuid=${APPROVED_UUID}
filesystem=ext4
database_name=synthetic_db
database_dump=db-${STAMP}.dump.age
database_sha256=${db_sha}
database_bytes=$(wc -c < "$dir/db-${STAMP}.dump.age" | tr -d ' ')
storage_archive=storage-${STAMP}.tar.gz.age
storage_sha256=${st_sha}
storage_bytes=$(wc -c < "$dir/storage-${STAMP}.tar.gz.age" | tr -d ' ')
storage_volume=synthetic_storage
evolution_archive=none
evolution_sha256=none
evolution_bytes=0
evolution_volume=none
caddy_archives=none
checksums=SHA256SUMS
encryption=age
postgres_version=16.0
git_commit=synthetic
backup_format=3
EOF_MANIFEST
}

TESTS=0; PASSED=0; FAILED=0
pass() { TESTS=$((TESTS+1)); PASSED=$((PASSED+1)); printf 'PASS  %s\n' "$1"; }
fail() { TESTS=$((TESTS+1)); FAILED=$((FAILED+1)); printf 'FAIL  %s\n' "$1" >&2; }
expect_ok()  { desc="$1"; shift; if "$@" >/dev/null 2>&1; then pass "$desc"; else fail "$desc"; fi; }
expect_fail() { desc="$1"; shift; if "$@" >/dev/null 2>&1; then fail "$desc"; else pass "$desc"; fi; }

# --- 1. correct UUID and filesystem accepted ---------------------------------
reset_mount; reset_fixture
expect_ok "1 correct mount UUID/ext4 accepted" \
  env BACKUP_ROOT="$FAKE_ROOT" bash -c '. "$1"; backup_check_storage "$2"' _ "$SCRIPT_DIR/backup-common.sh" "$FAKE_ROOT/daily"

# --- 2. missing mount rejected ------------------------------------------------
printf 'MOUNT_PRESENT=0\nSTUB_UUID=%s\nSTUB_FSTYPE=ext4\n' "$APPROVED_UUID" > "$STUB_STATE"
expect_fail "2 missing mount rejected" \
  env BACKUP_ROOT="$FAKE_ROOT" bash -c '. "$1"; backup_check_storage "$2"' _ "$SCRIPT_DIR/backup-common.sh" "$FAKE_ROOT/daily"

# --- 3. wrong UUID rejected ---------------------------------------------------
reset_mount
printf 'MOUNT_PRESENT=1\nSTUB_UUID=00000000-0000-0000-0000-000000000000\nSTUB_FSTYPE=ext4\n' > "$STUB_STATE"
expect_fail "3 wrong UUID rejected" \
  env BACKUP_ROOT="$FAKE_ROOT" bash -c '. "$1"; backup_check_storage "$2"' _ "$SCRIPT_DIR/backup-common.sh" "$FAKE_ROOT/daily"

# --- 4. wrong filesystem rejected ---------------------------------------------
printf 'MOUNT_PRESENT=1\nSTUB_UUID=%s\nSTUB_FSTYPE=xfs\n' "$APPROVED_UUID" > "$STUB_STATE"
expect_fail "4 wrong filesystem rejected" \
  env BACKUP_ROOT="$FAKE_ROOT" bash -c '. "$1"; backup_check_storage "$2"' _ "$SCRIPT_DIR/backup-common.sh" "$FAKE_ROOT/daily"

# --- 5. destination outside approved mount rejected ---------------------------
reset_mount
mkdir -p "$TMP/outside"
expect_fail "5 destination outside mount rejected" \
  env BACKUP_ROOT="$FAKE_ROOT" bash -c '. "$1"; backup_check_storage "$2"' _ "$SCRIPT_DIR/backup-common.sh" "$TMP/outside"

# --- 6. missing age recipient rejected with a precise error -------------------
if BACKUP_AGE_RECIPIENT= BACKUP_ROOT="$FAKE_ROOT" bash "$SCRIPT_DIR/backup.sh" >"$TMP/v6.log" 2>&1; then
  fail "6 missing age recipient rejected"
elif grep -q 'BACKUP ERROR: BACKUP_AGE_RECIPIENT is empty' "$TMP/v6.log" &&
     ! grep -q 'command not found' "$TMP/v6.log"; then
  pass "6 missing age recipient rejected"
else
  fail "6 missing age recipient rejected"; cat "$TMP/v6.log" >&2
fi

# --- 7. missing encryption requirement rejected with a precise error ----------
if BACKUP_REQUIRE_ENCRYPTION=0 BACKUP_AGE_RECIPIENT="age1synthetic" \
   BACKUP_ROOT="$FAKE_ROOT" bash "$SCRIPT_DIR/backup.sh" >"$TMP/v7.log" 2>&1; then
  fail "7 disabled encryption requirement rejected"
elif grep -q 'BACKUP ERROR: BACKUP_REQUIRE_ENCRYPTION' "$TMP/v7.log" &&
     ! grep -q 'command not found' "$TMP/v7.log"; then
  pass "7 disabled encryption requirement rejected"
else
  fail "7 disabled encryption requirement rejected"; cat "$TMP/v7.log" >&2
fi

# --- 8. valid synthetic encrypted set passes verification ---------------------
reset_mount; reset_fixture; make_set daily
if BACKUP_ROOT="$FAKE_ROOT" bash "$SCRIPT_DIR/backup-verify.sh" "$FAKE_ROOT" >"$TMP/v8.log" 2>&1; then
  pass "8 valid synthetic encrypted set verified"
else
  fail "8 valid synthetic encrypted set verified"; cat "$TMP/v8.log" >&2
fi

# --- 9. corrupted checksum rejected -------------------------------------------
printf 'tampered payload\n' > "$FAKE_ROOT/daily/clinic-daily-${STAMP}/db-${STAMP}.dump.age"
expect_fail "9 corrupted checksum rejected" \
  env BACKUP_ROOT="$FAKE_ROOT" bash "$SCRIPT_DIR/backup-verify.sh" "$FAKE_ROOT"

# --- 10. missing manifest artifact detected -----------------------------------
reset_fixture; make_set daily
rm -f "$FAKE_ROOT/daily/clinic-daily-${STAMP}/storage-${STAMP}.tar.gz.age"
if BACKUP_ROOT="$FAKE_ROOT" bash "$SCRIPT_DIR/backup-verify.sh" "$FAKE_ROOT" >"$TMP/v10.log" 2>&1; then
  fail "10 missing manifest artifact detected"
elif grep -q "storage.*missing" "$TMP/v10.log"; then pass "10 missing manifest artifact detected"
else fail "10 missing manifest artifact detected"; fi

# --- 11. orphan artifact detected ---------------------------------------------
reset_fixture; make_set daily
printf 'rogue\n' > "$FAKE_ROOT/daily/clinic-daily-${STAMP}/unexpected.age"
if BACKUP_ROOT="$FAKE_ROOT" bash "$SCRIPT_DIR/backup-verify.sh" "$FAKE_ROOT" >"$TMP/v11.log" 2>&1; then
  fail "11 orphan artifact detected"
elif grep -q "orphan artifact" "$TMP/v11.log"; then pass "11 orphan artifact detected"
else fail "11 orphan artifact detected"; fi

# --- 12. daily/weekly/monthly discovery ---------------------------------------
reset_fixture; make_set daily; make_set weekly; make_set monthly
if BACKUP_ROOT="$FAKE_ROOT" bash "$SCRIPT_DIR/backup-verify.sh" "$FAKE_ROOT" >"$TMP/v12.log" 2>&1 &&
   grep -q '3 set(s)' "$TMP/v12.log"; then
  pass "12 daily/weekly/monthly discovery"
else
  fail "12 daily/weekly/monthly discovery"; cat "$TMP/v12.log" >&2
fi

# --- 13. monitoring: absent mount with existing directory ---------------------
printf 'MOUNT_PRESENT=0\nSTUB_UUID=%s\nSTUB_FSTYPE=ext4\n' "$APPROVED_UUID" > "$STUB_STATE"
if P7_BACKUP_ROOT="$FAKE_ROOT" bash "$SCRIPT_DIR/p7-check-backup.sh" >"$TMP/m13.log" 2>&1; then
  rc=0
else rc=$?; fi
if [ "$rc" -eq 3 ] && grep -q '"status":"critical"' "$TMP/m13.log"; then
  pass "13 monitor rejects absent mount despite existing directory"
else
  fail "13 monitor rejects absent mount despite existing directory"; cat "$TMP/m13.log" >&2
fi

# --- 14. monitoring: invalid UUID ---------------------------------------------
printf 'MOUNT_PRESENT=1\nSTUB_UUID=00000000-0000-0000-0000-000000000000\nSTUB_FSTYPE=ext4\n' > "$STUB_STATE"
if P7_BACKUP_ROOT="$FAKE_ROOT" bash "$SCRIPT_DIR/p7-check-backup.sh" >"$TMP/m14.log" 2>&1; then
  rc=0
else rc=$?; fi
if [ "$rc" -eq 3 ] && grep -q 'does not match approved UUID' "$TMP/m14.log"; then
  pass "14 monitor rejects invalid UUID"
else
  fail "14 monitor rejects invalid UUID"; cat "$TMP/m14.log" >&2
fi

# --- 15. verifier/monitor never delete or modify artifacts --------------------
reset_mount; reset_fixture; make_set daily; make_set weekly; make_set monthly
before="$(find "$FAKE_ROOT" -type f -exec sha256sum {} \; | sed "s#$FAKE_ROOT#ROOT#" | sort)"
BACKUP_ROOT="$FAKE_ROOT" bash "$SCRIPT_DIR/backup-verify.sh" "$FAKE_ROOT" >/dev/null 2>&1 || true
P7_BACKUP_ROOT="$FAKE_ROOT" bash "$SCRIPT_DIR/p7-check-backup.sh" >/dev/null 2>&1 || true
after="$(find "$FAKE_ROOT" -type f -exec sha256sum {} \; | sed "s#$FAKE_ROOT#ROOT#" | sort)"
if [ "$before" = "$after" ]; then pass "15 no backup artifact deleted or modified"
else fail "15 no backup artifact deleted or modified"; fi

# --- 16. storage validator fail-closed reports a precise reason ---------------
printf 'MOUNT_PRESENT=1\nSTUB_UUID=00000000-0000-0000-0000-000000000000\nSTUB_FSTYPE=ext4\n' > "$STUB_STATE"
if env BACKUP_ROOT="$FAKE_ROOT" bash -c '. "$1"; backup_require_storage "$2"' \
     _ "$SCRIPT_DIR/backup-common.sh" "$FAKE_ROOT/daily" >"$TMP/v16.log" 2>&1; then
  fail "16 storage validator fail-closed reports a precise reason"
elif grep -q 'BACKUP ERROR: backup disk UUID' "$TMP/v16.log" &&
     ! grep -q 'command not found' "$TMP/v16.log"; then
  pass "16 storage validator fail-closed reports a precise reason"
else
  fail "16 storage validator fail-closed reports a precise reason"; cat "$TMP/v16.log" >&2
fi

printf '\np831-backup: %d passed, %d failed, %d total\n' "$PASSED" "$FAILED" "$TESTS"
[ "$FAILED" -eq 0 ] || exit 1
printf 'p831-backup: PASS %d/%d\n' "$PASSED" "$TESTS"
