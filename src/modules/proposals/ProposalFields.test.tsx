import { isValidElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ProposalContactFields, ProposalLinesEditor, ProposalPartyFields } from './ProposalFields';
import { createProposalLine, emptyContact, emptyParty } from './defaults';
import { MAX_PROPOSAL_LINES } from './pricing';
import { VAT_RATES, type PartySnapshot, type ProposalLine } from './types';
import { emptyCompany, type CompanyCard } from '../contracts/companies';

type Props = { children?: ReactNode; onChange?: (event: { target: { value: string } }) => void; onClick?: () => void; 'aria-label'?: string; disabled?: boolean; value?: unknown; label?: string; type?: string; inputMode?: string; id?: string };
function text(node: ReactNode): string { if (typeof node === 'string' || typeof node === 'number') return String(node); if (Array.isArray(node)) return node.map(text).join(''); return isValidElement<Props>(node) ? text(node.props.children) : ''; }
function find(node: ReactNode, predicate: (type: unknown, props: Props) => boolean): Props | undefined { if (Array.isArray(node)) { for (const child of node) { const result = find(child, predicate); if (result) return result; } } else if (isValidElement<Props>(node)) { if (predicate(node.type, node.props)) return node.props; return find(node.props.children, predicate); } }
const field = (tree: ReactNode, label: string) => find(tree, (_type, props) => props['aria-label'] === label)!;
const change = (tree: ReactNode, label: string, value: string) => field(tree, label).onChange!({ target: { value } });
const click = (tree: ReactNode, label: string) => field(tree, label).onClick!();
const companies = (): CompanyCard[] => [
  { ...emptyCompany('2026-09-18', 'internal'), scope: 'internal', name: 'Наша компания', shortName: 'Наша', inn: '1234567890', kpp: '123456789', ogrn: '1234567890123', address: 'Наш адрес', contact: 'mail@example.com', notes: 'СЕКРЕТНЫЕ ЗАМЕТКИ', decisionMakers: [{ id: 'private', fullName: 'Контакт', position: '', department: '', phone: '', email: '', notes: 'СКРЫТАЯ ИНФОРМАЦИЯ', isPrimary: true }] },
  { ...emptyCompany('2026-09-17', 'external'), scope: 'external', name: 'Заказчик', inn: '0987654321' },
  { ...emptyCompany('2026-09-16', 'archived'), name: 'Архивная компания', archived: true },
];

