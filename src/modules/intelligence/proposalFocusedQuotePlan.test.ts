import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildProposalFocusedUnitSelectionPlan, parseProposalFocusedUnitSelectionResponse, PROPOSAL_FOCUSED_UNIT_SELECTION_LIMITS, type ProposalFocusedUnitSelectionPlan, type ProposalFocusedUnitSelectionOptions } from './proposalFocusedQuotePlan';
import { taskSourceSnapshotKey } from './taskSourceIdentity';
import type { IntelligenceSource } from './workbenchTypes';

function source(extra = 2): IntelligenceSource {
  const lines = ['Договор', '1. Предмет договора', '1.1. Исполнитель оказывает услуги по проверке учебной системы.', '2. Состав оказываемых услуг',
    ...Array.from({ length: extra }, (_, index) => `2.${index + 1}. Проверить учебный раздел ${index + 1}; при наличии доступа сохранить ограничения.`),
    '3. Итоговые материалы', '3.1. Письменное заключение с сохранением исходных ограничений.', '4. Условия оплаты', '4.1. Оплата производится после подписания акта.'];
  return { id: 'focused-source', name: 'Учебный договор', text: 'AGGREGATE-NOT-A-PRIMARY-UNIT', coverage: { complete: true, requiresOcr: false },
    fragments: lines.map((text, index) => ({ id: `unit-${index}`, locator: `Абзац ${index + 1}`, text })) };
}
function wire(plan: ProposalFocusedUnitSelectionPlan, at = 0, selected: boolean | null = null) {
  return { sourceSnapshotKey: plan.sourceSnapshotKey, batchId: plan.batches[at].id,
    units: Object.fromEntries(plan.batches[at].units.map(unit => [unit.unitId, { selected, reason: 'Учебное решение; предметная правильность проверяется отдельно.' }])) };
}
const payload = (prompt: string) => JSON.parse(prompt.split('sourceUnits (данные): ')[1]);
const reverseKeys = (value: unknown): unknown => Array.isArray(value) ? value.map(reverseKeys) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).reverse().map(([key, part]) => [key, reverseKeys(part)])) : value;
afterEach(() => vi.unstubAllGlobals());

