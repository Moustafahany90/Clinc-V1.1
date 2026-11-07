import type {
  Block,
  ChecklistBlock,
  FieldDef,
  FieldMap,
  GridTableBlock,
  ListBlock,
  ListItem,
  ListStyle,
  SystemSource,
  TemplateDefinition,
} from './blocks.types.js';
import { splitTemplate } from './blocks.validate.js';
import { LETTERHEAD } from './letterhead.js';
import { LETTERHEAD_LOGO } from './letterheadLogo.js';

/**
 * ONE renderer for everything:
 *   mode "print": static HTML, used for the browser print preview and the
 *                 Chromium PDF sent over WhatsApp.
 *   mode "edit":  the same HTML with editable controls, shown in an iframe on
 *                 the report screen. No scripts: the host page reads values
 *                 back from the iframe DOM through the data-* attributes
 *                 (see "Edit mode contract" below).
 *
 * Edit mode contract (what the host reads):
 *   [data-key]                       editable element
 *   - span/td with contenteditable   value = textContent
 *   - <select data-key>              value = select.value
 *   - ul[data-kind="list"]           value = array of <li> textContent (non empty)
 *   - td[data-key][data-sub]         checklist cell: content[key][sub] = textContent
 */

export interface RenderInput {
  definition: TemplateDefinition;
  content: Record<string, unknown>;
  /** Preformatted strings for system rows (patient name, date of birth, visit date). */
  system: Partial<Record<SystemSource, string>>;
  mode: 'print' | 'edit';
  isDraft?: boolean;
  pageSize?: 'Letter' | 'A4';
}

export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

interface Ctx {
  mode: 'print' | 'edit';
  content: Record<string, unknown>;
  system: Partial<Record<SystemSource, string>>;
}

function textValue(ctx: Ctx, key: string, def?: { default?: string }): string {
  const raw = ctx.content[key];
  if (raw === undefined || raw === null) return def?.default ?? '';
  if (Array.isArray(raw)) return raw.map(String).join(', ');
  if (typeof raw === 'object') return '';
  return String(raw);
}

function fieldHtml(ctx: Ctx, key: string, def: FieldDef | undefined): string {
  const value = textValue(ctx, key, def);
  if (ctx.mode === 'print') return `<span class="v">${esc(value)}</span>`;
  if (def?.options?.length) {
    const options = def.options.includes(value) || value === '' ? def.options : [value, ...def.options];
    return (
      `<select class="f" data-key="${esc(key)}"><option value=""></option>` +
      options.map((o) => `<option value="${esc(o)}"${o === value ? ' selected' : ''}>${esc(o)}</option>`).join('') +
      `</select>`
    );
  }
  return `<span class="f" contenteditable="true" spellcheck="false" data-key="${esc(key)}" data-ph="${esc(def?.placeholder ?? '')}">${esc(value)}</span>`;
}

/** Renders a template string (text + {{fields}} + **bold**) without whitespace padding. */
function inline(ctx: Ctx, source: string, fields: FieldMap | undefined): string {
  let out = '';
  let bold = false;
  for (const part of splitTemplate(source)) {
    if (part.kind === 'bold') {
      out += bold ? '</b>' : '<b>';
      bold = !bold;
    } else if (part.kind === 'text') out += esc(part.text);
    else out += fieldHtml(ctx, part.key, fields?.[part.key]);
  }
  if (bold) out += '</b>';
  return out;
}

/** Print mode hides a line that has no static text and whose fields are all empty. */
function isBlank(ctx: Ctx, source: string, fields: FieldMap | undefined, hasLabel: boolean): boolean {
  if (hasLabel) return false;
  for (const part of splitTemplate(source)) {
    if (part.kind === 'text' && part.text.trim() !== '') return false;
    if (part.kind === 'field' && textValue(ctx, part.key, fields?.[part.key]).trim() !== '') return false;
  }
  return true;
}

function itemIsBlank(ctx: Ctx, item: ListItem): boolean {
  if (item.subtitle) return false;
  if (!isBlank(ctx, item.template, item.fields, Boolean(item.label))) return false;
  return (item.children ?? []).every((child) => itemIsBlank(ctx, child));
}

function listClass(style: ListStyle | undefined, fallback: ListStyle): string {
  return `l l-${style ?? fallback}`;
}

