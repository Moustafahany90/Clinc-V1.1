import type { ReportPdfInput } from './reportPdf.js';
import type { ReportTemplateField } from './reportTypes.js';
import { renderHtmlToPdf } from './htmlPdf.js';
import { GYN4D_LOGO } from './gyn4dLogo.js';

/**
 * "gyn4d" print layout: the 4D Gynecology scan design used by Dr. Monira.
 * One HTML document is the single source of truth. It is used:
 *  - by GET /reports/:id/print-html (the browser prints it), and
 *  - by renderGyn4dPdf (Chromium -> PDF) for the WhatsApp delivery.
 * Page size is US Letter, same as the original Word file. For A4 printers change
 * PAGE_SIZE below (and `Letter` in renderGyn4dPdf).
 */
const PAGE_SIZE = 'Letter';

/** Original design values, used whenever a template leaves a setting blank. */
const DEFAULT_PAGE_TITLE = '4D Gynecology Scan';
const DEFAULT_HEADER_LINES = [
  'د/ منيره علي علي',
  'استشاري الموجات الصوتية و طب الجنين',
  'بوحده طب الجنين- جامعه عين شمس',
];
const DEFAULT_DOCTOR_NAME = 'Dr. Monira Ali Ali';
const DEFAULT_DOCTOR_ROLE =
  'Ultrasound and fetal medicine consultant, Fetal medicine unit,';
const DEFAULT_DOCTOR_UNIVERSITY = 'Ain shams University.';
const DEFAULT_PHONE = 'Tel : 01113735454 - 01555579454';
const DEFAULT_ADDRESS = '10 ش سامي عبد العال – ارض الجولف – مصر الجديدة';

/**
 * Original editor labels for the seeded 4D template. When a template still has
 * one of these labels we keep the historical printed wording (which differs in
 * places). Once an operator renames a field, the new label is used in print.
 */
const GYN4D_SEED_LABELS: Record<string, string> = {
  lmp: 'LMP',
  serialVisit: 'Serial Visit No',
  scanQuality: 'Scan quality',
  routeOfScan: 'Route of scan',
  referredBy: 'Referred by Prof Dr/',
  uterusDesc: 'Uterus',
  uterineMeasurements: 'Uterine measurements',
  uterusMobility: 'Uterus mobility',
  endoCavity: 'Endometrium: cavity (3D)',
  endoTexture: 'Endometrium: texture and thickness',
  endoJunctionStatus: 'Junction status',
  endoJunction: 'Junction text',
  myometrium: 'Myometrium',
  cervixFinding: 'Cervix and cervical canal',
  cervicalLength: 'Cervical length',
  rightOvaryDimensions: 'Right ovary: dimensions',
  rightOvaryVolume: 'Right ovary: volume',
  rightOvaryMobility: 'Right ovary: mobility',
  rightOvaryTexture: 'Right ovary: texture',
  rightOvaryFollicles: 'Right ovary: dominant follicles',
  rightOvaryOther: 'Right ovary: other adnexal abnormalities',
  leftOvaryDimensions: 'Left ovary: dimensions',
  leftOvaryVolume: 'Left ovary: volume',
  leftOvaryMobility: 'Left ovary: mobility',
  leftOvaryTexture: 'Left ovary: texture',
  leftOvaryFollicles: 'Left ovary: dominant follicles',
  leftOvaryOther: 'Left ovary: other adnexal abnormalities',
  douglasSliding: 'Douglas pouch: sliding sign',
  douglasFluid: 'Douglas pouch: fluid',
  conclusion: 'Conclusion',
};

