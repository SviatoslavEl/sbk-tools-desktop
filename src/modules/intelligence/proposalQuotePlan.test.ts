import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildProposalQuotePlan, isProposalQuoteSelectionCandidate, parseProposalQuoteResponse, PROPOSAL_QUOTE_LIMITS, PROPOSAL_QUOTE_ROLES, type ProposalQuotePlan, type ProposalQuotePlanOptions } from './proposalQuotePlan';
import { taskSourceSnapshotKey } from './taskSourceIdentity';
import type { IntelligenceSource } from './workbenchTypes';

function source(extra = 3): IntelligenceSource {
  const lines = ['Договор', '1. Предмет договора', '1.1. Исполнитель оказывает услуги по анализу учебной системы.',
    '2. Состав оказываемых услуг', ...Array.from({ length: extra }, (_, index) => `2.${index + 1}. Проверить раздел ${index + 1}; при наличии доступа сохранить все ограничения.`),
    '3. Срок оказания услуг', '3.1. Максимальный срок — 20 рабочих дней после предоставления материалов.'];
  return { id: 'source-a', name: 'Учебный договор', text: 'AGGREGATE-NOT-SELECTED-UNITS', sha256: 'a'.repeat(64),
    coverage: { complete: true, requiresOcr: false }, fragments: lines.map((text, index) => ({ id: `p-${index}`, locator: `Абзац ${index + 1}`, text })) };
}
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
const payload = (prompt: string) => JSON.parse(prompt.split('sourceUnits (данные): ')[1]);
function wire(plan: ProposalQuotePlan, batchIndex = 0, disposition: 'commercial' | 'context' | 'unclear' = 'context', roles: string[] = ['context']) {
  return { sourceSnapshotKey: plan.sourceSnapshotKey, batchId: plan.batches[batchIndex].id,
    units: Object.fromEntries(plan.batches[batchIndex].units.map(unit => [unit.unitId, { disposition, roles: [...roles], quote: disposition === 'commercial' ? unit.text : null as string | null }])) };
}
const reorderKeys = (value: unknown): unknown => Array.isArray(value) ? value.map(reorderKeys) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).reverse().map(([key, part]) => [key, reorderKeys(part)])) : value;
afterEach(() => vi.unstubAllGlobals());

describe('standalone proposal route candidate, not strict validation', () => {
  it('recognises one complete eligible contract or technical task from selected visible fragments, without IO or mutation', () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const contract = source(), task = source(); task.fragments![0].text = 'Техническое задание';
    const before = structuredClone(contract);
    expect(isProposalQuoteSelectionCandidate([contract])).toBe(true); expect(isProposalQuoteSelectionCandidate([task])).toBe(true);
    expect(contract).toEqual(before); expect(fetch).not.toHaveBeenCalled();
  });

  it('does not check IDs or payload/snapshot budgets, so strict preflight errors cannot select a silent legacy fallback', async () => {
    const invalidIds = source(); invalidIds.id = ''; delete invalidIds.fragments![1].id; invalidIds.fragments![2].id = invalidIds.fragments![0].id;
    expect(isProposalQuoteSelectionCandidate([invalidIds])).toBe(true); await expect(buildProposalQuotePlan([invalidIds])).rejects.toThrow();
    const largeUnit = source(); largeUnit.fragments![4].text += 'x'.repeat(13 * 1024);
    expect(isProposalQuoteSelectionCandidate([largeUnit])).toBe(true); await expect(buildProposalQuotePlan([largeUnit])).rejects.toThrow(/Целый фрагмент/);
    const inventoryLimited = source(); inventoryLimited.fragments![4].text += 'x'.repeat(21_000);
    expect(isProposalQuoteSelectionCandidate([inventoryLimited])).toBe(true);
    const snapshotLimited = source(); snapshotLimited.text = 'x'.repeat(8 * 1024 * 1024);
    expect(isProposalQuoteSelectionCandidate([snapshotLimited])).toBe(true); await expect(buildProposalQuotePlan([snapshotLimited])).rejects.toThrow(/8 МБ/);
  });

  it('excludes hidden and explicitly unselected fragments when recognising document ownership and subject', () => {
    for (const mutate of [
      (s: IntelligenceSource) => { s.fragments![0].includedByUser = false; },
      (s: IntelligenceSource) => { s.fragments![0].sheetState = 'hidden'; },
      (s: IntelligenceSource) => { s.fragments!.forEach(fragment => { fragment.includedByUser = false; }); },
    ]) { const input = source(); mutate(input); expect(isProposalQuoteSelectionCandidate([input])).toBe(false); }
    const noSubject = source(0); noSubject.fragments![2].includedByUser = false;
    expect(isProposalQuoteSelectionCandidate([noSubject])).toBe(false);
    const excludedOtherDocument = source(); excludedOtherDocument.fragments!.push({ id: 'not-selected', locator: '', text: 'Договор', includedByUser: false });
    expect(isProposalQuoteSelectionCandidate([excludedOtherDocument])).toBe(true);
  });

  it('does not route incomplete, OCR-pending, ambiguous, aggregate-only or non-document material as eligible', () => {
    const cases: IntelligenceSource[][] = [[], [source(), { ...source(), id: 'other' }]];
    for (const mutate of [
      (s: IntelligenceSource) => { delete s.coverage; }, (s: IntelligenceSource) => { s.coverage!.complete = false; },
      (s: IntelligenceSource) => { s.coverage!.requiresOcr = true; }, (s: IntelligenceSource) => { s.coverage!.pagesWithoutText = [1]; },
      (s: IntelligenceSource) => { s.fragments![0].text = 'Письмо'; },
      (s: IntelligenceSource) => { s.fragments!.push({ id: 'second', locator: '', text: 'Договор' }); },
      (s: IntelligenceSource) => { s.text = s.fragments!.map(fragment => fragment.text).join('\n'); delete s.fragments; },
    ]) { const input = source(); mutate(input); cases.push([input]); }
    for (const input of cases) expect(isProposalQuoteSelectionCandidate(input)).toBe(false);
  });
});

