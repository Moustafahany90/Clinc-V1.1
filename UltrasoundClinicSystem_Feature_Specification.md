# Ultrasound Clinic Management System --- Feature Specifications

> Status: Adapted product specification. UI and user-facing content:
> **English only**. Timezone: `Africa/Cairo`. Project rule: build a new,
> independent application. Do not copy, modify, import, or depend on
> DentalPin or any existing project.

## 1. Approved technology stack

### Frontend

-   React 18, TypeScript 5, Vite 5, `@vitejs/plugin-react`
-   React Router v7 (`react-router-dom`)
-   Tailwind CSS v4 (`@tailwindcss/vite`), `clsx`, `tailwind-merge`
-   Radix UI primitives including `@radix-ui/react-slot`
-   `class-variance-authority` (CVA), Lucide React
-   Axios

### Backend

-   Node.js 20, TypeScript 5, Express 4
-   `tsx` for development and `tsc` for production builds
-   Prisma ORM v6, Zod validation
-   JWT access/refresh tokens using `jsonwebtoken`
-   Multer for controlled file uploads
-   Nodemailer SMTP support and optional Microsoft Graph API

### Data and infrastructure

-   PostgreSQL 16 (`postgres:16-alpine`), one new independent
    application database
-   Docker and Docker Compose with `db`, `backend`, and `web` services
-   Nginx serves the React SPA and reverse-proxies `/api` to the backend
-   Persistent Docker storage for uploads and generated files
-   `dotenv` for environment variables; Ubuntu Server production
    deployment; Windows may be used for development

Verify package compatibility before implementation, especially React
Router v7 with the selected React version and Tailwind CSS v4 with Vite
5. Do not silently change the approved stack; document incompatibilities
and propose the smallest safe adjustment.

## 2. Project isolation

-   Create the project from scratch in its own directory and initialize
    a new Git repository.
-   Inspect the target directory before writing files; do not overwrite
    existing content without approval.
-   Do not copy code, UI, assets, schemas, migrations, database volumes,
    dependencies, or Git history from any previous project.
-   Do not modify existing projects, databases, Docker volumes, or
    repositories.
-   Use fresh, project-specific Docker resources and Prisma migrations.
    Never assume an existing database or volume is safe to reset.

## 3. Roles, authentication, and access control

Initial roles: - **Admin:** manages accounts, roles, clinic settings,
schedules, and authorized operational/financial reports. -
**Receptionist:** manages patient demographics, appointments, queue,
permitted payment operations, and expenses if explicitly allowed. -
**Doctor:** accesses their own authorized appointments, visits, clinical
notes, reports, measurements, and images.

Use local application accounts with securely hashed passwords. Admin
creates accounts and assigns roles. Active Directory/LDAP is not
required. Implement secure JWT access/refresh token handling,
revocation/rotation as appropriate, rate limits, and server-side
validation. Securely bootstrap the first administrator; never ship
production credentials or demo passwords.

### Critical doctor isolation

-   Patient demographics may be shared, but clinical records are scoped
    to the responsible doctor.
-   Doctor A cannot access Doctor B's visits, notes, reports,
    measurements, report versions, or images, and vice versa.
-   Reception may access demographics, appointments, queue, and
    permitted financial records, but not clinical report content,
    images, measurements, or private notes.
-   Admin clinical access requires an explicit clinical permission; it
    is not automatically granted by the Admin role.
-   Enforce access control in backend services and database queries,
    including direct IDs, search, downloads, exports, dashboards,
    background jobs, and emails. Frontend hiding alone is insufficient.
-   Audit sensitive access and important changes. Test cross-doctor and
    cross-role access using direct API requests and tampered IDs.

## 4. Patient management

-   Create, view, update, and search patient demographics by name,
    phone, and patient ID.
-   Generate a unique patient ID.
-   Phone is optional where the clinic workflow allows it.
-   Warn about possible duplicates using phone and available identifying
    details; let an authorized user choose an existing patient. Never
    auto-merge records.
-   Keep shared demographics separate from doctor-owned clinical
    records.

### Quick patient creation from the appointment modal

