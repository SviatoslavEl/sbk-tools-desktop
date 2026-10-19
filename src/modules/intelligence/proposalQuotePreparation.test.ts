import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildProposalQuotePlan, type ProposalQuoteRole } from './proposalQuotePlan';
import { assertProposalQuotePreparationRequest, prepareProposalQuoteSelection, validProposalQuoteProvenance, type ProposalQuotePreparationRequest } from './proposalQuotePreparation';
import type { IntelligenceSource } from './workbenchTypes';

function source(): IntelligenceSource {
  const lines = ['Договор', 'Исполнитель: ООО «Учебные работы»', 'Заказчик: ООО «Контроль QA»',
    '1. Предмет договора', '1.1. Исполнитель оказывает комплекс услуг по проверке учебной системы, состав которых определён в приложении.',
    '2. Состав оказываемых услуг', '2.1. Анализ документации с сохранением ограничений доступа.',
    '3. Итоговые материалы и результат оказания услуг', '3.1. Отчёт с рисками и рекомендациями.',
    '4. Стоимость услуг и порядок расчетов', '4.1. Аванс 25% в течение 4 календарных дней от подписания.',
    '5. Срок оказания услуг', '5.1. Максимальный срок — 16 рабочих дней после полного аванса или всех материалов, что наступит позднее.'];
  return { id: 'source', name: 'Учебный договор', text: lines.join('\n'), fragments: lines.map((text, index) => ({ id: `p-${index}`, locator: `Абзац ${index}`, text })), coverage: { complete: true, requiresOcr: false } };
}
function rolesFor(text: string): ProposalQuoteRole[] {
  if (text.startsWith('1.1.')) return ['subject']; if (text.startsWith('2.1.')) return ['scope'];
  if (text.startsWith('3.1.')) return ['deliverable']; if (text.startsWith('4.1.')) return ['payment'];
  if (text.startsWith('5.1.')) return ['schedule', 'dependency']; return [];
}
async function request(roles = rolesFor): Promise<ProposalQuotePreparationRequest> {
  const sources = [source()], options = { maxUnitsPerBatch: 2 }, plan = await buildProposalQuotePlan(sources, options);
  return { revision: 7, sources, options, parts: plan.batches.map(batch => ({ batchId: batch.id, model: 'synthetic-model', raw: JSON.stringify({ sourceSnapshotKey: plan.sourceSnapshotKey, batchId: batch.id,
    units: batch.units.map(unit => { const selected = roles(unit.text); return { unitId: unit.unitId, disposition: selected.length ? 'commercial' : 'context', roles: selected, quote: selected.length ? unit.text : null }; }) }) })) };
}
const freeze = <T,>(value: T): T => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
afterEach(() => vi.unstubAllGlobals());

