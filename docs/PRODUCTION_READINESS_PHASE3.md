# Production Readiness — Phase 3: Clinical & Financial Workflow Audit (2026-11-17)

## 1. Scope and constraints

This audit exercised the real HTTP API (`createApp` + `fetch`) against synthetic patients, appointments, visits, reports, charges, payments, refunds, expenses and report deliveries. It covered:

- patient management (create, duplicate detection, update, ledger);
- appointments (availability, closures, transitions, billing-once, walk-in path already covered by existing tests);
- the complete clinical workflow: visit → measurements → draft report → finalize → complete visit → amend;
- report architecture: standard, gyn4d and JSON block templates; template validation/preview; print-data, document HTML and PDF generation;
- historical immutability: version snapshots, finalized locks, amendment reasons and audit entries;
- financial workflows: ledger, daily/monthly reports, clinic position, statement, accounting export (preview + CSV), deposits, voids, refunds, idempotency and atomicity;
- WhatsApp delivery with an in-process mock of the Evolution API (no real messages sent);
- concurrency of refunds, allocations, charge voids, report creation and slot booking.

**Safety constraints honoured:** only disposable PostgreSQL databases whose names end in `_test` were used; every destructive suite refuses to start otherwise. No production DB was touched. No deployment or real WhatsApp send was performed. All pre-existing modified/untracked files were preserved; the only source files changed are listed in section 8.

## 2. Environment and database setup

- Local PostgreSQL container `ultrasound-clinic-db-1`, host port `55432`, user `clinic_app`.
- Baseline DB: `ultrasound_clinic_phase3_test`.
- Final verification DB: `ultrasound_clinic_phase3_final_test`, created with `CREATE DATABASE ultrasound_clinic_phase3_final_test;` and provisioned with `npx prisma migrate deploy`.
- Migration result: **7 migrations found, 7 applied, 0 pending, all successfully applied.** Applied migrations: `20261026085618_init`, `20261029120000_add_token_blacklist`, `20261030120000_report_template_pinning`, `20261031120000_token_version_and_override_permissions`, `20261101120000_report_whatsapp_delivery`, `20261102120000_patient_referring_doctor`, `20261113135000_remove_email_delivery`.
- Test command: `cd backend; node --test --test-concurrency=1 --import tsx tests/*.test.ts` (identical to `npm test`).
- `npm run typecheck` passed after all fixes. There is no lint script in `backend/package.json`.

## 3. Test inventory

| Suite | Origin | Tests |
|---|---|---:|
| Existing backend suites (14 files) | pre-existing | 127 |
| `phase3-clinical-workflow.test.ts` | added in Phase 3 | 3 |
| `phase3-concurrency.test.ts` | added in Phase 3 | 5 |
| `phase3-financial-workflow.test.ts` | added in Phase 3 | 3 |
| `phase3-whatsapp.test.ts` | added in Phase 3 | 3 |
| **Total** | | **141** |

The six existing suites most relevant to this phase (`reportBlocks`, `report-templates`, `service-revenue`, `security-hardening`, `whatsapp-delivery`, `authorization-idor`) were retained unchanged and are included in the 127 baseline tests.

## 4. Clinical workflow results

`phase3-clinical-workflow.test.ts` covers:

- **Patient management:** duplicate detection by normalized phone, explicit acknowledgement override, raw display phone vs. stored normalized digits, demographics update, patient-number issuance and zero-balance ledger. Result: pass.
- **Appointments:** clinic-closure exception blocks booking, removal reopens the slot, booked deposit creates one charge and one payment with the deterministic `booking:<appointmentId>` idempotency key, overlapping slot is rejected with 409, agenda marks the slot occupied, `BOOKED → CONFIRMED → ARRIVED → WAITING → IN_EXAM → REPORT_REVIEW → DONE` transitions are accepted with a complete `AppointmentStatusHistory`, and `BOOKED → DONE` is rejected. Result: pass.
- **Visit → report:** one visit per appointment, one report per visit, measurement capture, DRAFT → IN_REVIEW on report creation, finalized report locks subsequent PATCH/DELETE and visit edits/measurements, second finalize returns 409, completion drives visit and appointment to `COMPLETED`/`DONE`. Result: pass.
- **Amendment/historical immutability:** v1 and v2 `ReportVersion` rows are retained with their full content snapshots and amendment reason; the current content moves to v2 while v1 remains unchanged; print-data exposes the current version. Result: pass.

