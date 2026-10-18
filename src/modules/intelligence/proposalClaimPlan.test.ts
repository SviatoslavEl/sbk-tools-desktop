import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildProposalClaimPlan, parseProposalClaimResponse, PROPOSAL_CLAIM_LIMITS, type ProposalClaimPlan } from './proposalClaimPlan';
import { taskSourceSnapshotKey } from './taskSourceIdentity';
import type { IntelligenceSource } from './workbenchTypes';

function source(extra = 3): IntelligenceSource {
  const lines = ['Договор', '1. Предмет договора', '1.1. Исполнитель оказывает услуги по анализу учебной системы.',
    '2. Состав оказываемых услуг', ...Array.from({ length: extra }, (_, index) => `2.${index + 1}. Проверить раздел ${index + 1}; при наличии доступа сохранить все ограничения.`),
    '3. Срок оказания услуг', '3.1. Максимальный срок — 20 рабочих дней после предоставления материалов.'];
  return { id: 'source-a', name: 'Учебный договор', text: 'AGGREGATE-MUST-NEVER-BECOME-UNITS', sha256: 'a'.repeat(64),
    coverage: { complete: true, requiresOcr: false }, fragments: lines.map((text, index) => ({ id: `p-${index}`, locator: `Абзац ${index + 1}`, text })) };
}
const payload = (prompt: string) => JSON.parse(prompt.split('sourceUnits (данные): ')[1]);
function wire(plan: ProposalClaimPlan, batchIndex = 0, disposition = 'context', roles: string[] = ['context']) {
  return { sourceSnapshotKey: plan.sourceSnapshotKey, batchId: plan.batches[batchIndex].id,
    units: plan.batches[batchIndex].units.map(unit => ({ unitId: unit.unitId, disposition, roles: [...roles], explanation: 'Классификация назначения фрагмента требует отдельной предметной проверки.' })) };
}
const reorderKeys = (value: unknown): unknown => Array.isArray(value) ? value.map(reorderKeys) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).reverse().map(([key, part]) => [key, reorderKeys(part)])) : value;
afterEach(() => vi.unstubAllGlobals());

