#!/usr/bin/env bash
# Rebuild and start the Compose stack from the current checkout, stamping every
# image with the exact commit that is running.
#
# Usage (from the checkout root, or with APP_ROOT pointing at it):
#   bash scripts/compose-up.sh -f docker-compose.yml \
#     -f docker-compose.tailscale.yml -f docker-compose.lan.yml
#
# `docker compose up` alone does not rebuild changed source. This wrapper makes
# rebuilds explicit and derives the stamp from Git rather than from an env file.
set -Eeuo pipefail

APP_ROOT="${APP_ROOT:-/opt/clinic}"

command -v git >/dev/null 2>&1 || { printf 'ERROR git is required\n' >&2; exit 1; }
command -v docker >/dev/null 2>&1 || { printf 'ERROR docker is required\n' >&2; exit 1; }
[ -d "$APP_ROOT/.git" ] || { printf 'ERROR %s is not a Git checkout\n' "$APP_ROOT" >&2; exit 1; }

cd "$APP_ROOT"

DIRTY="$(git status --porcelain 2>/dev/null || true)"
[ -z "$DIRTY" ] || {
  printf 'ERROR %s has uncommitted changes; refusing to build a mismatched stamp\n' "$APP_ROOT" >&2
  exit 1
}

BUILD_SHA="$(git rev-parse HEAD)"
export BUILD_SHA
printf 'INFO  building images from %s\n' "$BUILD_SHA"

exec docker compose "$@" up -d --build --remove-orphans
