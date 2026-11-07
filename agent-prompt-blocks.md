# Task: replace hardcoded report layouts with a block-based, editable template system

You are working inside an existing clinic management system (ultrasound clinic).
- **Frontend:** React + TypeScript + Tailwind (`lucide-react`, internal `components/ui`).
- **Backend:** Express + Zod + Prisma (ESM, relative imports use the `.js` suffix).

## 1. Goal
The clinic has 10 report designs (gynecology, first trimester, mid-trimester, twins, fetal echo, ...). Today each design would need its own print code. The new system defines every report as a **JSON list of blocks** (title, section, text, list, table, anatomy checklist...), rendered by **ONE renderer** that produces:
- the **editable report screen** (the doctor fills the report directly on the page layout),
- the **print preview**,
- the **PDF sent over WhatsApp** (Chromium).

Header, footer and doctor signature are **fixed and identical on every report**. They live in `letterhead.ts` and must NOT become configurable.

A tested core library and the 10 template JSON files are provided. **Your job is integration, not invention.**

## 2. Provided package (`report-blocks.zip`)
```
report-blocks/
  blocks.types.ts      pure types, no dependencies
  blocks.schema.ts     Zod schema (every object is .strict())
  blocks.validate.ts   validateDefinition(), buildInitialContent(), splitTemplate()
  blocks.render.ts     renderReportHtml({ definition, content, system, mode: 'print'|'edit', isDraft })
  letterhead.ts        fixed header / footer / signature text
  letterheadLogo.ts    generated base64 logo (do not edit)
  index.ts             re-exports
  collectContent.ts    frontend helpers: collectContent(), attachEditHandlers()
  selfcheck.ts         standalone tests (run with: npx tsx selfcheck.ts)
  templates/*.json     10 templates: { name, description, definition }
```
File placement:

| From the package | To |
|---|---|
| `blocks.types.ts`, `blocks.schema.ts`, `blocks.validate.ts`, `blocks.render.ts`, `letterhead.ts`, `letterheadLogo.ts`, `index.ts` | backend `src/lib/report-blocks/` |
| `templates/*.json` | backend `prisma/report-templates/` (or the folder your seed script uses) |
| `blocks.types.ts` (copy) | frontend `src/lib/reportBlocks.types.ts` |
| `collectContent.ts` | frontend `src/lib/collectContent.ts` |
| `selfcheck.ts` | port into the project's test framework (see Phase 1) |

## 3. How the block system works (read before coding)
- A template definition is `{ schemaVersion: 1, baseSize?, blocks: Block[] }`. It is stored in `ReportTemplate.layout.definition` together with `layout.printLayout = 'blocks'`. **No database migration is needed** (`layout` and `fields` are JSON columns).
- Values are bound to string keys. Inside any `template` string: `{{key}}` is an editable inline field (configured in the sibling `fields` map) and `**...**` toggles bold. Keys are unique per template and are the same keys used in `Report.currentContent`.
- Value shapes in `currentContent`: normal field = `string`; `freeList` = `string[]`; `checklistTable` = `Record<string, string>` keyed `"rowKey.columnKey"`.
- `validateDefinition(def)` returns `{ ok, errors, fields }`. `fields` is the **derived** `DerivedField[]`. For a block template the server ALWAYS derives `ReportTemplate.fields` from the definition and ignores any client-supplied `fields`.
- `buildInitialContent(fields)` builds the default content of a new report.
- **Edit mode contract** (the HTML has no scripts): the host page loads the HTML in a same-origin sandboxed `iframe srcdoc`, reads values back with `collectContent(doc, base)` and wires paste/Enter behaviour with `attachEditHandlers(doc, onChange)`.
- Reports are pinned to the template version through the existing `templateSnapshot`. The snapshot already copies `layout`, so it now carries the definition. Old reports never change when a template is edited.

