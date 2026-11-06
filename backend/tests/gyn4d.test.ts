import assert from 'node:assert/strict';
import test from 'node:test';
import { renderGyn4dHtml } from '../src/lib/gyn4d.js';
import type { ReportPdfInput } from '../src/lib/reportPdf.js';
import type { ReportTemplateField } from '../src/lib/reportTypes.js';

const CLASSIC_FIELDS: ReportTemplateField[] = [
  { key: 'lmp', label: 'LMP', type: 'text' },
  { key: 'serialVisit', label: 'Serial Visit No', type: 'text' },
  { key: 'scanQuality', label: 'Scan quality', type: 'text' },
  { key: 'routeOfScan', label: 'Route of scan', type: 'text' },
  { key: 'referredBy', label: 'Referred by Prof Dr/', type: 'text' },
  { key: 'uterusDesc', label: 'Uterus', type: 'textarea' },
  { key: 'uterineMeasurements', label: 'Uterine measurements', type: 'text' },
  { key: 'uterusMobility', label: 'Uterus mobility', type: 'text' },
  { key: 'endoCavity', label: 'Endometrium: cavity (3D)', type: 'text' },
  { key: 'endoTexture', label: 'Endometrium: texture and thickness', type: 'text' },
  { key: 'endoJunctionStatus', label: 'Junction status', type: 'text' },
  { key: 'endoJunction', label: 'Junction text', type: 'text' },
  { key: 'myometrium', label: 'Myometrium', type: 'text' },
  { key: 'cervixFinding', label: 'Cervix and cervical canal', type: 'text' },
  { key: 'cervicalLength', label: 'Cervical length', type: 'text' },
  { key: 'rightOvaryDimensions', label: 'Right ovary: dimensions', type: 'text' },
  { key: 'rightOvaryVolume', label: 'Right ovary: volume', type: 'text' },
  { key: 'rightOvaryMobility', label: 'Right ovary: mobility', type: 'text' },
  { key: 'rightOvaryTexture', label: 'Right ovary: texture', type: 'text' },
  { key: 'rightOvaryFollicles', label: 'Right ovary: dominant follicles', type: 'text' },
  { key: 'rightOvaryOther', label: 'Right ovary: other adnexal abnormalities', type: 'text' },
  { key: 'leftOvaryDimensions', label: 'Left ovary: dimensions', type: 'text' },
  { key: 'leftOvaryVolume', label: 'Left ovary: volume', type: 'text' },
  { key: 'leftOvaryMobility', label: 'Left ovary: mobility', type: 'text' },
  { key: 'leftOvaryTexture', label: 'Left ovary: texture', type: 'text' },
  { key: 'leftOvaryFollicles', label: 'Left ovary: dominant follicles', type: 'text' },
  { key: 'leftOvaryOther', label: 'Left ovary: other adnexal abnormalities', type: 'text' },
  { key: 'douglasSliding', label: 'Douglas pouch: sliding sign', type: 'text' },
  { key: 'douglasFluid', label: 'Douglas pouch: fluid', type: 'text' },
  { key: 'conclusion', label: 'Conclusion', type: 'list' },
];

function input(overrides: Partial<ReportPdfInput['report']> = {}): ReportPdfInput {
  return {
    clinic: {
      name: 'Template Test Clinic',
      phone: '01000000000',
      email: 'clinic@example.test',
      address: 'Cairo',
      timezone: 'Africa/Cairo',
    },
    report: {
      id: 'report-1',
      status: 'FINALIZED',
      versionNumber: 1,
      finalizedAt: new Date('2026-01-01T10:00:00Z'),
      lastAmendedAt: null,
      content: {
        lmp: '01/01/2026',
        uterusDesc: 'Uterus is AVF',
        conclusion: ['Normal scan'],
      },
      templateName: '4D Gynecology Scan',
      templateVersion: '2026-01-01T10:00:00.000Z',
      templateFields: CLASSIC_FIELDS.map((field) => ({ ...field })),
      templateLayout: {
        printLayout: 'gyn4d',
        showMeasurements: false,
        showSignature: false,
      },
      ...overrides,
    },
    patient: {
      patientNumber: 'P-1',
      firstName: 'Synthetic',
      lastName: 'Patient',
      dateOfBirth: new Date('1990-04-12T00:00:00Z'),
      gender: 'FEMALE',
    },
    examination: {
      visitDate: new Date('2026-01-01T10:00:00Z'),
      doctor: 'Template Doctor',
      examinationType: 'Pelvic ultrasound',
      chiefComplaint: null,
    },
    measurements: [],
  };
}

