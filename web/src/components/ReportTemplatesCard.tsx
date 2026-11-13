import { useRef, useState } from 'react';
import {
  Archive,
  ArrowDown,
  ArrowUp,
  ChevronDown,
  Copy,
  FileText,
  Plus,
  Save,
  Star,
  Trash2,
} from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { useAsyncData } from '../lib/hooks';
import type {
  Gyn4dPrintSettings,
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
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
  /** Pretty-printed `layout.definition` for block templates only. */
  definitionText: string;
  isDefault: boolean;
  /** Set when the draft was opened from the Duplicate action. */
  duplicatedFrom?: string;
}

const STARTER_DEFINITION = {
  schemaVersion: 1,
  baseSize: 11,
  blocks: [
    { type: 'title', text: 'Ultrasound Report' },
    {
      type: 'section',
      title: 'Findings',
      children: [
        {
          type: 'text',
          template: '{{findings}}',
          fields: { findings: { placeholder: 'Findings' } },
        },
      ],
    },
    { type: 'signature' },
  ],
};

function parseDefinitionText(text: string): { definition?: unknown; error?: string } {
  try {
    return { definition: JSON.parse(text) };
  } catch (err) {
    return {
      error: `Definition JSON is not valid: ${err instanceof Error ? err.message : 'unknown error'}`,
    };
  }
}

const DEFAULT_FIELDS: ReportTemplateField[] = [
  { key: 'indication', label: 'Indication', type: 'textarea' },
  { key: 'findings', label: 'Findings', type: 'textarea' },
  { key: 'measurements', label: 'Measurements', type: 'textarea' },
  { key: 'impression', label: 'Impression', type: 'textarea' },
  { key: 'recommendations', label: 'Recommendations', type: 'textarea' },
];

/**
 * Effective 4D wording, mirrored from the backend renderer. New templates store
 * these values explicitly so the printed design starts identical to the seeded
 * 4D template (logo, header, footer and doctor block) and every part is editable.
 * `scanTitle` stays blank on purpose: the renderer then keeps the styled
 * "4D Gynecology SCAN" title.
 */
const GYN4D_DEFAULT_SETTINGS: Gyn4dPrintSettings = {
  pageTitle: '4D Gynecology Scan',
  headerText:
    'د/ منيره علي علي\nاستشاري الموجات الصوتية و طب الجنين\nبوحده طب الجنين- جامعه عين شمس',
  doctorName: 'Dr. Monira Ali Ali',
  doctorRole: 'Ultrasound and fetal medicine consultant, Fetal medicine unit,',
  doctorUniversity: 'Ain shams University.',
  phone: 'Tel : 01113735454 - 01555579454',
  address: '10 ش سامي عبد العال – ارض الجولف – مصر الجديدة',
  rightAdnexum: 'Right adnexum',
  leftAdnexum: 'Left adnexum',
};

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
    definitionText: '',
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
      printLayout: template.layout?.printLayout,
      ...(template.layout?.gyn4d ? { gyn4d: { ...template.layout.gyn4d } } : {}),
      ...(template.layout?.definition ? { definition: template.layout.definition } : {}),
    },
    definitionText: template.layout?.definition
      ? JSON.stringify(template.layout.definition, null, 2)
      : '',
    isDefault: template.isDefault,
  };
}

/**
 * A new template starts from the 4D design so it prints with the same logo,
 * header and footer. The operator can still switch the print layout to Standard.
 */
function newTemplateDraft(templates: ReportTemplate[]): Draft {
  const source = templates.find(
    (template) =>
      template.layout?.printLayout === 'gyn4d' &&
      template.fields.some((field) => field.key === 'uterusDesc'),
  );
  if (!source) return emptyDraft();

  const copy = draftFromTemplate(source);
  return {
    ...copy,
    id: undefined,
    name: '',
    description: '',
    serviceId: '',
    isDefault: false,
    layout: {
      ...copy.layout,
      printLayout: 'gyn4d',
      gyn4d: { ...GYN4D_DEFAULT_SETTINGS, ...(source.layout?.gyn4d ?? {}) },
    },
  };
}

