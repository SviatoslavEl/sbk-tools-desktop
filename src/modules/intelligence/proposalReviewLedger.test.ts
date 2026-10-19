import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildProposalReviewLedger, revalidateProposalReviewLedger, PROPOSAL_REVIEW_LEDGER_LIMITS, type ProposalReviewRecord } from './proposalReviewLedger';
import { buildProposalSemanticReviewPlan, parseProposalSemanticReviewResponse, type ProposalSemanticReviewCandidate, type ProposalSemanticReviewPlan } from './proposalSemanticReview';
import type { DocxFragmentStructure } from './documentStructure';
import type { IntelligenceFragment, IntelligenceSource } from './workbenchTypes';

function paragraph(index: number, text = `Учебное условие ${index}.`, native: Partial<DocxFragmentStructure> = {}): IntelligenceFragment {
  return { id: `owner-${index}`, locator: `Позиция ${index}`, text, structure: { version: 1, format: 'docx', method: 'ooxml', part: 'word/document.xml', kind: 'paragraph', containerId: 'body', order: index, physicalSection: 0, ...native } };
}
function row(index: number, rowIndex: number, rowCount: number, texts: string[], headerMarker = false): IntelligenceFragment {
  return { id: `owner-${index}`, locator: `Строка ${index}`, text: texts.join('\t'), structure: { version: 1, format: 'docx', method: 'ooxml', part: 'word/document.xml', kind: 'table-row', containerId: 'table-A', tableId: 'table-A', order: index,
    physicalSection: 0, rowIndex, rowCount, headerMarker, cells: texts.map((text, index) => ({ index, text, gridSpan: 1, verticalMerge: 'none', nestedTableCount: 0 })) } };
}
const source = (fragments: IntelligenceFragment[]): IntelligenceSource[] => [{ id: 'synthetic-source', name: 'Учебный документ', sha256: 'b'.repeat(64), text: 'AGGREGATE IS NOT A MODEL ANSWER', warnings: ['Исходное предупреждение.'], fragments, coverage: { complete: true, requiresOcr: false } }];
const candidate = (extra: Partial<ProposalSemanticReviewCandidate> = {}): ProposalSemanticReviewCandidate => ({ text: '  Неизменённый кандидат.\r\nВторая часть ответа.  ', evidenceRefs: [{ ownerId: 'owner-0', cellIndex: null }], originalRawSHA256: `sha256:${'a'.repeat(64)}`, origin: 'untrusted-candidate-data', ...extra });
const planFor = (input: IntelligenceSource[], extra = {}) => buildProposalSemanticReviewPlan(input, { focus: 'work-scope', blockId: 'work-scope:block-1', candidate: candidate(), ...extra });
async function review(input: IntelligenceSource[], plan: ProposalSemanticReviewPlan, verdict: 'supported' | 'unsupported' | 'unclear') {
  return parseProposalSemanticReviewResponse(JSON.stringify({ reviewPlanKey: plan.reviewPlanKey, sourceSnapshotKey: plan.sourceSnapshotKey, structureSnapshotKey: plan.structureSnapshotKey, candidateKey: plan.candidateKey, blockId: plan.blockId, verdict,
    reason: 'Учебный модельный вердикт. Тест НЕ проверяет точность самой модели.' }), plan, input);
}
afterEach(() => vi.unstubAllGlobals());

