import type {
  Block,
  DerivedField,
  FieldMap,
  GridTableBlock,
  LeafBlock,
  TemplateDefinition,
} from './blocks.types.js';

/** Hard ceiling for derived fields of a block template. */
export const MAX_DERIVED_FIELDS = 400;

export type TemplatePart =
  | { kind: 'text'; text: string }
  | { kind: 'field'; key: string }
  | { kind: 'bold' };

const PART_RE = /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}|\*\*/g;

/** Splits a template into text, {{field}} tokens and ** bold toggles. */
export function splitTemplate(source: string): TemplatePart[] {
  const parts: TemplatePart[] = [];
  let last = 0;
  for (const match of source.matchAll(PART_RE)) {
    const index = match.index ?? 0;
    if (index > last) parts.push({ kind: 'text', text: source.slice(last, index) });
    if (match[1]) parts.push({ kind: 'field', key: match[1] });
    else parts.push({ kind: 'bold' });
    last = index + match[0].length;
  }
  if (last < source.length) parts.push({ kind: 'text', text: source.slice(last) });
  return parts;
}

function humanize(key: string): string {
  const spaced = key
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

interface Walker {
  errors: string[];
  keys: Map<string, string>;
  fields: DerivedField[];
}

function claimKey(w: Walker, key: string, where: string): boolean {
  const previous = w.keys.get(key);
  if (previous) {
    w.errors.push(`${where}: key "${key}" is already used at ${previous}. Keys must be unique in a template.`);
    return false;
  }
  w.keys.set(key, where);
  return true;
}

function walkTemplate(w: Walker, source: string, fields: FieldMap | undefined, where: string): void {
  const parts = splitTemplate(source);
  let bold = 0;
  const used = new Set<string>();
  for (const part of parts) {
    if (part.kind === 'bold') bold += 1;
    if (part.kind === 'text' && /\{\{|\}\}/.test(part.text)) {
      w.errors.push(`${where}: malformed {{token}} in "${source}".`);
    }
    if (part.kind === 'field') {
      if (used.has(part.key)) {
        w.errors.push(`${where}: token {{${part.key}}} appears twice in the same template.`);
        continue;
      }
      used.add(part.key);
      if (!claimKey(w, part.key, where)) continue;
      const def = fields?.[part.key];
      w.fields.push({
        key: part.key,
        label: humanize(part.key),
        type: def?.options?.length ? 'select' : 'text',
        ...(def?.default !== undefined ? { defaultValue: def.default } : {}),
        ...(def?.options?.length ? { options: def.options } : {}),
      });
    }
  }
  if (bold % 2 !== 0) w.errors.push(`${where}: unbalanced ** in "${source}".`);
  for (const declared of Object.keys(fields ?? {})) {
    if (!used.has(declared)) {
      w.errors.push(`${where}: fields["${declared}"] is declared but {{${declared}}} is not used in the template.`);
    }
  }
}

function checkGrid(w: Walker, block: GridTableBlock, where: string): void {
  const columns = block.widths.length;
  const occupied: boolean[][] = block.rows.map(() => new Array<boolean>(columns).fill(false));
  block.rows.forEach((row, r) => {
    let c = 0;
    row.cells.forEach((cell, i) => {
      while (c < columns && occupied[r]![c]) c += 1;
      const cs = cell.colSpan ?? 1;
      const rs = cell.rowSpan ?? 1;
      if (c >= columns) {
        w.errors.push(`${where}, row ${r + 1}: too many cells (table has ${columns} columns).`);
        return;
      }
      if (c + cs > columns) {
        w.errors.push(`${where}, row ${r + 1}, cell ${i + 1}: colSpan ${cs} runs past the last column.`);
        return;
      }
      if (r + rs > block.rows.length) {
        w.errors.push(`${where}, row ${r + 1}, cell ${i + 1}: rowSpan ${rs} runs past the last row.`);
        return;
      }
      for (let rr = r; rr < r + rs; rr += 1) {
        for (let cc = c; cc < c + cs; cc += 1) {
          if (occupied[rr]![cc]) {
            w.errors.push(`${where}, row ${r + 1}, cell ${i + 1}: overlaps another cell.`);
            return;
          }
          occupied[rr]![cc] = true;
        }
      }
      c += cs;
    });
  });
  occupied.forEach((cells, r) => {
    const missing = cells.filter((x) => !x).length;
    if (missing > 0) w.errors.push(`${where}, row ${r + 1}: ${missing} column(s) are not covered by any cell.`);
  });
  if ((block.headerRows ?? 0) > block.rows.length) w.errors.push(`${where}: headerRows is larger than the row count.`);
}

function walkLeaf(w: Walker, block: LeafBlock, where: string): void {
  switch (block.type) {
    case 'text':
      walkTemplate(w, block.template, block.fields, where);
      return;
    case 'list':
      block.items.forEach((item, i) => {
        walkTemplate(w, item.template, item.fields, `${where} item ${i + 1}`);
        item.children?.forEach((child, j) =>
          walkTemplate(w, child.template, child.fields, `${where} item ${i + 1}.${j + 1}`),
        );
      });
      return;
    case 'freeList':
      if (claimKey(w, block.key, where)) {
        w.fields.push({ key: block.key, label: humanize(block.key), type: 'list', defaultValue: block.default ?? [] });
      }
      return;
    case 'gridTable':
      checkGrid(w, block, where);
      block.rows.forEach((row, r) =>
        row.cells.forEach((cell, c) => walkTemplate(w, cell.template, cell.fields, `${where} row ${r + 1} cell ${c + 1}`)),
      );
      return;
    case 'checklistTable': {
      const columnKeys = new Set<string>();
      for (const column of block.columns) {
        if (columnKeys.has(column.key)) w.errors.push(`${where}: duplicate column key "${column.key}".`);
        columnKeys.add(column.key);
      }
      const rowKeys = new Set<string>();
      const defaults: Record<string, string> = {};
      block.rows.forEach((row, i) => {
        if (rowKeys.has(row.key)) w.errors.push(`${where}: duplicate row key "${row.key}".`);
        rowKeys.add(row.key);
        if (row.depth === 1 && !block.rows.slice(0, i).some((r) => r.depth === 0)) {
          w.errors.push(`${where}: row "${row.key}" is a sub item but no bulleted row comes before it.`);
        }
        for (const map of [row.defaults, row.placeholders]) {
          for (const column of Object.keys(map ?? {})) {
            if (!columnKeys.has(column)) w.errors.push(`${where}, row "${row.key}": unknown column "${column}".`);
          }
        }
        if (!row.values && (row.defaults || row.placeholders)) {
          w.errors.push(`${where}, row "${row.key}": has defaults or placeholders but values is false.`);
        }
        if (row.values) {
          for (const column of block.columns) {
            const value = row.defaults?.[column.key] ?? column.default;
            if (value !== undefined && value !== '') defaults[`${row.key}.${column.key}`] = value;
          }
        }
      });
      if (claimKey(w, block.key, where)) {
        w.fields.push({ key: block.key, label: humanize(block.key), type: 'checklist', defaultValue: defaults });
      }
      return;
    }
  }
}

function walkBlock(w: Walker, block: Block, index: number): void {
  const where = `blocks[${index}] (${block.type})`;
  switch (block.type) {
    case 'infoTable':
      block.rows.forEach((row, i) => {
        const at = `${where} row ${i + 1} "${row.label}"`;
        if (!!row.source === !!row.key) {
          w.errors.push(`${at}: set exactly one of "source" or "key".`);
          return;
        }
        if (row.key && claimKey(w, row.key, at)) {
          w.fields.push({
            key: row.key,
            label: row.label,
            type: 'text',
            ...(row.default !== undefined ? { defaultValue: row.default } : {}),
          });
        }
      });
      return;
    case 'section':
      block.children.forEach((child, i) => walkLeaf(w, child, `${where} "${block.title}" child ${i + 1} (${child.type})`));
      return;
    case 'title':
    case 'signature':
      return;
    default:
      walkLeaf(w, block, where);
  }
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  fields: DerivedField[];
}

/**
 * Cross-field validation + derived field list. Run AFTER templateDefinitionSchema.
 * Never throws; returns every problem found so the author can fix them in one go.
 */
export function validateDefinition(definition: TemplateDefinition): ValidationResult {
  const w: Walker = { errors: [], keys: new Map(), fields: [] };
  definition.blocks.forEach((block, i) => walkBlock(w, block, i));
  if (w.fields.length > MAX_DERIVED_FIELDS) {
    w.errors.push(`The template defines ${w.fields.length} fields; the maximum is ${MAX_DERIVED_FIELDS}.`);
  }
  return { ok: w.errors.length === 0, errors: w.errors, fields: w.fields };
}

/** Initial Report.currentContent for a new report: every default, nothing else. */
export function buildInitialContent(fields: DerivedField[]): Record<string, string | string[] | Record<string, string>> {
  const content: Record<string, string | string[] | Record<string, string>> = {};
  for (const field of fields) {
    if (field.type === 'list') content[field.key] = Array.isArray(field.defaultValue) ? [...field.defaultValue] : [];
    else if (field.type === 'checklist') {
      content[field.key] =
        field.defaultValue && typeof field.defaultValue === 'object' && !Array.isArray(field.defaultValue)
          ? { ...field.defaultValue }
          : {};
    } else content[field.key] = typeof field.defaultValue === 'string' ? field.defaultValue : '';
  }
  return content;
}
