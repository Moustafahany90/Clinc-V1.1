import PDFDocument from 'pdfkit';
import type { ReportTemplateField, ReportTemplateLayout } from './reportTypes.js';

export interface ReportPdfInput {
  clinic: {
    name: string;
    phone: string | null;
    email: string | null;
    address: string | null;
    timezone: string;
  };
  report: {
    id: string;
    status: string;
    versionNumber: number;
    finalizedAt: Date | null;
    lastAmendedAt: Date | null;
    content: Record<string, unknown>;
    templateName: string | null;
    templateVersion: string | null;
    templateFields: ReportTemplateField[] | null;
    templateLayout: ReportTemplateLayout | null;
  };
  patient: {
    patientNumber: string;
    firstName: string;
    lastName: string;
    dateOfBirth: Date | null;
    gender: string | null;
  };
  examination: {
    visitDate: Date;
    doctor: string;
    examinationType: string | null;
    chiefComplaint: string | null;
  };
  measurements: Array<{
    label: string;
    value: string;
    unit: string | null;
    measuredAt: Date;
  }>;
}

const MARGIN = 46;
const FOOTER_HEIGHT = 54;
const COLORS = {
  ink: '#111827',
  muted: '#4b5563',
  rule: '#d1d5db',
  accent: '#0f766e',
};

function formatDate(value: Date | null, timezone: string): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(value);
}

function formatDateTime(value: Date | null, timezone: string): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(value);
}

