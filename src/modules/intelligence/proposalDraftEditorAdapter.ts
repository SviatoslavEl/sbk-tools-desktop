import { PROPOSAL_AREAS, type ProposalArea, type ProposalAreaPlan } from './proposalAreaPlan';
import { PROPOSAL_WHOLE_DRAFT_LIMITS, revalidateProposalWholeDraft, type ProposalWholeDraft, type ProposalWholeDraftRecord } from './proposalWholeDraft';
import { assertResponsePreparationSources } from './responsePreparationBounds';
import type { IntelligenceSource } from './workbenchTypes';

export const PROPOSAL_DRAFT_EDITOR_LIMITS = Object.freeze({ textCharacters: 20_000, editableBytes: 8 * 1024 * 1024 });
export interface ProposalDraftEditorBlock {
  readonly id: string; readonly frameId: string; readonly frameIndex: number;
  /** Editable text has no inherited evidence. Original whole-bundle evidence
   * remains exclusively in privateContext.originalDraft. */
  text: string; origin: 'unchanged-model-answer' | 'user-edit-unreviewed';
}
export interface ProposalDraftEditorSection {
  readonly area: ProposalArea; readonly title: string;
  readonly sourceState: ProposalWholeDraft['sections'][number]['state'];
  readonly modelAbsence: ProposalWholeDraft['sections'][number]['modelAbsence'];
  blocks: ProposalDraftEditorBlock[];
  /** Every area remains editable even if no supported answer was admitted. */
  userText: string; readonly userTextOrigin: 'user-input-unreviewed';
}
export interface ProposalDraftEditorQuestion {
  readonly id: string; readonly area: ProposalArea; readonly topic: string;
  readonly reason: ProposalWholeDraft['clarificationQuestions'][number]['reason'];
  readonly question: string;
  answer: string; readonly answerOrigin: 'user-input-unreviewed';
}
/** A separate editor input, deliberately not ProposalData, a commercialDocument
 * or a public DTO. Saving/reloading this data cannot restore an issued proof. */
export interface ProposalDraftEditorHandoff {
  readonly version: 1; readonly kind: 'unapproved-model-draft';
  readonly sourceSnapshotKey: string; readonly structureSnapshotKey: string; readonly planKey: string;
  sections: ProposalDraftEditorSection[]; questions: ProposalDraftEditorQuestion[];
  readonly privateContext: {
    /** Original issued immutable draft, including blocked/not-stated answers,
     * ordered whole-bundle refs, source snapshot, and review history. */
    readonly originalDraft: ProposalWholeDraft;
  };
  readonly originalModelAnswersModified: false;
  readonly perClaimRefAttribution: 'not-provided'; readonly semanticTruth: 'not-proven';
  readonly readyForClient: false; readonly humanApproval: false; readonly publicCPAllowed: false;
}
/** A private UI view, not an export authorization or ProposalPublicDocument.
 * Source text/raw responses/reviewer reasons/audit stay out of this projection. */
export type ProposalDraftEditorPreview = Omit<ProposalDraftEditorHandoff, 'privateContext'>;

const issued = new WeakMap<ProposalDraftEditorHandoff, { draft: ProposalWholeDraft; manifest: string }>();
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
function validText(value: unknown): value is string {
  return typeof value === 'string' && value.length <= PROPOSAL_DRAFT_EDITOR_LIMITS.textCharacters * 2
    && Array.from(value).length <= PROPOSAL_DRAFT_EDITOR_LIMITS.textCharacters
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)
    && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
}
function manifest(handoff: ProposalDraftEditorHandoff): string {
  return JSON.stringify({ version: handoff.version, kind: handoff.kind, sourceSnapshotKey: handoff.sourceSnapshotKey, structureSnapshotKey: handoff.structureSnapshotKey, planKey: handoff.planKey,
    sections: handoff.sections.map(section => ({ area: section.area, title: section.title, sourceState: section.sourceState, modelAbsence: section.modelAbsence, userTextOrigin: section.userTextOrigin,
      blocks: section.blocks.map(block => ({ id: block.id, frameId: block.frameId, frameIndex: block.frameIndex })) })),
    questions: handoff.questions.map(question => ({ id: question.id, area: question.area, topic: question.topic, reason: question.reason, question: question.question, answerOrigin: question.answerOrigin })),
    originalModelAnswersModified: handoff.originalModelAnswersModified, perClaimRefAttribution: handoff.perClaimRefAttribution, semanticTruth: handoff.semanticTruth,
    readyForClient: handoff.readyForClient, humanApproval: handoff.humanApproval, publicCPAllowed: handoff.publicCPAllowed });
}
function assertEditableContent(handoff: ProposalDraftEditorHandoff): void {
  const original = issued.get(handoff);
  if (!original || handoff.privateContext.originalDraft !== original.draft || manifest(handoff) !== original.manifest) throw new Error('Нужен исходный editor handoff; состав, происхождение и статусы черновика не подменяются.');
  let size = 0;
  const charge = (text: unknown) => { if (!validText(text)) throw new Error('Редактируемый текст превышает 20 000 символов или содержит недопустимые символы. Ничего не усечено.'); size += bytes(text); };
  for (let at = 0; at < handoff.sections.length; at++) {
    const section = handoff.sections[at], source = original.draft.sections[at];
    charge(section.userText);
    section.blocks.forEach((block, index) => {
      charge(block.text);
      if (!['unchanged-model-answer', 'user-edit-unreviewed'].includes(block.origin)
        || block.origin === 'unchanged-model-answer' && block.text !== source.bundles[index].text) throw new Error('Изменённый текст нельзя выдавать за исходный ответ модели.');
    });
  }
  for (const question of handoff.questions) charge(question.answer);
  if (size > PROPOSAL_DRAFT_EDITOR_LIMITS.editableBytes) throw new Error('Редактируемая часть превышает 8 МиБ. Частичный черновик не выдан.');
}