describe('whole-source provisional review ledger, not a complete CP or semantic certificate', () => {
  it('retains every original owner, native cell, aggregate and warning; all unprocessed frames remain explicit', async () => {
    const input = source([paragraph(0, ''), row(1, 0, 2, ['Заголовок', 'Значение'], true), row(2, 1, 2, ['Условие', 'Полный\nтекст']), paragraph(3, 'Целый хвост'), paragraph(4, 'Вспомогательная часть', { kind: 'header-footer', part: 'word/header1.xml', containerId: 'aux' })]);
    const before = structuredClone(input), ledger = await buildProposalReviewLedger(input);
    expect(ledger.sourceSnapshot).toEqual(input); expect(ledger.sourceSnapshot).not.toBe(input); expect(input).toEqual(before);
    expect(ledger.owners.map(owner => owner.ownerId)).toEqual(input[0].fragments!.map(fragment => fragment.id)); expect(ledger.owners.find(owner => owner.ownerId === 'owner-1')?.nativeHeaderMarker).toBe(true);
    expect(ledger.focuses.map(focus => focus.focus)).toEqual(['work-scope', 'deliverables']);
    for (const focus of ledger.focuses) {
      expect(focus.blocks.flatMap(block => block.primaryOwnerIds)).toEqual(input[0].fragments!.map(fragment => fragment.id));
      expect(focus.ownerCoverage.completeOriginalOwnerMapping).toBe(true); expect(focus.ownerCoverage.wholeNativeDocumentClaim).toBe(false);
      expect(focus.blocks.every(block => block.state === 'NOT_PROCESSED' && block.bundle === null)).toBe(true);
      expect(focus.blocks.flatMap(block => block.context).some(entry => entry.ownerId === 'owner-1' && entry.basis === 'native-leading-table-header')).toBe(true);
    }
    expect(ledger.counts.notProcessed).toBe(ledger.counts.blocks); expect(ledger.reviewableDraftBundles).toEqual([]); expect(ledger.approvedContent).toEqual([]);
    expect(ledger).toMatchObject({ readyForClient: false, humanApproval: false, semanticTruth: 'not-proven', completeness: 'not-assessed' });
    expect(Object.isFrozen(ledger.sourceSnapshot[0].fragments![2].structure!.cells![1])).toBe(true); expect(Object.isFrozen(input[0])).toBe(false);
  });

  it('retains a pending unchanged candidate with ordered bundle refs, without manufacturing a reviewer capability', async () => {
    const input = source([paragraph(0), paragraph(1), paragraph(2)]), data = candidate({ evidenceRefs: [{ ownerId: 'owner-2', cellIndex: null }, { ownerId: 'owner-0', cellIndex: null }] }), plan = await planFor(input, { candidate: data });
    const records = [{ plan, response: null }], ledger = await buildProposalReviewLedger(input, records), bundle = ledger.focuses[0].blocks[0].bundle!;
    expect(bundle.candidate).toBe(plan.candidate); expect(bundle.candidate).toEqual(data); expect(bundle.modelReview).toBeNull(); expect(bundle.perClaimRefAttribution).toBe('not-provided');
    expect(bundle.admission).toBe('blocked-pending-review'); expect(bundle.publicCPAllowed).toBe(false); expect(ledger.counts.pendingReview).toBe(1);
    expect(ledger.reviewableDraftBundles).toEqual([]); expect(ledger.focuses[1].blocks.every(block => block.state === 'NOT_PROCESSED')).toBe(true);
    expect(await revalidateProposalReviewLedger(ledger, input, records)).toBe(ledger); expect(Object.isFrozen(records)).toBe(false); expect(Object.isFrozen(records[0])).toBe(false);
  });

  it('blocks an invented obligation despite a valid explicit column-label address, based on an explicit unsupported mock verdict', async () => {
    const input = source([row(0, 0, 1, ['Раздел', 'Действия', 'Результат'], true)]), data = candidate({ text: 'Обязанность: подтвердить, что действия завершены.', evidenceRefs: [{ ownerId: 'owner-0', cellIndex: 1 }] });
    const plan = await planFor(input, { candidate: data }), response = await review(input, plan, 'unsupported'), ledger = await buildProposalReviewLedger(input, [{ plan, response }]);
    const block = ledger.focuses[0].blocks[0]; expect(block.state).toBe('MODEL_UNSUPPORTED_BLOCKED'); expect(block.bundle!.candidate.text).toBe(data.text);
    expect(block.bundle!.candidate.evidenceRefs).toEqual(data.evidenceRefs); expect(block.bundle!.admission).toBe('blocked-model-unsupported');
    expect(block.bundle!.modelReview).toBe(response); expect(ledger.reviewableDraftBundles).toEqual([]); expect(ledger.approvedContent).toEqual([]); expect(ledger.readyForClient).toBe(false);
    // Admission-policy regression only. It does NOT demonstrate that an actual
    // reviewer model will recognize the fabricated predicate correctly.
  });

  it('does not discard real business conditions merely because they are in a native header', async () => {
    const input = source([row(0, 0, 2, ['Расчёт после письменного согласования.'], true), row(1, 1, 2, ['Явное условие'])]), data = candidate({ text: 'Расчёт после письменного согласования.', evidenceRefs: [{ ownerId: 'owner-0', cellIndex: 0 }] });
    const plan = await planFor(input, { candidate: data }), response = await review(input, plan, 'supported'), ledger = await buildProposalReviewLedger(input, [{ plan, response }]);
    const block = ledger.focuses[0].blocks[0]; expect(block.kind).toBe('native-table-header'); expect(block.state).toBe('MODEL_SUPPORTED_UNAPPROVED'); expect(block.bundle!.candidate.text).toBe(data.text);
    expect(ledger.owners[0].nativeHeaderMarker).toBe(true); expect(ledger.sourceSnapshot[0].fragments![0].structure!.cells![0].text).toBe(data.text);
    expect(ledger.reviewableDraftBundles).toEqual([{ focus: 'work-scope', blockId: plan.blockId, candidateKey: plan.candidateKey }]); expect(block.bundle!.publicCPAllowed).toBe(false); expect(ledger.readyForClient).toBe(false);
  });

  it.each(['supported', 'unsupported', 'unclear'] as const)('treats %s as fallible review, never truth, human approval, completeness or client content', async verdict => {
    const input = source([paragraph(0)]), plan = await planFor(input), response = await review(input, plan, verdict), ledger = await buildProposalReviewLedger(input, [{ plan, response }]);
    const bundle = ledger.focuses[0].blocks[0].bundle!;
    expect(bundle.modelReview).toBe(response); expect(bundle).toMatchObject({ semanticTruth: 'not-proven', humanApproval: false, publicCPAllowed: false, modelAnswerModified: false, perClaimRefAttribution: 'not-provided' });
    expect(ledger.reviewableDraftBundles.length).toBe(verdict === 'supported' ? 1 : 0); expect(ledger.approvedContent).toEqual([]); expect(ledger.readyForClient).toBe(false);
    expect(ledger.openProposalAreas).toEqual([
      { area: 'work-scope', state: 'OPEN_PENDING_COMPLETE_REVIEW' }, { area: 'deliverables', state: 'OPEN_PENDING_COMPLETE_REVIEW' },
      ...['checked-facets', 'price', 'payment', 'parties-and-roles', 'schedule'].map(area => ({ area, state: 'NOT_IMPLEMENTED_IN_THIS_ROUTE' })),
    ]);
  });

  it('keeps a multi-action answer as one bundle, without inheriting its refs per action or appending unselected source facts', async () => {
    const input = source([row(0, 0, 1, ['Деловое условие', 'Источник A', 'UNSELECTED SOURCE ONLY', 'Источник B'])]);
    const data = candidate({ text: '  Проверить A.\nПроверить B и сохранить ограничение.  ', evidenceRefs: [{ ownerId: 'owner-0', cellIndex: 3 }, { ownerId: 'owner-0', cellIndex: 1 }] });
    const plan = await planFor(input, { candidate: data }), response = await review(input, plan, 'supported'), ledger = await buildProposalReviewLedger(input, [{ plan, response }]), bundle = ledger.focuses[0].blocks[0].bundle!;
    expect(bundle.candidate.text).toBe(data.text); expect(bundle.candidate.evidenceRefs).toEqual(data.evidenceRefs); expect(bundle.candidate.text).not.toContain('UNSELECTED'); expect(ledger.reviewableDraftBundles).toHaveLength(1);
    for (const absent of ['claims', 'actions', 'actionRefs', 'quote', 'sourceCompletion', 'fixedAnswer', 'publicText']) expect(bundle).not.toHaveProperty(absent);
    expect(ledger.sourceSnapshot[0].fragments![0].structure!.cells![2].text).toBe('UNSELECTED SOURCE ONLY');
  });

  it('rejects duplicate block reviews atomically, not last-wins or optimistic retry selection', async () => {
    const input = source([paragraph(0)]), first = await planFor(input), second = await planFor(input, { candidate: candidate({ text: 'Другой целый кандидат.' }) });
    const unsupported = await review(input, first, 'unsupported'), supported = await review(input, second, 'supported');
    await expect(buildProposalReviewLedger(input, [{ plan: first, response: unsupported }, { plan: second, response: supported }])).rejects.toThrow(/несколько проверок/);
    await expect(buildProposalReviewLedger(input, [{ plan: first, response: null }, { plan: first, response: null }])).rejects.toThrow(/несколько проверок/);
  });

  it('rejects cloned, forged, mismatched or stale plan/verdict identities instead of trusting serialized provenance', async () => {
    const input = source([paragraph(0)]), plan = await planFor(input), response = await review(input, plan, 'supported'), equivalent = await planFor(input);
    for (const record of [{ plan: structuredClone(plan), response: null }, { plan, response: structuredClone(response) }, { plan: equivalent, response }, { plan: { ...plan }, response: null }]) await expect(buildProposalReviewLedger(input, [record])).rejects.toThrow();
    const stale = structuredClone(input); stale[0].fragments![0].structure!.styleId = 'Changed'; await expect(buildProposalReviewLedger(stale, [{ plan, response }])).rejects.toThrow(/изменились/);
    const wrongGrouping = await planFor(source([paragraph(0), paragraph(1)]), { maxOwnersPerProseBlock: 1 });
    await expect(buildProposalReviewLedger(source([paragraph(0), paragraph(1)]), [{ plan: wrongGrouping, response: null }])).rejects.toThrow(/Иная группировка/);
  });

  it('rejects source and record-list mutation during awaited work without freezing or modifying caller inputs', async () => {
    for (const change of ['source', 'wrapper', 'list', 'extra-key']) {
      const input = source([paragraph(0)]), plan = await planFor(input), response = await review(input, plan, 'supported'), records: ProposalReviewRecord[] = [{ plan, response }], pending = buildProposalReviewLedger(input, records);
      if (change === 'source') input[0].name += ' changed'; else if (change === 'wrapper') (records[0] as { response: unknown }).response = null;
      else if (change === 'list') records.pop(); else (records[0] as unknown as Record<string, unknown>).extra = true;
      await expect(pending).rejects.toThrow(/изменился/); expect(Object.isFrozen(input[0])).toBe(false); expect(Object.isFrozen(records)).toBe(false);
    }
  });

  it('requires the same issued ledger and record wrappers, then fresh source on revalidation', async () => {
    const input = source([paragraph(0)]), plan = await planFor(input), response = await review(input, plan, 'unclear'), records = [{ plan, response }], ledger = await buildProposalReviewLedger(input, records);
    expect(await revalidateProposalReviewLedger(ledger, input, records)).toBe(ledger);
    await expect(revalidateProposalReviewLedger(structuredClone(ledger), input, records)).rejects.toThrow(/исходный выданный/);
    await expect(revalidateProposalReviewLedger(ledger, input, [{ plan, response }])).rejects.toThrow(/Список проверок/);
    await expect(revalidateProposalReviewLedger(ledger, input)).rejects.toThrow(/Список проверок/);
    const changed = structuredClone(input); changed[0].text += ' changed'; await expect(revalidateProposalReviewLedger(ledger, changed, records)).rejects.toThrow();
    const pending = revalidateProposalReviewLedger(ledger, input, records); input[0].warnings!.push('Changed'); await expect(pending).rejects.toThrow(/изменился/);
  });

  it('checks the source again in the outer revalidator after the fresh ledger has returned', async () => {
    const input = source([paragraph(0)]), plan = await planFor(input), records = [{ plan, response: null }], ledger = await buildProposalReviewLedger(input, records);
    const nativeDigest = crypto.subtle.digest.bind(crypto.subtle); let calls = 0;
    const digest = vi.fn(async (...args: Parameters<SubtleCrypto['digest']>) => {
      const call = ++calls, output = await nativeDigest(...args);
      if (call === 8) queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => { input[0].name += ' outer ledger gap'; }))))));
      return output;
    });
    vi.stubGlobal('crypto', { subtle: { digest } });
    await expect(revalidateProposalReviewLedger(ledger, input, records)).rejects.toThrow('Источник или проверки изменились. Прежний реестр не принят.');
    expect(calls).toBe(8);
  });

  it('enforces bounded review count and combined Unicode data before async work or partial output', async () => {
    const input = source([paragraph(0)]), plan = await planFor(input);
    await expect(buildProposalReviewLedger(input, Array.from({ length: 129 }, () => ({ plan, response: null })))).rejects.toThrow(/не более128/);
    const oversized = { ...plan, candidate: candidate({ text: '🧪'.repeat(8_000) }) };
    await expect(buildProposalReviewLedger(input, Array.from({ length: 128 }, () => ({ plan: oversized, response: null })))).rejects.toThrow(/2МиБ/);
    await expect(buildProposalReviewLedger(input, [{ plan, response: null, extra: true } as ProposalReviewRecord])).rejects.toThrow();
    expect(PROPOSAL_REVIEW_LEDGER_LIMITS).toEqual({ records: 128, reviewDataBytes: 2_097_152, ledgerBytes: 16_777_216 });
  });

  it('does not silently accept partial extraction, missing structure or a plan too large for the full route', async () => {
    for (const change of [(input: IntelligenceSource[]) => { input[0].coverage!.complete = false; }, (input: IntelligenceSource[]) => { delete input[0].fragments![0].structure; }, (input: IntelligenceSource[]) => { input[0].text = 'x'.repeat(8_388_609); }]) {
      const input = source([paragraph(0)]); change(input); const before = structuredClone(input); await expect(buildProposalReviewLedger(input)).rejects.toThrow(); expect(input).toEqual(before);
    }
    const input = source(Array.from({ length: 65 }, (_, index) => row(index, index, 65, ['Условие']))); await expect(buildProposalReviewLedger(input)).rejects.toThrow(/64/);
  });

  it('has no network, worker, storage, exporter or implicit model route', async () => {
    const fetch = vi.fn(), Worker = vi.fn(); vi.stubGlobal('fetch', fetch); vi.stubGlobal('Worker', Worker);
    const input = source([paragraph(0)]), before = structuredClone(input), plan = await planFor(input), records = [{ plan, response: null }], ledger = await buildProposalReviewLedger(input, records);
    await revalidateProposalReviewLedger(ledger, input, records); expect(fetch).not.toHaveBeenCalled(); expect(Worker).not.toHaveBeenCalled(); expect(input).toEqual(before);
    expect(ledger.approvedContent).toEqual([]); expect(ledger.readyForClient).toBe(false);
  });
});