describe('bounded evidence-first whole-fragment plan', () => {
  it('owns every original visible unit exactly once in source order, with explicit source and prompt byte boundaries', async () => {
    const input = [source(45)], before = structuredClone(input), options = { instruction: 'Подготовить проект КП на основе выбранного материала.' };
    const plan = await buildProposalQuotePlan(input, options), units = plan.batches.flatMap(batch => batch.units);
    expect(plan.purpose).toBe('model-whole-fragment-selection'); expect(plan.sourceSnapshotKey).toBe(await taskSourceSnapshotKey(input));
    expect(units.map(unit => ({ id: unit.fragmentId, locator: unit.locator, text: unit.text }))).toEqual(input[0].fragments);
    expect(units.map(unit => unit.fragmentIndex)).toEqual(units.map((_, index) => index));
    expect(new Set(units.map(unit => unit.unitId)).size).toBe(units.length);
    expect(plan.instruction).toBe(options.instruction); expect(plan.contextWindow).toEqual({ maxBefore: 1, maxAfter: 1, adjacentVisibleOnly: true });
    for (const [index, batch] of plan.batches.entries()) {
      const body = payload(batch.prompt), schema = batch.responseSchema as any;
      expect(batch.id).toBe(`batch-${index + 1}`); expect(batch.index).toBe(index);
      expect(batch.units.length).toBeGreaterThan(0); expect(batch.units.length).toBeLessThanOrEqual(20);
      expect(batch.relatedContextUnits.length).toBeLessThanOrEqual(2);
      expect(batch.sourcePayloadBytes).toBe(bytes(JSON.stringify(body))); expect(batch.sourcePayloadBytes).toBeLessThanOrEqual(PROPOSAL_QUOTE_LIMITS.payloadBytes);
      expect(batch.promptBytes).toBe(bytes(batch.prompt)); expect(batch.promptBytes).toBeGreaterThan(batch.sourcePayloadBytes);
      expect(batch.prompt).not.toContain(input[0].text); expect(batch.prompt).toContain(JSON.stringify(options.instruction));
      expect(body.units).toEqual(batch.units); expect(body.relatedContextUnits).toEqual(batch.relatedContextUnits);
      expect(schema.additionalProperties).toBe(false); expect(schema.properties.units.type).toBe('object');
      expect(schema.properties.units.additionalProperties).toBe(false);
      expect(schema.properties.units.required).toEqual(batch.units.map(unit => unit.unitId));
      expect(Object.keys(schema.properties.units.properties)).toEqual(batch.units.map(unit => unit.unitId));
      for (const entry of Object.values(schema.properties.units.properties) as any[]) {
        expect(entry.additionalProperties).toBe(false); expect(entry.required).toEqual(['disposition', 'roles', 'quote']);
        expect(entry.properties).not.toHaveProperty('unitId'); expect(entry.properties.quote.type).toEqual(['string', 'null']);
      }
    }
    expect(input).toEqual(before); expect(Object.isFrozen(plan)).toBe(true); expect(Object.isFrozen(plan.batches[0].responseSchema)).toBe(true);
    expect(Object.isFrozen(plan.batches[0].relatedContextUnits)).toBe(true); expect(Object.isFrozen(PROPOSAL_QUOTE_ROLES)).toBe(true);
    expect(() => (plan.batches[0].units[0] as { text: string }).text = 'Поздняя правка').toThrow();
  });

  it('uses at most one whole adjacent context unit on each side, with no output slots or ownership credit for context', async () => {
    const input = [source()], plan = await buildProposalQuotePlan(input, { maxUnitsPerBatch: 2 });
    expect(plan.batches[0].relatedContextUnits.map(unit => unit.fragmentIndex)).toEqual([2]);
    expect(plan.batches[1].relatedContextUnits.map(unit => unit.fragmentIndex)).toEqual([1, 4]);
    expect(plan.batches[plan.batches.length - 1].relatedContextUnits.map(unit => unit.fragmentIndex)).toEqual([7]);
    const raw = JSON.stringify(wire(plan, 1, 'commercial', ['scope'])), result = await parseProposalQuoteResponse(raw, plan, plan.batches[1].id, input);
    expect(result.units).toHaveLength(2); expect(result.selections).toHaveLength(2);
    expect(result.selections.map(unit => unit.fragmentIndex)).toEqual([2, 3]);
    const foreignContext = wire(plan, 1, 'commercial', ['scope']), firstId = plan.batches[1].units[0].unitId;
    foreignContext.units[plan.batches[1].relatedContextUnits[0].unitId] = foreignContext.units[firstId]; delete foreignContext.units[firstId];
    await expect(parseProposalQuoteResponse(JSON.stringify(foreignContext), plan, plan.batches[1].id, input)).rejects.toThrow();
    const expanded = wire(plan, 1); expanded.units[plan.batches[1].relatedContextUnits[0].unitId] = { disposition: 'context', roles: ['context'], quote: null };
    await expect(parseProposalQuoteResponse(JSON.stringify(expanded), plan, plan.batches[1].id, input)).rejects.toThrow();
  });

  it('does not jump hidden/index gaps with related context, leak hidden text, or substitute aggregate text', async () => {
    const input = source(); input.fragments!.splice(2, 0, { id: 'hidden-private', locator: 'История', text: 'HIDDEN-SECRET-CONTENT', sheetState: 'hidden', includedByUser: true });
    const plan = await buildProposalQuotePlan([input], { maxUnitsPerBatch: 2 });
    expect(plan.batches[0].relatedContextUnits).toEqual([]);
    expect(plan.batches[1].relatedContextUnits.map(unit => unit.fragmentIndex)).toEqual([5]);
    expect(plan.batches.flatMap(batch => batch.units).map(unit => unit.unitId)).toContain('p-0');
    expect(plan.excludedHiddenFragments).toEqual([{ fragmentIndex: 2, fragmentId: 'hidden-private' }]);
    expect(plan.batches.every(batch => !/HIDDEN-SECRET|hidden-private|AGGREGATE-NOT/.test(batch.prompt))).toBe(true);
    const reply = JSON.stringify(wire(plan)); input.fragments![2].text += ' changed';
    await expect(parseProposalQuoteResponse(reply, plan, plan.batches[0].id, [input])).rejects.toThrow(/изменился/);
  });

  it('excludes explicitly unselected visible units and their context, while retaining original indices and the full snapshot key', async () => {
    const input = source(); input.fragments![4].includedByUser = false; input.fragments![4].text = 'EXCLUDED-PRIVATE-CLAUSE';
    const before = structuredClone(input), plan = await buildProposalQuotePlan([input], { maxUnitsPerBatch: 2 });
    const units = plan.batches.flatMap(batch => batch.units);
    expect(plan.sourceSnapshotKey).toBe(await taskSourceSnapshotKey([input]));
    expect(units.map(unit => unit.fragmentIndex)).toEqual([0, 1, 2, 3, 5, 6, 7, 8]);
    expect(plan.excludedUnselectedFragments).toEqual([{ fragmentIndex: 4, fragmentId: 'p-4' }]);
    expect(plan.batches[1].relatedContextUnits.map(unit => unit.fragmentIndex)).toEqual([1]);
    expect(plan.batches[2].relatedContextUnits.map(unit => unit.fragmentIndex)).toEqual([7]);
    expect(plan.batches.every(batch => !batch.prompt.includes('EXCLUDED-PRIVATE-CLAUSE') && !batch.units.some(unit => unit.unitId === 'p-4') && !batch.relatedContextUnits.some(unit => unit.unitId === 'p-4'))).toBe(true);
    const raw = JSON.stringify(wire(plan)); input.fragments![4].text += ' changed';
    await expect(parseProposalQuoteResponse(raw, plan, plan.batches[0].id, [input])).rejects.toThrow(/изменился/);
    expect(before.fragments![4].includedByUser).toBe(false);
  });

  it('does not borrow an excluded document heading or subject to qualify the remaining selection', async () => {
    const excludedHeading = source(); excludedHeading.fragments![0].includedByUser = false;
    await expect(buildProposalQuotePlan([excludedHeading])).rejects.toThrow(/выбранных фрагментов/);
    const excludedSubject = source(0); excludedSubject.fragments![2].includedByUser = false;
    await expect(buildProposalQuotePlan([excludedSubject])).rejects.toThrow(/выбранных фрагментов/);
    const allExcluded = source(); allExcluded.fragments!.forEach(fragment => { fragment.includedByUser = false; });
    await expect(buildProposalQuotePlan([allExcluded])).rejects.toThrow(/Нет выбранных видимых/);
  });

  it('budgets full context in UTF-8, shrinking primary batches instead of truncating it', async () => {
    const input = source(6); input.fragments!.forEach((fragment, index) => { if (index >= 4 && index <= 7) fragment.text += 'я'.repeat(500); });
    const plan = await buildProposalQuotePlan([input], { maxSourcePayloadBytes: 6000, maxUnitsPerBatch: 20 });
    expect(plan.batches.length).toBeGreaterThan(1);
    expect(plan.batches.flatMap(batch => batch.units).map(unit => unit.text)).toEqual(input.fragments!.map(fragment => fragment.text));
    expect(plan.batches.every(batch => batch.sourcePayloadBytes <= 6000)).toBe(true);
    for (const batch of plan.batches) expect(batch.sourcePayloadBytes).toBe(bytes(JSON.stringify(payload(batch.prompt))));
  });

  it('accepts the exact UTF-8 context payload limit and blocks the same complete payload one byte below it', async () => {
    const input = [source()]; input[0].fragments![4].text += ' 🧪';
    const initial = await buildProposalQuotePlan(input, { maxUnitsPerBatch: 1 });
    const boundary = Math.max(...initial.batches.map(batch => batch.sourcePayloadBytes));
    expect(boundary).toBeGreaterThanOrEqual(512);
    const exact = await buildProposalQuotePlan(input, { maxUnitsPerBatch: 1, maxSourcePayloadBytes: boundary });
    expect(Math.max(...exact.batches.map(batch => batch.sourcePayloadBytes))).toBe(boundary);
    await expect(buildProposalQuotePlan(input, { maxUnitsPerBatch: 1, maxSourcePayloadBytes: boundary - 1 })).rejects.toThrow(/с соседним контекстом/);
  });

  it('blocks a whole primary plus adjacent context that cannot fit, without silently omitting context', async () => {
    const input = source(); input.fragments![4].text += 'x'.repeat(450);
    await expect(buildProposalQuotePlan([input], { maxSourcePayloadBytes: 1000, maxUnitsPerBatch: 1 })).rejects.toThrow(/с соседним контекстом.*Ничего не усечено/);
    input.fragments![4].text = 'x'.repeat(13 * 1024);
    await expect(buildProposalQuotePlan([input])).rejects.toThrow(/Целый фрагмент.*не усечён/);
  });

  it('keeps long allowed metadata bounded, rather than ignoring it in source byte calculations', async () => {
    const input = source(); input.name = 'n'.repeat(20_000);
    const plan = await buildProposalQuotePlan([input]); expect(plan.batches[0].prompt).not.toContain(input.name);
    input.fragments![3].locator = 'l'.repeat(20_000);
    await expect(buildProposalQuotePlan([input])).rejects.toThrow(/Целый фрагмент/);
    input.name += 'x'; await expect(buildProposalQuotePlan([input])).rejects.toThrow();
  });

  it.each(['empty', 'undefined'] as const)('does not reinterpret %s selection as aggregate source text', async variant => {
    const input = source(); input.text = input.fragments!.map(fragment => fragment.text).join('\n');
    input.fragments = variant === 'empty' ? [] : undefined;
    await expect(buildProposalQuotePlan([input])).rejects.toThrow(/фрагменты/);
  });

  it('requires one complete eligible contract or technical task, no pending OCR or ambiguous ownership', async () => {
    const variants: IntelligenceSource[][] = [[], [source(), { ...source(), id: 'other' }]];
    for (const mutate of [
      (s: IntelligenceSource) => { delete s.coverage; }, (s: IntelligenceSource) => { s.coverage!.complete = false; },
      (s: IntelligenceSource) => { s.coverage!.requiresOcr = true; }, (s: IntelligenceSource) => { s.coverage!.pagesWithoutText = [2]; },
      (s: IntelligenceSource) => { s.fragments![0].text = 'Письмо'; },
      (s: IntelligenceSource) => { s.fragments!.push({ id: 'second-contract', locator: 'Другой договор', text: 'Договор' }); },
      (s: IntelligenceSource) => { s.fragments!.forEach(fragment => { fragment.sheetState = 'veryHidden'; }); },
    ]) { const input = source(); mutate(input); variants.push([input]); }
    for (const input of variants) { const before = structuredClone(input); await expect(buildProposalQuotePlan(input)).rejects.toThrow(); expect(input).toEqual(before); }
    const technical = source(); technical.fragments![0].text = 'Техническое задание';
    expect((await buildProposalQuotePlan([technical])).batches.flatMap(batch => batch.units)).toHaveLength(technical.fragments!.length);
  });

  it('rejects missing/duplicate IDs even in hidden units, invalid Unicode, and no weak snapshot hash fallback', async () => {
    for (const mutate of [
      (s: IntelligenceSource) => { delete s.fragments![2].id; },
      (s: IntelligenceSource) => { s.fragments!.push({ ...s.fragments![0], sheetState: 'hidden' }); },
      (s: IntelligenceSource) => { s.fragments![2].id = 'bad\ud800'; },
      (s: IntelligenceSource) => { s.fragments![2].text += '\ud800'; },
      (s: IntelligenceSource) => { s.fragments![2].locator += '\udfff'; },
    ]) { const input = source(); mutate(input); await expect(buildProposalQuotePlan([input])).rejects.toThrow(); }
    vi.stubGlobal('crypto', undefined); await expect(buildProposalQuotePlan([source()])).rejects.toThrow(/WebCrypto/);
  });

  it.each([
    { maxUnitsPerBatch: 0 }, { maxUnitsPerBatch: 21 }, { maxUnitsPerBatch: 1.5 }, { maxSourcePayloadBytes: 511 },
    { maxSourcePayloadBytes: 12 * 1024 + 1 }, { maxSourcePayloadBytes: Number.NaN }, { maxSourcePayloadBytes: null },
    { maxBatches: 1000 }, { contextUnits: 2 }, { instruction: 5 }, { instruction: 'x'.repeat(20_001) },
    { instruction: '\ud800' }, { instruction: '\u0001' },
  ])('only accepts closed, tighter bounded options (case %#)', async options => {
    await expect(buildProposalQuotePlan([source()], options as never)).rejects.toThrow();
  });

  it('rejects excess sequential batches without partial output and keeps 20k task instructions separate from source payload bounds', async () => {
    await expect(buildProposalQuotePlan([source(65)], { maxUnitsPerBatch: 1 })).rejects.toThrow(/64 последовательных/);
    const instruction = 'x'.repeat(20_000), plan = await buildProposalQuotePlan([source()], { instruction });
    expect(plan.instruction).toBe(instruction); expect(plan.batches[0].promptBytes).toBeGreaterThan(20_000);
    expect(plan.batches[0].sourcePayloadBytes).toBeLessThan(12 * 1024);
  });

  it('fails closed rather than truncating an over-4MiB plan or over-8MiB complete source snapshot', async () => {
    const overPlan = await buildProposalQuotePlan([source(55)], { maxUnitsPerBatch: 1, instruction: '\\'.repeat(20_000) }).then(() => false, (error: unknown) => error instanceof Error && /план.*4 МБ/i.test(error.message));
    expect(overPlan).toBe(true);
    const input = source(); input.text = 'x'.repeat(8 * 1024 * 1024);
    await expect(buildProposalQuotePlan([input])).rejects.toThrow(/8 МБ/);
  });

  it('captures source and options before any await, rather than borrowing later edits', async () => {
    const input = [source()], before = structuredClone(input), options: ProposalQuotePlanOptions = { maxUnitsPerBatch: 2, instruction: 'Исходное задание' };
    const pending = buildProposalQuotePlan(input, options); input[0].fragments![2].text = 'Поздняя правка'; options.instruction = 'Позднее задание'; options.maxUnitsPerBatch = 1;
    const plan = await pending;
    expect(plan.instruction).toBe('Исходное задание'); expect(plan.limits.maxUnitsPerBatch).toBe(2);
    expect(plan.batches.flatMap(batch => batch.units)[2].text).toBe(before[0].fragments![2].text);
    const current = reorderKeys(before) as IntelligenceSource[];
    expect((await parseProposalQuoteResponse(JSON.stringify(wire(plan)), plan, plan.batches[0].id, current)).zeroCommercial).toBe(true);
  });
});

