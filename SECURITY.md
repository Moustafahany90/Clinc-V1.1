# Security Policy and Credential Rotation

## Never commit secrets

`.env`, `backend/.env`, uploads, database dumps, and logs are ignored by Git.
Only `.env.example` is tracked and it contains placeholders. Never paste real
patient data, tokens, passwords, WhatsApp keys, QR/session data, or full phone
numbers into issues, pull requests, or chat.

## Rotate after any exposure

If a password, token, key, database dump, or `.env` was ever committed, pushed,
shared, or included in a screenshot, treat it as compromised **even if it was
later deleted from the working tree**. Deleting a file does not remove it from
Git history or from copies already downloaded.

This repository previously contained a development script with a real email
address and password, and the documentation/seed files contained shared test
passwords. Those values must be rotated; do not rely on the current HEAD being
clean as evidence that the old values are safe.

### Credential rotation checklist

1. **Application users** — change every affected password through
   `POST /api/v1/auth/change-password`, or archive and re-invite the account.
   Password changes increment `User.tokenVersion`, revoking all old access and
   refresh tokens immediately.
2. **First administrator** — if the setup administrator password was exposed,
   sign in and change it; confirm `mustChangePassword` is false and that
   `GET /api/v1/sessions` no longer lists unknown devices.
3. **Database** — generate a new `POSTGRES_PASSWORD`, update `.env`, then:
   ```bash
   docker compose exec db psql -U clinic_app -d postgres \
     -c "ALTER USER clinic_app WITH PASSWORD '<new-password>';"
   docker compose up -d backend
   ```
   Update any backup/restore tooling that embeds the old password.
4. **JWT secrets** — generate two distinct 48-byte random values:
   ```bash
   node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
   ```
   Set `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET`, then restart the backend.
   All existing sessions are invalidated. Never reuse one value for both.
5. **Email/Graph credentials** — revoke the old SMTP password or Microsoft
   Graph client secret in the provider console, issue a new one, update `.env`,
   restart the backend, and send a test message.
6. **WhatsApp credentials** — revoke the exposed Meta system-user token or
   phone-number configuration in Meta Business Manager, issue a new token,
   update `.env`, restart the backend, and verify a synthetic delivery. Rotate
   the token immediately if it was ever pasted into a screenshot, chat or log;
   never reuse a token from another clinic or project.
7. **TLS** — revoke/reissue any exposed certificate or private key. Caddy
   manages certificates automatically when used with the TLS overlay.
8. **Backups and storage** — if a backup or the storage volume was exposed,
   treat all PHI in it as disclosed and follow the clinic's incident process.
   Re-encrypt new backups and restrict access to the backup directory.
9. **Git history** — do not rewrite or force-push shared history without the
   repository owner's explicit approval. Rotate the secret instead; optionally
   run a secret scanner (for example `gitleaks detect`) and record findings.
10. **Verify** — sign in with a fresh account, confirm old access tokens return
   `401`, confirm `GET /healthz` is `200`, and check the audit log for
   `auth.password_changed` / `user.removed` events.

## Production minimums

- `NODE_ENV=production`
- `APP_ORIGIN=https://<public-host>` (comma-separated HTTPS origins only)
- `COOKIE_SECURE=true`
- `TRUST_PROXY=1` or greater (TLS terminates at Caddy/Nginx)
- Distinct, random JWT secrets of at least 32 characters, not placeholders
- Database, web, and backend ports bound to localhost; only the TLS proxy is
  exposed
- `EMAIL_ENABLED=true` only with a fully configured provider
- `WHATSAPP_ENABLED=true` only with a dedicated token, phone-number id, HTTPS
  Graph endpoint, patient-consent process and an approved template for
  business-initiated messages

The backend exits at startup if any of these production checks fail.

## Dependency and image hygiene

- Commit lockfiles and install with `npm ci`; do not use floating dependency
  ranges in a release build without review.
- The web build uses Vite 7 and audits with zero known advisories.
- The API runtime image excludes the Prisma CLI and its engine/fetch tooling;
  only `@prisma/client` and the generated client are shipped. The separate
  `migrate` service still contains the Prisma CLI because it applies committed
  migrations at startup.
- `npm audit` in the backend build/migrate stage can report advisories in the
  Prisma CLI's development-only config dependency chain. Do not run
  `npm audit fix --force` in a release branch; evaluate the supported Prisma
  upgrade instead. These packages are not present in the API runtime image.
- Rebuild images regularly to pick up base-image patches. The stack pins Node 22
  LTS, nginx 1.30, Caddy 2.11, and PostgreSQL 16; review major upgrades and EOL
  dates before changing them.

## Reporting a vulnerability

Contact the clinic's system owner privately. Do not open a public issue that
contains PHI, credentials, or exploitable details.
