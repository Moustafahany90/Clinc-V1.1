import type { ReportPdfInput } from '../reportPdf.js';
import { renderHtmlToPdf } from '../htmlPdf.js';
import { renderReportHtml } from './blocks.render.js';

/** Preformatted system values used by infoTable rows bound to patient/visit data. */
export function systemValues(input: ReportPdfInput) {
  const fmt = (d: Date | null) =>
    d
      ? new Intl.DateTimeFormat('en-GB', {
          timeZone: input.clinic.timezone,
          day: '2-digit',
          month: '2-digit',
          year: 'numeric',
        }).format(d)
      : '';
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
    definition,
    content: input.report.content,
    system: systemValues(input),
    mode: 'print',
    isDraft: input.report.status === 'DRAFT',
  });
  return renderHtmlToPdf(html, 'Letter');
}
