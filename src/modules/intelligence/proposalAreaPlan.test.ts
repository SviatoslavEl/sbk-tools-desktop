import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildProposalStructuralBlockPlan } from './proposalStructuralBlockPlan';
import { PROPOSAL_AREAS, PROPOSAL_AREA_LIMITS, buildProposalAreaPlan, resolveProposalAreaPlan, parseProposalAreaBlockResponse, resolveProposalAreaBlockResponse, buildProposalAreaReviewPlan, resolveProposalAreaReviewPlan, parseProposalAreaReviewResponse, resolveProposalAreaReviewResponse, type ProposalArea, type ProposalAreaAnswer, type ProposalAreaPlan, type ProposalAreaReviewPlan } from './proposalAreaPlan';
import type { DocxFragmentStructure } from './documentStructure';
import type { IntelligenceFragment, IntelligenceSource } from './workbenchTypes';

function paragraph(index: number, content = `Учебное условие ${index}.`, native: Partial<DocxFragmentStructure> = {}): IntelligenceFragment {
  return { id: `owner-${index}`, locator: `Позиция ${index}`, text: content, structure: { version: 1, format: 'docx', method: 'ooxml', part: 'word/document.xml', kind: 'paragraph', containerId: 'body', order: index, physicalSection: 0, ...native } };
}
function row(index: number, rowIndex: number, rowCount: number, texts: string[], headerMarker = false): IntelligenceFragment {
  return { id: `owner-${index}`, locator: `Строка ${index}`, text: texts.join('\t'), structure: { version: 1, format: 'docx', method: 'ooxml', part: 'word/document.xml', kind: 'table-row', containerId: 'table-A', tableId: 'table-A', order: index, physicalSection: 0, rowIndex, rowCount, headerMarker,
    cells: texts.map((text, cellIndex) => ({ index: cellIndex, text, gridSpan: 1, verticalMerge: 'none', nestedTableCount: 0 })) } };
}
const auxiliary = (index: number) => paragraph(index, 'Целое вспомогательное условие.', { kind: 'header-footer', part: `word/header${index}.xml`, containerId: `aux-${index}` });
const source = (fragments: IntelligenceFragment[]): IntelligenceSource[] => [{ id: 'synthetic-source', name: 'Учебный документ', sha256: 'b'.repeat(64), text: 'AGGREGATE IS NOT SELECTED EVIDENCE', fragments, coverage: { complete: true, requiresOcr: false } }];
type FixtureAnswer = { status: ProposalAreaAnswer['status']; answer: string | null; evidenceRefs: Array<{ ownerId: string; cellIndex: number | null }> };
const noAnswer = (status: 'not-stated' | 'unclear' = 'not-stated'): FixtureAnswer => ({ status, answer: null, evidenceRefs: [] });
function extraction(plan: ProposalAreaPlan, index = 0) {
  const owner = plan.blocks[index].primary[0], areas = Object.fromEntries(PROPOSAL_AREAS.map(area => [area, noAnswer()])) as Record<ProposalArea, FixtureAnswer>;
  areas['work-scope'] = { status: 'answered', answer: '  Учебный неизменённый whole bundle.\r\nВторое утверждение.  ', evidenceRefs: [{ ownerId: owner.ownerId, cellIndex: owner.structure.kind === 'table-row' ? 0 : null }] };
  return { planKey: plan.planKey, sourceSnapshotKey: plan.sourceSnapshotKey, structureSnapshotKey: plan.structureSnapshotKey, blockId: plan.blocks[index].id, areas };
}
function review(plan: ProposalAreaReviewPlan) {
  return { reviewPlanKey: plan.reviewPlanKey, planKey: plan.planKey, sourceSnapshotKey: plan.sourceSnapshotKey, structureSnapshotKey: plan.structureSnapshotKey, blockId: plan.blockId,
    areas: Object.fromEntries(PROPOSAL_AREAS.map(area => [area, { verdict: 'supported', reason: 'Синтетическая ошибающаяся модельная оценка, не предметная приёмка.' }])) };
}
const parse = (wire: unknown, plan: ProposalAreaPlan, input: IntelligenceSource[], index = 0) => parseProposalAreaBlockResponse(JSON.stringify(wire), plan, plan.blocks[index].id, input);
const parseReview = (wire: unknown, reviewPlan: ProposalAreaReviewPlan, plan: ProposalAreaPlan, input: IntelligenceSource[]) => parseProposalAreaReviewResponse(JSON.stringify(wire), reviewPlan, plan, input);
const payload = (prompt: string) => prompt.split('Целый блок (данные): ')[1];
afterEach(() => vi.unstubAllGlobals());

