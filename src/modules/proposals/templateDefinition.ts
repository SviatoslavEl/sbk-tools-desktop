import { getStarterDesign, type StarterDesignId } from './starterDesigns';

export type TemplateField = {
  id: string; label: string; required?: boolean;
} & (
  { columns?: undefined; input?: 'text' | 'short' | 'date' | 'fixed'; hint?: string; defaultValue?: string }
  | { columns: readonly string[]; maxRows?: number }
);

export interface ProposalTemplateLayout {
  base?: StarterDesignId;
  paper: 'portrait' | 'landscape';
  titleAlign: 'left' | 'center';
  pricing: 'accent' | 'gray' | 'outlined' | 'plain';
  pagination: 'continuous' | 'specification' | 'appendices' | 'slides';
  heading: string;
  fontSize: number;
  brand: boolean; cover: boolean; footerArt: boolean; pageNumbers: boolean;
}

export interface CustomProposalForm {
  version: 1;
  company: string;
  companyId?: string;
  fields: TemplateField[];
  layout: ProposalTemplateLayout;
}

export const TEMPLATE_FIELD_LIMIT = 32;
export const TEMPLATE_COLUMN_LIMIT = 8;
export const TEMPLATE_ROW_LIMIT = 120;
export const TEMPLATE_LABEL_LIMIT = 120;

export const defaultTemplateLayout = (base?: StarterDesignId): ProposalTemplateLayout => {
  const design = getStarterDesign(base);
  return {
    ...(base && { base }), paper: design?.paper === 'landscape' ? 'landscape' : 'portrait',
    titleAlign: design?.titleAlign === 'center' ? 'center' : 'left',
    pricing: design?.pricing === 'gray' || design?.pricing === 'outlined' || design?.pricing === 'plain' ? design.pricing : 'accent',
    pagination: design?.pagination === 'appendices' || design?.pagination === 'specification' || design?.pagination === 'slides' ? design.pagination : 'continuous',
    heading: 'Коммерческое предложение', fontSize: 11, brand: Boolean(design?.logo),
    cover: Boolean(design?.cover), footerArt: Boolean(design?.footer), pageNumbers: true,
  };
};

export function templateText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && Array.from(value).length <= maximum
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\uD800-\uDFFF]/u.test(value);
}

export function templateDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value) || value.startsWith('0000')) return false;
  try { return new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value; }
  catch { return false; }
}

export function assertCustomForm(form: CustomProposalForm): void {
  if (form?.version !== 1 || !templateText(form.company, 240)
    || (form.companyId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/u.test(form.companyId))
    || !Array.isArray(form.fields) || form.fields.length > TEMPLATE_FIELD_LIMIT) {
    throw new Error('Некорректная структура шаблона КП.');
  }
  const layout = form.layout;
  if (!layout || (layout.base !== undefined && !getStarterDesign(layout.base))
    || !['portrait', 'landscape'].includes(layout.paper) || !['left', 'center'].includes(layout.titleAlign)
    || !['accent', 'gray', 'outlined', 'plain'].includes(layout.pricing)
    || !['continuous', 'specification', 'appendices', 'slides'].includes(layout.pagination)
    || !templateText(layout.heading, TEMPLATE_LABEL_LIMIT) || !layout.heading.trim()
    || !Number.isInteger(layout.fontSize) || layout.fontSize < 9 || layout.fontSize > 14
    || [layout.brand, layout.cover, layout.footerArt, layout.pageNumbers].some((value) => typeof value !== 'boolean')) {
    throw new Error('Проверьте заголовок и параметры оформления шаблона.');
  }
  const ids = new Set<string>();
  for (const field of form.fields) {
    if (!field || !/^f-[a-z0-9-]{1,50}$/u.test(field.id) || ids.has(field.id)
      || !templateText(field.label, TEMPLATE_LABEL_LIMIT) || !field.label.trim()
      || (field.required !== undefined && typeof field.required !== 'boolean')) {
      throw new Error('У каждого раздела должно быть название.');
    }
    ids.add(field.id);
    if (field.columns !== undefined) {
      if (!Array.isArray(field.columns) || field.columns.length < 1 || field.columns.length > TEMPLATE_COLUMN_LIMIT
        || !field.columns.every((column) => templateText(column, TEMPLATE_LABEL_LIMIT) && column.trim())
        || new Set(field.columns.map((column) => column.trim().toLocaleLowerCase('ru-RU'))).size !== field.columns.length
        || (field.maxRows !== undefined && (!Number.isInteger(field.maxRows) || field.maxRows < 1 || field.maxRows > TEMPLATE_ROW_LIMIT))) {
        throw new Error(`Проверьте названия столбцов и лимит строк в разделе «${field.label}».`);
      }
    } else if ((field.input !== undefined && !['text', 'short', 'date', 'fixed'].includes(field.input))
      || (field.hint !== undefined && !templateText(field.hint, 240))
      || (field.defaultValue !== undefined && !templateText(field.defaultValue, field.input === 'short' ? 500 : 6000))
      || (field.input === 'fixed' && !field.defaultValue?.trim())
      || (field.input === 'date' && field.defaultValue && !templateDate(field.defaultValue))) {
      throw new Error(`Проверьте текст или значение по умолчанию в разделе «${field.label}».`);
    }
  }
}