describe('offline single-question unit-selection plan without model transcription', () => {
  it.each(['work-scope', 'deliverables'] as const)('asks only the program-selected %s question with six primary units by default and a closed owner map', async focus => {
    const input = [source()], before = structuredClone(input), instruction = 'Сохранить ограничения материала.';
    const plan = await buildProposalFocusedUnitSelectionPlan(input, { focus, instruction });
    expect(plan.version).toBe(2); expect(plan.purpose).toBe('model-focused-unit-selection'); expect(plan.focus).toBe(focus); expect(plan.instruction).toBe(instruction);
    expect(plan.sourceSnapshotKey).toBe(await taskSourceSnapshotKey(input)); expect(plan.limits.maxUnitsPerBatch).toBe(6);
    expect(plan.batches).toHaveLength(2); expect(plan.batches.flatMap(batch => batch.units.map(unit => unit.text))).toEqual(input[0].fragments!.map(fragment => fragment.text));
    expect(plan.contextWindow).toEqual({ maxBefore: 1, maxAfter: 1, adjacentVisibleOnly: true });
    for (const [index, batch] of plan.batches.entries()) {
      const schema = batch.responseSchema as any, body = payload(batch.prompt), ids = batch.units.map(unit => unit.unitId);
      expect(batch.id).toBe(`${focus}:batch-${index + 1}`); expect(batch.units.length).toBeLessThanOrEqual(6);
      expect(batch.sourcePayloadBytes).toBe(new TextEncoder().encode(JSON.stringify(body)).byteLength); expect(batch.sourcePayloadBytes).toBeLessThanOrEqual(12 * 1024);
      expect(batch.promptBytes).toBe(new TextEncoder().encode(batch.prompt).byteLength); expect(batch.promptBytes).toBeGreaterThan(batch.sourcePayloadBytes);
      expect(schema.required).toEqual(['sourceSnapshotKey', 'batchId', 'units']); expect(schema.additionalProperties).toBe(false);
      expect(schema.properties.units.type).toBe('object'); expect(schema.properties.units.required).toEqual(ids); expect(schema.properties.units.additionalProperties).toBe(false);
      for (const entry of Object.values(schema.properties.units.properties) as any[]) {
        expect(entry.required).toEqual(['selected', 'reason']); expect(entry.additionalProperties).toBe(false);
        expect(Object.keys(entry.properties)).toEqual(['selected', 'reason']); expect(entry.properties.selected.type).toEqual(['boolean', 'null']);
        expect(entry.properties).not.toHaveProperty('quote');
      }
      expect(batch.prompt).toContain('ОДИН вопрос'); expect(batch.prompt).toContain(JSON.stringify(instruction)); expect(batch.prompt).not.toContain(input[0].text);
      expect(batch.prompt).toContain('поле quote запрещено'); expect(batch.prompt).not.toContain('скопируй в quote'); expect(batch.prompt).toContain('получение текста выполняется локально');
      expect(batch.prompt).not.toContain('roles —'); expect(body.units).toEqual(batch.units); expect(body.relatedContextUnits).toEqual(batch.relatedContextUnits);
    }
    const serialized = JSON.stringify(plan); expect(serialized).not.toContain('Выбери дословные свидетельства для подготовки'); expect(plan).not.toHaveProperty('base');
    expect(input).toEqual(before); expect(Object.isFrozen(plan)).toBe(true); expect(Object.isFrozen(plan.batches[0].responseSchema)).toBe(true);
    expect(() => (plan.batches[0].units[0] as { text: string }).text = 'Изменение').toThrow();
  });

  it('rejects source or options edits during a delayed digest before exposing any standalone provider plan', async () => {
    for (const changed of ['source', 'options']) {
      let release!: (value: ArrayBuffer) => void;
      const digest = vi.fn().mockReturnValue(new Promise<ArrayBuffer>(resolve => { release = resolve; }));
      vi.stubGlobal('crypto', { subtle: { digest } });
      const input = [source()], options: ProposalFocusedUnitSelectionOptions = { focus: 'work-scope', instruction: 'Исходное задание', maxUnitsPerBatch: 2 };
      const pending = buildProposalFocusedUnitSelectionPlan(input, options);
      expect(digest).toHaveBeenCalledOnce();
      if (changed === 'source') input[0].fragments![4].text = 'Поздний текст';
      else { options.focus = 'deliverables'; options.instruction = 'Позднее задание'; options.maxUnitsPerBatch = 1; }
      release(new Uint8Array(32).buffer);
      await expect(pending).rejects.toThrow(/изменились во время подготовки/);
      expect(changed === 'source' ? input[0].fragments![4].text : options.instruction).toBe(changed === 'source' ? 'Поздний текст' : 'Позднее задание');
    }
  });

  it('normalizes absent and explicitly undefined optional options to the same bounded defaults', async () => {
    const input = [source()], defaults = await buildProposalFocusedUnitSelectionPlan(input, { focus: 'work-scope' });
    const options: ProposalFocusedUnitSelectionOptions = { focus: 'work-scope', instruction: undefined, maxSourcePayloadBytes: undefined, maxUnitsPerBatch: undefined };
    const explicit = await buildProposalFocusedUnitSelectionPlan(input, options);
    expect(explicit).toEqual(defaults); expect(options).toHaveProperty('instruction', undefined);
    expect(explicit.instruction).toBe(''); expect(explicit.limits).toEqual({ maxSourcePayloadBytes: 12 * 1024, maxUnitsPerBatch: 6 });
  });

  it('refuses every excluded hidden/unselected fragment instead of filtering a source into a whole-source capability', async () => {
    for (const variant of ['hidden', 'veryHidden', 'visible-false'] as const) {
      const input = source(); input.fragments![4].sheetState = variant === 'visible-false' ? 'visible' : variant;
      input.fragments![4].includedByUser = variant !== 'visible-false'; const before = structuredClone(input);
      await expect(buildProposalFocusedUnitSelectionPlan([input], { focus: 'work-scope' })).rejects.toThrow(/полного снимка без скрытых/); expect(input).toEqual(before);
    }
  });

  it('retains strict complete-document, whole-context and source-size admission with no fallback or truncation', async () => {
    const incomplete = source(); incomplete.coverage!.complete = false;
    await expect(buildProposalFocusedUnitSelectionPlan([incomplete], { focus: 'work-scope' })).rejects.toThrow();
    const overlong = source(); overlong.fragments![4].text += 'x'.repeat(13 * 1024);
    await expect(buildProposalFocusedUnitSelectionPlan([overlong], { focus: 'work-scope' })).rejects.toThrow(/Целый фрагмент/);
    await expect(buildProposalFocusedUnitSelectionPlan([source(390)], { focus: 'work-scope' })).rejects.toThrow(/64 последовательных/);
    const plan = await buildProposalFocusedUnitSelectionPlan([source()], { focus: 'work-scope', maxUnitsPerBatch: 2 });
    expect(plan.batches[1].relatedContextUnits.map(unit => unit.fragmentIndex)).toEqual([1, 4]); expect(PROPOSAL_FOCUSED_UNIT_SELECTION_LIMITS.unitsPerBatch).toBe(20);
  });

  it('requires exactly one supported focus and accepts no expanded/unknown task or batch options', async () => {
    for (const options of [{}, { focus: ['work-scope', 'deliverables'] }, { focus: 'payment' }, { focus: 'work-scope', roles: ['scope'] },
      { focus: 'work-scope', maxUnitsPerBatch: 21 }, { focus: 'work-scope', maxUnitsPerBatch: 0 }, { focus: 'work-scope', maxSourcePayloadBytes: 12 * 1024 + 1 },
      { focus: 'work-scope', instruction: 'x'.repeat(20_001) }]) {
      await expect(buildProposalFocusedUnitSelectionPlan([source()], options as never)).rejects.toThrow();
    }
  });
});

