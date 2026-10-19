import { buildProposalStructuralBlockPlan, type ProposalStructuralBlock, type ProposalStructuralBlockPlan, type ProposalStructuralContextBasis, type ProposalStructuralFocus } from './proposalStructuralBlockPlan';
import { resolveProposalSemanticReviewPlan, resolveProposalSemanticReviewResponse, type ProposalSemanticReviewCandidate, type ProposalSemanticReviewPlan, type ProposalSemanticReviewResponse } from './proposalSemanticReview';
import { assertResponsePreparationSources } from './responsePreparationBounds';
import type { IntelligenceSource } from './workbenchTypes';

export const PROPOSAL_REVIEW_LEDGER_LIMITS = Object.freeze({ records: 128, reviewDataBytes: 2 * 1024 * 1024, ledgerBytes: 16 * 1024 * 1024 });
/** null is an unprocessed review job, never a fabricated reviewer response. */
export interface ProposalReviewRecord { readonly plan: ProposalSemanticReviewPlan; readonly response: ProposalSemanticReviewResponse | null }
export type ProposalReviewState = 'NOT_PROCESSED' | 'PENDING_SEMANTIC_REVIEW' | 'MODEL_SUPPORTED_UNAPPROVED' | 'MODEL_UNSUPPORTED_BLOCKED' | 'MODEL_UNCLEAR_BLOCKED';
export interface ProposalReviewLedgerBlock {
  readonly id: string; readonly index: number; readonly kind: ProposalStructuralBlock['kind'];
  readonly primaryOwnerIds: readonly string[];
  readonly context: readonly { readonly ownerId: string; readonly basis: ProposalStructuralContextBasis }[];
  readonly continuation: ProposalStructuralBlock['continuation']; readonly table: ProposalStructuralBlock['table'];
  readonly semanticSectionClaim: false; readonly state: ProposalReviewState;
  readonly bundle: null | {
    readonly reviewUnit: 'unchanged-whole-answer-bundle'; readonly reviewPlanKey: string; readonly candidateKey: string;
    readonly candidate: ProposalSemanticReviewCandidate; readonly modelReview: ProposalSemanticReviewResponse | null;
    readonly modelAnswerModified: false; readonly perClaimRefAttribution: 'not-provided';
    readonly admission: 'unapproved-review-draft-only' | 'blocked-pending-review' | 'blocked-model-unsupported' | 'blocked-model-unclear';
    readonly publicCPAllowed: false; readonly semanticTruth: 'not-proven'; readonly humanApproval: false;
  };
}
export interface ProposalReviewLedgerFocus {
  readonly focus: ProposalStructuralFocus; readonly blocks: readonly ProposalReviewLedgerBlock[];
  readonly ownerCoverage: ProposalStructuralBlockPlan['coverage'];
}
/** A complete source inventory and provisional review ledger, NOT an assembled
 * CP, extraction completeness certificate, semantic proof or approval token. */
