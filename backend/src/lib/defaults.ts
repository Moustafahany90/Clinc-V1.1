import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Prisma } from '@prisma/client';
import { prisma } from './prisma.js';
import { templateDefinitionSchema, validateDefinition } from './report-blocks/index.js';

const REPORT_TEMPLATES_DIR = fileURLToPath(
  new URL('../../prisma/report-templates/', import.meta.url),
);

type Gyn4dField = {
  key: string;
  label: string;
  type: 'text' | 'textarea' | 'list';
  required: boolean;
  visible: boolean;
  placeholder?: string;
  defaultValue?: string | string[];
};

const gyn4dField = (
  key: string,
  label: string,
  type: Gyn4dField['type'] = 'text',
  extra: Pick<Gyn4dField, 'placeholder' | 'defaultValue'> = {},
): Gyn4dField => ({ key, label, type, required: false, visible: true, ...extra });

const gyn4dOvaryFields = (side: 'right' | 'left'): Gyn4dField[] => {
  const S = side === 'right' ? 'Right' : 'Left';
  return [
    gyn4dField(`${side}OvaryDimensions`, `${S} ovary: dimensions`, 'text', {
      placeholder: '__ x __ x __ mm',
    }),
    gyn4dField(`${side}OvaryVolume`, `${S} ovary: volume`, 'text', { placeholder: 'cc' }),
    gyn4dField(`${side}OvaryMobility`, `${S} ovary: mobility`, 'text', {
      defaultValue: 'mobile',
    }),
    gyn4dField(`${side}OvaryTexture`, `${S} ovary: texture`, 'text', {
      defaultValue: 'normal texture',
    }),
    gyn4dField(`${side}OvaryFollicles`, `${S} ovary: dominant follicles`, 'text', {
      defaultValue: 'No',
    }),
    gyn4dField(`${side}OvaryOther`, `${S} ovary: other adnexal abnormalities`, 'text', {
      defaultValue: 'No',
    }),
  ];
};

const GYN4D_FIELDS: Gyn4dField[] = [
  gyn4dField('lmp', 'LMP', 'text', { placeholder: 'dd/mm/yyyy' }),
  gyn4dField('serialVisit', 'Serial Visit No', 'text', { defaultValue: '1' }),
  gyn4dField('scanQuality', 'Scan quality', 'text', { defaultValue: 'Good quality scan' }),
  gyn4dField('routeOfScan', 'Route of scan', 'text', { defaultValue: 'Transvaginal Scan' }),
  gyn4dField('referredBy', 'Referred by Prof Dr/'),
  gyn4dField('uterusDesc', 'Uterus', 'textarea', {
    defaultValue: 'Uterus is AVF , with symmetrical appearance.',
  }),
  gyn4dField('uterineMeasurements', 'Uterine measurements', 'text', {
    placeholder: '60 x 30 x 45mm',
  }),
  gyn4dField('uterusMobility', 'Uterus mobility', 'text', { defaultValue: 'Mobile uterus' }),
  gyn4dField('endoCavity', 'Endometrium: cavity (3D)', 'text', {
    defaultValue: 'Endometrial cavity is inverted triangle in coronal view',
  }),
  gyn4dField('endoTexture', 'Endometrium: texture and thickness', 'text', {
    defaultValue: 'Endometrium is homogeneous in texture with thickness = ',
  }),
  gyn4dField('endoJunctionStatus', 'Junction status', 'text', { defaultValue: 'Normal' }),
  gyn4dField('endoJunction', 'Junction text', 'text', {
    defaultValue: 'endometrial myometrial junction',
  }),
  gyn4dField('myometrium', 'Myometrium', 'text', {
    defaultValue: 'Myometrium is homogeneous with no focal lesion',
  }),
  gyn4dField('cervixFinding', 'Cervix and cervical canal', 'text', {
    defaultValue: 'No abnormality detected at scan time',
  }),
  gyn4dField('cervicalLength', 'Cervical length', 'text', { placeholder: '33mm' }),
  ...gyn4dOvaryFields('right'),
  ...gyn4dOvaryFields('left'),
  gyn4dField('douglasSliding', 'Douglas pouch: sliding sign', 'text', {
    defaultValue: 'Positive sliding sign of DP',
  }),
  gyn4dField('douglasFluid', 'Douglas pouch: fluid', 'text', {
    defaultValue: 'No Fluid collection:',
  }),
  gyn4dField('conclusion', 'Conclusion', 'list', {
    defaultValue: ['AVF uterus', 'Normal Both ovaries'],
  }),
];

/**
 * Idempotent, non-sensitive defaults only:
 *  - payment methods (no tax types, no invoice series)
 *  - basic expense categories
 *  - common ultrasound exam types with durations and zero price
 *  - clinic opening template (Sat/Sun 13:00, Mon-Wed 14:30, Thu/Fri closed
 *    until an administrator configures them)
 *
 * Never seeds patients, reports, payments, staff accounts or credentials.
 */
