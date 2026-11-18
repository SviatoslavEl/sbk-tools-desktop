import type { CommercialBlock, CommercialBody, CommercialSection } from './commercialDocument';
import type { PartySnapshot, ProposalData, ProposalIssue, ProposalTemplate } from './types';
import { getStarterDesign, type StarterDesignId } from './starterDesigns';
import { assertCustomForm, templateDate, templateText, type TemplateField } from './templateDefinition';

interface StarterFormDefinition {
  id: StarterDesignId;
  company: string;
  title: string;
  style: ProposalTemplate['style'];
  fields: readonly TemplateField[];
}

export interface StarterFormRow { id: string; cells: string[] }
export interface StarterFormValues {
  version: 1;
  id: string;
  values: Record<string, string | StarterFormRow[]>;
}

export const STARTER_CELL_LIMIT = 2000;
export const STARTER_TEXT_LIMIT = 6000;
export const STARTER_ROW_LIMIT = 24;

const companyFields: readonly TemplateField[] = [
  { id: 'request', label: 'Основание предложения', hint: 'Например, номер и дата запроса заказчика' },
  { id: 'scope', label: 'Состав предложения', hint: 'Опишите услуги, работы или поставку' },
  { id: 'specification', label: 'Детализация предложения', columns: ['Позиция или этап', 'Описание', 'Срок', 'Результат или комплектность'], maxRows: 120 },
];

export const STARTER_FORMS: readonly StarterFormDefinition[] = [
  { id: 'starter-company-sbk', company: 'Сайбер Бизнес Консалтинг', title: 'ООО «Сайбер Бизнес Консалтинг»', style: 'standard', fields: companyFields },
  { id: 'starter-company-fbk', company: 'ФБК Консалтинг', title: 'ООО «ФБК Консалтинг»', style: 'standard', fields: companyFields },
  { id: 'starter-company-teslatel', company: 'Теслател', title: 'ООО «Теслател»', style: 'compact', fields: companyFields },
  { id: 'starter-company-strive', company: 'Страйв', title: 'ООО «Страйв»', style: 'standard', fields: companyFields },
];

// These IDs still identify the fields and layout of drafts and saved proposals.
// Only company-level forms are offered when creating a new proposal.
const LEGACY_FORMS: readonly StarterFormDefinition[] = [
  {
    id: 'starter-sbk-assessment', company: 'Сайбер Бизнес Консалтинг',
    title: 'Оценка защиты информации', style: 'standard',
    fields: [
      { id: 'request', label: 'Основание предложения', hint: 'Номер и дата запроса или закупки' },
      { id: 'requirements', label: 'Периметр и требования к оценке', hint: 'Объекты оценки, стандарт или раздел ТЗ' },
      { id: 'scope', label: 'Объём оценки', columns: ['Объект оценки', 'Проверка', 'Результат'] },
      { id: 'confirmations', label: 'Подтверждения по форме заказчика', columns: ['Требование', 'Подтверждение или оговорка'] },
    ],
  },
  {
    id: 'starter-sbk-software', company: 'Сайбер Бизнес Консалтинг',
    title: 'Документация для регистрации ПО', style: 'standard',
    fields: [
      { id: 'software', label: 'Программа и её окружение', hint: 'Название, версия ПО и операционная система' },
      { id: 'documents', label: 'Комплект документации', columns: ['Блок', 'Документы и содержание', 'Результат'] },
      { id: 'stages', label: 'Этапы доработки', columns: ['Этап', 'Содержание', 'Результат'] },
      { id: 'inputs', label: 'Исходные материалы от заказчика' },
      { id: 'exclusions', label: 'Границы ответственности', hint: 'Какие документы и действия остаются за заказчиком' },
    ],
  },
  {
    id: 'starter-fbk-quality', company: 'ФБК Консалтинг',
    title: 'Независимая оценка качества данных', style: 'standard',
    fields: [
      { id: 'perimeter', label: 'Системы и процессы в периметре' },
      { id: 'method', label: 'Методика и источники данных' },
      { id: 'criteria', label: 'Характеристики качества данных', columns: ['Характеристика', 'Критерий и способ оценки'] },
      { id: 'results', label: 'Состав заключения и рекомендации' },
      { id: 'team', label: 'Команда и релевантный опыт', columns: ['Роль или проект', 'Компетенции или опыт'] },
    ],
  },
  {
    id: 'starter-fbk-consulting', company: 'ФБК Консалтинг',
    title: 'Поэтапный консалтинг и сопровождение', style: 'standard',
    fields: [
      { id: 'request', label: 'Ответ на запрос', hint: 'Входящий номер, дата и предмет запроса' },
      { id: 'stages', label: 'План оказания услуг', columns: ['Этап', 'Содержание', 'Срок и событие начала', 'Результат'] },
      { id: 'support', label: 'Консультационное сопровождение', hint: 'Период, объём консультаций, порядок обращений' },
      { id: 'acceptance', label: 'Порядок сдачи и приёмки' },
    ],
  },
  {
    id: 'starter-teslatel-firewall', company: 'Теслател',
    title: 'Межсетевые экраны, монтаж и настройка', style: 'compact',
    fields: [
      { id: 'request', label: 'Запрос ценовой информации', hint: 'Номер и дата запроса' },
      { id: 'specification', label: 'Техническая спецификация', columns: ['Оборудование', 'Модель или артикул', 'Комплектация'] },
      { id: 'installation', label: 'Установка', hint: 'Площадки, требования к монтажу и объём работ' },
      { id: 'setup', label: 'Настройка и ввод в эксплуатацию' },
      { id: 'warranty', label: 'Гарантия и обслуживание' },
    ],
  },
  {
    id: 'starter-teslatel-server', company: 'Теслател',
    title: 'Серверы и варианты комплектации', style: 'compact',
    fields: [
      { id: 'configurations', label: 'Варианты комплектации', columns: ['Вариант', 'Производитель и модель', 'Количество', 'Характеристики и отличия'] },
      { id: 'parts', label: 'Расшифровка комплектующих', columns: ['Вариант', 'Артикул', 'Наименование', 'Количество в комплекте'], maxRows: 120 },
      { id: 'availability', label: 'Наличие, состояние и документы оборудования' },
      { id: 'warranty', label: 'Гарантия и техническая поддержка' },
    ],
  },
  {
    id: 'starter-strive-development', company: 'Страйв',
    title: 'Разработка и внедрение сервиса', style: 'standard',
    fields: [
      { id: 'goals', label: 'Цели проекта и задачи сервиса' },
      { id: 'stages', label: 'Состав работ и этапы', columns: ['Этап', 'Работы', 'Срок', 'Результат'] },
      { id: 'inputs', label: 'Данные, доступы и участие заказчика' },
      { id: 'acceptance', label: 'Испытания, опытная эксплуатация и приёмка' },
      { id: 'warranty', label: 'Гарантия и сопровождение' },
    ],
  },
];

