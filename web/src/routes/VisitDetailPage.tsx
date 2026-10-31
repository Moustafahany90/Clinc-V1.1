import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  CheckCircle2,
  Download,
  FilePlus2,
  FileText,
  Paperclip,
  Plus,
  Save,
  Stethoscope,
  Trash2,
  Upload,
} from 'lucide-react';
import { api, downloadFile, errorMessage, toApiFailure } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useClinic } from '../lib/clinic';
import { useAsyncData } from '../lib/hooks';
import { ageFromDob, dateOnlyInZone, formatDateOnly, formatDateTime, formatTime } from '../lib/format';
import type {
  FileAsset,
  Measurement,
  Report,
  ReportTemplate,
  Visit,
} from '../lib/types';
import { ConfirmDialog, ReasonDialog } from '../components/dialogs';
import { useToast } from '../components/toast';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  EmptyState,
  Field,
  Input,
  KeyValue,
  LoadingBlock,
  PageHeader,
  Select,
  StatusBadge,
  Textarea,
} from '../components/ui';

const DEFAULT_REPORT_FIELDS = [
  { key: 'indication', label: 'Indication', type: 'textarea' as const },
  { key: 'findings', label: 'Findings', type: 'textarea' as const },
  { key: 'measurements', label: 'Measurements', type: 'textarea' as const },
  { key: 'impression', label: 'Impression', type: 'textarea' as const },
  { key: 'recommendations', label: 'Recommendations', type: 'textarea' as const },
];