## 4. Working rules
1. **Start with a written plan** (Phase 0) before changing any file: every file to create/change with one line each, plus any assumption or path difference you found.
2. **No over-engineering.** Only what is listed here. No new abstractions, no unrelated refactors or formatting changes, no new dependencies (Zod and Playwright should already be installed; verify). No migrations.
3. **Do not modify the files in `report-blocks/`** except import paths. If you find a bug, fix it minimally, re-run the self-check, and list it in your report with the reason. Do not silently change behaviour.
4. Existing behaviour must stay identical: templates without `printLayout = 'blocks'` (standard templates and the legacy `gyn4d` layout) keep working exactly as before. Do **not** delete `gyn4d.ts` or its endpoint in this task.
5. After each phase run: type-check (backend and frontend), lint, and the existing tests. Fix what you broke. Never skip or delete a failing test.
6. Follow the project's conventions (`asyncHandler`, `parseBody`, `AppError` helpers, auditing, naming).
7. If a snippet below does not match the real code, adapt minimally and **list the deviation**. Do not guess silently.
8. Never use real patient data. Use obviously fake data in tests. Never log clinical content.
9. **Stop at the gates** marked STOP and wait for my "continue".

---

## Phase 0: Preflight (read only), then write the plan
Check and report:
1. **Prerequisite:** the earlier `gyn4d` task must already be merged: `lib/gyn4d.ts`, `GET /reports/:id/print-html`, helper `buildPdfInput`, `renderReportPdf` branch for `printLayout === 'gyn4d'`, `Gyn4dPrintView`. If something is missing, STOP and tell me. Do not implement it here.
2. Zod version, Playwright installed, test framework (vitest/jest/none), where seeds live.
3. Any Content-Security-Policy (Helmet or nginx). The editor and print views use `iframe srcDoc`, which inherits the page CSP, and the HTML needs inline `<style>` and `data:` images. **Report what you find; do not loosen a CSP on your own.**
4. Dockerfile: Chromium and fonts availability (`fonts-urw-base35`, `fonts-noto-core`).

Output: the plan, then continue to Phase 1 without waiting.

## Phase 1: Core library and tests
1. Copy the files to the locations in section 2. Fix import paths only.
2. In `lib/gyn4d.ts` (legacy), change `.hdr img{width:2.22in;height:auto;...}` to `.hdr img{width:2.22in;height:1.185in;...}` (matches the original Word header, prevents the logo overlapping the first table row on page 2). Nothing else in that file.
3. Port `selfcheck.ts` into the project's test framework (or keep it as an `npm run` script if there is none). It must cover: all templates validate, all render in both modes without leftover `{{`, no `<script>`, print HTML has no `contenteditable`, negative cases fail with the expected message, strict schema rejects unknown keys, HTML escaping.
4. **Gate:** self-check passes on the project's TypeScript config. If the strict `_schemaMatchesTypes` check fails with your Zod version, report it.

## Phase 2: Backend integration

### 2.1 Types
Backend `lib/reportTypes.ts` and frontend `lib/types.ts`:
```ts
// ReportTemplateField
type: 'text' | 'textarea' | 'number' | 'date' | 'select' | 'list' | 'checklist';
options?: string[];
defaultValue?: string | string[] | Record<string, string>;

// ReportTemplateLayout
printLayout?: 'default' | 'gyn4d' | 'blocks';
definition?: TemplateDefinition;   // from report-blocks types
```

### 2.2 `reports.ts` validation
**Content** (checklist values are `Record<string,string>`):
```ts
const contentSchema = z.record(
  z.string().max(120),
  z.union([
    z.string().max(20_000),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(z.string().max(2_000)).max(50),
    z.record(z.string().max(120), z.string().max(2_000)).refine((r) => Object.keys(r).length <= 400, 'Too many entries'),
  ]),
);
```
**Layout and template:**
```ts
import { templateDefinitionSchema, validateDefinition } from '../../lib/report-blocks/index.js';

const templateLayoutSchema = z
  .object({
    headerNote: z.string().trim().max(500).optional(),
    footerNote: z.string().trim().max(1000).optional(),
    showMeasurements: z.boolean().optional(),
    showSignature: z.boolean().optional(),
    printLayout: z.enum(['default', 'gyn4d', 'blocks']).optional(),
    definition: templateDefinitionSchema.optional(),
  })
  .superRefine((layout, ctx) => {
    if ((layout.printLayout === 'blocks') !== (layout.definition !== undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['definition'], message: 'printLayout "blocks" and a definition must be used together.' });
    }
  });
```
In `templateSchema`, make `fields` **optional** (`templateFieldsSchema.optional()`).