describe('actual quote-selection projection before local source completion', () => {
  it('retains raw parts and exact selected quotes without fabricating ordinary model fields or doing IO', async () => {
    const fetch = vi.fn(), storage = { getItem: vi.fn(), setItem: vi.fn() }; vi.stubGlobal('fetch', fetch); vi.stubGlobal('window', { localStorage: storage });
    const input = freeze(await request()), before = structuredClone(input), result = await prepareProposalQuoteSelection(input);
    expect(input).toEqual(before); expect(result.provenance.parts).toEqual(input.parts); expect(validProposalQuoteProvenance(result.provenance)).toBe(true);
    expect(result.provenance.counts).toEqual({ units: 13, commercial: 5, context: 8, unclear: 0, batches: 7 });
    expect(result.item?.fields).toEqual({ introduction: input.sources[0].fragments![4].text, paymentTerms: input.sources[0].fragments![10].text, deliveryTerms: input.sources[0].fragments![12].text });
    expect(result.item?.sourceIds).toEqual(['source']); expect(result.provenance.projectedItemId).toBe(result.item?.id);
    expect(result.item).not.toHaveProperty('modelContribution'); expect(result.item).not.toHaveProperty('modelQuoteProvenance');
    expect(result.item?.fields).not.toHaveProperty('lines'); expect(result.item?.fields).not.toHaveProperty('conclusion'); expect(result.item?.fields).not.toHaveProperty('unitPrice');
    expect(fetch).not.toHaveBeenCalled(); for (const method of Object.values(storage)) expect(method).not.toHaveBeenCalled();
  });
  it('keeps scope-only selection meaningful but does not invent lines, names or a source-derived description', async () => {
    const result = await prepareProposalQuoteSelection(await request(text => text.startsWith('2.1.') ? ['scope'] : []));
    expect(result.item?.fields).toEqual({}); expect(result.item?.evidence).toEqual([]); expect(result.provenance.counts.commercial).toBe(1);
  });
  it.each(['context', 'unclear', 'payment', 'financial', 'party'] as const)('does not manufacture a project from only %s dispositions/roles', async kind => {
    const input = await request(() => kind === 'context' || kind === 'unclear' ? [] : [kind]);
    if (kind === 'unclear') for (const part of input.parts) { const wire = JSON.parse(part.raw); wire.units.forEach((unit: { disposition: string }) => { unit.disposition = 'unclear'; }); part.raw = JSON.stringify(wire); }
    const result = await prepareProposalQuoteSelection(input); expect(result.item).toBeUndefined(); expect(result.provenance.projectedItemId).toBeUndefined(); expect(validProposalQuoteProvenance(result.provenance)).toBe(true);
  });
  it('deduplicates a multi-role occurrence in a field but keeps separate identical source occurrences', async () => {
    const input = await request(); input.sources[0].fragments![12].text = input.sources[0].fragments![10].text;
    const plan = await buildProposalQuotePlan(input.sources, input.options);
    input.parts = plan.batches.map(batch => ({ batchId: batch.id, model: 'synthetic-model', raw: JSON.stringify({ sourceSnapshotKey: plan.sourceSnapshotKey, batchId: batch.id, units: batch.units.map(unit => ({ unitId: unit.unitId, disposition: [4, 10, 12].includes(unit.fragmentIndex) ? 'commercial' : 'context', roles: unit.fragmentIndex === 4 ? ['subject'] : [10, 12].includes(unit.fragmentIndex) ? ['schedule', 'dependency'] : [], quote: [4, 10, 12].includes(unit.fragmentIndex) ? unit.text : null })) }) }));
    const result = await prepareProposalQuoteSelection(input), quote = input.sources[0].fragments![10].text;
    expect(result.item?.fields.deliveryTerms).toBe(`${quote}\n\n${quote}`); expect(result.item?.evidence?.filter(claim => claim.field === 'deliveryTerms')).toHaveLength(2);
  });
  it.each(['missing', 'reverse', 'duplicate', 'foreign', 'unknown', 'badquote', 'wrongsource', 'lateinvalid'] as const)('rejects %s complete-batch violations atomically', async variant => {
    const input = await request();
    if (variant === 'missing') input.parts.pop(); if (variant === 'reverse') input.parts.reverse();
    if (variant === 'duplicate') input.parts[1] = structuredClone(input.parts[0]); if (variant === 'foreign') input.parts[0].batchId = 'foreign';
    if (variant === 'unknown') Object.assign(input.parts[0], { approved: true });
    if (variant === 'badquote') { const wire = JSON.parse(input.parts[2].raw); wire.units[0].quote += ' invented'; input.parts[2].raw = JSON.stringify(wire); }
    if (variant === 'wrongsource') input.sources[0].fragments![4].text += ' changed'; if (variant === 'lateinvalid') input.parts[input.parts.length - 1].raw = '{';
    const before = structuredClone(input); await expect(prepareProposalQuoteSelection(input)).rejects.toThrow(); expect(input).toEqual(before);
  });
  it('captures input before the first await and retains complete long evidence in contiguous bounded pieces', async () => {
    const input = await request(); input.sources[0].fragments![4].text += ' Условие сохранено.'.repeat(130);
    const plan = await buildProposalQuotePlan(input.sources, input.options);
    input.parts = plan.batches.map(batch => ({ batchId: batch.id, model: 'synthetic-model', raw: JSON.stringify({ sourceSnapshotKey: plan.sourceSnapshotKey, batchId: batch.id, units: batch.units.map(unit => ({ unitId: unit.unitId, disposition: unit.fragmentIndex === 4 ? 'commercial' : 'context', roles: unit.fragmentIndex === 4 ? ['subject'] : [], quote: unit.fragmentIndex === 4 ? unit.text : null })) }) }));
    const original = input.sources[0].fragments![4].text, pending = prepareProposalQuoteSelection(input); input.sources[0].fragments![4].text = 'changed'; input.parts[0].raw = 'changed';
    const result = await pending; expect(result.item?.fields.introduction).toBe(original); expect(result.item?.evidence?.every(claim => claim.quote.length <= 2000)).toBe(true); expect(result.item?.evidence?.map(claim => claim.quote).join('')).toBe(original);
  });
  it('rejects combined raw and private ledger over-budget without truncation', async () => {
    const input = await request(); input.parts[0].raw = 'x'.repeat(2 * 1024 * 1024); input.parts[1].raw = 'x';
    await expect(prepareProposalQuoteSelection(input)).rejects.toThrow(/2 МБ/);
    const normal = (await prepareProposalQuoteSelection(await request())).provenance;
    normal.parts[0].raw = '\n'.repeat(1_048_000); expect(validProposalQuoteProvenance(normal)).toBe(false);
  });
  it.each(['field', 'evidence'] as const)('fails the complete projection when the %s budget is exceeded, without truncating quotes', async variant => {
    const sources = [source()], options = { maxUnitsPerBatch: variant === 'field' ? 1 : 20 };
    for (let index = 0; index < (variant === 'field' ? 4 : 501); index++) {
      sources[0].fragments!.push({ id: `extra-${index}`, locator: `Дополнение ${index}`, text: variant === 'field' ? `Оплата ${index}: ${'a'.repeat(5500)}` : `Целое условие ${index}.` });
      if (variant === 'field') sources[0].fragments!.push({ id: `separator-${index}`, locator: 'Разделитель', text: 'Контекст.' });
    }
    const plan = await buildProposalQuotePlan(sources, options), input: ProposalQuotePreparationRequest = { revision: 1, sources, options,
      parts: plan.batches.map(batch => ({ batchId: batch.id, model: 'synthetic-model', raw: JSON.stringify({ sourceSnapshotKey: plan.sourceSnapshotKey, batchId: batch.id, units: batch.units.map(unit => {
        const extra = unit.fragmentId.startsWith('extra-'), core = unit.fragmentId === 'p-4';
        return { unitId: unit.unitId, disposition: extra || core ? 'commercial' : 'context', roles: extra ? [variant === 'field' ? 'payment' : 'subject'] : core ? ['scope'] : [], quote: extra || core ? unit.text : null };
      }) }) })) };
    const before = structuredClone(input); await expect(prepareProposalQuoteSelection(input)).rejects.toThrow(variant === 'field' ? /20 000/ : /Подтверждения/); expect(input).toEqual(before);
  });
  it('closes receipt structure, count consistency, roles, identities and private keys', async () => {
    const receipt = (await prepareProposalQuoteSelection(await request())).provenance;
    for (const mutate of [
      (copy: typeof receipt) => { Object.assign(copy, { approved: true }); },
      (copy: typeof receipt) => { copy.counts.commercial++; },
      (copy: typeof receipt) => { copy.selections[0].roles = ['invented' as ProposalQuoteRole]; },
      (copy: typeof receipt) => { copy.selections.push(copy.selections[0]); copy.counts.commercial++; copy.counts.units++; },
      (copy: typeof receipt) => { copy.selections[0].fragmentId = 'foreign'; },
      (copy: typeof receipt) => { Object.assign(copy.parts[0], { apiKey: 'not-allowed' }); },
      (copy: typeof receipt) => { copy.projectedItemId = 'bad\nidentity'; },
    ]) { const copy = structuredClone(receipt); mutate(copy); expect(validProposalQuoteProvenance(copy)).toBe(false); }
  });
  it('rejects invalid request keys/options synchronously, before worker allocation or digest', async () => {
    const input = await request();
    for (const bad of [null, { ...input, revision: -1 }, { ...input, raw: '{}' }, { ...input, options: { contextUnits: 1 } }, { ...input, options: { instruction: '\0' } }, { ...input, options: { maxUnitsPerBatch: 21 } }, { ...input, options: { maxSourcePayloadBytes: 511 } }, { ...input, options: { instruction: 'x'.repeat(20_001) } }]) expect(() => assertProposalQuotePreparationRequest(bad)).toThrow();
  });
});