test('gyn4d keeps the original design when no print settings are stored', () => {
  const html = renderGyn4dHtml(input());

  assert.ok(html.includes('<title>4D Gynecology Scan</title>'));
  assert.ok(html.includes('<b>4D</b> Gynecology <small>SCAN</small>'));
  assert.ok(html.includes('<h2>Uterus:</h2>'));
  assert.ok(html.includes('<h2>Right adnexum:</h2>'));
  assert.ok(html.includes('<h2>Left adnexum:</h2>'));
  assert.ok(html.includes('<h3 class="ov">Right ovary:</h3>'));
  assert.ok(html.includes('<td class="l">Dimensions</td>'));
  assert.ok(html.includes('<h2>Douglas Pouch:</h2>'));
  assert.ok(html.includes('Conclusion :</h2>'));
  assert.ok(html.includes('<div class="dr">د/ منيره علي علي</div>'));
  assert.ok(html.includes('استشاري الموجات الصوتية و طب الجنين'));
  assert.ok(html.includes('بوحده طب الجنين- جامعه عين شمس'));
  assert.ok(html.includes('<div class="tel">Tel : 01113735454 - 01555579454</div>'));
  assert.ok(
    html.includes('<div class="addr">10 ش سامي عبد العال – ارض الجولف – مصر الجديدة</div>'),
  );
  assert.ok(html.includes('<div class="name">Dr. Monira Ali Ali</div>'));
  assert.ok(
    html.includes(
      '<div class="role">Ultrasound and fetal medicine consultant, Fetal medicine unit,</div>',
    ),
  );
  assert.ok(html.includes('<div class="uni">Ain shams University.</div>'));
});

test('gyn4d renders template-specific print settings with escaping', () => {
  const html = renderGyn4dHtml(
    input({
      templateLayout: {
        printLayout: 'gyn4d',
        gyn4d: {
          pageTitle: 'Custom 4D scan',
          scanTitle: 'Pelvic <4D>',
          headerText: 'Dr. Custom\nCustom unit & hospital',
          doctorName: 'Dr. Custom',
          doctorRole: 'Consultant, <unit>',
          doctorUniversity: 'Custom University',
          phone: 'Tel : 100',
          address: '1 Custom Street',
          rightAdnexum: 'Right side <area>',
          leftAdnexum: 'Left side',
        },
      },
    }),
  );

  assert.ok(html.includes('<title>Custom 4D scan</title>'));
  assert.ok(html.includes('<div class="title">Pelvic &lt;4D&gt;</div>'));
  assert.ok(html.includes('<div class="dr">Dr. Custom</div>'));
  assert.ok(html.includes('<div>Custom unit &amp; hospital</div>'));
  assert.ok(html.includes('<div class="name">Dr. Custom</div>'));
  assert.ok(html.includes('<div class="role">Consultant, &lt;unit&gt;</div>'));
  assert.ok(html.includes('<div class="uni">Custom University</div>'));
  assert.ok(html.includes('<div class="tel">Tel : 100</div>'));
  assert.ok(html.includes('<div class="addr">1 Custom Street</div>'));
  assert.ok(html.includes('<h2>Right side &lt;area&gt;:</h2>'));
  assert.ok(html.includes('<h2>Left side:</h2>'));
  assert.ok(!html.includes('Dr. Monira Ali Ali'));
});

test('gyn4d printed headings follow renamed template fields', () => {
  const html = renderGyn4dHtml(
    input({
      content: {
        uterusDesc: 'Uterus is AVF',
        rightOvaryDimensions: '30 x 20 mm',
        leftOvaryDimensions: '31 x 21 mm',
        endoCavity: 'Inverted triangle',
        douglasSliding: 'Positive sliding sign',
        conclusion: ['Normal scan'],
      },
      templateFields: [
        { key: 'uterusDesc', label: 'Womb', type: 'textarea' },
        { key: 'rightOvaryDimensions', label: 'Right gonad: size', type: 'text' },
        { key: 'leftOvaryDimensions', label: 'Left gonad: size', type: 'text' },
        { key: 'endoCavity', label: 'Endometrial cavity: 3D', type: 'text' },
        { key: 'douglasSliding', label: 'Cul-de-sac: sliding', type: 'text' },
        { key: 'conclusion', label: 'Impression', type: 'list' },
      ],
    }),
  );

  assert.ok(html.includes('<h2>Womb:</h2>'));
  assert.ok(html.includes('<h3 class="ov">Right gonad:</h3>'));
  assert.ok(html.includes('<td class="l">Size:</td>'));
  assert.ok(html.includes('<h3 class="ov">Left gonad:</h3>'));
  assert.ok(html.includes('Endometrial cavity:</span>'));
  assert.ok(html.includes('<h2>Cul-de-sac:</h2>'));
  assert.ok(html.includes('>Impression :</h2>'));
});

