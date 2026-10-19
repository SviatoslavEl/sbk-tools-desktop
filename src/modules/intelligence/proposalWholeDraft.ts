import {
  PROPOSAL_AREAS, resolveProposalAreaPlan, resolveProposalAreaBlockResponse, resolveProposalAreaReviewPlan, resolveProposalAreaReviewResponse,
  type ProposalArea, type ProposalAreaPlan, type ProposalAreaBlockResponse, type ProposalAreaReviewPlan, type ProposalAreaReviewResponse, type ProposalAreaReference,
} from './proposalAreaPlan';
import { assertResponsePreparationSources } from './responsePreparationBounds';
import type { IntelligenceSource } from './workbenchTypes';

export const PROPOSAL_WHOLE_DRAFT_LIMITS = Object.freeze({ records: 64, combinedRawBytes: 2 * 1024 * 1024, draftBytes: 16 * 1024 * 1024 });
/** All three objects must be original capabilities issued by the new seven-area
 * route. Persisted JSON or old diagnostic responses cannot become proof. */
export interface ProposalWholeDraftRecord {
  readonly response: ProposalAreaBlockResponse;
  readonly reviewPlan: ProposalAreaReviewPlan;
  readonly reviewResponse: ProposalAreaReviewResponse;
}
export interface ProposalWholeDraftBundle {
  readonly frameId: string; readonly frameIndex: number; readonly text: string;
  readonly evidenceRefs: readonly ProposalAreaReference[];
  readonly origin: 'model-answer-whole-bundle'; readonly modelAnswerModified: false;
  readonly perClaimRefAttribution: 'not-provided'; readonly publicCPAllowed: false;
}
export interface ProposalWholeDraftSection {
  readonly area: ProposalArea; readonly title: string;
  readonly state: 'MODEL_DRAFT_UNAPPROVED' | 'MODEL_NOT_FOUND_NEEDS_CLARIFICATION' | 'BLOCKED_REVIEW';
  readonly bundles: readonly ProposalWholeDraftBundle[];
  /** Only a complete, supported all-frame model-not-stated result permits this
   * label. It remains a model finding, never proof of source-wide absence. */
  readonly modelAbsence: 'not-claimed' | 'model-not-found-in-supplied-source-not-proof';
}
export interface ProposalWholeDraftQuestion {
  readonly id: string; readonly area: ProposalArea; readonly topic: string;
  readonly reason: 'MODEL_NOT_FOUND' | 'BLOCKED_REVIEW';
  readonly question: string; readonly frameIds: readonly string[]; readonly ownerIds: readonly string[];
}
export type ProposalWholeDraftAreaState = 'MODEL_ANSWER_SUPPORTED_UNAPPROVED' | 'MODEL_NOT_STATED_SUPPORTED_LOCAL_ONLY' | 'MODEL_EXTRACTION_UNCLEAR_BLOCKED' | 'MODEL_REVIEW_UNSUPPORTED_BLOCKED' | 'MODEL_REVIEW_UNCLEAR_BLOCKED';
export interface ProposalWholeDraft {
  readonly version: 1; readonly purpose: 'unapproved-model-whole-proposal-draft';
  readonly planKey: string; readonly sourceSnapshotKey: string; readonly structureSnapshotKey: string;
  /** The exact source including aggregate, every owner/native cell and warnings
   * is retained once. Source-only material is not appended to review text. */
  readonly sourceSnapshot: readonly IntelligenceSource[];
  readonly owners: readonly { readonly ownerId: string; readonly fragmentIndex: number; readonly locator: string }[];
  readonly sections: readonly ProposalWholeDraftSection[];
  readonly clarificationQuestions: readonly ProposalWholeDraftQuestion[];
  /** An untyped detail is not an identified missing value or a clarification
   * question. This checklist does not substitute for model extraction. */
  readonly unvalidatedDetails: readonly {
    readonly area: ProposalArea; readonly topics: readonly string[];
    readonly state: 'SUBFIELD_COMPLETENESS_NOT_ASSESSED'; readonly notEvidenceOfMissingValues: true;
  }[];
  /** Private audit data, not client text. Whole model bundles and ordered refs
   * are retained; no split-claim or inherited-ref attribution is manufactured. */
  readonly audit: {
    readonly frames: readonly {
      readonly frameId: string; readonly frameIndex: number; readonly primaryOwnerIds: readonly string[];
      readonly contextOwnerIds: readonly string[]; readonly reviewPlanKey: string;
      readonly extractionResponse: ProposalAreaBlockResponse; readonly modelReview: ProposalAreaReviewResponse;
      readonly areas: Readonly<Record<ProposalArea, ProposalWholeDraftAreaState>>;
    }[];
    readonly combinedRawBytes: number; readonly provenance: 'original-issued-seven-area-run-and-reviews';
    readonly publicTextSource: 'supported-answered-whole-model-bundles-only';
  };
  readonly runCoverage: { readonly state: 'ALL_PLANNED_FRAMES_REVIEWED'; readonly frames: number; readonly sourceOwners: number; readonly areas: 7; readonly structuralOwnerMapping: 'complete-not-semantic-completeness' };
  readonly approvedContent: readonly never[]; readonly readyForClient: false; readonly humanApproval: false;
  readonly semanticTruth: 'not-proven'; readonly completeness: 'not-assessed'; readonly providerAuthenticity: 'not-attested';
}

