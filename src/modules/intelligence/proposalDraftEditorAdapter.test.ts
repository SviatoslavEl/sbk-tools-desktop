import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildProposalAreaPlan, buildProposalAreaReviewPlan, parseProposalAreaBlockResponse, parseProposalAreaReviewResponse, PROPOSAL_AREAS, type ProposalArea, type ProposalAreaAnswer } from './proposalAreaPlan';
import { buildProposalWholeDraft, type ProposalWholeDraftRecord } from './proposalWholeDraft';
import { createProposalDraftEditorHandoff, editProposalDraftEditorBlock, projectProposalDraftEditorPreview, PROPOSAL_DRAFT_EDITOR_LIMITS } from './proposalDraftEditorAdapter';
import type { IntelligenceSource } from './workbenchTypes';
import { syntheticReview, syntheticReviewContract } from './proposalAreaReview.test-fixture';

function source(): IntelligenceSource[] {
  const cells = ['OWNED_A', 'SOURCE_ONLY_PRIVATE_CELL', 'OWNED_B'].map((text, index) => ({ index, text, gridSpan: 1, verticalMerge: 'none' as const, nestedTableCount: 0 }));
  return [{ id: 'synthetic-source', name: 'Synthetic source', sha256: 'b'.repeat(64), text: 'PRIVATE_AGGREGATE_NOT_MODEL_TEXT', warnings: ['PRIVATE_SOURCE_WARNING'],
    coverage: { complete: true, requiresOcr: false }, fragments: [{ id: 'owner-0', locator: 'Native row', text: cells.map(cell => cell.text).join('\t'), structure: {
      version: 1, format: 'docx', method: 'ooxml', part: 'word/document.xml', kind: 'table-row', containerId: 'table-A', tableId: 'table-A', order: 0,
      physicalSection: 0, rowIndex: 0, rowCount: 1, headerMarker: true, cells,
    } }] }];
}
/** Synthetic parser-issued objects only. Supported mock verdicts test the
 * adapter's admission policy, never a real model's semantic accuracy. */
async function fixture(options: { answers?: Partial<Record<ProposalArea, ProposalAreaAnswer>>; verdicts?: Partial<Record<ProposalArea, 'supported' | 'unsupported' | 'unclear'>> } = {}) {
  const sources = source(), plan = await buildProposalAreaPlan(sources), records: ProposalWholeDraftRecord[] = [];
  for (const block of plan.blocks) {
    const areas = Object.fromEntries(PROPOSAL_AREAS.map((area, index) => [area, options.answers?.[area] || { status: 'answered', answer: `  MODEL_${area}\r\nWhole unchanged bundle ${index}.  `,
      evidenceRefs: index % 2 ? [{ ownerId: 'owner-0', cellIndex: 0 }] : [{ ownerId: 'owner-0', cellIndex: 2 }, { ownerId: 'owner-0', cellIndex: 0 }] }]));
    const response = await parseProposalAreaBlockResponse(JSON.stringify({ schemaCarrier: plan.schemaCarrier, planKey: plan.planKey, sourceSnapshotKey: plan.sourceSnapshotKey, structureSnapshotKey: plan.structureSnapshotKey, blockId: block.id, areas }), plan, block.id, sources);
    const reviewPlan = await buildProposalAreaReviewPlan(response, plan, sources);
    const reviewResponse = await parseProposalAreaReviewResponse(JSON.stringify({ ...syntheticReviewContract, reviewPlanKey: reviewPlan.reviewPlanKey, planKey: plan.planKey, sourceSnapshotKey: plan.sourceSnapshotKey, structureSnapshotKey: plan.structureSnapshotKey,
      blockId: block.id, areas: Object.fromEntries(PROPOSAL_AREAS.map(area => [area, syntheticReview(response.areas[area].status, options.verdicts?.[area], `PRIVATE_REVIEW_DIAGNOSTIC_${area}`)])) }), reviewPlan, plan, sources);
    records.push({ response, reviewPlan, reviewResponse });
  }
  const draft = await buildProposalWholeDraft(plan, records, sources);
  return { sources, plan, records, draft };
}
afterEach(() => vi.unstubAllGlobals());

