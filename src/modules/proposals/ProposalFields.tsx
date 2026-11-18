import type { CompanyCard } from '../contracts/companies';
import { createProposalLine } from './defaults';
import { formatMoneyMinor, MAX_PROPOSAL_LINES, priceProposalLine } from './pricing';
import { VAT_RATES, type PartySnapshot, type ProposalContact, type ProposalLine } from './types';

interface PartyProps {
  label: string;
  value: PartySnapshot;
  onChange: (value: PartySnapshot) => void;
  disabled?: boolean;
  companies: CompanyCard[];
  scope: 'internal' | 'external';
  documentForm?: boolean;
  nameOnCover?: boolean;
}

const partyFields = [
  ['name', 'Полное наименование'], ['shortName', 'Краткое наименование'],
  ['inn', 'ИНН'], ['kpp', 'КПП'], ['ogrn', 'ОГРН / ОГРНИП'],
] as const;

export function ProposalPartyFields({ label, value, onChange, disabled = false, companies, scope, documentForm = false, nameOnCover = false }: PartyProps) {
  const fieldPrefix = scope === 'internal' ? 'issuer' : 'recipient';
  const available = companies.filter((company) => !company.archived);
  const savedCompany = companies.find((company) => company.id === value.companyId);
  const groups: Array<CompanyCard['scope']> = scope === 'internal' ? ['internal', 'external'] : ['external', 'internal'];
  const update = (field: keyof PartySnapshot, next: string) => { if (!disabled) onChange({ ...value, [field]: next }); };
  const chooseCompany = (id: string) => {
    if (disabled) return;
    if (!id) {
      const { companyId: _companyId, sourceUpdatedAt: _sourceUpdatedAt, ...manual } = value;
      onChange(manual);
      return;
    }
    const company = available.find((candidate) => candidate.id === id);
    if (!company) return;
    // Explicit public snapshot: no internal notes, decisions, authorisations or files.
    onChange({
      companyId: company.id, sourceUpdatedAt: company.updatedAt,
      name: company.name, shortName: company.shortName, inn: company.inn,
      kpp: company.kpp, ogrn: company.ogrn, address: company.address,
      contact: company.contact, paymentDetails: value.companyId === company.id ? value.paymentDetails : '',
    });
  };
  const companyField = ([field, title]: typeof partyFields[number]) => <label key={field} className={field === 'name' ? 'proposal-wide' : undefined}>{title}
    <input id={`proposal-${fieldPrefix}.${field}`} type="text" aria-label={`${label}: ${title}`} value={value[field]} onChange={(event) => update(field, event.target.value)} inputMode={['inn', 'kpp', 'ogrn'].includes(field) ? 'numeric' : undefined} />
  </label>;
  const details = <div className="proposal-fields-grid">
    {(documentForm ? partyFields.slice(1) : partyFields).map(companyField)}
    <label className="proposal-wide">Адрес<textarea id={`proposal-${fieldPrefix}.address`} aria-label={`${label}: Адрес`} rows={2} value={value.address} onChange={(event) => update('address', event.target.value)} /></label>
    <label className="proposal-wide">Контакты компании<textarea id={`proposal-${fieldPrefix}.contact`} aria-label={`${label}: Контакты компании`} rows={2} value={value.contact} onChange={(event) => update('contact', event.target.value)} /></label>
    <label className="proposal-wide">Платёжные реквизиты<textarea id={`proposal-${fieldPrefix}.paymentDetails`} aria-label={`${label}: Платёжные реквизиты`} rows={3} value={value.paymentDetails} onChange={(event) => update('paymentDetails', event.target.value)} /></label>
  </div>;
  return <fieldset className="proposal-party-fields" disabled={disabled}>
    <legend>{label}</legend>
    <label className="proposal-wide">Компания из справочника
      <select aria-label={`${label}: компания из справочника`} value={value.companyId || ''} onChange={(event) => chooseCompany(event.target.value)}>
        <option value="">Ввести вручную</option>
        {value.companyId && !available.some((company) => company.id === value.companyId) && <option value={value.companyId}>{value.name || savedCompany?.name || 'Сохранённая компания'} {savedCompany?.archived ? '(в архиве — сохранённый снимок)' : '(сохранённый снимок)'}</option>}
        {groups.map((group) => <optgroup key={group} label={group === 'internal' ? 'Внутренние компании' : 'Внешние контрагенты'}>
          {available.filter((company) => company.scope === group).map((company) => <option key={company.id} value={company.id}>{company.name}{company.inn ? ` · ИНН ${company.inn}` : ''}</option>)}
        </optgroup>)}
      </select>
    </label>
    {documentForm ? <>{!nameOnCover && companyField(partyFields[0])}<details className="proposal-document-party-details"><summary>Реквизиты и контакты</summary>{details}</details></> : <>
      <p className="proposal-field-help">Выбор копирует реквизиты в это КП. Изменения здесь не меняют справочник; последующие изменения справочника не заменяют сохранённый снимок автоматически.</p>
      {details}
    </>}
  </fieldset>;
}