export function VisitDetailPage() {
  const { id = '' } = useParams();
  const { hasPermission } = useAuth();
  const { timezone } = useClinic();
  const navigate = useNavigate();
  const toast = useToast();
  const fileInput = useRef<HTMLInputElement | null>(null);

  const [chiefComplaint, setChiefComplaint] = useState('');
  const [examinationType, setExaminationType] = useState('');
  const [savingDetails, setSavingDetails] = useState(false);
  const [measurementOpen, setMeasurementOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [completeOpen, setCompleteOpen] = useState(false);
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [deleteMeasurement, setDeleteMeasurement] = useState<Measurement | null>(null);
  const [deleteFile, setDeleteFile] = useState<FileAsset | null>(null);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);

  const state = useAsyncData<{ visit: Visit }>(
    async () => {
      const res = await api.get<{ visit: Visit }>(`/visits/${id}`);
      return res.data;
    },
    [id],
  );

  const visit = state.data?.visit ?? null;
  const canWrite = hasPermission('CLINICAL_WRITE');
  const canOverrideCompletion = hasPermission('VISITS_OVERRIDE');
  const readonly = !visit || visit.status === 'COMPLETED' || !canWrite;
  const reports = visit?.reports ?? [];
  const hasFinal = reports.some((report) => report.status !== 'DRAFT');
  const hasDraft = reports.some((report) => report.status === 'DRAFT');

  useEffect(() => {
    if (!visit) return;
    setChiefComplaint(visit.chiefComplaint ?? '');
    setExaminationType(visit.examinationType ?? '');
  }, [visit?.id, visit?.chiefComplaint, visit?.examinationType]);

  async function saveDetails(event: FormEvent) {
    event.preventDefault();
    if (!visit) return;
    setSavingDetails(true);
    try {
      await api.patch(`/visits/${visit.id}`, {
        chiefComplaint: chiefComplaint.trim() || null,
        examinationType: examinationType.trim() || null,
      });
      toast.success('Visit details saved');
      state.reload();
    } catch (err) {
      toast.error('Could not save the visit', errorMessage(err));
    } finally {
      setSavingDetails(false);
    }
  }

  async function uploadFile(file: File | null) {
    if (!file || !visit) return;
    const form = new FormData();
    form.append('file', file);
    form.append('visitId', visit.id);
    setUploading(true);
    try {
      await api.post('/files', form);
      toast.success('File attached', file.name);
      state.reload();
    } catch (err) {
      toast.error('Upload rejected', errorMessage(err));
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  async function removeMeasurement() {
    if (!visit || !deleteMeasurement) return;
    setBusy(true);
    try {
      await api.delete(`/visits/${visit.id}/measurements/${deleteMeasurement.id}`);
      toast.success('Measurement removed');
      setDeleteMeasurement(null);
      state.reload();
    } catch (err) {
      toast.error('Could not remove the measurement', errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function removeFile() {
    if (!deleteFile) return;
    setBusy(true);
    try {
      await api.delete(`/files/${deleteFile.id}`);
      toast.success('File deleted');
      setDeleteFile(null);
      state.reload();
    } catch (err) {
      toast.error('Could not delete the file', errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function completeVisit(reason?: string) {
    if (!visit) return;
    setBusy(true);
    try {
      await api.patch(`/visits/${visit.id}`, {
        status: 'COMPLETED',
        ...(reason ? { overrideReason: reason } : {}),
      });
      toast.success('Visit completed');
      setCompleteOpen(false);
      setOverrideOpen(false);
      state.reload();
    } catch (err) {
      const failure = toApiFailure(err);
      const details = failure.details as { requiresOverride?: boolean } | undefined;
      setCompleteOpen(false);
      if (details?.requiresOverride) {
        setOverrideOpen(true);
      } else {
        toast.error('Could not complete the visit', failure.message);
      }
    } finally {
      setBusy(false);
    }
  }

  if (state.loading && !visit) return <LoadingBlock label="Loading the clinical record…" />;
  if (state.error) {
    return (
      <div className="space-y-4">
        <Alert tone="danger">{state.error}</Alert>
        <Button variant="secondary" asChild>
          <Link to="/visits">
            <ArrowLeft className="h-4 w-4" aria-hidden />
            Back to visits
          </Link>
        </Button>
      </div>
    );
  }
  if (!visit) return null;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Clinical record"
        title={`Visit · ${visit.patient ? `${visit.patient.firstName} ${visit.patient.lastName}` : 'Patient'}`}
        description={`${formatDateOnly(dateOnlyInZone(visit.visitDate, timezone))} at ${formatTime(
          visit.visitDate,
          timezone,
        )} · ${visit.doctor ? `Dr ${visit.doctor.firstName} ${visit.doctor.lastName}` : 'Doctor'}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" asChild>
              <Link to="/visits">
                <ArrowLeft className="h-4 w-4" aria-hidden />
                Visits
              </Link>
            </Button>
            {!readonly && visit.status !== 'COMPLETED' && (
              <Button
                variant="secondary"
                onClick={() => {
                  if (hasFinal) {
                    setCompleteOpen(true);
                    return;
                  }
                  if (canOverrideCompletion) {
                    setOverrideOpen(true);
                    return;
                  }
                  toast.error(
                    'Finalize a report first',
                    'Only an administrator can complete a visit without a finalized report.',
                  );
                }}
              >
                <CheckCircle2 className="h-4 w-4" aria-hidden />
                Complete visit
              </Button>
            )}
          </div>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={visit.status} />
        {visit.patient && (
          <Badge tone="muted">{visit.patient.patientNumber}</Badge>
        )}
        {visit.patient?.dateOfBirth && (
          <Badge tone="muted">{ageFromDob(visit.patient.dateOfBirth)}</Badge>
        )}
        {visit.appointment && (
          <Badge tone="info">Appointment {formatTime(visit.appointment.startAt, timezone)}</Badge>
        )}
        {!hasFinal && <Badge tone="warning">No finalized report</Badge>}
      </div>

      {!hasFinal && !readonly && (
        <Alert tone="warning" title="Report required before completion">
          Finalize a report to complete this visit normally. An administrator or clinician may
          override with a recorded reason when clinically justified.
        </Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-6">
          <Card>
            <CardHeader title="Visit details" icon={Stethoscope} />
            <form onSubmit={saveDetails} className="space-y-4 px-5 py-4">
              <Field label="Examination type" htmlFor="visit-exam">
                <Input
                  id="visit-exam"
                  value={examinationType}
                  onChange={(event) => setExaminationType(event.target.value)}
                  disabled={readonly}
                  maxLength={200}
                  placeholder="Abdominal ultrasound"
                />
              </Field>
              <Field label="Chief complaint / indication" htmlFor="visit-complaint">
                <Textarea
                  id="visit-complaint"
                  value={chiefComplaint}
                  onChange={(event) => setChiefComplaint(event.target.value)}
                  disabled={readonly}
                  maxLength={2000}
                  placeholder="Clinical indication for this examination"
                />
              </Field>
              {!readonly && (
                <div className="flex justify-end">
                  <Button type="submit" variant="secondary" loading={savingDetails}>
                    <Save className="h-4 w-4" aria-hidden />
                    Save details
                  </Button>
                </div>
              )}
            </form>
          </Card>

          <Card>
            <CardHeader
              title="Measurements"
              description="Structured ultrasound measurements recorded during the visit."
              icon={Stethoscope}
              action={
                !readonly && (
                  <Button size="sm" variant="secondary" onClick={() => setMeasurementOpen(true)}>
                    <Plus className="h-3.5 w-3.5" aria-hidden />
                    Add
                  </Button>
                )
              }
            />
            {visit.measurements && visit.measurements.length > 0 ? (
              <div className="divide-y divide-line">
                {visit.measurements.map((measurement) => (
                  <div
                    key={measurement.id}
                    className="flex flex-wrap items-center justify-between gap-2 px-5 py-3"
                  >
                    <div className="min-w-0">
                      <p className="text-[13px] font-medium text-ink-800">{measurement.label}</p>
                      <p className="tabular mt-0.5 text-sm text-ink-950">
                        {measurement.value}
                        {measurement.unit ? ` ${measurement.unit}` : ''}
                      </p>
                      <p className="mt-0.5 text-[11px] text-ink-400">
                        {formatDateTime(measurement.measuredAt, timezone)}
                      </p>
                    </div>
                    {!readonly && (
                      <Button
                        size="iconSm"
                        variant="ghost"
                        onClick={() => setDeleteMeasurement(measurement)}
                        aria-label="Delete measurement"
                      >
                        <Trash2 className="h-4 w-4 text-ink-400" aria-hidden />
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="px-5 py-6 text-center text-[13px] text-ink-500">
                No measurements recorded.
              </div>
            )}
          </Card>

          <Card>
            <CardHeader
              title="Reports"
              description="One report per visit. Finalized reports are immutable and amended in versions."
              icon={FileText}
              action={
                !readonly && reports.length === 0 && (
                  <Button size="sm" onClick={() => setReportOpen(true)}>
                    <FilePlus2 className="h-3.5 w-3.5" aria-hidden />
                    Draft report
                  </Button>
                )
              }
            />
            {reports.length === 0 ? (
              <EmptyState
                icon={FileText}
                title="No report yet"
                description="Create a draft report, complete the findings, then finalize it."
                action={
                  !readonly ? (
                    <Button variant="secondary" onClick={() => setReportOpen(true)}>
                      Create report
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <div className="divide-y divide-line">
                {reports.map((report) => (
                  <div
                    key={report.id}
                    className="flex flex-wrap items-center justify-between gap-3 px-5 py-3"
                  >
                    <div>
                      <div className="flex items-center gap-2">
                        <StatusBadge status={report.status} />
                        <span className="text-[12px] text-ink-500">Version {report.versionNumber}</span>
                      </div>
                      <p className="mt-1 text-[11px] text-ink-400">
                        Updated {formatDateTime(report.updatedAt, timezone)}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" variant="secondary" asChild>
                        <Link to={`/reports/${report.id}`}>Open report</Link>
                      </Button>
                      <Button size="sm" variant="ghost" asChild>
                        <Link to={`/reports/${report.id}/print`} target="_blank">
                          Print
                        </Link>
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader title="Patient" icon={Stethoscope} />
            <div className="space-y-3 px-5 py-4">
              <KeyValue label="Name">
                {visit.patient ? (
                  <Link
                    to={`/patients/${visit.patient.id}`}
                    className="text-brand-700 hover:underline"
                  >
                    {visit.patient.firstName} {visit.patient.lastName}
                  </Link>
                ) : (
                  '—'
                )}
              </KeyValue>
              <div className="grid grid-cols-2 gap-3">
                <KeyValue label="Patient number">{visit.patient?.patientNumber ?? '—'}</KeyValue>
                <KeyValue label="Date of birth">
                  {formatDateOnly(visit.patient?.dateOfBirth ?? null)}
                </KeyValue>
              </div>
              <KeyValue label="Doctor">
                {visit.doctor ? `Dr ${visit.doctor.firstName} ${visit.doctor.lastName}` : '—'}
              </KeyValue>
              <KeyValue label="Created">{formatDateTime(visit.createdAt, timezone)}</KeyValue>
            </div>
          </Card>

          <Card>
            <CardHeader
              title="Attachments"
              description="Images and PDFs are stored privately and only served through authorised endpoints."
              icon={Paperclip}
              action={
                !readonly && (
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={uploading}
                    onClick={() => fileInput.current?.click()}
                  >
                    <Upload className="h-3.5 w-3.5" aria-hidden />
                    Upload
                  </Button>
                )
              }
            />
            <input
              ref={fileInput}
              type="file"
              className="hidden"
              accept="image/jpeg,image/png,image/webp,image/tiff,application/pdf"
              onChange={(event) => void uploadFile(event.target.files?.[0] ?? null)}
            />
            {visit.files && visit.files.length > 0 ? (
              <div className="divide-y divide-line">
                {visit.files.map((file) => (
                  <div
                    key={file.id}
                    className="flex items-center justify-between gap-2 px-5 py-2.5"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-[12px] font-medium text-ink-800">
                        {file.originalName}
                      </p>
                      <p className="text-[10px] text-ink-400">
                        {(file.sizeBytes / 1024).toFixed(0)} KB ·{' '}
                        {formatDateOnly(dateOnlyInZone(file.createdAt, timezone))}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-0.5">
                      <Button
                        size="iconSm"
                        variant="ghost"
                        aria-label="Download file"
                        onClick={() => void downloadFile(file.id, file.originalName)}
                      >
                        <Download className="h-3.5 w-3.5" aria-hidden />
                      </Button>
                      {!readonly && (
                        <Button
                          size="iconSm"
                          variant="ghost"
                          aria-label="Delete file"
                          onClick={() => setDeleteFile(file)}
                        >
                          <Trash2 className="h-3.5 w-3.5 text-ink-400" aria-hidden />
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="px-5 py-6 text-center text-[12px] text-ink-500">No files attached.</p>
            )}
          </Card>
        </div>
      </div>

      <MeasurementDialog
        open={measurementOpen}
        onOpenChange={setMeasurementOpen}
        visitId={visit.id}
        onSaved={() => state.reload()}
      />

      <CreateReportDialog
        open={reportOpen}
        onOpenChange={setReportOpen}
        visitId={visit.id}
        serviceId={visit.appointment ? undefined : undefined}
        onCreated={(report) => navigate(`/reports/${report.id}`)}
      />

      <ConfirmDialog
        open={completeOpen}
        onOpenChange={setCompleteOpen}
        title="Complete this visit?"
        description="The visit and its report become read-only. Corrections are made through report amendments."
        confirmLabel="Complete visit"
        tone="primary"
        busy={busy}
        onConfirm={() => void completeVisit()}
      />

      <ReasonDialog
        open={overrideOpen}
        onOpenChange={setOverrideOpen}
        title="Complete without a finalized report"
        description={
          hasDraft
            ? 'A draft report exists. Finalize it first, or record why this visit is being closed without one.'
            : 'No report has been created. Explain why the visit is being completed without one.'
        }
        label="Override reason"
        confirmLabel="Complete anyway"
        tone="warning"
        busy={busy}
        onConfirm={(reason) => void completeVisit(reason)}
      />

      <ConfirmDialog
        open={deleteMeasurement !== null}
        onOpenChange={(next) => !next && setDeleteMeasurement(null)}
        title="Remove measurement?"
        description={
          deleteMeasurement
            ? `${deleteMeasurement.label}: ${deleteMeasurement.value} ${
                deleteMeasurement.unit ?? ''
              }`
            : undefined
        }
        confirmLabel="Remove"
        busy={busy}
        onConfirm={() => void removeMeasurement()}
      />

      <ConfirmDialog
        open={deleteFile !== null}
        onOpenChange={(next) => !next && setDeleteFile(null)}
        title="Delete attachment?"
        description={deleteFile?.originalName}
        confirmLabel="Delete file"
        busy={busy}
        onConfirm={() => void removeFile()}
      />
    </div>
  );
}

function MeasurementDialog({
  open,
  onOpenChange,
  visitId,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  visitId: string;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [label, setLabel] = useState('');
  const [value, setValue] = useState('');
  const [unit, setUnit] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setLabel('');
    setValue('');
    setUnit('');
    setBusy(false);
    setError(null);
  }, [open]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (!label.trim() || !value.trim()) {
      setError('Both a label and a value are required.');
      return;
    }
    setBusy(true);
    try {
      await api.post(`/visits/${visitId}/measurements`, {
        label: label.trim(),
        value: value.trim(),
        ...(unit.trim() ? { unit: unit.trim() } : {}),
      });
      toast.success('Measurement added');
      onSaved();
      onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent size="sm">
        <DialogHeader title="Add measurement" description="Record a structured finding." />
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <DialogBody className="space-y-4">
            {error && <Alert tone="danger">{error}</Alert>}
            <Field label="Label" required>
              <Input
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder="e.g. Right kidney length"
                maxLength={120}
                autoFocus
                required
              />
            </Field>
            <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-3">
              <Field label="Value" required>
                <Input
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                  placeholder="10.4"
                  maxLength={120}
                  required
                />
              </Field>
              <Field label="Unit">
                <Input
                  value={unit}
                  onChange={(event) => setUnit(event.target.value)}
                  placeholder="cm"
                  maxLength={40}
                />
              </Field>
            </div>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" loading={busy}>
              Add measurement
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CreateReportDialog({
  open,
  onOpenChange,
  visitId,
  serviceId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  visitId: string;
  serviceId?: string | null;
  onCreated: (report: Report) => void;
}) {
  const toast = useToast();
  const [templates, setTemplates] = useState<ReportTemplate[]>([]);
  const [templateId, setTemplateId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTemplateId('');
    setBusy(false);
    setError(null);
    api
      .get<{ templates: ReportTemplate[] }>('/reports/templates')
      .then((res) => {
        const active = res.data.templates.filter((template) => template.isActive);
        setTemplates(active);
        const fallback = active.find((template) => template.isDefault);
        if (fallback) setTemplateId(fallback.id);
      })
      .catch(() => setTemplates([]));
  }, [open]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const template = templates.find((item) => item.id === templateId);
      const fields =
        template && template.fields.length > 0
          ? template.fields
          : DEFAULT_REPORT_FIELDS;
      const content: Record<string, string> = {};
      for (const field of fields) content[field.key] = '';
      const res = await api.post<{ report: Report }>('/reports', {
        visitId,
        templateId: templateId || null,
        serviceId: serviceId ?? null,
        content,
      });
      toast.success('Draft report created');
      onOpenChange(false);
      onCreated(res.data.report);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent size="sm">
        <DialogHeader
          title="Create a report"
          description="Pick a template. Fields can be edited in the report workspace."
          icon={FileText}
        />
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <DialogBody className="space-y-4">
            {error && <Alert tone="danger">{error}</Alert>}
            <Field
              label="Template"
              hint="Choosing no template uses the standard ultrasound field set."
            >
              <Select value={templateId} onChange={(event) => setTemplateId(event.target.value)}>
                <option value="">Standard ultrasound report</option>
                {templates.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.name}
                    {template.isDefault ? ' (default)' : ''}
                  </option>
                ))}
              </Select>
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" loading={busy}>
              Create draft
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
