-- Bearer tokens are checked against the account's current token version in
-- addition to the jti blacklist, so a password change (or archive/restore)
-- invalidates already-issued access tokens immediately.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "tokenVersion" INTEGER NOT NULL DEFAULT 0;

-- Schedule overrides and completing a visit without a finalized report are
-- privileged exceptions. Existing administrators keep their ability; other
-- roles must be granted these capabilities explicitly.
UPDATE "User"
SET "permissions" = array_append("permissions", 'APPOINTMENTS_OVERRIDE')
WHERE "role" = 'ADMIN'
  AND NOT ('APPOINTMENTS_OVERRIDE' = ANY("permissions"));

UPDATE "User"
SET "permissions" = array_append("permissions", 'VISITS_OVERRIDE')
WHERE "role" = 'ADMIN'
  AND NOT ('VISITS_OVERRIDE' = ANY("permissions"));
