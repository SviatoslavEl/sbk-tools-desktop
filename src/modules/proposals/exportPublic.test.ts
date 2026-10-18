import { describe, expect, it } from 'vitest';
import { createProposal, createProposalLine } from './defaults';
import { buildProposalPublic, validateProposal } from './exportPublic';
import { applyProposalSourcePrice, createProposalSourceFinancials, dismissProposalSourcePricing, type ProposalSourceFinancialCandidate } from './sourcePricing';
import { priceProposal } from './pricing';
import type { ProposalData } from './types';

const heading = 'Состав работ и результаты';
const candidate = (patch: Partial<ProposalSourceFinancialCandidate> = {}): ProposalSourceFinancialCandidate => ({ id: 'aggregate-price', sourceId: 'document-a', sourceName: 'PRIVATE-SOURCE-NAME', fragmentId: 'price-p', locator: 'PRIVATE-LOCATOR', quote: 'Стоимость услуг 1220 рублей с НДС 22%. PRIVATE-SOURCE-QUOTE', sourceKind: 'contract', scope: 'aggregate', currency: 'RUB', net: '1000', vatAmount: '220', gross: '1220', tax: { kind: 'vat', rate: 22 }, issues: [], ...patch });
function draft(description = 'Полный состав работ и ограничений.\n'.repeat(80), conclusion = ''): ProposalData {
  const data = createProposal(new Date(2035, 0, 1)); data.title = 'Проверка учебной системы'; data.issuer.name = 'Исполнитель'; data.recipient.name = 'Заказчик';
  data.lines = [{ ...createProposalLine(), title: 'Комплекс аудита', description }]; data.conclusion = conclusion;
  data.paymentTerms = 'Оплата после акта или истечения срока отказа.'; data.deliveryTerms = '16 рабочих дней после получения всех материалов.';
  data.internalNote = 'PRIVATE-INTERNAL-NOTE'; data.sourceFinancials = createProposalSourceFinancials([candidate()]);
  data.sourceQuestions = [{ id: 'private-question', message: 'PRIVATE-UNRESOLVED-QUESTION', evidence: [{ sourceId: 'document-a', sourceName: 'PRIVATE-SOURCE-NAME', locator: 'PRIVATE-LOCATOR', quote: 'PRIVATE-SOURCE-QUOTE' }] }];
  return data;
}
const apply = (data: ProposalData) => applyProposalSourcePrice(data, 'aggregate-price', { sameProject: true, aggregateAsSingleLine: true });

