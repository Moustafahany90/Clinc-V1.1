import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft,
  CheckCircle2,
  Download,
  FilePlus2,
  FileText,
  History,
  MessageCircle,
  Paperclip,
  Printer,
  Save,
  Trash2,
  Upload,
} from 'lucide-react';
import { api, downloadFile, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useClinic } from '../lib/clinic';
import { useAsyncData } from '../lib/hooks';
import { ageFromDob, dateOnlyInZone, formatDateOnly, formatDateTime, formatTime } from '../lib/format';
import type { Report, ReportTemplate, ReportTemplateField, Visit } from '../lib/types';
import { ConfirmDialog, ReasonDialog } from '../components/dialogs';
import { useToast } from '../components/toast';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  Field,
  Input,
  KeyValue,
  LoadingBlock,
  PageHeader,
  Select,
  StatusBadge,
  Textarea,
} from '../components/ui';

const DEFAULT_FIELDS: ReportTemplateField[] = [
  { key: 'indication', label: 'Indication', type: 'textarea' },
  { key: 'findings', label: 'Findings', type: 'textarea' },
  { key: 'measurements', label: 'Measurements', type: 'textarea' },
  { key: 'impression', label: 'Impression', type: 'textarea' },
  { key: 'recommendations', label: 'Recommendations', type: 'textarea' },
];

type ContentState = Record<string, string>;

function contentToState(content: Record<string, unknown> | undefined, fields: ReportTemplateField[]): ContentState {
  const state: ContentState = {};
  for (const field of fields) {
    const value = content?.[field.key];
    state[field.key] = Array.isArray(value)
      ? value.map(String).join('\n')
      : value == null
        ? ''
        : String(value);
  }
  return state;
}