Helper (one place for the formatting):
```ts
function blockErrors(errors: string[]): string {
  const shown = errors.slice(0, 10).join('\n');
  return errors.length > 10 ? `${shown}\n(+${errors.length - 10} more)` : shown;
}
```
**POST `/templates`:**
```ts
let fields = payload.fields as unknown;
if (payload.layout?.printLayout === 'blocks' && payload.layout.definition) {
  const check = validateDefinition(payload.layout.definition);
  if (!check.ok) throw badRequest(blockErrors(check.errors));
  fields = check.fields;             // always derived, client fields ignored
} else if (!payload.fields) {
  throw badRequest('Add at least one section.');
}
// ... store `fields as Prisma.InputJsonValue`
```
**PATCH `/templates/:id`:**
- `const wasBlocks = (existing.layout as { printLayout?: string } | null)?.printLayout === 'blocks'`; `const willBeBlocks = payload.layout === undefined ? wasBlocks : payload.layout?.printLayout === 'blocks'`.
- If `wasBlocks !== willBeBlocks` return 400: `A template cannot be converted between block and standard layouts. Create a new template.`
- If `willBeBlocks`: ignore `payload.fields`; when `payload.layout?.definition` is present validate it and write `fields = check.fields`; when `payload.layout` is absent leave `fields` and `layout` untouched.
- Everything else (default, archive, restore, name, description, service) behaves as today.

**New routes** (permission `SETTINGS_MANAGE`, declared next to the other template routes):
```ts
// POST /templates/validate  body: { definition }  ->  { ok, errors, fieldCount }
// POST /templates/preview   body: { definition }  ->  { html }   (print mode, fake data)
```
Both run `templateDefinitionSchema.safeParse` first (return Zod issues flattened as strings in `errors`), then `validateDefinition`. Preview uses `buildInitialContent(check.fields)`, `system = { 'patient.name': 'Sample Patient', 'patient.dob': '01/01/1990', 'visit.date': '01/01/2026' }`, `mode: 'print'`, `isDraft: false`. Neither route writes to the database.

### 2.3 Initial content on report creation (`POST /reports`)
Make `content` optional in `createReportSchema` (`contentSchema.default({})`). When the chosen template is a block template, **ignore the client content** and use `buildInitialContent(validateDefinition(definition).fields)`; keep today's behaviour for other templates.

### 2.4 Shared Chromium helper
Create `lib/htmlPdf.ts` by moving the browser handling out of `gyn4d.ts`:
```ts
import type { Browser } from 'playwright';

let browserPromise: Promise<Browser> | null = null;
async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = import('playwright').then(({ chromium }) => chromium.launch({ args: ['--no-sandbox'] }));
    browserPromise.catch(() => { browserPromise = null; });
  }
  const browser = await browserPromise;
  if (!browser.isConnected()) { browserPromise = null; return getBrowser(); }
  return browser;
}

export async function renderHtmlToPdf(html: string, format: 'Letter' | 'A4' = 'Letter'): Promise<Buffer> {
  const browser = await getBrowser();
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    await page.route('**/*', (route) => (route.request().url().startsWith('data:') ? route.continue() : route.abort()));
    await page.setContent(html, { waitUntil: 'load' });
    return Buffer.from(await page.pdf({ format, printBackground: true, preferCSSPageSize: true }));
  } finally {
    await context.close();
  }
}
```
`renderGyn4dPdf` becomes `return renderHtmlToPdf(renderGyn4dHtml(input), PAGE_SIZE)`. Behaviour must not change.

