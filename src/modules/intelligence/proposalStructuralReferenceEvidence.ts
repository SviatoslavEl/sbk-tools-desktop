import { resolveProposalStructuralReferenceResponse, type ProposalStructuralReferencePlan, type ProposalStructuralReferenceResponse } from './proposalStructuralReferencePlan';
import { assertResponsePreparationSources } from './responsePreparationBounds';
import type { IntelligenceSource } from './workbenchTypes';

export const PROPOSAL_STRUCTURAL_REFERENCE_EVIDENCE_LIMITS = Object.freeze({ receiptBytes: 64 * 1024, references: 20 });
export interface ProposalStructuralMaterializedReference {
  readonly origin: 'source-materialized-whole-native-cell' | 'source-materialized-whole-owner';
  readonly sourceId: string; readonly ownerId: string; readonly fragmentId: string; readonly fragmentIndex: number;
  readonly locator: string; readonly cellIndex: number | null; readonly text: string;
  readonly modelProvidedText: false;
}
/** A separately labelled source receipt, NEVER a replacement model answer or
 * model-extracted quote. Addresses/ownership do not prove semantic support. */
export interface ProposalStructuralMaterializedEvidence {
  readonly version: 1; readonly purpose: 'source-materialized-reference-evidence-only';
  readonly origin: 'model-returned-refs/source-materialized-evidence';
  readonly referencePlanKey: `sha256:${string}`; readonly sourceSnapshotKey: `sha256:${string}`; readonly structureSnapshotKey: `sha256:${string}`;
  readonly focus: ProposalStructuralReferenceResponse['focus']; readonly blockId: string;
  readonly modelRawSHA256: ProposalStructuralReferenceResponse['rawSHA256'];
  readonly modelStatus: ProposalStructuralReferenceResponse['status'];
  readonly entries: readonly ProposalStructuralMaterializedReference[];
  readonly modelAnswerModified: false; readonly semanticReviewRequired: true;
  readonly providerAuthenticity: 'not-attested'; readonly readiness: 'not-assessed';
}
const proofs = new WeakMap<ProposalStructuralMaterializedEvidence, { response: ProposalStructuralReferenceResponse; plan: ProposalStructuralReferencePlan; canonical: string }>();
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
function capture(sources: readonly IntelligenceSource[]): string {
  assertResponsePreparationSources(sources);
  const captured = structuredClone(sources); assertResponsePreparationSources(captured);
  const canonical = JSON.stringify(captured);
  if (JSON.stringify(sources) !== canonical) throw new Error('Источник изменился во время фиксации. Подтверждения не материализованы.');
  return canonical;
}
function budget(receipt: ProposalStructuralMaterializedEvidence): string {
  if (receipt.entries.length > PROPOSAL_STRUCTURAL_REFERENCE_EVIDENCE_LIMITS.references) throw new Error('Подтверждения превышают 20 явных ссылок. Частичный результат не выдан.');
  const serialized = JSON.stringify(receipt);
  if (bytes(serialized) > PROPOSAL_STRUCTURAL_REFERENCE_EVIDENCE_LIMITS.receiptBytes) throw new Error('Материализованные подтверждения превышают 64 КиБ. Источник и ссылки не усечены.');
  return serialized;
}

/** Resolve ONLY explicitly returned, parser-issued PRIMARY addresses. Never
 * look up text by answer wording, infer refs from yes/status, fill merged cells,
 * append source tails, normalize line endings or promote any CP readiness. */
