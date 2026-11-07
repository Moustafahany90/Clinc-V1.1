/**
 * Self check for the block system. Run: npx tsx selfcheck.ts
 * Exits non-zero on the first failed assertion group.
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { templateDefinitionSchema } from './blocks.schema.js';
import { buildInitialContent, validateDefinition } from './blocks.validate.js';
import { renderReportHtml } from './blocks.render.js';
import type { TemplateDefinition } from './blocks.types.js';

let failures = 0;
const check = (ok: boolean, message: string) => {
  if (!ok) {
    failures += 1;
    console.error('FAIL:', message);
  }
};

const dir = new URL('./templates/', import.meta.url).pathname;
mkdirSync(new URL('./out/', import.meta.url).pathname, { recursive: true });
const system = { 'patient.name': 'Test Patient', 'patient.dob': '01/01/1990', 'visit.date': '01/11/2026' } as const;

for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
  const raw = JSON.parse(readFileSync(join(dir, file), 'utf8')) as { name: string; definition: unknown };
  const parsed = templateDefinitionSchema.safeParse(raw.definition);
  check(parsed.success, `${file}: schema ${parsed.success ? '' : JSON.stringify(parsed.error.issues.slice(0, 3))}`);
  if (!parsed.success) continue;
  const def = parsed.data as TemplateDefinition;
  const result = validateDefinition(def);
  check(result.ok, `${file}: validation ${result.errors.join(' | ')}`);
  const content = buildInitialContent(result.fields);
  const print = renderReportHtml({ definition: def, content, system, mode: 'print', isDraft: file.startsWith('2d') });
  const edit = renderReportHtml({ definition: def, content, system, mode: 'edit' });
  check(!/\{\{|\}\}/.test(print), `${file}: unrendered token in print html`);
  check(!/<script/i.test(print + edit), `${file}: script tag found`);
  check(!/contenteditable/.test(print.replace(/<style>[\s\S]*?<\/style>/, '')), `${file}: print html must not be editable`);
  check(/contenteditable/.test(edit), `${file}: edit html has no editable control`);
  writeFileSync(new URL(`./out/${file.replace('.json', '')}.print.html`, import.meta.url).pathname, print);
  writeFileSync(new URL(`./out/${file.replace('.json', '')}.edit.html`, import.meta.url).pathname, edit);
  console.log(`ok ${file}: ${result.fields.length} fields`);
}

// ---- negative tests: the validator must catch these
const base = (blocks: unknown[]) => ({ schemaVersion: 1, blocks }) as unknown;
const bad = (name: string, blocks: unknown[], expect: RegExp) => {
  const parsed = templateDefinitionSchema.safeParse(base(blocks));
  if (!parsed.success) {
    check(expect.test('schema'), `${name}: rejected by schema (expected validator message)`);
    return;
  }
  const result = validateDefinition(parsed.data as TemplateDefinition);
  check(!result.ok && result.errors.some((e) => expect.test(e)), `${name}: expected error ${expect}, got ${JSON.stringify(result.errors)}`);
};
bad('duplicate key', [{ type: 'text', template: '{{a}}' }, { type: 'text', template: '{{a}}' }], /already used/);
bad('orphan field', [{ type: 'text', template: 'x', fields: { a: {} } }], /declared but/);
bad('unbalanced bold', [{ type: 'text', template: '**x' }], /unbalanced/);
bad('malformed token', [{ type: 'text', template: '{{a' }], /malformed/);
bad('grid short row', [{ type: 'gridTable', widths: [1, 1], rows: [{ cells: [{ template: 'a' }] }] }], /not covered/);
bad('grid colspan overflow', [{ type: 'gridTable', widths: [1, 1], rows: [{ cells: [{ template: 'a', colSpan: 3 }] }] }], /runs past/);
bad('info needs source xor key', [{ type: 'infoTable', rows: [{ label: 'x' }] }], /exactly one/);
bad('checklist orphan sub item', [{ type: 'checklistTable', key: 'c', columns: [{ key: 'n', label: 'N' }], rows: [{ key: 'r', label: 'R', depth: 1, values: true }] }], /sub item/);
check(!templateDefinitionSchema.safeParse(base([{ type: 'text', template: 'x', tempalte: 'typo' }])).success, 'strict schema rejects unknown property');
check(!templateDefinitionSchema.safeParse(base([{ type: 'section', title: 's', children: [{ type: 'title', text: 'x' }] }])).success, 'section cannot contain a title');

// ---- escaping
{
  const def = templateDefinitionSchema.parse(base([{ type: 'text', template: '{{a}}', fields: { a: { default: '<img src=x onerror=alert(1)>' } } }])) as TemplateDefinition;
  const html = renderReportHtml({ definition: def, content: { a: '<script>alert(1)</script>"\'' }, system: {}, mode: 'edit' });
  check(!html.includes('<script>alert') && !html.includes('<img src=x'), 'content is HTML escaped');
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