**Goal:** create a patient and continue booking without leaving the
agenda or opening a nested modal.

1.  Clicking an empty calendar slot opens **New Appointment** and
    focuses the patient selector.
2.  Typing a name shows matching patients. If no exact match is found,
    show **Create patient "`<typed name>`{=html}"** as a distinct final
    action.
3.  Selecting it expands a mini-form in the same selector/modal:
    -   **First name** and **Last name**, prefilled with a heuristic
        split but always editable.
    -   **Phone**, optional, using a telephone-friendly input.
    -   Primary action: **Create and select**. Secondary action:
        **Cancel / Back to search**.
4.  While a phone is entered, check for a possible match. If found, show
    an inline soft warning with the matching patient's name and **Use
    this patient**. Do not block creation automatically.
5.  On success, select the new patient in the appointment form and show
    a subtle **New** indicator for the current session.
6.  On server/network error, show an inline error and preserve typed
    values for retry.
7.  Patient creation and appointment saving are separate persisted
    operations. Do not create a temporary client-only patient or imply
    both operations succeeded atomically.
8.  Only users with patient-write permission can see/use the create
    action. Prevent duplicate submissions while saving.
9.  Support keyboard operation, autofocus, accessible labels, visible
    focus, and clear validation.
10. On narrow screens, use a full-width bottom sheet or equivalent
    single-layer layout. Aim for touch targets of at least 44 CSS
    pixels.
11. Validate at 375×667, 390×844, and 768×1024.
12. Enter must not silently auto-create a patient; the editable
    confirmation form is required.

## 5. Agenda, appointments, and queue

### Booking

-   Provide useful daily and calendar views for reception.
-   Appointments include patient, responsible doctor, date/time,
    duration, and service/exam type.
-   Default exam duration is 15 minutes; allow service-specific
    configuration.
-   Prevent overlapping active appointments for the same doctor,
    including concurrent requests. Use backend/database protection and
    return a clear conflict response.
-   Record audit history for rescheduling, cancellation, status changes,
    and manual overrides.
-   Use `Africa/Cairo` consistently for clinic-local dates and times.

### Editable initial schedule defaults

-   Saturday and Sunday: start from 1:00 PM.
-   Monday through Wednesday: start from 2:30 PM.
-   Clinic generally closes by 9:00 PM.
-   Thursday and Friday are configurable; do not assume fixed hours.
-   Allow authorized users to configure working days, hours, breaks,
    exceptions, doctor availability, and appointment durations.

### Appointment statuses

Suggested workflow:
`Booked → Confirmed → Arrived → Waiting → InExam → ReportReview → Done`.
Additional states: `Cancelled`, `NoShow`. Validate transitions on the
backend and record who changed a status and when. Do not mark an
appointment complete until required completion steps are satisfied.

### Waiting queue

-   Reception can manage today's queue without seeing clinical report
    content.
-   Track arrival, queue entry, exam start, and exam end times.
-   Show waiting duration and elapsed time.
-   Support calling/skipping a patient and recording a reason for manual
    overrides when appropriate.
-   Provide daily operational summaries such as patient counts and
    waiting-time measures.

## 6. Ultrasound visits and clinical reports

### Visit records

Link each visit to the patient, appointment when applicable, and
responsible doctor. Store clinical content within the doctor's access
scope. Demographic/appointment access must not grant access to medical
details.

### Structured report editor

Provide configurable ultrasound report templates with structured fields
and editable free text. Baseline fields: - Patient and examination
identifiers - Examination date and responsible doctor - Clinical
indication - Findings - Measurements - Impression / conclusion -
Recommendations - Associated images, when available

Do not include dental terminology, tooth charts, dental treatment plans,
or dental-specific fields.

### Review, finalization, and history

-   Authorized doctors draft, review, edit, and finalize reports for
    their own patients.
-   Finalized reports cannot be silently overwritten. Corrections create
    a new version/amendment with author, timestamp, and reason where
    appropriate.
-   Preserve report versions and audit history.
-   Reception cannot read or edit clinical content. Admin clinical
    access requires explicit permission.