function itemHtml(ctx: Ctx, item: ListItem, childStyle: ListStyle): string {
  const cls = [item.bold ? 'b' : '', item.underline ? 'u' : ''].filter(Boolean).join(' ');
  const label = item.label ? `<span class="lab">${esc(item.label)}</span>` : '';
  const subtitle = item.subtitle ? `<div class="sub">${esc(item.subtitle)}</div>` : '';
  const visibleChildren =
    ctx.mode === 'print' ? (item.children ?? []).filter((child) => !itemIsBlank(ctx, child)) : (item.children ?? []);
  const children =
    visibleChildren.length > 0
      ? `<ul class="l l-${childStyle}">${visibleChildren.map((child) => itemHtml(ctx, { ...child }, childStyle)).join('')}</ul>`
      : '';
  return `<li${cls ? ` class="${cls}"` : ''}>${label}${inline(ctx, item.template, item.fields)}${subtitle}${children}</li>`;
}

function listHtml(ctx: Ctx, block: ListBlock): string {
  const cls = `${listClass(block.style, 'bullet')}${block.small ? ' sm' : ''}${block.bold ? ' b' : ''}`;
  const childStyle = block.childStyle ?? 'circle';
  const items = ctx.mode === 'print' ? block.items.filter((item) => !itemIsBlank(ctx, item)) : block.items;
  if (items.length === 0) return '';
  return `<ul class="${cls}">${items.map((item) => itemHtml(ctx, item, childStyle)).join('')}</ul>`;
}