/**
 * A block template starts from a minimal valid definition. The operator edits
 * the JSON in the dialog and can validate or preview it before saving.
 */
function newBlockTemplateDraft(): Draft {
  return {
    name: '',
    description: '',
    serviceId: '',
    fields: [],
    layout: {
      printLayout: 'blocks',
      showMeasurements: false,
      showSignature: false,
    },
    definitionText: JSON.stringify(STARTER_DEFINITION, null, 2),
    isDefault: false,
  };
}

function validateDraft(draft: Draft): string | null {
  if (!draft.name.trim()) return 'Give the template a name.';
  if (draft.layout.printLayout === 'blocks') {
    return parseDefinitionText(draft.definitionText).error ?? null;
  }
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
  const [deleteTarget, setDeleteTarget] = useState<ReportTemplate | null>(null);
  const [defaultTarget, setDefaultTarget] = useState<ReportTemplate | null>(null);
  const [blockCheck, setBlockCheck] = useState<{ ok: boolean; message: string } | null>(null);
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const importInput = useRef<HTMLInputElement | null>(null);

  const templates = templatesState.data?.templates ?? [];
  const services = servicesState.data?.services ?? [];
  const serviceName = (id: string | null) =>
    id ? (services.find((service) => service.id === id)?.name ?? 'Service') : 'Any service';

  function openDraft(next: Draft) {
    setError(null);
    setBlockCheck(null);
    setPreviewHtml(null);
    setDraft(next);
  }

  function updateDefinitionText(value: string) {
    setBlockCheck(null);
    setPreviewHtml(null);
    updateDraft({ definitionText: value });
  }

  async function validateBlockDefinition(text: string) {
    const parsed = parseDefinitionText(text);
    if (parsed.error) {
      setBlockCheck({ ok: false, message: parsed.error });
      return;
    }
    setBusy(true);
    try {
      const res = await api.post<{ ok: boolean; errors: string[]; fieldCount: number }>(
        '/reports/templates/validate',
        { definition: parsed.definition },
      );
      setBlockCheck({
        ok: res.data.ok,
        message: res.data.ok
          ? `OK, ${res.data.fieldCount} field${res.data.fieldCount === 1 ? '' : 's'}`
          : res.data.errors.join('\n'),
      });
    } catch (err) {
      setBlockCheck({ ok: false, message: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  async function previewBlockDefinition(text: string) {
    const parsed = parseDefinitionText(text);
    if (parsed.error) {
      setBlockCheck({ ok: false, message: parsed.error });
      return;
    }
    setBusy(true);
    try {
      const res = await api.post<{ html: string }>('/reports/templates/preview', {
        definition: parsed.definition,
      });
      setPreviewHtml(res.data.html);
    } catch (err) {
      setBlockCheck({ ok: false, message: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  function importDefinitionJson(file: File | null) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === 'string' ? reader.result : '';
      const parsed = parseDefinitionText(text);
      if (parsed.error) {
        setBlockCheck({ ok: false, message: parsed.error });
        return;
      }
      const value = parsed.definition;
      const definition =
        value && typeof value === 'object' && 'definition' in value
          ? (value as { definition: unknown }).definition
          : value;
      updateDefinitionText(JSON.stringify(definition, null, 2));
    };
    reader.readAsText(file);
    if (importInput.current) importInput.current.value = '';
  }

  function exportDefinitionJson() {
    if (!draft) return;
    const parsed = parseDefinitionText(draft.definitionText);
    if (parsed.error) {
      setError(parsed.error);
      return;
    }
    const payload = {
      name: draft.name.trim() || 'report-template',
      description: draft.description.trim(),
      definition: parsed.definition,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${(draft.name.trim() || 'report-template')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

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

  function updateGyn4dSettings(patch: Partial<Gyn4dPrintSettings>) {
    setDraft((current) => {
      if (!current) return current;
      return {
        ...current,
        layout: {
          ...current.layout,
          gyn4d: { ...(current.layout.gyn4d ?? {}), ...patch },
        },
      };
    });
  }

  /**
   * Switching a template to the 4D layout starts it from the classic 4D
   * structure and wording. From there the operator can freely add, delete or
   * reorder sections; the structure-aware renderer follows the template.
   */
  function changePrintLayout(printLayout: 'default' | 'gyn4d') {
    setDraft((current) => {
      if (!current) return current;
      let fields = current.fields;
      let gyn4d = current.layout.gyn4d;
      if (printLayout === 'gyn4d') {
        const source = templates.find(
          (template) =>
            template.layout?.printLayout === 'gyn4d' &&
            template.fields.some((field) => field.key === 'uterusDesc'),
        );
        if (source) {
          if (!fields.some((field) => field.key === 'uterusDesc')) {
            fields = source.fields.map((field) => ({ ...field }));
          }
          if (!gyn4d) {
            gyn4d = { ...GYN4D_DEFAULT_SETTINGS, ...(source.layout?.gyn4d ?? {}) };
          }
        }
      }
      return {
        ...current,
        fields,
        layout: { ...current.layout, printLayout, ...(gyn4d ? { gyn4d } : {}) },
      };
    });
  }

  function duplicateTemplate(template: ReportTemplate) {
    const existingNames = new Set(templates.map((item) => item.name.trim().toLowerCase()));
    const base = `${template.name} (copy)`;
    let name = base.slice(0, 160);
    for (let index = 2; existingNames.has(name.toLowerCase()); index += 1) {
      name = `${template.name} (copy ${index})`.slice(0, 160);
      if (index > 100) break;
    }
    const copy = draftFromTemplate(template);
    openDraft({
      ...copy,
      id: undefined,
      name,
      isDefault: false,
      duplicatedFrom: template.name,
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
    const blockTemplate = draft.layout.printLayout === 'blocks';
    let definition: unknown;
    if (blockTemplate) {
      const parsed = parseDefinitionText(draft.definitionText);
      if (parsed.error) {
        setError(parsed.error);
        return;
      }
      definition = parsed.definition;
    }
    setBusy(true);
    try {
      let payload: Record<string, unknown>;
      if (blockTemplate) {
        payload = {
          name: draft.name.trim(),
          description: draft.description.trim(),
          serviceId: draft.serviceId || null,
          isDefault: draft.isDefault,
          layout: { printLayout: 'blocks', definition },
        };
      } else {
        const gyn4dSettings = Object.fromEntries(
          Object.entries(draft.layout.gyn4d ?? {}).filter(
            ([, value]) => typeof value === 'string' && value.trim(),
          ),
        ) as Gyn4dPrintSettings;
        payload = {
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
            ...(field.defaultValue !== undefined ? { defaultValue: field.defaultValue } : {}),
          })),
          layout: {
            headerNote: draft.layout.headerNote?.trim() ?? '',
            footerNote: draft.layout.footerNote?.trim() ?? '',
            showMeasurements: draft.layout.showMeasurements ?? true,
            showSignature: draft.layout.showSignature ?? true,
            ...(draft.layout.printLayout && draft.layout.printLayout !== 'default'
              ? { printLayout: draft.layout.printLayout }
              : {}),
            ...(draft.layout.printLayout === 'gyn4d' && Object.keys(gyn4dSettings).length > 0
              ? { gyn4d: gyn4dSettings }
              : {}),
          },
          isDefault: draft.isDefault,
        };
      }
      if (draft.id) {
        await api.patch(`/reports/templates/${draft.id}`, payload);
        toast.success('Report template updated');
      } else {
        await api.post('/reports/templates', payload);
        toast.success('Report template created');
      }
      setDraft(null);
      setBlockCheck(null);
      setPreviewHtml(null);
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

  async function deleteTemplate() {
    if (!deleteTarget) return;
    setBusy(true);
    try {
      await api.delete(`/reports/templates/${deleteTarget.id}/permanent`);
      toast.success('Template deleted. Existing reports keep their pinned version.');
      setDeleteTarget(null);
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
        description="Section order, headings, defaults, 4D print details and the default template. Reports keep the version they were created with."
        icon={FileText}
        action={
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm">
                <Plus className="h-3.5 w-3.5" aria-hidden />
                New template
                <ChevronDown className="h-3.5 w-3.5" aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-56">
              <DropdownMenuItem onSelect={() => openDraft(newTemplateDraft(templates))}>
                <FileText className="h-4 w-4" aria-hidden />
                Standard template
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => openDraft(newBlockTemplateDraft())}>
                <FileText className="h-4 w-4" aria-hidden />
                Block template
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
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
                        {template.layout?.printLayout === 'gyn4d' && (
                          <Badge tone="muted">4D</Badge>
                        )}
                        {template.layout?.printLayout === 'blocks' && (
                          <Badge tone="info">Blocks</Badge>
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
                          onClick={() => openDraft(draftFromTemplate(template))}
                        >
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => duplicateTemplate(template)}
                          title="Create an editable copy of this template"
                        >
                          <Copy className="h-3.5 w-3.5" aria-hidden />
                          Duplicate
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
                            title="Hide this template from new reports"
                          >
                            <Archive className="h-3.5 w-3.5" aria-hidden />
                            Archive
                          </Button>
                        ) : (
                          <Button size="sm" variant="ghost" onClick={() => void restore(template)}>
                            Restore
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-clay-700 hover:bg-clay-50 hover:text-clay-800"
                          onClick={() => setDeleteTarget(template)}
                          title="Permanently delete this template"
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden />
                          Delete
                        </Button>
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
            title={
              draft?.id
                ? 'Edit report template'
                : draft?.duplicatedFrom
                  ? 'Duplicate report template'
                  : draft?.layout.printLayout === 'blocks'
                    ? 'New block template'
                    : 'New report template'
            }
            description={
              draft?.duplicatedFrom
                ? `A new copy of “${draft.duplicatedFrom}”. Change any detail before saving; existing reports keep their pinned version.`
                : draft?.id
                  ? 'Changes apply to new reports. Reports already created keep their pinned version.'
                  : draft?.layout.printLayout === 'blocks'
                    ? 'Define the report as JSON blocks. Validate or preview it before saving; existing reports keep their pinned version.'
                    : 'New templates start from the 4D design with the same logo, header and footer. Change any detail before saving; switch the print layout to Standard if you need a plain report.'
            }
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

            {draft?.layout.printLayout !== 'blocks' && (
            <div className="rounded-xl border border-line p-3">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <p className="text-[13px] font-semibold text-ink-900">Sections</p>
                  <p className="text-[11px] text-ink-500">
                    {draft?.layout.printLayout === 'gyn4d'
                      ? 'Add, delete, rename or reorder sections. Known 4D keys keep the classic layout; extra sections print after their position in this list.'
                      : 'Printed in this order. Empty sections are omitted from the printout.'}
                  </p>
                </div>
                <Button size="sm" variant="secondary" onClick={addField}>
                  <Plus className="h-3.5 w-3.5" aria-hidden />
                  Add section
                </Button>
              </div>

              <div className="mt-3 space-y-2">
                {(draft?.fields ?? []).map((field, index) => {
                  const listDefault = Array.isArray(field.defaultValue)
                    ? field.defaultValue.join('\n')
                    : '';
                  const defaultText =
                    typeof field.defaultValue === 'string' ? field.defaultValue : listDefault;
                  return (
                    <div key={`${field.key}-${index}`} className="rounded-lg bg-surface-muted/45 p-2.5">
                      <div className="grid gap-2 sm:grid-cols-[1fr_10rem_8rem_auto]">
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
                            <option value="list">List</option>
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
                      <div className="mt-2 grid gap-2 sm:grid-cols-2">
                        <Field
                          label="Default value"
                          hint={
                            field.type === 'list'
                              ? 'One list item per line.'
                              : 'Prefilled when a new report starts.'
                          }
                        >
                          {field.type === 'list' ? (
                            <Textarea
                              rows={2}
                              value={listDefault}
                              onChange={(event) => {
                                const items = event.target.value
                                  .split(/\r?\n/)
                                  .map((item) => item.trim())
                                  .filter(Boolean);
                                updateField(index, {
                                  defaultValue: items.length > 0 ? items : undefined,
                                });
                              }}
                              placeholder={'One item per line\ne.g. AVF uterus\nNormal both ovaries'}
                            />
                          ) : (
                            <Input
                              value={defaultText}
                              onChange={(event) =>
                                updateField(index, {
                                  defaultValue: event.target.value || undefined,
                                })
                              }
                              placeholder="Leave blank to start empty"
                            />
                          )}
                        </Field>
                        <Field label="Placeholder" hint="Hint shown inside the empty editor field.">
                          <Input
                            value={field.placeholder ?? ''}
                            onChange={(event) =>
                              updateField(index, {
                                placeholder: event.target.value || undefined,
                              })
                            }
                            placeholder="e.g. mm or cc"
                          />
                        </Field>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
            )}

            {draft?.layout.printLayout !== 'blocks' && (
            <div className="grid gap-3 rounded-xl border border-line p-3 sm:grid-cols-2">
              <Field
                label="Print layout"
                hint="4D keeps the logo, header and footer while sections stay editable."
              >
                <Select
                  value={draft?.layout.printLayout ?? 'default'}
                  onChange={(event) =>
                    changePrintLayout(event.target.value as 'default' | 'gyn4d')
                  }
                >
                  <option value="default">Standard</option>
                  <option value="gyn4d">4D Gynecology (Dr. Monira)</option>
                </Select>
              </Field>
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
            )}

            {draft?.layout.printLayout === 'blocks' && (
              <div className="space-y-3 rounded-xl border border-line p-3">
                <div>
                  <p className="text-[13px] font-semibold text-ink-900">Block definition</p>
                  <p className="text-[11px] text-ink-500">
                    The JSON list of blocks rendered by the report engine. Validate or preview it
                    before saving; the server derives the fields from the definition.
                  </p>
                </div>
                <Textarea
                  value={draft.definitionText}
                  onChange={(event) => updateDefinitionText(event.target.value)}
                  rows={16}
                  spellCheck={false}
                  className="font-mono text-[11px] leading-relaxed"
                  aria-label="Template definition JSON"
                />
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => void validateBlockDefinition(draft.definitionText)}
                    disabled={busy}
                  >
                    Validate
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => void previewBlockDefinition(draft.definitionText)}
                    disabled={busy}
                  >
                    Preview
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => importInput.current?.click()}
                  >
                    Import JSON
                  </Button>
                  <Button size="sm" variant="secondary" onClick={exportDefinitionJson}>
                    Export JSON
                  </Button>
                  <input
                    ref={importInput}
                    type="file"
                    className="hidden"
                    accept="application/json,.json"
                    onChange={(event) => importDefinitionJson(event.target.files?.[0] ?? null)}
                  />
                </div>
                {blockCheck && (
                  <Alert tone={blockCheck.ok ? 'success' : 'danger'}>
                    <span className="whitespace-pre-wrap">{blockCheck.message}</span>
                  </Alert>
                )}
                {previewHtml && (
                  <iframe
                    title="Template preview"
                    srcDoc={previewHtml}
                    sandbox="allow-same-origin allow-modals"
                    className="mx-auto block h-[520px] w-[8.5in] max-w-full border border-line bg-white"
                  />
                )}
              </div>
            )}

            {draft?.layout.printLayout === 'gyn4d' && (
              <div className="space-y-3 rounded-xl border border-line p-3">
                <div>
                  <p className="text-[13px] font-semibold text-ink-900">4D print details</p>
                  <p className="text-[11px] text-ink-500">
                    Leave a field blank to keep the original Dr. Monira wording. The logo and 4D
                    page design stay the same; sections can be added, removed or reordered above.
                  </p>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Page title" hint="Browser tab and PDF document title.">
                    <Input
                      value={draft.layout.gyn4d?.pageTitle ?? ''}
                      onChange={(event) =>
                        updateGyn4dSettings({ pageTitle: event.target.value })
                      }
                      placeholder="4D Gynecology Scan"
                    />
                  </Field>
                  <Field label="Printed scan title" hint="Centered title above the sections.">
                    <Input
                      value={draft.layout.gyn4d?.scanTitle ?? ''}
                      onChange={(event) =>
                        updateGyn4dSettings({ scanTitle: event.target.value })
                      }
                      placeholder="4D Gynecology SCAN"
                    />
                  </Field>
                </div>
                <Field
                  label="Header text"
                  hint="One line per row. The first line is highlighted; the logo stays on the right."
                >
                  <Textarea
                    value={draft.layout.gyn4d?.headerText ?? ''}
                    onChange={(event) =>
                      updateGyn4dSettings({ headerText: event.target.value })
                    }
                    rows={3}
                    placeholder={'د/ منيره علي علي\nاستشاري الموجات الصوتية و طب الجنين\nبوحده طب الجنين- جامعه عين شمس'}
                  />
                </Field>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Doctor name" hint="Signature block.">
                    <Input
                      value={draft.layout.gyn4d?.doctorName ?? ''}
                      onChange={(event) =>
                        updateGyn4dSettings({ doctorName: event.target.value })
                      }
                      placeholder="Dr. Monira Ali Ali"
                    />
                  </Field>
                  <Field label="Doctor role / title" hint="Signature block.">
                    <Input
                      value={draft.layout.gyn4d?.doctorRole ?? ''}
                      onChange={(event) =>
                        updateGyn4dSettings({ doctorRole: event.target.value })
                      }
                      placeholder="Ultrasound and fetal medicine consultant, Fetal medicine unit,"
                    />
                  </Field>
                  <Field label="University / hospital">
                    <Input
                      value={draft.layout.gyn4d?.doctorUniversity ?? ''}
                      onChange={(event) =>
                        updateGyn4dSettings({ doctorUniversity: event.target.value })
                      }
                      placeholder="Ain shams University."
                    />
                  </Field>
                  <Field label="Phone">
                    <Input
                      value={draft.layout.gyn4d?.phone ?? ''}
                      onChange={(event) => updateGyn4dSettings({ phone: event.target.value })}
                      placeholder="Tel : 01113735454 - 01555579454"
                    />
                  </Field>
                </div>
                <Field label="Address">
                  <Input
                    value={draft.layout.gyn4d?.address ?? ''}
                    onChange={(event) => updateGyn4dSettings({ address: event.target.value })}
                    placeholder="10 ش سامي عبد العال – ارض الجولف – مصر الجديدة"
                  />
                </Field>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field
                    label="Right adnexum heading"
                    hint="Section heading above the right ovary table."
                  >
                    <Input
                      value={draft.layout.gyn4d?.rightAdnexum ?? ''}
                      onChange={(event) =>
                        updateGyn4dSettings({ rightAdnexum: event.target.value })
                      }
                      placeholder="Right adnexum"
                    />
                  </Field>
                  <Field
                    label="Left adnexum heading"
                    hint="Section heading above the left ovary table."
                  >
                    <Input
                      value={draft.layout.gyn4d?.leftAdnexum ?? ''}
                      onChange={(event) =>
                        updateGyn4dSettings({ leftAdnexum: event.target.value })
                      }
                      placeholder="Left adnexum"
                    />
                  </Field>
                </div>
              </div>
            )}

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

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title="Delete this template permanently?"
        description={`“${deleteTarget?.name ?? ''}” will be removed for good and cannot be restored. Reports already created keep their own pinned copy and remain printable.`}
        confirmLabel="Delete permanently"
        busy={busy}
        onConfirm={() => void deleteTemplate()}
      />
    </Card>
  );
}