type CapturedRecord = { readonly wrapper: ProposalWholeDraftRecord; readonly response: ProposalAreaBlockResponse; readonly reviewPlan: ProposalAreaReviewPlan; readonly reviewResponse: ProposalAreaReviewResponse };
const issuedDrafts = new WeakMap<ProposalWholeDraft, { readonly plan: ProposalAreaPlan; readonly records: readonly CapturedRecord[]; readonly serialized: string }>();
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
const plain = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
function captureSources(sources: readonly IntelligenceSource[]) {
  assertResponsePreparationSources(sources); const snapshot = structuredClone(sources); assertResponsePreparationSources(snapshot);
  const serialized = JSON.stringify(snapshot);
  if (JSON.stringify(sources) !== serialized) throw new Error('Источник изменился во время фиксации. Черновик не создан.');
  return { snapshot, serialized };
}
function rawCharge(value: unknown): number {
  if (!plain(value) || typeof value.rawBytes !== 'number' || !Number.isSafeInteger(value.rawBytes) || value.rawBytes <= 0 || value.rawBytes > PROPOSAL_WHOLE_DRAFT_LIMITS.combinedRawBytes
    || typeof value.rawSHA256 !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value.rawSHA256)) throw new Error('Нужны исходные ответы с точным rawBytes и SHA. Частичный черновик не создан.');
  return value.rawBytes;
}
/** Bound copied primitives before any opaque resolver or untrusted plan
 * serialization. Only the original issued objects can pass later admission. */
function captureRecords(records: readonly ProposalWholeDraftRecord[]) {
  if (!Array.isArray(records) || records.length > PROPOSAL_WHOLE_DRAFT_LIMITS.records) throw new Error('Полный запуск допускает не более64 кадров. Частичный черновик не создан.');
  let combinedRawBytes = 0;
  const captured = Array.from(records, wrapper => {
    if (!plain(wrapper) || !exactKeys(wrapper, ['response', 'reviewPlan', 'reviewResponse']) || !plain(wrapper.reviewPlan)) throw new Error('Нужны точные исходные response/reviewPlan/reviewResponse.');
    combinedRawBytes += rawCharge(wrapper.response) + rawCharge(wrapper.reviewResponse);
    if (combinedRawBytes > PROPOSAL_WHOLE_DRAFT_LIMITS.combinedRawBytes) throw new Error('Суммарные raw извлечения и проверок превышают2МиБ. Частичный черновик не создан.');
    return { wrapper, response: wrapper.response, reviewPlan: wrapper.reviewPlan, reviewResponse: wrapper.reviewResponse } as unknown as CapturedRecord;
  });
  return { captured, combinedRawBytes };
}
function assertRecordsUnchanged(records: readonly ProposalWholeDraftRecord[], captured: readonly CapturedRecord[]) {
  if (!Array.isArray(records) || records.length !== captured.length || captured.some((entry, index) => records[index] !== entry.wrapper || !plain(entry.wrapper)
    || !exactKeys(entry.wrapper, ['response', 'reviewPlan', 'reviewResponse']) || entry.wrapper.response !== entry.response || entry.wrapper.reviewPlan !== entry.reviewPlan || entry.wrapper.reviewResponse !== entry.reviewResponse)) throw new Error('Записи запуска изменились. Черновик не выдан.');
}
function budget(draft: ProposalWholeDraft) {
  const serialized = JSON.stringify(draft);
  if (bytes(serialized) > PROPOSAL_WHOLE_DRAFT_LIMITS.draftBytes) throw new Error('Полный черновик превышает16МиБ. Источник и ответы не усечены, частичный результат не выдан.');
  return serialized;
}

