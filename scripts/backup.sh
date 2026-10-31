#!/usr/bin/env bash
# Create a consistent-enough backup of the database and uploaded files.
#
#   ./scripts/backup.sh
#
# Outputs are written to backups/ with mode 0700. Backups contain PHI: encrypt
# them at rest and copy them to an access-controlled, off-host location. This
# script does not delete old backups automatically.
set -euo pipefail

cd "$(dirname "$0")/.."
umask 077

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_DIR="${BACKUP_DIR:-backups}"
DB_CONTAINER_SERVICE="${DB_SERVICE:-db}"
STORAGE_VOLUME="${STORAGE_VOLUME:-ultrasound_clinic_storage}"

mkdir -p "$OUT_DIR"
chmod 700 "$OUT_DIR"
OUT_DIR_ABS="$(cd "$OUT_DIR" && pwd)"

if ! docker volume inspect "$STORAGE_VOLUME" >/dev/null 2>&1; then
  echo "Storage volume '$STORAGE_VOLUME' not found. Set STORAGE_VOLUME or start the stack." >&2
  exit 1
fi

echo "Backing up database..."
docker compose exec -T "$DB_CONTAINER_SERVICE" \
  sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' \
  > "$OUT_DIR/db-$STAMP.dump"

echo "Backing up uploaded files..."
docker run --rm \
  -v "${STORAGE_VOLUME}:/data:ro" \
  -v "${OUT_DIR_ABS}:/backup" \
  alpine:3.22 \
  tar czf "/backup/storage-$STAMP.tar.gz" -C /data .

(
  cd "$OUT_DIR_ABS"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "db-$STAMP.dump" "storage-$STAMP.tar.gz" > "SHA256SUMS-$STAMP.txt"
  else
    shasum -a 256 "db-$STAMP.dump" "storage-$STAMP.tar.gz" > "SHA256SUMS-$STAMP.txt"
  fi
)

cat > "$OUT_DIR/MANIFEST-$STAMP.txt" <<EOF
created_utc=$STAMP
database_dump=db-$STAMP.dump
storage_archive=storage-$STAMP.tar.gz
checksums=SHA256SUMS-$STAMP.txt
git_commit=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)
EOF

echo "Backup complete: $OUT_DIR (encrypt before moving off-host)."