export function ReportEditorPage() {
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const { timezone } = useClinic();
  const toast = useToast();
  const fileInput = useRef<HTMLInputElement | null>(null);

  const [content, setContent] = useState<ContentState>({});
  const [amendMode, setAmendMode] = useState(false);
  const [reasonOpen, setReasonOpen] = useState(false);
  const [finalizeOpen, setFinalizeOpen] = useState(false);
  const [whatsappOpen, setWhatsappOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteFileId, setDeleteFileId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [createVisitId, setCreateVisitId] = useState(searchParams.get('visitId') ?? '');
  const [createTemplateId, setCreateTemplateId] = useState(
    searchParams.get('templateId') ?? '',
  );
  const [creating, setCreating] = useState(false);

  const reportState = useAsyncData<{ report: Report }>(
    async () => (await api.get<{ report: Report }>(`/reports/${id}`)).data,
    [id],
    Boolean(id),
  );

  const templatesState = useAsyncData<{ templates: ReportTemplate[] }>(
    async () => (await api.get<{ templates: ReportTemplate[] }>('/reports/templates')).data,
    [],
    !id,
  );

  const visitsState = useAsyncData<{ visits: Visit[] }>(
    async () =>
      (await api.get<{ visits: Visit[] }>('/visits', { params: { pageSize: 100 } })).data,
    [],
    !id,
  );

  const report = reportState.data?.report ?? null;
  const templateFields = report?.templateSnapshot?.fields ?? report?.template?.fields;
  const templateName = report?.templateSnapshot?.name ?? report?.template?.name ?? null;
  const fields = useMemo(() => {
    const source =
      templateFields && templateFields.length > 0 ? templateFields : DEFAULT_FIELDS;
    return source.filter((field) => field.visible !== false);
  }, [templateFields]);

  const defaultTemplateApplied = useRef(false);
  useEffect(() => {
    if (id || defaultTemplateApplied.current || !templatesState.data) return;
    defaultTemplateApplied.current = true;
    if (createTemplateId) return;
    const fallback = templatesState.data.templates.find(
      (template) => template.isDefault && template.isActive,
    );
    if (fallback) setCreateTemplateId(fallback.id);
  }, [id, createTemplateId, templatesState.data]);

  useEffect(() => {
    if (!report) return;
    setContent(contentToState(report.currentContent, fields));
    setAmendMode(false);
    setError(null);
  }, [report?.id, report?.versionNumber, report?.updatedAt, fields]);

  const canWrite = hasPermission('CLINICAL_WRITE');
  const canFinalize = hasPermission('REPORTS_FINALIZE');
  const canSend = hasPermission('REPORTS_SEND');
  const latestDelivery = report?.deliveries?.[0] ?? null;
  const currentDelivery =
    latestDelivery && latestDelivery.versionNumber === report?.versionNumber
      ? latestDelivery
      : null;
  const pendingDeliveryIsStale =
    currentDelivery?.status === 'PENDING' &&
    Date.now() - new Date(currentDelivery.updatedAt).getTime() >= 5 * 60_000;
  const draft = report?.status === 'DRAFT';
  const editable = Boolean(report) && draft && canWrite;
  const amendmentEditable = Boolean(report) && !draft && amendMode && canFinalize;

  function buildContent(): Record<string, unknown> {
    const merged: Record<string, unknown> = { ...(report?.currentContent ?? {}) };
    for (const field of fields) {
      merged[field.key] = content[field.key] ?? '';
    }
    return merged;
  }

  async function saveDraft() {
    if (!report) return;
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/reports/${report.id}`, { content: buildContent() });
      toast.success('Draft saved');
      reportState.reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function finalize() {
    if (!report) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/reports/${report.id}/finalize`);
      toast.success('Report finalized', 'The visit has been completed and the report is now read-only.');
      setFinalizeOpen(false);
      reportState.reload();
    } catch (err) {
      setError(errorMessage(err));
      setFinalizeOpen(false);
    } finally {
      setBusy(false);
    }
  }

  async function sendWhatsApp() {
    if (!report) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/reports/${report.id}/whatsapp`, {
        consent: true,
        resend: currentDelivery?.status === 'SENT' || pendingDeliveryIsStale,
      });
      toast.success(
        'Report sent by WhatsApp',
        'The finalized PDF was sent to the patient phone number on file.',
      );
      setWhatsappOpen(false);
      reportState.reload();
    } catch (err) {
      setError(errorMessage(err));
      setWhatsappOpen(false);
    } finally {
      setBusy(false);
    }
  }

  async function amend(reason: string) {
    if (!report) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/reports/${report.id}/amend`, {
        content: buildContent(),
        reason,
      });
      toast.success('Amendment saved', 'A new immutable version has been recorded.');
      setReasonOpen(false);
      setAmendMode(false);
      reportState.reload();
    } catch (err) {
      setError(errorMessage(err));
      setReasonOpen(false);
    } finally {
      setBusy(false);
    }
  }

  async function deleteDraft() {
    if (!report) return;
    setBusy(true);
    try {
      await api.delete(`/reports/${report.id}`);
      toast.success('Draft deleted');
      navigate(`/visits/${report.visitId}`);
    } catch (err) {
      toast.error('Could not delete the draft', errorMessage(err));
      setDeleteOpen(false);
    } finally {
      setBusy(false);
    }
  }

  async function upload(file: File | null) {
    if (!file || !report) return;
    const form = new FormData();
    form.append('file', file);
    form.append('reportId', report.id);
    setUploading(true);
    try {
      await api.post('/files', form);
      toast.success('Attachment uploaded', file.name);
      reportState.reload();
    } catch (err) {
      toast.error('Upload rejected', errorMessage(err));
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  async function removeFile() {
    if (!deleteFileId) return;
    setBusy(true);
    try {
      await api.delete(`/files/${deleteFileId}`);
      toast.success('Attachment deleted');
      setDeleteFileId(null);
      reportState.reload();
    } catch (err) {
      toast.error('Could not delete the attachment', errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function createReport(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (!createVisitId) {
      setError('Select the visit this report belongs to.');
      return;
    }
    setCreating(true);
    try {
      const templates = templatesState.data?.templates ?? [];
      const template = templates.find((item) => item.id === createTemplateId);
      const usedFields = template && template.fields.length > 0 ? template.fields : DEFAULT_FIELDS;
      const visit = (visitsState.data?.visits ?? []).find((item) => item.id === createVisitId);
      const initial: ContentState = {};
      for (const field of usedFields) initial[field.key] = '';
      if ('indication' in initial && visit?.chiefComplaint) {
        initial.indication = visit.chiefComplaint;
      }
      const res = await api.post<{ report: Report }>('/reports', {
        visitId: createVisitId,
        templateId: createTemplateId || null,
        content: initial,
      });
      toast.success('Draft report created');
      navigate(`/reports/${res.data.report.id}`, { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setCreating(false);
    }
  }

  if (!id) {
    const visits = (visitsState.data?.visits ?? []).filter(
      (visit) => !visit.reports || visit.reports.length === 0,
    );
    const templates = (templatesState.data?.templates ?? []).filter(
      (template) => template.isActive,
    );

    return (
      <div className="space-y-6">
        <PageHeader
          eyebrow="Clinical"
          title="New report"
          description="Pick the visit and template. The draft opens in the report workspace, where it can be completed and finalized."
          actions={
            <Button variant="secondary" asChild>
              <Link to="/reports">
                <ArrowLeft className="h-4 w-4" aria-hidden />
                Reports
              </Link>
            </Button>
          }
        />

        {error && <Alert tone="danger">{error}</Alert>}

        <Card className="mx-auto max-w-2xl">
          <CardHeader
            title="Report details"
            description="Each visit can have one report. Only visits without a report are listed."
            icon={FilePlus2}
          />
          <form onSubmit={createReport} className="space-y-4 px-5 py-4">
            <Field label="Visit" required hint="Only open visits without a report appear here.">
              <Select
                value={createVisitId}
                onChange={(event) => setCreateVisitId(event.target.value)}
                required
              >
                <option value="">Select a visit…</option>
                {visits.map((visit) => (
                  <option key={visit.id} value={visit.id}>
                    {visit.patient
                      ? `${visit.patient.firstName} ${visit.patient.lastName}`
                      : 'Patient'}{' '}
                    — {formatDateOnly(dateOnlyInZone(visit.visitDate))} (
                    {visit.status.toLowerCase().replace('_', ' ')})
                  </option>
                ))}
              </Select>
            </Field>

            {visits.length === 0 && !visitsState.loading && (
              <Alert tone="info">
                There are no visits without a report. Start a visit first, then create its report.
              </Alert>
            )}

            <Field
              label="Template"
              hint="Choosing no template uses the standard ultrasound field set."
            >
              <Select
                value={createTemplateId}
                onChange={(event) => setCreateTemplateId(event.target.value)}
              >
                <option value="">Standard ultrasound report</option>
                {templates.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.name}
                    {template.isDefault ? ' (default)' : ''}
                  </option>
                ))}
              </Select>
            </Field>

            <div className="flex justify-end gap-2 border-t border-line pt-4">
              <Button type="button" variant="secondary" asChild>
                <Link to="/visits">Choose from visits</Link>
              </Button>
              <Button type="submit" loading={creating} disabled={!createVisitId}>
                Create draft
              </Button>
            </div>
          </form>
        </Card>
      </div>
    );
  }

  if (reportState.loading && !report) return <LoadingBlock label="Loading the report…" />;

  if (reportState.error) {
    return (
      <div className="space-y-4">
        <Alert tone="danger">{reportState.error}</Alert>
        <Button variant="secondary" asChild>
          <Link to="/reports">
            <ArrowLeft className="h-4 w-4" aria-hidden />
            Back to reports
          </Link>
        </Button>
      </div>
    );
  }

  if (!report) return null;

  const visit = report.visit;
  const patient = visit?.patient;
  const editableNow = editable || amendmentEditable;
  const files = report.files ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={draft ? 'Draft report' : `Version ${report.versionNumber}`}
        title={patient ? `${patient.firstName} ${patient.lastName}` : 'Clinical report'}
        description={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>
              {visit ? formatDateOnly(dateOnlyInZone(visit.visitDate)) : ''}
              {visit ? ` at ${formatTime(visit.visitDate, timezone)}` : ''}
            </span>
            <span>·</span>
            <span>
              {visit?.doctor
                ? `Dr ${visit.doctor.firstName} ${visit.doctor.lastName}`
                : 'Responsible doctor'}
            </span>
            {patient && <span>· {patient.patientNumber}</span>}
            {patient?.dateOfBirth && <span>· {ageFromDob(patient.dateOfBirth)}</span>}
          </span>
        }
        actions={
          <>
            <Button variant="secondary" asChild>
              <Link to={`/visits/${report.visitId}`}>
                <ArrowLeft className="h-4 w-4" aria-hidden />
                Visit
              </Link>
            </Button>
            <Button
              variant="secondary"
              onClick={() => window.open(`/reports/${report.id}/print`, '_blank')}
            >
              <Printer className="h-4 w-4" aria-hidden />
              Print
            </Button>
            {editable && (
              <>
                <Button variant="secondary" loading={busy} onClick={() => void saveDraft()}>
                  <Save className="h-4 w-4" aria-hidden />
                  Save draft
                </Button>
                {canFinalize && (
                  <Button onClick={() => setFinalizeOpen(true)}>
                    <CheckCircle2 className="h-4 w-4" aria-hidden />
                    Finalize
                  </Button>
                )}
              </>
            )}
            {!draft && canSend && !amendMode && (
              <Button
                variant="secondary"
                onClick={() => setWhatsappOpen(true)}
                disabled={
                  (currentDelivery?.status === 'PENDING' && !pendingDeliveryIsStale) || busy
                }
              >
                <MessageCircle className="h-4 w-4" aria-hidden />
                {currentDelivery?.status === 'SENT'
                  ? 'Resend WhatsApp'
                  : currentDelivery?.status === 'FAILED' || pendingDeliveryIsStale
                    ? 'Retry WhatsApp'
                    : 'Send WhatsApp'}
              </Button>
            )}
            {!draft && canFinalize && !amendMode && (
              <Button onClick={() => setAmendMode(true)}>
                <FileText className="h-4 w-4" aria-hidden />
                Amend
              </Button>
            )}
            {amendMode && (
              <>
                <Button variant="secondary" onClick={() => setAmendMode(false)} disabled={busy}>
                  Cancel
                </Button>
                <Button onClick={() => setReasonOpen(true)} loading={busy}>
                  <Save className="h-4 w-4" aria-hidden />
                  Save amendment
                </Button>
              </>
            )}
          </>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={report.status} />
        <Badge tone="muted">Version {report.versionNumber}</Badge>
        {report.finalizedAt && (
          <Badge tone="success">Finalized {formatDateTime(report.finalizedAt, timezone)}</Badge>
        )}
        {report.lastAmendedAt && (
          <Badge tone="brand">Amended {formatDateTime(report.lastAmendedAt, timezone)}</Badge>
        )}
        {!draft && !amendMode && <Badge tone="info">Read-only · immutable</Badge>}
        {currentDelivery && (
          <Badge
            tone={
              currentDelivery.status === 'SENT'
                ? 'success'
                : currentDelivery.status === 'FAILED'
                  ? 'danger'
                  : 'warning'
            }
          >
            WhatsApp {currentDelivery.status.toLowerCase()} ••••{currentDelivery.recipientLast4}
            {currentDelivery.sentAt ? ` · ${formatDateTime(currentDelivery.sentAt, timezone)}` : ''}
          </Badge>
        )}
        {draft && !canWrite && <Badge tone="warning">Read-only</Badge>}
      </div>

      {error && <Alert tone="danger">{error}</Alert>}

      {!draft && !amendMode && (
        <Alert tone="info" title="Finalized reports are immutable">
          Corrections are recorded as a new version with your name, the timestamp and the reason you
          provide. Earlier versions remain available below.
        </Alert>
      )}

      {amendMode && (
        <Alert tone="warning" title="Amendment mode">
          Edit the content, then save the amendment with a reason. The report will be stored as
          version {report.versionNumber + 1}; the current version is kept unchanged.
        </Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-6">
          <Card>
            <CardHeader
              title="Report content"
              description={
                templateName
                  ? `Template: ${templateName}`
                  : 'Standard ultrasound structure'
              }
              icon={FileText}
            />
            <div className="space-y-4 px-5 py-4">
              {fields.map((field) => {
                const fieldId = `report-field-${field.key}`;
                const value = content[field.key] ?? '';
                const onChange = (next: string) =>
                  setContent((prev) => ({ ...prev, [field.key]: next }));
                return (
                  <Field
                    key={field.key}
                    label={field.label}
                    htmlFor={fieldId}
                    required={field.required}
                    hint={field.placeholder ? undefined : undefined}
                  >
                    {field.type === 'textarea' ? (
                      <Textarea
                        id={fieldId}
                        value={value}
                        onChange={(event) => onChange(event.target.value)}
                        placeholder={field.placeholder}
                        readOnly={!editableNow}
                        disabled={!editableNow}
                        className={field.key === 'findings' ? 'min-h-[160px]' : 'min-h-[90px]'}
                      />
                    ) : (
                      <Input
                        id={fieldId}
                        type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'}
                        value={value}
                        onChange={(event) => onChange(event.target.value)}
                        placeholder={field.placeholder}
                        readOnly={!editableNow}
                        disabled={!editableNow}
                      />
                    )}
                  </Field>
                );
              })}
            </div>
          </Card>

          {visit?.measurements && visit.measurements.length > 0 && (
            <Card>
              <CardHeader
                title="Recorded measurements"
                description="From the clinical visit, for reference while writing the report."
              />
              <div className="divide-y divide-line">
                {visit.measurements.map((measurement) => (
                  <div
                    key={measurement.id}
                    className="flex flex-wrap items-baseline justify-between gap-2 px-5 py-2.5"
                  >
                    <span className="text-[13px] text-ink-700">{measurement.label}</span>
                    <span className="tabular text-[13px] font-medium text-ink-900">
                      {measurement.value}
                      {measurement.unit ? ` ${measurement.unit}` : ''}
                    </span>
                  </div>
                ))}
              </div>
            </Card>
          )}

          <Card>
            <CardHeader
              title="Attachments"
              description="Private images and PDFs linked to this report."
              icon={Paperclip}
              action={
                (editable || amendmentEditable) && (
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
              onChange={(event) => void upload(event.target.files?.[0] ?? null)}
            />
            {files.length === 0 ? (
              <p className="px-5 py-6 text-center text-[12px] text-ink-500">No attachments.</p>
            ) : (
              <div className="divide-y divide-line">
                {files.map((file) => (
                  <div key={file.id} className="flex items-center justify-between gap-2 px-5 py-2.5">
                    <div className="min-w-0">
                      <p className="truncate text-[12px] font-medium text-ink-800">
                        {file.originalName}
                      </p>
                      <p className="text-[10px] text-ink-400">
                        {(file.sizeBytes / 1024).toFixed(0)} KB ·{' '}
                        {formatDateTime(file.createdAt, timezone)}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-0.5">
                      <Button
                        size="iconSm"
                        variant="ghost"
                        aria-label="Download attachment"
                        onClick={() => void downloadFile(file.id, file.originalName)}
                      >
                        <Download className="h-3.5 w-3.5" aria-hidden />
                      </Button>
                      {editable && (
                        <Button
                          size="iconSm"
                          variant="ghost"
                          aria-label="Delete attachment"
                          onClick={() => setDeleteFileId(file.id)}
                        >
                          <Trash2 className="h-3.5 w-3.5 text-ink-400" aria-hidden />
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader title="Patient & visit" />
            <div className="space-y-3 px-5 py-4">
              <KeyValue label="Patient">
                {patient ? (
                  <Link
                    to={`/patients/${patient.id}`}
                    className="text-brand-700 hover:underline"
                  >
                    {patient.firstName} {patient.lastName}
                  </Link>
                ) : (
                  '—'
                )}
              </KeyValue>
              <div className="grid grid-cols-2 gap-3">
                <KeyValue label="Patient number">{patient?.patientNumber ?? '—'}</KeyValue>
                <KeyValue label="Date of birth">
                  {formatDateOnly(patient?.dateOfBirth ?? null)}
                </KeyValue>
              </div>
              <KeyValue label="Examination">
                {visit?.examinationType ?? '—'}
              </KeyValue>
              <KeyValue label="Indication">
                {visit?.chiefComplaint ?? '—'}
              </KeyValue>
              <KeyValue label="Visit status">
                {visit ? <StatusBadge status={visit.status} /> : '—'}
              </KeyValue>
              <KeyValue label="Responsible doctor">
                {visit?.doctor ? `Dr ${visit.doctor.firstName} ${visit.doctor.lastName}` : '—'}
              </KeyValue>
            </div>
          </Card>

          <Card>
            <CardHeader
              title="Version history"
              description="Newest first. Finalized versions are never rewritten."
              icon={History}
            />
            <div className="divide-y divide-line">
              {report.versions.map((version) => (
                <div key={version.id} className="px-5 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={version.isFinal ? 'success' : 'warning'}>
                      Version {version.versionNumber}
                    </Badge>
                    <span className="text-[11px] text-ink-400">
                      {version.isFinal ? 'final' : 'draft'}
                    </span>
                  </div>
                  <p className="mt-1 text-[11px] text-ink-500">
                    {formatDateTime(version.createdAt, timezone)} ·{' '}
                    {version.author
                      ? `${version.author.firstName} ${version.author.lastName}`
                      : 'Author'}
                  </p>
                  {version.reason && (
                    <p className="mt-1 text-[12px] text-ink-600">{version.reason}</p>
                  )}
                </div>
              ))}
            </div>
          </Card>

          {editable && (
            <Card>
              <CardHeader title="Draft actions" />
              <div className="px-5 py-4">
                <p className="text-[12px] leading-relaxed text-ink-500">
                  Deleting a draft removes it and returns the visit to its previous state. Finalized
                  reports cannot be deleted.
                </p>
                <Button
                  variant="outlineDanger"
                  size="sm"
                  className="mt-3"
                  onClick={() => setDeleteOpen(true)}
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  Delete draft
                </Button>
              </div>
            </Card>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={whatsappOpen}
        onOpenChange={setWhatsappOpen}
        title="Send this report by WhatsApp?"
        description={
          <>
            The finalized PDF will be sent to the patient phone number on file
            {patient?.phone
              ? ` (ending ${patient.phone.replace(/\D/g, '').slice(-4)})`
              : ''}
            . A successful send cannot be undone.
          </>
        }
        confirmLabel={currentDelivery?.status === 'SENT' ? 'Resend report' : 'Send report'}
        tone="warning"
        busy={busy}
        onConfirm={() => void sendWhatsApp()}
      >
        <Alert tone="warning" title="Clinical information leaves the clinic">
          Only continue after confirming the patient consented to receive clinical reports through
          WhatsApp. The delivery attempt is audited, but the messaging provider is outside the
          clinic&apos;s systems.
        </Alert>
      </ConfirmDialog>

      <ConfirmDialog
        open={finalizeOpen}
        onOpenChange={setFinalizeOpen}
        title="Finalize this report?"
        description="The report and its visit become read-only. Later corrections are stored as a new version with an amendment reason."
        confirmLabel="Finalize report"
        tone="primary"
        busy={busy}
        onConfirm={() => void finalize()}
      />

      <ReasonDialog
        open={reasonOpen}
        onOpenChange={setReasonOpen}
        title="Save an amendment"
        description="Explain what is being corrected. The reason, your name and the timestamp are kept with the new version."
        label="Amendment reason"
        confirmLabel="Save amendment"
        tone="warning"
        busy={busy}
        onConfirm={(reason) => void amend(reason)}
      />

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete this draft?"
        description="The draft and its content will be removed. This cannot be undone."
        confirmLabel="Delete draft"
        busy={busy}
        onConfirm={() => void deleteDraft()}
      />

      <ConfirmDialog
        open={deleteFileId !== null}
        onOpenChange={(next) => !next && setDeleteFileId(null)}
        title="Delete this attachment?"
        confirmLabel="Delete file"
        busy={busy}
        onConfirm={() => void removeFile()}
      />
    </div>
  );
}