function freeListHtml(ctx: Ctx, block: Extract<Block, { type: 'freeList' }>): string {
  const raw = ctx.content[block.key];
  const lines = Array.isArray(raw)
    ? raw.map(String)
    : typeof raw === 'string'
      ? raw.split('\n')
      : (block.default ?? []);
  const cls = `${listClass(block.style, 'bullet')}${block.small ? ' sm' : ''}${block.bold ? ' b' : ''}`;
  if (ctx.mode === 'print') {
    const filled = lines.map((l) => l.trim()).filter(Boolean);
    return filled.length ? `<ul class="${cls}">${filled.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : '';
  }
  const rows = (lines.length ? lines : ['']).map((l) => `<li>${esc(l)}</li>`).join('');
  return `<ul class="${cls} free" contenteditable="true" spellcheck="false" data-key="${esc(block.key)}" data-kind="list" data-ph="${esc(block.placeholder ?? '')}">${rows}</ul>`;
}

function gridHtml(ctx: Ctx, block: GridTableBlock): string {
  const total = block.widths.reduce((a, b) => a + b, 0);
  const cols = block.widths.map((w) => `<col style="width:${((w / total) * 100).toFixed(3)}%">`).join('');
  const headerRows = block.headerRows ?? 0;
  const rows = block.rows
    .map((row, r) => {
      const cells = row.cells
        .map((cell) => {
          const cls = [
            r < headerRows ? 'hd' : '',
            cell.align ? `al-${cell.align}` : '',
            cell.bold ? 'b' : '',
            cell.accent ? 'ac' : '',
            cell.underline ? 'u' : '',
            cell.rightRule ? 'rr' : '',
          ]
            .filter(Boolean)
            .join(' ');
          const span = `${cell.colSpan && cell.colSpan > 1 ? ` colspan="${cell.colSpan}"` : ''}${
            cell.rowSpan && cell.rowSpan > 1 ? ` rowspan="${cell.rowSpan}"` : ''
          }`;
          return `<td${cls ? ` class="${cls}"` : ''}${span}>${inline(ctx, cell.template, cell.fields)}</td>`;
        })
        .join('');
      return `<tr${row.rule ? ` class="r-${row.rule}"` : ''}>${cells}</tr>`;
    })
    .join('');
  const title = block.title ? `<h3 class="gt">${esc(block.title)}</h3>` : '';
  return `${title}<table class="g g-${block.border ?? 'none'}"><colgroup>${cols}</colgroup><tbody>${rows}</tbody></table>`;
}

function checklistHtml(ctx: Ctx, block: ChecklistBlock): string {
  const rawValues = ctx.content[block.key];
  const stored =
    rawValues && typeof rawValues === 'object' && !Array.isArray(rawValues)
      ? (rawValues as Record<string, unknown>)
      : {};
  const labelWidth = block.labelWidth ?? 50;
  const colWidth = (100 - labelWidth) / block.columns.length;
  const cols =
    `<col style="width:${labelWidth}%">` +
    block.columns.map(() => `<col style="width:${colWidth.toFixed(3)}%">`).join('');
  const legend = block.legend?.length ? block.legend.map((l) => `<div>${esc(l)}</div>`).join('') : '';
  const head = `<thead><tr><th class="ck-leg">${legend}</th>${block.columns
    .map((c) => `<th>${esc(c.label)}</th>`)
    .join('')}</tr></thead>`;
  let counter = 0;
  const marker = block.subMarker ?? 'number';
  const body = block.rows
    .map((row) => {
      let label: string;
      if (row.depth === 0) {
        counter = 0;
        label = `<td class="lbl d0">${esc(row.label)}</td>`;
      } else {
        counter += 1;
        label = `<td class="lbl d1">${marker === 'number' ? `${counter}. ` : '- '}${esc(row.label)}</td>`;
      }
      const cells = block.columns
        .map((column) => {
          if (!row.values) return '<td class="c"></td>';
          const sub = `${row.key}.${column.key}`;
          const saved = stored[sub];
          const value =
            typeof saved === 'string' ? saved : (row.defaults?.[column.key] ?? column.default ?? '');
          if (ctx.mode === 'print') return `<td class="c">${esc(value)}</td>`;
          return `<td class="c" contenteditable="true" spellcheck="false" data-key="${esc(block.key)}" data-sub="${esc(sub)}" data-ph="${esc(row.placeholders?.[column.key] ?? '')}">${esc(value)}</td>`;
        })
        .join('');
      return `<tr>${label}${cells}</tr>`;
    })
    .join('');
  return `<table class="ck"><colgroup>${cols}</colgroup>${head}<tbody>${body}</tbody></table>`;
}

function blockHtml(ctx: Ctx, block: Block): string {
  switch (block.type) {
    case 'infoTable': {
      const out: string[] = [];
      let pending: string[] = [];
      const flush = () => {
        if (pending.length) out.push(`<table class="info"><tbody>${pending.join('')}</tbody></table>`);
        pending = [];
      };
      for (const row of block.rows) {
        const value = row.source
          ? esc(ctx.system[row.source] ?? '')
          : fieldHtml(ctx, row.key ?? '', { default: row.default, placeholder: row.placeholder });
        if (row.boxed) {
          flush();
          out.push(`<div class="refer"><i>${esc(row.label)}</i> ${value}</div>`);
        } else {
          pending.push(`<tr><td class="l">${esc(row.label)}</td><td class="v${row.bold ? ' b' : ''}">${value}</td></tr>`);
        }
      }
      flush();
      return out.join('');
    }
    case 'title':
      return `<div class="title">${block.boldPrefix ? `<b>${esc(block.boldPrefix)}</b>` : ''}${esc(block.text)}${
        block.suffix ? ` <small>${esc(block.suffix)}</small>` : ''
      }</div>`;
    case 'section': {
      const hasChecklist = block.children.some((c) => c.type === 'checklistTable');
      const inner = block.children.map((child) => blockHtml(ctx, child)).join('');
      if (ctx.mode === 'print' && inner === '' && block.children.length > 0) return '';
      return `<section${hasChecklist ? ' class="long"' : ''}><h2${block.color === 'blue' ? ' class="blue"' : ''}>${esc(block.title)}</h2>${inner}</section>`;
    }
    case 'text':
      if (ctx.mode === 'print' && isBlank(ctx, block.template, block.fields, false)) return '';
      return `<div class="t t-${block.style ?? 'body'}">${inline(ctx, block.template, block.fields)}</div>`;
    case 'list':
      return listHtml(ctx, block);
    case 'freeList':
      return freeListHtml(ctx, block);
    case 'gridTable':
      return gridHtml(ctx, block);
    case 'checklistTable':
      return checklistHtml(ctx, block);
    case 'signature': {
      const [best, name, role, uni] = LETTERHEAD.signatureLines;
      return `<div class="sign"><div class="best">${esc(best)}</div><div class="name">${esc(name)}</div><div class="role">${esc(role)}</div><div class="uni">${esc(uni)}</div></div>`;
    }
  }
}

const CSS = `
:root{--pink:#E32D91;--purple:#C830CC;--blue:#2581BA;
 --font:"Century Gothic","URW Gothic","Questrial","Avant Garde","Segoe UI",Arial,"Noto Sans",sans-serif;
 --script:"Monotype Corsiva","URW Chancery L","Z003","Apple Chancery","Lucida Calligraphy",cursive}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{font-family:var(--font);color:#000;line-height:1.25;background:#fff;font-size:var(--b)}
.hdr{display:flex;align-items:center;justify-content:space-between}
.hdr .txt{flex:1;text-align:center;direction:rtl;font-size:12pt;line-height:1.25}
.hdr .dr{color:var(--purple);font-weight:700;font-size:16pt}
.hdr img{width:2.22in;height:1.185in;display:block}
.ftr{display:flex;justify-content:space-between;align-items:flex-end;gap:.3in;color:var(--pink);font-weight:700;font-size:12pt}
.ftr .addr{direction:rtl;text-align:right}
.ftr .tel{direction:ltr;white-space:nowrap}
.draft{text-align:center;color:#c00;font-weight:700;font-size:9pt;letter-spacing:.12em}
table.wrap{width:100%;border-collapse:collapse}
table.wrap>thead>tr>td,table.wrap>tbody>tr>td,table.wrap>tfoot>tr>td{padding:0}
.spacer-h{height:1.4in}.spacer-f{height:.95in}
.body-pad{padding:0 .5in 0 1in}
b{font-weight:700}
table.info{border-collapse:collapse;width:100%}
table.info td{padding:1px 0;vertical-align:baseline}
table.info td.l{font-weight:700;font-size:var(--b);width:2.15in;white-space:nowrap}
table.info td.v{font-size:calc(var(--b) - 2pt)}
table.info td.v.b{font-weight:700}
.refer{border:1px solid #000;padding:1px 4px;font-size:calc(var(--b) - 2pt);font-weight:700;margin-top:2px}
.title{text-align:center;color:var(--pink);font-size:calc(var(--b) + 4pt);margin:.05in 0 .02in;text-decoration:underline}
.title small{font-size:calc(var(--b) - 2pt)}
h2{margin:.08in 0 .02in;font-size:calc(var(--b) + 2pt);font-weight:700;color:var(--pink);text-decoration:underline;display:flex;align-items:center;gap:6px;break-after:avoid}
h2.blue{color:var(--blue)}
h2::before{content:"";display:inline-block;width:.075in;height:.075in;background:currentColor;flex:none}
h3.gt{font-size:calc(var(--b) + 2pt);font-weight:700;text-decoration:underline;margin:.05in 0 0 .08in;break-after:avoid}
.t{margin:2px 0;white-space:pre-wrap}
.t-bold{font-weight:700}
.t-blueItalic{color:var(--blue);font-weight:700;font-style:italic;text-decoration:underline}
ul.l{margin:2px 0;padding-left:.38in}
ul.l.sm{font-size:calc(var(--b) - 2pt)}
ul.l.b{font-weight:700}
ul.l-bullet{list-style:disc}ul.l-circle{list-style:circle}ul.l-number{list-style:decimal}
ul.l-dash{list-style-type:"- "}ul.l-none{list-style:none;padding-left:0}
ul.l ul.l{padding-left:.4in}
ul.l li{margin:1px 0;white-space:pre-wrap}
li.b{font-weight:700}li.u{text-decoration:underline}
.lab{font-weight:700;text-decoration:underline}
.sub{color:var(--blue);font-weight:700;font-style:italic;text-decoration:underline}
table.g{border-collapse:collapse;width:96%;margin:0 0 0 .08in;font-size:calc(var(--b) - 2pt);break-inside:avoid}
table.g td{padding:1px 6px 1px 8px;vertical-align:top;white-space:pre-wrap}
table.g td.b{font-weight:700}table.g td.ac{color:var(--pink)}table.g td.u{text-decoration:underline}
table.g td.al-center{text-align:center}table.g td.al-right{text-align:right}
table.g td.hd{color:var(--pink);font-weight:700;text-align:center}
table.g-all td{border:1px solid #000}
table.g-lines tr.r-top>td,table.g-lines tr.r-both>td{border-top:1px solid #000}
table.g-lines tr.r-bottom>td,table.g-lines tr.r-both>td{border-bottom:1px solid #000}
table.g td.rr{border-right:1px solid #000}
table.ck{border-collapse:collapse;width:100%;margin:.04in 0;font-size:calc(var(--b) - 1pt)}
table.ck th{color:var(--pink);font-weight:700;border:1px solid #000;padding:1px 4px;text-align:center}
table.ck th.ck-leg{text-align:left;color:#000;font-weight:400}
table.ck thead{display:table-header-group}
table.ck tr{break-inside:avoid}
table.ck td{border:1px solid #000;padding:0 4px;vertical-align:top;white-space:pre-wrap}
table.ck td.lbl.d0::before{content:"\\2022  "}
table.ck td.lbl.d0{padding-left:.12in}
table.ck td.lbl.d1{padding-left:.38in}
table.ck td.c{text-align:left}
section{break-inside:avoid}
section.long{break-inside:auto}
.sign{text-align:center;margin-top:.25in;break-inside:avoid}
.sign .best{font-family:var(--script);font-weight:700;font-style:italic;font-size:18pt}
.sign .name{font-family:var(--script);font-weight:700;font-style:italic;font-size:22pt;line-height:1.1}
.sign .role{font-size:11pt;margin-top:2px}
.sign .uni{font-size:13pt}
.v{white-space:pre-wrap}
@media screen{
 body{background:#e9e9ee}
 .paper{width:8.5in;margin:16px auto;background:#fff;box-shadow:0 2px 14px rgba(0,0,0,.18);padding:.2in 0 .3in}
 .hdr{margin:0 .5in .2in 1in}
 .ftr{margin:.3in .5in 0 1in}
 .spacer-h,.spacer-f{display:none}
 .draft{margin-bottom:.05in}
 .f{padding:0 .5ch;background:#fff4fa;border-radius:3px;outline:none}
 .f:hover{background:#ffe9f4}
 .f:focus{background:#ffdcee;box-shadow:0 0 0 2px #f7b6d9}
 .f:empty::before{content:attr(data-ph);color:#c9a;font-weight:400;font-style:normal}
 select.f{font:inherit;border:1px solid #f0c0da}
 td.c[contenteditable]:hover{background:#fff4fa}
 td.c[contenteditable]:focus{background:#ffdcee;outline:none}
 td.c[contenteditable]:empty::before{content:attr(data-ph);color:#c9a}
 ul.free{outline:none;background:#fff4fa;border-radius:3px;min-height:1.4em}
 ul.free:focus{background:#ffdcee}
}
@media print{
 body{background:#fff}
 .paper{padding:0}
 .hdr{position:fixed;top:.2in;left:1in;right:.5in}
 .ftr{position:fixed;bottom:.4in;left:1in;right:.5in}
 .draft{position:fixed;top:.04in;left:0;right:0}
}
`;

export function renderReportHtml(input: RenderInput): string {
  const ctx: Ctx = { mode: input.mode, content: input.content, system: input.system };
  const base = input.definition.baseSize ?? 12;
  const page = input.pageSize ?? 'Letter';
  const [doctorLine, ...restLines] = LETTERHEAD.headerLinesRtl;
  const header =
    `<div class="hdr"><div class="txt"><div class="dr">${esc(doctorLine)}</div>` +
    restLines.map((l) => `<div>${esc(l)}</div>`).join('') +
    `</div><img src="${LETTERHEAD_LOGO}" alt=""></div>`;
  const footer =
    `<div class="ftr"><div class="tel">${esc(LETTERHEAD.footerPhone)}</div>` +
    `<div class="addr">${esc(LETTERHEAD.footerAddressRtl)}</div></div>`;
  const draft = input.isDraft ? '<div class="draft">DRAFT - NOT A FINAL REPORT</div>' : '';
  const body = input.definition.blocks.map((block) => blockHtml(ctx, block)).join('');
  return (
    `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>Report</title><style>@page{size:${page};margin:0}:root{--b:${base}pt}${CSS}</style></head><body>` +
    `<div class="paper">${draft}${header}` +
    `<table class="wrap"><thead><tr><td><div class="spacer-h"></div></td></tr></thead>` +
    `<tbody><tr><td><div class="body-pad">${body}</div></td></tr></tbody>` +
    `<tfoot><tr><td><div class="spacer-f"></div></td></tr></tfoot></table>${footer}</div></body></html>`
  );
}