export interface ProposalReviewLedger {
  readonly version: 1; readonly purpose: 'whole-source-provisional-review-ledger';
  readonly sourceSnapshotKey: string; readonly structureSnapshotKey: string;
  /** The exact supplied source, including aggregate, warnings and every native
   * owner/cell, retained once; indexes below are pointers, not invented facts. */
  readonly sourceSnapshot: readonly IntelligenceSource[];
  readonly owners: readonly {
    readonly ownerId: string; readonly sourceId: string; readonly fragmentId: string; readonly fragmentIndex: number;
    readonly locator: string; readonly nativeKind: string; readonly nativeHeaderMarker: boolean;
  }[];
  readonly focuses: readonly ProposalReviewLedgerFocus[];
  /** Pointers to unchanged whole bundles ONLY. No split claims, inherited refs,
   * reviewer reasons or unselected source-only facts become draft assertions. */
  readonly reviewableDraftBundles: readonly { readonly focus: ProposalStructuralFocus; readonly blockId: string; readonly candidateKey: string }[];
  readonly approvedContent: readonly never[];
  readonly openProposalAreas: readonly { readonly area: string; readonly state: 'OPEN_PENDING_COMPLETE_REVIEW' | 'NOT_IMPLEMENTED_IN_THIS_ROUTE' }[];
  readonly counts: { readonly sourceOwners: number; readonly blocks: number; readonly notProcessed: number; readonly pendingReview: number; readonly modelSupportedUnapproved: number; readonly modelUnsupportedBlocked: number; readonly modelUnclearBlocked: number };
  readonly structuralOwnerMapping: 'complete-for-supplied-source-not-semantic-completeness';
  readonly semanticTruth: 'not-proven'; readonly completeness: 'not-assessed'; readonly humanApproval: false;
  readonly readyForClient: false; readonly providerAuthenticity: 'not-attested';
}
type CapturedRecord = { readonly record: ProposalReviewRecord; readonly plan: ProposalSemanticReviewPlan; readonly response: ProposalSemanticReviewResponse | null };
const issuedLedgers = new WeakMap<ProposalReviewLedger, { records: readonly CapturedRecord[]; serialized: string }>();
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
const plain = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])])) : value;
const equalData = (left: unknown, right: unknown) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
function captureSources(sources: readonly IntelligenceSource[]) {
  assertResponsePreparationSources(sources); const snapshot = structuredClone(sources); assertResponsePreparationSources(snapshot);
  const serialized = JSON.stringify(snapshot);
  if (JSON.stringify(sources) !== serialized) throw new Error('Источник изменился во время фиксации. Реестр не создан.');
  return { snapshot, serialized };
}
const reviewKeys = ['version', 'purpose', 'reviewUnit', 'sourceSnapshotKey', 'structureSnapshotKey', 'reviewPlanKey', 'candidateKey', 'focus', 'blockId', 'verdict', 'reason', 'rawSHA256', 'semanticTruth', 'humanApproval', 'completeness', 'providerAuthenticity'] as const;
/** Charge bounded copied primitives before any async work or serialization of
 * untrusted plans. Opaque resolver validation below is still mandatory. */
function captureRecords(records: readonly ProposalReviewRecord[]): CapturedRecord[] {
  if (!Array.isArray(records) || records.length > PROPOSAL_REVIEW_LEDGER_LIMITS.records) throw new Error('Допускается не более128 целых bundle-проверок. Частичный реестр не создан.');
  let total = 2 + Math.max(0, records.length - 1);
  return Array.from(records, record => {
    if (!plain(record) || !exactKeys(record, ['plan', 'response']) || !plain(record.plan) || record.response !== null && !plain(record.response)) throw new Error('Нужны точные исходные plan/response; null означает ожидающую проверку.');
    const plan = record.plan as unknown as ProposalSemanticReviewPlan, response = record.response as unknown as ProposalSemanticReviewResponse | null;
    const candidate = plan.candidate;
    if (!plain(candidate) || !exactKeys(candidate, ['text', 'evidenceRefs', 'originalRawSHA256', 'origin'])
      || typeof candidate.text !== 'string' || candidate.text.length > 16_000 || Array.from(candidate.text).length > 8_000
      || typeof candidate.originalRawSHA256 !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(candidate.originalRawSHA256) || candidate.origin !== 'untrusted-candidate-data'
      || !Array.isArray(candidate.evidenceRefs) || !candidate.evidenceRefs.length || candidate.evidenceRefs.length > 20) throw new Error('Неверный или слишком большой whole-answer bundle. Ничего не усечено.');
    const refs = Array.from(candidate.evidenceRefs, ref => {
      if (!plain(ref) || !exactKeys(ref, ['ownerId', 'cellIndex']) || typeof ref.ownerId !== 'string' || ref.ownerId.length > 256
        || ref.cellIndex !== null && (typeof ref.cellIndex !== 'number' || !Number.isSafeInteger(ref.cellIndex) || ref.cellIndex < 0)) throw new Error('Неверная явная ссылка whole-answer bundle.');
      return { ownerId: ref.ownerId, cellIndex: ref.cellIndex };
    });
    let modelReview: Record<string, unknown> | null = null;
    if (response !== null) {
      if (!exactKeys(response as unknown as Record<string, unknown>, reviewKeys)) throw new Error('Нужен исходный выданный закрытый ответ проверки.');
      modelReview = Object.fromEntries(reviewKeys.map(key => {
        const value = response[key];
        if (key === 'version' ? value !== 1 : key === 'humanApproval' ? value !== false : typeof value !== 'string' || value.length > (key === 'reason' ? 4_000 : 128)) throw new Error('Неверный или слишком большой ответ проверки.');
        return [key, value];
      }));
    }
    total += bytes(JSON.stringify({ candidate: { text: candidate.text, evidenceRefs: refs, originalRawSHA256: candidate.originalRawSHA256, origin: candidate.origin }, modelReview }));
    if (total > PROPOSAL_REVIEW_LEDGER_LIMITS.reviewDataBytes) throw new Error('Суммарные данные bundle-проверок превышают2МиБ. Частичный реестр не создан.');
    return { record: record as unknown as ProposalReviewRecord, plan, response };
  });
}
function assertRecordsUnchanged(records: readonly ProposalReviewRecord[], captured: readonly CapturedRecord[]) {
  if (!Array.isArray(records) || records.length !== captured.length || captured.some((entry, index) => records[index] !== entry.record || entry.record.plan !== entry.plan || entry.record.response !== entry.response
    || !plain(entry.record) || !exactKeys(entry.record, ['plan', 'response']))) throw new Error('Список проверок изменился во время операции. Реестр не выдан.');
}
function inventory(block: ProposalStructuralBlock) {
  return { id: block.id, index: block.index, kind: block.kind, primary: block.primary, context: block.context, continuation: block.continuation, table: block.table, semanticSectionClaim: false, sourcePayloadBytes: block.sourcePayloadBytes };
}
function ledgerBudget(ledger: ProposalReviewLedger): string {
  const serialized = JSON.stringify(ledger);
  if (bytes(serialized) > PROPOSAL_REVIEW_LEDGER_LIMITS.ledgerBytes) throw new Error('Полный реестр превышает16МиБ. Владельцы и ответы не усечены, частичный реестр не создан.');
  return serialized;
}

