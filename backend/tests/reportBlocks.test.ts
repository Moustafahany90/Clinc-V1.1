/**
 * Port of report-blocks/selfcheck.ts into the backend test framework.
 * Run: npm test (node --test --import tsx)
 *
 * It uses the real template files that the seed installs, so a broken template
 * fails the build before it ever reaches the database.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { renderReportHtml } from '../src/lib/report-blocks/blocks.render.js';
import { templateDefinitionSchema } from '../src/lib/report-blocks/blocks.schema.js';
import { buildInitialContent, validateDefinition } from '../src/lib/report-blocks/blocks.validate.js';
import type { TemplateDefinition } from '../src/lib/report-blocks/blocks.types.js';
import { LETTERHEAD } from '../src/lib/report-blocks/letterhead.js';

const templatesDir = fileURLToPath(new URL('../prisma/report-templates/', import.meta.url));
const files = readdirSync(templatesDir)
  .filter((file) => file.endsWith('.json'))
  .sort();
const system = {
  'patient.name': 'Test Patient',
  'patient.dob': '01/01/1990',
  'visit.date': '01/11/2026',
} as const;

function parseDefinition(file: string): TemplateDefinition {
  const raw = JSON.parse(readFileSync(join(templatesDir, file), 'utf8')) as {
    name: string;
    definition: unknown;
  };
  const parsed = templateDefinitionSchema.safeParse(raw.definition);
  if (!parsed.success) {
    assert.fail(`${file}: schema ${JSON.stringify(parsed.error.issues.slice(0, 3))}`);
  }
  return parsed.data as TemplateDefinition;
}

test('the provided template set is complete', () => {
  assert.equal(files.length, 10, `expected 10 templates, found ${files.length}`);
});

test('every template validates and renders in both modes', () => {
  for (const file of files) {
    const definition = parseDefinition(file);
    const result = validateDefinition(definition);
    assert.ok(result.ok, `${file}: validation ${result.errors.join(' | ')}`);

    const content = buildInitialContent(result.fields);
    for (const field of result.fields) {
      if (field.type === 'list') {
        assert.ok(Array.isArray(content[field.key]), `${file}: ${field.key} must start as string[]`);
      } else if (field.type === 'checklist') {
        assert.ok(
          content[field.key] !== null &&
            typeof content[field.key] === 'object' &&
            !Array.isArray(content[field.key]),
          `${file}: ${field.key} must start as Record<string, string>`,
        );
      } else {
        assert.equal(typeof content[field.key], 'string', `${file}: ${field.key} must start as a string`);
      }
    }

    const print = renderReportHtml({ definition, content, system, mode: 'print', isDraft: false });
    const edit = renderReportHtml({ definition, content, system, mode: 'edit', isDraft: false });

    assert.ok(!/\{\{|\}\}/.test(print), `${file}: unrendered token in print html`);
    assert.ok(!/<script/i.test(print + edit), `${file}: script tag found`);
    assert.ok(
      !/contenteditable/.test(print.replace(/<style>[\s\S]*?<\/style>/, '')),
      `${file}: print html must not be editable`,
    );
    assert.ok(/contenteditable/.test(edit), `${file}: edit html has no editable control`);
    assert.ok(print.includes('@page{size:Letter'), `${file}: block reports must print on US Letter`);

    // Header and footer are fixed for every report and live in letterhead.ts.
    assert.ok(print.includes(LETTERHEAD.headerLinesRtl[0]!), `${file}: missing fixed header`);
    assert.ok(print.includes(LETTERHEAD.footerPhone), `${file}: missing fixed footer phone`);
    assert.ok(print.includes(LETTERHEAD.footerAddressRtl), `${file}: missing fixed footer address`);
  }
});

const base = (blocks: unknown[]) => ({ schemaVersion: 1 as const, blocks });

function expectInvalid(name: string, blocks: unknown[], expected: RegExp): void {
  const parsed = templateDefinitionSchema.safeParse(base(blocks));
  if (!parsed.success) {
    assert.fail(`${name}: the schema should accept the fixture so the validator can report a readable error`);
  }
  const result = validateDefinition(parsed.data as TemplateDefinition);
  assert.ok(!result.ok, `${name}: expected a validation error`);
  assert.ok(
    result.errors.some((error) => expected.test(error)),
    `${name}: expected ${expected}, got ${JSON.stringify(result.errors)}`,
  );
}

test('the validator reports broken definitions with readable messages', () => {
  expectInvalid('duplicate key', [{ type: 'text', template: '{{a}}' }, { type: 'text', template: '{{a}}' }], /already used/);
  expectInvalid('orphan field', [{ type: 'text', template: 'x', fields: { a: {} } }], /declared but/);
  expectInvalid('unbalanced bold', [{ type: 'text', template: '**x' }], /unbalanced/);
  expectInvalid('malformed token', [{ type: 'text', template: '{{a' }], /malformed/);
  expectInvalid(
    'grid short row',
    [{ type: 'gridTable', widths: [1, 1], rows: [{ cells: [{ template: 'a' }] }] }],
    /not covered/,
  );
  expectInvalid(
    'grid colspan overflow',
    [{ type: 'gridTable', widths: [1, 1], rows: [{ cells: [{ template: 'a', colSpan: 3 }] }] }],
    /runs past/,
  );
  expectInvalid('info needs source xor key', [{ type: 'infoTable', rows: [{ label: 'x' }] }], /exactly one/);
  expectInvalid(
    'checklist orphan sub item',
    [
      {
        type: 'checklistTable',
        key: 'c',
        columns: [{ key: 'n', label: 'N' }],
        rows: [{ key: 'r', label: 'R', depth: 1, values: true }],
      },
    ],
    /sub item/,
  );
});

test('the strict schema rejects unknown properties and misplaced blocks', () => {
  assert.equal(
    templateDefinitionSchema.safeParse(base([{ type: 'text', template: 'x', tempalte: 'typo' }])).success,
    false,
  );
  assert.equal(
    templateDefinitionSchema.safeParse(base([{ type: 'section', title: 's', children: [{ type: 'title', text: 'x' }] }]))
      .success,
    false,
  );
  assert.equal(
    templateDefinitionSchema.safeParse({ ...base([{ type: 'text', template: 'x' }]), extra: true }).success,
    false,
  );
});

test('rendered output escapes field values', () => {
  const parsed = templateDefinitionSchema.safeParse(
    base([{ type: 'text', template: '{{a}}', fields: { a: { default: '<img src=x onerror=alert(1)>' } } }]),
  );
  if (!parsed.success) assert.fail(JSON.stringify(parsed.error.issues.slice(0, 3)));
  const html = renderReportHtml({
    definition: parsed.data as TemplateDefinition,
    content: { a: '<script>alert(1)</script>"\'' },
    system: {},
    mode: 'edit',
  });
  assert.ok(!html.includes('<script>alert'), 'content must not become an executable script');
  assert.ok(!html.includes('<img src=x'), 'content must not become an image tag');
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'angle brackets must be escaped');
  assert.ok(html.includes('&quot;') && html.includes('&#39;'), 'quotes must be escaped');
});