export async function materializeProposalStructuralReferenceEvidence(
  response: ProposalStructuralReferenceResponse, plan: ProposalStructuralReferencePlan, currentSources: readonly IntelligenceSource[],
): Promise<ProposalStructuralMaterializedEvidence> {
  const before = capture(currentSources);
  const resolved = await resolveProposalStructuralReferenceResponse(response, plan, currentSources);
  if (capture(currentSources) !== before || resolved.response !== response
    || resolved.referencePlanKey !== response.referencePlanKey || resolved.sourceSnapshotKey !== response.sourceSnapshotKey
    || resolved.structureSnapshotKey !== response.structureSnapshotKey || resolved.block.id !== response.blockId) throw new Error('Снимок или исходный ответ изменился. Подтверждения не материализованы.');
  if (response.evidenceRefs.length > PROPOSAL_STRUCTURAL_REFERENCE_EVIDENCE_LIMITS.references) throw new Error('Слишком много явных ссылок; результат не усечён.');
  const seen = new Set<string>();
  const entries = response.evidenceRefs.map(reference => {
    const owner = resolved.block.primary.find(owner => owner.ownerId === reference.ownerId);
    if (!owner) throw new Error('Ссылка не принадлежит PRIMARY. Контекст и другие владельцы не подставлены.');
    const address = JSON.stringify([reference.ownerId, reference.cellIndex]);
    if (seen.has(address)) throw new Error('Повторная ссылка не материализована.'); seen.add(address);
    let text: string, origin: ProposalStructuralMaterializedReference['origin'];
    if (owner.structure.kind === 'table-row') {
      const index = reference.cellIndex;
      if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 || !owner.structure.cells
        || index >= owner.structure.cells.length || owner.structure.cells[index].index !== index) throw new Error('Нужен точный нативный индекс ячейки, не визуальная колонка или gridSpan.');
      text = owner.structure.cells[index].text; origin = 'source-materialized-whole-native-cell';
    } else {
      if (reference.cellIndex !== null) throw new Error('Для целого нетабличного владельца нужен cellIndex:null.');
      text = owner.text; origin = 'source-materialized-whole-owner';
    }
    if (!text.trim()) throw new Error('Выбранный источник пуст. Другой текст или значение объединённой ячейки не подставлены.');
    return { origin, sourceId: owner.sourceId, ownerId: owner.ownerId, fragmentId: owner.fragmentId,
      fragmentIndex: owner.fragmentIndex, locator: owner.locator, cellIndex: reference.cellIndex, text, modelProvidedText: false as const };
  });
  const receipt: ProposalStructuralMaterializedEvidence = {
    version: 1, purpose: 'source-materialized-reference-evidence-only', origin: 'model-returned-refs/source-materialized-evidence',
    referencePlanKey: response.referencePlanKey, sourceSnapshotKey: response.sourceSnapshotKey, structureSnapshotKey: response.structureSnapshotKey,
    focus: response.focus, blockId: response.blockId, modelRawSHA256: response.rawSHA256, modelStatus: response.status,
    entries, modelAnswerModified: false, semanticReviewRequired: true, providerAuthenticity: 'not-attested', readiness: 'not-assessed',
  };
  const canonical = budget(receipt);
  if (capture(currentSources) !== before) throw new Error('Источник изменился до выдачи подтверждений. Результат не выдан.');
  freeze(receipt); proofs.set(receipt, { response, plan, canonical }); return receipt;
}

/** In-memory provenance only, not provider authentication or semantic proof.
 * Future consumers must revalidate against the SAME issued response/plan and
 * fresh source; a persisted JSON receipt is not a transferable capability. */
export async function revalidateProposalStructuralMaterializedEvidence(
  evidence: ProposalStructuralMaterializedEvidence, response: ProposalStructuralReferenceResponse,
  plan: ProposalStructuralReferencePlan, currentSources: readonly IntelligenceSource[],
): Promise<ProposalStructuralMaterializedEvidence> {
  const issued = evidence && typeof evidence === 'object' ? proofs.get(evidence) : undefined;
  if (!issued || issued.response !== response || issued.plan !== plan || budget(evidence) !== issued.canonical) throw new Error('Нужны исходные выданные подтверждения, ответ и план. JSON-копия не является доказательством происхождения.');
  const before = capture(currentSources);
  const fresh = await materializeProposalStructuralReferenceEvidence(response, plan, currentSources);
  if (capture(currentSources) !== before || budget(fresh) !== issued.canonical) throw new Error('Источник или подтверждения изменились. Прежний результат не принят.');
  return evidence;
}