describe('whole physical frame seven-area protocol, not a semantic quality claim', () => {
  it('preserves complete original grouping, native headers/context and exact source payload while asking all seven questions once per frame', async () => {
    const fragments = [paragraph(0), paragraph(1), row(2, 0, 2, ['Валюта и условие согласования'], true), row(3, 1, 2, ['Действие', 'Результат']), auxiliary(4)], input = source(fragments), before = structuredClone(input);
    const base = await buildProposalStructuralBlockPlan(input, { focus: 'work-scope' }), plan = await buildProposalAreaPlan(input);
    expect(plan.blocks).toHaveLength(base.blocks.length); expect(plan.coverage).toEqual(base.coverage); expect(plan.limits).toEqual(base.limits);
    expect(plan.blocks.flatMap(block => block.primary.map(owner => [owner.ownerId, owner.text, owner.structure]))).toEqual(base.blocks.flatMap(block => block.primary.map(owner => [owner.ownerId, owner.text, owner.structure])));
    for (const [index, block] of plan.blocks.entries()) {
      expect(block.id).toBe(base.blocks[index].id); expect(payload(block.prompt)).toBe(payload(base.blocks[index].prompt)); expect(block.sourcePayloadBytes).toBe(base.blocks[index].sourcePayloadBytes);
      expect(block.context).toEqual(base.blocks[index].context); expect(block.prompt).not.toContain(input[0].text);
      for (const area of PROPOSAL_AREAS) expect(block.prompt).toContain(`${area}:`);
      expect(block.responseSchema).toHaveProperty('properties.areas.required', [...PROPOSAL_AREAS]); expect(block.responseSchema).not.toHaveProperty('properties.rawSHA256');
    }
    expect(plan.coverage.canonicalPrimaryOwners).toBe(fragments.length); expect(plan.coverage.wholeNativeDocumentClaim).toBe(false); expect(input).toEqual(before);
    expect(Object.isFrozen(plan.blocks[0].primary[0].structure)).toBe(true);
  });

  it('binds normalized options, exact new prompts/questions and full source metadata without accepting area subsets or old focus options', async () => {
    const input = source([paragraph(0)]), plan = await buildProposalAreaPlan(input);
    expect(await buildProposalAreaPlan(input, { instruction: undefined, maxSourcePayloadBytes: undefined, maxOwnersPerProseBlock: undefined })).toEqual(plan);
    expect((await buildProposalAreaPlan(input, { instruction: 'Учесть ограничения.' })).planKey).not.toBe(plan.planKey);
    const changed = structuredClone(input); changed[0].fragments![0].structure!.styleId = 'opaque-native-change'; expect((await buildProposalAreaPlan(changed)).planKey).not.toBe(plan.planKey);
    for (const extra of [{ focus: 'deliverables' }, { areas: ['payment'] }, { instruction: 'x'.repeat(20_001) }, { maxSourcePayloadBytes: 12_289 }, { maxOwnersPerProseBlock: 21 }]) await expect(buildProposalAreaPlan(input, extra as never)).rejects.toThrow();
  });

  it('retains native/full-source admission and all existing size/count caps without fallback or partial planning', async () => {
    const missing = source([paragraph(0)]); delete missing[0].fragments![0].structure; await expect(buildProposalAreaPlan(missing)).rejects.toMatchObject({ code: 'BLOCKED_NEEDS_STRUCTURE' });
    const noSha = source([paragraph(0)]); delete noSha[0].sha256; await expect(buildProposalAreaPlan(noSha)).rejects.toMatchObject({ code: 'BLOCKED_NEEDS_STRUCTURE' });
    for (const mutation of [(value: IntelligenceSource[]) => { value[0].fragments![0].includedByUser = false; }, (value: IntelligenceSource[]) => { value[0].fragments![0].sheetState = 'hidden'; }, (value: IntelligenceSource[]) => { value[0].coverage!.complete = false; }]) {
      const input = source([paragraph(0)]); mutation(input); await expect(buildProposalAreaPlan(input)).rejects.toThrow();
    }
    await expect(buildProposalAreaPlan(source([paragraph(0, 'x'.repeat(13 * 1024))]))).rejects.toMatchObject({ code: 'BLOCKED_LIMITS' });
    await expect(buildProposalAreaPlan(source(Array.from({ length: 65 }, (_, index) => auxiliary(index))))).rejects.toMatchObject({ code: 'BLOCKED_LIMITS' });
    await expect(buildProposalAreaPlan(source(Array.from({ length: 64 }, (_, index) => auxiliary(index))), { instruction: '\\'.repeat(20_000) })).rejects.toThrow(/4/);
    const huge = source([paragraph(0)]); huge[0].text = 'x'.repeat(8 * 1024 * 1024 + 1); await expect(buildProposalAreaPlan(huge)).rejects.toThrow(/8 МБ/);
  });

  it('checks schema/native envelope metrics independently and exposes no token or model-capacity promise', async () => {
    const plan = await buildProposalAreaPlan(source([paragraph(0)])), block = plan.blocks[0];
    expect(block.promptBytes).toBe(new TextEncoder().encode(block.prompt).byteLength); expect(block.schemaBytes).toBe(new TextEncoder().encode(JSON.stringify(block.responseSchema)).byteLength);
    expect(block.schemaBytes).toBeLessThanOrEqual(65_536); expect(block.nativeRequestBodyBytesUpperBound).toBeGreaterThan(block.promptBytes + block.schemaBytes); expect(block.nativeRequestBodyBytesUpperBound).toBeLessThanOrEqual(2_097_152);
    expect(PROPOSAL_AREA_LIMITS).toMatchObject({ payloadBytes: 12_288, frames: 64, planBytes: 4_194_304, schemaBytes: 65_536, schemaDepth: 32, schemaNodes: 10_000, rawBytes: 2_097_152 });
    expect(Object.isFrozen(PROPOSAL_AREAS)).toBe(true);
    expect(block).not.toHaveProperty('contextTokensGuaranteed');
  });

  it('preserves exact answers and each explicit ordered ref list without splitting bundles, copying absent refs or source completion', async () => {
    const input = source([paragraph(0), paragraph(1)]), plan = await buildProposalAreaPlan(input), wire = extraction(plan);
    wire.areas['work-scope'].evidenceRefs = [{ ownerId: 'owner-1', cellIndex: null }, { ownerId: 'owner-0', cellIndex: null }];
    wire.areas.deliverables = { status: 'answered', answer: 'Отдельный модельный результат.', evidenceRefs: [{ ownerId: 'owner-0', cellIndex: null }] };
    wire.areas.schedule = noAnswer('unclear'); const raw = JSON.stringify(wire, null, 2), response = await parseProposalAreaBlockResponse(raw, plan, plan.blocks[0].id, input);
    expect(response.areas).toEqual(wire.areas); expect(response.areas['work-scope'].answer).toBe(wire.areas['work-scope'].answer); expect(response.areas.payment).toEqual(noAnswer());
    expect(response.rawBytes).toBe(new TextEncoder().encode(raw).byteLength); const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
    expect(response.rawSHA256).toBe(`sha256:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`);
    const resolved = await resolveProposalAreaBlockResponse(response, plan, input); expect(resolved.response).toBe(response); expect(resolved.plan).toBe(plan); expect(resolved.block).toBe(plan.blocks[0]);
    expect(response.humanApproval).toBe(false); expect(response.completeness).toBe('not-assessed'); expect(response.providerAuthenticity).toBe('not-attested'); expect(response).not.toHaveProperty('items');
  });

  it('requires all7 closed area keys and fields with exact status types and no answer/ref inheritance', async () => {
    const input = source([paragraph(0)]), plan = await buildProposalAreaPlan(input), wire = extraction(plan);
    const missing = structuredClone(wire); delete (missing.areas as Partial<typeof missing.areas>).payment; await expect(parse(missing, plan, input)).rejects.toThrow(/семи областям/);
    for (const patch of [{ status: ['answered'], answer: null, evidenceRefs: [] }, { status: 'answered', answer: 'X', evidenceRefs: [] }, { status: 'unclear', answer: 'X', evidenceRefs: [] }, { status: 'not-stated', answer: null, evidenceRefs: wire.areas['work-scope'].evidenceRefs },
      { status: 'answered', answer: '', evidenceRefs: wire.areas['work-scope'].evidenceRefs }, { ...wire.areas['work-scope'], quote: 'Forbidden' }]) await expect(parse({ ...wire, areas: { ...wire.areas, payment: patch } }, plan, input)).rejects.toThrow();
    await expect(parse({ ...wire, areas: { ...wire.areas, other: noAnswer() } }, plan, input)).rejects.toThrow();
    await expect(parse({ ...wire, ready: true }, plan, input)).rejects.toThrow();
  });

  it('checks own PRIMARY/native cell pairs, not context or visual merged columns; header conditions remain valid targets', async () => {
    const header = row(0, 0, 2, ['Порядок согласования и валюта'], true), body = row(1, 1, 2, ['Полная\nячейка\tс вложенной таблицей', 'Вторая', '']); body.structure!.cells![0].gridSpan = 3; body.structure!.cells![0].nestedTableCount = 1;
    const input = source([header, body]), plan = await buildProposalAreaPlan(input); expect(plan.blocks[0].kind).toBe('native-table-header'); await parse(extraction(plan), plan, input);
    const wire = extraction(plan, 1); wire.areas['work-scope'].evidenceRefs = [{ ownerId: 'owner-1', cellIndex: 1 }, { ownerId: 'owner-1', cellIndex: 0 }]; expect((await parse(wire, plan, input, 1)).areas['work-scope'].evidenceRefs).toEqual(wire.areas['work-scope'].evidenceRefs);
    for (const refs of [[{ ownerId: 'owner-0', cellIndex: 0 }], [{ ownerId: 'owner-1', cellIndex: null }], [{ ownerId: 'owner-1', cellIndex: 2 }], [{ ownerId: 'owner-1', cellIndex: 3 }], [{ ownerId: 'owner-1', cellIndex: 0.5 }], [...wire.areas['work-scope'].evidenceRefs, ...wire.areas['work-scope'].evidenceRefs]]) await expect(parse({ ...wire, areas: { ...wire.areas, 'work-scope': { ...wire.areas['work-scope'], evidenceRefs: refs } } }, plan, input, 1)).rejects.toThrow();
    const para = source([paragraph(0)]), paraPlan = await buildProposalAreaPlan(para), paraWire = extraction(paraPlan); paraWire.areas['work-scope'].evidenceRefs = [{ ownerId: 'owner-0', cellIndex: 0 }]; await expect(parse(paraWire, paraPlan, para)).rejects.toThrow(/cellIndex:null/);
  });

  it('constrains every area schema to null for whole non-table owners instead of offering a synthetic cell zero', async () => {
    for (const fragments of [[paragraph(0), paragraph(1)], [auxiliary(0)], [paragraph(0, 'Учебная сноска.', { kind: 'note', part: 'word/footnotes.xml', containerId: 'note-1' })]]) {
      const input = source(fragments), before = structuredClone(input), plan = await buildProposalAreaPlan(input);
      for (const block of plan.blocks) for (const area of PROPOSAL_AREAS) {
        expect(block.responseSchema).toHaveProperty(`properties.areas.properties.${area}.properties.evidenceRefs.items.properties.cellIndex`, { type: 'null' });
        expect(block.responseSchema).toHaveProperty(`properties.areas.properties.${area}.properties.evidenceRefs.items.properties.ownerId.enum`, block.primary.map(owner => owner.ownerId));
      }
      const wire = extraction(plan), beforeWire = structuredClone(wire);
      wire.areas['work-scope'].evidenceRefs[0].cellIndex = 0;
      const rejectedWire = structuredClone(wire);
      await expect(parse(wire, plan, input)).rejects.toThrow(/cellIndex:null/);
      expect(wire).toEqual(rejectedWire); // No0→null repair of a returned answer.
      expect((await parse(beforeWire, plan, input)).areas).toEqual(beforeWire.areas);
      expect(input).toEqual(before);
    }
  });

  it('offers only nonempty own native table cell indices in every area, not null, context, empty cells or visual merged columns', async () => {
    const header = row(0, 0, 2, ['Учебное условие заголовка'], true), body = row(1, 1, 2, ['Первая целая ячейка', '', 'Третья целая ячейка']);
    body.structure!.cells![0].gridSpan = 4;
    const input = source([header, body]), plan = await buildProposalAreaPlan(input);
    for (const [index, expected] of [[0, [0]], [1, [0, 2]]] as const) for (const area of PROPOSAL_AREAS) {
      expect(plan.blocks[index].responseSchema).toHaveProperty(`properties.areas.properties.${area}.properties.evidenceRefs.items.properties.cellIndex`, { type: 'integer', enum: expected });
      expect(plan.blocks[index].responseSchema).toHaveProperty(`properties.areas.properties.${area}.properties.evidenceRefs.items.properties.ownerId.enum`, [`owner-${index}`]);
    }
    const wire = extraction(plan, 1); wire.areas['work-scope'].evidenceRefs = [{ ownerId: 'owner-1', cellIndex: 2 }];
    expect((await parse(wire, plan, input, 1)).areas['work-scope'].evidenceRefs).toEqual(wire.areas['work-scope'].evidenceRefs);
    const blankInput = source([row(0, 0, 1, ['', ' '])]), blankPlan = await buildProposalAreaPlan(blankInput);
    for (const area of PROPOSAL_AREAS) expect(blankPlan.blocks[0].responseSchema).toHaveProperty(`properties.areas.properties.${area}.properties.evidenceRefs.maxItems`, 0);
    const blankWire = extraction(blankPlan); blankWire.areas['work-scope'] = noAnswer();
    expect((await parse(blankWire, blankPlan, blankInput)).areas['work-scope']).toEqual(noAnswer());
  });

  it('keeps headings with business actions as PRIMARY and requests semantic area relevance without claiming the parser proves it', async () => {
    const input = source([paragraph(0, 'Учебный идентификатор ALPHA-001.'), auxiliary(1)]);
    input[0].fragments![1].text = 'Исполнитель должен выполнить учебную проверку.';
    const before = structuredClone(input), plan = await buildProposalAreaPlan(input);
    expect(plan.blocks.flatMap(block => block.primary.map(owner => owner.ownerId))).toEqual(['owner-0', 'owner-1']);
    expect(plan.blocks[0].prompt).toContain('answered должен прямо отвечать на вопрос именно этой области');
    expect(plan.blocks[0].prompt).toContain('Это не правило пропуска заголовков');
    const candidateWire = extraction(plan); candidateWire.areas['work-scope'].answer = input[0].fragments![0].text;
    const candidate = await parse(candidateWire, plan, input), reviewPlan = await buildProposalAreaReviewPlan(candidate, plan, input);
    expect(candidate.areas['work-scope'].answer).toBe(candidateWire.areas['work-scope'].answer);
    expect(candidate.semanticReviewRequired).toBe(true); // Formatting is not a semantic relevance oracle.
    expect(reviewPlan.prompt).toContain('точная цитата или верный реквизит не являются supported-ответом на другой вопрос');
    const verdictWire = review(reviewPlan); verdictWire.areas['work-scope'] = { verdict: 'unsupported', reason: 'СИНТЕТИЧЕСКАЯ оценка нерелевантного ответа, не результат реальной модели.' };
    expect((await parseReview(verdictWire, reviewPlan, plan, input)).areas['work-scope'].verdict).toBe('unsupported');
    const business = extraction(plan, 1); business.areas['work-scope'].answer = input[0].fragments![1].text;
    expect((await parse(business, plan, input, 1)).areas['work-scope'].answer).toBe(business.areas['work-scope'].answer);
    expect(input).toEqual(before);
  });

  it('enforces answer/ref/raw bounds and duplicate-key rejection, without rewriting an answer to pass', async () => {
    const input = source([paragraph(0)]), plan = await buildProposalAreaPlan(input), wire = extraction(plan);
    wire.areas['work-scope'].answer = '🧪'.repeat(8000); expect((await parse(wire, plan, input)).areas['work-scope'].answer).toBe(wire.areas['work-scope'].answer);
    for (const value of ['🧪'.repeat(8001), '\ud800', '\u0000']) await expect(parse({ ...wire, areas: { ...wire.areas, 'work-scope': { ...wire.areas['work-scope'], answer: value } } }, plan, input)).rejects.toThrow();
    await expect(parse({ ...wire, areas: { ...wire.areas, 'work-scope': { ...wire.areas['work-scope'], evidenceRefs: Array.from({ length: 21 }, () => ({ ownerId: 'owner-0', cellIndex: null })) } } }, plan, input)).rejects.toThrow();
    const raw = JSON.stringify(wire); await expect(parseProposalAreaBlockResponse(raw.replace('"areas":', '"areas":{},"areas":'), plan, plan.blocks[0].id, input)).rejects.toThrow(/повторённое поле/);
    await expect(parseProposalAreaBlockResponse('я'.repeat(1_048_577), plan, plan.blocks[0].id, input)).rejects.toThrow(/2 МБ/);
  });

  it('rejects forged/cloned/cross-plan capabilities and stale source/structure, including options mutations during async planning', async () => {
    const input = source([paragraph(0)]), plan = await buildProposalAreaPlan(input), raw = JSON.stringify(extraction(plan)), response = await parseProposalAreaBlockResponse(raw, plan, plan.blocks[0].id, input);
    await expect(resolveProposalAreaPlan(structuredClone(plan), input)).rejects.toThrow(); await expect(resolveProposalAreaBlockResponse(structuredClone(response), plan, input)).rejects.toThrow();
    const equivalent = await buildProposalAreaPlan(input); await expect(resolveProposalAreaBlockResponse(response, equivalent, input)).rejects.toThrow();
    const stale = structuredClone(input); stale[0].fragments![0].structure!.styleId = 'changed'; await expect(resolveProposalAreaPlan(plan, stale)).rejects.toThrow();
    let release!: (value: ArrayBuffer) => void; const digest = vi.fn().mockImplementationOnce(() => new Promise<ArrayBuffer>(resolve => { release = resolve; })).mockResolvedValue(new Uint8Array(32).buffer); vi.stubGlobal('crypto', { subtle: { digest } });
    const options = { instruction: 'Исходное' }, pending = buildProposalAreaPlan(input, options); options.instruction = 'Изменено'; release(new Uint8Array(32).buffer); await expect(pending).rejects.toThrow(/Параметры изменились/);
  });

  it('rechecks source after the outer plan-resolver await boundary', async () => {
    const input = source([paragraph(0)]), plan = await buildProposalAreaPlan(input), nativeDigest = crypto.subtle.digest.bind(crypto.subtle); let calls = 0;
    const digest = vi.fn(async (...args: Parameters<SubtleCrypto['digest']>) => { const call = ++calls, output = await nativeDigest(...args); if (call === 3) queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => { input[0].name += ' final outer gap'; })))); return output; });
    vi.stubGlobal('crypto', { subtle: { digest } }); await expect(resolveProposalAreaPlan(plan, input)).rejects.toThrow(/перед возвратом исходного плана/);
  });
});