test('gyn4d follows added, removed and reordered template sections', () => {
  const fields = CLASSIC_FIELDS.filter(
    (field) => field.key !== 'uterineMeasurements' && field.key !== 'douglasFluid',
  ).map((field) => ({ ...field }));
  fields.push({ key: 'section_31', label: 'Additional findings', type: 'textarea' });
  const conclusionIndex = fields.findIndex((field) => field.key === 'conclusion');
  const [conclusion] = fields.splice(conclusionIndex, 1);
  fields.unshift(conclusion!);

  const html = renderGyn4dHtml(
    input({
      templateFields: fields,
      content: {
        lmp: '01/01/2026',
        serialVisit: '2',
        scanQuality: 'Good',
        routeOfScan: 'Transvaginal',
        referredBy: 'Dr. Ref',
        uterusDesc: 'Uterus is AVF',
        uterineMeasurements: 'MEASUREMENT_MARKER',
        uterusMobility: 'Mobile uterus',
        endoCavity: 'Inverted triangle',
        endoTexture: 'Homogeneous',
        endoJunctionStatus: 'Normal',
        endoJunction: 'junction text',
        myometrium: 'Homogeneous',
        cervixFinding: 'No abnormality',
        cervicalLength: '33mm',
        rightOvaryDimensions: '30 x 20mm',
        rightOvaryVolume: '5cc',
        rightOvaryMobility: 'mobile',
        rightOvaryTexture: 'normal',
        rightOvaryFollicles: 'No',
        rightOvaryOther: 'No',
        leftOvaryDimensions: '31 x 21mm',
        leftOvaryVolume: '6cc',
        leftOvaryMobility: 'mobile',
        leftOvaryTexture: 'normal',
        leftOvaryFollicles: 'Yes',
        leftOvaryOther: 'No',
        douglasSliding: 'Positive',
        douglasFluid: 'FLUID_MARKER',
        conclusion: ['Normal scan'],
        section_31: 'Extra finding text',
      },
    }),
  );

  assert.ok(!html.includes('Uterine measurements'));
  assert.ok(!html.includes('MEASUREMENT_MARKER'));
  assert.ok(!html.includes('FLUID_MARKER'));
  assert.ok(html.includes('<h2>Additional findings:</h2>'));
  assert.ok(html.includes('Extra finding text'));
  assert.ok(html.includes('<h3 class="ov">Right ovary:</h3>'));
  assert.ok(html.indexOf('Conclusion :') < html.indexOf('<h2>Uterus:</h2>'));

  const hidden = renderGyn4dHtml(
    input({
      templateFields: fields.map((field) =>
        field.key === 'conclusion' ? { ...field, visible: false } : field,
      ),
      content: { conclusion: ['Normal scan'] },
    }),
  );
  assert.ok(!hidden.includes('Conclusion :'));
});

test('gyn4d blank settings fall back to the original values', () => {
  const html = renderGyn4dHtml(
    input({
      templateLayout: {
        printLayout: 'gyn4d',
        gyn4d: {
          pageTitle: '   ',
          scanTitle: '',
          headerText: '  ',
          doctorName: '',
          doctorRole: '\t',
          doctorUniversity: '',
          phone: ' ',
          address: '',
        },
      },
    }),
  );

  assert.ok(html.includes('<title>4D Gynecology Scan</title>'));
  assert.ok(html.includes('<div class="name">Dr. Monira Ali Ali</div>'));
  assert.ok(html.includes('<div class="tel">Tel : 01113735454 - 01555579454</div>'));
  assert.ok(
    html.includes('<div class="addr">10 ش سامي عبد العال – ارض الجولف – مصر الجديدة</div>'),
  );
});
