# Ultrasound Clinic Management System

A full-stack, independent Ultrasound Clinic Management System. The frontend is a React 18 + TypeScript + Vite SPA; the backend is a Node.js + Express + Prisma + PostgreSQL API. It covers patient management, appointments, queue, visits, ultrasound reports (with measurements and images), payments, expenses, finance, and audit logging, with role-based access control for Admin, Receptionist, and Doctor.

## Tech Stack

**Frontend** (`web/`)
- React 18, TypeScript 5, Vite 7, React Router v7
- Tailwind CSS v4, Radix UI primitives, Lucide React, Axios

**Backend** (`backend/`)
- Node.js 20+, TypeScript 5, Express 4, tsx (dev) / tsc (build)
- Prisma ORM v6, Zod validation, JWT access/refresh tokens
- Multer uploads, Nodemailer SMTP, optional Microsoft Graph
- PDF generation via pdfkit

**Data & Infra**
- PostgreSQL 16, Docker + Docker Compose (`db`, `backend`, `web`)
- Nginx serves the SPA and reverse-proxies `/api`
- Timezone: `Africa/Cairo`; UI content: English only

## Features

- **Patients & Visits** — demographics, visit history, clinical records scoped per doctor
- **Appointments & Agenda** — scheduling, queue management
- **Reports** — ultrasound report editor with measurements, images, versioning, print view
- **Finance** — payments, expenses, finance summaries, bill printing
- **Users & Roles** — Admin-managed accounts with permission-based access
- **Audit** — audit log for sensitive actions
- **Settings** — clinic settings, setup wizard on first run
- **Security** — JWT auth with refresh rotation, rate limiting, helmet, CORS, env validation

## Quick Start (Docker)

1. Copy the environment file and fill in secrets:
   ```bash
   cp .env.example .env
   # generate secrets with:
   node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
   ```
2. Start the stack:
   ```bash
   docker compose up -d
   ```
3. Open the app at http://localhost:8080
4. Complete the setup wizard on first run.

For production, use the TLS overlay and the hardened checklist in
[docs/operations.md](docs/operations.md). The backend refuses to start with
unsafe production settings (HTTP origin, insecure cookies, placeholder JWT
secrets).

## Development

### Prerequisites
- Node.js 22 LTS (Vite 7 also accepts 20.19+ or 24+)
- PostgreSQL 16 (or use Docker for DB only)

### Both apps at once (recommended)
```bash
npm run setup        # installs dependencies for root, backend and web
npm run db:up        # starts PostgreSQL only (host port = POSTGRES_PORT in .env)
npm run dev          # runs backend (:4000) and web (:5173) together
```
Other root scripts: `dev:web`, `dev:backend`, `build`, `typecheck`, `test`,
`prisma:generate`, `prisma:migrate`, `prisma:deploy`, `prisma:studio`, `seed`,
`db:down`.

### Backend (standalone)
```bash
cd backend
npm install
cp ../.env.example .env
# For the Vite dev server on :5173, set APP_ORIGIN=http://localhost:5173 in .env.
npx prisma generate
npx prisma migrate dev
npm run dev
```

### Frontend (standalone)
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
- [Feature Specification](UltrasoundClinicSystem_Feature_Specification.md)

## Project Structure

```
Clinc-V1.1/
├── backend/          # Express + Prisma API
│   ├── prisma/       # schema & migrations
│   ├── src/          # application code
│   └── tests/        # node:test suite
├── web/              # React + Vite SPA
│   ├── src/          # components & routes
│   └── public/
├── docs/             # operations, API, finance, etc.
├── scripts/          # backup / restore scripts
├── docker-compose.yml
└── .env.example
```