-   Produce professional, print-friendly English reports with print /
    Save as PDF output.
-   Select and document a reliable PDF approach compatible with the
    approved Node.js stack.

### Medical images and files

-   Support attaching approved images/documents to visits and reports.
-   Validate file type, size, and content. Use safe generated storage
    names.
-   Keep uploads outside publicly served static directories and serve
    through authorized backend endpoints.
-   Never expose permanent public URLs to medical files.
-   Include uploaded files in backup/restore planning.

### Future GE Voluson Performance 18 integration

This is future scope and must not be assumed possible until verified. -
Confirm the exact device configuration, export methods, network
settings, licensing, and supported standards. - Do not assume DICOM,
automatic export, or direct API access. - If DICOM is supported,
evaluate a local receiver such as Orthanc. - Validate patient/study
identifiers; prevent duplicate imports and wrong-patient attachment. -
Keep DICOM services on the clinic network; do not expose them directly
to the public internet. - A doctor must review imported content before
it is included in a finalized report.

## 7. Payments and patient ledger

### Payment operations

-   Record exam/service charges, deposits, partial payments, outstanding
    balances, and authorized refunds.
-   Support configurable methods such as cash, InstaPay, and bank
    transfer.
-   InstaPay/bank transfers are manually verified by reception; do not
    claim direct integration unless separately implemented and verified.
-   Store date, amount, method, reference where available, receiving
    user, and patient/visit association.
-   Prevent duplicate submissions and retain an audit trail.
-   Refunds require permission and confirmation and create a separate
    record; do not delete or rewrite the original payment.
-   A booked appointment is not proof of payment.

### Patient Payments view

Show total paid, amount owed to the clinic, unallocated/on-account
balance, patient credit when applicable, and a chronological history of
charges, payments, and refunds. Keep charges distinct from received
money. Deposits must not be counted twice when later allocated to a
visit.

### Record payment

-   Provide **Record Payment** from patient and relevant visit screens.
-   Preselect the patient when launched from their record.
-   Allow payment to remain unallocated/on-account if the clinic
    workflow permits.
-   Refresh balances after successful payment.
-   Enforce backend permissions for ledger reads, payment recording, and
    refunds.

## 8. Expenses and financial reporting

### Expenses

Record clinic expenses such as supplies and external purchases. Include
date, amount, category, description, payment method if relevant, and
recording user. Correct financial records through auditable changes;
restrict deletion of history.

### Daily closing and summaries

Authorized users may view: - Daily payments received by method -
Deposits and outstanding balances - Refunds - Expenses - Daily
cash-closing summary - Monthly financial summary - Clear separation of
charges, money collected, refunds, and expenses

Define each metric and calculation. Prevent double-counting of deposits
and allocations.

### Optional accounting export

-   Export an authorized date range to CSV, with preview counts/totals
    and documented columns/date/number formats.
-   Include charges, payments, refunds, and expenses according to a
    documented schema; do not conceal real differences between charges
    and payments.
-   Protect exports as sensitive files; no public download URLs.
-   This feature may be delivered after core workflows.

**Absolute tax restriction:** no tax/VAT functionality anywhere: no tax
IDs, rates, calculations, fields, reports, fiscal country presets, tax
invoice logic, or tax-related UI. Do not seed tax types or invoice
series.

## 9. First-run setup and onboarding

### Setup wizard

1.  Create the first Admin account.
2.  Enter clinic name and basic details.
3.  Confirm timezone (`Africa/Cairo`) and currency (EGP), both
    configurable.
4.  Configure working hours and default appointment duration.
5.  Create doctor and receptionist accounts.
6.  Configure optional email delivery.
7.  Optionally register the first patient.

Do not require a tax ID or tax configuration. All user-facing text is
English only.

### Seeded defaults

Seed only useful non-sensitive defaults: appointment durations, basic
expense categories, payment methods, and appointment statuses. Do not
seed demo patients, fake clinical reports, fake payments, tax data,
dental catalogs, or production credentials. Seeding must be idempotent.

Setup should still complete if optional email is not configured; show a
clear warning instead.