describe('controlled proposal parties and contacts', () => {
  it('selects an explicit public company snapshot with provenance and no internal notes or nested records', () => {
    const source = companies(); const original = structuredClone(source); const onChange = vi.fn();
    const tree = ProposalPartyFields({ label: 'Исполнитель', value: { ...emptyParty(), paymentDetails: 'Старый банк' }, onChange, companies: source, scope: 'internal' });
    change(tree, 'Исполнитель: компания из справочника', 'internal');
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ companyId: 'internal', sourceUpdatedAt: '2026-09-18', name: 'Наша компания', shortName: 'Наша', inn: '1234567890', kpp: '123456789', ogrn: '1234567890123', address: 'Наш адрес', contact: 'mail@example.com', paymentDetails: '' });
    expect(JSON.stringify(onChange.mock.lastCall![0])).not.toContain('СЕКРЕТ');
    expect(JSON.stringify(onChange.mock.lastCall![0])).not.toContain('decisionMakers');
    expect(source).toEqual(original);
  });
  it('offers active companies in both scope groups but not archived companies as new choices', () => {
    const tree = ProposalPartyFields({ label: 'Получатель', value: emptyParty(), onChange: vi.fn(), companies: companies(), scope: 'external' });
    expect(find(tree, (type) => type === 'optgroup')?.label).toBe('Внешние контрагенты');
    expect(text(tree)).toContain('Наша компания'); expect(text(tree)).toContain('Заказчик'); expect(text(tree)).not.toContain('Архивная компания');
  });
  it('retains a saved archived or missing company snapshot without reading it back automatically', () => {
    for (const id of ['archived', 'missing']) {
      const value = { ...emptyParty(), companyId: id, sourceUpdatedAt: 'old', name: 'Историческое имя' }; const onChange = vi.fn();
      const tree = ProposalPartyFields({ label: 'Сторона', value, onChange, companies: companies(), scope: 'internal' });
      expect(text(tree)).toContain('Историческое имя'); expect(onChange).not.toHaveBeenCalled();
      change(tree, 'Сторона: компания из справочника', id); expect(onChange).not.toHaveBeenCalled();
    }
  });
  it('edits one field while preserving all sibling fields and source IDs', () => {
    const value: PartySnapshot = { ...emptyParty(), companyId: 'internal', sourceUpdatedAt: 'snapshot-time', name: 'Имя', inn: '0012345678', paymentDetails: 'Банк' }; const onChange = vi.fn();
    change(ProposalPartyFields({ label: 'Сторона', value, onChange, companies: companies(), scope: 'internal' }), 'Сторона: ИНН', '0000000000');
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ ...value, inn: '0000000000' }); expect(value.inn).toBe('0012345678');
  });
  it('manual entry detaches only provenance and preserves already entered requisites', () => {
    const value = { ...emptyParty(), companyId: 'internal', sourceUpdatedAt: 'old', name: 'Вручную', paymentDetails: 'Банк' }; const onChange = vi.fn();
    change(ProposalPartyFields({ label: 'Сторона', value, onChange, companies: companies(), scope: 'internal' }), 'Сторона: компания из справочника', '');
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ ...emptyParty(), name: 'Вручную', paymentDetails: 'Банк' });
  });
  it('keeps payment details when reselecting the same company but clears them when switching companies', () => {
    const value = { ...emptyParty(), companyId: 'internal', paymentDetails: 'Расчётный счёт нашей компании' }; const onChange = vi.fn();
    const tree = ProposalPartyFields({ label: 'Сторона', value, onChange, companies: companies(), scope: 'internal' });
    change(tree, 'Сторона: компания из справочника', 'internal'); expect(onChange.mock.lastCall![0].paymentDetails).toBe(value.paymentDetails);
    change(tree, 'Сторона: компания из справочника', 'external'); expect(onChange.mock.lastCall![0].paymentDetails).toBe('');
  });
  it('contact changes preserve sibling fields without mutating the original', () => {
    const value = { ...emptyContact(), fullName: 'Иванов', position: 'Директор', phone: '+7 999', email: 'old@example.com' }; const onChange = vi.fn();
    const tree = ProposalContactFields({ label: 'Контакт', value, onChange });
    expect(field(tree, 'Контакт: Электронная почта').type).toBe('email'); expect(field(tree, 'Контакт: Телефон').type).toBe('tel');
    change(tree, 'Контакт: Электронная почта', 'new@example.com');
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ ...value, email: 'new@example.com' }); expect(value.email).toBe('old@example.com');
  });
  it('disables fieldsets and ignores party/contact callbacks in read-only mode', () => {
    const onChange = vi.fn(); const party = ProposalPartyFields({ label: 'Сторона', value: emptyParty(), onChange, disabled: true, companies: companies(), scope: 'external' });
    expect(find(party, (type) => type === 'fieldset')?.disabled).toBe(true);
    change(party, 'Сторона: компания из справочника', 'internal'); change(party, 'Сторона: Полное наименование', 'Новое');
    const contact = ProposalContactFields({ label: 'Контакт', value: emptyContact(), onChange, disabled: true });
    expect(find(contact, (type) => type === 'fieldset')?.disabled).toBe(true); change(contact, 'Контакт: ФИО', 'Новое'); expect(onChange).not.toHaveBeenCalled();
  });
});

