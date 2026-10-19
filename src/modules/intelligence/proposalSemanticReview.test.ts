import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildProposalStructuralBlockPlan } from './proposalStructuralBlockPlan';
import { buildProposalSemanticReviewPlan, parseProposalSemanticReviewResponse, resolveProposalSemanticReviewPlan, resolveProposalSemanticReviewResponse, PROPOSAL_SEMANTIC_REVIEW_LIMITS, type ProposalSemanticReviewCandidate, type ProposalSemanticReviewPlan } from './proposalSemanticReview';
import type { DocxFragmentStructure } from './documentStructure';
import type { IntelligenceFragment, IntelligenceSource } from './workbenchTypes';

function paragraph(index: number, content = `Учебное условие ${index}.`, native: Partial<DocxFragmentStructure> = {}): IntelligenceFragment {
  return { id: `owner-${index}`, locator: `Позиция ${index}`, text: content, structure: { version: 1, format: 'docx', method: 'ooxml', part: 'word/document.xml', kind: 'paragraph', containerId: 'body', order: index, physicalSection: 0, ...native } };
}
function row(index: number, rowIndex: number, rowCount: number, texts: string[], headerMarker = false): IntelligenceFragment {
  return { id: `owner-${index}`, locator: `Строка ${index}`, text: texts.join('\t'), structure: { version: 1, format: 'docx', method: 'ooxml', part: 'word/document.xml', kind: 'table-row', containerId: 'table-A', tableId: 'table-A', order: index,
    physicalSection: 0, rowIndex, rowCount, headerMarker, cells: texts.map((text, cellIndex) => ({ index: cellIndex, text, gridSpan: 1, verticalMerge: 'none', nestedTableCount: 0 })) } };
}
const auxiliary = (index: number) => paragraph(index, 'Целое вспомогательное условие.', { kind: 'header-footer', part: `word/header${index}.xml`, containerId: `aux-${index}` });
const source = (fragments: IntelligenceFragment[]): IntelligenceSource[] => [{ id: 'synthetic-source', name: 'Учебный документ', sha256: 'b'.repeat(64), text: 'AGGREGATE IS NOT SELECTED EVIDENCE', fragments, coverage: { complete: true, requiresOcr: false } }];
const candidate = (extra = {}): ProposalSemanticReviewCandidate => ({ text: '  Неизменённый кандидат.\r\nЕщё одно утверждение.  ', evidenceRefs: [{ ownerId: 'owner-0', cellIndex: null }], originalRawSHA256: `sha256:${'a'.repeat(64)}`, origin: 'untrusted-candidate-data', ...extra });
const build = (input: IntelligenceSource[], extra = {}) => buildProposalSemanticReviewPlan(input, { focus: 'work-scope', blockId: 'work-scope:block-1', candidate: candidate(), ...extra });
function reply(plan: ProposalSemanticReviewPlan, verdict = 'supported', reason = 'Учебная модельная оценка; её истинность этим тестом не проверяется.') {
  return { reviewPlanKey: plan.reviewPlanKey, sourceSnapshotKey: plan.sourceSnapshotKey, structureSnapshotKey: plan.structureSnapshotKey, candidateKey: plan.candidateKey, blockId: plan.blockId, verdict, reason };
}
const parse = (wire: unknown, plan: ProposalSemanticReviewPlan, input: IntelligenceSource[]) => parseProposalSemanticReviewResponse(JSON.stringify(wire), plan, input);
const payloadString = (prompt: string) => prompt.split('Целый блок (данные): ')[1];
const byteLength = (value: string) => new TextEncoder().encode(value).byteLength;
afterEach(() => vi.unstubAllGlobals());

