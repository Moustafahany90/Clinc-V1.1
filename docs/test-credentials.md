# Test Accounts & Role Accounts

The repository does **not** contain passwords. Create or reset the local test
accounts with a password you supply at runtime:

```bash
# backend/
$env:SEED_TEST_PASSWORD = '<strong-password>'       # PowerShell
$env:SEED_TEMP_PASSWORD = '<different-strong-password>'
npm run seed:test-users
```

```bash
# bash / macOS
SEED_TEST_PASSWORD='<strong-password>' \
SEED_TEMP_PASSWORD='<different-strong-password>' \
npm run seed:test-users
```

The command refuses to run when `NODE_ENV=production` unless
`ALLOW_TEST_SEED=true`; it never prints the password. Seeding only development
or CI databases is allowed. If a password is ever committed or shared, rotate it
immediately (see [SECURITY.md](../SECURITY.md)).

## Pre-Configured Accounts

| Role | Email | Full Name | Notes |
|------|-------|-----------|-------|
| **ADMIN** | `admin@ultrasound.clinic` | Amina Hassan | User management, settings, finance, audit. Clinical access must be granted explicitly. |
| **DOCTOR** | `doctor@ultrasound.clinic` | Dr. Youssef Kamal | Clinical records scoped to this doctor; finalize, amend and WhatsApp finalized reports. |
| **DOCTOR (2)** | `doctor2@ultrasound.clinic` | Dr. Mariam Farouk | Used to verify cross-doctor isolation. |
| **RECEPTIONIST** | `reception@ultrasound.clinic` | Nour Reception | Patients, appointments, queue, billing. No clinical access. |
| **TEMP USER** | `temp.user@ultrasound.clinic` | Tarek Ibrahim | Starts with `mustChangePassword: true`; the API blocks everything except changing the password. |

## Role Permissions Reference

### ADMIN
`PATIENTS_READ`, `PATIENTS_WRITE`, `APPOINTMENTS_READ`, `APPOINTMENTS_WRITE`,
`APPOINTMENTS_OVERRIDE`, `QUEUE_READ`, `QUEUE_WRITE`, `PAYMENTS_READ`,
`PAYMENTS_WRITE`, `REFUNDS_WRITE`, `EXPENSES_READ`, `EXPENSES_WRITE`,
`FINANCE_READ`, `FINANCE_EXPORT`, `USERS_MANAGE`, `SETTINGS_MANAGE`,
`AUDIT_READ`, `VISITS_OVERRIDE`.

Clinical permissions (`CLINICAL_READ`, `CLINICAL_WRITE`, `REPORTS_FINALIZE`, `REPORTS_SEND`)
are never implied by the `ADMIN` role. Schedule and visit overrides are
explicit capabilities; grant them only to staff who are authorised to use them.

### DOCTOR
`PATIENTS_READ`, `APPOINTMENTS_READ`, `QUEUE_READ`, `CLINICAL_READ`,
`CLINICAL_WRITE`, `REPORTS_FINALIZE`, `REPORTS_SEND`. Doctors can only access visits and reports
they own.

### RECEPTIONIST
`PATIENTS_READ`, `PATIENTS_WRITE`, `APPOINTMENTS_READ`, `APPOINTMENTS_WRITE`,
`QUEUE_READ`, `QUEUE_WRITE`, `PAYMENTS_READ`, `PAYMENTS_WRITE`. Cannot read or
write clinical records, and cannot override the clinic schedule.

## Verification Scenarios

### Token Invalidation
- Logout blacklists the access token's `jti` until it expires.
- Changing/resetting a password, archiving/restoring an account, and completing
  password setup increment `User.tokenVersion`; all previously issued access
  tokens stop working immediately, even before their 15-minute expiry.
- Refresh-token rotation and reuse detection revoke the whole token family.

### Forced Password Change
1. Sign in with the temporary-password account.
2. Login and refresh responses return `user.mustChangePassword: true`.
3. The SPA redirects to `/account`; the API also returns
   `403 PASSWORD_CHANGE_REQUIRED` for every protected endpoint except
   `/auth/me`, `/auth/change-password`, `/auth/logout`, and session listing.
4. Changing the password issues a new access token and refresh cookie and
   invalidates the old access token immediately.

### Report Immutability
- A finalized report cannot be edited; corrections create a new
  `ReportVersion` with a reason and a new version number.
- Measurements and attachments are locked once the visit is completed.
- Completed visit metadata is locked; correct the report through an amendment.

### Clinician Report Print Flow
- `GET /api/v1/reports/:id/print-data` requires `CLINICAL_READ` and ownership.
- The print page renders the pinned template snapshot as A4.

## Session Management Endpoints
- `GET /api/v1/sessions` or `GET /api/v1/auth/sessions`
- `DELETE /api/v1/sessions/:id` or `DELETE /api/v1/auth/sessions/:id`
- `GET /api/v1/admin/sessions` (administrator only)
- `DELETE /api/v1/admin/sessions/:id` (administrator only)