describe('bounded source-unit model classification plan, never a prepared proposal', () => {
  it('keeps every whole selected fragment, exact identity/order and conservative batch bytes/counts', async () => {
    const input = [source(45)], before = structuredClone(input), plan = await buildProposalClaimPlan(input);
    const units = plan.batches.flatMap(batch => batch.units);
    expect(plan.purpose).toBe('model-classification-only'); expect(plan.sourceSnapshotKey).toBe(await taskSourceSnapshotKey(input));
    expect(units.map(unit => ({ id: unit.fragmentId, locator: unit.locator, text: unit.text }))).toEqual(input[0].fragments);
    expect(units.map(unit => unit.fragmentIndex)).toEqual(units.map((_, index) => index));
    expect(units.every(unit => unit.sourceId === input[0].id && unit.unitId === unit.fragmentId)).toBe(true);
    for (const [index, batch] of plan.batches.entries()) {
      expect(batch.id).toBe(`batch-${index + 1}`); expect(batch.index).toBe(index);
      expect(batch.units.length).toBeGreaterThan(0); expect(batch.units.length).toBeLessThanOrEqual(20);
      expect(batch.sourcePayloadBytes).toBe(new TextEncoder().encode(JSON.stringify(payload(batch.prompt))).byteLength);
      expect(batch.sourcePayloadBytes).toBeLessThanOrEqual(12 * 1024);
      expect(batch.prompt).not.toContain(input[0].text);
      const schema = batch.responseSchema as any;
      expect(schema.additionalProperties).toBe(false); expect(schema.properties.units.minItems).toBe(batch.units.length);
      expect(schema.properties.units.maxItems).toBe(batch.units.length);
      expect(schema.properties.units.items.properties.unitId.enum).toEqual(batch.units.map(unit => unit.unitId));
    }
    expect(input).toEqual(before); expect(Object.isFrozen(plan)).toBe(true); expect(Object.isFrozen(plan.batches[0].responseSchema)).toBe(true);
    expect(() => (plan.batches[0].units[0] as { text: string }).text = 'Поздняя правка').toThrow();
  });

  it('counts serialized UTF-8 at the exact boundary and rejects one overlong original unit rather than slicing it', async () => {
    const input = source(), at = 4;
    const unit = { unitId: input.fragments![at].id!, sourceId: input.id, fragmentId: input.fragments![at].id!, fragmentIndex: at, locator: input.fragments![at].locator, text: '' };
    const overhead = new TextEncoder().encode(JSON.stringify({ sourceId: input.id, sourceSnapshotKey: `sha256:${'a'.repeat(64)}`, units: [unit] })).byteLength;
    const remaining = PROPOSAL_CLAIM_LIMITS.payloadBytes - overhead;
    input.fragments![at].text = 'я'.repeat(Math.floor(remaining / 2)) + 'x'.repeat(remaining % 2);
    const before = structuredClone(input), plan = await buildProposalClaimPlan([input], { maxUnitsPerBatch: 1 });
    expect(plan.batches.find(batch => batch.units[0].fragmentIndex === at)!.sourcePayloadBytes).toBe(PROPOSAL_CLAIM_LIMITS.payloadBytes);
    input.fragments![at].text += 'x';
    await expect(buildProposalClaimPlan([input])).rejects.toThrow(/Целый фрагмент.*не усечён/);
    expect(input.fragments![at].text).toBe(before.fragments![at].text + 'x');
  });

  it('never sends hidden material or restores aggregate text, while the full original snapshot still binds it', async () => {
    const input = source(); input.fragments!.splice(2, 0, { id: 'hidden-private', locator: 'История', text: 'HIDDEN-SECRET-CONTENT', sheetState: 'hidden', includedByUser: true });
    input.fragments![0].includedByUser = false; // Existing visible-false metadata means default visibility, not hidden-sheet opt-in.
    const plan = await buildProposalClaimPlan([input]);
    expect(plan.batches.flatMap(batch => batch.units).map(unit => unit.fragmentId)).toContain('p-0');
    expect(plan.batches.flatMap(batch => batch.units).map(unit => unit.fragmentId)).not.toContain('hidden-private');
    expect(plan.excludedHiddenFragments).toEqual([{ fragmentIndex: 2, fragmentId: 'hidden-private' }]);
    expect(plan.batches.every(batch => !/HIDDEN-SECRET|hidden-private|AGGREGATE-MUST/.test(batch.prompt))).toBe(true);
    const reply = JSON.stringify(wire(plan)); input.fragments![2].text += ' changed';
    await expect(parseProposalClaimResponse(reply, plan, plan.batches[0].id, [input])).rejects.toThrow(/изменился/);
  });

  it.each(['empty', 'undefined'] as const)('does not reinterpret %s fragment selection as aggregate source text', async variant => {
    const input = source(); input.text = input.fragments!.map(fragment => fragment.text).join('\n');
    input.fragments = variant === 'empty' ? [] : undefined;
    await expect(buildProposalClaimPlan([input])).rejects.toThrow(/фрагменты/);
  });

  it('fails closed on incomplete/ambiguous/non-document inputs, missing IDs and repeated IDs', async () => {
    const variants: IntelligenceSource[][] = [[], [source(), { ...source(), id: 'other' }]];
    for (const mutate of [
      (s: IntelligenceSource) => { delete s.coverage; }, (s: IntelligenceSource) => { s.coverage!.complete = false; },
      (s: IntelligenceSource) => { s.coverage!.requiresOcr = true; }, (s: IntelligenceSource) => { delete s.fragments![2].id; },
      (s: IntelligenceSource) => { s.coverage!.pagesWithoutText = [2]; },
      (s: IntelligenceSource) => { s.fragments![2].id = s.fragments![0].id; },
      (s: IntelligenceSource) => { s.fragments![0].text = 'Письмо'; },
      (s: IntelligenceSource) => { s.fragments!.push({ id: 'second-contract', locator: 'Другой договор', text: 'Договор' }); },
      (s: IntelligenceSource) => { s.fragments!.forEach(fragment => { fragment.sheetState = 'veryHidden'; }); },
    ]) { const input = source(); mutate(input); variants.push([input]); }
    for (const input of variants) { const before = structuredClone(input); await expect(buildProposalClaimPlan(input)).rejects.toThrow(); expect(input).toEqual(before); }
  });

  it('does not infer missing text or visual completeness from image metadata alone', async () => {
    const input = source(); input.coverage!.pagesWithImages = [1, 2]; input.coverage!.pagesWithoutText = [];
    const before = structuredClone(input), plan = await buildProposalClaimPlan([input]);
    expect(plan.batches.flatMap(batch => batch.units).map(unit => unit.text)).toEqual(input.fragments!.map(fragment => fragment.text));
    expect(plan).not.toHaveProperty('visualCompleteness'); expect(input).toEqual(before);
  });

  it('only allows tighter batch options and rejects too many sequential batches without a partial plan', async () => {
    for (const options of [{ maxUnitsPerBatch: 0 }, { maxUnitsPerBatch: 21 }, { maxUnitsPerBatch: 1.5 }, { maxSourcePayloadBytes: 511 }, { maxSourcePayloadBytes: 12 * 1024 + 1 }, { maxSourcePayloadBytes: Number.NaN }, { maxSourcePayloadBytes: null }, { maxBatches: 1000 }]) {
      await expect(buildProposalClaimPlan([source()], options as never)).rejects.toThrow();
    }
    const input = [source(65)], before = structuredClone(input);
    await expect(buildProposalClaimPlan(input, { maxUnitsPerBatch: 1 })).rejects.toThrow(/64 последовательных/); expect(input).toEqual(before);
  });

  it('captures source/options synchronously before hashing and permits storage key reordering without changing meaning', async () => {
    const original = source(), before = structuredClone(original), options = { maxUnitsPerBatch: 2 };
    const pending = buildProposalClaimPlan([original], options); original.fragments![2].text = 'Поздняя правка'; options.maxUnitsPerBatch = 1;
    const plan = await pending; expect(plan.limits.maxUnitsPerBatch).toBe(2); expect(plan.batches.flatMap(batch => batch.units)[2].text).toBe(before.fragments![2].text);
    const reordered = reorderKeys(JSON.parse(JSON.stringify(plan))) as ProposalClaimPlan;
    const result = await parseProposalClaimResponse(JSON.stringify(wire(plan)), reordered, plan.batches[0].id, [before]);
    expect(result.status).toBe('model-classification-only');
  });
});

