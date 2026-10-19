import { buildProposalQuotePlan, parseProposalQuoteResponse, PROPOSAL_QUOTE_ROLES, PROPOSAL_QUOTE_LIMITS, type ProposalQuotePlan, type ProposalQuotePlanOptions, type ProposalQuoteRole } from './proposalQuotePlan';
import { assertResponsePreparationRaw, assertResponsePreparationSources, RESPONSE_PREPARATION_LIMITS } from './responsePreparationBounds';
import type { IntelligenceEvidence, IntelligenceItem, IntelligenceSource } from './workbenchTypes';

export interface ProposalQuoteResponsePart { batchId: string; model: string; raw: string }
export interface ProposalQuotePreparationRequest {
  revision: number; sources: IntelligenceSource[]; options?: ProposalQuotePlanOptions; parts: ProposalQuoteResponsePart[];
}
export interface ProposalQuotePreparationWireRequest extends ProposalQuotePreparationRequest { origin: 'model-selected-quotes' }
/** Private receipt of the actual selection, captured BEFORE local completion.
 * Role membership, exact quotations and counts are not semantic approval. */
export interface ProposalQuoteProvenance {
  version: 1; origin: 'model-selected-quotes'; sourceSnapshotKey: `sha256:${string}`;
  parts: ProposalQuoteResponsePart[];
  selections: Array<{ unitId: string; sourceId: string; fragmentId: string; locator: string; quote: string; roles: ProposalQuoteRole[] }>;
  counts: { units: number; commercial: number; context: number; unclear: number; batches: number };
  projectedItemId?: string;
}
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
const keys = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) => required.every(key => Object.prototype.hasOwnProperty.call(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const wellFormed = (value: string) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
const text = (value: unknown, maximum: number, nonempty = false): value is string => typeof value === 'string' && value.length <= maximum && (!nonempty || Boolean(value.trim())) && wellFormed(value) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value);
const id = (value: unknown): value is string => text(value, 256, true) && Array.from(value).length <= 128 && !/[\u0000-\u001f]/u.test(value);
const count = (value: unknown, maximum: number): value is number => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum;
const maximumUnits = PROPOSAL_QUOTE_LIMITS.batches * PROPOSAL_QUOTE_LIMITS.unitsPerBatch;

function assertParts(value: unknown): asserts value is ProposalQuoteResponsePart[] {
  if (!Array.isArray(value) || !value.length || value.length > PROPOSAL_QUOTE_LIMITS.batches) throw new Error('Нужны исходные ответы всех пакетов выбора цитат, не более 64.');
  let size = 0; const seen = new Set<string>();
  for (const part of value) {
    if (!object(part) || !keys(part, ['batchId', 'model', 'raw']) || !id(part.batchId) || seen.has(part.batchId)
      || !text(part.model, 200, true) || /[\u0000-\u001f]/u.test(part.model)) throw new Error('Некорректный или повторный пакет выбора цитат.');
    assertResponsePreparationRaw(part.raw);
    size += bytes(part.raw);
    if (size > RESPONSE_PREPARATION_LIMITS.rawBytes) throw new Error('Общий объём исходных ответов превышает 2 МБ. Ничего не усечено.');
    seen.add(part.batchId);
  }
}

/** Synchronous admission before cloning, a worker allocation or digest await. */
export function assertProposalQuotePreparationRequest(value: unknown, wire = false): asserts value is ProposalQuotePreparationRequest {
  if (!object(value) || !keys(value, ['revision', 'sources', 'parts', ...(wire ? ['origin'] : [])], ['options'])
    || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0 || wire && value.origin !== 'model-selected-quotes') throw new Error('Некорректный запрос подготовки выбранных моделью цитат.');
  assertResponsePreparationSources(value.sources); assertParts(value.parts);
  if (Object.prototype.hasOwnProperty.call(value, 'options') && (!object(value.options)
    || !keys(value.options, [], ['maxSourcePayloadBytes', 'maxUnitsPerBatch', 'instruction']))) throw new Error('Неизвестные параметры выбора цитат.');
  if (object(value.options)) {
    const { maxSourcePayloadBytes, maxUnitsPerBatch, instruction } = value.options;
    if (maxSourcePayloadBytes !== undefined && (!Number.isSafeInteger(maxSourcePayloadBytes) || Number(maxSourcePayloadBytes) < 512 || Number(maxSourcePayloadBytes) > PROPOSAL_QUOTE_LIMITS.payloadBytes)
      || maxUnitsPerBatch !== undefined && (!Number.isSafeInteger(maxUnitsPerBatch) || Number(maxUnitsPerBatch) < 1 || Number(maxUnitsPerBatch) > PROPOSAL_QUOTE_LIMITS.unitsPerBatch)
      || instruction !== undefined && !text(instruction, 20_000)) throw new Error('Некорректные пределы пакетов или инструкция выбора цитат.');
  }
}

/** Admission for the production quote-to-proposal route only. The standalone
 * selector may inspect a partial plan, but the legacy source-completion tail
 * has a different selection contract. Never repair/filter the original source
 * snapshot to make those contracts appear equivalent. */
export function assertFullProposalQuotePlan(plan: ProposalQuotePlan): void {
  if (plan.excludedUnselectedFragments.length || plan.excludedHiddenFragments.length) throw new Error('Источник содержит скрытые или отдельно помеченные фрагменты. Автоматическая подготовка КП по такому снимку недоступна; исходные материалы и прежние результаты не изменены.');
}

/** Closed structural storage/worker guard only. Fresh source/raw ownership is
 * checked by the asynchronous plan parser before constructing this receipt. */
export function validProposalQuoteProvenance(value: unknown): value is ProposalQuoteProvenance {
  try {
    if (!object(value) || !keys(value, ['version', 'origin', 'sourceSnapshotKey', 'parts', 'selections', 'counts'], ['projectedItemId'])
      || value.version !== 1 || value.origin !== 'model-selected-quotes' || typeof value.sourceSnapshotKey !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value.sourceSnapshotKey)
      || Object.prototype.hasOwnProperty.call(value, 'projectedItemId') && !id(value.projectedItemId)) return false;
    assertParts(value.parts);
    if (!Array.isArray(value.selections) || value.selections.length > maximumUnits || !object(value.counts)) return false;
    const counts = value.counts;
    if (!keys(counts, ['units', 'commercial', 'context', 'unclear', 'batches'])
      || !['units', 'commercial', 'context', 'unclear'].every(key => count(counts[key], maximumUnits)) || counts.units !== Number(counts.commercial) + Number(counts.context) + Number(counts.unclear)
      || counts.batches !== value.parts.length || counts.commercial !== value.selections.length || !counts.units) return false;
    const seen = new Set<string>();
    for (const selection of value.selections) {
      if (!object(selection) || !keys(selection, ['unitId', 'sourceId', 'fragmentId', 'locator', 'quote', 'roles']) || !id(selection.unitId) || seen.has(selection.unitId)
        || !id(selection.sourceId) || !id(selection.fragmentId) || selection.unitId !== selection.fragmentId || !text(selection.locator, 20_000) || !text(selection.quote, 20_000, true)
        || !Array.isArray(selection.roles) || !selection.roles.length || selection.roles.length > PROPOSAL_QUOTE_ROLES.length
        || selection.roles.some(role => typeof role !== 'string' || !(PROPOSAL_QUOTE_ROLES as readonly string[]).includes(role)) || new Set(selection.roles).size !== selection.roles.length || !selection.roles.some(role => role !== 'context')) return false;
      seen.add(selection.unitId);
    }
    return bytes(JSON.stringify(value)) <= RESPONSE_PREPARATION_LIMITS.rawBytes;
  } catch { return false; }
}