/** Offline admission policy, not a model call. Every unprocessed owner remains
 * present. Even a model-supported bundle is only an unapproved review draft;
 * no path here can produce approved/client-ready CP content. */
export async function buildProposalReviewLedger(sources: readonly IntelligenceSource[], records: readonly ProposalReviewRecord[] = []): Promise<ProposalReviewLedger> {
  const capturedSources = captureSources(sources), captured = captureRecords(records);
  const unchanged = () => {
    if (captureSources(sources).serialized !== capturedSources.serialized) throw new Error('Источник изменился. Реестр не выдан.');
    assertRecordsUnchanged(records, captured);
  };
  const bases: ProposalStructuralBlockPlan[] = [];
  for (const focus of ['work-scope', 'deliverables'] as const) {
    unchanged(); const base = await buildProposalStructuralBlockPlan(capturedSources.snapshot, { focus }); unchanged(); bases.push(base);
  }
  const first = bases[0];
  if (bases.some(base => base.sourceSnapshotKey !== first.sourceSnapshotKey || base.structureSnapshotKey !== first.structureSnapshotKey)) throw new Error('Неоднозначный снимок полного источника.');
  const byBlock = new Map<string, CapturedRecord>();
  for (const entry of captured) {
    unchanged();
    const plan = entry.response === null ? await resolveProposalSemanticReviewPlan(entry.plan, sources)
      : (await resolveProposalSemanticReviewResponse(entry.response, entry.plan, sources)).plan;
    unchanged();
    const base = bases.find(base => base.focus === plan.focus), block = base?.blocks.find(block => block.id === plan.blockId);
    if (plan !== entry.plan || !base || !block || plan.sourceSnapshotKey !== base.sourceSnapshotKey || plan.structureSnapshotKey !== base.structureSnapshotKey || plan.sourceId !== base.sourceId
      || !equalData(plan.limits, base.limits) || !equalData(plan.coverage, base.coverage) || !equalData(plan.block, inventory(block))) throw new Error('Проверка не относится к полному исходному плану по умолчанию. Иная группировка не подставлена.');
    if (byBlock.has(plan.blockId)) throw new Error('У блока несколько проверок. Оптимистичный ответ не выбран автоматически; реестр не выдан.');
    byBlock.set(plan.blockId, entry);
  }
  const counts = { sourceOwners: first.coverage.originalOwners, blocks: 0, notProcessed: 0, pendingReview: 0, modelSupportedUnapproved: 0, modelUnsupportedBlocked: 0, modelUnclearBlocked: 0 };
  const reviewableDraftBundles: Array<{ focus: ProposalStructuralFocus; blockId: string; candidateKey: string }> = [];
  const focuses: ProposalReviewLedgerFocus[] = bases.map(base => ({ focus: base.focus, ownerCoverage: base.coverage, blocks: base.blocks.map(block => {
    counts.blocks++;
    const entry = byBlock.get(block.id); let state: ProposalReviewState = 'NOT_PROCESSED'; let bundle: ProposalReviewLedgerBlock['bundle'] = null;
    if (!entry) counts.notProcessed++;
    else {
      const { plan, response } = entry;
      const admission = response === null ? 'blocked-pending-review' : response.verdict === 'supported' ? 'unapproved-review-draft-only' : response.verdict === 'unsupported' ? 'blocked-model-unsupported' : 'blocked-model-unclear';
      if (response === null) { state = 'PENDING_SEMANTIC_REVIEW'; counts.pendingReview++; }
      else if (response.verdict === 'supported') { state = 'MODEL_SUPPORTED_UNAPPROVED'; counts.modelSupportedUnapproved++; reviewableDraftBundles.push({ focus: base.focus, blockId: block.id, candidateKey: plan.candidateKey }); }
      else if (response.verdict === 'unsupported') { state = 'MODEL_UNSUPPORTED_BLOCKED'; counts.modelUnsupportedBlocked++; }
      else { state = 'MODEL_UNCLEAR_BLOCKED'; counts.modelUnclearBlocked++; }
      bundle = { reviewUnit: 'unchanged-whole-answer-bundle', reviewPlanKey: plan.reviewPlanKey, candidateKey: plan.candidateKey, candidate: plan.candidate, modelReview: response,
        modelAnswerModified: false, perClaimRefAttribution: 'not-provided', admission, publicCPAllowed: false, semanticTruth: 'not-proven', humanApproval: false };
    }
    return { id: block.id, index: block.index, kind: block.kind, primaryOwnerIds: block.primary.map(owner => owner.ownerId),
      context: block.context.map(context => ({ ownerId: context.owner.ownerId, basis: context.basis })), continuation: block.continuation, table: block.table, semanticSectionClaim: false, state, bundle };
  }) }));
  const owners = capturedSources.snapshot[0].fragments!.map((fragment, fragmentIndex) => ({ ownerId: fragment.id!, sourceId: first.sourceId, fragmentId: fragment.id!, fragmentIndex,
    locator: fragment.locator, nativeKind: fragment.structure!.kind, nativeHeaderMarker: fragment.structure!.headerMarker === true }));
  const ledger: ProposalReviewLedger = { version: 1, purpose: 'whole-source-provisional-review-ledger', sourceSnapshotKey: first.sourceSnapshotKey, structureSnapshotKey: first.structureSnapshotKey,
    sourceSnapshot: capturedSources.snapshot, owners, focuses, reviewableDraftBundles, approvedContent: [],
    openProposalAreas: [
      { area: 'work-scope', state: 'OPEN_PENDING_COMPLETE_REVIEW' }, { area: 'deliverables', state: 'OPEN_PENDING_COMPLETE_REVIEW' },
      ...['checked-facets', 'price', 'payment', 'parties-and-roles', 'schedule'].map(area => ({ area, state: 'NOT_IMPLEMENTED_IN_THIS_ROUTE' as const })),
    ], counts, structuralOwnerMapping: 'complete-for-supplied-source-not-semantic-completeness', semanticTruth: 'not-proven', completeness: 'not-assessed', humanApproval: false, readyForClient: false, providerAuthenticity: 'not-attested' };
  const serialized = ledgerBudget(ledger); unchanged(); freeze(ledger); issuedLedgers.set(ledger, { records: captured, serialized }); return ledger;
}

/** Same in-memory ledger and record identities plus fresh source, never JSON
 * re-import as a capability. Rechecking cannot promote readiness or truth. */
export async function revalidateProposalReviewLedger(ledger: ProposalReviewLedger, sources: readonly IntelligenceSource[], records: readonly ProposalReviewRecord[] = []): Promise<ProposalReviewLedger> {
  const issued = ledger && typeof ledger === 'object' ? issuedLedgers.get(ledger) : undefined;
  if (!issued || ledgerBudget(ledger) !== issued.serialized) throw new Error('Нужен исходный выданный реестр; JSON-копия не является capability.');
  assertRecordsUnchanged(records, issued.records);
  const before = captureSources(sources).serialized;
  const fresh = await buildProposalReviewLedger(sources, records);
  assertRecordsUnchanged(records, issued.records);
  if (captureSources(sources).serialized !== before || ledgerBudget(fresh) !== issued.serialized) throw new Error('Источник или проверки изменились. Прежний реестр не принят.');
  return ledger;
}