### 2.5 PDF and document endpoint
Create `lib/report-blocks/pdf.ts`:
```ts
import type { ReportPdfInput } from '../reportPdf.js';
import { renderHtmlToPdf } from '../htmlPdf.js';
import { renderReportHtml } from './blocks.render.js';

export function systemValues(input: ReportPdfInput) {
  const fmt = (d: Date | null) =>
    d ? new Intl.DateTimeFormat('en-GB', { timeZone: input.clinic.timezone, day: '2-digit', month: '2-digit', year: 'numeric' }).format(d) : '';
  return {
    'patient.name': `${input.patient.firstName} ${input.patient.lastName}`.trim(),
    'patient.dob': fmt(input.patient.dateOfBirth),
    'visit.date': fmt(input.examination.visitDate),
  } as const;
}

export async function renderBlocksPdf(input: ReportPdfInput): Promise<Buffer> {
  const definition = input.report.templateLayout?.definition;
  if (!definition) throw new Error('Block template without a definition');
  const html = renderReportHtml({
    definition, content: input.report.content, system: systemValues(input),
    mode: 'print', isDraft: input.report.status === 'DRAFT',
  });
  return renderHtmlToPdf(html, 'Letter');
}
```
In `renderReportPdf` add, next to the gyn4d branch: `if (input.report.templateLayout?.printLayout === 'blocks') return renderBlocksPdf(input);`.

New endpoint in `reports.ts` (reuse `buildPdfInput`; it already prefers the pinned snapshot layout):
```ts
reportsRouter.get(
  '/:id/document',
  requirePermission('CLINICAL_READ'),
  asyncHandler(async (req, res) => {
    const { id } = parseParams(z.object({ id: uuidSchema }), req);
    const { mode } = parseQuery(z.object({ mode: z.enum(['edit', 'print']).default('print') }), req);
    const me = currentUser(req);
    const report = await prisma.report.findUnique({
      where: { id },
      include: {
        template: true,
        visit: { include: { patient: true, doctor: { select: { firstName: true, lastName: true } }, measurements: true } },
      },
    });
    if (!report) throw notFound('Report not found');
    assertClinicalRead(me, report.doctorId);
    if (mode === 'edit') assertClinicalWrite(me, report.doctorId);
    const input = await buildPdfInput(report);
    const definition = input.report.templateLayout?.definition;
    if (input.report.templateLayout?.printLayout !== 'blocks' || !definition) {
      throw badRequest('This report does not use a block template.');
    }
    const html = renderReportHtml({
      definition, content: input.report.content, system: systemValues(input),
      mode, isDraft: report.status === 'DRAFT',
    });
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(html);
  }),
);
```
`PATCH /:id` (draft save) and `POST /:id/amend` are unchanged: they already accept `content` and enforce draft/finalized rules.

### 2.6 Seed
Idempotent upsert by `name`, using the project's seed mechanism. Validate every file and fail loudly:
```ts
for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
  const { name, description, definition } = JSON.parse(readFileSync(join(dir, file), 'utf8'));
  const parsed = templateDefinitionSchema.parse(definition);
  const check = validateDefinition(parsed);
  if (!check.ok) throw new Error(`${file}: ${check.errors.join('; ')}`);
  const layout = { printLayout: 'blocks', definition: parsed, showMeasurements: false, showSignature: false };
  await prisma.reportTemplate.upsert({
    where: { name },
    update: { description, fields: check.fields as unknown as Prisma.InputJsonValue, layout: layout as unknown as Prisma.InputJsonValue, isActive: true },
    create: { name, description, fields: check.fields as unknown as Prisma.InputJsonValue, layout: layout as unknown as Prisma.InputJsonValue, isActive: true, isDefault: false },
  });
}
```
Note: the "4D Gynecology Scan" template already exists from the previous task (legacy `gyn4d`). The upsert converts it to the block version. Field keys are identical, and existing reports keep their pinned snapshot, so they still render through the legacy `gyn4d` branch. That is why the legacy branch must stay.