describe('focused raw decisions: reference ownership only, not semantic approval or source transcription', () => {
  it('retains true/false/null actual decisions and diagnostic reasons, returning selected owner references without source text', async () => {
    const input = [source()], before = structuredClone(input), plan = await buildProposalFocusedUnitSelectionPlan(input, { focus: 'work-scope' }), data = wire(plan);
    const [first, second] = plan.batches[0].units;
    data.units[first.unitId] = { selected: true, reason: 'Учебный выбор, не предметная приёмка.' }; data.units[second.unitId].selected = false;
    const raw = JSON.stringify(data), result = await parseProposalFocusedUnitSelectionResponse(raw, plan, plan.batches[0].id, input);
    expect(result.units).toEqual(plan.batches[0].units.map(unit => ({ unitId: unit.unitId, ...data.units[unit.unitId] })));
    expect(result.counts).toEqual({ selected: 1, notSelected: 1, unclear: 4 }); expect(result.zeroSelected).toBe(false);
    expect(result.references).toEqual([{ unitId: first.unitId, sourceId: first.sourceId, fragmentId: first.fragmentId, fragmentIndex: first.fragmentIndex, locator: first.locator }]);
    expect(Object.keys(result.references[0])).toEqual(['unitId', 'sourceId', 'fragmentId', 'fragmentIndex', 'locator']);
    expect(result.references[0]).not.toHaveProperty('reason'); expect(result.references[0]).not.toHaveProperty('roles'); expect(result.references[0]).not.toHaveProperty('text'); expect(result.references[0]).not.toHaveProperty('quote');
    expect(result.units[0]).not.toHaveProperty('text'); expect(result.units[0]).not.toHaveProperty('quote'); expect(result).not.toHaveProperty('selections');
    expect(result.version).toBe(2); expect(result.status).toBe('model-focused-unit-selection-only'); expect(result).not.toHaveProperty('items'); expect(result).not.toHaveProperty('confirmed'); expect(result).not.toHaveProperty('canFinalize');
    expect(Object.isFrozen(result.units[0])).toBe(true); expect(Object.isFrozen(result.references)).toBe(true); expect(raw).toBe(JSON.stringify(data)); expect(input).toEqual(before);
  });

  it('accepts all false or all null without references or a claim about semantic quality/absence/fullness', async () => {
    const input = [source()], plan = await buildProposalFocusedUnitSelectionPlan(input, { focus: 'deliverables' });
    for (const selected of [false, null]) {
      const data = wire(plan, 0, selected); data.units[plan.batches[0].units[0].unitId].reason = ',';
      const result = await parseProposalFocusedUnitSelectionResponse(JSON.stringify(data), plan, plan.batches[0].id, input);
      expect(result.zeroSelected).toBe(true); expect(result.references).toEqual([]); expect(result.counts.selected).toBe(0);
      expect(result.units[0].reason).toBe(','); expect(result.counts[selected === false ? 'notSelected' : 'unclear']).toBe(6); expect(result).not.toHaveProperty('complete');
    }
  });

  it('preserves source order independently of JSON key order and refuses swapped-focus replies on the same snapshot', async () => {
    const input = [source()], work = await buildProposalFocusedUnitSelectionPlan(input, { focus: 'work-scope' }), deliverables = await buildProposalFocusedUnitSelectionPlan(input, { focus: 'deliverables' });
    expect(work.sourceSnapshotKey).toBe(deliverables.sourceSnapshotKey); expect(work.batches[0].id).not.toBe(deliverables.batches[0].id);
    const raw = JSON.stringify(reverseKeys(wire(work, 0, true)));
    expect((await parseProposalFocusedUnitSelectionResponse(raw, work, work.batches[0].id, input)).units.map(unit => unit.unitId)).toEqual(work.batches[0].units.map(unit => unit.unitId));
    await expect(parseProposalFocusedUnitSelectionResponse(raw, deliverables, deliverables.batches[0].id, input)).rejects.toThrow(/вопросу/);
    await expect(parseProposalFocusedUnitSelectionResponse(raw, deliverables, work.batches[0].id, input)).rejects.toThrow(/вопросу/);
  });

  it('never emits source text from the parser, even when selected text contains Unicode and original whitespace', async () => {
    const input = [source()]; input[0].fragments![4].text = '  Условное действие 🧪;\r\nпри наличии доступа.\t ';
    const before = structuredClone(input), plan = await buildProposalFocusedUnitSelectionPlan(input, { focus: 'work-scope' }), data = wire(plan, 0, true);
    const parsed = await parseProposalFocusedUnitSelectionResponse(JSON.stringify(data), plan, plan.batches[0].id, input);
    expect(parsed.references[4]).toEqual({ unitId: 'unit-4', sourceId: 'focused-source', fragmentId: 'unit-4', fragmentIndex: 4, locator: 'Абзац 5' });
    expect(JSON.stringify(parsed)).not.toContain('Условное действие'); expect(input).toEqual(before);
  });

  it('rejects all legacy three-field quote responses rather than stripping, repairing or crediting their text', async () => {
    const input = [source()], plan = await buildProposalFocusedUnitSelectionPlan(input, { focus: 'work-scope' }), id = plan.batches[0].units[0].unitId;
    for (const selected of [true, false, null]) {
      const current = wire(plan, 0, selected), legacy = { ...current, units: { ...current.units, [id]: { ...current.units[id], quote: selected === true ? plan.batches[0].units[0].text : null } } };
      const raw = JSON.stringify(legacy);
      await expect(parseProposalFocusedUnitSelectionResponse(raw, plan, plan.batches[0].id, input)).rejects.toThrow(/Частичный отбор/);
      expect(raw).toBe(JSON.stringify(legacy));
    }
  });

  it('bounds diagnostic reason by UTF-16 and rejects extra fields or invalid decision/reason shapes atomically', async () => {
    const input = [source()], plan = await buildProposalFocusedUnitSelectionPlan(input, { focus: 'work-scope' }), id = plan.batches[0].units[0].unitId, data = wire(plan);
    data.units[id].reason = '🧪'.repeat(200);
    expect((await parseProposalFocusedUnitSelectionResponse(JSON.stringify(data), plan, plan.batches[0].id, input)).units[0].reason.length).toBe(400);
    for (const patch of [{ selected: 'true' }, { selected: 0 }, { selected: undefined }, { reason: '' }, { reason: '🧪'.repeat(201) }, { reason: '\ud800' }, { reason: '\u0001' }, { roles: ['scope'] }, { unitId: id }, { price: 100 }]) {
      const invalid = wire(plan); Object.assign(invalid.units[id], patch);
      await expect(parseProposalFocusedUnitSelectionResponse(JSON.stringify(invalid), plan, plan.batches[0].id, input)).rejects.toThrow();
    }
  });

  it('rejects missing/foreign/context keys, duplicate JSON keys and old array/role wire forms without repair', async () => {
    const input = [source()], plan = await buildProposalFocusedUnitSelectionPlan(input, { focus: 'work-scope' }), data = wire(plan), id = plan.batches[0].units[0].unitId;
    const missing = wire(plan); delete missing.units[id];
    const context = wire(plan); context.units[plan.batches[0].relatedContextUnits[0].unitId] = context.units[id]; delete context.units[id];
    const legacy = { ...data, units: plan.batches[0].units.map(unit => ({ unitId: unit.unitId, disposition: 'commercial', roles: ['scope'], quote: unit.text })) };
    for (const invalid of [missing, context, legacy, { ...data, confirmed: true }]) await expect(parseProposalFocusedUnitSelectionResponse(JSON.stringify(invalid), plan, plan.batches[0].id, input)).rejects.toThrow();
    const raw = JSON.stringify(data), duplicated = raw.replace('"unit-0":', '"unit-0":{"selected":null,"reason":"Неясно"},"unit-0":');
    await expect(parseProposalFocusedUnitSelectionResponse(duplicated, plan, plan.batches[0].id, input)).rejects.toThrow(/повторённое поле/);
  });

  it('rejects stale source metadata/content/order and forged serialized plans, without exposing a partial result', async () => {
    const input = [source()], plan = await buildProposalFocusedUnitSelectionPlan(input, { focus: 'work-scope' }), raw = JSON.stringify(wire(plan));
    for (const mutate of [(s: IntelligenceSource) => { s.name += ' changed'; }, (s: IntelligenceSource) => { s.fragments![4].text += ' changed'; },
      (s: IntelligenceSource) => { s.text += ' changed'; }, (s: IntelligenceSource) => { [s.fragments![4], s.fragments![5]] = [s.fragments![5], s.fragments![4]]; }]) {
      const current = structuredClone(input); mutate(current[0]); await expect(parseProposalFocusedUnitSelectionResponse(raw, plan, plan.batches[0].id, current)).rejects.toThrow(/изменился/);
    }
    for (const forged of [structuredClone(plan), { ...plan, focus: 'deliverables' }, null]) await expect(parseProposalFocusedUnitSelectionResponse(raw, forged as ProposalFocusedUnitSelectionPlan, plan.batches[0].id, input)).rejects.toThrow(/исходный неизменный план/);
  });

  it('rejects source edits during asynchronous verification rather than publishing an earlier capture', async () => {
    const input = [source()], plan = await buildProposalFocusedUnitSelectionPlan(input, { focus: 'work-scope' });
    const pending = parseProposalFocusedUnitSelectionResponse(JSON.stringify(wire(plan)), plan, plan.batches[0].id, input); input[0].name += ' changed during parse';
    await expect(pending).rejects.toThrow(/во время проверки/);
  });

  it('retains raw/plan ceilings and uses no provider, worker, network, UI or persistence', async () => {
    const fetch = vi.fn(), Worker = vi.fn(); vi.stubGlobal('fetch', fetch); vi.stubGlobal('Worker', Worker);
    const input = [source()], plan = await buildProposalFocusedUnitSelectionPlan(input, { focus: 'work-scope' });
    await expect(parseProposalFocusedUnitSelectionResponse('я'.repeat(1_048_577), plan, plan.batches[0].id, input)).rejects.toThrow(/2 МБ/);
    const overPlan = await buildProposalFocusedUnitSelectionPlan([source(55)], { focus: 'work-scope', maxUnitsPerBatch: 1, instruction: '\\'.repeat(20_000) }).then(() => false, error => error instanceof Error && /4 МБ/.test(error.message));
    expect(overPlan).toBe(true); await parseProposalFocusedUnitSelectionResponse(JSON.stringify(wire(plan)), plan, plan.batches[0].id, input);
    expect(fetch).not.toHaveBeenCalled(); expect(Worker).not.toHaveBeenCalled();
  });
});