/** Seeded 4D structure, in the exact printed order. */
const GYN4D_CLASSIC_KEYS = [
  'lmp',
  'serialVisit',
  'scanQuality',
  'routeOfScan',
  'referredBy',
  'uterusDesc',
  'uterineMeasurements',
  'uterusMobility',
  'endoCavity',
  'endoTexture',
  'endoJunctionStatus',
  'endoJunction',
  'myometrium',
  'cervixFinding',
  'cervicalLength',
  'rightOvaryDimensions',
  'rightOvaryVolume',
  'rightOvaryMobility',
  'rightOvaryTexture',
  'rightOvaryFollicles',
  'rightOvaryOther',
  'leftOvaryDimensions',
  'leftOvaryVolume',
  'leftOvaryMobility',
  'leftOvaryTexture',
  'leftOvaryFollicles',
  'leftOvaryOther',
  'douglasSliding',
  'douglasFluid',
  'conclusion',
] as const;

const GYN4D_INFO_KEYS = new Set(['lmp', 'serialVisit', 'scanQuality', 'routeOfScan', 'referredBy']);
const GYN4D_UTERUS_KEYS = new Set([
  'uterusDesc',
  'uterineMeasurements',
  'uterusMobility',
  'endoCavity',
  'endoTexture',
  'endoJunctionStatus',
  'endoJunction',
  'myometrium',
  'cervixFinding',
  'cervicalLength',
]);
const GYN4D_ENDOMETRIUM_KEYS = new Set([
  'endoCavity',
  'endoTexture',
  'endoJunctionStatus',
  'endoJunction',
]);
const GYN4D_INFO_FALLBACK_LABELS: Record<string, string> = {
  lmp: 'LMP',
  serialVisit: 'Serial Visit No',
  scanQuality: 'Scan quality',
  routeOfScan: 'Route of scan',
  referredBy: 'Referred By Prof Dr/',
};

/**
 * True when the template still contains exactly the seeded structure in the
 * seeded order. Those templates keep the original renderer byte-for-byte.
 * Any add, delete, reorder or hidden field switches to the structure-aware
 * renderer that follows the template.
 */
function isClassicGyn4dStructure(fields: ReportTemplateField[]): boolean {
  return (
    fields.length === GYN4D_CLASSIC_KEYS.length &&
    fields.every((field, index) => field.key === GYN4D_CLASSIC_KEYS[index])
  );
}


function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function text(content: Record<string, unknown>, key: string): string {
  const value = content[key];
  if (Array.isArray(value)) return value.map(String).join(', ');
  if (value === null || value === undefined) return '';
  return String(value);
}

function items(content: Record<string, unknown>, key: string): string[] {
  const value = content[key];
  const raw = Array.isArray(value) ? value.map(String) : String(value ?? '').split('\n');
  return raw.map((item) => item.trim()).filter(Boolean);
}

function dateOnly(value: Date | null, timezone: string): string {
  if (!value) return '';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(value);
}

