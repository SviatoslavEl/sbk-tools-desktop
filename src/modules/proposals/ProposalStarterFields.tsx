import {
  proposalFormDefinition, STARTER_CELL_LIMIT, STARTER_FORMS, STARTER_ROW_LIMIT, STARTER_TEXT_LIMIT,
  starterFormHasContent, suggestedStarterForms, type StarterFormRow, type StarterFormValues,
} from './starterForms';
import type { PartySnapshot, ProposalTemplate } from './types';

export function ProposalStarterPicker({ issuer, value, template, customTemplates = [], disabled, onChange }: {
  issuer: PartySnapshot;
  value?: StarterFormValues;
  template?: ProposalTemplate;
  customTemplates?: readonly ProposalTemplate[];
  disabled: boolean;
  onChange: (id: string) => void;
}) {
  const suggested = suggestedStarterForms(issuer);
  const others = STARTER_FORMS.filter((form) => !suggested.includes(form));
  const locked = starterFormHasContent(value);
  const savedForm = value && ![...STARTER_FORMS, ...customTemplates].some((form) => form.id === value.id)
    ? proposalFormDefinition(value.id, template) : undefined;
  const options = (forms: typeof STARTER_FORMS) => forms.map((form) => (
    <option key={form.id} value={form.id}>{form.title}</option>
  ));
  return <div className="proposal-starter-picker">
    <label>Шаблон КП
      <select value={value?.id ?? ''} onChange={(event) => onChange(event.target.value)} disabled={disabled || locked}>
        <option value="">Без фирменного бланка</option>
        {savedForm && <option value={savedForm.id} disabled>Бланк из черновика · {savedForm.title}</option>}
        {suggested.length > 0 && <optgroup label="Для выбранного исполнителя">{options(suggested)}</optgroup>}
        <optgroup label={suggested.length ? 'Другие юрлица' : 'Фирменные бланки'}>{options(others)}</optgroup>
        {!!customTemplates.length && <optgroup label="Пользовательские шаблоны">{customTemplates.map((item) =>
          <option key={item.id} value={item.id}>{item.name}{item.form?.company ? ` · ${item.form.company}` : ''}</option>
        )}</optgroup>}
      </select>
    </label>
    <p className="help-text">{locked
      ? 'В документе заполнены поля шаблона. Чтобы сменить шаблон, сначала очистите эти поля.'
      : value ? 'Заполните поля прямо в документе ниже.'
        : 'Выберите исполнителя из справочника или введите его название, чтобы увидеть подходящие шаблоны.'}</p>
  </div>;
}

export function ProposalStarterFields({ value, template, disabled, onChange }: {
  value: StarterFormValues;
  template?: ProposalTemplate;
  disabled: boolean;
  onChange: (value: StarterFormValues) => void;
}) {
  const form = proposalFormDefinition(value.id, template);
  if (!form) return null;
  function update(id: string, next: string | StarterFormRow[]) {
    if (!disabled) onChange({ ...value, values: { ...value.values, [id]: next } });
  }
  return <section className="proposal-starter-fields" aria-label={form.title}>
    {form.fields.map((field, fieldIndex) => {
      const content = value.values[field.id];
      if (!field.columns) {
        if (field.input === 'fixed') return <section className="proposal-document-block proposal-template-fixed" key={field.id}>
          <h3>{field.label}</h3><p>{field.defaultValue}</p>
        </section>;
        const props = { id: `proposal-starter-${field.id}`, placeholder: field.hint ?? 'Введите текст',
          disabled, value: typeof content === 'string' ? content : field.defaultValue ?? '', 'aria-required': field.required };
        return <label className="proposal-document-field" key={field.id}>
          <span>{field.label}{field.required ? ' *' : ''}</span>
          {field.input === 'short' || field.input === 'date'
            ? <input {...props} type={field.input === 'date' ? 'date' : 'text'} maxLength={500} onChange={(event) => update(field.id, event.target.value)} />
            : <textarea {...props} rows={2} maxLength={STARTER_TEXT_LIMIT} onChange={(event) => update(field.id, event.target.value)} />}
        </label>;
      }
      const rows = Array.isArray(content) ? content : [];
      const columns = field.columns;
      const appendix = form.pagination === 'appendices' ? form.fields.slice(0, fieldIndex + 1).filter(entry => entry.columns).length : 0;
      return <section className="proposal-document-block" key={field.id} id={`proposal-starter-${field.id}`} tabIndex={-1} aria-label={field.label}>
        {appendix > 0 && <small className="proposal-template-appendix">Приложение {appendix}</small>}
        <h3>{field.label}{field.required ? ' *' : ''}</h3>
        <div className="proposal-document-table-scroll">
          <table className="proposal-document-table">
            <thead><tr>{columns.map(label => <th scope="col" key={label}>{label}</th>)}{!disabled && <th scope="col" className="proposal-document-row-actions"><span className="proposal-sr-only">Действия</span></th>}</tr></thead>
            <tbody>{rows.map((row, index) => <tr key={row.id}>
              {columns.map((label, column) => <td key={label}>
                <textarea id={`proposal-starter-${field.id}-${index}-${column}`} rows={2} maxLength={STARTER_CELL_LIMIT}
                  aria-label={`${field.label}, строка ${index + 1}, ${label}`} placeholder={label} disabled={disabled}
                  value={row.cells[column]}
                  onChange={(event) => {
                    const text = event.target.value;
                    update(field.id, rows.map((entry) => entry.id === row.id
                      ? { ...entry, cells: entry.cells.map((cell, pos) => pos === column ? text : cell) } : entry));
                  }} />
              </td>)}
              {!disabled && <td><button type="button" className="proposal-document-remove" aria-label={`Убрать строку ${index + 1} из раздела «${field.label}»`}
                onClick={() => update(field.id, rows.filter((entry) => entry.id !== row.id))}>×</button></td>}
            </tr>)}</tbody>
          </table>
        </div>
        {!disabled && <button className="secondary small" type="button" disabled={rows.length >= (field.maxRows ?? STARTER_ROW_LIMIT)}
          aria-label={`Добавить строку в раздел «${field.label}»`}
          onClick={(event) => {
            const section = event.currentTarget.closest('.proposal-document-block');
            update(field.id, [...rows, { id: crypto.randomUUID(), cells: columns.map(() => '') }]);
            requestAnimationFrame(() => section?.querySelector<HTMLElement>(`#proposal-starter-${field.id}-${rows.length}-0`)?.focus());
          }}>
          + Строка
        </button>}
      </section>;
    })}
  </section>;
}