const companyKey = (value: string) => value.toLocaleLowerCase('ru-RU')
  .replace(/["«»„“”]/gu, '').trim().replace(/^ооо\s+/u, '').replace(/\s+/gu, ' ');

export function suggestedStarterForms(issuer: PartySnapshot) {
  const keys = [issuer.name, issuer.shortName].map(companyKey).map((name) => ({
    'сбк': 'сайбер бизнес консалтинг',
    'фбк': 'фбк консалтинг',
    'teslatel': 'теслател',
    'strive': 'страйв',
  }[name] || name));
  return STARTER_FORMS.filter(({ company }) => keys.includes(companyKey(company)));
}

export function getStarterForm(id?: string) {
  return STARTER_FORMS.find((entry) => entry.id === id) ?? LEGACY_FORMS.find((entry) => entry.id === id);
}

export function proposalFormDefinition(id: string, template?: ProposalTemplate) {
  if (template?.id === id && template.form) {
    return { id, title: template.name, company: template.form.company, fields: template.form.fields,
      pagination: template.form.layout.pagination };
  }
  const form = getStarterForm(id);
  return form && { ...form, pagination: getStarterDesign(form.id)?.pagination };
}

export const STARTER_APPEARANCES: readonly ProposalTemplate[] = STARTER_FORMS.map((form) => ({
  schemaVersion: 1, id: form.id, version: 1, name: form.title,
  style: form.style, accentColor: getStarterDesign(form.id)!.accent,
  show: { address: true, requisites: true, contact: true, signer: true },
  introduction: '', conclusion: '', footer: '',
}));

export function starterFormHasContent(form?: StarterFormValues) {
  return Object.values(form?.values ?? {}).some((value) => typeof value === 'string'
    ? Boolean(value.trim()) : value.some(({ cells }) => cells.some((cell) => cell.trim())));
}

const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));