describe('whole-answer-bundle review jobs from explicitly untrusted input, not restored model capabilities', () => {
  it('retains the whole candidate and ordered refs unchanged, without splitting or inheriting refs per claim', async () => {
    const input = source([paragraph(0), paragraph(1), paragraph(2)]), data = candidate({ evidenceRefs: [{ ownerId: 'owner-2', cellIndex: null }, { ownerId: 'owner-0', cellIndex: null }] });
    const persistedCopy = JSON.parse(JSON.stringify(data)), before = structuredClone({ input, data }), plan = await build(input, { candidate: persistedCopy });
    expect(plan.candidate).toEqual(data); expect(plan.candidate.text).toBe(data.text); expect(plan.candidate.evidenceRefs).toEqual(data.evidenceRefs);
    expect(plan.provenance).toBe('untrusted-input-not-original-model-capability'); expect(plan.reviewUnit).toBe('unchanged-whole-answer-bundle');
    expect(plan.prompt).toContain(JSON.stringify(data)); expect(plan.prompt).toContain('Кандидат для проверки (недоверенные данные)');
    expect(plan.prompt).toContain('ВСЕ утверждения и существенные уточнения'); expect(plan.prompt).toContain('не могут молча заменить, расширить или исправить');
    for (const absent of ['claims', 'claimIds', 'modelProof', 'originalParserCapability', 'complete', 'ready']) expect(plan).not.toHaveProperty(absent);
    expect(Object.isFrozen(plan.candidate)).toBe(true); expect(Object.isFrozen(plan.candidate.evidenceRefs[0])).toBe(true); expect({ input, data }).toEqual(before);
  });

  it('reuses the exact whole block source payload and keeps full original owner coverage, not an answer-tail completion', async () => {
    const fragments = Array.from({ length: 17 }, (_, index) => paragraph(index, `Условие ${index}: ${'Целый учебный текст. '.repeat(12)}`)), input = source(fragments);
    const base = await buildProposalStructuralBlockPlan(input, { focus: 'work-scope', maxOwnersPerProseBlock: 2 }), plan = await build(input, { maxOwnersPerProseBlock: 2 });
    expect(plan.coverage).toEqual(base.coverage); expect(plan.coverage.canonicalPrimaryOwners).toBe(fragments.length); expect(plan.coverage.completeOriginalOwnerMapping).toBe(true);
    expect(plan.block.primary).toEqual(base.blocks[0].primary); expect(plan.block.context).toEqual(base.blocks[0].context); expect(plan.block.continuation).toEqual(base.blocks[0].continuation);
    expect(payloadString(plan.prompt)).toBe(payloadString(base.blocks[0].prompt)); expect(plan.sourcePayloadBytes).toBe(base.blocks[0].sourcePayloadBytes);
    expect(plan.sourcePayloadBytes).toBe(byteLength(payloadString(plan.prompt))); expect(plan.prompt).not.toContain(input[0].text);
    expect(plan.block).not.toHaveProperty('prompt'); expect(plan.block).not.toHaveProperty('responseSchema'); expect(plan.candidate.text).not.toContain(fragments[1].text);
  });

  it('keeps a native header with actual business conditions as PRIMARY, without a structural absence/skip rule', async () => {
    const input = source([row(0, 0, 2, ['Оплата после письменного согласования; валюта указана отдельно.'], true), row(1, 1, 2, ['Выполнить учебную проверку'])]);
    const data = candidate({ text: 'Кандидат о порядке согласования.', evidenceRefs: [{ ownerId: 'owner-0', cellIndex: 0 }] }), plan = await build(input, { candidate: data });
    expect(plan.block.kind).toBe('native-table-header'); expect(plan.block.primary[0].structure.headerMarker).toBe(true); expect(plan.block.primary[0].text).toBe(input[0].fragments![0].text);
    expect(plan.coverage.ledger[0].contextOccurrences).toHaveLength(1); expect(plan.prompt).toContain('НЕ означает отсутствие деловых условий или фактов');
    const verdict = await parse(reply(plan), plan, input); expect(verdict.verdict).toBe('supported'); expect(verdict.semanticTruth).toBe('not-proven');
    // This mock checks retention/admission boundaries, NOT whether the model
    // can distinguish header conditions from invented obligations in practice.
    expect(verdict.humanApproval).toBe(false); expect(verdict.completeness).toBe('not-assessed');
  });

  it('binds exact candidate text, ordered refs, declared original raw hash, focus, instruction and source structure', async () => {
    const input = source([paragraph(0), paragraph(1)]), first = await build(input);
    for (const data of [candidate({ text: `${candidate().text}\n` }), candidate({ originalRawSHA256: `sha256:${'c'.repeat(64)}` }), candidate({ evidenceRefs: [{ ownerId: 'owner-1', cellIndex: null }] })]) {
      const changed = await build(input, { candidate: data }); expect(changed.candidateKey).not.toBe(first.candidateKey); expect(changed.reviewPlanKey).not.toBe(first.reviewPlanKey);
    }
    const other = await build(input, { focus: 'deliverables', blockId: 'deliverables:block-1' }); expect(other.reviewPlanKey).not.toBe(first.reviewPlanKey);
    expect((await build(input, { instruction: 'Учитывать все явные ограничения.' })).reviewPlanKey).not.toBe(first.reviewPlanKey);
    expect(await build(input, { instruction: undefined, maxSourcePayloadBytes: undefined, maxOwnersPerProseBlock: undefined })).toEqual(first);
    const changed = structuredClone(input); changed[0].fragments![0].structure!.styleId = 'opaque-native-change'; expect((await build(changed)).reviewPlanKey).not.toBe(first.reviewPlanKey);
  });

  it('checks exact PRIMARY owner/cell pairs and never silently repairs context, merged positions, empty cells or paragraph indices', async () => {
    const fragment = row(0, 0, 1, ['Целая\nячейка\tс вложенным текстом', 'Вторая', '']); fragment.structure!.cells![0].gridSpan = 3; fragment.structure!.cells![0].nestedTableCount = 1;
    const input = source([fragment]), good = candidate({ evidenceRefs: [{ ownerId: 'owner-0', cellIndex: 1 }, { ownerId: 'owner-0', cellIndex: 0 }] });
    expect((await build(input, { candidate: good })).candidate.evidenceRefs).toEqual(good.evidenceRefs);
    for (const cellIndex of [null, 2, 3, -1, 0.5, '0']) await expect(build(input, { candidate: candidate({ evidenceRefs: [{ ownerId: 'owner-0', cellIndex }] }) })).rejects.toThrow();
    const para = source([paragraph(0)]); await expect(build(para, { candidate: candidate({ evidenceRefs: [{ ownerId: 'owner-0', cellIndex: 0 }] }) })).rejects.toThrow(/cellIndex:null/);
    const contextual = source([row(0, 0, 2, ['Нативный контекст'], true), row(1, 1, 2, ['Основная строка'])]);
    await expect(build(contextual, { blockId: 'work-scope:block-2', candidate: candidate({ evidenceRefs: [{ ownerId: 'owner-0', cellIndex: 0 }] }) })).rejects.toThrow(/не принадлежит PRIMARY/);
    await expect(build(para, { candidate: candidate({ evidenceRefs: [{ ownerId: 'foreign', cellIndex: null }] }) })).rejects.toThrow(/PRIMARY/);
  });

  it('requires a closed bounded candidate and options, without accepting provider/proof assertions or dropping bad refs', async () => {
    const input = source([paragraph(0)]);
    for (const patch of [{ text: '' }, { text: ' ' }, { text: '\ud800' }, { text: '🧪'.repeat(8001) }, { text: '\u0000' }, { originalRawSHA256: 'a'.repeat(64) }, { originalRawSHA256: `sha256:${'A'.repeat(64)}` },
      { origin: 'original-provider-proof' }, { evidenceRefs: [] }, { evidenceRefs: [candidate().evidenceRefs[0], candidate().evidenceRefs[0]] }, { evidenceRefs: Array.from({ length: 21 }, () => candidate().evidenceRefs[0]) },
      { evidenceRefs: [{ ownerId: 'owner-0', cellIndex: null, quote: 'Extra' }] }, { providerAuthenticated: true }]) await expect(build(input, { candidate: candidate(patch) })).rejects.toThrow();
    for (const extra of [{ focus: 'price' }, { blockId: 'foreign:block' }, { blockId: 'deliverables:block-1' }, { maxUnitsPerBatch: 6 }, { maxSourcePayloadBytes: 12 * 1024 + 1 }, { maxOwnersPerProseBlock: 21 }, { instruction: 'x'.repeat(20_001) }]) await expect(build(input, extra)).rejects.toThrow();
    const nonEnumerable = candidate(); Object.defineProperty(nonEnumerable, 'text', { value: nonEnumerable.text, enumerable: false }); await expect(build(input, { candidate: nonEnumerable })).rejects.toThrow();
  });

  it('preserves source admission, full-source and physical block caps rather than falling back to a partial route', async () => {
    const missing = source([paragraph(0)]); delete missing[0].fragments![0].structure; await expect(build(missing)).rejects.toMatchObject({ code: 'BLOCKED_NEEDS_STRUCTURE' });
    const noSha = source([paragraph(0)]); delete noSha[0].sha256; await expect(build(noSha)).rejects.toMatchObject({ code: 'BLOCKED_NEEDS_STRUCTURE' });
    for (const change of [(current: IntelligenceSource[]) => { current[0].fragments![0].includedByUser = false; }, (current: IntelligenceSource[]) => { current[0].fragments![0].sheetState = 'hidden'; }, (current: IntelligenceSource[]) => { current[0].coverage!.complete = false; }]) {
      const input = source([paragraph(0)]); change(input); const before = structuredClone(input); await expect(build(input)).rejects.toThrow(); expect(input).toEqual(before);
    }
    await expect(build(source([paragraph(0, 'x'.repeat(13 * 1024))]))).rejects.toMatchObject({ code: 'BLOCKED_LIMITS' });
    await expect(build(source(Array.from({ length: 65 }, (_, index) => auxiliary(index))))).rejects.toMatchObject({ code: 'BLOCKED_LIMITS' });
    await expect(build(source(Array.from({ length: 64 }, (_, index) => auxiliary(index))), { instruction: '\\'.repeat(20_000) })).rejects.toThrow(/4 МБ/);
    const huge = source([paragraph(0)]); huge[0].text = 'x'.repeat(8 * 1024 * 1024 + 1); await expect(build(huge)).rejects.toThrow(/8 МБ/);
  });

  it('keeps schema, raw and conservative complete native request limits independent of the source12KiB cap', async () => {
    const input = source([paragraph(0)]), plan = await build(input, { candidate: candidate({ text: '🧪'.repeat(8000) }) });
    expect(plan.candidate.text).toHaveLength(16_000); expect(plan.schemaBytes).toBe(byteLength(JSON.stringify(plan.responseSchema))); expect(plan.schemaBytes).toBeLessThanOrEqual(65_536);
    expect(plan.promptBytes).toBe(byteLength(plan.prompt)); expect(plan.nativeRequestBodyBytesUpperBound).toBeGreaterThan(plan.promptBytes + plan.schemaBytes); expect(plan.nativeRequestBodyBytesUpperBound).toBeLessThanOrEqual(2_097_152);
    expect(PROPOSAL_SEMANTIC_REVIEW_LIMITS).toMatchObject({ payloadBytes: 12_288, blocks: 64, planBytes: 4_194_304, snapshotBytes: 8_388_608, rawBytes: 2_097_152, schemaBytes: 65_536, schemaDepth: 32, schemaNodes: 10_000 });
    await expect(parseProposalSemanticReviewResponse('я'.repeat(1_048_577), plan, input)).rejects.toThrow(/2 МБ/);
  });

  it('rejects source, outer options and nested candidate edits across asynchronous construction', async () => {
    for (const mutation of ['source', 'options', 'candidate-text', 'candidate-ref']) {
      let release!: (value: ArrayBuffer) => void;
      const digest = vi.fn().mockImplementationOnce(() => new Promise<ArrayBuffer>(resolve => { release = resolve; })).mockResolvedValue(new Uint8Array(32).buffer); vi.stubGlobal('crypto', { subtle: { digest } });
      const input = source([paragraph(0)]), data = candidate(), options = { focus: 'work-scope' as const, blockId: 'work-scope:block-1', instruction: 'Исходное', candidate: data }, pending = buildProposalSemanticReviewPlan(input, options);
      if (mutation === 'source') input[0].name += ' changed'; else if (mutation === 'options') options.instruction = 'Изменено';
      else if (mutation === 'candidate-text') (data as { text: string }).text += ' changed'; else (data.evidenceRefs[0] as { ownerId: string }).ownerId = 'changed';
      release(new Uint8Array(32).buffer); await expect(pending).rejects.toThrow(/изменились во время подготовки/);
    }
  });

  it('resolves an original pending job identity without manufacturing any reviewer response or upgrading untrusted data', async () => {
    const input = source([paragraph(0)]), plan = await build(input);
    expect(await resolveProposalSemanticReviewPlan(plan, input)).toBe(plan); expect(plan.provenance).toBe('untrusted-input-not-original-model-capability');
    for (const absent of ['response', 'verdict', 'humanApproval', 'admitted']) expect(plan).not.toHaveProperty(absent);
    await expect(resolveProposalSemanticReviewPlan(structuredClone(plan), input)).rejects.toThrow(/исходный неизменный/);
    await expect(resolveProposalSemanticReviewPlan({ ...plan }, input)).rejects.toThrow(/исходный неизменный/);
    const stale = structuredClone(input); stale[0].fragments![0].text += ' changed'; await expect(resolveProposalSemanticReviewPlan(plan, stale)).rejects.toThrow(/изменились/);
    const pending = resolveProposalSemanticReviewPlan(plan, input); input[0].name += ' changed during await'; await expect(pending).rejects.toThrow(/изменились/);
  });

  it('rejects a microtask source mutation between inner fresh-plan completion and the exported pending resolver continuation', async () => {
    const input = source([paragraph(0)]), plan = await build(input), nativeDigest = crypto.subtle.digest.bind(crypto.subtle); let calls = 0;
    const digest = vi.fn(async (...args: Parameters<SubtleCrypto['digest']>) => {
      const call = ++calls, output = await nativeDigest(...args);
      if (call === 4) queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => { input[0].name += ' changed in final resolver gap'; }))));
      return output;
    });
    vi.stubGlobal('crypto', { subtle: { digest } });
    await expect(resolveProposalSemanticReviewPlan(plan, input)).rejects.toThrow(/перед возвратом исходного плана/);
  });
});