export async function ensureDefaults(
  tx: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<void> {
  await tx.paymentMethod.createMany({
    data: [
      { key: 'CASH', label: 'Cash', requiresReference: false, sortOrder: 1 },
      { key: 'INSTAPAY', label: 'InstaPay', requiresReference: true, sortOrder: 2 },
      { key: 'BANK_TRANSFER', label: 'Bank transfer', requiresReference: true, sortOrder: 3 },
    ],
    skipDuplicates: true,
  });

  await tx.expenseCategory.createMany({
    data: [
      { name: 'Supplies' },
      { name: 'Equipment' },
      { name: 'Rent' },
      { name: 'Utilities' },
      { name: 'Salaries' },
      { name: 'Maintenance' },
      { name: 'Other' },
    ],
    skipDuplicates: true,
  });

  await tx.service.createMany({
    data: [
      { name: 'Abdominal ultrasound', durationMinutes: 20 },
      { name: 'Pelvic ultrasound', durationMinutes: 20 },
      { name: 'Obstetric ultrasound', durationMinutes: 20 },
      { name: 'Thyroid ultrasound', durationMinutes: 15 },
      { name: 'Breast ultrasound', durationMinutes: 20 },
      { name: 'Doppler ultrasound', durationMinutes: 30 },
    ],
    skipDuplicates: true,
  });

  await tx.workingHours.createMany({
    data: [
      { dayOfWeek: 1, isOpen: true, openMinute: 870, closeMinute: 1260 },
      { dayOfWeek: 2, isOpen: true, openMinute: 870, closeMinute: 1260 },
      { dayOfWeek: 3, isOpen: true, openMinute: 870, closeMinute: 1260 },
      { dayOfWeek: 4, isOpen: false, openMinute: 870, closeMinute: 1260 },
      { dayOfWeek: 5, isOpen: false, openMinute: 870, closeMinute: 1260 },
      { dayOfWeek: 6, isOpen: true, openMinute: 780, closeMinute: 1260 },
      { dayOfWeek: 7, isOpen: true, openMinute: 780, closeMinute: 1260 },
    ],
    skipDuplicates: true,
  });

  await tx.reportTemplate.createMany({
    data: [
      {
        name: 'General ultrasound report',
        description: 'Baseline structured ultrasound report with free-text findings.',
        fields: [
          { key: 'indication', label: 'Clinical indication', type: 'textarea', required: true },
          { key: 'findings', label: 'Findings', type: 'textarea', required: true },
          { key: 'measurements', label: 'Measurements', type: 'text', required: false },
          { key: 'impression', label: 'Impression / conclusion', type: 'textarea', required: true },
          { key: 'recommendations', label: 'Recommendations', type: 'textarea', required: false },
        ],
      },
    ],
    skipDuplicates: true,
  });

  // Fixed 4D gynecology design used by Dr. Monira. Upsert keeps the template
  // current when the seed is run again; reports keep their pinned snapshot.
  await tx.reportTemplate.upsert({
    where: { name: '4D Gynecology Scan' },
    update: {
      fields: GYN4D_FIELDS,
      layout: { printLayout: 'gyn4d', showMeasurements: false, showSignature: false },
    },
    create: {
      name: '4D Gynecology Scan',
      description: '4D transvaginal gynecology scan (Dr. Monira)',
      fields: GYN4D_FIELDS,
      layout: { printLayout: 'gyn4d', showMeasurements: false, showSignature: false },
      isActive: true,
      isDefault: false,
    },
  });

  // Block-based report templates. Idempotent upsert by unique name; every file
  // is schema-checked and cross-validated before anything is written.
  for (const file of readdirSync(REPORT_TEMPLATES_DIR)
    .filter((name) => name.endsWith('.json'))
    .sort()) {
    const raw = JSON.parse(readFileSync(join(REPORT_TEMPLATES_DIR, file), 'utf8')) as {
      name: string;
      description?: string;
      definition: unknown;
    };
    const parsed = templateDefinitionSchema.parse(raw.definition);
    const check = validateDefinition(parsed);
    if (!check.ok) throw new Error(`${file}: ${check.errors.join('; ')}`);
    const layout = {
      printLayout: 'blocks',
      definition: parsed,
      showMeasurements: false,
      showSignature: false,
    };
    await tx.reportTemplate.upsert({
      where: { name: raw.name },
      update: {
        description: raw.description ?? null,
        fields: check.fields as unknown as Prisma.InputJsonValue,
        layout: layout as unknown as Prisma.InputJsonValue,
        isActive: true,
      },
      create: {
        name: raw.name,
        description: raw.description ?? null,
        fields: check.fields as unknown as Prisma.InputJsonValue,
        layout: layout as unknown as Prisma.InputJsonValue,
        isActive: true,
        isDefault: false,
      },
    });
  }
}