export function assertStarterForm(value: unknown, template?: ProposalTemplate): asserts value is StarterFormValues {
  if (!object(value) || value.version !== 1 || typeof value.id !== 'string' || !object(value.values)) {
    throw new Error('Не удалось прочитать форму шаблона КП.');
  }
  if (template?.form) {
    if (template.id !== value.id) throw new Error('Форма не соответствует сохранённой редакции шаблона.');
    assertCustomForm(template.form);
  }
  const form = proposalFormDefinition(value.id, template);
  if (!form) throw new Error('Этот шаблон КП не поддерживается в текущей версии.');
  for (const [id, content] of Object.entries(value.values)) {
    const field = form.fields.find((entry) => entry.id === id);
    if (!field) throw new Error('Форма КП содержит неизвестное поле шаблона.');
    if (!field.columns && field.input !== 'fixed' && templateText(content, field.input === 'short' ? 500 : STARTER_TEXT_LIMIT)
      && (field.input !== 'date' || !content || templateDate(content))) continue;
    const columns = field.columns?.length;
    const ids = new Set<string>();
    if (field.columns && columns && Array.isArray(content) && content.length <= (field.maxRows ?? STARTER_ROW_LIMIT) && content.every((row: unknown) => {
      if (!object(row) || typeof row.id !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/u.test(row.id)
        || ids.has(row.id) || !Array.isArray(row.cells) || row.cells.length !== columns
        || !row.cells.every((cell: unknown) => templateText(cell, STARTER_CELL_LIMIT))) return false;
      ids.add(row.id);
      return true;
    })) continue;
    throw new Error(`Проверьте данные в разделе «${field.label}».`);
  }
}

export function starterFormIssues(value: StarterFormValues, template?: ProposalTemplate): ProposalIssue[] {
  try { assertStarterForm(value, template); }
  catch (reason) {
    return [{ field: 'starterForm', step: 3, severity: 'error', message: (reason as Error).message }];
  }
  const issues: ProposalIssue[] = [];
  for (const field of proposalFormDefinition(value.id, template)!.fields) {
    const content = value.values[field.id];
    if (!field.columns) {
      if (field.required && !(typeof content === 'string' ? content : field.defaultValue ?? '').trim()) {
        issues.push({ field: `starter-${field.id}`, step: 3, severity: 'error', message: `Заполните раздел «${field.label}».` });
      }
      continue;
    }
    const rows = Array.isArray(content) ? content : [];
    if (field.required && !rows.some(({ cells }) => cells.some((cell) => cell.trim()))) {
      issues.push({ field: `starter-${field.id}`, step: 3, severity: 'error', message: `Добавьте строку в раздел «${field.label}».` });
    }
    rows.forEach(({ cells }, index) => {
      if (cells[0].trim() || !cells.some((cell) => cell.trim())) return;
      issues.push({ field: `starter-${field.id}-${index}-0`, step: 3, severity: 'error',
        message: `«${field.label}», строка ${index + 1}. Заполните поле «${field.columns![0]}».` });
    });
  }
  return issues;
}

/** Render filled sections of the selected form in the client document. */
export function starterFormBody(data: ProposalData): CommercialBody {
  const sections: CommercialSection[] = [];
  const add = (id: string, title: string, block: Omit<Extract<CommercialBlock, { kind: 'paragraph' }>, 'id'>
    | Omit<Extract<CommercialBlock, { kind: 'table' }>, 'id'>) => {
    sections.push({ id: `s-${id}`, kind: 'other', title, blocks: [{ id: `b-${id}`, ...block }] });
  };
  const paragraph = (id: string, title: string, value: string) => {
    if (value.trim()) add(id, title, { kind: 'paragraph', style: 'body', content: [{ kind: 'text', text: value.trim() }] });
  };
  const form = data.starterForm;
  if (!form) return { version: 1, sections };
  assertStarterForm(form, data.template);
  const definition = proposalFormDefinition(form.id, data.template)!;
  const appendices = definition.pagination === 'appendices';
  let appendix = 0;
  for (const field of definition.fields) {
    const value = form.values[field.id];
    if (!field.columns) paragraph(field.id, field.label, typeof value === 'string' ? value : field.defaultValue ?? '');
    else {
      const title = appendices ? `Приложение ${++appendix}. ${field.label}` : field.label;
      const entries = Array.isArray(value) ? value : [];
      const rows = entries.filter(({ cells }) => cells.some((cell) => cell.trim()));
      if (rows.length) add(field.id, title, { kind: 'table', columns: [...field.columns],
        rows: rows.map(({ cells }) => cells.map((text) => text.trim() ? [{ kind: 'text', text: text.trim() }] : [])) });
    }
  }
  paragraph('delivery', 'Сроки работ и поставки', data.deliveryTerms);
  paragraph('payment', 'Условия оплаты', data.paymentTerms);
  paragraph('conclusion', 'Заключение', data.conclusion);
  return { version: 1, sections };
}
