import { useEffect } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Printer } from 'lucide-react';
import { api } from '../lib/api';
import { useAsyncData } from '../lib/hooks';
import { ageFromDob, formatDateOnly, formatDateTime, formatTime } from '../lib/format';
import type {
  Measurement,
  ReportTemplateField,
  ReportTemplateLayout,
} from '../lib/types';
import { Alert, Button, LoadingBlock } from '../components/ui';

interface PrintData {
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
    finalizedAt: string | null;
    lastAmendedAt: string | null;
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
    dateOfBirth: string | null;
    gender: string | null;
  };
  examination: {
    visitDate: string;
    doctor: string;
    examinationType: string | null;
    chiefComplaint: string | null;
    measurements: Measurement[];
  };
}

const FALLBACK_FIELDS: ReportTemplateField[] = [
  { key: 'indication', label: 'Indication', type: 'textarea' },
  { key: 'findings', label: 'Findings', type: 'textarea' },
  { key: 'measurements', label: 'Measurements', type: 'textarea' },
  { key: 'impression', label: 'Impression', type: 'textarea' },
  { key: 'recommendations', label: 'Recommendations', type: 'textarea' },
];

function display(value: unknown): string {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(String).join('\n');
  return String(value);
}

export function ReportPrintPage() {
  const { id = '' } = useParams();
  const state = useAsyncData<PrintData>(
    async () => (await api.get<PrintData>(`/reports/${id}/print-data`)).data,
    [id],
  );

  const data = state.data;

  useEffect(() => {
    if (!data) return;
    const previous = document.title;
    document.title = `Report · ${data.patient.firstName} ${data.patient.lastName}`;
    return () => {
      document.title = previous;
    };
  }, [data]);

  if (state.loading && !data) return <LoadingBlock label="Preparing the report…" />;

  if (state.error) {
    return (
      <div className="mx-auto max-w-2xl space-y-4 p-6">
        <Alert tone="danger">{state.error}</Alert>
        <Button variant="secondary" asChild>
          <Link to="/reports">
            <ArrowLeft className="h-4 w-4" aria-hidden />
            Back to reports
          </Link>
        </Button>
      </div>
    );
  }

  if (!data) return null;

  const { clinic, report, patient, examination } = data;
  const templateFields =
    report.templateFields && report.templateFields.length > 0
      ? report.templateFields
      : FALLBACK_FIELDS;
  const fields = templateFields.filter((field) => field.visible !== false);
  const layout = report.templateLayout ?? {};
  const showMeasurements = layout.showMeasurements !== false;
  const showSignature = layout.showSignature !== false;
  const pinnedOn = report.templateVersion ? new Date(report.templateVersion) : null;
  const templateDate = pinnedOn && !Number.isNaN(pinnedOn.getTime()) ? pinnedOn : null;

  return (
    <div className="min-h-dvh bg-ink-100/60 py-6 print:bg-white print:py-0">
      <div className="no-print mx-auto mb-4 flex w-[min(210mm,calc(100%-1.5rem))] flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" asChild>
            <Link to={`/reports/${report.id}`}>
              <ArrowLeft className="h-4 w-4" aria-hidden />
              Back to report
            </Link>
          </Button>
          <span className="text-[12px] text-ink-500">
            Version {report.versionNumber}
            {report.finalizedAt
              ? ` · finalized ${formatDateTime(report.finalizedAt, clinic.timezone)}`
              : ' · draft'}
            {report.templateName ? ` · ${report.templateName}` : ''}
          </span>
        </div>
        <Button onClick={() => window.print()}>
          <Printer className="h-4 w-4" aria-hidden />
          Print / Save as PDF
        </Button>
      </div>

      <article className="print-page mx-auto flex min-h-[297mm] w-[min(210mm,calc(100%-1.5rem))] flex-col bg-white px-[15mm] py-[16mm] text-ink-900 shadow-card">
        <header className="print-avoid-break flex flex-wrap items-start justify-between gap-4 border-b-2 border-ink-900 pb-4">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">{clinic.name}</h1>
            <p className="mt-1 text-[11px] leading-relaxed text-ink-600">
              {[clinic.address, clinic.phone, clinic.email].filter(Boolean).join(' · ')}
            </p>
            {layout.headerNote && (
              <p className="mt-2 max-w-md whitespace-pre-wrap text-[10.5px] leading-relaxed text-ink-600">
                {layout.headerNote}
              </p>
            )}
          </div>
          <div className="text-right">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-ink-500">
              Ultrasound report
            </p>
            <p className="mt-1 text-[11px] text-ink-600">
              {formatDateOnly(examination.visitDate.slice(0, 10))} ·{' '}
              {formatTime(examination.visitDate, clinic.timezone)}
            </p>
            <p className="text-[11px] text-ink-600">
              Version {report.versionNumber} ·{' '}
              {report.status === 'DRAFT' ? 'Draft' : 'Final'}
            </p>
            {report.templateName && (
              <p className="mt-0.5 text-[9.5px] text-ink-500">
                {report.templateName}
                {templateDate
                  ? ` · pinned ${formatDateOnly(
                      templateDate.toISOString().slice(0, 10),
                    )}`
                  : ''}
              </p>
            )}
          </div>
        </header>

        <section className="print-avoid-break mt-5 grid grid-cols-2 gap-x-8 gap-y-2 border-b border-line pb-4 text-[11.5px]">
          <div>
            <p className="text-[9px] font-semibold uppercase tracking-[0.12em] text-ink-500">
              Patient
            </p>
            <p className="mt-0.5 text-[13px] font-semibold">
              {patient.firstName} {patient.lastName}
            </p>
            <p className="text-ink-600">
              {patient.patientNumber}
              {patient.dateOfBirth
                ? ` · ${formatDateOnly(patient.dateOfBirth)} (${ageFromDob(patient.dateOfBirth)})`
                : ''}
              {patient.gender ? ` · ${patient.gender.toLowerCase()}` : ''}
            </p>
          </div>
          <div>
            <p className="text-[9px] font-semibold uppercase tracking-[0.12em] text-ink-500">
              Examination
            </p>
            <p className="mt-0.5 text-[13px] font-semibold">
              {examination.examinationType || 'Ultrasound examination'}
            </p>
            <p className="text-ink-600">Reporting doctor: Dr {examination.doctor}</p>
          </div>
          {examination.chiefComplaint && (
            <div className="col-span-2">
              <p className="text-[9px] font-semibold uppercase tracking-[0.12em] text-ink-500">
                Clinical indication
              </p>
              <p className="mt-0.5 whitespace-pre-wrap text-ink-800">
                {examination.chiefComplaint}
              </p>
            </div>
          )}
        </section>

        <section className="mt-5 space-y-5">
          {fields.map((field) => {
            const value = display(report.content[field.key]);
            if (!value.trim()) return null;
            return (
              <div key={field.key} className="print-avoid-break">
                <h2 className="border-b border-line pb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-600">
                  {field.label}
                </h2>
                <p className="mt-2 whitespace-pre-wrap text-[12pt] leading-relaxed text-ink-900">
                  {value}
                </p>
              </div>
            );
          })}
        </section>

        {showMeasurements && examination.measurements.length > 0 && (
          <section className="print-avoid-break mt-6">
            <h2 className="border-b border-line pb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-600">
              Measurements
            </h2>
            <table className="mt-2 w-full border-collapse text-[11px]">
              <thead>
                <tr className="text-left text-[9px] uppercase tracking-[0.1em] text-ink-500">
                  <th className="py-1">Measurement</th>
                  <th className="py-1 text-right">Value</th>
                  <th className="py-1 text-right">Recorded</th>
                </tr>
              </thead>
              <tbody>
                {examination.measurements.map((measurement) => (
                  <tr key={measurement.id} className="border-t border-line">
                    <td className="py-1">{measurement.label}</td>
                    <td className="tabular py-1 text-right font-medium">
                      {measurement.value}
                      {measurement.unit ? ` ${measurement.unit}` : ''}
                    </td>
                    <td className="py-1 text-right text-ink-500">
                      {formatDateTime(measurement.measuredAt, clinic.timezone)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        <footer className="print-avoid-break mt-auto border-t border-line pt-4">
          {layout.footerNote && (
            <p className="mb-4 max-w-xl whitespace-pre-wrap text-[10px] leading-relaxed text-ink-600">
              {layout.footerNote}
            </p>
          )}
          <div className="flex flex-wrap items-end justify-between gap-8">
            <div className="text-[10px] leading-relaxed text-ink-500">
              <p>
                {report.finalizedAt
                  ? `Finalized ${formatDateTime(report.finalizedAt, clinic.timezone)}`
                  : 'Draft — not a finalized clinical document'}
                {report.lastAmendedAt
                  ? ` · Last amended ${formatDateTime(report.lastAmendedAt, clinic.timezone)}`
                  : ''}
              </p>
              <p className="mt-0.5">
                Report reference {report.id.slice(0, 8)} · {clinic.timezone} · {clinic.name}
              </p>
            </div>
            {showSignature && (
              <div className="w-56 text-center">
                <div className="h-10 border-b border-ink-400" />
                <p className="mt-1 text-[10px] text-ink-600">Dr {examination.doctor}</p>
                <p className="text-[9px] text-ink-400">Signature</p>
              </div>
            )}
          </div>
        </footer>
      </article>
    </div>
  );
}
