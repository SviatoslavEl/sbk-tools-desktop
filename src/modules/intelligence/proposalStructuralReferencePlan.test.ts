import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildProposalStructuralBlockPlan } from './proposalStructuralBlockPlan';
import { buildProposalStructuralReferencePlan, parseProposalStructuralReferenceResponse, resolveProposalStructuralReferenceResponse, PROPOSAL_STRUCTURAL_REFERENCE_LIMITS, type ProposalStructuralReferencePlan } from './proposalStructuralReferencePlan';
import type { DocxFragmentStructure } from './documentStructure';
import type { IntelligenceFragment, IntelligenceSource } from './workbenchTypes';

function paragraph(index: number, text = `Учебное условие ${index}.`, native: Partial<DocxFragmentStructure> = {}): IntelligenceFragment {
  return { id: `synthetic-${index}`, locator: `Позиция ${index}`, text, structure: { version: 1, format: 'docx', method: 'ooxml', part: 'word/document.xml', kind: 'paragraph', containerId: 'body', order: index, physicalSection: 0, ...native } };
}
function row(index: number, rowIndex: number, rowCount: number, texts: string[], headerMarker = false): IntelligenceFragment {
  return { id: `synthetic-${index}`, locator: `Строка ${index}`, text: texts.join('\t'), structure: { version: 1, format: 'docx', method: 'ooxml', part: 'word/document.xml', kind: 'table-row', containerId: 'synthetic-table', tableId: 'synthetic-table',
    order: index, physicalSection: 0, rowIndex, rowCount, headerMarker, cells: texts.map((text, cellIndex) => ({ index: cellIndex, text, gridSpan: 1, verticalMerge: 'none', nestedTableCount: 0 })) } };
}
const aux = (index: number) => paragraph(index, `Полное условие вспомогательной части ${index}.`, { part: `word/header${index}.xml`, kind: 'header-footer', containerId: `aux-${index}` });
const source = (fragments: IntelligenceFragment[]): IntelligenceSource[] => [{ id: 'synthetic-source', name: 'Учебный документ', sha256: 'b'.repeat(64), text: 'AGGREGATE IS NOT EVIDENCE', coverage: { complete: true, requiresOcr: false }, fragments }];
const build = (input: IntelligenceSource[], extra = {}) => buildProposalStructuralReferencePlan(input, { focus: 'work-scope', ...extra });
function reply(plan: ProposalStructuralReferencePlan, index = 0, status = 'answered') {
  const block = plan.blocks[index], owner = block.primary[0];
  return { referencePlanKey: plan.referencePlanKey, sourceSnapshotKey: plan.sourceSnapshotKey, structureSnapshotKey: plan.structureSnapshotKey, blockId: block.id, status,
    answer: status === 'answered' ? 'Учебный ответ модели, не предметная приёмка.' : null,
    evidenceRefs: status === 'answered' ? [{ ownerId: owner.ownerId, cellIndex: owner.structure.kind === 'table-row' ? 0 : null }] : [] };
}
const parse = (wire: unknown, plan: ProposalStructuralReferencePlan, input: IntelligenceSource[], index = 0) => parseProposalStructuralReferenceResponse(JSON.stringify(wire), plan, plan.blocks[index].id, input);
const payloadString = (prompt: string) => prompt.split('Целый блок (данные): ')[1];
const byteLength = (value: string) => new TextEncoder().encode(value).byteLength;
afterEach(() => vi.unstubAllGlobals());