describe('atomic classification protocol and exact source/batch ownership', () => {
  it('accepts all-context and all-unclear replies explicitly as zero commercial classifications, not useful CP', async () => {
    const input = [source()], plan = await buildProposalClaimPlan(input), before = structuredClone(input);
    for (const [disposition, roles] of [['context', ['context']], ['unclear', []]] as const) {
      const raw = JSON.stringify(wire(plan, 0, disposition, [...roles])), result = await parseProposalClaimResponse(raw, plan, plan.batches[0].id, input);
      expect(result.zeroCommercial).toBe(true); expect(result.counts.commercial).toBe(0); expect(result.units.length).toBe(plan.batches[0].units.length);
      expect(result.status).toBe('model-classification-only'); expect(result).not.toHaveProperty('raw');
      expect(JSON.stringify(result)).not.toMatch(/canFinalize|confirmed|quote|unitPrice|selectedFields|commercialDocument/);
    }
    expect(input).toEqual(before);
  });

  it('returns only original model labels and explanations with explicit counts, never completes source clauses', async () => {
    const input = [source()], plan = await buildProposalClaimPlan(input), data = wire(plan, 0, 'commercial', ['scope']);
    const raw = JSON.stringify(data), result = await parseProposalClaimResponse(raw, plan, plan.batches[0].id, input);
    expect(result.units).toEqual(data.units); expect(result.counts.commercial).toBe(data.units.length); expect(result.zeroCommercial).toBe(false);
    expect(Object.isFrozen(result.units[0])).toBe(true); expect(result.units[0]).not.toHaveProperty('text'); expect(raw).toBe(JSON.stringify(data));
  });

  it('rejects partial/repeated/reordered/foreign/hidden unit identities atomically', async () => {
    const input = [source()], plan = await buildProposalClaimPlan(input, { maxUnitsPerBatch: 3 });
    const invalid = [wire(plan), wire(plan), wire(plan), wire(plan), wire(plan)];
    invalid[0].units.pop(); invalid[1].units[1] = invalid[1].units[0];
    [invalid[2].units[0], invalid[2].units[1]] = [invalid[2].units[1], invalid[2].units[0]];
    invalid[3].units[0].unitId = plan.batches[1].units[0].unitId; invalid[4].units[0].unitId = 'hidden-or-foreign';
    for (const data of invalid) await expect(parseProposalClaimResponse(JSON.stringify(data), plan, plan.batches[0].id, input)).rejects.toThrow();
  });

  it('rejects stale content/metadata/order/aggregate and a response for another source or batch', async () => {
    const input = [source()], plan = await buildProposalClaimPlan(input), raw = JSON.stringify(wire(plan));
    for (const mutate of [
      (s: IntelligenceSource) => { s.fragments![2].text += ' changed'; }, (s: IntelligenceSource) => { s.fragments![2].locator += ' changed'; },
      (s: IntelligenceSource) => { s.text += ' changed aggregate'; }, (s: IntelligenceSource) => { s.name += ' changed'; },
      (s: IntelligenceSource) => { [s.fragments![4], s.fragments![5]] = [s.fragments![5], s.fragments![4]]; },
    ]) { const current = structuredClone(input); mutate(current[0]); await expect(parseProposalClaimResponse(raw, plan, plan.batches[0].id, current)).rejects.toThrow(/изменился/); }
    for (const patch of [{ sourceSnapshotKey: `sha256:${'b'.repeat(64)}` }, { batchId: 'batch-foreign' }]) await expect(parseProposalClaimResponse(JSON.stringify({ ...wire(plan), ...patch }), plan, plan.batches[0].id, input)).rejects.toThrow();
    await expect(parseProposalClaimResponse(raw, plan, 'batch-missing', input)).rejects.toThrow(/пакету/);
    const changedPlan = structuredClone(plan); (changedPlan.batches[0].units[0] as { text: string }).text += ' changed';
    await expect(parseProposalClaimResponse(raw, changedPlan, plan.batches[0].id, input)).rejects.toThrow(/изменился/);
  });

  it('rejects duplicate/prototype/unknown fields, invented quote/price/approval fields and invalid role/disposition shapes', async () => {
    const input = [source()], plan = await buildProposalClaimPlan(input), raw = JSON.stringify(wire(plan));
    const invalid: unknown[] = [null, [], { ...wire(plan), confirmed: true }, { ...wire(plan), fields: {} }];
    for (const patch of [{ quote: 'Сгенерированная цитата' }, { price: '100' }, { sourceId: 'source-a' }, { roles: ['unknown'] }, { roles: ['scope', 'scope'] }, { disposition: 'resolved' }, { disposition: ['commercial'] }, { disposition: ['context'] }, { disposition: { value: 'context' } }, { disposition: 'commercial', roles: [] }, { disposition: 'commercial', roles: ['context'] }, { explanation: '' }, { explanation: 'x'.repeat(601) }, { explanation: '\u0001' }, { explanation: '\ud800' }]) {
      const data = wire(plan); Object.assign(data.units[0], patch); invalid.push(data);
    }
    for (const data of invalid) await expect(parseProposalClaimResponse(JSON.stringify(data), plan, plan.batches[0].id, input)).rejects.toThrow();
    for (const poisoned of [raw.replace('"units":', '"batchId":"duplicate","units":'), raw.slice(0, -1) + ',"__proto__":{"approved":true}}', raw.slice(0, -1) + ',"constructor":{}}', 'not-json', '```json\n' + raw + '\n```']) {
      await expect(parseProposalClaimResponse(poisoned, plan, plan.batches[0].id, input)).rejects.toThrow();
    }
    expect(({} as { approved?: boolean }).approved).toBeUndefined();
  });

  it('keeps oversized/invalid responses and plans out without IO or partial installation', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const input = [source()], plan = await buildProposalClaimPlan(input), raw = JSON.stringify(wire(plan));
    await expect(parseProposalClaimResponse('я'.repeat(1_048_577), plan, plan.batches[0].id, input)).rejects.toThrow(/2 МБ/);
    const cycle = structuredClone(plan) as unknown as Record<string, unknown>; cycle.self = cycle;
    await expect(parseProposalClaimResponse(raw, cycle as unknown as ProposalClaimPlan, plan.batches[0].id, input)).rejects.toThrow(/циклическая/);
    await expect(parseProposalClaimResponse(raw, { ...plan, unknown: true } as ProposalClaimPlan, plan.batches[0].id, input)).rejects.toThrow(/изменился/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