describe('strict fallible reviewer verdicts, never semantic truth, human approval or complete CP acceptance', () => {
  it.each(['supported', 'unsupported', 'unclear'])('preserves model %s and diagnostic reason without upgrading it to truth or source claims', async verdict => {
    const input = source([paragraph(0)]), plan = await build(input), reason = '  Непроверенное объяснение модели.\r\nНе новая обязанность.  ', response = await parse(reply(plan, verdict, reason), plan, input);
    expect(response.verdict).toBe(verdict); expect(response.reason).toBe(reason); expect(response.semanticTruth).toBe('not-proven'); expect(response.humanApproval).toBe(false);
    expect(response.completeness).toBe('not-assessed'); expect(response.providerAuthenticity).toBe('not-attested'); expect(response.reviewUnit).toBe('unchanged-whole-answer-bundle');
    for (const absent of ['answer', 'claims', 'evidenceRefs', 'quote', 'ready', 'admitted', 'canFinalize', 'publicText']) expect(response).not.toHaveProperty(absent);
    expect(plan.candidate.text).toBe(candidate().text); expect(Object.isFrozen(response)).toBe(true);
  });

  it('binds exact reviewer raw bytes while retaining diagnostics as model text, not a source quote', async () => {
    const input = source([paragraph(0)]), plan = await build(input), wire = reply(plan, 'unclear', 'Пояснение отсутствует в исходном тексте и не является цитатой.'), raw = JSON.stringify(wire, null, 2);
    const response = await parseProposalSemanticReviewResponse(raw, plan, input), digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
    expect(response.rawSHA256).toBe(`sha256:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`);
    expect((await parseProposalSemanticReviewResponse(`${raw}\n`, plan, input)).rawSHA256).not.toBe(response.rawSHA256); expect(raw).toBe(JSON.stringify(wire, null, 2));
  });

  it('rejects duplicate keys, malformed enum types, bindings and new-answer/ref-replacement fields without repair', async () => {
    const input = source([paragraph(0)]), plan = await build(input), wire = reply(plan), raw = JSON.stringify(wire);
    await expect(parseProposalSemanticReviewResponse(raw.replace('"verdict":', '"verdict":"unclear","verdict":'), plan, input)).rejects.toThrow(/повторённое поле/);
    for (const patch of [{ verdict: ['supported'] }, { verdict: true }, { verdict: 'SUPPORTED' }, { reason: '' }, { reason: ' ' }, { reason: '\ud800' }, { reason: '\u0000' }, { reason: '🧪'.repeat(2001) },
      { reviewPlanKey: 'sha256:other' }, { candidateKey: 'sha256:other' }, { sourceSnapshotKey: 'sha256:other' }, { structureSnapshotKey: 'sha256:other' }, { blockId: 'foreign' }, { answer: 'Исправленный ответ' }, { evidenceRefs: [] }, { claims: [] }, { humanApproval: true }]) await expect(parse({ ...wire, ...patch }, plan, input)).rejects.toThrow();
    const mockOldWire = { sourceSnapshotKey: plan.sourceSnapshotKey, structureSnapshotKey: plan.structureSnapshotKey, referencePlanKey: 'sha256:not-this-protocol', blockId: plan.blockId, status: 'answered', answer: candidate().text, evidenceRefs: candidate().evidenceRefs };
    await expect(parse(mockOldWire, plan, input)).rejects.toThrow(/закрытому протоколу/);
  });

  it('rejects forged, cross-candidate and stale source/structure review plans', async () => {
    const input = source([paragraph(0)]), plan = await build(input), raw = JSON.stringify(reply(plan));
    await expect(parseProposalSemanticReviewResponse(raw, structuredClone(plan), input)).rejects.toThrow(/исходный неизменный/);
    const other = await build(input, { candidate: candidate({ text: 'Другой неизменённый bundle.' }) }); await expect(parseProposalSemanticReviewResponse(raw, other, input)).rejects.toThrow(/закрытому протоколу/);
    for (const change of [(current: IntelligenceSource[]) => { current[0].fragments![0].text += ' changed'; }, (current: IntelligenceSource[]) => { current[0].fragments![0].structure!.styleId = 'changed'; }]) {
      const current = structuredClone(input); change(current); await expect(parseProposalSemanticReviewResponse(raw, plan, current)).rejects.toThrow(/изменились/);
    }
  });

  it('checks fresh source again after the reviewer raw hash await before issuing a verdict', async () => {
    const input = source([paragraph(0)]), plan = await build(input), raw = JSON.stringify(reply(plan)), nativeDigest = crypto.subtle.digest.bind(crypto.subtle);
    let release!: () => void, signal!: () => void, count = 0;
    const gate = new Promise<void>(resolve => { release = resolve; }), reached = new Promise<void>(resolve => { signal = resolve; });
    const digest = vi.fn(async (...args: Parameters<SubtleCrypto['digest']>) => { const call = ++count, output = await nativeDigest(...args); if (call === 5) { signal(); await gate; } return output; });
    vi.stubGlobal('crypto', { subtle: { digest } }); const pending = parseProposalSemanticReviewResponse(raw, plan, input);
    await reached; input[0].name += ' changed during raw hash'; release(); await expect(pending).rejects.toThrow(/raw проверки/);
  });

  it('resolves only issued identities with original frozen candidate data, never persisted verdict copies or an equivalent plan', async () => {
    const input = source([paragraph(0)]), plan = await build(input), response = await parse(reply(plan), plan, input), resolved = await resolveProposalSemanticReviewResponse(response, plan, input);
    expect(resolved.response).toBe(response); expect(resolved.plan).toBe(plan); expect(resolved.block).toBe(plan.block); expect(resolved.candidate).toBe(plan.candidate); expect(Object.isFrozen(resolved)).toBe(true);
    await expect(resolveProposalSemanticReviewResponse(structuredClone(response), plan, input)).rejects.toThrow(/выданный вердикт/);
    await expect(resolveProposalSemanticReviewResponse({ ...response, verdict: 'supported' }, plan, input)).rejects.toThrow();
    await expect(resolveProposalSemanticReviewResponse(response, structuredClone(plan), input)).rejects.toThrow();
    const equivalent = await build(input); await expect(resolveProposalSemanticReviewResponse(response, equivalent, input)).rejects.toThrow(/тот же план/);
    const pending = resolveProposalSemanticReviewResponse(response, plan, input); input[0].name += ' changed during await'; await expect(pending).rejects.toThrow(/изменились/);
  });

  it('remains offline-only and never calls a provider, old answer parser, projector or storage', async () => {
    const fetch = vi.fn(), Worker = vi.fn(); vi.stubGlobal('fetch', fetch); vi.stubGlobal('Worker', Worker);
    const input = source([paragraph(0)]), before = structuredClone(input), data = candidate(), plan = await build(input, { candidate: data }), response = await parse(reply(plan, 'unsupported'), plan, input);
    await resolveProposalSemanticReviewResponse(response, plan, input); expect(fetch).not.toHaveBeenCalled(); expect(Worker).not.toHaveBeenCalled(); expect(input).toEqual(before); expect(plan.candidate).toEqual(data);
  });
});
