import { useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  FileText,
  Plus,
  Save,
  Star,
  Trash2,
} from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { useAsyncData } from '../lib/hooks';
import type {
  ReportTemplate,
  ReportTemplateField,
  ReportTemplateLayout,
  Service,
} from '../lib/types';
import { ConfirmDialog } from './dialogs';
import { useToast } from './toast';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  Checkbox,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  EmptyState,
  Field,
  Input,
  LoadingBlock,
  Select,
  Table,
  TableWrap,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Textarea,
} from './ui';

interface Draft {
  id?: string;
  name: string;
  description: string;
  serviceId: string;
  fields: ReportTemplateField[];
  layout: ReportTemplateLayout;
  isDefault: boolean;
}

const DEFAULT_FIELDS: ReportTemplateField[] = [
  { key: 'indication', label: 'Indication', type: 'textarea' },
  { key: 'findings', label: 'Findings', type: 'textarea' },
  { key: 'measurements', label: 'Measurements', type: 'textarea' },
  { key: 'impression', label: 'Impression', type: 'textarea' },
  { key: 'recommendations', label: 'Recommendations', type: 'textarea' },
];

function emptyDraft(): Draft {
  return {
    name: '',
    description: '',
    serviceId: '',
    fields: DEFAULT_FIELDS.map((field) => ({ ...field })),
    layout: {
      headerNote: '',
      footerNote: '',
      showMeasurements: true,
      showSignature: true,
    },
    isDefault: false,
  };
}

function draftFromTemplate(template: ReportTemplate): Draft {
  return {
    id: template.id,
    name: template.name,
    description: template.description ?? '',
    serviceId: template.serviceId ?? '',
    fields: template.fields.map((field) => ({ ...field })),
    layout: {
      headerNote: template.layout?.headerNote ?? '',
      footerNote: template.layout?.footerNote ?? '',
      showMeasurements: template.layout?.showMeasurements ?? true,
      showSignature: template.layout?.showSignature ?? true,
    },
    isDefault: template.isDefault,
  };
}

function validateDraft(draft: Draft): string | null {
  if (!draft.name.trim()) return 'Give the template a name.';
  if (draft.fields.length === 0) return 'Add at least one section.';
  const keys = new Set<string>();
  for (const [index, field] of draft.fields.entries()) {
    if (!field.label.trim()) return `Section ${index + 1} needs a heading.`;
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(field.key.trim())) {
      return `Section ${index + 1}: the field key must start with a letter and use only letters, numbers and underscores.`;
    }
    if (keys.has(field.key.trim())) return `Duplicate field key “${field.key}”.`;
    keys.add(field.key.trim());
  }
  return null;
}

