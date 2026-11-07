/**
 * Report block system: types (pure TypeScript, no runtime dependencies).
 * This file is copied verbatim to the frontend. Keep it dependency free.
 *
 * A template is a TemplateDefinition: an ordered list of blocks.
 * Editable values are bound to string keys through {{key}} tokens inside
 * templates, or through an explicit `key` on a block. Every key is unique in a
 * template and is also the key used in Report.currentContent.
 *
 * Inline markup inside any `template` string:
 *   {{key}}   editable inline field (configured in the sibling `fields` map)
 *   **...**   toggles bold (may wrap {{key}} tokens)
 */

export const SCHEMA_VERSION = 1 as const;

export interface FieldDef {
  default?: string;
  placeholder?: string;
  /** When present the field is a dropdown in edit mode (value is still plain text). */
  options?: string[];
}
export type FieldMap = Record<string, FieldDef>;

/** Values the system fills in automatically (never typed by the doctor). */
export type SystemSource = 'patient.name' | 'patient.dob' | 'visit.date';

export interface InfoRow {
  label: string;
  /** Exactly one of `source` or `key`. */
  source?: SystemSource;
  key?: string;
  default?: string;
  placeholder?: string;
  /** Rendered as a full-width bordered box instead of a table row. */
  boxed?: boolean;
  bold?: boolean;
}
export interface InfoTableBlock {
  type: 'infoTable';
  rows: InfoRow[];
}

export interface TitleBlock {
  type: 'title';
  text: string;
  boldPrefix?: string;
  /** Smaller text appended after `text` (e.g. "SCAN"). */
  suffix?: string;
}

export type TextStyle = 'body' | 'bold' | 'blueItalic';
export interface TextBlock {
  type: 'text';
  template: string;
  fields?: FieldMap;
  style?: TextStyle;
}

export type ListStyle = 'bullet' | 'circle' | 'number' | 'dash' | 'none';
export interface ListItem {
  /** Static prefix, rendered bold + underlined. Put the separator in `template` (e.g. " : ..."). */
  label?: string;
  template: string;
  fields?: FieldMap;
  bold?: boolean;
  underline?: boolean;
  /** Static blue italic line under the item text, before its children. */
  subtitle?: string;
  children?: ListItem[];
}
export interface ListBlock {
  type: 'list';
  style?: ListStyle;
  childStyle?: ListStyle;
  small?: boolean;
  bold?: boolean;
  items: ListItem[];
}

/** A list whose lines are fully typed by the doctor (conclusion, comment). Value: string[]. */
export interface FreeListBlock {
  type: 'freeList';
  key: string;
  style?: ListStyle;
  small?: boolean;
  bold?: boolean;
  default?: string[];
  placeholder?: string;
}

export interface TableCell {
  template: string;
  fields?: FieldMap;
  colSpan?: number;
  rowSpan?: number;
  align?: 'left' | 'center' | 'right';
  bold?: boolean;
  /** Accent (pink) colour. */
  accent?: boolean;
  underline?: boolean;
  /** Vertical rule on the right edge of this cell. */
  rightRule?: boolean;
}
export interface TableRow {
  cells: TableCell[];
  rule?: 'top' | 'bottom' | 'both';
}
export type TableBorder = 'none' | 'all' | 'lines';
export interface GridTableBlock {
  type: 'gridTable';
  /** Heading above the table (bold, underlined). */
  title?: string;
  /** Relative column widths. Their count is the number of columns. */
  widths: number[];
  border?: TableBorder;
  /** The first N rows are header rows (accent colour, centred). */
  headerRows?: number;
  rows: TableRow[];
}

export interface ChecklistColumn {
  key: string;
  label: string;
  default?: string;
}
export interface ChecklistRow {
  key: string;
  label: string;
  /** 0 = bulleted row (group or single item), 1 = sub item (numbered or dashed). */
  depth: 0 | 1;
  /** Whether this row has editable value cells. */
  values: boolean;
  /** Per column default overriding the column default. */
  defaults?: Record<string, string>;
  /** Per column placeholder (printed empty). */
  placeholders?: Record<string, string>;
}
/** Anatomy style table. Value: Record<"rowKey.columnKey", string>. */
export interface ChecklistBlock {
  type: 'checklistTable';
  key: string;
  legend?: string[];
  columns: ChecklistColumn[];
  rows: ChecklistRow[];
  subMarker?: 'number' | 'dash';
  /** Percentage width of the label column (default 50). */
  labelWidth?: number;
}

/** Fixed doctor signature block (text lives in letterhead.ts). */
export interface SignatureBlock {
  type: 'signature';
}

export type LeafBlock = TextBlock | ListBlock | FreeListBlock | GridTableBlock | ChecklistBlock;

export interface SectionBlock {
  type: 'section';
  title: string;
  color?: 'accent' | 'blue';
  children: LeafBlock[];
}

export type Block = InfoTableBlock | TitleBlock | SectionBlock | LeafBlock | SignatureBlock;

export interface TemplateDefinition {
  schemaVersion: typeof SCHEMA_VERSION;
  /** Base font size in points (default 12). Everything else scales from it. */
  baseSize?: number;
  blocks: Block[];
}

export type DerivedFieldType = 'text' | 'select' | 'list' | 'checklist';
export interface DerivedField {
  key: string;
  label: string;
  type: DerivedFieldType;
  defaultValue?: string | string[] | Record<string, string>;
  options?: string[];
}