export function ProposalContactFields({ label, value, onChange, disabled = false }: {
  label: string; value: ProposalContact; onChange: (value: ProposalContact) => void; disabled?: boolean;
}) {
  const fields = [['fullName', 'ФИО', 'text'], ['position', 'Должность', 'text'], ['phone', 'Телефон', 'tel'], ['email', 'Электронная почта', 'email']] as const;
  const prefix = label === 'Подписант КП' ? 'signer' : label === 'Адресат' ? 'addressee' : label === 'Контакт исполнителя' ? 'contact' : null;
  return <fieldset className="proposal-contact-fields" disabled={disabled}>
    <legend>{label}</legend>
    <div className="proposal-fields-grid">{fields.map(([field, title, type]) => <label key={field}>{title}
      <input id={prefix ? `proposal-${prefix}.${field}` : undefined} type={type} aria-label={`${label}: ${title}`} value={value[field]} onChange={(event) => { if (!disabled) onChange({ ...value, [field]: event.target.value }); }} />
    </label>)}</div>
  </fieldset>;
}

export function ProposalLinesEditor({ lines, onChange, disabled = false, scopeInDocument = false, documentForm = false }: {
  lines: ProposalLine[]; onChange: (lines: ProposalLine[]) => void; disabled?: boolean; scopeInDocument?: boolean; documentForm?: boolean;
}) {
  const update = (index: number, patch: Partial<ProposalLine>) => { if (!disabled && !(scopeInDocument && 'description' in patch)) onChange(lines.map((line, position) => position === index ? { ...line, ...patch } : line)); };
  const move = (index: number, offset: -1 | 1) => {
    const target = index + offset;
    if (disabled || target < 0 || target >= lines.length) return;
    const next = [...lines]; [next[index], next[target]] = [next[target], next[index]]; onChange(next);
  };
  const copy = (index: number) => {
    if (disabled || lines.length >= MAX_PROPOSAL_LINES) return;
    const source = lines[index];
    onChange([...lines.slice(0, index + 1), { ...source, id: crypto.randomUUID(), tax: { ...source.tax } }, ...lines.slice(index + 1)]);
  };
  const renderedLines = lines.map((line, index) => {
    const prefix = `Позиция ${index + 1}`;
    const controls = {
      title: <label className="proposal-wide">Наименование<input id={`proposal-lines.title-${line.id}`} type="text" aria-label={`${prefix}: Наименование`} value={line.title} onChange={(event) => update(index, { title: event.target.value })} /></label>,
      description: scopeInDocument ? <p className="proposal-wide help-text">Состав услуг редактируется в документе по разделам. В ценовой таблице будет короткая ссылка на него; исходный снимок описания не перезаписывается.</p> : <label className="proposal-wide">Описание<textarea id={`proposal-lines.description-${line.id}`} rows={2} aria-label={`${prefix}: Описание`} value={line.description} onChange={(event) => update(index, { description: event.target.value })} /></label>,
      unit: <label>Единица измерения<input id={`proposal-lines.unit-${line.id}`} type="text" aria-label={`${prefix}: Единица измерения`} value={line.unit} onChange={(event) => update(index, { unit: event.target.value })} /></label>,
      quantity: <label>Количество<input id={`proposal-lines.quantity-${line.id}`} type="text" inputMode="decimal" aria-label={`${prefix}: Количество`} value={line.quantity} onChange={(event) => update(index, { quantity: event.target.value })} /></label>,
      price: <label>Цена за единицу, ₽<input id={`proposal-lines.unitPrice-${line.id}`} type="text" inputMode="decimal" aria-label={`${prefix}: Цена за единицу, ₽`} value={line.unitPrice} onChange={(event) => update(index, { unitPrice: event.target.value })} /></label>,
      discount: <label>Скидка, %<input id={`proposal-lines.discountPercent-${line.id}`} type="text" inputMode="decimal" aria-label={`${prefix}: Скидка, %`} value={line.discountPercent} onChange={(event) => update(index, { discountPercent: event.target.value })} /></label>,
      tax: <label>НДС<select id={`proposal-lines.tax-${line.id}`} aria-label={`${prefix}: НДС`} value={line.tax.kind === 'none' ? 'none' : String(line.tax.rate)} onChange={(event) => {
const rate = VAT_RATES.find((candidate) => String(candidate) === event.target.value);
if (event.target.value === 'none') update(index, { tax: { kind: 'none' } });
else if (rate !== undefined) update(index, { tax: { kind: 'vat', rate } });
}}><option value="none">Без НДС</option>{VAT_RATES.map((rate) => <option key={rate} value={String(rate)}>НДС {rate}%</option>)}</select></label>,
      basis: <label>Ввод цены<select id={`proposal-lines.priceBasis-${line.id}`} aria-label={`${prefix}: Ввод цены`} value={line.priceBasis} onChange={(event) => { if (event.target.value === 'gross' || event.target.value === 'net') update(index, { priceBasis: event.target.value }); }}><option value="gross">Цена включает НДС</option><option value="net">НДС начисляется сверху</option></select></label>,
    };
    const actions = <div className="proposal-line-actions">
      <button type="button" className="secondary small" aria-label={`Переместить вверх: ${prefix}`} disabled={disabled || index === 0} onClick={() => move(index, -1)}>{documentForm ? '↑' : '↑ Вверх'}</button>
      <button type="button" className="secondary small" aria-label={`Переместить вниз: ${prefix}`} disabled={disabled || index === lines.length - 1} onClick={() => move(index, 1)}>{documentForm ? '↓' : '↓ Вниз'}</button>
      <button type="button" className="secondary small" aria-label={`Копировать: ${prefix}`} disabled={disabled || lines.length >= MAX_PROPOSAL_LINES} onClick={() => copy(index)}>Копия</button>
      <button type="button" className="danger-button small" aria-label={`Удалить: ${prefix}`} onClick={() => { if (!disabled) onChange(lines.filter((_, position) => position !== index)); }}>Удалить</button>
    </div>;
    if (documentForm) {
      let amount = '—';
      try { amount = formatMoneyMinor(priceProposalLine(line).grossMinor); } catch { /* Partial input. */ }
      return <tr key={line.id} aria-label={prefix}>
        <td>{index + 1}</td>
        <td>{controls.title}{controls.description}{!disabled && actions}</td>
        <td>{controls.quantity}{controls.unit}</td>
        <td>{controls.price}{controls.tax}{controls.basis}{controls.discount}</td>
        <td className="proposal-document-line-total">{amount}</td>
      </tr>;
    }
    return <section className="proposal-line-card" key={line.id} aria-label={prefix}>
      <header className="proposal-line-header"><strong>{prefix}</strong>{actions}</header>
      <div className="proposal-fields-grid proposal-line-grid">
        {controls.title}{controls.description}{controls.unit}{controls.quantity}{controls.price}{controls.discount}{controls.tax}{controls.basis}
      </div>
    </section>;
  });
  return <fieldset className={documentForm ? 'proposal-document-block proposal-document-prices' : 'proposal-lines-editor'} disabled={disabled}>
    <legend>Позиции предложения</legend>
    {!documentForm && <p className="proposal-field-help">Введите цену за единицу и выберите, включает ли она НДС. «Без НДС» и «НДС 0%» — разные варианты. Допускается десятичная запятая или точка.</p>}
    {!lines.length && <p className="proposal-empty-lines">Позиции пока не добавлены.</p>}
    {documentForm ? <div className="proposal-document-table-scroll">
      <table className="proposal-document-table">
        <thead><tr>{['№', 'Наименование и описание', 'Количество', 'Цена и НДС', 'Сумма с НДС'].map(title => <th key={title} scope="col">{title}</th>)}</tr></thead>
        <tbody>{renderedLines}</tbody>
      </table>
    </div> : <div className="proposal-line-list">{renderedLines}</div>}
    {!documentForm || !disabled ? <button type="button" className="secondary proposal-add-line" disabled={disabled || lines.length >= MAX_PROPOSAL_LINES} onClick={() => { if (!disabled && lines.length < MAX_PROPOSAL_LINES) onChange([...lines, createProposalLine()]); }}>Добавить позицию</button> : null}
    {lines.length >= MAX_PROPOSAL_LINES && <p className="proposal-field-help">В одном КП допускается не более {MAX_PROPOSAL_LINES} позиций.</p>}
  </fieldset>;
}