## 5. Report rendering, HTML and PDF results

- Block definitions are parsed with `templateDefinitionSchema` and validated with `validateDefinition`; editable fields are derived into string and string-array shapes by `buildInitialContent`.
- Twin reports use ordinary unique keys (`firstTwin`, `secondTwin`); duplicating a key is reported by the validation endpoint as an error. No special twin validator exists or is needed.
- Client-supplied content for a block template is ignored at creation; template defaults win.
- `/reports/templates/preview` and `/reports/:id/document?mode=print` emit `@page{size:Letter...}`, contain no `<script>` or `allow-scripts` token, escape injected HTML (`<script>` and `<img src=x>` become inert text), and carry `Cache-Control: no-store`. Print HTML has no `contenteditable` outside `<style>`; edit HTML retains `data-key` fields for the host application.
- Frontend iframes use `sandbox="allow-same-origin allow-modals"` (no `allow-scripts`), matching the requirement that report HTML never executes scripts.
- `renderReportPdf` produces a valid `%PDF` file with exactly one `612 × 792` US Letter page for a normal report and at least two pages for a deliberately long report (pagination instead of clipping). Backend HTML→PDF disables JavaScript and aborts all non-`data:` requests.
- Result: pass. There is no standalone HTTP PDF download route in the backend; PDF bytes are generated in-process during the WhatsApp send.

## 6. WhatsApp results (provider mocked)

- Generic network failures map to `WHATSAPP_NETWORK_ERROR` and do not leak the recipient number in the error message.
- Four concurrent first-send requests produce exactly one `200`, three `409` conflicts and exactly one provider `sendMedia` call; the single delivery row is `SENT`, version 1, attempts 1.
- After an amendment, a new send creates a separate version-2 delivery and a filename ending `-v2.pdf`; deliveries for versions 1 and 2 coexist.
- Evolution API traffic is intercepted in-process; no real WhatsApp message was sent.

## 7. Financial verification results

- Independently recomputed expected totals (charges 15,000; payments 12,000; refunds 2,000; allocated 12,000; outstanding 3,000; unallocated −2,000; balance 5,000 piasters) matched the patient ledger, all-time position, daily report, monthly totals, statement and export preview.
- Daily totals: billed 15,000, collected 10,000, net cash 8,500 after a 1,500 expense. Statement row counts and signed refund row (−2,000) matched.
- CSV export: UTF-8 BOM, CRLF, quoted cells, exact 10-column schema and five transaction rows; refund and expense amounts are numeric signed values (`-2000`, `-1500`).
- Invalid operations (allocation over payment, duplicate charge in one payment, allocation over charge, missing method reference, over-refund, void of a settled charge, repeated expense void) return 4xx and leave the ledger unchanged.
- Payment and expense idempotency keys prevent duplicates; unallocated deposits increase patient credit exactly once; voided charges are excluded from billed totals while the original record is preserved.

## 8. Confirmed defects and fixes

| # | Severity | Defect | Fix | File |
|---|---|---|---|---|
| 1 | High | Concurrent full refunds both read the pre-refund total before taking the ledger lock, allowing refunds to exceed the payment amount. | Resolve the payment's `patientId` first, acquire `lockLedger`, then re-read payment and refunds inside the transaction before computing the cap. | `backend/src/modules/payments/routes.ts` |
| 2 | High | Two simultaneous report creations for one visit both passed the pre-check, creating duplicate reports. | Take a transaction-scoped `pg_advisory_xact_lock(hashtext('report-visit:'+visitId))` and re-check for an existing report inside the transaction. | `backend/src/modules/reports/routes.ts` |
| 3 | High | Charge void could race a payment allocation: a VOID charge could retain or receive an allocation. | Move the void into a transaction, take the patient ledger lock, and re-read the charge and its allocations before deciding. | `backend/src/modules/payments/routes.ts` |
| 4 | Medium | Accounting CSV escaped negative amounts as `"'-2000"` via the formula-injection guard, breaking numeric import/reconciliation. | Use a dedicated `csvNumber` helper for the amount column so validated integer amounts keep their sign while other cells stay guarded. | `backend/src/modules/financial/routes.ts` |
| 5 | Low | `docs/finance-rules.md` documented the ledger balance sign backwards; a source comment repeated the error. | Corrected both to state that positive means the patient owes the clinic and negative means unallocated credit. | `docs/finance-rules.md`, `backend/src/modules/financial/routes.ts` |
| 6 | Informational (test infrastructure) | The cached Playwright renderer kept a single-file test process alive after block-template PDF tests, preventing suite completion. | Added and called `closeHtmlPdfBrowser()` during teardown of the new clinical suite. | `backend/src/lib/htmlPdf.ts`, `backend/tests/phase3-clinical-workflow.test.ts` |