const CSS = `
:root{--pink:#E32D91;--purple:#C830CC;--blue:#2581BA;
 --font:"Century Gothic","URW Gothic","Questrial","Avant Garde","Segoe UI",Arial,"Noto Sans",sans-serif;
 --script:"Monotype Corsiva","URW Chancery L","Z003","Apple Chancery","Lucida Calligraphy",cursive}
*{box-sizing:border-box}
@page{size:${PAGE_SIZE};margin:0}
html,body{margin:0;padding:0}
body{font-family:var(--font);color:#000;line-height:1.25;background:#fff}
.hdr{position:fixed;top:.2in;left:1in;right:.5in;display:flex;align-items:center;justify-content:space-between}
.hdr .txt{flex:1;text-align:center;direction:rtl;font-size:12pt;line-height:1.25}
.hdr .dr{color:var(--purple);font-weight:700;font-size:16pt}
.hdr img{width:2.22in;height:1.185in;display:block}
.ftr{position:fixed;bottom:.4in;left:1in;right:.5in;display:flex;justify-content:space-between;align-items:flex-end;gap:.3in;color:var(--pink);font-weight:700;font-size:12pt}
.ftr .addr{direction:rtl;text-align:right}
.ftr .tel{direction:ltr;white-space:nowrap}
.draft{position:fixed;top:.04in;left:0;right:0;text-align:center;color:#c00;font-weight:700;font-size:9pt;letter-spacing:.12em}
table.wrap{width:100%;border-collapse:collapse}
table.wrap>thead>tr>td,table.wrap>tbody>tr>td,table.wrap>tfoot>tr>td{padding:0}
.spacer-h{height:1.4in}.spacer-f{height:.95in}
.body-pad{padding:0 .5in 0 1in}
table.info{border-collapse:collapse;width:100%}
table.info td{padding:1px 0;vertical-align:baseline}
table.info td.l{font-weight:700;font-size:14pt;width:2.15in;white-space:nowrap}
table.info td.v{font-size:12pt}
table.info td.v.b{font-weight:700}
.refer{border:1px solid #000;padding:1px 4px;font-size:12pt;font-weight:700;margin-top:2px}
.title{text-align:center;color:var(--pink);font-size:18pt;margin:.05in 0 .02in;text-decoration:underline}
.title small{font-size:12pt}
h2{margin:.08in 0 .02in;font-size:16pt;font-weight:700;color:var(--pink);text-decoration:underline;display:flex;align-items:center;gap:6px;break-after:avoid}
h2::before{content:"";display:inline-block;width:.075in;height:.075in;background:var(--pink);flex:none}
h3.ov{font-size:16pt;font-weight:700;text-decoration:underline;margin:.05in 0 0 .08in;break-after:avoid}
.txt14{font-size:14pt;margin:2px 0}
ul{margin:2px 0;padding-left:.38in;font-size:14pt}
ul ul{list-style:circle;padding-left:.4in}
li{margin:1px 0}
.lab{font-weight:700;text-decoration:underline}
.blue{color:var(--blue);font-weight:700;font-style:italic;text-decoration:underline}
ul.sm{font-size:12pt;font-weight:700;list-style:circle}
ul.concl{font-weight:700}
table.ov{border-collapse:collapse;width:96%;margin:0 0 0 .08in;font-size:12pt;break-inside:avoid}
table.ov tr.first td{border-top:1px solid #000}
table.ov td{padding:1px 6px 1px 8px;vertical-align:top}
table.ov td.l{font-weight:700;width:2in;white-space:nowrap}
table.ov tr.other td{border-top:1px solid #000;border-bottom:1px solid #000}
table.ov tr.other td.l{text-decoration:underline;border-right:1px solid #000;white-space:normal}
table.ov tr.other td.v{font-size:10pt}
section{break-inside:avoid}
.sign{text-align:center;margin-top:.25in;break-inside:avoid}
.sign .best{font-family:var(--script);font-weight:700;font-style:italic;font-size:18pt}
.sign .name{font-family:var(--script);font-weight:700;font-style:italic;font-size:22pt;line-height:1.1}
.sign .role{font-size:11pt;margin-top:2px}
.sign .uni{font-size:13pt}
`;