### Getting-started card

An Admin dashboard checklist may cover clinic details, working hours,
doctor accounts, receptionist account, appointment settings, optional
email, and optional first patient. Checklist state must reflect real
backend data.

### Invitations and password setup

Optional one-time password setup links must expire, be single-use, be
revocable, and never be logged with their tokens. Admin can create
accounts without SMTP. Rate-limit public password setup endpoints.

## 10. Notifications

-   Support SMTP through Nodemailer and optional Microsoft Graph API.
-   Email is optional; core clinic operations must work when email is
    unavailable.
-   Store credentials in environment variables or an approved secrets
    mechanism.

### Daily doctor schedule

Optionally send each doctor a morning summary containing only their own
appointments and the minimum operational patient information required.
Distinguish new/returning patients only when known reliably. Do not
include full reports, sensitive findings, or images by default. Enforce
doctor ownership in background queries.

### Financial and operational summaries

Monthly financial summaries go only to explicitly authorized recipients.
Optional daily/weekly summaries must respect roles and doctor-level
access. Avoid sensitive details in logs and apply retry limits.

## 11. Optional future online booking

Not required for launch and must not delay core clinic workflows. -
Public available-slot grid. - Short-lived signed hold token. - Explicit
confirmation through a secure link. - Optional manual review queue for
online requests. - Configurable reminders. - No online payments in the
initial version; no patient portal account required.

Never expose the patient directory or clinical data publicly. Recheck
availability when confirming; define hold expiry/cancellation; use rate
limiting. Implement only after clinic approval.

## 12. UI and accessibility

-   English-only user interface and content; left-to-right only.
-   No language switcher, translation catalogs, Arabic UI, or RTL
    support.
-   Use the approved Radix UI primitives and Lucide React; avoid mixing
    component libraries without a documented need.
-   Short forms, keyboard navigation, visible focus, accessible labels,
    clear validation and loading/error states.
-   Avoid nested modals for core reception workflows.
-   Test desktop, tablet, and narrow mobile screens.
-   Use consistent local date/time and EGP formatting.
-   No dental imagery, tooth charts, dental terminology, or
    dental-specific navigation.

## 13. Audit, privacy, and reliability

-   Audit role/account changes, report finalization/amendments,
    payments/refunds, expense changes, appointment overrides, and
    sensitive admin actions.
-   Never log passwords, JWTs, invitation tokens, full clinical reports,
    or unnecessary sensitive data.
-   Validate API inputs with Zod and authorize every endpoint and file
    download.
-   Use database transactions for operations that must remain
    consistent.
-   Protect against concurrent booking and duplicate submissions.
-   Add health checks for web, backend, and database services.
-   Document and test backups/restores for PostgreSQL and uploaded
    files.
-   Keep secrets out of source control; provide `.env.example` with
    placeholders only.

## 14. Suggested API surface

Exact route names can be refined during implementation, but behavior and
permissions must remain equivalent.

  --------------------------------------------------------------------------------------
  Area                    Example endpoint                      Purpose
  ----------------------- ------------------------------------- ------------------------
  Auth                    `POST /api/v1/auth/login`             Login

  Auth                    `POST /api/v1/auth/refresh`           Refresh tokens

  Auth                    `POST /api/v1/auth/logout`            End/revoke session

  Setup                   `GET /api/v1/setup/status`            Check setup state

  Setup                   `POST /api/v1/setup`                  Bootstrap Admin and
                                                                clinic

  Users                   `/api/v1/users`                       Admin-managed accounts
                                                                and roles

  Patients                `GET /api/v1/patients?search=`        Search demographics

  Patients                `POST /api/v1/patients`               Create patient

  Appointments            `/api/v1/appointments`                List/create/update
                                                                appointments

  Queue                   `/api/v1/queue`                       Manage today's queue

  Visits                  `/api/v1/visits`                      Doctor-owned visits

  Reports                 `/api/v1/reports`                     Draft/finalize/version
                                                                reports

  Files                   `/api/v1/files/:id`                   Authorized file access

  Payments                `/api/v1/payments`                    Record/list authorized
                                                                payments

  Ledger                  `/api/v1/patients/:id/ledger`         Patient payment ledger

  Refunds                 `/api/v1/payments/:id/refund`         Authorized refund

  Expenses                `/api/v1/expenses`                    Expenses

  Financial reports       `/api/v1/financial-reports/*`         Authorized summaries

  Export                  `/api/v1/accounting-export/preview`   Preview export

  Export                  `/api/v1/accounting-export/run`       Generate protected CSV
  --------------------------------------------------------------------------------------

