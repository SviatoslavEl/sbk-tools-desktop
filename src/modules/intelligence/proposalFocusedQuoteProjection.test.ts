import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildProposalFocusedUnitSelectionPlan, type ProposalFocusedQuoteFocus, type ProposalFocusedUnitSelectionOptions } from './proposalFocusedQuotePlan';
import * as focusedPlan from './proposalFocusedQuotePlan';
import * as contractCompletion from './contractProposalCompletion';
import { assembleFocusedUnitSelectionRun, projectFocusedUnitSelectionProposal, type FocusedUnitSelectionRunProof } from './proposalFocusedQuoteProjection';
import { buildIntelligenceHandoff, validateIntelligenceItem } from './workbenchModel';
import { validateProposal } from '../proposals/exportPublic';
import type { IntelligenceSource } from './workbenchTypes';

function source(): IntelligenceSource {
  const lines = ['Договор', 'Исполнитель: ООО «Учебные работы»', 'Заказчик: ООО «Контроль QA»',
    '1. Предмет договора', '1.1. Исполнитель оказывает комплекс услуг по проверке учебной системы, состав которых определён в приложении.',
    '2. Состав оказываемых услуг', '2.1. Анализ документации с сохранением ограничений доступа. SELECTED-WORK',
    '2.2. Проверка компонентов с обязательной передачей исходного кода. UNSELECTED-WORK-MUST-NOT-RETURN',
    '3. Итоговые материалы и результат оказания услуг', '3.1. Отчёт с рисками и рекомендациями. SELECTED-RESULT',
    '3.2. Архив исходного кода и видеозапись встречи. UNSELECTED-RESULT-MUST-NOT-RETURN',
    '4. Стоимость услуг и порядок расчетов', '4.1. Стоимость услуг составляет 12 000,00 рублей, в том числе НДС 22%.',
    '4.2. Аванс 25% в течение 4 календарных дней от подписания.',
    '5. Срок оказания услуг', '5.1. Максимальный срок — 16 рабочих дней после полного аванса или всех материалов, что наступит позднее.'];
  return { id: 'source', name: 'Учебный договор', text: lines.join('\n'), fragments: lines.map((text, index) => ({ id: `p-${index}`, locator: `Абзац ${index}`, text })), coverage: { complete: true, requiresOcr: false } };
}
// Authored protocol fixtures ONLY. These tests do not execute a provider or
// establish that a real model makes correct or complete semantic selections.
async function input(sources: IntelligenceSource[], focus: ProposalFocusedQuoteFocus, selected = ['p-6'], unclear: string[] = [], limits: Partial<ProposalFocusedUnitSelectionOptions> = {}) {
  const options: ProposalFocusedUnitSelectionOptions = { focus, maxUnitsPerBatch: 4, ...limits }, plan = await buildProposalFocusedUnitSelectionPlan(sources, options);
  return { sources, options, parts: plan.batches.map(batch => ({ batchId: batch.id, model: 'authored-synthetic-not-inference', raw: JSON.stringify({ sourceSnapshotKey: plan.sourceSnapshotKey, batchId: batch.id,
    units: Object.fromEntries(batch.units.map(unit => [unit.unitId, { selected: unclear.includes(unit.fragmentId) ? null : selected.includes(unit.fragmentId), reason: 'PRIVATE-MODEL-REASON: authored fixture, not inference.' }])) }) })) };
}
async function proof(sources: IntelligenceSource[], focus: ProposalFocusedQuoteFocus, selected?: string[], unclear?: string[]) {
  return assembleFocusedUnitSelectionRun(await input(sources, focus, selected ?? (focus === 'work-scope' ? ['p-6'] : ['p-9']), unclear));
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('offline model unit selection and distinct local whole-fragment materialization', () => {
  it('keeps original raw decisions separate from source-owned references/materializations and a non-serializable run capability without IO', async () => {
    const fetch = vi.fn(), storage = { getItem: vi.fn(), setItem: vi.fn() }; vi.stubGlobal('fetch', fetch); vi.stubGlobal('window', { localStorage: storage });
    const request = await input([source()], 'work-scope', ['p-6', 'p-7']), before = structuredClone(request), run = await assembleFocusedUnitSelectionRun(request);
    expect(request).toEqual(before); expect(run.receipt.parts).toEqual(request.parts); expect(run.receipt.focus).toBe('work-scope');
    expect(run.receipt.counts).toEqual({ units: 16, selected: 2, notSelected: 14, unclear: 0, batches: 4 });
    expect(run).toMatchObject({ version: 2, receipt: { version: 2, origin: 'model-selection/source-materialized-fragments' } });
    expect(run.receipt.materializations.map(value => value.text)).toEqual(request.sources[0].fragments!.slice(6, 8).map(value => value.text));
    expect(run.receipt.materializations.every(value => value.origin === 'source-materialized-whole-fragment')).toBe(true);
    expect(run.receipt.references.map(value => Object.keys(value).sort())).toEqual(Array(2).fill(['fragmentId', 'fragmentIndex', 'locator', 'sourceId', 'unitId']));
    for (const part of run.receipt.parts) for (const decision of Object.values(JSON.parse(part.raw).units as Record<string, unknown>)) expect(Object.keys(decision as object).sort()).toEqual(['reason', 'selected']);
    expect(JSON.stringify(run.receipt.decisions)).not.toMatch(/"(?:quote|text)":/u); expect(JSON.stringify(run.receipt.references)).not.toMatch(/"(?:quote|text)":/u);
    expect(Object.isFrozen(run)).toBe(true); expect(Object.isFrozen(run.receipt.parts[0])).toBe(true);
    expect(run.receipt).not.toHaveProperty('apiKey'); expect(run.receipt).not.toHaveProperty('endpoint'); expect(run.receipt).not.toHaveProperty('prompt');
    await expect(projectFocusedUnitSelectionProposal({ sources: request.sources, work: structuredClone(run) })).rejects.toThrow(/JSON-журнал/);
    expect(fetch).not.toHaveBeenCalled(); for (const method of Object.values(storage)) expect(method).not.toHaveBeenCalled();
  });

  it('projects ONLY model-selected work/result bodies with separately source-derived names, no canonical tail or invented commercial fields', async () => {
    const sources = [source()], work = await proof(sources, 'work-scope'), deliverables = await proof(sources, 'deliverables'), before = structuredClone(sources);
    const complete = vi.spyOn(contractCompletion, 'completeContractProposalFields'), prover = vi.spyOn(contractCompletion, 'createContractProposalProver');
    const result = await projectFocusedUnitSelectionProposal({ sources, work, deliverables });
    expect(result.status).toBe('candidate'); expect(result.receipt.readiness).toBe('not-assessed'); expect(result.receipt.warnings).toEqual([]);
    expect(result.item!.fields).toEqual({ title: 'КП по проверке учебной системы', lines: ['Услуги по проверке учебной системы'], lineDescriptions: [sources[0].fragments![6].text], conclusion: sources[0].fragments![9].text });
    expect(result.receipt.caption).toMatchObject({ origin: 'source-derived-caption', sourceIds: ['source'] });
    expect(result.receipt.caption!.evidence.some(value => value.fragmentId === 'p-4')).toBe(true);
    expect(result.receipt.fieldOrigins.filter(value => value.origin === 'source-derived-caption')).toEqual([{ field: 'title', origin: 'source-derived-caption', unitIds: [] }, { field: 'lines', origin: 'source-derived-caption', unitIds: [] }]);
    expect(result.receipt).toMatchObject({ version: 2, origin: 'model-selection/source-materialized-projection' });
    expect(result.receipt.fieldOrigins.find(value => value.field === 'lineDescriptions')).toEqual({ field: 'lineDescriptions', origin: 'model-selected/source-materialized-text', unitIds: work.receipt.references.map(value => value.unitId) });
    const actual = JSON.stringify(result.item);
    for (const omitted of ['UNSELECTED-WORK', 'UNSELECTED-RESULT', 'PRIVATE-MODEL-REASON', '12 000,00', 'Аванс 25%', '16 рабочих дней', 'issuerName', 'recipientName', 'proposalSourceFinancials', 'proposalSourceParties']) expect(actual).not.toContain(omitted);
    expect(result.receipt.projectedItemId).toBe(result.item!.id); expect(validateIntelligenceItem(result.item!)).toEqual([]);
    expect(complete).not.toHaveBeenCalled(); expect(prover).not.toHaveBeenCalled(); expect(sources).toEqual(before);
  });

  it('passes the selected-only body through the real unsaved handoff without restoring scope or default price/quantity/unit', async () => {
    const sources = [source()], result = await projectFocusedUnitSelectionProposal({ sources, work: await proof(sources, 'work-scope'), deliverables: await proof(sources, 'deliverables') });
    const handoff = buildIntelligenceHandoff(result.item!, sources, '/isolated-synthetic-workspace');
    expect(handoff.destination).toBe('proposals'); if (handoff.destination !== 'proposals') throw new Error('wrong fixture destination');
    expect(handoff.data.lines).toHaveLength(1); expect(handoff.data.lines[0]).toMatchObject({ title: 'Услуги по проверке учебной системы', description: sources[0].fragments![6].text, quantity: '', unit: '', unitPrice: '' });
    expect(handoff.data.conclusion).toBe(sources[0].fragments![9].text); expect(handoff.data.paymentTerms).toBe(''); expect(handoff.data.deliveryTerms).toBe('');
    expect(handoff.data.issuer.name).toBe(''); expect(handoff.data.recipient.name).toBe(''); expect(handoff.data.documentDate).toBe(''); expect(handoff.data.validUntil).toBe('');
    expect(handoff.data).not.toHaveProperty('commercialDocument'); expect(handoff.data).not.toHaveProperty('sourceFinancials');
    for (const omitted of ['UNSELECTED-WORK', 'UNSELECTED-RESULT', 'PRIVATE-MODEL-REASON']) expect(JSON.stringify(handoff.data)).not.toContain(omitted);
    // A syntactically transferable aggregate is deliberately NOT a ready CP.
    expect(validateProposal(handoff.data).some(issue => issue.severity === 'error')).toBe(true); expect(result.receipt.readiness).toBe('not-assessed');
  });

  it('preserves each selected whole occurrence and its internal qualifiers in source order, even for repeated identical text', async () => {
    const sources = [source()]; sources[0].fragments![7].text = sources[0].fragments![6].text;
    const work = await proof(sources, 'work-scope', ['p-7', 'p-6']), result = await projectFocusedUnitSelectionProposal({ sources, work });
    const quote = sources[0].fragments![6].text;
    expect(result.item!.fields.lineDescriptions).toEqual([`${quote}\n\n${quote}`]);
    expect(result.item!.evidence!.filter(value => value.field === 'lineDescriptions').map(value => value.fragmentId)).toEqual(['p-6', 'p-7']);
    expect(result.status).toBe('incomplete'); expect(result.item!.fields).not.toHaveProperty('conclusion');
  });

  it('materializes exact source Unicode/spacing locally although the actual raw response contains no document text', async () => {
    const sources = [source()], exact = '2.1. Проверка е\u0301 и ё; условие: «при наличии».\r\n\tAPI 😀 — без изменения пробелов.  ';
    sources[0].fragments![6].text = exact;
    // Aggregate text deliberately differs: it is never the materializer's owner.
    sources[0].text = 'AGGREGATE-FALLBACK-MUST-NOT-RETURN';
    const request = await input(sources, 'work-scope'), run = await assembleFocusedUnitSelectionRun(request), result = await projectFocusedUnitSelectionProposal({ sources, work: run });
    expect(run.receipt.materializations).toEqual([{ origin: 'source-materialized-whole-fragment', ...run.receipt.references[0], text: exact }]);
    expect(result.item!.fields.lineDescriptions).toEqual([exact]); expect(result.item!.evidence!.filter(value => value.field === 'lineDescriptions').map(value => value.quote).join('')).toBe(exact);
    for (const part of request.parts) { expect(part.raw).not.toContain('Проверка'); expect(part.raw).not.toContain('API'); expect(part.raw).not.toMatch(/"(?:quote|text)":/u); }
    expect(JSON.stringify(result.item)).not.toContain('AGGREGATE-FALLBACK');
  });

  it.each(['', ' \t\r\n  '])('rejects a selected blank whole fragment without trimming, replacing or repairing its raw/source input (%j)', async blank => {
    const sources = [source()]; sources[0].fragments![6].text = blank;
    const request = await input(sources, 'work-scope'), before = structuredClone(request);
    await expect(assembleFocusedUnitSelectionRun(request)).rejects.toThrow(/Выбранный фрагмент пуст/);
    expect(request).toEqual(before); expect(sources[0].fragments![6].text).toBe(blank);
  });

  it.each(['fragmentIndex', 'fragmentId', 'locator', 'sourceId'] as const)('fails closed when a parser reference %s is inconsistent with the fresh whole-fragment owner', async changed => {
    const request = await input([source()], 'work-scope'), parse = focusedPlan.parseProposalFocusedUnitSelectionResponse;
    vi.spyOn(focusedPlan, 'parseProposalFocusedUnitSelectionResponse').mockImplementation(async (...args) => {
      const result = await parse(...args);
      return { ...result, references: result.references.map(reference => ({ ...reference, [changed]: changed === 'fragmentIndex' ? reference.fragmentIndex + 1 : 'foreign' })) };
    });
    await expect(assembleFocusedUnitSelectionRun(request)).rejects.toThrow(/не принадлежит исходному пакету/);
  });

  it('never materializes an unselected source-owned fragment even if a parser reference has otherwise valid owner coordinates', async () => {
    const sources = [source()], request = await input(sources, 'work-scope'), plan = await buildProposalFocusedUnitSelectionPlan(sources, request.options), parse = focusedPlan.parseProposalFocusedUnitSelectionResponse;
    vi.spyOn(focusedPlan, 'parseProposalFocusedUnitSelectionResponse').mockImplementation(async (...args) => {
      const result = await parse(...args), foreign = plan.batches.flatMap(batch => batch.units).find(unit => unit.fragmentId === 'p-7')!;
      return result.references.length ? { ...result, references: [{ unitId: foreign.unitId, sourceId: foreign.sourceId, fragmentId: foreign.fragmentId, fragmentIndex: foreign.fragmentIndex, locator: foreign.locator }] } : result;
    });
    await expect(assembleFocusedUnitSelectionRun(request)).rejects.toThrow(/Невыбранный текст не материализован/);
  });

  it('does not treat diagnostic punctuation as semantic coverage or fix an all-false run by adding source content', async () => {
    const sources = [source()], request = await input(sources, 'work-scope', []);
    for (const part of request.parts) { const wire = JSON.parse(part.raw); for (const decision of Object.values(wire.units as Record<string, { reason: string }>)) decision.reason = ','; part.raw = JSON.stringify(wire); }
    const run = await assembleFocusedUnitSelectionRun(request), result = await projectFocusedUnitSelectionProposal({ sources, work: run });
    expect(run.receipt.decisions.every(value => value.reason === ',')).toBe(true); expect(run.receipt.materializations).toEqual([]);
    expect(result.status).toBe('empty'); expect(result.item).toBeUndefined(); expect(result.receipt.readiness).toBe('not-assessed');
  });

  it.each(['none', 'unclear', 'selected-and-unclear'] as const)('reports %s work honestly without source-only fallback', async variant => {
    const sources = [source()], work = await proof(sources, 'work-scope', variant === 'selected-and-unclear' ? ['p-6'] : [], variant === 'none' ? [] : ['p-7']);
    const result = await projectFocusedUnitSelectionProposal({ sources, work, deliverables: await proof(sources, 'deliverables') });
    expect(result.status).toBe(variant === 'none' ? 'empty' : 'incomplete'); expect(result.receipt.readiness).toBe('not-assessed');
    if (variant === 'selected-and-unclear') { expect(result.item!.fields.lineDescriptions).toEqual([sources[0].fragments![6].text]); expect(JSON.stringify(result.item)).not.toContain('UNSELECTED-WORK'); }
    else expect(result.item).toBeUndefined();
  });

  it.each(['absent', 'empty', 'unclear'] as const)('keeps %s deliverables explicitly incomplete, with no source-derived conclusion', async variant => {
    const sources = [source()], result = await projectFocusedUnitSelectionProposal({ sources, work: await proof(sources, 'work-scope'), ...(variant === 'absent' ? {} : { deliverables: await proof(sources, 'deliverables', [], variant === 'unclear' ? ['p-9'] : []) }) });
    expect(result.status).toBe('incomplete'); expect(result.item!.fields).not.toHaveProperty('conclusion'); expect(JSON.stringify(result.item)).not.toContain('SELECTED-RESULT');
  });

  it('does not invent a generic caption when a bounded printed service phrase cannot be derived', async () => {
    const sources = [source()]; sources[0].fragments![4].text = `1.1. Исполнитель оказывает комплекс услуг по ${'а'.repeat(220)}.`;
    const result = await projectFocusedUnitSelectionProposal({ sources, work: await proof(sources, 'work-scope'), deliverables: await proof(sources, 'deliverables') });
    expect(result.status).toBe('incomplete'); expect(result.item).toBeUndefined(); expect(result.receipt.runs[0].materializations).toHaveLength(1); expect(result.receipt.caption).toBeUndefined();
  });

  it.each(['missing', 'reversed', 'duplicate', 'wrong-focus', 'unknown-key', 'late-bad-json', 'old-quote-raw', 'invented-text-raw', 'stale-source'] as const)('rejects %s full-run violations atomically', async variant => {
    const request = await input([source()], 'work-scope');
    if (variant === 'missing') request.parts.pop(); if (variant === 'reversed') request.parts.reverse();
    if (variant === 'duplicate') request.parts[1] = structuredClone(request.parts[0]);
    if (variant === 'wrong-focus') request.options.focus = 'deliverables';
    if (variant === 'unknown-key') Object.assign(request.parts[0], { approved: true });
    if (variant === 'late-bad-json') request.parts[request.parts.length - 1].raw = '{';
    if (variant === 'old-quote-raw' || variant === 'invented-text-raw') { const wire = JSON.parse(request.parts[1].raw); const decision = Object.values(wire.units as Record<string, { selected: boolean }>).find(value => value.selected)!; Object.assign(decision, variant === 'old-quote-raw' ? { quote: request.sources[0].fragments![6].text } : { text: 'invented' }); request.parts[1].raw = JSON.stringify(wire); }
    if (variant === 'stale-source') request.sources[0].fragments![6].text += ' changed';
    const before = structuredClone(request); await expect(assembleFocusedUnitSelectionRun(request)).rejects.toThrow(); expect(request).toEqual(before);
  });

  it.each(['source', 'options', 'raw', 'oversized-live-raw'] as const)('revalidates changed %s before publishing a run proof', async variant => {
    const request = await input([source()], 'work-scope'), pending = assembleFocusedUnitSelectionRun(request);
    if (variant === 'source') request.sources[0].fragments![6].text += ' changed';
    if (variant === 'options') request.options.instruction = 'changed';
    if (variant === 'raw') request.parts[0].raw += '\n';
    if (variant === 'oversized-live-raw') request.parts[0].raw = 'x'.repeat(2 * 1024 * 1024 + 1);
    await expect(pending).rejects.toThrow(variant === 'oversized-live-raw' ? /2 МБ/ : /изменились/);
  });

  it('rejects forged proofs, reversed focuses, mixed snapshots and edits before projection', async () => {
    const sources = [source()], work = await proof(sources, 'work-scope'), deliverables = await proof(sources, 'deliverables');
    await expect(projectFocusedUnitSelectionProposal({ sources, work: { version: 2, receipt: work.receipt } })).rejects.toThrow(/JSON-журнал/);
    await expect(projectFocusedUnitSelectionProposal({ sources, work: { version: 1, receipt: { ...work.receipt, version: 1, origin: 'model-focused-whole-quotes' } } as unknown as FocusedUnitSelectionRunProof })).rejects.toThrow(/прежний quote-proof/);
    await expect(projectFocusedUnitSelectionProposal({ sources, work: deliverables, deliverables: work })).rejects.toThrow(/именно этого фокуса/);
    const changed = structuredClone(sources); changed[0].fragments![6].text += ' changed';
    await expect(projectFocusedUnitSelectionProposal({ sources: changed, work })).rejects.toThrow(/Источники изменились/);
    await expect(projectFocusedUnitSelectionProposal({ sources, work, deliverables: await proof(changed, 'deliverables') })).rejects.toThrow(/разным снимкам/);
  });

  it.each(['source', 'proof', 'oversized-live-source'] as const)('rejects %s changing while the projection snapshot digest is pending', async variant => {
    const sources = [source()], work = await proof(sources, 'work-scope'), replacement = await proof(sources, 'work-scope', ['p-7']), request: { sources: IntelligenceSource[]; work: FocusedUnitSelectionRunProof } = { sources, work };
    const pending = projectFocusedUnitSelectionProposal(request);
    if (variant === 'source') request.sources[0].fragments![6].text += ' changed';
    if (variant === 'proof') request.work = replacement;
    if (variant === 'oversized-live-source') request.sources[0].text = 'x'.repeat(8 * 1024 * 1024 + 1);
    await expect(pending).rejects.toThrow(variant === 'oversized-live-source' ? /8 МБ/ : /изменились/);
  });

  it('keeps long selected literal evidence losslessly in bounded surrogate-safe pieces', async () => {
    const sources = [source()]; sources[0].fragments![6].text = `${'x'.repeat(1999)}😀${'y'.repeat(1000)}`;
    const result = await projectFocusedUnitSelectionProposal({ sources, work: await assembleFocusedUnitSelectionRun(await input(sources, 'work-scope', ['p-6'], [], { maxUnitsPerBatch: 1 })) });
    const evidence = result.item!.evidence!.filter(value => value.field === 'lineDescriptions');
    expect(result.item!.fields.lineDescriptions).toEqual([sources[0].fragments![6].text]); expect(evidence.map(value => value.quote).join('')).toBe(sources[0].fragments![6].text);
    expect(evidence.every(value => value.quote.length <= 2000 && !/[\uD800-\uDBFF]$/u.test(value.quote) && !/^[\uDC00-\uDFFF]/u.test(value.quote))).toBe(true);
  });

  it('rejects combined raw and expanded private receipt bounds without repairing or truncating the input', async () => {
    const request = await input([source()], 'work-scope'); request.parts[0].raw = 'x'.repeat(2 * 1024 * 1024); request.parts[1].raw = 'x';
    await expect(assembleFocusedUnitSelectionRun(request)).rejects.toThrow(/2 МБ/);
    const expanded = await input([source()], 'work-scope'); expanded.parts[0].raw += '\n'.repeat(1_049_000); const before = structuredClone(expanded);
    await expect(assembleFocusedUnitSelectionRun(expanded)).rejects.toThrow(/Журнал.*2 МБ/); expect(expanded).toEqual(before);
  });

  it('shares the total raw budget across both individually valid focus runs', async () => {
    const sources = [source()], workInput = await input(sources, 'work-scope'), resultInput = await input(sources, 'deliverables', ['p-9']);
    // JSON whitespace is retained exactly; neither individual receipt exceeds
    // the cap, but combining them must fail before any public candidate exists.
    workInput.parts[0].raw += ' '.repeat(1_050_000); resultInput.parts[0].raw += ' '.repeat(1_050_000);
    const work = await assembleFocusedUnitSelectionRun(workInput), deliverables = await assembleFocusedUnitSelectionRun(resultInput);
    await expect(projectFocusedUnitSelectionProposal({ sources, work, deliverables })).rejects.toThrow(/Общий объём.*2 МБ/);
    expect(work.receipt.parts[0].raw).toBe(workInput.parts[0].raw); expect(deliverables.receipt.parts[0].raw).toBe(resultInput.parts[0].raw);
  });

  it.each(['field', 'evidence'] as const)('rejects the entire selected projection at the %s cap, without partial public fields', async variant => {
    const sources = [source()], selected: string[] = [];
    for (let index = 0; index < (variant === 'field' ? 4 : 501); index++) {
      const id = `extra-${index}`; selected.push(id); sources[0].fragments!.push({ id, locator: `Дополнение ${index}`, text: variant === 'field' ? `${index}: ${'a'.repeat(5500)}` : `Целое условие ${index}.` });
      if (variant === 'field') sources[0].fragments!.push({ id: `separator-${index}`, locator: 'Разделитель', text: 'Контекст.' });
    }
    const request = await input(sources, 'work-scope', selected, [], { maxUnitsPerBatch: variant === 'field' ? 1 : 20 }), before = structuredClone(request);
    const work = await assembleFocusedUnitSelectionRun(request);
    await expect(projectFocusedUnitSelectionProposal({ sources, work })).rejects.toThrow(variant === 'field' ? /20 000/ : /Подтверждения.*500/); expect(request).toEqual(before);
  });
});