describe('new whole-block reference planning, offline and separate from literal protocol', () => {
  it('retains exact whole grouping, payload bytes, continuation and canonical PRIMARY coverage without an added catalog', async () => {
    const fragments = Array.from({ length: 12 }, (_, index) => paragraph(index, `Условие ${index}: ${'Целый учебный текст. '.repeat(35)}`));
    fragments.push(row(12, 0, 2, ['Валюта; НДС; условия'], true), row(13, 1, 2, ['Название', 'Проверить учебный объект.']), aux(14));
    const input = source(fragments), before = structuredClone(input), options = { focus: 'work-scope' as const, maxOwnersPerProseBlock: 3 };
    const base = await buildProposalStructuralBlockPlan(input, options), plan = await buildProposalStructuralReferencePlan(input, options);
    expect(plan.blocks).toHaveLength(base.blocks.length); expect(plan.coverage).toEqual(base.coverage);
    expect(plan.sourceSnapshotKey).toBe(base.sourceSnapshotKey); expect(plan.structureSnapshotKey).toBe(base.structureSnapshotKey);
    expect(plan.blocks.flatMap(block => block.primary.map(owner => [owner.fragmentIndex, owner.ownerId, owner.text]))).toEqual(fragments.map((fragment, index) => [index, fragment.id, fragment.text]));
    for (const [index, block] of plan.blocks.entries()) {
      expect(block.primary).toEqual(base.blocks[index].primary); expect(block.context).toEqual(base.blocks[index].context);
      expect(block.continuation).toEqual(base.blocks[index].continuation); expect(block.table).toEqual(base.blocks[index].table);
      expect(payloadString(block.prompt)).toBe(payloadString(base.blocks[index].prompt));
      expect(block.sourcePayloadBytes).toBe(base.blocks[index].sourcePayloadBytes); expect(block.sourcePayloadBytes).toBe(byteLength(payloadString(block.prompt)));
      expect(block.sourcePayloadBytes).toBeLessThanOrEqual(12 * 1024); expect(block.promptBytes).toBe(byteLength(block.prompt));
      expect(block.responseSchema).not.toHaveProperty('properties.evidence'); expect(block.responseSchema).toHaveProperty('properties.evidenceRefs');
      expect(block.prompt).not.toContain('хотя бы одна короткая дословная цитата'); expect(block.prompt).not.toContain(input[0].text);
      expect(block.prompt).toContain('полный перечень запрошенных действий или результатов');
    }
    expect(plan.coverage.completeOriginalOwnerMapping).toBe(true); expect(plan.coverage.wholeNativeDocumentClaim).toBe(false);
    expect(Object.isFrozen(plan.blocks[0].primary[0].structure)).toBe(true); expect(input).toEqual(before);
  });

  it('binds the new protocol, focus, normalized options and complete source metadata without accepting old options or mutating sources', async () => {
    const input = source([paragraph(0)]), first = await build(input);
    expect(first.version).toBe(1); expect(first.purpose).toBe('model-structural-block-reference-question');
    expect(await build(input, { instruction: undefined, maxSourcePayloadBytes: undefined, maxOwnersPerProseBlock: undefined })).toEqual(first);
    for (const extra of [{ instruction: 'Учесть явно указанные ограничения.' }, { focus: 'deliverables' }, { maxOwnersPerProseBlock: 1 }]) expect((await build(input, extra)).referencePlanKey).not.toBe(first.referencePlanKey);
    const changed = structuredClone(input); changed[0].fragments![0].structure!.styleId = 'opaque-native-value';
    expect((await build(changed)).referencePlanKey).not.toBe(first.referencePlanKey);
    await expect(build(input, { maxUnitsPerBatch: 6 })).rejects.toThrow(/Неизвестные параметры/);
    await expect(build(input, { focus: 'price' })).rejects.toThrow(/Выберите вопрос/);
    await expect(build(input, { maxSourcePayloadBytes: 12 * 1024 + 1 })).rejects.toThrow(/Пределы/);
    await expect(build(input, { maxOwnersPerProseBlock: 21 })).rejects.toThrow(/Пределы/);
    await expect(build(input, { instruction: 'x'.repeat(20_001) })).rejects.toThrow(/20 000/);
  });

  it('retains native admission and source/block/plan bounds with no fallback or partial runnable result', async () => {
    const missing = source([paragraph(0)]); delete missing[0].fragments![0].structure;
    await expect(build(missing)).rejects.toMatchObject({ code: 'BLOCKED_NEEDS_STRUCTURE' });
    const noSha = source([paragraph(0)]); delete noSha[0].sha256; await expect(build(noSha)).rejects.toMatchObject({ code: 'BLOCKED_NEEDS_STRUCTURE' });
    for (const patch of [(input: IntelligenceSource[]) => { input[0].fragments![0].includedByUser = false; }, (input: IntelligenceSource[]) => { input[0].fragments![0].sheetState = 'hidden'; },
      (input: IntelligenceSource[]) => { input[0].coverage!.complete = false; }, (input: IntelligenceSource[]) => { input[0].coverage!.requiresOcr = true; }]) {
      const input = source([paragraph(0)]); patch(input); const before = structuredClone(input); await expect(build(input)).rejects.toThrow(); expect(input).toEqual(before);
    }
    await expect(build(source([paragraph(0, 'x'.repeat(13 * 1024))]))).rejects.toMatchObject({ code: 'BLOCKED_LIMITS' });
    await expect(build(source(Array.from({ length: 65 }, (_, index) => aux(index))))).rejects.toMatchObject({ code: 'BLOCKED_LIMITS' });
    await expect(build(source(Array.from({ length: 64 }, (_, index) => aux(index))), { instruction: '\\'.repeat(20_000) })).rejects.toThrow(/4 МБ/);
    const huge = source([paragraph(0)]); huge[0].text = 'x'.repeat(8 * 1024 * 1024 + 1); await expect(build(huge)).rejects.toThrow(/8 МБ/);
  });

  it('keeps schema and conservative full native envelope below their independent limits', async () => {
    const plan = await build(source([row(0, 0, 1, ['Учебная ячейка', 'Действие'])]));
    const block = plan.blocks[0], schema = block.responseSchema;
    expect(block.schemaBytes).toBe(byteLength(JSON.stringify(schema))); expect(block.schemaBytes).toBeLessThanOrEqual(64 * 1024);
    let nodes = 0, deepest = 0; const stack: Array<{ value: unknown; depth: number }> = [{ value: schema, depth: 0 }];
    while (stack.length) { const { value, depth } = stack.pop()!; nodes++; deepest = Math.max(deepest, depth); if (value && typeof value === 'object') stack.push(...Object.values(value).map(child => ({ value: child, depth: depth + 1 }))); }
    expect(nodes).toBeLessThanOrEqual(10_000); expect(deepest).toBeLessThanOrEqual(32);
    expect(block.nativeRequestBodyBytesUpperBound).toBeGreaterThan(block.promptBytes + block.schemaBytes); expect(block.nativeRequestBodyBytesUpperBound).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(PROPOSAL_STRUCTURAL_REFERENCE_LIMITS).toMatchObject({ schemaBytes: 65_536, schemaDepth: 32, schemaNodes: 10_000, nativeRequestBytes: 2_097_152, blocks: 64, planBytes: 4_194_304, rawBytes: 2_097_152 });
  });

  it('rejects live source/options mutation across asynchronous plan construction', async () => {
    for (const mutation of ['source', 'options']) {
      let release!: (value: ArrayBuffer) => void;
      const digest = vi.fn().mockImplementationOnce(() => new Promise<ArrayBuffer>(resolve => { release = resolve; })).mockResolvedValue(new Uint8Array(32).buffer);
      vi.stubGlobal('crypto', { subtle: { digest } });
      const input = source([paragraph(0)]), options = { focus: 'work-scope' as const, instruction: 'Исходное' }, pending = buildProposalStructuralReferencePlan(input, options);
      if (mutation === 'source') input[0].name += ' изменено'; else options.instruction = 'Изменено';
      release(new Uint8Array(32).buffer); await expect(pending).rejects.toThrow(/изменились во время подготовки/);
    }
  });
});