export function renderGyn4dHtml(input: ReportPdfInput): string {
  const c = input.report.content;
  const tz = input.clinic.timezone;
  const settings = input.report.templateLayout?.gyn4d ?? {};
  const setting = (value: string | undefined, fallback: string): string => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : fallback;
  };
  const t = (key: string) => esc(text(c, key));
  const patientName = `${input.patient.firstName} ${input.patient.lastName}`.trim();
  const conclusion = items(c, 'conclusion')
    .map((item) => `<li>${esc(item)}</li>`)
    .join('');

  const pageTitle = esc(setting(settings.pageTitle, DEFAULT_PAGE_TITLE));
  const scanTitle = settings.scanTitle?.trim();
  const titleHtml = scanTitle
    ? esc(scanTitle)
    : '<b>4D</b> Gynecology <small>SCAN</small>';
  const headerLines = settings.headerText?.trim()
    ? settings.headerText
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
    : DEFAULT_HEADER_LINES;
  const headerHtml = headerLines
    .map((line, index) => `<div${index === 0 ? ' class="dr"' : ''}>${esc(line)}</div>`)
    .join('\n  ');
  const doctorName = setting(settings.doctorName, DEFAULT_DOCTOR_NAME);
  const doctorRole = setting(settings.doctorRole, DEFAULT_DOCTOR_ROLE);
  const doctorUniversity = setting(settings.doctorUniversity, DEFAULT_DOCTOR_UNIVERSITY);
  const phone = setting(settings.phone, DEFAULT_PHONE);
  const address = setting(settings.address, DEFAULT_ADDRESS);

  const fieldLabelByKey = new Map<string, string>();
  for (const field of input.report.templateFields ?? []) {
    if (typeof field?.key === 'string' && typeof field.label === 'string') {
      fieldLabelByKey.set(field.key, field.label.trim());
    }
  }
  const customFieldLabel = (key: string): string | null => {
    const label = fieldLabelByKey.get(key);
    if (!label) return null;
    const baseline = GYN4D_SEED_LABELS[key];
    return baseline && label === baseline ? null : label;
  };
  const beforeColon = (value: string): string => value.split(':')[0]?.trim() || value;
  const afterColon = (value: string): string => {
    const index = value.indexOf(':');
    return index >= 0 ? value.slice(index + 1).trim() || value : value;
  };
  const capitalize = (value: string): string =>
    value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
  /**
   * Printed label for a 4D field. `fallback` is the historical wording, so an
   * untouched template prints exactly as before; a renamed field prints the new
   * label. `before`/`after` extract the section or row part of labels such as
   * "Right ovary: dimensions".
   */
  const printLabel = (
    key: string,
    fallback: string,
    mode: 'full' | 'before' | 'after' = 'full',
  ): string => {
    const custom = customFieldLabel(key);
    if (!custom) return fallback;
    if (mode === 'before') return esc(beforeColon(custom));
    if (mode === 'after') return esc(capitalize(afterColon(custom)));
    return esc(custom);
  };


  const ovarySection = (side: 'right' | 'left'): string => {
    const S = side === 'right' ? 'Right' : 'Left';
    const k = (name: string) => `${side}Ovary${name}`;
    const adnexum = esc(
      setting(side === 'right' ? settings.rightAdnexum : settings.leftAdnexum, `${S} adnexum`),
    );
    return `<section>
<h2>${adnexum}:</h2>
<h3 class="ov">${printLabel(k('Dimensions'), `${S} ovary`, 'before')}:</h3>
<table class="ov">
<tr class="first"><td class="l">${printLabel(k('Dimensions'), 'Dimensions', 'after')}</td><td>${t(k('Dimensions'))}</td></tr>
<tr><td class="l">${printLabel(k('Volume'), 'Ovarian volume', 'after')}:</td><td>${t(k('Volume'))}</td></tr>
<tr><td class="l">${printLabel(k('Mobility'), 'Mobility of ovary', 'after')}:</td><td>${t(k('Mobility'))}</td></tr>
<tr><td class="l">${printLabel(k('Texture'), 'Texture of ovary', 'after')}</td><td>${t(k('Texture'))}</td></tr>
<tr><td class="l">${printLabel(k('Follicles'), 'Dominant follicles', 'after')}:</td><td>${t(k('Follicles'))}</td></tr>
<tr class="other"><td class="l">${printLabel(k('Other'), 'Other adnexal abnormalities', 'after')}</td><td class="v">${t(k('Other'))}</td></tr>
</table>
</section>`;
  };

  const templateFields = input.report.templateFields ?? [];
  const visibleFields = templateFields.filter(
    (field) => typeof field?.key === 'string' && field.visible !== false,
  );
  const classic = templateFields.length === 0 || isClassicGyn4dStructure(visibleFields);
  const fieldByKey = new Map(visibleFields.map((field) => [field.key, field]));

  const fieldValue = (field: ReportTemplateField): string | string[] =>
    field.type === 'list' ? items(c, field.key) : text(c, field.key).trim();
  const hasValue = (field: ReportTemplateField): boolean => {
    const value = fieldValue(field);
    return Array.isArray(value) ? value.length > 0 : Boolean(value);
  };
  const fieldLabel = (field: ReportTemplateField): string =>
    customFieldLabel(field.key) ?? field.label?.trim() ?? field.key;
  const headingText = (value: string): string => esc(value.trim().replace(/:\s*$/, ''));
  const rowLabel = (field: ReportTemplateField): string => {
    const label = fieldLabel(field);
    return label.includes(':') ? capitalize(afterColon(label)) : label;
  };
  const listItems = (value: string[]): string =>
    value.map((item) => `<li>${esc(item)}</li>`).join('');

  const infoFields = visibleFields.filter(
    (field) => GYN4D_INFO_KEYS.has(field.key) && hasValue(field),
  );
  const referral = infoFields.find((field) => field.key === 'referredBy');
  const infoRows = infoFields
    .filter((field) => field.key !== 'referredBy')
    .map((field) => {
      const label = printLabel(
        field.key,
        GYN4D_INFO_FALLBACK_LABELS[field.key] ?? fieldLabel(field),
      );
      const valueClass = field.key === 'routeOfScan' ? 'v b' : 'v';
      return `<tr><td class="l">${label}</td><td class="${valueClass}">${t(field.key)}</td></tr>`;
    })
    .join('\n');

  const units: Array<{ kind: string; fields: ReportTemplateField[] }> = [];
  const seenUnits = new Set<string>();
  for (const field of visibleFields) {
    if (GYN4D_INFO_KEYS.has(field.key)) continue;
    let kind = `field:${field.key}`;
    let group: ReportTemplateField[] = [field];
    if (GYN4D_UTERUS_KEYS.has(field.key)) {
      kind = 'uterus';
      group = visibleFields.filter((item) => GYN4D_UTERUS_KEYS.has(item.key));
    } else if (field.key.startsWith('rightOvary')) {
      kind = 'rightOvary';
      group = visibleFields.filter((item) => item.key.startsWith('rightOvary'));
    } else if (field.key.startsWith('leftOvary')) {
      kind = 'leftOvary';
      group = visibleFields.filter((item) => item.key.startsWith('leftOvary'));
    } else if (field.key.startsWith('douglas')) {
      kind = 'douglas';
      group = visibleFields.filter((item) => item.key.startsWith('douglas'));
    } else if (field.key === 'conclusion') {
      kind = 'conclusion';
    }
    if (seenUnits.has(kind)) continue;
    seenUnits.add(kind);
    units.push({ kind, fields: group });
  }

  const renderUterus = (group: ReportTemplateField[]): string => {
    const present = group.filter(hasValue);
    if (present.length === 0) return '';
    const desc = group.find((field) => field.key === 'uterusDesc' && hasValue(field));
    const children = group.filter((field) => field.key !== 'uterusDesc' && hasValue(field));
    const lines: string[] = [];
    let endometriumDone = false;
    let cervixDone = false;
    for (const field of children) {
      if (GYN4D_ENDOMETRIUM_KEYS.has(field.key)) {
        if (endometriumDone) continue;
        endometriumDone = true;
        const endoFields = children.filter((item) => GYN4D_ENDOMETRIUM_KEYS.has(item.key));
        const headingField = endoFields.find((item) => item.key === 'endoCavity') ?? endoFields[0];
        const endoHeading = headingField
          ? printLabel(headingField.key, 'Endometrium', 'before')
          : 'Endometrium';
        const endoLines: string[] = [];
        let junctionDone = false;
        for (const item of endoFields) {
          if (item.key === 'endoJunctionStatus' || item.key === 'endoJunction') {
            if (junctionDone) continue;
            junctionDone = true;
            const status = fieldByKey.get('endoJunctionStatus');
            const junction = fieldByKey.get('endoJunction');
            const statusValue = status && hasValue(status) ? t('endoJunctionStatus') : '';
            const junctionValue = junction && hasValue(junction) ? t('endoJunction') : '';
            if (statusValue && junctionValue) {
              endoLines.push(`   <li><b>${statusValue}</b> ${junctionValue}</li>`);
            } else if (statusValue) {
              endoLines.push(`   <li><b>${statusValue}</b></li>`);
            } else if (junctionValue) {
              endoLines.push(`   <li>${junctionValue}</li>`);
            }
            continue;
          }
          endoLines.push(`   <li>${t(item.key)}</li>`);
        }
        if (endoLines.length > 0) {
          lines.push(`<li><span class="lab">${endoHeading}:</span>
  <div class="blue">3D rendering of the endometrium showing :-</div>
  <ul>
${endoLines.join('\n')}
  </ul>
 </li>`);
        }
        continue;
      }
      if (field.key === 'cervixFinding' || field.key === 'cervicalLength') {
        if (cervixDone) continue;
        cervixDone = true;
        const cervixLines: string[] = [];
        const cervixFinding = fieldByKey.get('cervixFinding');
        const cervicalLength = fieldByKey.get('cervicalLength');
        if (cervixFinding && hasValue(cervixFinding)) {
          cervixLines.push(`   <li>${t('cervixFinding')}</li>`);
        }
        if (cervicalLength && hasValue(cervicalLength)) {
          cervixLines.push(
            `   <li>${printLabel('cervicalLength', 'Cervical Length', 'before')} : ${t('cervicalLength')}</li>`,
          );
        }
        if (cervixLines.length > 0) {
          lines.push(`<li style="margin-top:4px"><span class="lab">${printLabel('cervixFinding', 'Cervix &amp; Cervical Canal', 'before')}</span> :
  <ul>
${cervixLines.join('\n')}
  </ul>
 </li>`);
        }
        continue;
      }
      if (field.key === 'uterineMeasurements') {
        lines.push(
          `<li><span class="lab">${printLabel('uterineMeasurements', 'Uterine measurements', 'before')}:</span> ${t('uterineMeasurements')}</li>`,
        );
        continue;
      }
      if (field.key === 'uterusMobility') {
        lines.push(`<li class="lab">${t('uterusMobility')}</li>`);
        continue;
      }
      if (field.key === 'myometrium') {
        lines.push(`<li style="margin-top:4px"><span class="lab">${printLabel('myometrium', 'Myometrium', 'before')}:</span>
  <ul><li>${t('myometrium')}</li></ul>
 </li>`);
        continue;
      }
      lines.push(`<li><span class="lab">${esc(fieldLabel(field))}:</span> ${t(field.key)}</li>`);
    }
    let html = '<section>';
    html += `\n<h2>${printLabel('uterusDesc', 'Uterus', 'before')}:</h2>`;
    if (desc) html += `\n<div class="txt14">${t('uterusDesc')}</div>`;
    if (lines.length > 0) html += `\n<ul>\n ${lines.join('\n ')}\n</ul>`;
    return `${html}\n</section>`;
  };

  const renderOvary = (side: 'right' | 'left'): string => {
    const prefix = `${side}Ovary`;
    const group = visibleFields.filter(
      (field) => field.key.startsWith(prefix) && hasValue(field),
    );
    if (group.length === 0) return '';
    const S = side === 'right' ? 'Right' : 'Left';
    const adnexum = esc(
      setting(side === 'right' ? settings.rightAdnexum : settings.leftAdnexum, `${S} adnexum`),
    );
    const headingField = group.find((field) => field.key === `${prefix}Dimensions`) ?? group[0]!;
    const subHeading = headingText(fieldLabel(headingField).split(':')[0] ?? fieldLabel(headingField));
    const rows = group.map((field, index) => {
      const classes = [index === 0 ? 'first' : '', index === group.length - 1 ? 'other' : '']
        .filter(Boolean)
        .join(' ');
      const valueClass = index === group.length - 1 ? ' class="v"' : '';
      return `<tr${classes ? ` class="${classes}"` : ''}><td class="l">${esc(rowLabel(field))}:</td><td${valueClass}>${t(field.key)}</td></tr>`;
    });
    return `<section>
<h2>${adnexum}:</h2>
<h3 class="ov">${subHeading}:</h3>
<table class="ov">
${rows.join('\n')}
</table>
</section>`;
  };

  const renderDouglas = (group: ReportTemplateField[]): string => {
    const present = group.filter(hasValue);
    if (present.length === 0) return '';
    const headingField = present[0];
    const title = headingField
      ? printLabel(headingField.key, 'Douglas Pouch', 'before')
      : 'Douglas Pouch';
    return `<section>
<h2>${title}:</h2>
<ul class="sm">${present.map((field) => `<li>${t(field.key)}</li>`).join('')}</ul>
</section>`;
  };

  const renderConclusion = (): string => {
    const list = items(c, 'conclusion');
    if (list.length === 0) return '';
    return `<section>
<h2 style="margin-top:.2in">${printLabel('conclusion', 'Conclusion', 'before')} :</h2>
<ul class="concl">${listItems(list)}</ul>
</section>`;
  };

  const renderField = (field: ReportTemplateField): string => {
    if (!hasValue(field)) return '';
    const title = headingText(fieldLabel(field));
    if (field.type === 'list') {
      const list = items(c, field.key);
      if (list.length === 0) return '';
      return `<section>
<h2>${title}:</h2>
<ul class="concl">${listItems(list)}</ul>
</section>`;
    }
    return `<section>
<h2>${title}:</h2>
<div class="txt14">${t(field.key)}</div>
</section>`;
  };

  const renderUnit = (unit: { kind: string; fields: ReportTemplateField[] }): string => {
    if (unit.kind === 'uterus') return renderUterus(unit.fields);
    if (unit.kind === 'rightOvary') return renderOvary('right');
    if (unit.kind === 'leftOvary') return renderOvary('left');
    if (unit.kind === 'douglas') return renderDouglas(unit.fields);
    if (unit.kind === 'conclusion') return renderConclusion();
    return renderField(unit.fields[0]!);
  };

  const signBlock = `<div class="sign">
 <div class="best">Best regards.</div>
 <div class="name">${esc(doctorName)}</div>
 <div class="role">${esc(doctorRole)}</div>
 <div class="uni">${esc(doctorUniversity)}</div>
</div>`;

  const classicBody = `
<table class="info">
<tr><td class="l">Name</td><td class="v">${esc(patientName)}</td></tr>
<tr><td class="l">Exam. Date</td><td class="v">${esc(dateOnly(input.examination.visitDate, tz))}</td></tr>
<tr><td class="l">Date of Birth</td><td class="v">${esc(dateOnly(input.patient.dateOfBirth, tz))}</td></tr>
<tr><td class="l">${printLabel('lmp', 'LMP')}</td><td class="v">${t('lmp')}</td></tr>
<tr><td class="l">${printLabel('serialVisit', 'Serial Visit No')}</td><td class="v">${t('serialVisit')}</td></tr>
<tr><td class="l">${printLabel('scanQuality', 'Scan quality')}</td><td class="v">${t('scanQuality')}</td></tr>
<tr><td class="l">${printLabel('routeOfScan', 'Route of scan')}</td><td class="v b">${t('routeOfScan')}</td></tr>
</table>
<div class="refer"><i>${printLabel('referredBy', 'Referred By Prof Dr/')}</i> ${t('referredBy')}</div>

<div class="title">${titleHtml}</div>

<section>
<h2>${printLabel('uterusDesc', 'Uterus', 'before')}:</h2>
<div class="txt14">${t('uterusDesc')}</div>
<ul>
 <li><span class="lab">${printLabel('uterineMeasurements', 'Uterine measurements', 'before')}:</span> ${t('uterineMeasurements')}</li>
 <li class="lab">${t('uterusMobility')}</li>
 <li><span class="lab">${printLabel('endoCavity', 'Endometrium', 'before')}:</span>
  <div class="blue">3D rendering of the endometrium showing :-</div>
  <ul>
   <li>${t('endoCavity')}</li>
   <li>${t('endoTexture')}</li>
   <li><b>${t('endoJunctionStatus')}</b> ${t('endoJunction')}</li>
  </ul>
 </li>
 <li style="margin-top:4px"><span class="lab">${printLabel('myometrium', 'Myometrium', 'before')}:</span>
  <ul><li>${t('myometrium')}</li></ul>
 </li>
 <li style="margin-top:4px"><span class="lab">${printLabel('cervixFinding', 'Cervix &amp; Cervical Canal', 'before')}</span> :
  <ul>
   <li>${t('cervixFinding')}</li>
   <li>${printLabel('cervicalLength', 'Cervical Length', 'before')} : ${t('cervicalLength')}</li>
  </ul>
 </li>
</ul>
</section>

${ovarySection('right')}
${ovarySection('left')}

<section>
<h2>${printLabel('douglasSliding', 'Douglas Pouch', 'before')}:</h2>
<ul class="sm"><li>${t('douglasSliding')}</li><li>${t('douglasFluid')}</li></ul>
</section>

<section>
<h2 style="margin-top:.2in">${printLabel('conclusion', 'Conclusion', 'before')} :</h2>
<ul class="concl">${conclusion}</ul>
</section>

${signBlock}
`;

  const contentHtml = units.map(renderUnit).filter(Boolean).join('\n\n');
  const referralHtml = referral
    ? `\n<div class="refer"><i>${printLabel('referredBy', 'Referred By Prof Dr/')}</i> ${t('referredBy')}</div>`
    : '';
  const dynamicBody = `
<table class="info">
<tr><td class="l">Name</td><td class="v">${esc(patientName)}</td></tr>
<tr><td class="l">Exam. Date</td><td class="v">${esc(dateOnly(input.examination.visitDate, tz))}</td></tr>
<tr><td class="l">Date of Birth</td><td class="v">${esc(dateOnly(input.patient.dateOfBirth, tz))}</td></tr>
${infoRows}
</table>${referralHtml}

<div class="title">${titleHtml}</div>
${contentHtml ? `\n${contentHtml}\n` : '\n'}
${signBlock}
`;

  const body = classic ? classicBody : dynamicBody;

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>${pageTitle}</title>
<style>${CSS}</style></head><body>
${input.report.status === 'DRAFT' ? '<div class="draft">DRAFT - NOT A FINAL REPORT</div>' : ''}
<div class="hdr">
 <div class="txt">
  ${headerHtml}
 </div>
 <img src="${GYN4D_LOGO}" alt="">
</div>
<div class="ftr">
 <div class="tel">${esc(phone)}</div>
 <div class="addr">${esc(address)}</div>
</div>
<table class="wrap"><thead><tr><td><div class="spacer-h"></div></td></tr></thead>
<tbody><tr><td><div class="body-pad">
${body}
</div></td></tr></tbody>
<tfoot><tr><td><div class="spacer-f"></div></td></tr></tfoot></table>
</body></html>`;
}

export async function renderGyn4dPdf(input: ReportPdfInput): Promise<Buffer> {
  return renderHtmlToPdf(renderGyn4dHtml(input), PAGE_SIZE);
}
