import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PROPOSAL_AREAS, buildProposalAreaPlan, parseProposalAreaBlockResponse, buildProposalAreaReviewPlan, parseProposalAreaReviewResponse,
  type ProposalArea, type ProposalAreaAnswer, type ProposalAreaPlan, type ProposalAreaReviewVerdict,
} from './proposalAreaPlan';
import { buildProposalWholeDraft, revalidateProposalWholeDraft, PROPOSAL_WHOLE_DRAFT_LIMITS, type ProposalWholeDraftRecord } from './proposalWholeDraft';
import type { IntelligenceFragment, IntelligenceSource } from './workbenchTypes';

/** Every response/review below is a SYNTHETIC ordinary schema response issued
 * by the new pure parser. No provider, actual raw or semantic accuracy proof. */
const paragraph = (index: number, text = `SYNTHETIC целый источник ${index}.`): IntelligenceFragment => ({ id: `owner-${index}`, locator: `Позиция ${index}`, text,
  structure: { version: 1, format: 'docx', method: 'ooxml', part: 'word/document.xml', kind: 'paragraph', containerId: 'body', order: index, physicalSection: 0 } });
const row = (index: number, texts: string[], count: number, header = false): IntelligenceFragment => ({ id: `owner-${index}`, locator: `Строка ${index}`, text: texts.join('\t'),
  structure: { version: 1, format: 'docx', method: 'ooxml', part: 'word/document.xml', kind: 'table-row', containerId: 'table-A', tableId: 'table-A', rowIndex: index, rowCount: count,
    order: index, physicalSection: 0, headerMarker: header, cells: texts.map((text, cellIndex) => ({ index: cellIndex, text, gridSpan: 1, verticalMerge: 'none', nestedTableCount: 0 })) } });
const source = (fragments: IntelligenceFragment[] = [paragraph(0)]): IntelligenceSource[] => [{ id: 'synthetic-source', name: 'Учебный источник', sha256: 'b'.repeat(64), text: 'AGGREGATE_ONLY_SENTINEL', fragments,
  warnings: ['SOURCE_WARNING_ONLY_SENTINEL'], coverage: { complete: true, requiresOcr: false } }];
const length = (text: string) => new TextEncoder().encode(text).byteLength;
type AnswerOptions = (area: ProposalArea, frameIndex: number) => Partial<ProposalAreaAnswer>;
type ReviewOptions = (area: ProposalArea, frameIndex: number) => Partial<ProposalAreaReviewVerdict>;
function schemaWire(schema: Readonly<Record<string, unknown>>, areas: unknown) {
  const properties = schema.properties as Record<string, { enum?: unknown[] }>;
  return Object.fromEntries(Object.keys(properties).map(key => {
    if (key === 'areas') return [key, areas];
    if (properties[key].enum?.length !== 1) throw new Error(`Synthetic fixture expected a fixed binding for ${key}`);
    return [key, properties[key].enum![0]];
  }));
}
async function recordFor(plan: ProposalAreaPlan, input: IntelligenceSource[], frameIndex: number, answers?: AnswerOptions, reviews?: ReviewOptions, extractionPadTo?: number, reviewPadding = 0) {
  const block = plan.blocks[frameIndex], owner = block.primary[0];
  const areas = Object.fromEntries(PROPOSAL_AREAS.map(area => [area, { status: 'answered', answer: `  SYNTHETIC ${area} ${frameIndex}.\r\nЦелый неизменённый bundle.  `,
    evidenceRefs: [{ ownerId: owner.ownerId, cellIndex: owner.structure.kind === 'table-row' ? 0 : null }], ...answers?.(area, frameIndex) }]));
  let extractionRaw = JSON.stringify(schemaWire(block.responseSchema, areas));
  if (extractionPadTo !== undefined) { if (extractionPadTo < length(extractionRaw)) throw new Error('Synthetic padding cannot truncate raw'); extractionRaw += ' '.repeat(extractionPadTo - length(extractionRaw)); }
  const response = await parseProposalAreaBlockResponse(extractionRaw, plan, block.id, input), reviewPlan = await buildProposalAreaReviewPlan(response, plan, input);
  const reviewAreas = Object.fromEntries(PROPOSAL_AREAS.map(area => [area, { verdict: 'supported', reason: 'SYNTHETIC ошибающаяся модельная оценка; истинность тестом не доказана.', ...reviews?.(area, frameIndex) }]));
  const reviewRaw = JSON.stringify(schemaWire(reviewPlan.responseSchema, reviewAreas)) + ' '.repeat(reviewPadding);
  const reviewResponse = await parseProposalAreaReviewResponse(reviewRaw, reviewPlan, plan, input);
  return { record: { response, reviewPlan, reviewResponse } satisfies ProposalWholeDraftRecord, extractionRaw, reviewRaw };
}
async function complete(input: IntelligenceSource[], answers?: AnswerOptions, reviews?: ReviewOptions, options = {}) {
  const plan = await buildProposalAreaPlan(input, options), records: ProposalWholeDraftRecord[] = [];
  for (let index = 0; index < plan.blocks.length; index++) records.push((await recordFor(plan, input, index, answers, reviews)).record);
  return { plan, records };
}
const notStated: ProposalAreaAnswer = { status: 'not-stated', answer: null, evidenceRefs: [] };
afterEach(() => vi.unstubAllGlobals());