### 2.7 STOP: gate 1 (backend)
Run and report the result of each item:
1. Type-check, lint, existing tests, self-check.
2. Run the seed. List the 10 templates with their derived field counts.
3. For each of the 10 templates, with fake data: create a report through the API, then `GET /reports/:id/document?mode=print` (200, HTML, no `{{`), `mode=edit` (200, contains `contenteditable`), and `renderReportPdf` returns a non-empty PDF (page count > 0).
4. Escaping: save `<script>alert(1)</script>` into a text field through `PATCH /reports/:id`, then confirm both HTML modes contain the escaped text and no executable tag.
5. Validation errors: `POST /reports/templates/validate` with a duplicate key, an orphan field and a bad table span returns readable messages.
6. A standard (non-block) template and the legacy gyn4d report still print as before.
7. `PATCH` that tries to convert a block template to a standard one returns 400.

**Wait for "continue" before starting Phase 3.**

---

## Phase 3: Frontend

### 3.1 `components/ReportDocumentFrame.tsx`
```tsx
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { attachEditHandlers, collectContent } from '../lib/collectContent';
import { Alert, LoadingBlock } from './ui';

export interface ReportDocumentHandle {
  getContent(base?: Record<string, unknown>): Record<string, unknown>;
  print(): void;
}
interface Props { reportId: string; docKey: string; mode: 'edit' | 'print'; onDirty?: () => void }

export const ReportDocumentFrame = forwardRef<ReportDocumentHandle, Props>(function ReportDocumentFrame(
  { reportId, docKey, mode, onDirty }, ref,
) {
  const frame = useRef<HTMLIFrameElement | null>(null);
  const cleanup = useRef<(() => void) | null>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [height, setHeight] = useState(1100);

  useEffect(() => {
    let cancelled = false;
    setHtml(null);
    setError(null);
    api
      .get<string>(`/reports/${reportId}/document`, { params: { mode }, responseType: 'text', transformResponse: (raw) => raw })
      .then((res) => !cancelled && setHtml(res.data))
      .catch((err) => !cancelled && setError(errorMessage(err)));
    return () => { cancelled = true; };
  }, [reportId, docKey, mode]);

  useEffect(() => () => cleanup.current?.(), []);

  function onLoad() {
    cleanup.current?.();
    const doc = frame.current?.contentDocument;
    if (!doc) return;
    const resize = () => setHeight(doc.documentElement.scrollHeight + 8);
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(doc.body);
    const detach = mode === 'edit' ? attachEditHandlers(doc, () => { onDirty?.(); resize(); }) : () => undefined;
    cleanup.current = () => { observer.disconnect(); detach(); };
  }

  useImperativeHandle(ref, () => ({
    getContent: (base = {}) => {
      const doc = frame.current?.contentDocument;
      return doc ? collectContent(doc, base) : base;
    },
    print: () => frame.current?.contentWindow?.print(),
  }), []);

  if (error) return <Alert tone="danger">{error}</Alert>;
  if (html === null) return <LoadingBlock label="Preparing the report…" />;
  return (
    <iframe
      ref={frame}
      title="Report"
      srcDoc={html}
      onLoad={onLoad}
      sandbox="allow-same-origin allow-modals"
      style={{ height }}
      className="mx-auto block w-[8.5in] max-w-full border-0 bg-white"
    />
  );
});
```
Adapt names to the project's `api`/`ui` modules. The iframe has **no `allow-scripts`**; keep it that way.

