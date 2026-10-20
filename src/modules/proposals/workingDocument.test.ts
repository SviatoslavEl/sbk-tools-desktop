import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildProposalAreaPlan, buildProposalAreaReviewPlan, parseProposalAreaBlockResponse, parseProposalAreaReviewResponse, PROPOSAL_AREAS } from '../intelligence/proposalAreaPlan';
import { buildProposalWholeDraft, type ProposalWholeDraftRecord } from '../intelligence/proposalWholeDraft';
import { createProposalDraftEditorHandoff, editProposalDraftEditorBlock, projectProposalDraftEditorPreview, type ProposalDraftEditorHandoff } from '../intelligence/proposalDraftEditorAdapter';
import type { IntelligenceSource } from '../intelligence/workbenchTypes';
import { createWorkingProposal, createWorkingProposalReviewIntent, editWorkingProposal, fingerprintWorkingProposal, fingerprintWorkingProposalPublic,
  inspectWorkingProposalHistory, parseWorkingProposalDocument, projectWorkingProposalPublic, serializeWorkingProposalDocument, validateWorkingProposalDocument,
  WORKING_PROPOSAL_LIMITS, type WorkingProposalDocument } from './workingDocument';

const ID = 'a1234567-1234-4234-8234-123456789abc';
/** Synthetic, actually parser-issued capabilities. No model/provider is run. */
async function issuedFixture(withWitness = false) {
  const sources: IntelligenceSource[] = [{ id: 'synthetic', name: 'PRIVATE_SOURCE_NAME', sha256: 'b'.repeat(64), text: 'PRIVATE_SOURCE_AGGREGATE', warnings: ['PRIVATE_SOURCE_WARNING'],
    coverage: { complete: true, requiresOcr: false }, fragments: [{ id: 'owner-0', locator: 'PRIVATE_OWNER_LOCATOR', text: withWitness ? 'PRIVATE_NON_NULL_WITNESS_ONLY' : 'WHOLE_SYNTHETIC_SOURCE_TEXT', structure: {
      version: 1, format: 'docx', method: 'ooxml', part: 'word/document.xml', kind: 'paragraph', containerId: 'body', order: 0, physicalSection: 0 } }] }];
  const plan = await buildProposalAreaPlan(sources), records: ProposalWholeDraftRecord[] = [];
  for (const block of plan.blocks) {
    const response = await parseProposalAreaBlockResponse(JSON.stringify({ schemaCarrier: plan.schemaCarrier, planKey: plan.planKey, sourceSnapshotKey: plan.sourceSnapshotKey, structureSnapshotKey: plan.structureSnapshotKey,
      blockId: block.id, areas: Object.fromEntries(PROPOSAL_AREAS.map(area => [area, area === 'payment' ? { status: 'not-stated', answer: null, evidenceRefs: [] }
        : { status: 'answered', answer: `  Деловой текст ${area}\r\nПолный блок 🧪 e\u0301.  `, evidenceRefs: [{ ownerId: 'owner-0', cellIndex: null }] }])) }), plan, block.id, sources);
    const reviewPlan = await buildProposalAreaReviewPlan(response, plan, sources);
    const reviewResponse = await parseProposalAreaReviewResponse(JSON.stringify({ schemaCarrier: plan.schemaCarrier, reviewContract: 'state-aware-primary-v2', reviewPlanKey: reviewPlan.reviewPlanKey, planKey: plan.planKey, sourceSnapshotKey: plan.sourceSnapshotKey,
      structureSnapshotKey: plan.structureSnapshotKey, blockId: block.id, areas: Object.fromEntries(PROPOSAL_AREAS.map(area => [area, withWitness && area === 'payment'
        ? { verdict: 'unsupported', reason: 'SYNTHETIC diagnostic only', basis: 'primary-answer-found', counterexample: { ownerId: 'owner-0', cellIndex: null, quote: 'PRIVATE_NON_NULL_WITNESS_ONLY' } }
        : { verdict: 'supported', reason: `PRIVATE_REVIEW_REASON_${area}`, basis: response.areas[area].status === 'answered' ? 'answer-supported' : 'primary-no-answer', counterexample: null }])) }), reviewPlan, plan, sources);
    records.push({ response, reviewPlan, reviewResponse });
  }
  const draft = await buildProposalWholeDraft(plan, records, sources), handoff = await createProposalDraftEditorHandoff(draft, plan, records, sources);
  return { draft, handoff };
}
let original: WorkingProposalDocument, originalHistory: string;
beforeAll(async () => { const f = await issuedFixture(), created = await createWorkingProposal(f.handoff, { id: ID }); original = created.document; originalHistory = created.historyJson; });
afterEach(() => vi.restoreAllMocks());
const ordinary = () => parseWorkingProposalDocument(serializeWorkingProposalDocument(original));
const digest = async (text: string) => `sha256:${Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), byte => byte.toString(16).padStart(2, '0')).join('')}`;