/** Fresh proof validation happens on the SAME issued draft, plan, record
 * wrappers and source input. Only then are ordinary mutable editor fields made.
 * No source-completion tail, canonical prover, default currency/date/price or
 * automatic pricing/party decision participates in this adapter. */
export async function createProposalDraftEditorHandoff(draft: ProposalWholeDraft, plan: ProposalAreaPlan, records: readonly ProposalWholeDraftRecord[], sources: readonly IntelligenceSource[]): Promise<ProposalDraftEditorHandoff> {
  assertResponsePreparationSources(sources);
  const sourceBefore = JSON.stringify(sources);
  if (!Array.isArray(records) || records.length > PROPOSAL_WHOLE_DRAFT_LIMITS.records) throw new Error('Нужны исходные записи полного запуска в допустимых пределах.');
  const recordBefore = Array.from(records, wrapper => ({ wrapper, response: wrapper?.response, reviewPlan: wrapper?.reviewPlan, reviewResponse: wrapper?.reviewResponse }));
  const validated = await revalidateProposalWholeDraft(draft, plan, records, sources);
  assertResponsePreparationSources(sources);
  if (JSON.stringify(sources) !== sourceBefore || records.length !== recordBefore.length || recordBefore.some((entry, index) => records[index] !== entry.wrapper
    || !entry.wrapper || Object.keys(entry.wrapper).length !== 3 || entry.wrapper.response !== entry.response || entry.wrapper.reviewPlan !== entry.reviewPlan || entry.wrapper.reviewResponse !== entry.reviewResponse)) throw new Error('Материалы или исходные записи изменились во время передачи в редактор. Черновик не открыт.');
  if (validated !== draft) throw new Error('Повторная проверка должна вернуть исходный выданный черновик.');
  if (draft.sections.length !== PROPOSAL_AREAS.length || draft.sections.some((section, index) => section.area !== PROPOSAL_AREAS[index])) throw new Error('Нужен полный исходный порядок всех семи областей КП.');
  const handoff: ProposalDraftEditorHandoff = {
    version: 1, kind: 'unapproved-model-draft', sourceSnapshotKey: draft.sourceSnapshotKey, structureSnapshotKey: draft.structureSnapshotKey, planKey: draft.planKey,
    sections: draft.sections.map(section => ({ area: section.area, title: section.title, sourceState: section.state, modelAbsence: section.modelAbsence,
      blocks: section.bundles.map(bundle => ({ id: `${section.area}:${bundle.frameId}`, frameId: bundle.frameId, frameIndex: bundle.frameIndex, text: bundle.text, origin: 'unchanged-model-answer' })), userText: '', userTextOrigin: 'user-input-unreviewed' })),
    questions: draft.clarificationQuestions.map(question => ({ id: question.id, area: question.area, topic: question.topic, reason: question.reason, question: question.question, answer: '', answerOrigin: 'user-input-unreviewed' })),
    privateContext: Object.freeze({ originalDraft: draft }), originalModelAnswersModified: false, perClaimRefAttribution: 'not-provided', semanticTruth: 'not-proven', readyForClient: false, humanApproval: false, publicCPAllowed: false,
  };
  issued.set(handoff, { draft, manifest: manifest(handoff) }); assertEditableContent(handoff); return handoff;
}

/** Edits only one complete displayed bundle. It does not inherit evidence from
 * the original, reclassify blocked text, resolve questions, or approve content. */
export function editProposalDraftEditorBlock(handoff: ProposalDraftEditorHandoff, area: ProposalArea, blockId: string, text: string): void {
  assertEditableContent(handoff);
  if (!validText(text)) throw new Error('Текст превышает 20 000 символов или содержит недопустимые символы.');
  const block = handoff.sections.find(section => section.area === area)?.blocks.find(block => block.id === blockId);
  if (!block) throw new Error('Редактируемый bundle не найден в указанной области.');
  const before = { text: block.text, origin: block.origin };
  block.text = text; block.origin = 'user-edit-unreviewed';
  try { assertEditableContent(handoff); } catch (reason) { block.text = before.text; block.origin = before.origin; throw reason; }
}

export function projectProposalDraftEditorPreview(handoff: ProposalDraftEditorHandoff): ProposalDraftEditorPreview {
  assertEditableContent(handoff);
  // Explicit allowlist: never spread the envelope or any original source/audit.
  return { version: 1, kind: 'unapproved-model-draft', sourceSnapshotKey: handoff.sourceSnapshotKey, structureSnapshotKey: handoff.structureSnapshotKey, planKey: handoff.planKey,
    sections: handoff.sections.map(section => ({ area: section.area, title: section.title, sourceState: section.sourceState, modelAbsence: section.modelAbsence,
      blocks: section.blocks.map(block => ({ id: block.id, frameId: block.frameId, frameIndex: block.frameIndex, text: block.text, origin: block.origin })), userText: section.userText, userTextOrigin: section.userTextOrigin })),
    questions: handoff.questions.map(question => ({ id: question.id, area: question.area, topic: question.topic, reason: question.reason, question: question.question, answer: question.answer, answerOrigin: question.answerOrigin })),
    originalModelAnswersModified: false, perClaimRefAttribution: 'not-provided', semanticTruth: 'not-proven', readyForClient: false, humanApproval: false, publicCPAllowed: false };
}
