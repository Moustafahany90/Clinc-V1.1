import type { Browser } from 'playwright';
import type { ReportPdfInput } from './reportPdf.js';
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
.hdr img{width:2.22in;height:auto;display:block}
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
  const t = (key: string) => esc(text(c, key));
  const patientName = `${input.patient.firstName} ${input.patient.lastName}`.trim();
  const conclusion = items(c, 'conclusion')
    .map((item) => `<li>${esc(item)}</li>`)
    .join('');

  const ovarySection = (side: 'right' | 'left'): string => {
    const S = side === 'right' ? 'Right' : 'Left';
    const k = (name: string) => `${side}Ovary${name}`;
    return `<section>
<h2>${S} adnexum:</h2>
<h3 class="ov">${S} ovary:</h3>
<table class="ov">
<tr class="first"><td class="l">Dimensions</td><td>${t(k('Dimensions'))}</td></tr>
<tr><td class="l">Ovarian volume:</td><td>${t(k('Volume'))}</td></tr>
<tr><td class="l">Mobility of ovary:</td><td>${t(k('Mobility'))}</td></tr>
<tr><td class="l">Texture of ovary</td><td>${t(k('Texture'))}</td></tr>
<tr><td class="l">Dominant follicles:</td><td>${t(k('Follicles'))}</td></tr>
<tr class="other"><td class="l">Other adnexal abnormalities</td><td class="v">${t(k('Other'))}</td></tr>
</table>
</section>`;
  };

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>4D Gynecology Scan</title>
<style>${CSS}</style></head><body>
${input.report.status === 'DRAFT' ? '<div class="draft">DRAFT - NOT A FINAL REPORT</div>' : ''}
<div class="hdr">
 <div class="txt">
  <div class="dr">د/ منيره علي علي</div>
  <div>استشاري الموجات الصوتية و طب الجنين</div>
  <div>بوحده طب الجنين- جامعه عين شمس</div>
 </div>
 <img src="${GYN4D_LOGO}" alt="">
</div>
<div class="ftr">
 <div class="tel">Tel : 01113735454 - 01555579454</div>
 <div class="addr">10 ش سامي عبد العال – ارض الجولف – مصر الجديدة</div>
</div>
<table class="wrap"><thead><tr><td><div class="spacer-h"></div></td></tr></thead>
<tbody><tr><td><div class="body-pad">

<table class="info">
<tr><td class="l">Name</td><td class="v">${esc(patientName)}</td></tr>
<tr><td class="l">Exam. Date</td><td class="v">${esc(dateOnly(input.examination.visitDate, tz))}</td></tr>
<tr><td class="l">Date of Birth</td><td class="v">${esc(dateOnly(input.patient.dateOfBirth, tz))}</td></tr>
<tr><td class="l">LMP</td><td class="v">${t('lmp')}</td></tr>
<tr><td class="l">Serial Visit No</td><td class="v">${t('serialVisit')}</td></tr>
<tr><td class="l">Scan quality</td><td class="v">${t('scanQuality')}</td></tr>
<tr><td class="l">Route of scan</td><td class="v b">${t('routeOfScan')}</td></tr>
</table>
<div class="refer"><i>Referred By Prof Dr/</i> ${t('referredBy')}</div>

<div class="title"><b>4D</b> Gynecology <small>SCAN</small></div>

<section>
<h2>Uterus:</h2>
<div class="txt14">${t('uterusDesc')}</div>
<ul>
 <li><span class="lab">Uterine measurements:</span> ${t('uterineMeasurements')}</li>
 <li class="lab">${t('uterusMobility')}</li>
 <li><span class="lab">Endometrium:</span>
  <div class="blue">3D rendering of the endometrium showing :-</div>
  <ul>
   <li>${t('endoCavity')}</li>
   <li>${t('endoTexture')}</li>
   <li><b>${t('endoJunctionStatus')}</b> ${t('endoJunction')}</li>
  </ul>
 </li>
 <li style="margin-top:4px"><span class="lab">Myometrium:</span>
  <ul><li>${t('myometrium')}</li></ul>
 </li>
 <li style="margin-top:4px"><span class="lab">Cervix &amp; Cervical Canal</span> :
  <ul>
   <li>${t('cervixFinding')}</li>
   <li>Cervical Length : ${t('cervicalLength')}</li>
  </ul>
 </li>
</ul>
</section>

${ovarySection('right')}
${ovarySection('left')}

<section>
<h2>Douglas Pouch:</h2>
<ul class="sm"><li>${t('douglasSliding')}</li><li>${t('douglasFluid')}</li></ul>
</section>

<section>
<h2 style="margin-top:.2in">Conclusion :</h2>
<ul class="concl">${conclusion}</ul>
</section>

<div class="sign">
 <div class="best">Best regards.</div>
 <div class="name">Dr. Monira Ali Ali</div>
 <div class="role">Ultrasound and fetal medicine consultant, Fetal medicine unit,</div>
 <div class="uni">Ain shams University.</div>
</div>

</div></td></tr></tbody>
<tfoot><tr><td><div class="spacer-f"></div></td></tr></tfoot></table>
</body></html>`;
}

let browserPromise: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = import('playwright').then(({ chromium }) =>
      chromium.launch({ args: ['--no-sandbox'] }),
    );
    browserPromise.catch(() => {
      browserPromise = null;
    });
  }
  const browser = await browserPromise;
  if (!browser.isConnected()) {
    browserPromise = null;
    return getBrowser();
  }
  return browser;
}

export async function renderGyn4dPdf(input: ReportPdfInput): Promise<Buffer> {
  const browser = await getBrowser();
  // JavaScript off and every non-data request blocked: the HTML is static and
  // must never reach out to the network while rendering clinical data.
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    await page.route('**/*', (route) =>
      route.request().url().startsWith('data:') ? route.continue() : route.abort(),
    );
    await page.setContent(renderGyn4dHtml(input), { waitUntil: 'load' });
    const pdf = await page.pdf({
      format: PAGE_SIZE,
      printBackground: true,
      preferCSSPageSize: true,
    });
    return Buffer.from(pdf);
  } finally {
    await context.close();
  }
}