describe('atomic original-issued seven-area whole draft, never client-ready or semantic proof', () => {
  it('retains all seven actual returned whole answers, ordered refs and source owners without canonical/source-only completion', async () => {
    const input = source([paragraph(0), paragraph(1), paragraph(2)]), before = structuredClone(input);
    const { plan, records } = await complete(input, area => ({ answer: `  SYNTHETIC ${area}: первая часть.\r\nВторая часть без разделения.  `,
      evidenceRefs: [{ ownerId: 'owner-2', cellIndex: null }, { ownerId: 'owner-0', cellIndex: null }] }));
    const draft = await buildProposalWholeDraft(plan, records, input);
    expect(draft.purpose).toBe('unapproved-model-whole-proposal-draft'); expect(draft.sections.map(section => section.area)).toEqual(PROPOSAL_AREAS);
    for (const section of draft.sections) {
      expect(section.state).toBe('MODEL_DRAFT_UNAPPROVED'); expect(section.bundles).toHaveLength(1);
      expect(section.bundles[0].text).toBe(records[0].response.areas[section.area].answer); expect(section.bundles[0].evidenceRefs).toEqual(records[0].response.areas[section.area].evidenceRefs);
      expect(section.bundles[0].perClaimRefAttribution).toBe('not-provided'); expect(section.bundles[0].publicCPAllowed).toBe(false); expect(section.bundles[0].modelAnswerModified).toBe(false);
      expect(section.modelAbsence).toBe('not-claimed');
    }
    expect(draft.sourceSnapshot).toEqual(before); expect(draft.owners.map(owner => owner.ownerId)).toEqual(['owner-0', 'owner-1', 'owner-2']);
    expect(draft.audit.frames[0].extractionResponse).toBe(records[0].response); expect(draft.audit.frames[0].modelReview).toBe(records[0].reviewResponse);
    expect(JSON.stringify(draft.sections)).not.toContain(input[0].text); expect(JSON.stringify(draft.sections)).not.toContain(input[0].warnings![0]);
    expect(draft.readyForClient).toBe(false); expect(draft.humanApproval).toBe(false); expect(draft.semanticTruth).toBe('not-proven'); expect(draft.completeness).toBe('not-assessed');
    expect(draft.providerAuthenticity).toBe('not-attested'); expect(draft.approvedContent).toEqual([]); expect(draft.runCoverage).toEqual({ state: 'ALL_PLANNED_FRAMES_REVIEWED', frames: 1, sourceOwners: 3, areas: 7, structuralOwnerMapping: 'complete-not-semantic-completeness' });
    expect(draft.clarificationQuestions).toEqual([]); expect(draft.unvalidatedDetails.map(detail => detail.area)).toEqual(PROPOSAL_AREAS);
    expect(draft.unvalidatedDetails.every(detail => detail.state === 'SUBFIELD_COMPLETENESS_NOT_ASSESSED' && detail.notEvidenceOfMissingValues)).toBe(true);
    for (const absent of ['price', 'currency', 'vat', 'canonicalCommercialDocument', 'sourceProof', 'approved', 'publicText']) expect(draft).not.toHaveProperty(absent);
    expect(input).toEqual(before); expect(Object.isFrozen(input[0])).toBe(false); expect(Object.isFrozen(draft)).toBe(true);
  });

  it('orders whole supported bundles by source frames and retains a native header as its own primary without inferring text', async () => {
    const input = source([row(0, ['Учебные условия заголовка', 'Вторая ячейка'], 3, true), row(1, ['Первая строка'], 3), row(2, ['Вторая строка'], 3)]), { plan, records } = await complete(input);
    const draft = await buildProposalWholeDraft(plan, records, input);
    expect(plan.blocks).toHaveLength(3); expect(draft.audit.frames.map(frame => frame.primaryOwnerIds)).toEqual([['owner-0'], ['owner-1'], ['owner-2']]);
    expect(draft.sourceSnapshot[0].fragments![0].structure!.headerMarker).toBe(true);
    for (const section of draft.sections) { expect(section.bundles.map(bundle => bundle.frameId)).toEqual(plan.blocks.map(block => block.id)); expect(section.bundles.map(bundle => bundle.frameIndex)).toEqual([0, 1, 2]); }
    expect(draft.audit.frames[1].contextOwnerIds).toContain('owner-0'); expect(JSON.stringify(draft.sections)).not.toContain('Учебные условия заголовка');
  });

  it('refuses missing, duplicate, additional, reordered or foreign frames atomically rather than treating unprocessed parts as absent', async () => {
    const input = source([row(0, ['Первая'], 2), row(1, ['Вторая'], 2)]), { plan, records } = await complete(input), foreign = await complete(input);
    for (const bad of [[], records.slice(0, 1), [records[0], records[0]], [...records, records[0]], [...records].reverse(), [foreign.records[0], records[1]]]) {
      await expect(buildProposalWholeDraft(plan, bad, input)).rejects.toThrow();
    }
    await expect(buildProposalWholeDraft(foreign.plan, records, input)).rejects.toThrow();
    expect((await buildProposalWholeDraft(plan, records, input)).runCoverage.frames).toBe(2);
  });

  it('labels all-frame supported not-stated only as model-not-found and asks specific missing-value questions without defaults', async () => {
    const input = source(), { plan, records } = await complete(input, () => notStated), draft = await buildProposalWholeDraft(plan, records, input);
    expect(draft.sections).toHaveLength(7);
    for (const section of draft.sections) { expect(section.state).toBe('MODEL_NOT_FOUND_NEEDS_CLARIFICATION'); expect(section.modelAbsence).toBe('model-not-found-in-supplied-source-not-proof'); expect(section.bundles).toEqual([]); }
    expect(draft.audit.frames[0].areas.payment).toBe('MODEL_NOT_STATED_SUPPORTED_LOCAL_ONLY');
    expect(draft.clarificationQuestions.every(question => question.reason === 'MODEL_NOT_FOUND' && question.question.includes('не доказательство'))).toBe(true);
    expect(draft.clarificationQuestions.filter(question => question.area === 'price-vat').map(question => question.topic)).toEqual(['price', 'currency', 'vat', 'price-basis']);
    expect(draft.clarificationQuestions.filter(question => question.area === 'payment').map(question => question.topic)).toEqual(['payment-events', 'payment-base', 'payment-amounts', 'payment-day-kind']);
    expect(draft.clarificationQuestions.filter(question => question.area === 'schedule').map(question => question.topic)).toEqual(['duration', 'day-kind', 'start-event', 'dependencies']);
    expect(draft.clarificationQuestions.every(question => question.frameIds[0] === plan.blocks[0].id && question.ownerIds.includes('owner-0'))).toBe(true);
    expect(draft.unvalidatedDetails).toEqual([]);
    expect(JSON.stringify(draft.sections)).not.toMatch(/RUB|₽|01\.01\.|"price":0/u); expect(draft.readyForClient).toBe(false);
  });

  it('does not turn local not-stated into global absence when another frame has a supported answer', async () => {
    const input = source([row(0, ['Первая'], 2), row(1, ['Вторая'], 2)]), { plan, records } = await complete(input, (_area, frame) => frame === 0 ? notStated : {}), draft = await buildProposalWholeDraft(plan, records, input);
    for (const section of draft.sections) { expect(section.state).toBe('MODEL_DRAFT_UNAPPROVED'); expect(section.modelAbsence).toBe('not-claimed'); expect(section.bundles.map(bundle => bundle.frameId)).toEqual([plan.blocks[1].id]); }
    expect(draft.clarificationQuestions).toEqual([]); expect(draft.unvalidatedDetails.map(detail => detail.area)).toEqual(PROPOSAL_AREAS);
    expect(draft.unvalidatedDetails.find(detail => detail.area === 'price-vat')!.topics).toEqual(['price', 'currency', 'vat', 'price-basis']);
  });

  it('does not fabricate missing-value questions from supported but untyped text in any of the seven areas', async () => {
    const input = source(), { plan, records } = await complete(input, area => ({ answer: `SYNTHETIC целый поддержанный ответ ${area}; отдельные подполя не извлекались.` }));
    const draft = await buildProposalWholeDraft(plan, records, input);
    expect(draft.sections.every(section => section.state === 'MODEL_DRAFT_UNAPPROVED')).toBe(true); expect(draft.clarificationQuestions).toEqual([]);
    expect(draft.unvalidatedDetails).toHaveLength(7); expect(draft.unvalidatedDetails.every(detail => detail.notEvidenceOfMissingValues && detail.state === 'SUBFIELD_COMPLETENESS_NOT_ASSESSED')).toBe(true);
    expect(draft.completeness).toBe('not-assessed'); expect(draft.readyForClient).toBe(false);
  });

  it('keeps unsupported, review-unclear and extraction-unclear areas blocked with context pointers, never repaired text', async () => {
    const input = source([row(0, ['Контекст'], 2, true), row(1, ['Основная строка'], 2)]), { plan, records } = await complete(input,
      (area, frame) => area === 'schedule' && frame === 1 ? { status: 'unclear', answer: null, evidenceRefs: [] } : {},
      (area, frame) => frame === 1 && area === 'payment' ? { verdict: 'unsupported', reason: 'SYNTHETIC_REVIEW_REASON_PRIVATE' } : frame === 1 && area === 'price-vat' ? { verdict: 'unclear' } : {});
    const draft = await buildProposalWholeDraft(plan, records, input);
    expect(draft.audit.frames[1].areas.payment).toBe('MODEL_REVIEW_UNSUPPORTED_BLOCKED'); expect(draft.audit.frames[1].areas['price-vat']).toBe('MODEL_REVIEW_UNCLEAR_BLOCKED'); expect(draft.audit.frames[1].areas.schedule).toBe('MODEL_EXTRACTION_UNCLEAR_BLOCKED');
    for (const area of ['payment', 'price-vat', 'schedule']) { const section = draft.sections.find(section => section.area === area)!; expect(section.state).toBe('BLOCKED_REVIEW'); expect(section.modelAbsence).toBe('not-claimed'); expect(section.bundles.map(bundle => bundle.frameId)).toEqual([plan.blocks[0].id]); }
    const question = draft.clarificationQuestions.find(question => question.area === 'payment')!; expect(question.reason).toBe('BLOCKED_REVIEW'); expect(question.frameIds).toEqual([plan.blocks[1].id]); expect(question.ownerIds).toEqual(['owner-1', 'owner-0']);
    expect([...new Set(draft.clarificationQuestions.map(question => question.area))]).toEqual(['price-vat', 'payment', 'schedule']);
    expect(JSON.stringify(draft.sections)).not.toContain('SYNTHETIC_REVIEW_REASON_PRIVATE'); expect(JSON.stringify(draft.clarificationQuestions)).not.toContain('SYNTHETIC_REVIEW_REASON_PRIVATE'); expect(draft.audit.frames[1].modelReview.areas.payment.reason).toBe('SYNTHETIC_REVIEW_REASON_PRIVATE');
  });

  it('requires original response, review plan and reviewer identities, not JSON/provider-proof assertions or crossed reviews', async () => {
    const input = source(), { plan, records } = await complete(input), another = (await recordFor(plan, input, 0)).record;
    for (const key of ['response', 'reviewPlan', 'reviewResponse'] as const) await expect(buildProposalWholeDraft(plan, [{ ...records[0], [key]: structuredClone(records[0][key]) }], input)).rejects.toThrow();
    await expect(buildProposalWholeDraft(structuredClone(plan), records, input)).rejects.toThrow();
    await expect(buildProposalWholeDraft(plan, [{ ...records[0], reviewPlan: another.reviewPlan, reviewResponse: another.reviewResponse }], input)).rejects.toThrow();
    await expect(buildProposalWholeDraft(plan, [{ ...records[0], reviewResponse: another.reviewResponse }], input)).rejects.toThrow();
    await expect(buildProposalWholeDraft(plan, [{ ...records[0], providerAuthenticated: true } as ProposalWholeDraftRecord], input)).rejects.toThrow();
  });

  it('rejects stale source text, structure, hash and coverage without changing any earlier issued record', async () => {
    const input = source(), { plan, records } = await complete(input), before = JSON.stringify(records);
    for (const change of [(value: IntelligenceSource[]) => { value[0].fragments![0].text += ' stale'; }, (value: IntelligenceSource[]) => { value[0].fragments![0].structure!.styleId = 'changed'; },
      (value: IntelligenceSource[]) => { value[0].sha256 = 'c'.repeat(64); }, (value: IntelligenceSource[]) => { value[0].coverage!.complete = false; }]) {
      const stale = structuredClone(input); change(stale); await expect(buildProposalWholeDraft(plan, records, stale)).rejects.toThrow();
    }
    expect(JSON.stringify(records)).toBe(before); expect((await buildProposalWholeDraft(plan, records, input)).owners).toHaveLength(1);
  });

  it.each(['source', 'wrapper', 'list', 'extra-key'] as const)('rejects %s mutation while an opaque resolver is awaiting', async mutation => {
    const input = source(), { plan, records } = await complete(input), nativeDigest = crypto.subtle.digest.bind(crypto.subtle);
    let entered!: () => void, release!: () => void; const enteredPromise = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; }); let gated = false;
    vi.stubGlobal('crypto', { subtle: { digest: vi.fn(async (...args: Parameters<SubtleCrypto['digest']>) => { if (!gated) { gated = true; entered(); await gate; } return nativeDigest(...args); }) } });
    const pending = buildProposalWholeDraft(plan, records, input); await enteredPromise;
    if (mutation === 'source') input[0].name += ' during await'; else if (mutation === 'wrapper') records[0] = { ...records[0] }; else if (mutation === 'list') records.push(records[0]); else Object.assign(records[0], { unexpected: true });
    release(); await expect(pending).rejects.toThrow(/изменил|изменил|изменились/u);
  });

  it('requires the original issued draft, plan and same wrapper identities for fresh revalidation', async () => {
    const input = source(), { plan, records } = await complete(input), draft = await buildProposalWholeDraft(plan, records, input);
    expect(await revalidateProposalWholeDraft(draft, plan, [...records], input)).toBe(draft);
    await expect(revalidateProposalWholeDraft(structuredClone(draft), plan, records, input)).rejects.toThrow(/capability/u);
    await expect(revalidateProposalWholeDraft(draft, structuredClone(plan), records, input)).rejects.toThrow(/capability/u);
    await expect(revalidateProposalWholeDraft(draft, plan, [{ ...records[0] }], input)).rejects.toThrow(/изменились/u);
    const stale = structuredClone(input); stale[0].name += ' changed'; await expect(revalidateProposalWholeDraft(draft, plan, records, stale)).rejects.toThrow();
  });

  it.each(['source', 'wrapper'] as const)('does not return a previously issued draft after %s changes during revalidation', async mutation => {
    const input = source(), { plan, records } = await complete(input), draft = await buildProposalWholeDraft(plan, records, input), nativeDigest = crypto.subtle.digest.bind(crypto.subtle);
    let entered!: () => void, release!: () => void; const enteredPromise = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; }); let gated = false;
    vi.stubGlobal('crypto', { subtle: { digest: vi.fn(async (...args: Parameters<SubtleCrypto['digest']>) => { if (!gated) { gated = true; entered(); await gate; } return nativeDigest(...args); }) } });
    const pending = revalidateProposalWholeDraft(draft, plan, records, input); await enteredPromise;
    if (mutation === 'source') input[0].name += ' revalidation gap'; else records[0] = { ...records[0] };
    release(); await expect(pending).rejects.toThrow();
    expect(draft.readyForClient).toBe(false); expect(draft.approvedContent).toEqual([]);
  });

  it('counts BOTH actually issued raw bodies exactly at the combined2MiB boundary and refuses +1 atomically before resolver work', async () => {
    const input = source(), plan = await buildProposalAreaPlan(input), small = await recordFor(plan, input, 0), target = PROPOSAL_WHOLE_DRAFT_LIMITS.combinedRawBytes - small.record.reviewResponse.rawBytes;
    const exact = await recordFor(plan, input, 0, undefined, undefined, target), exactTotal = exact.record.response.rawBytes + exact.record.reviewResponse.rawBytes;
    expect(exactTotal).toBe(PROPOSAL_WHOLE_DRAFT_LIMITS.combinedRawBytes); const draft = await buildProposalWholeDraft(plan, [exact.record], input); expect(draft.audit.combinedRawBytes).toBe(exactTotal);
    const over = await recordFor(plan, input, 0, undefined, undefined, target, 1), digest = vi.fn(); expect(over.record.response.rawBytes + over.record.reviewResponse.rawBytes).toBe(exactTotal + 1);
    vi.stubGlobal('crypto', { subtle: { digest } }); await expect(buildProposalWholeDraft(plan, [over.record], input)).rejects.toThrow(/2МиБ/u); expect(digest).not.toHaveBeenCalled();
  });

  it('bounds count before resolving forged wrappers and never calls providers, workers, export or storage', async () => {
    const input = source(), { plan, records } = await complete(input), fetch = vi.fn(), Worker = vi.fn(); vi.stubGlobal('fetch', fetch); vi.stubGlobal('Worker', Worker);
    await expect(buildProposalWholeDraft(plan, Array.from({ length: 65 }, () => records[0]), input)).rejects.toThrow(/64/u);
    const draft = await buildProposalWholeDraft(plan, records, input); expect(await revalidateProposalWholeDraft(draft, plan, records, input)).toBe(draft); expect(fetch).not.toHaveBeenCalled(); expect(Worker).not.toHaveBeenCalled();
    expect(PROPOSAL_WHOLE_DRAFT_LIMITS).toEqual({ records: 64, combinedRawBytes: 2 * 1024 * 1024, draftBytes: 16 * 1024 * 1024 });
  });
});