export function ReportTemplatesCard() {
  const toast = useToast();
  const templatesState = useAsyncData<{ templates: ReportTemplate[] }>(
    async () => (await api.get<{ templates: ReportTemplate[] }>('/reports/templates')).data,
    [],
  );
  const servicesState = useAsyncData<{ services: Service[] }>(
    async () => (await api.get<{ services: Service[] }>('/settings/services')).data,
    [],
  );

  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<ReportTemplate | null>(null);
  const [defaultTarget, setDefaultTarget] = useState<ReportTemplate | null>(null);

  const templates = templatesState.data?.templates ?? [];
  const services = servicesState.data?.services ?? [];
  const serviceName = (id: string | null) =>
    id ? (services.find((service) => service.id === id)?.name ?? 'Service') : 'Any service';

  function updateDraft(patch: Partial<Draft>) {
    setDraft((current) => (current ? { ...current, ...patch } : current));
  }

  function updateField(index: number, patch: Partial<ReportTemplateField>) {
    setDraft((current) => {
      if (!current) return current;
      return {
        ...current,
        fields: current.fields.map((field, i) => (i === index ? { ...field, ...patch } : field)),
      };
    });
  }

  function moveField(index: number, delta: number) {
    setDraft((current) => {
      if (!current) return current;
      const target = index + delta;
      const moving = current.fields[index];
      const displaced = current.fields[target];
      if (!moving || !displaced) return current;
      const fields = [...current.fields];
      fields[index] = displaced;
      fields[target] = moving;
      return { ...current, fields };
    });
  }

  function addField() {
    setDraft((current) => {
      if (!current) return current;
      let suffix = current.fields.length + 1;
      while (current.fields.some((field) => field.key === `section_${suffix}`)) suffix += 1;
      return {
        ...current,
        fields: [
          ...current.fields,
          { key: `section_${suffix}`, label: '', type: 'textarea', required: false },
        ],
      };
    });
  }

  function removeField(index: number) {
    setDraft((current) =>
      current
        ? { ...current, fields: current.fields.filter((_, i) => i !== index) }
        : current,
    );
  }

  async function save() {
    if (!draft) return;
    const problem = validateDraft(draft);
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const payload = {
        name: draft.name.trim(),
        description: draft.description.trim(),
        serviceId: draft.serviceId || null,
        fields: draft.fields.map((field) => ({
          key: field.key.trim(),
          label: field.label.trim(),
          type: field.type,
          required: field.required ?? false,
          visible: field.visible !== false,
          ...(field.placeholder?.trim() ? { placeholder: field.placeholder.trim() } : {}),
        })),
        layout: {
          headerNote: draft.layout.headerNote?.trim() ?? '',
          footerNote: draft.layout.footerNote?.trim() ?? '',
          showMeasurements: draft.layout.showMeasurements ?? true,
          showSignature: draft.layout.showSignature ?? true,
        },
        isDefault: draft.isDefault,
      };
      if (draft.id) {
        await api.patch(`/reports/templates/${draft.id}`, payload);
        toast.success('Report template updated');
      } else {
        await api.post('/reports/templates', payload);
        toast.success('Report template created');
      }
      setDraft(null);
      templatesState.reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function makeDefault(template: ReportTemplate) {
    setBusy(true);
    try {
      await api.patch(`/reports/templates/${template.id}`, {
        isDefault: true,
        isActive: true,
      });
      toast.success(`“${template.name}” is now the default template`);
      setDefaultTarget(null);
      templatesState.reload();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function archive() {
    if (!archiveTarget) return;
    setBusy(true);
    try {
      await api.delete(`/reports/templates/${archiveTarget.id}`);
      toast.success('Template archived. Existing reports keep their pinned version.');
      setArchiveTarget(null);
      templatesState.reload();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function restore(template: ReportTemplate) {
    setBusy(true);
    try {
      await api.patch(`/reports/templates/${template.id}`, { isActive: true });
      toast.success('Template restored');
      templatesState.reload();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title="Report templates"
        description="Section order, headings, print notes and the default template. Reports keep the version they were created with."
        icon={FileText}
        action={
          <Button size="sm" onClick={() => setDraft(emptyDraft())}>
            <Plus className="h-3.5 w-3.5" aria-hidden />
            New template
          </Button>
        }
      />

      <div className="space-y-3 px-5 py-4">
        {templatesState.error && <Alert tone="danger">{templatesState.error}</Alert>}
        {templatesState.loading && templates.length === 0 ? (
          <LoadingBlock label="Loading report templates…" />
        ) : templates.length === 0 ? (
          <EmptyState
            icon={FileText}
            title="No report templates yet"
            description="Create a template to standardise the sections used in ultrasound reports."
          />
        ) : (
          <TableWrap>
            <Table>
              <THead>
                <TR>
                  <TH>Template</TH>
                  <TH>Service</TH>
                  <TH>Sections</TH>
                  <TH>Used by</TH>
                  <TH className="text-right">Actions</TH>
                </TR>
              </THead>
              <TBody>
                {templates.map((template) => (
                  <TR key={template.id}>
                    <TD>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-ink-900">{template.name}</span>
                        {template.isDefault && (
                          <Badge tone="brand" dot>
                            Default
                          </Badge>
                        )}
                        {!template.isActive && <Badge tone="muted">Archived</Badge>}
                      </div>
                      {template.description && (
                        <p className="mt-0.5 max-w-md text-[11px] text-ink-500">
                          {template.description}
                        </p>
                      )}
                    </TD>
                    <TD className="text-ink-600">{serviceName(template.serviceId)}</TD>
                    <TD className="tabular text-ink-600">{template.fields.length}</TD>
                    <TD className="tabular text-ink-600">{template._count?.reports ?? 0}</TD>
                    <TD>
                      <div className="flex flex-wrap items-center justify-end gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setError(null);
                            setDraft(draftFromTemplate(template));
                          }}
                        >
                          Edit
                        </Button>
                        {!template.isDefault && template.isActive && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setDefaultTarget(template)}
                            title="Use this template by default"
                          >
                            <Star className="h-3.5 w-3.5" aria-hidden />
                            Set default
                          </Button>
                        )}
                        {template.isActive ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setArchiveTarget(template)}
                          >
                            <Trash2 className="h-3.5 w-3.5" aria-hidden />
                            Archive
                          </Button>
                        ) : (
                          <Button size="sm" variant="ghost" onClick={() => void restore(template)}>
                            Restore
                          </Button>
                        )}
                      </div>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableWrap>
        )}
      </div>

      <Dialog open={draft !== null} onOpenChange={(open) => !open && setDraft(null)}>
        <DialogContent size="xl" className="max-w-3xl">
          <DialogHeader
            title={draft?.id ? 'Edit report template' : 'New report template'}
            description="Changes apply to new reports. Reports already created keep their pinned version."
            icon={FileText}
          />
          <DialogBody className="space-y-5">
            {error && <Alert tone="danger">{error}</Alert>}
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Name" required>
                <Input
                  value={draft?.name ?? ''}
                  onChange={(event) => updateDraft({ name: event.target.value })}
                  placeholder="e.g. Obstetric ultrasound"
                />
              </Field>
              <Field label="Service" hint="Optional. Links the template to a service.">
                <Select
                  value={draft?.serviceId ?? ''}
                  onChange={(event) => updateDraft({ serviceId: event.target.value })}
                >
                  <option value="">Any service</option>
                  {services.map((service) => (
                    <option key={service.id} value={service.id}>
                      {service.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Field label="Description">
              <Input
                value={draft?.description ?? ''}
                onChange={(event) => updateDraft({ description: event.target.value })}
                placeholder="When should this template be used?"
              />
            </Field>

            <div className="rounded-xl border border-line p-3">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <p className="text-[13px] font-semibold text-ink-900">Sections</p>
                  <p className="text-[11px] text-ink-500">
                    Printed in this order. Empty sections are omitted from the printout.
                  </p>
                </div>
                <Button size="sm" variant="secondary" onClick={addField}>
                  <Plus className="h-3.5 w-3.5" aria-hidden />
                  Add section
                </Button>
              </div>

              <div className="mt-3 space-y-2">
                {(draft?.fields ?? []).map((field, index) => (
                  <div
                    key={`${field.key}-${index}`}
                    className="grid gap-2 rounded-lg bg-surface-muted/45 p-2.5 sm:grid-cols-[1fr_10rem_8rem_auto]"
                  >
                    <Field label="Heading">
                      <Input
                        value={field.label}
                        onChange={(event) => updateField(index, { label: event.target.value })}
                        placeholder="e.g. Findings"
                      />
                    </Field>
                    <Field label="Field key">
                      <Input
                        value={field.key}
                        onChange={(event) => updateField(index, { key: event.target.value })}
                        placeholder="findings"
                      />
                    </Field>
                    <Field label="Type">
                      <Select
                        value={field.type}
                        onChange={(event) =>
                          updateField(index, {
                            type: event.target.value as ReportTemplateField['type'],
                          })
                        }
                      >
                        <option value="textarea">Paragraph</option>
                        <option value="text">Short text</option>
                        <option value="number">Number</option>
                        <option value="date">Date</option>
                        <option value="select">Choice</option>
                      </Select>
                    </Field>
                    <div className="flex flex-wrap items-end gap-1 pb-0.5">
                      <Checkbox
                        id={`required-${index}`}
                        checked={field.required ?? false}
                        onCheckedChange={(checked) => updateField(index, { required: checked })}
                        label="Required"
                      />
                      <Checkbox
                        id={`visible-${index}`}
                        checked={field.visible !== false}
                        onCheckedChange={(checked) => updateField(index, { visible: checked })}
                        label="Print"
                      />
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Move ${field.label || 'section'} up`}
                        onClick={() => moveField(index, -1)}
                        disabled={index === 0}
                      >
                        <ArrowUp className="h-3.5 w-3.5" aria-hidden />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Move ${field.label || 'section'} down`}
                        onClick={() => moveField(index, 1)}
                        disabled={index === (draft?.fields.length ?? 0) - 1}
                      >
                        <ArrowDown className="h-3.5 w-3.5" aria-hidden />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Remove ${field.label || 'section'}`}
                        onClick={() => removeField(index)}
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="grid gap-3 rounded-xl border border-line p-3 sm:grid-cols-2">
              <Field label="Print header note" hint="Shown under the clinic letterhead.">
                <Textarea
                  value={draft?.layout.headerNote ?? ''}
                  onChange={(event) =>
                    updateDraft({
                      layout: { ...(draft?.layout ?? {}), headerNote: event.target.value },
                    })
                  }
                  rows={2}
                />
              </Field>
              <Field label="Print footer note" hint="Shown above the signature block.">
                <Textarea
                  value={draft?.layout.footerNote ?? ''}
                  onChange={(event) =>
                    updateDraft({
                      layout: { ...(draft?.layout ?? {}), footerNote: event.target.value },
                    })
                  }
                  rows={2}
                />
              </Field>
              <Checkbox
                id="template-measurements"
                checked={draft?.layout.showMeasurements ?? true}
                onCheckedChange={(checked) =>
                  updateDraft({
                    layout: { ...(draft?.layout ?? {}), showMeasurements: checked },
                  })
                }
                label="Show the measurements table when data exists"
              />
              <Checkbox
                id="template-signature"
                checked={draft?.layout.showSignature ?? true}
                onCheckedChange={(checked) =>
                  updateDraft({
                    layout: { ...(draft?.layout ?? {}), showSignature: checked },
                  })
                }
                label="Show the doctor signature block"
              />
            </div>

            <Checkbox
              id="template-default"
              checked={draft?.isDefault ?? false}
              onCheckedChange={(checked) => updateDraft({ isDefault: checked })}
              label="Use this template by default for new reports"
            />
          </DialogBody>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setDraft(null)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={() => void save()} loading={busy}>
              <Save className="h-4 w-4" aria-hidden />
              Save template
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={defaultTarget !== null}
        onOpenChange={(open) => !open && setDefaultTarget(null)}
        title="Make this the default template?"
        description="New reports will start with this template. Reports already created are not changed."
        confirmLabel="Make default"
        busy={busy}
        onConfirm={() => defaultTarget && void makeDefault(defaultTarget)}
      />

      <ConfirmDialog
        open={archiveTarget !== null}
        onOpenChange={(open) => !open && setArchiveTarget(null)}
        title="Archive this template?"
        description="It will no longer be offered for new reports. Existing reports keep their pinned version and remain printable."
        confirmLabel="Archive template"
        busy={busy}
        onConfirm={() => void archive()}
      />
    </Card>
  );
}
