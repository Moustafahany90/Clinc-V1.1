#!/usr/bin/env bash
# Restore a backup into a disposable Postgres database and verify row counts.
# It never touches the clinic database.
#
#   ./scripts/restore-drill.sh backups/db-20261030T120000Z.dump
#
# The drill database name must end in "_drill"; the script refuses to run
# otherwise. Set KEEP_DRILL_DB=1 to keep it for inspection.
set -euo pipefail

cd "$(dirname "$0")/.."

DUMP="${1:-}"
if [ -z "$DUMP" ] || [ ! -f "$DUMP" ]; then
  echo "Usage: $0 <path-to-db-*.dump>" >&2
  exit 1
fi

DRILL_DB="${DRILL_DB:-clinic_restore_drill}"
case "$DRILL_DB" in
  *_drill) ;;
  *)
    echo "Refusing to restore into '$DRILL_DB': the name must end in '_drill'." >&2
    exit 1
    ;;
esac
if ! printf '%s' "$DRILL_DB" | grep -Eq '^[A-Za-z0-9_]+_drill$'; then
  echo "Refusing to restore into '$DRILL_DB': use only letters, digits and underscores." >&2
  exit 1
fi

DB_USER="$(docker compose exec -T db printenv POSTGRES_USER | tr -d '\r')"
if [ -z "$DB_USER" ]; then
  echo "Could not determine POSTGRES_USER from the db service." >&2
  exit 1
fi

echo "Recreating disposable database '$DRILL_DB'..."
docker compose exec -T db psql -U "$DB_USER" -d postgres -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE IF EXISTS \"$DRILL_DB\";"
docker compose exec -T db psql -U "$DB_USER" -d postgres -v ON_ERROR_STOP=1 \
  -c "CREATE DATABASE \"$DRILL_DB\";"

echo "Restoring $DUMP ..."
docker compose exec -T db pg_restore -U "$DB_USER" -d "$DRILL_DB" \
  --no-owner --no-acl --exit-on-error < "$DUMP"

echo "Verifying restored data..."
docker compose exec -T db psql -U "$DB_USER" -d "$DRILL_DB" -v ON_ERROR_STOP=1 \
  -c 'SELECT
        (SELECT count(*) FROM "_prisma_migrations") AS migrations,
        (SELECT count(*) FROM "User") AS users,
        (SELECT count(*) FROM "Patient") AS patients,
        (SELECT count(*) FROM "Report") AS reports;'

echo "Restore drill passed for '$DRILL_DB'. No clinic data was modified."
if [ "${KEEP_DRILL_DB:-0}" = "1" ]; then
  echo "Keeping '$DRILL_DB' for inspection (KEEP_DRILL_DB=1)."
else
  echo "Dropping disposable database '$DRILL_DB'..."
  docker compose exec -T db psql -U "$DB_USER" -d postgres -v ON_ERROR_STOP=1 \
    -c "DROP DATABASE IF EXISTS \"$DRILL_DB\";"
fi
