import { describe, expect, it } from 'vitest';
import { completeContractProposalFields } from '../intelligence/contractProposalCompletion';
import { taskSourceSnapshotKey } from '../intelligence/taskSourceIdentity';
import { buildIntelligenceHandoff } from '../intelligence/workbenchModel';
import type { IntelligenceItem, IntelligenceSource } from '../intelligence/workbenchTypes';
import { prepareCommercialTaskProposal } from './commercialTaskPreparation';
import { applyProposalSourcePrice, createProposalSourceFinancials } from './sourcePricing';
import { hasFreshCommercialScopeSnapshot } from './commercialScopeSnapshot';

function source(): IntelligenceSource {
  const lines = ['Договор', 'Исполнитель: ООО «Учебные работы»', 'Заказчик: ООО «Контроль QA»',
    '1. Предмет договора', '1.1. Исполнитель оказывает комплекс услуг по проверке учебной системы, состав которых определён в приложении.',
    '2. Состав оказываемых услуг', '2.1. Анализ документации с сохранением ограничений доступа.', '2.2. Проверка компонентов; SBOM при наличии.',
    '3. Итоговые материалы и результат оказания услуг', '3.1. Отчёт с рисками и рекомендациями.', '3.2. Материалы в DOCX и PDF; встреча по результатам.',
    '4. Стоимость услуг и порядок расчетов', '4.1. Стоимость услуг составляет 12 000,00 рублей, в том числе НДС 22%.', '4.2. Аванс 25% в течение 4 календарных дней от подписания.', '4.3. Окончательный расчет в течение 6 рабочих дней от акта или истечения срока отказа.',
    '5. Срок оказания услуг', '5.1. Максимальный срок — 16 рабочих дней после полного аванса или всех материалов, что наступит позднее.',
    '6. Входные данные и условия проведения работ', '6.1. Заказчик предоставляет доступы, материалы и разрешения; репозиторий при наличии.',
    '7. Допущения и ограничения', '7.1. Восстановление архитектуры в объём работ не входит.'];
  return { id: 'source', name: 'Учебный договор', text: lines.join('\n'), fragments: lines.map((text, index) => ({ id: `p-${index}`, locator: `Абзац ${index}`, text })), coverage: { complete: true, requiresOcr: false } };
}
async function fixture() {
  const sources = [source()]; const raw: IntelligenceItem = { id: 'card', title: 'КП', destination: 'proposals', fields: {}, selectedFields: [], sourceIds: ['source'], evidence: [] };
  const items = completeContractProposalFields([raw], sources, ['proposals']).items, item = items[0], handoff = buildIntelligenceHandoff(item, sources, '/isolated-workspace');
  if (handoff.destination !== 'proposals') throw new Error('fixture');
  return { data: handoff.data, item, items, sources, sourceSnapshotKey: await taskSourceSnapshotKey(sources) };
}
describe('bounded whole-contract task preparation', () => {
  it('attaches the source-derived body only to a fresh whole-field-proven draft and preserves raw source and legacy values', async () => {
    const input = await fixture(), before = structuredClone(input), result = await prepareCommercialTaskProposal(input);
    expect(result.structured).toBe(true); expect(result.data.commercialDocument?.privateAppendix.clauses).toHaveLength(input.sources[0].fragments!.length);
    expect(result.data.commercialDocument?.decisions).toEqual([]); expect(result.data.commercialDocument?.privateAppendix.extraction.visualAssessment).toBe('unassessed');
    const { commercialDocument: _body, commercialScopeSnapshot: scope, ...legacy } = result.data; expect(legacy).toEqual(input.data); expect(scope).toMatchObject({ version: 1, lineId: input.data.lines[0].id, title: input.data.lines[0].title, description: input.data.lines[0].description }); expect(input).toEqual(before);
  });
  it('does not replace a manually tailored subset or an unproven model field with the full source contract', async () => {
    const input = await fixture(); input.item.fields.deliveryTerms = 'Только один выбранный блок'; input.data.deliveryTerms = 'Только один выбранный блок';
    const result = await prepareCommercialTaskProposal(input); expect(result.structured).toBe(false); expect(result.data.deliveryTerms).toBe('Только один выбранный блок'); expect(result.data.commercialDocument).toBeUndefined();
  });
  it('keeps the canonical service row identity and scope receipt through an explicit source-price application', async () => {
    const input = await fixture(), result = await prepareCommercialTaskProposal(input), originalId = result.data.lines[0].id;
    result.data.title = 'Предложение по итогам обсуждения';
    result.data.sourceFinancials = createProposalSourceFinancials([{ id: 'price', sourceId: 'source', sourceName: 'Учебный договор', locator: 'Стоимость', quote: 'Стоимость услуг составляет 12 000,00 рублей, в том числе НДС 22%.', sourceKind: 'contract', scope: 'aggregate', currency: 'RUB', gross: '12000', tax: { kind: 'vat', rate: 22 }, issues: [] }]);
    const priced = applyProposalSourcePrice(result.data, 'price', { sameProject: true, aggregateAsSingleLine: true });
    expect(priced.lines[0].id).toBe(originalId); expect(hasFreshCommercialScopeSnapshot(priced)).toBe(true);
    expect(priced.commercialScopeSnapshot).toEqual(result.data.commercialScopeSnapshot);
  });
  it('does not overwrite a receiver edit made after the item was prepared', async () => {
    const input = await fixture(); input.data.paymentTerms += ' Мои новые условия';
    await expect(prepareCommercialTaskProposal(input)).rejects.toThrow(/изменён/); expect(input.data.paymentTerms).toContain('Мои новые условия');
  });
  it('does not issue a canonical scope receipt for a changed price-row title', async () => {
    const input = await fixture(); input.data.lines[0].title = 'Другая услуга';
    await expect(prepareCommercialTaskProposal(input)).rejects.toThrow(/изменён/);
  });
  it('never upgrades already structured or approved documents a second time', async () => {
    const input = await fixture(), first = await prepareCommercialTaskProposal(input);
    await expect(prepareCommercialTaskProposal({ ...input, data: first.data })).rejects.toThrow(/новому черновику/);
    input.data.status = 'ready'; await expect(prepareCommercialTaskProposal(input)).rejects.toThrow(/новому черновику/);
  });
  it('does not claim completeness for an incomplete or mismatched source snapshot', async () => {
    const input = await fixture(); input.sources[0].coverage!.complete = false;
    const result = await prepareCommercialTaskProposal(input); expect(result.structured).toBe(false); expect(result.data.commercialDocument).toBeUndefined();
    const valid = await fixture(); valid.sourceSnapshotKey = `sha256:${'f'.repeat(64)}`;
    expect((await prepareCommercialTaskProposal(valid)).structured).toBe(false);
  });
});