describe('ordinary working proposal, not proof restoration or an export operation', () => {
  it('preserves a non-null reviewer witness only in private history through ordinary conversion and real publicV3 projection', async () => {
    const { handoff } = await issuedFixture(true), { document, historyJson } = await createWorkingProposal(handoff);
    expect(historyJson).toContain('PRIVATE_NON_NULL_WITNESS_ONLY');
    const review = await projectWorkingProposalPublic(document, 'review-draft');
    const intent = await createWorkingProposalReviewIntent(document), final = await projectWorkingProposalPublic(document, 'final', intent);
    for (const publicValue of [review, final]) {
      const serialized = JSON.stringify(publicValue);
      expect(publicValue.schemaVersion).toBe(3); expect(serialized).not.toContain('PRIVATE_NON_NULL_WITNESS_ONLY');
      expect(serialized).not.toContain('counterexample'); expect(serialized).not.toContain('primary-answer-found');
    }
    expect(document.sections.find(section => section.area === 'payment')?.blocks).toEqual([]);
    expect(await inspectWorkingProposalHistory(document, historyJson)).toEqual({ state: 'available-unvalidated', warning: null });
    // Pure projection only: no native command, filesystem output or rendering.
  });
  it('does not accept duplicate historical JSON keys even with an exact matching hash', async () => {
    const doc = ordinary(), duplicated = originalHistory.replace('{', '{"version":1,');
    const altered = { ...doc, historicalSource: { ...doc.historicalSource, bytes: new TextEncoder().encode(duplicated).byteLength, sha256: (await digest(duplicated)).slice(7) } };
    expect((await inspectWorkingProposalHistory(altered, duplicated)).state).toBe('mismatch');
  });
  it('creates a separate bounded historical blob with exact hash/bytes and no business defaults', async () => {
    const f = await issuedFixture(), before = JSON.stringify(f.draft), created = await createWorkingProposal(f.handoff, { id: ID });
    expect(created.historyJson).toBe(before); expect(JSON.stringify(f.draft)).toBe(before);
    expect(created.document.historicalSource).toMatchObject({ kind: 'unvalidated-history', sha256: (await digest(before)).slice(7), bytes: new TextEncoder().encode(before).length });
    expect(created.document.sections.map(section => section.area)).toEqual(PROPOSAL_AREAS);
    expect(created.document.sections[0].blocks[0].text).toBe(f.handoff.sections[0].blocks[0].text);
    expect(created.document.metadata).toEqual({ number: null, documentDate: null, validUntil: null, currency: null, issuerName: null, recipientName: null });
    for (const key of ['privateContext', 'sourceSnapshot', 'humanApproval', 'readyForClient', 'audit', 'currency', 'lines', 'totals', 'historyJson']) expect(created.document).not.toHaveProperty(key);
    expect(created.historyJson).toContain('PRIVATE_SOURCE_AGGREGATE'); expect(JSON.stringify(created.document)).not.toContain('PRIVATE_SOURCE_AGGREGATE');
    expect(await inspectWorkingProposalHistory(created.document, created.historyJson)).toEqual({ state: 'available-unvalidated', warning: null });
  });

  it('preserves current handoff edits without inheriting model evidence or including manual text by default', async () => {
    const { handoff } = await issuedFixture(); editProposalDraftEditorBlock(handoff, 'work-scope', handoff.sections[0].blocks[0].id, 'Целиком изменённый текст\n🧪');
    handoff.sections[0].userText = 'Ручной абзац\nбез автоматической отправки'; handoff.questions[0].answer = 'PRIVATE_USER_ANSWER';
    const { document } = await createWorkingProposal(handoff);
    expect(document.sections[0]).toMatchObject({ userText: handoff.sections[0].userText, userTextIncluded: false });
    expect(document.sections[0].blocks[0]).toMatchObject({ text: 'Целиком изменённый текст\n🧪', origin: 'user-edit-unreviewed', included: true });
    expect(document.questions[0]).toMatchObject({ answer: 'PRIVATE_USER_ANSWER', state: 'answered' });
    expect(JSON.stringify(await projectWorkingProposalPublic(document, 'review-draft'))).not.toContain('PRIVATE_USER_ANSWER');
  });

  it('roundtrips decoded LF/CR/Unicode, nulls, choices, whole order, answers and question states exactly', () => {
    const edited = editWorkingProposal(ordinary(), draft => {
      draft.title = '  КП 🧪\nбез нормализации  '; draft.metadata.number = '  № 01\t '; draft.metadata.documentDate = '2032-02-29'; draft.metadata.currency = 'USD';
      draft.sections[0].blocks[0].text = '  e\u0301\r\n漢字 🧪\n  '; draft.sections[0].blocks[0].included = false;
      draft.sections[1].userText = '  Новый\nабзац\r\n'; draft.sections[1].userTextIncluded = true;
      draft.questions[0].answer = '  PRIVATE_ANSWER\n🧪  '; draft.questions[0].state = 'answered'; draft.questions[1].state = 'resolved';
    });
    const text = serializeWorkingProposalDocument(edited), reopened = parseWorkingProposalDocument(text);
    expect(reopened).toEqual(edited); expect(serializeWorkingProposalDocument(reopened)).toBe(text); expect(reopened.revision).toBe(1);
    expect(reopened.sections[0].blocks[0].origin).toBe('user-edit-unreviewed'); expect(reopened.metadata.validUntil).toBeNull();
    expect(() => projectProposalDraftEditorPreview(reopened as unknown as ProposalDraftEditorHandoff)).toThrow();
    expect(reopened).not.toHaveProperty('humanApproval');
  });

  it('rejects a JSON handoff copy and detects edits across the history hash await', async () => {
    const { handoff } = await issuedFixture(); await expect(createWorkingProposal(structuredClone(handoff))).rejects.toThrow();
    const native = crypto.subtle.digest.bind(crypto.subtle); let release!: () => void;
    vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(async (...args) => { await new Promise<void>(resolve => { release = resolve; }); return native(...args); });
    const pending = createWorkingProposal(handoff); handoff.sections[0].userText = 'Changed while hashing'; release(); await expect(pending).rejects.toThrow(/изменился/);
  });

  it('has deterministic exact ordinary-body and selected public fingerprints with different purposes', async () => {
    const document = ordinary(), serialized = serializeWorkingProposalDocument(document);
    expect(await fingerprintWorkingProposal(document)).toBe(await digest(serialized));
    const preview = await projectWorkingProposalPublic(document, 'review-draft'); expect(await fingerprintWorkingProposalPublic(document, 'review-draft')).toBe(await digest(JSON.stringify(preview)));
    const changed = editWorkingProposal(document, draft => { draft.questions[0].answer = 'PRIVATE_ONLY_ANSWER'; });
    expect(await fingerprintWorkingProposal(changed)).not.toBe(await fingerprintWorkingProposal(document));
    expect(await fingerprintWorkingProposalPublic(changed)).toBe(await fingerprintWorkingProposalPublic(document));
  });

  it('structurally excludes private envelopes, IDs, diagnostics, nonselected blocks and answers, not legitimate business prose', async () => {
    const document = editWorkingProposal(ordinary(), draft => {
      draft.sections[0].blocks[0].text = 'PRIVATE_SOURCE_AGGREGATE — это теперь явно выбранное деловое условие.';
      draft.sections[1].blocks[0].included = false; draft.sections[1].blocks[0].text = 'NOT_SELECTED_SENTINEL';
      draft.sections[0].userText = 'PRIVATE_ANSWER_INSERTED_EXPLICITLY'; draft.sections[0].userTextIncluded = true;
      draft.questions[0].answer = 'PRIVATE_ANSWER_NEVER_INSERTED'; draft.questions[0].state = 'resolved';
    });
    const projection = await projectWorkingProposalPublic(document, 'review-draft'), body = JSON.stringify(projection);
    expect(Object.keys(projection)).toEqual(['kind', 'schemaVersion', 'mode', 'title', 'metadata', 'layout', 'sections']);
    expect(body).toContain('PRIVATE_SOURCE_AGGREGATE —'); expect(body).toContain('PRIVATE_ANSWER_INSERTED_EXPLICITLY');
    for (const sentinel of ['PRIVATE_ANSWER_NEVER_INSERTED', 'NOT_SELECTED_SENTINEL', 'PRIVATE_OWNER_LOCATOR', 'PRIVATE_SOURCE_WARNING', 'PRIVATE_REVIEW_REASON_', 'sourceSnapshotKey', 'historicalSource', 'frameId', 'origin', 'questions', 'evidenceRefs', 'rawSHA256']) expect(body).not.toContain(sentinel);
    expect(projection.sections[0].blocks).toEqual([document.sections[0].blocks[0].text, document.sections[0].userText]);
    expect(projection.metadata.currency).toBeNull();
  });

  it('requires a fresh same-document human intent for final, not save/reload, a model verdict or zero questions', async () => {
    const document = ordinary(); expect(document.questions.some(question => question.state === 'open')).toBe(true);
    await expect(projectWorkingProposalPublic(document, 'final')).rejects.toThrow(/явная проверка/);
    const intent = await createWorkingProposalReviewIntent(document), projection = await projectWorkingProposalPublic(document, 'final', intent);
    expect(projection.mode).toBe('final'); expect(projection.schemaVersion).toBe(3); expect(projection).not.toHaveProperty('humanApproval');
    await expect(projectWorkingProposalPublic(document, 'final', structuredClone(intent))).rejects.toThrow();
    await expect(projectWorkingProposalPublic(parseWorkingProposalDocument(serializeWorkingProposalDocument(document)), 'final', intent)).rejects.toThrow();
  });

  it('invalidates review on text, selection, manual inclusion, metadata, layout and private resolution changes', async () => {
    const edits: Array<(document: WorkingProposalDocument) => void> = [draft => { draft.title += '!'; }, draft => { draft.sections[0].blocks[0].text += '!'; },
      draft => { draft.sections[0].blocks[0].included = false; }, draft => { draft.sections[0].userTextIncluded = true; }, draft => { draft.metadata.recipientName = 'Explicit company'; },
      draft => { draft.layout.style = 'compact'; }, draft => { draft.questions[0].answer = 'Private answer'; }, draft => { draft.questions[0].state = 'resolved'; }];
    for (const edit of edits) { const document = ordinary(), intent = await createWorkingProposalReviewIntent(document); edit(document); await expect(projectWorkingProposalPublic(document, 'final', intent)).rejects.toThrow(); }
  });

  it('preserves an empty ordinary draft and useful unresolved review draft but refuses an empty final', async () => {
    const document = editWorkingProposal(ordinary(), draft => { draft.sections.forEach(section => { section.blocks.forEach(block => { block.included = false; }); section.userTextIncluded = false; }); });
    expect(parseWorkingProposalDocument(serializeWorkingProposalDocument(document))).toEqual(document);
    expect((await projectWorkingProposalPublic(document, 'review-draft')).sections.every(section => section.blocks.length === 0)).toBe(true);
    await expect(createWorkingProposalReviewIntent(document)).rejects.toThrow(/выберите или введите/);
  });

  it('reports missing/mismatched private history without changing the ordinary text or filling evidence', async () => {
    const document = ordinary(), before = serializeWorkingProposalDocument(document);
    expect((await inspectWorkingProposalHistory(document)).state).toBe('missing');
    expect((await inspectWorkingProposalHistory(document, `${originalHistory} `)).state).toBe('mismatch');
    expect((await inspectWorkingProposalHistory(document, originalHistory.replace('PRIVATE_SOURCE_NAME', 'PRIVATE_SOURCE_NAMF'))).state).toBe('mismatch');
    expect((await inspectWorkingProposalHistory(document, 'x'.repeat(WORKING_PROPOSAL_LIMITS.historyBytes + 1))).state).toBe('mismatch');
    expect(serializeWorkingProposalDocument(document)).toBe(before); expect((await inspectWorkingProposalHistory(document, originalHistory)).state).toBe('available-unvalidated');
  });

  it('does not treat matching bytes/hash as issued history or accept a foreign source tuple/approval envelope', async () => {
    for (const mutate of [(history: any) => { history.planKey = `sha256:${'c'.repeat(64)}`; }, (history: any) => { history.humanApproval = true; },
      (history: any) => { history.privateExtra = 'FOREIGN_PRIVATE'; }]) {
      const document = ordinary(), history = JSON.parse(originalHistory); mutate(history); const historyJson = JSON.stringify(history);
      Object.assign(document.historicalSource, { bytes: new TextEncoder().encode(historyJson).length, sha256: (await digest(historyJson)).slice(7) });
      expect((await inspectWorkingProposalHistory(document, historyJson)).state).toBe('mismatch');
    }
  });

  it('retains explicitly ordered whole blocks and rejects revision overflow without mutating the original', () => {
    const document = ordinary(), first = document.sections[0].blocks[0];
    document.sections[0].blocks = [{ ...first, id: 'manual-order-second', frameId: 'frame-2', frameIndex: 2, text: 'second first' }, first];
    expect(parseWorkingProposalDocument(serializeWorkingProposalDocument(document)).sections[0].blocks.map(block => block.text)).toEqual(['second first', first.text]);
    const revised = editWorkingProposal(document, draft => { draft.sections[0].blocks.reverse(); });
    expect(revised.sections[0].blocks.map(block => block.id)).toEqual([first.id, 'manual-order-second']);
    const overflow = ordinary(); Object.assign(overflow, { revision: Number.MAX_SAFE_INTEGER }); const before = serializeWorkingProposalDocument(overflow);
    expect(() => editWorkingProposal(overflow, () => {})).toThrow(/счётчик/); expect(serializeWorkingProposalDocument(overflow)).toBe(before);
  });

  it('applies edits transactionally and never promotes changed whole text or replaces stable history/meaning', () => {
    const document = ordinary(), before = serializeWorkingProposalDocument(document);
    expect(() => editWorkingProposal(document, draft => { draft.sections[0].blocks[0].text = 'x'.repeat(20_001); })).toThrow();
    expect(serializeWorkingProposalDocument(document)).toBe(before);
    const edited = editWorkingProposal(document, draft => { draft.sections[0].blocks[0].text = 'new'; });
    expect(edited.sections[0].blocks[0].origin).toBe('user-edit-unreviewed');
    const again = editWorkingProposal(edited, draft => { draft.sections[0].blocks[0].origin = 'historical-model-answer'; }); expect(again.sections[0].blocks[0].origin).toBe('user-edit-unreviewed');
    expect(() => editWorkingProposal(document, draft => { draft.sections[0].blocks = []; })).toThrow();
    expect(() => editWorkingProposal(document, draft => { (draft.historicalSource as { sha256: string }).sha256 = 'c'.repeat(64); })).toThrow();
    expect(() => editWorkingProposal(document, draft => { (draft.questions[0] as { question: string }).question = 'Different meaning'; })).toThrow();
    expect(() => editWorkingProposal(document, (() => Promise.resolve()) as unknown as (draft: WorkingProposalDocument) => void)).toThrow(/синхронной/);
  });

  it('validates exact Unicode limit without slicing and aggregate 8MiB without partial replacement', () => {
    const document = ordinary(); document.sections[0].userText = '🧪'.repeat(20_000); expect(() => validateWorkingProposalDocument(document)).not.toThrow();
    document.sections[0].userText += '🧪'; expect(() => validateWorkingProposalDocument(document)).toThrow();
    const huge = ordinary(); huge.sections.forEach((section, index) => { section.blocks = Array.from({ length: 64 }, (_, at) => ({ id: `block-${index}-${at}`, frameId: `frame-${at}`, frameIndex: at, text: 'x'.repeat(20_000), origin: 'historical-model-answer', included: true })); });
    expect(() => serializeWorkingProposalDocument(huge)).toThrow(/8 МиБ/);
  });

  it('rejects future/legacy/private-extra/corrupt/unsafe forms instead of normalization or fallback', () => {
    const mutators: Array<(document: any) => void> = [document => { document.schemaVersion = 2; }, document => { document.kind = 'proposal'; }, document => { document.humanApproval = true; },
      document => { document.privateContext = { sentinel: 'PRIVATE' }; }, document => { document.metadata.extra = 'PRIVATE'; }, document => { delete document.metadata.currency; },
      document => { document.sections[0].blocks[0].evidenceRefs = []; }, document => { document.sections[0].blocks[0].frameIndex = 64; },
      document => { document.sections.reverse(); }, document => { document.sections[1].blocks[0].id = document.sections[0].blocks[0].id; },
      document => { document.questions[1].id = document.questions[0].id; }, document => { document.questions[0].state = 'approved'; }, document => { document.questions[0].answer = '\ud800'; },
      document => { document.metadata.documentDate = '2031-02-29'; }, document => { document.metadata.validUntil = ''; }, document => { document.layout.style = ['standard']; },
      document => { document.title = 'bad\u0000'; }, document => { document.revision = -1; }, document => { document.id = '../bad'; }, document => { document.historicalSource.path = '/PRIVATE/PATH'; },
      document => { document.historicalSource.bytes = WORKING_PROPOSAL_LIMITS.historyBytes + 1; }];
    for (const mutate of mutators) { const document = ordinary(); mutate(document); expect(() => parseWorkingProposalDocument(document)).toThrow(); }
    const getter = ordinary(); Object.defineProperty(getter, 'title', { enumerable: true, get() { throw new Error('Getter must not run'); } }); expect(() => validateWorkingProposalDocument(getter)).toThrow(/структура/);
    const holes = ordinary(); delete holes.sections[0].blocks[0]; expect(() => validateWorkingProposalDocument(holes)).toThrow();
    expect(() => parseWorkingProposalDocument('{broken')).toThrow();
    expect(() => parseWorkingProposalDocument(serializeWorkingProposalDocument(ordinary()).replace('"schemaVersion":1', '"schemaVersion":2,"schemaVersion":1'))).toThrow(/неоднозначный/);
    expect(() => parseWorkingProposalDocument(serializeWorkingProposalDocument(ordinary()).replace('"currency":null', '"currency":"PRIVATE","currency":null'))).toThrow(/неоднозначный/);
  });

  it('detects ordinary snapshot mutation during fingerprint and final-review hash awaits', async () => {
    for (const kind of ['fingerprint', 'review'] as const) {
      const document = ordinary(), native = crypto.subtle.digest.bind(crypto.subtle); let release!: () => void;
      const spy = vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(async (...args) => { await new Promise<void>(resolve => { release = resolve; }); return native(...args); });
      const pending = kind === 'fingerprint' ? fingerprintWorkingProposal(document) : createWorkingProposalReviewIntent(document);
      document.questions[0].answer = 'Changed during hash'; release(); await expect(pending).rejects.toThrow(/изменилось/); spy.mockRestore();
    }
  });
});
