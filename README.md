# Ultrasound Clinic Management System

A brand-new, independent Ultrasound Clinic Management System built with React 18 + TypeScript + Vite (frontend) and Node.js + Express + Prisma + PostgreSQL (backend).

## Quick Start (Docker)

1. Copy environment file: cp .env.example .env and fill in secrets (generate with node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))")
2. Start the stack: docker compose up -d
3. Open the app at http://localhost:8080
4. Complete the setup wizard on first run

For a production deployment, use the TLS overlay and the hardened environment
checklist in [docs/operations.md](docs/operations.md). The backend refuses to
start with unsafe production settings (HTTP origin, insecure cookies, placeholder
JWT secrets).

## Development

### Prerequisites
- Node.js 22 LTS (Vite 7 also accepts 20.19+ or 24+)
- PostgreSQL 16 (or use Docker for DB only)

### Backend
```bash
cd backend
npm install
cp ../.env.example .env
# For the Vite dev server on :5173, set APP_ORIGIN=http://localhost:5173 in .env.
npx prisma generate
npx prisma migrate dev
npm run dev
```

### Frontend
```bash
cd web
npm install
npm run dev
```

## Database migrations
Use committed migrations; never `prisma db push` against a shared or production
database.

```bash
cd backend
npx prisma migrate deploy   # applies committed migrations
```

CI applies all migrations to an empty Postgres database, checks for schema
drift, runs the test suite, and builds both apps.

## Operations
- Production TLS, monitoring, log rotation, backup schedule, and the restore
  drill are documented in [docs/operations.md](docs/operations.md).
- Optional WhatsApp PDF delivery is manual, finalized-report-only and disabled
  by default; setup, consent and template requirements are in
  [docs/operations.md](docs/operations.md#whatsapp-report-delivery).
- Never commit `.env`, backups, uploaded files, logs, or PHI.
- Rotate any credential that was ever shared or committed; see
  [SECURITY.md](SECURITY.md).

## Test Accounts & Credentials

Test accounts are never shipped with committed passwords. To create or reset
the development accounts, supply a strong local password through the
environment for that command only:

```bash
# Directly in backend (PowerShell syntax shown; use export on bash/macOS)
$env:SEED_TEST_PASSWORD = '<a-strong-local-password>'
$env:SEED_TEMP_PASSWORD = '<a-different-strong-local-password>'
npm run seed:test-users

# Or via Docker, run the seed in the build image with the same secrets as the
# backend. Export them for this one command; never commit them.
docker compose run --rm \
  -e NODE_ENV=development \
  -e APP_ORIGIN=http://localhost:8080 \
  -e JWT_ACCESS_SECRET='<local-only-32+-char-value>' \
  -e JWT_REFRESH_SECRET='<different-local-only-32+-char-value>' \
  -e SEED_TEST_PASSWORD='<strong-password>' \
  -e SEED_TEMP_PASSWORD='<different-strong-password>' \
  migrate npm run seed:test-users
```

The seed refuses to run in production unless `ALLOW_TEST_SEED=true` and never
prints passwords. Use the email addresses listed in
[docs/test-credentials.md](docs/test-credentials.md) with the password you
supplied. If any password was ever committed or shared, rotate it immediately:
see [SECURITY.md](SECURITY.md).

## Documentation
- [Test Accounts](docs/test-credentials.md)
- [Security & Credential Rotation](SECURITY.md)
- [Operations: TLS, Backups, Monitoring](docs/operations.md)
- [Backup & Restore](docs/backup-restore.md)
- [Decisions](docs/decisions.md)
- [Finance Rules](docs/finance-rules.md)
- [API Overview](docs/api.md)