These are proposed contracts, not a requirement to implement every
endpoint before the core workflow works.

## 15. Testing and acceptance criteria

### Patients and booking

-   Select existing patients and create new patients inline.
-   Name split remains editable; phone is optional.
-   Duplicate phone shows a soft warning and allows selecting the
    existing patient.
-   Failed creation preserves entered values.
-   Users without patient-write permission cannot create patients via UI
    or direct API.
-   Concurrent overlapping bookings for one doctor cannot both succeed.
-   Different doctors may have simultaneous appointments when their
    schedules permit.
-   Validate mobile layout and keyboard flow.

### Clinical privacy

-   Doctor A cannot access Doctor B's reports, measurements, notes,
    images, or report versions by changing IDs.
-   Reception cannot access clinical content through endpoints, search,
    exports, or file routes.
-   Admin clinical access is denied unless explicit permission is
    granted.
-   Final reports cannot be silently overwritten; amendments preserve
    versions and audit history.
-   Emails/background jobs cannot leak another doctor's data.

### Finance and setup

-   Deposits and allocations are not double-counted.
-   Partial payments and refunds update balances correctly.
-   Daily closing reconciles according to documented rules.
-   Exports respect date range and user permissions.
-   No tax fields, calculations, routes, UI, or seed data exist.
-   Setup/seeding is idempotent.
-   Docker Compose, Nginx proxying, persistent storage, backups, and
    restores are tested.
-   No existing project, database, volume, or Git history is modified.

## 16. Delivery phases

### Phase 1 --- Core launch

-   React/Express project skeleton, Docker Compose, Nginx, PostgreSQL,
    Prisma migrations
-   Authentication, users, roles, backend authorization
-   Patient records and quick patient creation in appointment modal
-   Agenda, schedules, conflict prevention, waiting queue
-   Ultrasound visits and structured report
    drafting/finalization/version history
-   Protected image/document uploads
-   Payments, patient ledger, expenses, daily/monthly summaries
-   English-only responsive UI, audit logs, tests, backup/restore
    documentation

### Phase 2 --- Operational enhancements

-   Email configuration and per-doctor daily schedule emails
-   Monthly authorized financial summaries
-   CSV accounting export
-   Onboarding improvements and operational analytics

### Phase 3 --- Optional integrations

-   GE Voluson Performance 18 integration after capability verification
-   Public hold-and-confirm booking after explicit product approval
-   Secure remote access after deployment/security review
-   AI-assisted drafting only if approved later. It must never invent
    findings/measurements; outputs remain drafts until doctor review and
    approval, with the same access controls as normal clinical records.

## 17. Explicitly prohibited or out of scope

-   Dental features: odontograms, teeth/surfaces, dental treatment
    catalogs/plans, dental-specific roles, or dental reports.
-   Any non-English UI, language switcher, translations, Arabic content,
    or RTL layout.
-   Tax/VAT functionality, tax IDs/calculations/reports, fiscal country
    presets, or tax invoice compliance.
-   Active Directory/LDAP as a required login dependency.
-   Reuse or modification of any existing project or database.
-   Claiming automatic InstaPay verification without a verified
    integration.
-   Assuming DICOM or automatic device integration without verifying the
    GE device.
-   Public access to medical files or clinical records.
-   AI-generated final reports without doctor review.
-   Multi-tenant SaaS infrastructure in the initial release unless
    separately approved.

**Implementation principle:** Build a reliable, secure clinic workflow
first. Prefer small, testable modules and explicit permissions over
copying the source project's architecture or adding unrelated features.
