import { z } from 'zod';
import type { TemplateDefinition } from './blocks.types.js';

/**
 * Zod schema for TemplateDefinition. Every object is .strict(): an unknown or
 * misspelled property is a validation error instead of being silently dropped.
 * Cross-field rules (unique keys, token/field consistency, table geometry) live
 * in blocks.validate.ts and must run after this schema.
 */

const key = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,59}$/, 'Keys start with a letter and use letters, digits and underscores (max 60).');
const shortText = z.string().max(300);
const template = z.string().max(2_000);

const fieldDef = z
  .object({
    default: z.string().max(2_000).optional(),
    placeholder: z.string().max(200).optional(),
    options: z.array(z.string().min(1).max(80)).min(1).max(30).optional(),
  })
  .strict();
const fieldMap = z.record(key, fieldDef);

const infoRow = z
  .object({
    label: z.string().min(1).max(120),
    source: z.enum(['patient.name', 'patient.dob', 'visit.date']).optional(),
    key: key.optional(),
    default: z.string().max(2_000).optional(),
    placeholder: z.string().max(200).optional(),
    boxed: z.boolean().optional(),
    bold: z.boolean().optional(),
  })
  .strict();

const listStyle = z.enum(['bullet', 'circle', 'number', 'dash', 'none']);

const leafItem = z
  .object({
    label: shortText.optional(),
    template,
    fields: fieldMap.optional(),
    bold: z.boolean().optional(),
    underline: z.boolean().optional(),
    subtitle: shortText.optional(),
  })
  .strict();
const listItem = leafItem
  .extend({ children: z.array(leafItem).max(50).optional() })
  .strict();

const tableCell = z
  .object({
    template,
    fields: fieldMap.optional(),
    colSpan: z.number().int().min(1).max(12).optional(),
    rowSpan: z.number().int().min(1).max(100).optional(),
    align: z.enum(['left', 'center', 'right']).optional(),
    bold: z.boolean().optional(),
    accent: z.boolean().optional(),
    underline: z.boolean().optional(),
    rightRule: z.boolean().optional(),
  })
  .strict();

const textBlock = z
  .object({
    type: z.literal('text'),
    template,
    fields: fieldMap.optional(),
    style: z.enum(['body', 'bold', 'blueItalic']).optional(),
  })
  .strict();

const listBlock = z
  .object({
    type: z.literal('list'),
    style: listStyle.optional(),
    childStyle: listStyle.optional(),
    small: z.boolean().optional(),
    bold: z.boolean().optional(),
    items: z.array(listItem).min(1).max(100),
  })
  .strict();

const freeListBlock = z
  .object({
    type: z.literal('freeList'),
    key,
    style: listStyle.optional(),
    small: z.boolean().optional(),
    bold: z.boolean().optional(),
    default: z.array(z.string().max(2_000)).max(50).optional(),
    placeholder: z.string().max(200).optional(),
  })
  .strict();

const gridTableBlock = z
  .object({
    type: z.literal('gridTable'),
    title: shortText.optional(),
    widths: z.array(z.number().positive().max(1000)).min(1).max(12),
    border: z.enum(['none', 'all', 'lines']).optional(),
    headerRows: z.number().int().min(0).max(5).optional(),
    rows: z
      .array(
        z
          .object({
            cells: z.array(tableCell).min(1).max(12),
            rule: z.enum(['top', 'bottom', 'both']).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();

const checklistBlock = z
  .object({
    type: z.literal('checklistTable'),
    key,
    legend: z.array(z.string().max(120)).max(6).optional(),
    columns: z
      .array(z.object({ key, label: z.string().max(60), default: z.string().max(200).optional() }).strict())
      .min(1)
      .max(6),
    rows: z
      .array(
        z
          .object({
            key,
            label: z.string().min(1).max(200),
            depth: z.union([z.literal(0), z.literal(1)]),
            values: z.boolean(),
            defaults: z.record(key, z.string().max(200)).optional(),
            placeholders: z.record(key, z.string().max(100)).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(150),
    subMarker: z.enum(['number', 'dash']).optional(),
    labelWidth: z.number().min(20).max(80).optional(),
  })
  .strict();

const leafBlock = z.discriminatedUnion('type', [textBlock, listBlock, freeListBlock, gridTableBlock, checklistBlock]);

const sectionBlock = z
  .object({
    type: z.literal('section'),
    title: z.string().min(1).max(200),
    color: z.enum(['accent', 'blue']).optional(),
    children: z.array(leafBlock).max(50),
  })
  .strict();

const infoTableBlock = z.object({ type: z.literal('infoTable'), rows: z.array(infoRow).min(1).max(30) }).strict();
const titleBlock = z
  .object({
    type: z.literal('title'),
    text: z.string().min(1).max(200),
    boldPrefix: z.string().max(60).optional(),
    suffix: z.string().max(60).optional(),
  })
  .strict();
const signatureBlock = z.object({ type: z.literal('signature') }).strict();

export const templateDefinitionSchema = z
  .object({
    schemaVersion: z.literal(1),
    baseSize: z.number().min(8).max(18).optional(),
    blocks: z
      .array(
        z.discriminatedUnion('type', [
          infoTableBlock,
          titleBlock,
          sectionBlock,
          textBlock,
          listBlock,
          freeListBlock,
          gridTableBlock,
          checklistBlock,
          signatureBlock,
        ]),
      )
      .min(1)
      .max(200),
  })
  .strict();

/** Compile time guard: the schema output must stay assignable to the public type. */
type _Check = z.infer<typeof templateDefinitionSchema> extends TemplateDefinition ? true : never;
export const _schemaMatchesTypes: _Check = true;
