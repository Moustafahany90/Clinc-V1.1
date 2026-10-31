-- Revoked access tokens (by jti) until their natural expiry.
--
-- `TokenBlacklist` exists in schema.prisma and is queried by the auth
-- middleware on every authenticated request, but the initial migration never
-- created the table. Without this migration a fresh install provisions a
-- database where every authenticated API call fails with Prisma P2021.
--
-- The DDL is intentionally idempotent: some existing environments created this
-- table out-of-band (e.g. `prisma db push`) and would otherwise fail when this
-- migration is first applied.

CREATE TABLE IF NOT EXISTS "TokenBlacklist" (
    "jti" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TokenBlacklist_pkey" PRIMARY KEY ("jti")
);

CREATE INDEX IF NOT EXISTS "TokenBlacklist_expiresAt_idx" ON "TokenBlacklist"("expiresAt");