const AREA_DETAILS: Readonly<Record<ProposalArea, { readonly title: string; readonly fields: readonly { readonly topic: string; readonly question: string }[] }>> = {
  'work-scope': { title: 'Состав работ', fields: [{ topic: 'scope-and-boundaries', question: 'Какие работы входят в предложение и каковы их границы?' }, { topic: 'responsibilities-and-exclusions', question: 'Как разделены обязанности и какие работы исключены?' }] },
  deliverables: { title: 'Результаты и приёмка', fields: [{ topic: 'deliverables-and-formats', question: 'Какие результаты и форматы нужно передать?' }, { topic: 'acceptance-conditions', question: 'Каковы условия и события приёмки результатов?' }] },
  'checked-facets': { title: 'Области и способы проверки', fields: [{ topic: 'checks-and-coverage', question: 'Какие объекты и аспекты охватывает проверка?' }, { topic: 'methods-and-limitations', question: 'Какие методы и ограничения проверки установлены?' }] },
  'price-vat': { title: 'Цена и НДС', fields: [{ topic: 'price', question: 'Какова цена или порядок её определения?' }, { topic: 'currency', question: 'В какой валюте указана цена?' }, { topic: 'vat', question: 'Каков режим НДС и включён ли он в цену?' }, { topic: 'price-basis', question: 'К какому объёму и составу работ относится цена?' }] },
  payment: { title: 'Порядок оплаты', fields: [{ topic: 'payment-events', question: 'Какие события запускают каждый платёж?' }, { topic: 'payment-base', question: 'От какой базы рассчитывается каждый платёж?' }, { topic: 'payment-amounts', question: 'Каковы суммы или доли аванса и последующих платежей?' }, { topic: 'payment-day-kind', question: 'Каковы сроки оплаты и какие дни используются: рабочие или календарные?' }] },
  'parties-roles': { title: 'Стороны и роли', fields: [{ topic: 'actual-parties', question: 'Какие фактические стороны участвуют в предложении?' }, { topic: 'party-roles-and-authority', question: 'Каковы роли сторон и полномочия их представителей?' }] },
  schedule: { title: 'Сроки и зависимости', fields: [{ topic: 'duration', question: 'Какова длительность и сроки этапов?' }, { topic: 'day-kind', question: 'В каких днях исчисляются сроки: рабочих или календарных?' }, { topic: 'start-event', question: 'Какое событие запускает срок?' }, { topic: 'dependencies', question: 'От каких материалов, согласований и других событий зависят сроки?' }] },
};

function areaState(answer: ProposalAreaBlockResponse['areas'][ProposalArea], review: ProposalAreaReviewResponse['areas'][ProposalArea]): ProposalWholeDraftAreaState {
  if (review.verdict === 'unsupported') return 'MODEL_REVIEW_UNSUPPORTED_BLOCKED';
  if (review.verdict === 'unclear') return 'MODEL_REVIEW_UNCLEAR_BLOCKED';
  if (answer.status === 'unclear') return 'MODEL_EXTRACTION_UNCLEAR_BLOCKED';
  return answer.status === 'answered' ? 'MODEL_ANSWER_SUPPORTED_UNAPPROVED' : 'MODEL_NOT_STATED_SUPPORTED_LOCAL_ONLY';
}

/** Atomic offline assembler for an actually returned complete seven-area run.
 * Supported reviews are fallible unapproved text only, not semantic proof,
 * human approval or permission to issue a client-ready commercial offer. */
