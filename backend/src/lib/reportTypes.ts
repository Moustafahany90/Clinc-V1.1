export interface ReportTemplateField {
  key: string;
  label: string;
  type: 'text' | 'textarea' | 'number' | 'date' | 'select' | 'list';
  required?: boolean;
  visible?: boolean;
  placeholder?: string;
  defaultValue?: string | string[];
}

/**
 * Editable text for the fixed "gyn4d" print design. Every value is optional;
 * missing or blank values fall back to the original Dr. Monira design so old
 * templates and pinned report snapshots keep printing exactly as before.
 */
export interface Gyn4dPrintSettings {
  pageTitle?: string;
  scanTitle?: string;
  headerText?: string;
  doctorName?: string;
  doctorRole?: string;
  doctorUniversity?: string;
  phone?: string;
  address?: string;
  rightAdnexum?: string;
  leftAdnexum?: string;
}

export interface ReportTemplateLayout {
  headerNote?: string;
  footerNote?: string;
  showMeasurements?: boolean;
  showSignature?: boolean;
  printLayout?: 'default' | 'gyn4d';
  gyn4d?: Gyn4dPrintSettings;
}

export interface TemplateSnapshot {
  id: string;
  name: string;
  description: string | null;
  fields: unknown;
  layout: unknown;
  version: string;
}

export function templateFieldsFromSnapshot(
  snapshot: TemplateSnapshot | null | undefined,
): ReportTemplateField[] | null {
  if (!snapshot || !Array.isArray(snapshot.fields)) return null;
  return snapshot.fields.filter(
    (field): field is ReportTemplateField =>
      Boolean(field) &&
      typeof field === 'object' &&
      typeof (field as Record<string, unknown>).key === 'string' &&
      typeof (field as Record<string, unknown>).label === 'string' &&
      typeof (field as Record<string, unknown>).type === 'string',
  );
}

export function templateLayoutFromSnapshot(
  snapshot: TemplateSnapshot | null | undefined,
): ReportTemplateLayout | null {
  if (!snapshot || !snapshot.layout || typeof snapshot.layout !== 'object') return null;
  return snapshot.layout as ReportTemplateLayout;
}