### 3.2 `ReportEditorPage`
- `usesBlocks = (report.templateSnapshot?.layout ?? report.template?.layout)?.printLayout === 'blocks'`.
- When `usesBlocks`, replace the "Report content" card body (the field form) with `<ReportDocumentFrame mode={editableNow ? 'edit' : 'print'} docKey={`${report.id}:${report.versionNumber}`} ... />`. **`docKey` must NOT include `updatedAt`**, otherwise saving a draft reloads the iframe and the doctor loses the caret. The other cards (patient, attachments, versions, delete, WhatsApp, finalize, amend) stay untouched.
- `buildContent()`: for block templates return `docRef.current?.getContent(report.currentContent) ?? report.currentContent`; keep the existing code for other templates.
- `createReport`: for a block template send `content: {}` (the server builds the defaults). Keep today's logic for other templates.
- Draft save, finalize and amend keep calling the same endpoints with `buildContent()`.

### 3.3 `ReportPrintPage`
Turn `Gyn4dPrintView` into one generic `HtmlDocumentPrintView` that takes the URL. Use `/reports/:id/print-html` for legacy `gyn4d`, and `ReportDocumentFrame mode="print"` for `printLayout === 'blocks'`. The toolbar button calls the frame's `print()`. All other templates keep the current page.

### 3.4 Template admin (`ReportTemplatesCard`): Builder v1 = JSON + live preview
Keep it small. No drag-and-drop canvas.
- Block templates show a "Blocks" badge. In the edit dialog, **hide the Sections editor** for them and show instead: a monospace `Textarea` with the pretty-printed `layout.definition` JSON, a **Validate** button (`POST /reports/templates/validate`, shows the error list or "OK, N fields"), a **Preview** button (`POST /reports/templates/preview`, shows the returned HTML in an `iframe srcDoc` with the same sandbox), **Import JSON** (file input, fills the textarea; accepts the provided `{ name, description, definition }` files or a bare definition) and **Export JSON** (download).
- "New template" gets a second option, **"New block template"**: name, description, service, JSON textarea, Validate, Preview, Save. A minimal valid starter definition is pre-filled.
- Saving a block template sends `{ name, description, serviceId, isDefault, layout: { printLayout: 'blocks', definition } }` and **no `fields`**. (The old Zod field enum does not know `checklist`.)
- The table's "Sections" column shows the number of derived fields for block templates.
- Standard templates keep the current editor unchanged.

### 3.5 STOP: final report
Run type-check, lint, tests. Manual checks to report (with exact steps taken):
1. Create a report with each block template, fill several fields (inline text, a select, a checklist cell, a `freeList` line added and removed), **Save draft**, reload the page: values persist.
2. Print preview and the WhatsApp PDF (finalized report) match the on-screen layout. Header, footer and signature appear on every page.
3. Finalize, then Amend with a reason: a new version is created, the old one is untouched.
4. A report created before this change (standard template) still opens, edits and prints as before.
5. Builder v1: import one of the JSON files, Validate, Preview, Save; then break the JSON (duplicate key) and confirm the error is clear and nothing is saved.

## 5. Acceptance criteria
- No migration. Existing templates, reports and the legacy `gyn4d` path unchanged.
- The self-check and all existing tests pass.
- Header, footer and signature exist in ONE place (`letterhead.ts`).
- One renderer produces edit, print and PDF output.
- No `<script>` in generated HTML. The iframe has no `allow-scripts`.
- All 10 templates validate and render.
- Every deviation from this document is listed in your final report.

## 6. Final report format
1. The plan you followed and every deviation (paths, names, types), with the reason.
2. Files created / changed.
3. Results of the gate checks and manual checks.
4. Open risks, explicitly:
   - **CSP** blocking the `srcDoc` iframe (inline styles, `data:` images).
   - **Fonts** in the Docker image: without `fonts-urw-base35` and `fonts-noto-core` the PDF falls back to a different font.
   - `contenteditable` behaviour differences between browsers.
   - Unsaved edits are lost on navigation (no dirty-state guard was added; do not add one unless asked).
5. Page size is US Letter (same as the original Word files). Do not change it.

Do not add features beyond this list.