export async function buildProposalWholeDraft(plan: ProposalAreaPlan, records: readonly ProposalWholeDraftRecord[], currentSources: readonly IntelligenceSource[]): Promise<ProposalWholeDraft> {
  const source = captureSources(currentSources), { captured, combinedRawBytes } = captureRecords(records);
  const unchanged = () => { if (captureSources(currentSources).serialized !== source.serialized) throw new Error('Источник изменился. Черновик не выдан.'); assertRecordsUnchanged(records, captured); };
  unchanged(); const resolvedPlan = await resolveProposalAreaPlan(plan, currentSources); unchanged();
  if (resolvedPlan !== plan || plan.blocks.length !== captured.length || !captured.length) throw new Error('Нужны все кадры полного плана ровно один раз и в исходном порядке. Частичный черновик не создан.');
  const auditFrames: ProposalWholeDraft['audit']['frames'][number][] = [];
  for (let index = 0; index < captured.length; index++) {
    const entry = captured[index], block = plan.blocks[index];
    if (entry.response.blockId !== block.id || entry.reviewResponse.blockId !== block.id) throw new Error('Дублированный, чужой или переставленный кадр. Полный черновик не создан.');
    unchanged(); const extraction = await resolveProposalAreaBlockResponse(entry.response, plan, currentSources); unchanged();
    if (extraction.response !== entry.response || extraction.plan !== plan || extraction.block !== block) throw new Error('Нужен исходный ответ того же кадра и плана.');
    unchanged(); const reviewPlan = await resolveProposalAreaReviewPlan(entry.reviewPlan, plan, currentSources); unchanged();
    if (reviewPlan !== entry.reviewPlan || reviewPlan.extractionResponse !== entry.response) throw new Error('План проверки относится к другому извлечённому ответу.');
    unchanged(); const review = await resolveProposalAreaReviewResponse(entry.reviewResponse, entry.reviewPlan, plan, currentSources); unchanged();
    if (review.response !== entry.reviewResponse || review.reviewPlan !== entry.reviewPlan || review.plan !== plan || review.extractionResponse !== entry.response) throw new Error('Нужна исходная проверка того же whole-frame ответа.');
    const areas = Object.fromEntries(PROPOSAL_AREAS.map(area => [area, areaState(entry.response.areas[area], entry.reviewResponse.areas[area])])) as Record<ProposalArea, ProposalWholeDraftAreaState>;
    auditFrames.push({ frameId: block.id, frameIndex: block.index, primaryOwnerIds: block.primary.map(owner => owner.ownerId), contextOwnerIds: block.context.map(context => context.owner.ownerId),
      reviewPlanKey: entry.reviewPlan.reviewPlanKey, extractionResponse: entry.response, modelReview: entry.reviewResponse, areas });
  }
  const sections: ProposalWholeDraftSection[] = PROPOSAL_AREAS.map(area => {
    const blocked = auditFrames.some(frame => !['MODEL_ANSWER_SUPPORTED_UNAPPROVED', 'MODEL_NOT_STATED_SUPPORTED_LOCAL_ONLY'].includes(frame.areas[area]));
    const allNotFound = auditFrames.every(frame => frame.areas[area] === 'MODEL_NOT_STATED_SUPPORTED_LOCAL_ONLY');
    const bundles = auditFrames.filter(frame => frame.areas[area] === 'MODEL_ANSWER_SUPPORTED_UNAPPROVED').map(frame => {
      const answer = frame.extractionResponse.areas[area];
      return { frameId: frame.frameId, frameIndex: frame.frameIndex, text: answer.answer!, evidenceRefs: answer.evidenceRefs, origin: 'model-answer-whole-bundle' as const, modelAnswerModified: false as const, perClaimRefAttribution: 'not-provided' as const, publicCPAllowed: false as const };
    });
    return { area, title: AREA_DETAILS[area].title, state: blocked ? 'BLOCKED_REVIEW' : allNotFound ? 'MODEL_NOT_FOUND_NEEDS_CLARIFICATION' : 'MODEL_DRAFT_UNAPPROVED', bundles,
      modelAbsence: allNotFound ? 'model-not-found-in-supplied-source-not-proof' : 'not-claimed' };
  });
  const clarificationQuestions: ProposalWholeDraftQuestion[] = sections.filter(section => section.state !== 'MODEL_DRAFT_UNAPPROVED').flatMap(section => {
    const reason = section.state === 'BLOCKED_REVIEW' ? 'BLOCKED_REVIEW' : 'MODEL_NOT_FOUND';
    const relevant = section.state === 'BLOCKED_REVIEW' ? auditFrames.filter(frame => !['MODEL_ANSWER_SUPPORTED_UNAPPROVED', 'MODEL_NOT_STATED_SUPPORTED_LOCAL_ONLY'].includes(frame.areas[section.area])) : auditFrames;
    const frameIds = relevant.map(frame => frame.frameId), ownerIds = [...new Set(relevant.flatMap(frame => [...frame.primaryOwnerIds, ...frame.contextOwnerIds]))];
    return AREA_DETAILS[section.area].fields.map(field => ({ id: `${section.area}:${field.topic}`, area: section.area, topic: field.topic, reason,
      question: `${reason === 'MODEL_NOT_FOUND' ? 'Модель не обнаружила данные во всём переданном источнике; это не доказательство их отсутствия. ' : 'Есть неясные или неподтверждённые модельные части; уточните по указанному контексту. '}${field.question}`,
      frameIds, ownerIds }));
  });
  const unvalidatedDetails = sections.filter(section => section.bundles.length > 0).map(section => ({ area: section.area, topics: AREA_DETAILS[section.area].fields.map(field => field.topic),
    state: 'SUBFIELD_COMPLETENESS_NOT_ASSESSED' as const, notEvidenceOfMissingValues: true as const }));
  const draft: ProposalWholeDraft = { version: 1, purpose: 'unapproved-model-whole-proposal-draft', planKey: plan.planKey, sourceSnapshotKey: plan.sourceSnapshotKey, structureSnapshotKey: plan.structureSnapshotKey,
    sourceSnapshot: source.snapshot, owners: source.snapshot[0].fragments!.map((fragment, fragmentIndex) => ({ ownerId: fragment.id!, fragmentIndex, locator: fragment.locator })), sections, clarificationQuestions, unvalidatedDetails,
    audit: { frames: auditFrames, combinedRawBytes, provenance: 'original-issued-seven-area-run-and-reviews', publicTextSource: 'supported-answered-whole-model-bundles-only' },
    runCoverage: { state: 'ALL_PLANNED_FRAMES_REVIEWED', frames: plan.blocks.length, sourceOwners: plan.coverage.originalOwners, areas: 7, structuralOwnerMapping: 'complete-not-semantic-completeness' },
    approvedContent: [], readyForClient: false, humanApproval: false, semanticTruth: 'not-proven', completeness: 'not-assessed', providerAuthenticity: 'not-attested' };
  const serialized = budget(draft); unchanged(); freeze(draft); issuedDrafts.set(draft, { plan, records: captured, serialized }); return draft;
}

/** The same issued draft, plan and record wrappers only. Revalidation cannot
 * turn a model-supported unapproved draft into truth or client-ready content. */
export async function revalidateProposalWholeDraft(draft: ProposalWholeDraft, plan: ProposalAreaPlan, sameRecords: readonly ProposalWholeDraftRecord[], currentSources: readonly IntelligenceSource[]): Promise<ProposalWholeDraft> {
  const issued = draft && typeof draft === 'object' ? issuedDrafts.get(draft) : undefined;
  if (!issued || issued.plan !== plan || budget(draft) !== issued.serialized) throw new Error('Нужны исходные выданные черновик и план. JSON-копия не является capability.');
  assertRecordsUnchanged(sameRecords, issued.records); const before = captureSources(currentSources).serialized;
  const fresh = await buildProposalWholeDraft(plan, sameRecords, currentSources);
  assertRecordsUnchanged(sameRecords, issued.records);
  if (captureSources(currentSources).serialized !== before || budget(fresh) !== issued.serialized) throw new Error('Источник или записи изменились перед возвратом прежнего черновика.');
  return draft;
}