function ageFromDob(dob: Date | null, timezone: string): string {
  if (!dob) return '—';
  const now = new Date();
  const tz = timezone;
  const dobParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(dob);
  const nowParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (parts: Intl.DateTimeFormatPart[], type: string) =>
    Number(parts.find((item) => item.type === type)?.value ?? 0);
  const dobYear = part(dobParts, 'year');
  const dobMonth = part(dobParts, 'month');
  const dobDay = part(dobParts, 'day');
  const nowYear = part(nowParts, 'year');
  const nowMonth = part(nowParts, 'month');
  const nowDay = part(nowParts, 'day');
  let age = nowYear - dobYear;
  if (nowMonth < dobMonth || (nowMonth === dobMonth && nowDay < dobDay)) age -= 1;
  return age >= 0 ? `${age} years` : '—';
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '';
  if (Array.isArray(value)) {
    return value.map((item) => displayValue(item)).filter(Boolean).join(', ');
  }
  if (typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}

function fallbackFields(): ReportTemplateField[] {
  return [
    { key: 'indication', label: 'Indication', type: 'textarea' },
    { key: 'findings', label: 'Findings', type: 'textarea' },
    { key: 'impression', label: 'Impression / conclusion', type: 'textarea' },
    { key: 'recommendations', label: 'Recommendations', type: 'textarea' },
  ];
}

function ensureSpace(doc: PDFKit.PDFDocument, height: number): void {
  const bottom = doc.page.height - FOOTER_HEIGHT;
  if (doc.y + height > bottom) doc.addPage();
}

function section(doc: PDFKit.PDFDocument, title: string, value: string): void {
  if (!value.trim()) return;
  doc.font('Helvetica-Bold').fontSize(9).fillColor(COLORS.muted);
  ensureSpace(doc, 28);
  doc.text(title.toUpperCase(), MARGIN, doc.y, {
    width: doc.page.width - MARGIN * 2,
    characterSpacing: 0.4,
  });
  doc.moveDown(0.25);
  doc.font('Helvetica').fontSize(10).fillColor(COLORS.ink);
  const height = doc.heightOfString(value, {
    width: doc.page.width - MARGIN * 2,
    lineGap: 1.5,
  });
  ensureSpace(doc, height + 16);
  doc.text(value, MARGIN, doc.y, {
    width: doc.page.width - MARGIN * 2,
    lineGap: 1.5,
  });
  doc.moveDown(0.8);
}

function rule(doc: PDFKit.PDFDocument): void {
  doc
    .moveTo(MARGIN, doc.y)
    .lineTo(doc.page.width - MARGIN, doc.y)
    .lineWidth(0.6)
    .strokeColor(COLORS.rule)
    .stroke();
  doc.moveDown(0.8);
}

function twoColumn(doc: PDFKit.PDFDocument, pairs: Array<[string, string]>): void {
  const width = doc.page.width - MARGIN * 2;
  const column = width / 2;
  const startY = doc.y;
  let leftY = startY;
  let rightY = startY;
  pairs.forEach(([label, value], index) => {
    const x = index % 2 === 0 ? MARGIN : MARGIN + column;
    const y = index % 2 === 0 ? leftY : rightY;
    doc.font('Helvetica-Bold').fontSize(8).fillColor(COLORS.muted);
    doc.text(label.toUpperCase(), x, y, { width: column - 10 });
    doc.font('Helvetica').fontSize(10).fillColor(COLORS.ink);
    doc.text(value || '—', x, y + 11, { width: column - 10 });
    const next = y + 34;
    if (index % 2 === 0) leftY = next;
    else rightY = next;
  });
  doc.y = Math.max(leftY, rightY);
}

export async function renderReportPdf(input: ReportPdfInput): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: MARGIN, right: MARGIN, bottom: FOOTER_HEIGHT, left: MARGIN },
    bufferPages: true,
    info: {
      Title: 'Ultrasound report',
      Author: input.clinic.name,
      Subject: 'Finalized ultrasound report',
      Creator: 'Ultrasound Clinic Management System',
    },
  });

  const chunks: Buffer[] = [];
  const finished = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const timezone = input.clinic.timezone;
  const contentWidth = doc.page.width - MARGIN * 2;

  doc.font('Helvetica-Bold').fontSize(19).fillColor(COLORS.accent);
  doc.text(input.clinic.name, MARGIN, MARGIN, { width: contentWidth });
  doc.font('Helvetica').fontSize(8.5).fillColor(COLORS.muted);
  const contact = [input.clinic.address, input.clinic.phone, input.clinic.email]
    .filter(Boolean)
    .join('  •  ');
  if (contact) doc.text(contact, MARGIN, doc.y + 3, { width: contentWidth });
  doc.moveDown(0.7);
  rule(doc);

  doc.font('Helvetica-Bold').fontSize(15).fillColor(COLORS.ink);
  doc.text('Ultrasound Report', MARGIN, doc.y, { width: contentWidth });
  const statusText =
    input.report.status === 'AMENDED'
      ? `Amended ${formatDateTime(input.report.lastAmendedAt, timezone)}`
      : `Finalized ${formatDateTime(input.report.finalizedAt, timezone)}`;
  const templateText = input.report.templateName
    ? `  •  ${input.report.templateName}${
        input.report.templateVersion ? ` (${input.report.templateVersion})` : ''
      }`
    : '';
  doc.font('Helvetica').fontSize(9).fillColor(COLORS.muted);
  doc.text(
    `${statusText}  •  Version ${input.report.versionNumber}${templateText}  •  ${input.report.id}`,
    MARGIN,
    doc.y + 2,
    { width: contentWidth },
  );
  doc.moveDown(0.9);

  doc.font('Helvetica-Bold').fontSize(10).fillColor(COLORS.accent);
  doc.text('Patient', MARGIN, doc.y);
  doc.moveDown(0.35);
  twoColumn(doc, [
    ['Patient name', `${input.patient.firstName} ${input.patient.lastName}`],
    ['Patient number', input.patient.patientNumber],
    ['Date of birth', formatDate(input.patient.dateOfBirth, timezone)],
    ['Age', ageFromDob(input.patient.dateOfBirth, timezone)],
    ['Gender', input.patient.gender ?? '—'],
    ['Examination date', formatDateTime(input.examination.visitDate, timezone)],
    ['Responsible doctor', input.examination.doctor],
    ['Examination type', input.examination.examinationType ?? '—'],
  ]);
  doc.moveDown(0.2);
  rule(doc);

  if (input.report.templateLayout?.headerNote) {
    section(doc, 'Note', input.report.templateLayout.headerNote);
  }

  if (input.examination.chiefComplaint) {
    section(doc, 'Clinical indication', input.examination.chiefComplaint);
  }

  const fields =
    input.report.templateFields && input.report.templateFields.length > 0
      ? input.report.templateFields
      : fallbackFields();
  for (const field of fields) {
    if (field.visible === false) continue;
    section(doc, field.label, displayValue(input.report.content[field.key]));
  }

  const showMeasurements = input.report.templateLayout?.showMeasurements !== false;
  if (showMeasurements && input.measurements.length > 0) {
    doc.font('Helvetica-Bold').fontSize(9).fillColor(COLORS.muted);
    ensureSpace(doc, 32);
    doc.text('MEASUREMENTS', MARGIN, doc.y, { width: contentWidth });
    doc.moveDown(0.4);
    for (const measurement of input.measurements) {
      ensureSpace(doc, 18);
      const value = measurement.unit
        ? `${measurement.value} ${measurement.unit}`
        : measurement.value;
      doc.font('Helvetica-Bold').fontSize(9).fillColor(COLORS.ink);
      doc.text(`${measurement.label}: `, MARGIN, doc.y, { continued: true, width: contentWidth });
      doc.font('Helvetica').fillColor(COLORS.ink).text(value);
      doc.font('Helvetica').fontSize(8).fillColor(COLORS.muted);
      doc.text(formatDateTime(measurement.measuredAt, timezone), MARGIN, doc.y + 1, {
        width: contentWidth,
      });
      doc.moveDown(0.3);
    }
    doc.moveDown(0.4);
  }

  if (input.report.templateLayout?.showSignature !== false) {
    ensureSpace(doc, 100);
    doc.moveDown(1.2);
    rule(doc);
    const signatureY = doc.y;
    doc.font('Helvetica-Bold').fontSize(9).fillColor(COLORS.ink);
    doc.text('Responsible doctor', MARGIN, signatureY, { width: contentWidth / 2 });
    doc.font('Helvetica').fontSize(9).fillColor(COLORS.muted);
    doc.text(input.examination.doctor, MARGIN, signatureY + 12, {
      width: contentWidth / 2,
    });
    doc.font('Helvetica-Bold').fontSize(9).fillColor(COLORS.ink);
    doc.text('Signature / date', MARGIN + contentWidth / 2, signatureY, {
      width: contentWidth / 2,
    });
    doc.font('Helvetica').fontSize(9).fillColor(COLORS.muted);
    doc.text(
      formatDate(input.report.finalizedAt, timezone),
      MARGIN + contentWidth / 2,
      signatureY + 12,
      {
        width: contentWidth / 2,
      },
    );
    doc.y = signatureY + 30;
    doc.moveDown(1);
  }

  if (input.report.templateLayout?.footerNote) {
    section(doc, 'Clinic note', input.report.templateLayout.footerNote);
  }

  const range = doc.bufferedPageRange();
  const footerClinic =
    input.clinic.name.length > 60 ? `${input.clinic.name.slice(0, 57)}...` : input.clinic.name;
  for (let index = range.start; index < range.start + range.count; index += 1) {
    doc.switchToPage(index);
    // The footer deliberately sits below the normal content margin. Narrow the
    // bottom margin for this draw so PDFKit does not treat it as an overflow
    // and append a blank page.
    const originalBottomMargin = doc.page.margins.bottom;
    doc.page.margins.bottom = 20;
    doc.font('Helvetica').fontSize(7.5).fillColor(COLORS.muted);
    doc.text(
      `${footerClinic}  •  Report ${input.report.id}  •  Page ${index + 1} of ${range.count}`,
      MARGIN,
      doc.page.height - 30,
      { width: contentWidth, align: 'center', lineBreak: false },
    );
    doc.page.margins.bottom = originalBottomMargin;
  }

  doc.end();
  return finished;
}