describe('atomic exact-quote response protocol, never model semantic acceptance', () => {
  it('retains only actual model-selected whole quotes, identities and roles, without local enrichment or business approvals', async () => {
    const input = [source()], before = structuredClone(input), plan = await buildProposalQuotePlan(input), data = wire(plan, 0, 'commercial', ['scope', 'dependency']);
    const raw = JSON.stringify(data), result = await parseProposalQuoteResponse(raw, plan, plan.batches[0].id, input);
    expect(result.units).toEqual(plan.batches[0].units.map(unit => ({ unitId: unit.unitId, ...data.units[unit.unitId] }))); expect(result.selections).toEqual(plan.batches[0].units.map(unit => ({
      unitId: unit.unitId, sourceId: unit.sourceId, fragmentId: unit.fragmentId, fragmentIndex: unit.fragmentIndex,
      locator: unit.locator, roles: ['scope', 'dependency'], quote: unit.text,
    })));
    expect(result.counts).toEqual({ commercial: Object.keys(data.units).length, context: 0, unclear: 0 }); expect(result.zeroCommercial).toBe(false);
    expect(result.status).toBe('model-quote-selection-only'); expect(result).not.toHaveProperty('raw'); expect(result).not.toHaveProperty('confirmed');
    expect(result).not.toHaveProperty('canFinalize'); expect(result).not.toHaveProperty('item');
    expect(Object.isFrozen(result.units[0].roles)).toBe(true); expect(Object.isFrozen(result.selections[0])).toBe(true);
    expect(raw).toBe(JSON.stringify(data)); expect(input).toEqual(before);
  });

  it('accepts object-key reordering without changing owner order, repairing IDs or rewriting the original raw', async () => {
    const input = [source()], plan = await buildProposalQuotePlan(input), ordered = wire(plan, 0, 'commercial', ['scope']);
    const raw = JSON.stringify(reorderKeys(ordered)), before = raw;
    expect(Object.keys(JSON.parse(raw).units)).toEqual(plan.batches[0].units.map(unit => unit.unitId).reverse());
    const result = await parseProposalQuoteResponse(raw, plan, plan.batches[0].id, input);
    expect(result.units).toEqual(plan.batches[0].units.map(unit => ({ unitId: unit.unitId, ...ordered.units[unit.unitId] })));
    expect(result.selections.map(selection => selection.unitId)).toEqual(plan.batches[0].units.map(unit => unit.unitId)); expect(raw).toBe(before);
  });

  it('uses exact own keys even for integer-like/prototype-named source IDs, never inherited properties or insertion-order ownership', async () => {
    const input = [source()]; ['8', '3', '__proto__', 'constructor', 'toString'].forEach((id, index) => { input[0].fragments![index].id = id; });
    const plan = await buildProposalQuotePlan(input), data = wire(plan, 0, 'commercial', ['scope']), raw = JSON.stringify(data);
    expect(Object.keys(data.units).slice(0, 2)).toEqual(['3', '8']);
    const result = await parseProposalQuoteResponse(raw, plan, plan.batches[0].id, input);
    expect(result.units.map(unit => unit.unitId)).toEqual(input[0].fragments!.map(fragment => fragment.id));
    expect(result.selections[2].quote).toBe(input[0].fragments![2].text);
    const missingOwn = wire(plan); Reflect.deleteProperty(missingOwn.units, 'constructor');
    await expect(parseProposalQuoteResponse(JSON.stringify(missingOwn), plan, plan.batches[0].id, input)).rejects.toThrow(/полному списку/);
    expect(({} as { approved?: boolean }).approved).toBeUndefined();
  });

  it('rejects a synthetic 20-row/11-unique p-27 padded legacy response, repeated object keys and a one-key replacement without local repair', async () => {
    const input = [source(40)], plan = await buildProposalQuotePlan(input), batch = plan.batches[1], data = wire(plan, 1, 'commercial', ['scope']);
    expect(batch.units).toHaveLength(20); expect(batch.units.some(unit => unit.unitId === 'p-27')).toBe(true);
    const legacyRows = batch.units.slice(0, 11).map(unit => ({ unitId: unit.unitId, ...data.units[unit.unitId] }));
    while (legacyRows.length < 20) legacyRows.push({ unitId: 'p-27', ...data.units['p-27'] });
    expect(new Set(legacyRows.map(unit => unit.unitId)).size).toBe(11);
    const legacyRaw = JSON.stringify({ ...data, units: legacyRows });
    await expect(parseProposalQuoteResponse(legacyRaw, plan, batch.id, input)).rejects.toThrow(/полному списку/);
    const repeated = Array.from({ length: 20 }, () => `"p-27":${JSON.stringify(data.units['p-27'])}`).join(',');
    const repeatedRaw = `{"sourceSnapshotKey":${JSON.stringify(data.sourceSnapshotKey)},"batchId":${JSON.stringify(data.batchId)},"units":{${repeated}}}`;
    await expect(parseProposalQuoteResponse(repeatedRaw, plan, batch.id, input)).rejects.toThrow(/повторённое поле/);
    await expect(parseProposalQuoteResponse(JSON.stringify({ ...data, units: { 'p-27': data.units['p-27'] } }), plan, batch.id, input)).rejects.toThrow(/полному списку/);
    const paddedValues = { ...data, units: Object.fromEntries(batch.units.map(unit => [unit.unitId, data.units['p-27']])) };
    await expect(parseProposalQuoteResponse(JSON.stringify(paddedValues), plan, batch.id, input)).rejects.toThrow(/изменённую цитату/);
  });

  it('accepts all-context/all-unclear without inventing selected quotes or claiming useful commercial content', async () => {
    const input = [source()], plan = await buildProposalQuotePlan(input);
    for (const disposition of ['context', 'unclear'] as const) {
      const result = await parseProposalQuoteResponse(JSON.stringify(wire(plan, 0, disposition, disposition === 'context' ? ['context'] : [])), plan, plan.batches[0].id, input);
      expect(result.units).toHaveLength(plan.batches[0].units.length); expect(result.counts.commercial).toBe(0);
      expect(result.counts[disposition]).toBe(plan.batches[0].units.length); expect(result.zeroCommercial).toBe(true); expect(result.selections).toEqual([]);
    }
  });

  it('preserves exact Unicode, CRLF, tabs, punctuation, qualifiers and trailing whitespace without normalization', async () => {
    const input = [source()]; input[0].fragments![4].text = '  2.1. Если доступ предоставлен 🧪, сохранить результат;\r\nиначе — не обещать срок.\t ';
    const plan = await buildProposalQuotePlan(input), data = wire(plan, 0, 'commercial', ['dependency']);
    const result = await parseProposalQuoteResponse(JSON.stringify(data), plan, plan.batches[0].id, input);
    expect(result.selections[4].quote).toBe(input[0].fragments![4].text);
    for (const changed of [data.units['p-4'].quote!.trim(), data.units['p-4'].quote!.replace('\r\n', '\n'), data.units['p-4'].quote!.slice(1), '2.1. Сохранить результат']) {
      const invalid = structuredClone(data); invalid.units['p-4'].quote = changed;
      await expect(parseProposalQuoteResponse(JSON.stringify(invalid), plan, plan.batches[0].id, input)).rejects.toThrow(/изменённую цитату/);
    }
  });

  it('rejects a blank commercial unit, cross-unit quotes, absent context-null and noncommercial copied quotes', async () => {
    const input = [source()]; input[0].fragments![4].text = ' \t\n';
    const plan = await buildProposalQuotePlan(input);
    await expect(parseProposalQuoteResponse(JSON.stringify(wire(plan, 0, 'commercial', ['scope'])), plan, plan.batches[0].id, input)).rejects.toThrow();
    const firstId = plan.batches[0].units[0].unitId, context = wire(plan); context.units[firstId].quote = plan.batches[0].units[0].text;
    await expect(parseProposalQuoteResponse(JSON.stringify(context), plan, plan.batches[0].id, input)).rejects.toThrow();
    const cross = wire(plan); cross.units[firstId] = { disposition: 'commercial', roles: ['scope'], quote: plan.batches[0].units[1].text };
    await expect(parseProposalQuoteResponse(JSON.stringify(cross), plan, plan.batches[0].id, input)).rejects.toThrow();
  });

  it('rejects missing, foreign, padded and legacy-array slots before returning any selections', async () => {
    const input = [source()], plan = await buildProposalQuotePlan(input, { maxUnitsPerBatch: 3 });
    const [first, second] = plan.batches[0].units, invalid: unknown[] = [];
    const missing = wire(plan); delete missing.units[first.unitId]; invalid.push(missing);
    const padded = wire(plan, 0, 'commercial', ['scope']); padded.units[second.unitId] = padded.units[first.unitId]; invalid.push(padded);
    const foreign = wire(plan); foreign.units[plan.batches[1].units[0].unitId] = foreign.units[first.unitId]; delete foreign.units[first.unitId]; invalid.push(foreign);
    const hidden = wire(plan); hidden.units['hidden-or-foreign'] = hidden.units[first.unitId]; delete hidden.units[first.unitId]; invalid.push(hidden);
    const oldArray = { ...wire(plan), units: plan.batches[0].units.map(unit => ({ unitId: unit.unitId, disposition: 'context', roles: ['context'], quote: null })) }; invalid.push(oldArray);
    for (const data of invalid) await expect(parseProposalQuoteResponse(JSON.stringify(data), plan, plan.batches[0].id, input)).rejects.toThrow();
  });

  it('rejects stale sources, metadata, aggregate, ordering, incorrect batch or snapshot and forged/serialized plans', async () => {
    const input = [source()], plan = await buildProposalQuotePlan(input), raw = JSON.stringify(wire(plan));
    for (const mutate of [
      (s: IntelligenceSource) => { s.fragments![2].text += ' changed'; }, (s: IntelligenceSource) => { s.fragments![2].locator += ' changed'; },
      (s: IntelligenceSource) => { s.text += ' changed aggregate'; }, (s: IntelligenceSource) => { s.name += ' changed'; },
      (s: IntelligenceSource) => { [s.fragments![4], s.fragments![5]] = [s.fragments![5], s.fragments![4]]; },
    ]) { const current = structuredClone(input); mutate(current[0]); await expect(parseProposalQuoteResponse(raw, plan, plan.batches[0].id, current)).rejects.toThrow(/изменился/); }
    for (const patch of [{ sourceSnapshotKey: `sha256:${'b'.repeat(64)}` }, { batchId: 'batch-foreign' }]) await expect(parseProposalQuoteResponse(JSON.stringify({ ...wire(plan), ...patch }), plan, plan.batches[0].id, input)).rejects.toThrow();
    await expect(parseProposalQuoteResponse(raw, plan, 'batch-missing', input)).rejects.toThrow(/пакету/);
    for (const forged of [structuredClone(plan), JSON.parse(JSON.stringify(plan)), { ...plan, instruction: 'Другой запрос' }, null]) {
      await expect(parseProposalQuoteResponse(raw, forged as ProposalQuotePlan, plan.batches[0].id, input)).rejects.toThrow(/исходный неизменный план/);
    }
  });

  it('detects current source mutation while an asynchronous digest is pending, instead of accepting its earlier capture', async () => {
    const input = [source()], plan = await buildProposalQuotePlan(input), raw = JSON.stringify(wire(plan));
    const pending = parseProposalQuoteResponse(raw, plan, plan.batches[0].id, input); input[0].name += ' changed during parse';
    await expect(pending).rejects.toThrow(/во время проверки/);
  });

  it('rejects duplicate JSON keys, extra/prototype/price/approval fields and malformed closed records', async () => {
    const input = [source()], plan = await buildProposalQuotePlan(input), raw = JSON.stringify(wire(plan));
    const invalid: unknown[] = [null, [], { ...wire(plan), confirmed: true }, { ...wire(plan), fields: {} }];
    for (const patch of [
      { explanation: 'Не требуется пересказ' }, { price: '100' }, { sourceId: 'source-a' }, { unitId: 'p-0' }, { quote: undefined },
      { roles: ['unknown'] }, { roles: ['scope', 'scope'] }, { roles: ['__proto__'] }, { roles: 'scope' },
      { disposition: 'resolved' }, { disposition: ['commercial'] }, { disposition: { value: 'context' } },
      { disposition: 'commercial', roles: [] }, { disposition: 'commercial', roles: ['context'] },
    ]) { const data = wire(plan); Object.assign(data.units[plan.batches[0].units[0].unitId], patch); invalid.push(data); }
    for (const data of invalid) await expect(parseProposalQuoteResponse(JSON.stringify(data), plan, plan.batches[0].id, input)).rejects.toThrow();
    for (const poisoned of [raw.replace('"units":', '"batchId":"duplicate","units":'), raw.replace('"p-0":', '"p-0":{"disposition":"context","roles":[],"quote":null},"p-0":'), raw.replace('"p-0":', '"\\u0070-0":{"disposition":"context","roles":[],"quote":null},"p-0":'), raw.replace('"disposition":', '"disposition":"context","disposition":'), raw.slice(0, -1) + ',"__proto__":{"approved":true}}', raw.slice(0, -1) + ',"constructor":{}}', 'not-json', '```json\n' + raw + '\n```']) {
      await expect(parseProposalQuoteResponse(poisoned, plan, plan.batches[0].id, input)).rejects.toThrow();
    }
    expect(({} as { approved?: boolean }).approved).toBeUndefined();
  });

  it('bounds raw size and performs no model, network, DB or other IO while planning and parsing', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const input = [source()], plan = await buildProposalQuotePlan(input);
    await expect(parseProposalQuoteResponse('я'.repeat(1_048_577), plan, plan.batches[0].id, input)).rejects.toThrow(/2 МБ/);
    await expect(parseProposalQuoteResponse(5 as never, plan, plan.batches[0].id, input)).rejects.toThrow(/текстом JSON/);
    await parseProposalQuoteResponse(JSON.stringify(wire(plan)), plan, plan.batches[0].id, input);
    expect(fetch).not.toHaveBeenCalled();
  });
});