Before fixes, the concurrency regression suite reproduced the defects: concurrent refunds succeeded twice, six duplicate report creations returned 201, and all six charge-void rounds allowed a void plus a retained allocation. After fixes the same suite passes 5/5. The CSV defect was reproduced by the financial suite (`"'-2000" !== '-2000'`) and passes after the fix.

## 9. Modified and added files

Changed by this Phase 3 audit (all changes remain uncommitted):

- `backend/src/modules/payments/routes.ts` — refund lock order, charge-void transaction.
- `backend/src/modules/reports/routes.ts` — per-visit report-creation advisory lock.
- `backend/src/modules/financial/routes.ts` — CSV numeric amount helper, corrected balance comment.
- `backend/src/lib/htmlPdf.ts` — added `closeHtmlPdfBrowser()` so the shared Chromium renderer can be closed during test teardown; this fixed a suite hang after block-template PDF tests and made the full combined run possible.
- `docs/finance-rules.md` — corrected ledger balance sign.
- `backend/tests/phase3-clinical-workflow.test.ts` — new (3 tests).
- `backend/tests/phase3-concurrency.test.ts` — new (5 tests).
- `backend/tests/phase3-financial-workflow.test.ts` — new (3 tests).
- `backend/tests/phase3-whatsapp.test.ts` — new (3 tests).
- `docs/PRODUCTION_READINESS_PHASE3.md` — this report.

All other modified/untracked files in `git status` predate this audit and were left untouched (including `report-blocks/`, `gyn4d.ts`, report templates/endpoints, finalized historical reports and the quick-actions work).

## 10. Results, blockers and severity classification

### Verified test results

- Baseline (fresh `ultrasound_clinic_phase3_test`, 7 migrations applied): **127/127 passed**, 0 failed, 0 skipped, 81.5 s.
- New clinical suite: **3/3 passed** (duplicates/normalization, appointments and status history, visit→report→amend, block validation/HTML/PDF).
- New concurrency suite: **5/5 passed** after the fixes (before fixes: two refund successes, six 201 duplicate reports, and 6/6 charge-void races).
- New financial suite: **3/3 passed** after the CSV fix (before fix: `"'-2000" !== '-2000'`).
- New WhatsApp suite: **3/3 passed**.
- Typecheck: `npm run typecheck` passed with no errors.

Full combined suite on the freshly provisioned `ultrasound_clinic_phase3_final_test` (7/7 migrations applied): **141 tests, 141 passed, 0 failed, 0 cancelled, 0 skipped, 0 todo, 129.97 s**. Breakdown: 127 pre-existing + 14 new (clinical 3, concurrency 5, financial 3, WhatsApp 3). This is the final consolidated result.

### Residual observations and blockers

- **Low / robustness:** under eight-way contention, some loser requests returned Prisma `P2028` transaction-timeout errors instead of a clean 4xx. In every observed case the invariant held (exactly one refund/allocation succeeded, no over-refund or over-allocation). This is a client-visible error-quality issue, not data corruption; a retry/backoff or wider transaction budget can be addressed in a later phase.
- **Low / schema hardening (carried forward from Phase 2):** several amount/status invariants rely on application validation and Zod rather than DB-level `CHECK` constraints. The application-level locks applied here close the observed races without a risky migration; DB constraints remain a separate, backward-compatible migration project.
- **Informational:** no standalone HTTP PDF endpoint exists; PDF is produced during WhatsApp send. Frontend iframe sandboxing was verified from source (`allow-same-origin allow-modals`, no `allow-scripts`), not via a browser E2E test.
- **No Phase 3 blocker remains** for the confirmed defects above. Deployment, dependency/vulnerability scanning and production verification are outside this phase's scope.

**Phase 3 status:** complete pending review. Do **not** proceed to Phase 4 without explicit approval of this report.