describe('separate unapproved seven-area editor adapter, not a canonical or public proposal', () => {
  it('preserves complete supported whole bundles and their own ordered refs without source-only completion or defaults', async () => {
    const f = await fixture(), before = structuredClone(f.sources), handoff = await createProposalDraftEditorHandoff(f.draft, f.plan, f.records, f.sources);
    expect(handoff.sections.map(section => section.area)).toEqual([...PROPOSAL_AREAS]);
    expect(handoff.privateContext.originalDraft).toBe(f.draft);
    handoff.sections.forEach((section, at) => {
      expect(section.blocks.map(block => block.text)).toEqual(f.draft.sections[at].bundles.map(bundle => bundle.text));
      expect(section.blocks.every(block => block.origin === 'unchanged-model-answer')).toBe(true);
      expect(section.userText).toBe('');
      expect(f.draft.sections[at].bundles[0].evidenceRefs).toEqual(f.records[0].response.areas[section.area].evidenceRefs);
      for (const block of section.blocks) for (const key of ['evidenceRefs', 'claims', 'quote', 'price', 'sourceCompletion']) expect(block).not.toHaveProperty(key);
    });
    expect(handoff).toMatchObject({ kind: 'unapproved-model-draft', readyForClient: false, humanApproval: false, publicCPAllowed: false, semanticTruth: 'not-proven', originalModelAnswersModified: false, perClaimRefAttribution: 'not-provided' });
    for (const key of ['currency', 'issuer', 'recipient', 'documentDate', 'validUntil', 'lines', 'sourceFinancials', 'commercialDocument', 'commercialScopeSnapshot', 'publicDocument']) expect(handoff).not.toHaveProperty(key);
    const preview = projectProposalDraftEditorPreview(handoff), serialized = JSON.stringify(preview);
    for (const marker of ['SOURCE_ONLY_PRIVATE_CELL', 'PRIVATE_AGGREGATE', 'PRIVATE_SOURCE_WARNING', 'PRIVATE_REVIEW_DIAGNOSTIC']) expect(serialized).not.toContain(marker);
    for (const key of ['rawSHA256', 'extractionResponse', 'evidenceRefs', 'audit', 'privateContext', 'sourceSnapshot']) expect(serialized).not.toContain(`"${key}"`);
    expect(preview.sections).not.toBe(handoff.sections); expect(preview.sections[0].blocks).not.toBe(handoff.sections[0].blocks);
    expect(f.sources).toEqual(before); expect(Object.isFrozen(f.sources[0])).toBe(false); expect(Object.isFrozen(f.draft)).toBe(true);
  });

  it('keeps blocked, unclear and model-not-found context private and every area editable without claiming absence as truth', async () => {
    const f = await fixture({ answers: { payment: { status: 'not-stated', answer: null, evidenceRefs: [] }, schedule: { status: 'unclear', answer: null, evidenceRefs: [] } }, verdicts: { 'parties-roles': 'unsupported' } });
    const handoff = await createProposalDraftEditorHandoff(f.draft, f.plan, f.records, f.sources), payment = handoff.sections.find(section => section.area === 'payment')!, parties = handoff.sections.find(section => section.area === 'parties-roles')!, schedule = handoff.sections.find(section => section.area === 'schedule')!;
    expect(payment).toMatchObject({ sourceState: 'MODEL_NOT_FOUND_NEEDS_CLARIFICATION', modelAbsence: 'model-not-found-in-supplied-source-not-proof', blocks: [] });
    expect(parties).toMatchObject({ sourceState: 'BLOCKED_REVIEW', modelAbsence: 'not-claimed', blocks: [] }); expect(schedule.blocks).toEqual([]);
    expect(handoff.privateContext.originalDraft.audit.frames[0].extractionResponse.areas['parties-roles'].answer).toContain('MODEL_parties-roles');
    expect(handoff.questions.map(question => question.id)).toEqual(f.draft.clarificationQuestions.map(question => question.id));
    for (const section of handoff.sections) section.userText = `User-entered draft for ${section.area}`;
    handoff.questions[0].answer = 'User input, not an approval.';
    const preview = projectProposalDraftEditorPreview(handoff);
    expect(preview.sections.every(section => section.userText)).toBe(true); expect(preview.questions[0].answerOrigin).toBe('user-input-unreviewed');
    expect(JSON.stringify(preview)).not.toContain('MODEL_parties-roles'); expect(preview.readyForClient).toBe(false); expect(preview.humanApproval).toBe(false);
  });

  it('marks an edit unreviewed and preserves original answer/refs without inheriting evidence for the edited text', async () => {
    const f = await fixture(), handoff = await createProposalDraftEditorHandoff(f.draft, f.plan, f.records, f.sources), block = handoff.sections[0].blocks[0], originalText = block.text, originalRefs = f.draft.sections[0].bundles[0].evidenceRefs;
    editProposalDraftEditorBlock(handoff, 'work-scope', block.id, 'User changed the entire displayed bundle.');
    expect(block).toMatchObject({ text: 'User changed the entire displayed bundle.', origin: 'user-edit-unreviewed' }); expect(block).not.toHaveProperty('evidenceRefs');
    expect(f.draft.sections[0].bundles[0].text).toBe(originalText); expect(f.draft.sections[0].bundles[0].evidenceRefs).toBe(originalRefs);
    expect(projectProposalDraftEditorPreview(handoff)).toMatchObject({ readyForClient: false, humanApproval: false, publicCPAllowed: false });
    block.origin = 'unchanged-model-answer'; expect(() => projectProposalDraftEditorPreview(handoff)).toThrow(/Изменённый текст/);
  });

  it('rejects copied draft/plan/record wrappers and stale sources instead of accepting persisted provenance as proof', async () => {
    const f = await fixture();
    await expect(createProposalDraftEditorHandoff(structuredClone(f.draft), f.plan, f.records, f.sources)).rejects.toThrow();
    await expect(createProposalDraftEditorHandoff(f.draft, structuredClone(f.plan), f.records, f.sources)).rejects.toThrow();
    await expect(createProposalDraftEditorHandoff(f.draft, f.plan, f.records.map(record => ({ ...record })), f.sources)).rejects.toThrow();
    const stale = structuredClone(f.sources); stale[0].warnings!.push('Changed source warning');
    await expect(createProposalDraftEditorHandoff(f.draft, f.plan, f.records, stale)).rejects.toThrow();
    const handoff = await createProposalDraftEditorHandoff(f.draft, f.plan, f.records, f.sources);
    expect(() => projectProposalDraftEditorPreview(structuredClone(handoff))).toThrow(/исходный editor handoff/);
  });

  it('rejects source or record changes while fresh validation is awaited and leaves the caller data mutable', async () => {
    for (const target of ['source', 'record']) {
      const f = await fixture(), pending = createProposalDraftEditorHandoff(f.draft, f.plan, f.records, f.sources);
      if (target === 'source') f.sources[0].text += ' changed'; else f.records[0] = { ...f.records[0] };
      await expect(pending).rejects.toThrow(/изменил|Нужны исходные|исходные записи/); expect(Object.isFrozen(f.sources[0])).toBe(false); expect(Object.isFrozen(f.records)).toBe(false);
    }
  });

  it('bounds edits without truncation or readiness changes and rejects tampered section/approval identity', async () => {
    const f = await fixture(), handoff = await createProposalDraftEditorHandoff(f.draft, f.plan, f.records, f.sources), block = handoff.sections[0].blocks[0], before = { ...block };
    expect(() => editProposalDraftEditorBlock(handoff, 'work-scope', block.id, 'x'.repeat(PROPOSAL_DRAFT_EDITOR_LIMITS.textCharacters + 1))).toThrow(/20 000/); expect(block).toEqual(before);
    expect(() => editProposalDraftEditorBlock(handoff, 'work-scope', block.id, 'bad\u0000text')).toThrow(); expect(block).toEqual(before);
    handoff.sections.reverse(); expect(() => projectProposalDraftEditorPreview(handoff)).toThrow(/состав|Состав/); handoff.sections.reverse();
    (handoff as unknown as { readyForClient: boolean }).readyForClient = true; expect(() => projectProposalDraftEditorPreview(handoff)).toThrow(/статусы/);
  });
});