const lines = (): ProposalLine[] => [{ ...createProposalLine(), id: 'one', title: 'Первая', quantity: '1', unitPrice: '10', tax: { kind: 'vat', rate: 20 } }, { ...createProposalLine(), id: 'two', title: 'Вторая', quantity: '2', unitPrice: '5' }];
describe('controlled proposal lines', () => {
  it('exposes stable IDs for navigating from validation issues to parties, signer and individual line fields', () => {
    const onChange = vi.fn();
    expect(field(ProposalPartyFields({ label: 'Исполнитель', value: emptyParty(), onChange, companies: [], scope: 'internal' }), 'Исполнитель: Полное наименование').id).toBe('proposal-issuer.name');
    expect(field(ProposalPartyFields({ label: 'Заказчик', value: emptyParty(), onChange, companies: [], scope: 'external' }), 'Заказчик: Полное наименование').id).toBe('proposal-recipient.name');
    expect(field(ProposalContactFields({ label: 'Подписант КП', value: emptyContact(), onChange }), 'Подписант КП: ФИО').id).toBe('proposal-signer.fullName');
    const tree = ProposalLinesEditor({ lines: lines(), onChange });
    expect(field(tree, 'Позиция 1: Цена за единицу, ₽').id).toBe('proposal-lines.unitPrice-one');
    expect(field(tree, 'Позиция 2: Цена за единицу, ₽').id).toBe('proposal-lines.unitPrice-two');
  });
  it('uses decimal text inputs and preserves incomplete/comma input without coercion or sibling changes', () => {
    const value = lines(); const original = structuredClone(value); const onChange = vi.fn(); const tree = ProposalLinesEditor({ lines: value, onChange });
    for (const name of ['Количество', 'Цена за единицу, ₽', 'Скидка, %']) {
      expect(field(tree, `Позиция 1: ${name}`).type).toBe('text'); expect(field(tree, `Позиция 1: ${name}`).inputMode).toBe('decimal');
    }
    change(tree, 'Позиция 1: Цена за единицу, ₽', '12,');
    expect(onChange).toHaveBeenCalledExactlyOnceWith([{ ...value[0], unitPrice: '12,' }, value[1]]);
    expect(onChange.mock.lastCall![0][1]).toBe(value[1]); expect(value).toEqual(original);
  });
  it('adds a fresh default line and preserves existing IDs', () => {
    const value = lines(); const onChange = vi.fn(); const tree = ProposalLinesEditor({ lines: value, onChange });
    find(tree, (type, props) => type === 'button' && text(props.children) === 'Добавить позицию')!.onClick!();
    const updated = onChange.mock.lastCall![0] as ProposalLine[];
    expect(updated).toHaveLength(3); expect(updated[0]).toBe(value[0]); expect(updated[1]).toBe(value[1]); expect(updated[2].id).not.toBe('one'); expect(updated[2].id).not.toBe('two'); expect(updated[2].quantity).toBe('1');
  });
  it('copies immediately after the source with a fresh ID and independent tax object', () => {
    const value = lines(); const onChange = vi.fn(); click(ProposalLinesEditor({ lines: value, onChange }), 'Копировать: Позиция 1');
    const updated = onChange.mock.lastCall![0] as ProposalLine[];
    expect(updated).toHaveLength(3); expect(updated[0]).toBe(value[0]); expect(updated[2]).toBe(value[1]);
    expect(updated[1]).toEqual({ ...value[0], id: updated[1].id }); expect(updated[1].id).not.toBe(value[0].id); expect(updated[1].tax).not.toBe(value[0].tax);
  });
  it('moves lines up/down without changing their IDs or values and blocks boundary moves', () => {
    const value = lines(); const onChange = vi.fn(); const tree = ProposalLinesEditor({ lines: value, onChange });
    expect(field(tree, 'Переместить вверх: Позиция 1').disabled).toBe(true); expect(field(tree, 'Переместить вниз: Позиция 2').disabled).toBe(true);
    click(tree, 'Переместить вверх: Позиция 1'); click(tree, 'Переместить вниз: Позиция 2'); expect(onChange).not.toHaveBeenCalled();
    click(tree, 'Переместить вниз: Позиция 1'); expect(onChange).toHaveBeenLastCalledWith([value[1], value[0]]);
    click(tree, 'Переместить вверх: Позиция 2'); expect(onChange).toHaveBeenLastCalledWith([value[1], value[0]]); expect(value.map((entry) => entry.id)).toEqual(['one', 'two']);
  });
  it('deletes only the requested position and supports a deliberately empty draft', () => {
    const value = lines(); const onChange = vi.fn(); click(ProposalLinesEditor({ lines: value, onChange }), 'Удалить: Позиция 1'); expect(onChange).toHaveBeenLastCalledWith([value[1]]);
    click(ProposalLinesEditor({ lines: [value[0]], onChange }), 'Удалить: Позиция 1'); expect(onChange).toHaveBeenLastCalledWith([]);
    expect(text(ProposalLinesEditor({ lines: [], onChange }))).toContain('Позиции пока не добавлены');
  });
  it('keeps VAT zero distinct from no VAT and offers every supported rate', () => {
    const value = lines(); const onChange = vi.fn(); const tree = ProposalLinesEditor({ lines: value, onChange });
    const taxField = field(tree, 'Позиция 1: НДС');
    for (const rate of VAT_RATES) { expect(text(taxField.children)).toContain(`НДС ${rate}%`); change(tree, 'Позиция 1: НДС', String(rate)); expect(onChange.mock.lastCall![0][0].tax).toEqual({ kind: 'vat', rate }); }
    change(tree, 'Позиция 1: НДС', 'none'); expect(onChange.mock.lastCall![0][0].tax).toEqual({ kind: 'none' });
    const count = onChange.mock.calls.length; change(tree, 'Позиция 1: НДС', ''); change(tree, 'Позиция 1: НДС', '99'); expect(onChange).toHaveBeenCalledTimes(count);
  });
  it('switches gross/net pricing while leaving tax, quantity and other fields intact', () => {
    const value = lines(); const onChange = vi.fn(); const tree = ProposalLinesEditor({ lines: value, onChange });
    change(tree, 'Позиция 1: Ввод цены', 'net'); expect(onChange).toHaveBeenLastCalledWith([{ ...value[0], priceBasis: 'net' }, value[1]]);
    change(tree, 'Позиция 1: Ввод цены', 'gross'); expect(onChange).toHaveBeenLastCalledWith(value);
    change(tree, 'Позиция 1: Ввод цены', 'invalid'); expect(onChange).toHaveBeenCalledTimes(2);
  });
  it('guards all line mutations while the editor is disabled', () => {
    const onChange = vi.fn(); const tree = ProposalLinesEditor({ lines: lines(), onChange, disabled: true });
    expect(find(tree, (type) => type === 'fieldset')?.disabled).toBe(true);
    change(tree, 'Позиция 1: Наименование', 'Не менять'); change(tree, 'Позиция 1: НДС', 'none');
    click(tree, 'Удалить: Позиция 1'); click(tree, 'Копировать: Позиция 1'); click(tree, 'Переместить вниз: Позиция 1');
    find(tree, (type, props) => type === 'button' && text(props.children) === 'Добавить позицию')!.onClick!(); expect(onChange).not.toHaveBeenCalled();
  });
  it('enforces the maximum line count for add and copy even through stale callbacks', () => {
    const value = Array.from({ length: MAX_PROPOSAL_LINES }, (_, index) => ({ ...createProposalLine(), id: String(index) })); const onChange = vi.fn(); const tree = ProposalLinesEditor({ lines: value, onChange });
    const add = find(tree, (type, props) => type === 'button' && text(props.children) === 'Добавить позицию')!;
    expect(add.disabled).toBe(true); expect(field(tree, 'Копировать: Позиция 1').disabled).toBe(true);
    add.onClick!(); click(tree, 'Копировать: Позиция 1'); expect(onChange).not.toHaveBeenCalled();
  });
});