describe('long confirmed aggregate scope customer export formatting', () => {
  it('moves exact complete scope out of the price cell and retains existing conclusion in its own block', () => {
    const accepted = apply(draft(undefined, '  Существующее заключение\nСохраняется дословно.  ')), before = structuredClone(accepted);
    const expectedScope = accepted.lines[0].description, output = buildProposalPublic(accepted);
    expect(expectedScope.length).toBeGreaterThan(2000);
    expect(output.lines).toHaveLength(1); expect(output.lines[0].description).toBe('Подробный состав работ и результаты приведены в разделе «Состав работ и результаты».');
    expect(output.terms.conclusion).toBe(`${accepted.conclusion}\n\n${heading}\n\n${expectedScope}`);
    expect(output.terms.conclusion.split(expectedScope)).toHaveLength(2);
    expect(output.lines[0]).toMatchObject({ title: accepted.lines[0].title, quantity: '1', unit: 'комплекс', unitPrice: '1220', priceBasis: 'gross', tax: { kind: 'vat', rate: 22 } });
    expect(output.totals).toEqual(priceProposal(accepted.lines).totals);
    expect(output.totals).toMatchObject({ netMinor: '100000', vatMinor: '22000', grossMinor: '122000' });
    expect(output.terms.delivery).toBe(accepted.deliveryTerms); expect(output.terms.payment).toBe(accepted.paymentTerms);
    expect(accepted).toEqual(before); expect(output).not.toHaveProperty('sourceFinancials'); expect(output).not.toHaveProperty('sourceQuestions');
    expect(JSON.stringify(output)).not.toContain('PRIVATE-');
  });

  it('keeps ordinary, commodity, not-used and position-price descriptions in their original public fields', () => {
    const ordinary = draft(); delete ordinary.sourceFinancials; ordinary.lines[0] = { ...ordinary.lines[0], unit: 'шт.', quantity: '2', unitPrice: '300' };
    expect(buildProposalPublic(ordinary).lines[0].description).toBe(ordinary.lines[0].description.trim());
    expect(buildProposalPublic(ordinary).terms.conclusion).toBe('');
    const rejected = draft(); rejected.lines[0] = { ...rejected.lines[0], unit: 'комплекс', quantity: '1', unitPrice: '1220', tax: { kind: 'vat', rate: 22 } };
    const manual = dismissProposalSourcePricing(rejected);
    expect(buildProposalPublic(manual).lines[0].description).toBe(manual.lines[0].description.trim());
    const sourcePosition = draft(); sourcePosition.sourceFinancials = createProposalSourceFinancials([candidate({ scope: 'position', positionName: sourcePosition.lines[0].title, quantity: '1', unit: 'комплекс', unitPrice: '1220', priceBasis: 'gross' })]);
    const acceptedPosition = applyProposalSourcePrice(sourcePosition, 'aggregate-price', { sameProject: true });
    expect(buildProposalPublic(acceptedPosition).lines[0].description).toBe(acceptedPosition.lines[0].description.trim());
    const aggregateGoods = draft(); aggregateGoods.sourceFinancials = createProposalSourceFinancials([candidate({ quote: 'Стоимость поставки оборудования 1220 рублей с НДС 22%.' })]);
    const acceptedGoods = apply(aggregateGoods); expect(buildProposalPublic(acceptedGoods).lines[0].description).toBe(acceptedGoods.lines[0].description); expect(buildProposalPublic(acceptedGoods).terms.conclusion).toBe('');
  });

  it('does not move multiple priced positions even when one has a valid source-price decision', () => {
    const data = draft(); data.lines.push({ ...createProposalLine(), title: 'Вторая услуга', description: 'Самостоятельный состав', unitPrice: '50' });
    data.sourceFinancials = createProposalSourceFinancials([candidate({ scope: 'position', positionName: data.lines[0].title, quantity: '1', unit: 'комплекс', unitPrice: '1220', priceBasis: 'gross' })]);
    const accepted = applyProposalSourcePrice(data, 'aggregate-price', { sameProject: true, replaceExistingPrices: true });
    const output = buildProposalPublic(accepted);
    expect(output.lines).toHaveLength(2); expect(output.lines[0].description).toBe(accepted.lines[0].description.trim()); expect(output.lines[1].description).toBe('Самостоятельный состав');
    expect(output.terms.conclusion).toBe('');
  });

  it('uses the 2000-character threshold exactly and refuses unconfirmed or stale aggregate approvals', () => {
    // Add the known title prefix as part of the accepted source-scope text;
    // threshold is applied to the stored, accepted complete description.
    const short = apply(draft('А'.repeat(1900)));
    expect(short.lines[0].description.length).toBeLessThanOrEqual(2000); expect(buildProposalPublic(short).lines[0].description).toBe(short.lines[0].description);
    const exact = apply(draft('А'.repeat(2000 - 'Комплекс аудита\n'.length)));
    expect(exact.lines[0].description).toHaveLength(2000); expect(buildProposalPublic(exact).terms.conclusion).toBe('');
    const over = apply(draft('А'.repeat(2001 - 'Комплекс аудита\n'.length)));
    expect(over.lines[0].description).toHaveLength(2001); expect(buildProposalPublic(over).terms.conclusion).toBe(`${heading}\n\n${over.lines[0].description}`);
    const unconfirmed = draft(); unconfirmed.lines[0].unitPrice = '1220'; expect(() => buildProposalPublic(unconfirmed)).toThrow();
    over.paymentTerms += ' Изменённое условие.'; expect(() => buildProposalPublic(over)).toThrow(/Решите/u);
  });

  it('fails early without truncation when exact scope plus existing conclusion exceeds the shared 20000-character budget', () => {
    const data = apply(draft('Полный состав.\n'.repeat(160), 'Я'.repeat(19_000))), before = structuredClone(data);
    expect(validateProposal(data)).toContainEqual(expect.objectContaining({ field: 'conclusion', step: 3, severity: 'error', message: expect.stringContaining('20 000') }));
    expect(() => buildProposalPublic(data)).toThrow(/Полный состав работ.*20 000/u); expect(data).toEqual(before);
    const exact = apply(draft('Я'.repeat(20_000 - heading.length - 2 - 'Комплекс аудита\n'.length)));
    expect(buildProposalPublic(exact).terms.conclusion).toHaveLength(20_000);
    const overflow = apply(draft('Я'.repeat(20_001 - heading.length - 2 - 'Комплекс аудита\n'.length)));
    expect(() => buildProposalPublic(overflow)).toThrow(/20 000/u);
  });
});