describe('per-frame seven-area fallible semantic review of original issued whole bundles', () => {
  it('consumes only original extraction objects, keeps all seven bundles/ref lists and whole source unchanged', async () => {
    const input = source([paragraph(0), paragraph(1)]), plan = await buildProposalAreaPlan(input), wire = extraction(plan); wire.areas.schedule = noAnswer('unclear');
    const response = await parse(wire, plan, input), before = structuredClone(response), reviewPlan = await buildProposalAreaReviewPlan(response, plan, input);
    expect(reviewPlan.extractionResponse).toBe(response); expect(reviewPlan.extractionResponse.areas).toEqual(wire.areas); expect(payload(reviewPlan.prompt)).toBe(payload(plan.blocks[0].prompt));
    expect(reviewPlan.prompt).toContain('НЕИЗМЕНЁННЫХ whole-answer bundles'); expect(reviewPlan.prompt).toContain('лишь отсутствие сведений'); expect(reviewPlan.prompt).toContain('unclear исходная область остаётся нерешённой');
    expect(reviewPlan.block.primary).toBe(plan.blocks[0].primary); expect(response).toEqual(before); expect(await resolveProposalAreaReviewPlan(reviewPlan, plan, input)).toBe(reviewPlan);
    await expect(buildProposalAreaReviewPlan(structuredClone(response), plan, input)).rejects.toThrow(); await expect(resolveProposalAreaReviewPlan(structuredClone(reviewPlan), plan, input)).rejects.toThrow();
    expect(reviewPlan.block).not.toHaveProperty('prompt'); expect(Object.isFrozen(reviewPlan.extractionResponse.areas)).toBe(true);
  });

  it('preserves all model verdicts/reasons as fallible diagnostics and never promotes a supported unclear area or repairs missing answers', async () => {
    const input = source([paragraph(0)]), plan = await buildProposalAreaPlan(input), wire = extraction(plan); wire.areas.payment = noAnswer('unclear');
    const response = await parse(wire, plan, input), reviewPlan = await buildProposalAreaReviewPlan(response, plan, input), verdicts = review(reviewPlan);
    verdicts.areas.deliverables = { verdict: 'unsupported', reason: '  Непроверенное пояснение.\r\nНе новый source факт.  ' }; verdicts.areas.schedule = { verdict: 'unclear', reason: 'Нельзя установить.' };
    const raw = JSON.stringify(verdicts, null, 2), result = await parseProposalAreaReviewResponse(raw, reviewPlan, plan, input);
    expect(result.areas).toEqual(verdicts.areas); expect(result.extractionRawSHA256).toBe(response.rawSHA256); expect(result.rawBytes).toBe(new TextEncoder().encode(raw).byteLength);
    expect(result.semanticTruth).toBe('not-proven'); expect(result.humanApproval).toBe(false); expect(result.completeness).toBe('not-assessed'); expect(result.providerAuthenticity).toBe('not-attested');
    expect(reviewPlan.extractionResponse.areas.payment).toEqual(noAnswer('unclear')); expect(result).not.toHaveProperty('answer'); expect(result).not.toHaveProperty('ready');
    const resolved = await resolveProposalAreaReviewResponse(result, reviewPlan, plan, input); expect(resolved.response).toBe(result); expect(resolved.reviewPlan).toBe(reviewPlan); expect(resolved.plan).toBe(plan); expect(resolved.extractionResponse).toBe(response); expect(resolved.block).toBe(reviewPlan.block);
  });

  it('requires every review area with strict enums/reasons and exact bindings, rejecting answer/ref replacement and duplicate keys', async () => {
    const input = source([paragraph(0)]), plan = await buildProposalAreaPlan(input), response = await parse(extraction(plan), plan, input), reviewPlan = await buildProposalAreaReviewPlan(response, plan, input), wire = review(reviewPlan);
    const missing = structuredClone(wire); delete missing.areas.payment; await expect(parseReview(missing, reviewPlan, plan, input)).rejects.toThrow();
    for (const patch of [{ verdict: ['supported'], reason: 'X' }, { verdict: 'SUPPORTED', reason: 'X' }, { verdict: 'supported', reason: '' }, { verdict: 'unclear', reason: '\ud800' }, { verdict: 'supported', reason: '🧪'.repeat(2001) }, { verdict: 'supported', reason: 'X', answer: 'Replacement' }, { verdict: 'supported', reason: 'X', evidenceRefs: [] }]) await expect(parseReview({ ...wire, areas: { ...wire.areas, payment: patch } }, reviewPlan, plan, input)).rejects.toThrow();
    for (const patch of [{ reviewPlanKey: 'other' }, { planKey: 'other' }, { blockId: 'other' }, { rawBytes: 0 }]) await expect(parseReview({ ...wire, ...patch }, reviewPlan, plan, input)).rejects.toThrow();
    const raw = JSON.stringify(wire); await expect(parseProposalAreaReviewResponse(raw.replace('"verdict":', '"verdict":"unclear","verdict":'), reviewPlan, plan, input)).rejects.toThrow(/повторённое поле/);
    await expect(parseProposalAreaReviewResponse('я'.repeat(1_048_577), reviewPlan, plan, input)).rejects.toThrow(/2 МБ/);
  });

  it('binds reviewer jobs to the original exact raw extraction and rejects equivalent clones/other candidate bundles', async () => {
    const input = source([paragraph(0)]), plan = await buildProposalAreaPlan(input), wire = extraction(plan), first = await parse(wire, plan, input);
    const otherRaw = await parseProposalAreaBlockResponse(`${JSON.stringify(wire)}\n`, plan, plan.blocks[0].id, input), reviewPlan = await buildProposalAreaReviewPlan(first, plan, input), otherReview = await buildProposalAreaReviewPlan(otherRaw, plan, input);
    expect(otherReview.reviewPlanKey).not.toBe(reviewPlan.reviewPlanKey); const result = await parseReview(review(reviewPlan), reviewPlan, plan, input);
    await expect(resolveProposalAreaReviewResponse(structuredClone(result), reviewPlan, plan, input)).rejects.toThrow(); await expect(resolveProposalAreaReviewResponse(result, otherReview, plan, input)).rejects.toThrow();
    await expect(parseReview(review(reviewPlan), otherReview, plan, input)).rejects.toThrow(); const clonePlan = await buildProposalAreaPlan(input); await expect(resolveProposalAreaReviewPlan(reviewPlan, clonePlan, input)).rejects.toThrow();
  });

  it('rejects current-source mutation during extraction hashing, review construction and review resolution without publishing late objects', async () => {
    const input = source([paragraph(0)]), plan = await buildProposalAreaPlan(input), response = await parse(extraction(plan), plan, input);
    const pendingReview = buildProposalAreaReviewPlan(response, plan, input); input[0].name += ' changed'; await expect(pendingReview).rejects.toThrow(/изменился/);
    input[0].name = 'Учебный документ'; const reviewPlan = await buildProposalAreaReviewPlan(response, plan, input), result = await parseReview(review(reviewPlan), reviewPlan, plan, input);
    const pending = resolveProposalAreaReviewResponse(result, reviewPlan, plan, input); input[0].name += ' changed during await'; await expect(pending).rejects.toThrow(/изменился/);
  });

  it('rechecks the full source after the final raw digest for both extraction and review before issuing any response', async () => {
    for (const phase of ['extraction', 'review']) {
      const input = source([paragraph(0)]), plan = await buildProposalAreaPlan(input), wire = extraction(plan), response = await parse(wire, plan, input), reviewPlan = await buildProposalAreaReviewPlan(response, plan, input);
      const nativeDigest = crypto.subtle.digest.bind(crypto.subtle); let calls = 0, release!: () => void, signal!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; }), reached = new Promise<void>(resolve => { signal = resolve; });
      const digest = vi.fn(async (...args: Parameters<SubtleCrypto['digest']>) => { const call = ++calls, output = await nativeDigest(...args); if (call === (phase === 'extraction' ? 4 : 5)) { signal(); await gate; } return output; });
      vi.stubGlobal('crypto', { subtle: { digest } });
      const pending = phase === 'extraction' ? parse(wire, plan, input) : parseReview(review(reviewPlan), reviewPlan, plan, input);
      await reached; input[0].name += ' changed during final raw digest'; release(); await expect(pending).rejects.toThrow(/raw-привязанного/);
      vi.unstubAllGlobals();
    }
  });

  it('does no provider, worker, old actual parser replay, persistence or proposal completion', async () => {
    const fetch = vi.fn(), Worker = vi.fn(); vi.stubGlobal('fetch', fetch); vi.stubGlobal('Worker', Worker);
    const input = source([paragraph(0)]), before = structuredClone(input), plan = await buildProposalAreaPlan(input), response = await parse(extraction(plan), plan, input), reviewPlan = await buildProposalAreaReviewPlan(response, plan, input);
    await parseReview(review(reviewPlan), reviewPlan, plan, input); expect(fetch).not.toHaveBeenCalled(); expect(Worker).not.toHaveBeenCalled(); expect(input).toEqual(before);
  });
});