describe('strict explicit structural references, not semantic evidence or a ready CP', () => {
  it('preserves answer and ordered explicit refs exactly, hashes original raw bytes, and never selects every owner', async () => {
    const input = source([paragraph(0), paragraph(1), paragraph(2)]), before = structuredClone(input), plan = await build(input), wire = reply(plan);
    wire.answer = '  Непроверенный ответ модели.\r\nВторая строка.\n\tТретья строка.  ';
    wire.evidenceRefs = [{ ownerId: 'synthetic-2', cellIndex: null }, { ownerId: 'synthetic-0', cellIndex: null }];
    const raw = JSON.stringify(wire, null, 2), original = raw, result = await parseProposalStructuralReferenceResponse(raw, plan, plan.blocks[0].id, input);
    expect(result.answer).toBe(wire.answer); expect(result.evidenceRefs).toEqual(wire.evidenceRefs); expect(result.evidenceRefs).toHaveLength(2);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
    expect(result.rawSHA256).toBe(`sha256:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`);
    expect((await parseProposalStructuralReferenceResponse(`${raw}\n`, plan, plan.blocks[0].id, input)).rawSHA256).not.toBe(result.rawSHA256);
    expect(result.focus).toBe('work-scope'); expect(result.semanticReviewRequired).toBe(true); expect(Object.isFrozen(result.evidenceRefs[0])).toBe(true);
    for (const absent of ['quote', 'text', 'evidence', 'materializations', 'items', 'selected', 'ready', 'complete', 'canFinalize', 'price']) expect(result).not.toHaveProperty(absent);
    expect(raw).toBe(original); expect(input).toEqual(before);
  });

  it.each(['not-stated', 'unclear'])('retains model %s as a model status, not a local absence or completeness assertion', async status => {
    const input = source([paragraph(0)]), plan = await build(input), wire = reply(plan, 0, status), result = await parse(wire, plan, input);
    expect(result.status).toBe(status); expect(result.answer).toBeNull(); expect(result.evidenceRefs).toEqual([]); expect(result.semanticReviewRequired).toBe(true);
    await expect(parse({ ...wire, answer: 'Нельзя незаметно дополнить ответ.' }, plan, input)).rejects.toThrow();
    await expect(parse({ ...wire, evidenceRefs: [{ ownerId: 'synthetic-0', cellIndex: null }] }, plan, input)).rejects.toThrow();
  });

  it('uses actual native merged/nested cell indices, never gridSpan positions, row null or empty cells', async () => {
    const fragment = row(0, 0, 1, ['Целая ячейка\nВложенная строка\tЗначение', 'Другая целая ячейка', '']);
    fragment.structure!.cells![0] = { ...fragment.structure!.cells![0], gridSpan: 3, verticalMerge: 'restart', nestedTableCount: 1 };
    const input = source([fragment]), plan = await build(input), wire = reply(plan);
    wire.evidenceRefs = [{ ownerId: 'synthetic-0', cellIndex: 1 }, { ownerId: 'synthetic-0', cellIndex: 0 }];
    expect((await parse(wire, plan, input)).evidenceRefs).toEqual(wire.evidenceRefs);
    for (const cellIndex of [null, 2, 3, -1, 0.5, '0', true]) await expect(parse({ ...wire, evidenceRefs: [{ ownerId: 'synthetic-0', cellIndex }] }, plan, input)).rejects.toThrow(/cells.index/);
    expect(plan.blocks[0].primary[0].structure.cells).toEqual(fragment.structure!.cells);
  });

  it('requires null for whole paragraph and auxiliary owners, without inferring references from answer', async () => {
    const input = source([paragraph(0), aux(1)]), plan = await build(input);
    expect((await parse(reply(plan), plan, input)).evidenceRefs).toEqual([{ ownerId: 'synthetic-0', cellIndex: null }]);
    expect((await parse(reply(plan, 1), plan, input, 1)).evidenceRefs).toEqual([{ ownerId: 'synthetic-1', cellIndex: null }]);
    await expect(parse({ ...reply(plan), evidenceRefs: [{ ownerId: 'synthetic-0', cellIndex: 0 }] }, plan, input)).rejects.toThrow(/cellIndex:null/);
    await expect(parse({ ...reply(plan), evidenceRefs: [] }, plan, input)).rejects.toThrow(/сочетание/);
    const empty = source([paragraph(0, '  ')]), emptyPlan = await build(empty); await expect(parse(reply(emptyPlan), emptyPlan, empty)).rejects.toThrow(/непустого/);
  });

  it('keeps native headers as canonical PRIMARY evidence with cell indices, but never accepts them as body-row evidence', async () => {
    const input = source([row(0, 0, 2, ['Условие валюты и ограничения'], true), row(1, 1, 2, ['Выполнить учебную проверку'])]), plan = await build(input);
    expect(plan.blocks[0].kind).toBe('native-table-header'); expect(plan.blocks[1].context[0].owner.ownerId).toBe('synthetic-0');
    expect((await parse(reply(plan), plan, input)).evidenceRefs).toEqual([{ ownerId: 'synthetic-0', cellIndex: 0 }]);
    await expect(parse({ ...reply(plan), evidenceRefs: [{ ownerId: 'synthetic-0', cellIndex: null }] }, plan, input)).rejects.toThrow();
    await expect(parse({ ...reply(plan, 1), evidenceRefs: [{ ownerId: 'synthetic-0', cellIndex: 0 }] }, plan, input, 1)).rejects.toThrow(/контекстная/);
    expect(plan.coverage.canonicalPrimaryOwners).toBe(input[0].fragments!.length);
  });

  it('enforces the owner/cell combination rather than a global cell enum and rejects duplicates/foreign references atomically', async () => {
    const input = source([row(0, 0, 2, ['Первая целая строка'], true), row(1, 1, 2, ['Вторая строка', 'Вторая ячейка'], true)]), plan = await build(input), wire = reply(plan);
    wire.evidenceRefs = [{ ownerId: 'synthetic-1', cellIndex: 1 }]; expect((await parse(wire, plan, input)).evidenceRefs).toEqual(wire.evidenceRefs);
    for (const evidenceRefs of [[{ ownerId: 'synthetic-0', cellIndex: 1 }], [{ ownerId: 'not-a-primary', cellIndex: 0 }], [...wire.evidenceRefs, ...wire.evidenceRefs],
      [{ ...wire.evidenceRefs[0], quote: 'Лишнее поле' }], Array.from({ length: 21 }, () => wire.evidenceRefs[0])]) await expect(parse({ ...wire, evidenceRefs }, plan, input)).rejects.toThrow();
  });

  it('rejects old literal/selection wire, duplicate JSON keys and extra fields, rather than repairing raw', async () => {
    const input = source([paragraph(0)]), plan = await build(input), wire = reply(plan), raw = JSON.stringify(wire);
    await expect(parseProposalStructuralReferenceResponse(raw.replace('"status":', '"status":"unclear","status":'), plan, plan.blocks[0].id, input)).rejects.toThrow(/повторённое поле/);
    const { referencePlanKey: _binding, evidenceRefs: _refs, ...old } = wire;
    await expect(parse({ ...old, evidence: [{ ownerId: 'synthetic-0', quote: input[0].fragments![0].text }] }, plan, input)).rejects.toThrow(/протоколу/);
    await expect(parse({ sourceSnapshotKey: plan.sourceSnapshotKey, batchId: plan.blocks[0].id, units: { 'synthetic-0': { selected: true, reason: 'Учебный выбор' } } }, plan, input)).rejects.toThrow();
    for (const patch of [{ quote: 'Недопустимо' }, { rawSHA256: 'Недопустимо в wire' }, { status: ['answered'], answer: null, evidenceRefs: [] }, { referencePlanKey: 'sha256:other' }, { blockId: 'foreign' }]) await expect(parse({ ...wire, ...patch }, plan, input)).rejects.toThrow();
    expect(raw).toBe(JSON.stringify(wire));
  });

  it('bounds answer Unicode/raw without changing returned text or treating a punctuation answer as semantic success', async () => {
    const input = source([paragraph(0)]), plan = await build(input), wire = reply(plan);
    wire.answer = '🧪'.repeat(8000); expect((await parse(wire, plan, input)).answer).toBe(wire.answer);
    for (const answer of ['🧪'.repeat(8001), '', '  ', '\ud800', '\u0000']) await expect(parse({ ...wire, answer }, plan, input)).rejects.toThrow();
    const punctuation = await parse({ ...wire, answer: ',' }, plan, input); expect(punctuation.answer).toBe(','); expect(punctuation.semanticReviewRequired).toBe(true); expect(punctuation).not.toHaveProperty('ready');
    await expect(parseProposalStructuralReferenceResponse('я'.repeat(1_048_577), plan, plan.blocks[0].id, input)).rejects.toThrow(/2 МБ/);
    await expect(parseProposalStructuralReferenceResponse(`${JSON.stringify(wire)}\ud800`, plan, plan.blocks[0].id, input)).rejects.toThrow(/Unicode/);
  });

  it('rejects forged plans and cross-focus/instruction/source plans, even with otherwise plausible refs', async () => {
    const input = source([paragraph(0)]), plan = await build(input), raw = JSON.stringify(reply(plan));
    await expect(parseProposalStructuralReferenceResponse(raw, structuredClone(plan), plan.blocks[0].id, input)).rejects.toThrow(/исходный/);
    for (const extra of [{ focus: 'deliverables' }, { instruction: 'Другой запрос' }]) {
      const other = await build(input, extra); await expect(parseProposalStructuralReferenceResponse(raw, other, other.blocks[0].id, input)).rejects.toThrow(/протоколу/);
    }
    for (const change of [(current: IntelligenceSource[]) => { current[0].fragments![0].text += ' изменено'; }, (current: IntelligenceSource[]) => { current[0].fragments![0].structure!.styleId = 'changed'; }]) {
      const current = structuredClone(input); change(current); await expect(parseProposalStructuralReferenceResponse(raw, plan, plan.blocks[0].id, current)).rejects.toThrow(/изменились/);
    }
  });

  it('rechecks current source after the additional raw digest await rather than publishing a stale issued response', async () => {
    const input = source([paragraph(0)]), plan = await build(input), raw = JSON.stringify(reply(plan)), nativeDigest = crypto.subtle.digest.bind(crypto.subtle);
    let release!: () => void, signal!: () => void, calls = 0;
    const reached = new Promise<void>(resolve => { signal = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const digest = vi.fn(async (...args: Parameters<SubtleCrypto['digest']>) => {
      const call = ++calls, result = await nativeDigest(...args); if (call === 4) { signal(); await gate; } return result;
    });
    vi.stubGlobal('crypto', { subtle: { digest } }); const pending = parseProposalStructuralReferenceResponse(raw, plan, plan.blocks[0].id, input);
    await reached; input[0].name += ' changed during raw digest'; release(); await expect(pending).rejects.toThrow(/raw ответа/);
  });
});

describe('opaque fresh response capability for a separate honest local materializer', () => {
  it('resolves only an issued unchanged response for the same plan and returns frozen source data, not materialized evidence', async () => {
    const input = source([row(0, 0, 1, ['Исходная ячейка\nс переносом', 'Другое поле'])]), plan = await build(input), wire = reply(plan), response = await parse(wire, plan, input);
    const resolution = await resolveProposalStructuralReferenceResponse(response, plan, input);
    expect(resolution.response).toBe(response); expect(resolution.block).toEqual(plan.blocks[0]); expect(resolution.referencePlanKey).toBe(plan.referencePlanKey);
    expect(Object.isFrozen(resolution)).toBe(true); expect(Object.isFrozen(resolution.block.primary[0].structure.cells![0])).toBe(true);
    expect(response).not.toHaveProperty('text'); expect(response).not.toHaveProperty('materializedEvidence'); expect(resolution).not.toHaveProperty('text');
    await expect(resolveProposalStructuralReferenceResponse(structuredClone(response), plan, input)).rejects.toThrow(/выданный parser/);
    await expect(resolveProposalStructuralReferenceResponse({ ...response, evidenceRefs: [{ ownerId: 'synthetic-0', cellIndex: 1 }] }, plan, input)).rejects.toThrow(/выданный parser/);
    await expect(resolveProposalStructuralReferenceResponse(response, structuredClone(plan), input)).rejects.toThrow(/тот же план/);
    const equivalent = await build(input); await expect(resolveProposalStructuralReferenceResponse(response, equivalent, input)).rejects.toThrow(/тот же план/);
  });

  it('rejects stale and asynchronously changing sources before resolving references', async () => {
    const input = source([paragraph(0)]), plan = await build(input), response = await parse(reply(plan), plan, input);
    const changed = structuredClone(input); changed[0].name += ' changed'; await expect(resolveProposalStructuralReferenceResponse(response, plan, changed)).rejects.toThrow(/изменились/);
    const pending = resolveProposalStructuralReferenceResponse(response, plan, input); input[0].name += ' changed during await'; await expect(pending).rejects.toThrow(/изменились/);
  });

  it('does no HTTP, workers, native execution, persistence or materialization', async () => {
    const fetch = vi.fn(), Worker = vi.fn(); vi.stubGlobal('fetch', fetch); vi.stubGlobal('Worker', Worker);
    const input = source([paragraph(0)]), before = structuredClone(input), plan = await build(input), response = await parse(reply(plan), plan, input);
    await resolveProposalStructuralReferenceResponse(response, plan, input); expect(fetch).not.toHaveBeenCalled(); expect(Worker).not.toHaveBeenCalled(); expect(input).toEqual(before);
  });
});