/** Parse every captured batch once, atomically. Projection uses only exact
 * model-selected whole fragments; prices/parties/scope names are not inferred.
 * The caller may subsequently add source-derived content with its own receipt. */
export async function prepareProposalQuoteSelection(request: ProposalQuotePreparationRequest): Promise<{ item?: IntelligenceItem; provenance: ProposalQuoteProvenance }> {
  assertProposalQuotePreparationRequest(request);
  const captured = structuredClone(request), plan = await buildProposalQuotePlan(captured.sources, captured.options);
  assertFullProposalQuotePlan(plan);
  if (captured.parts.length !== plan.batches.length || captured.parts.some((part, index) => part.batchId !== plan.batches[index].id)) throw new Error('Нужны все пакеты текущего плана ровно один раз и в исходном порядке. Частичный проект не создан.');
  const provenance: ProposalQuoteProvenance = { version: 1, origin: 'model-selected-quotes', sourceSnapshotKey: plan.sourceSnapshotKey,
    parts: captured.parts, selections: [], counts: { units: 0, commercial: 0, context: 0, unclear: 0, batches: plan.batches.length } };
  for (const part of captured.parts) {
    const response = await parseProposalQuoteResponse(part.raw, plan, part.batchId, captured.sources);
    provenance.counts.units += response.units.length;
    for (const key of ['commercial', 'context', 'unclear'] as const) provenance.counts[key] += response.counts[key];
    provenance.selections.push(...response.selections.map(selection => ({ unitId: selection.unitId, sourceId: selection.sourceId, fragmentId: selection.fragmentId, locator: selection.locator, quote: selection.quote, roles: [...selection.roles] })));
  }
  if (!validProposalQuoteProvenance(provenance)) throw new Error('Полный журнал выбранных цитат некорректен или превышает 2 МБ. Частичный журнал не сохранён.');
  if (!provenance.selections.some(selection => selection.roles.some(role => ['subject', 'scope', 'deliverable'].includes(role)))) return { provenance };
  const fields: Record<string, string> = {}, evidence: IntelligenceEvidence[] = [];
  const projections = { introduction: ['subject'], paymentTerms: ['payment'], deliveryTerms: ['schedule', 'dependency', 'exclusion', 'perimeter', 'customer-input'] };
  for (const [field, roles] of Object.entries(projections)) {
    const selections = provenance.selections.filter(selection => selection.roles.some(role => roles.includes(role)));
    if (!selections.length) continue;
    const value = selections.map(selection => selection.quote).join('\n\n');
    if (value.length > 20_000) throw new Error('Выбранные целые цитаты превышают 20 000 символов на поле. Текст не усечён, прежний результат сохранён.');
    fields[field] = value;
    for (const selection of selections) for (let start = 0; start < selection.quote.length;) {
      let end = Math.min(start + 2000, selection.quote.length);
      if (end < selection.quote.length && /[\uD800-\uDBFF]/u.test(selection.quote[end - 1]) && /[\uDC00-\uDFFF]/u.test(selection.quote[end])) end--;
      evidence.push({ field, sourceId: selection.sourceId, fragmentId: selection.fragmentId, quote: selection.quote.slice(start, end) }); start = end;
      if (evidence.length > 500) throw new Error('Подтверждения выбранных цитат превышают предел. Частичный проект не создан.');
    }
  }
  const item: IntelligenceItem = { id: crypto.randomUUID(), destination: 'proposals', title: 'Коммерческое предложение', sourceIds: [plan.sourceId], fields, selectedFields: Object.keys(fields), evidence };
  provenance.projectedItemId = item.id;
  if (!validProposalQuoteProvenance(provenance)) throw new Error('Журнал выбранных цитат превышает допустимый объём. Частичный проект не создан.');
  return { item, provenance };
}
