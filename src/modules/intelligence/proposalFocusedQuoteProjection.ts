import { buildProposalFocusedQuotePlan, parseProposalFocusedQuoteResponse, PROPOSAL_FOCUSED_QUOTE_LIMITS, type ProposalFocusedQuoteFocus, type ProposalFocusedQuotePlanOptions } from './proposalFocusedQuotePlan';
import { deriveContractProposalCaption, type ContractProposalCaption } from './contractProposalCompletion';
import { assertResponsePreparationRaw, assertResponsePreparationSources, RESPONSE_PREPARATION_LIMITS } from './responsePreparationBounds';
import { taskSourceSnapshotKey } from './taskSourceIdentity';
import type { IntelligenceEvidence, IntelligenceItem, IntelligenceSource } from './workbenchTypes';

type Focus = ProposalFocusedQuoteFocus;
export interface FocusedQuoteRawPart { batchId: string; model: string; raw: string }
export interface FocusedQuoteRunReceipt {
  version: 1; origin: 'model-focused-whole-quotes'; focus: Focus; sourceSnapshotKey: `sha256:${string}`;
  parts: FocusedQuoteRawPart[];
  decisions: Array<{ unitId: string; selected: boolean | null; reason: string }>;
  selections: Array<{ unitId: string; sourceId: string; fragmentId: string; locator: string; quote: string }>;
  counts: { units: number; selected: number; notSelected: number; unclear: number; batches: number };
}
/** The JSON receipt is historical data, not the capability. Only this module's
 * private WeakMap can establish a fully parsed in-memory focus run. */
export interface FocusedQuoteRunProof { readonly version: 1; readonly receipt: Readonly<FocusedQuoteRunReceipt> }
export interface FocusedQuoteProjectionReceipt {
  version: 1; origin: 'model-selected-focused-projection'; sourceSnapshotKey: `sha256:${string}`;
  runs: FocusedQuoteRunReceipt[]; caption?: ContractProposalCaption;
  fieldOrigins: Array<{ field: 'title' | 'lines' | 'lineDescriptions' | 'conclusion'; origin: 'source-derived-caption' | 'model-selected-whole-quotes'; unitIds: string[] }>;
  readiness: 'not-assessed'; warnings: string[]; projectedItemId?: string;
}
export interface FocusedQuoteProjection {
  status: 'candidate' | 'incomplete' | 'empty'; item?: IntelligenceItem; receipt: FocusedQuoteProjectionReceipt;
}
const proofs = new WeakMap<FocusedQuoteRunProof, { receipt: FocusedQuoteRunReceipt; serialized: string }>();
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
const keys = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) => required.every(key => Object.prototype.hasOwnProperty.call(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const safeText = (value: unknown, maximum: number, nonempty = false): value is string => typeof value === 'string' && value.length <= maximum && (!nonempty || Boolean(value.trim()))
  && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value) && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
const id = (value: unknown): value is string => safeText(value, 256, true) && Array.from(value).length <= 128 && !/[\u0000-\u001f]/u.test(value);
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
function assertReceiptBudget(receipt: unknown): void {
  if (bytes(JSON.stringify(receipt)) > RESPONSE_PREPARATION_LIMITS.rawBytes) throw new Error('Журнал выбранных цитат превышает 2 МБ. Источники и ответы не усечены.');
}
function assertRawParts(parts: unknown): asserts parts is FocusedQuoteRawPart[] {
  if (!Array.isArray(parts) || !parts.length || parts.length > PROPOSAL_FOCUSED_QUOTE_LIMITS.batches) throw new Error('Нужны исходные ответы всех пакетов одного фокуса, не более 64.');
  let total = 0; const seen = new Set<string>();
  for (const part of parts) {
    if (!object(part) || !keys(part, ['batchId', 'model', 'raw']) || !id(part.batchId) || seen.has(part.batchId) || !safeText(part.model, 200, true) || /[\u0000-\u001f]/u.test(part.model)) throw new Error('Некорректный или повторный исходный пакет фокуса.');
    assertResponsePreparationRaw(part.raw); total += bytes(part.raw); seen.add(part.batchId);
    if (total > RESPONSE_PREPARATION_LIMITS.rawBytes) throw new Error('Исходные ответы фокуса превышают 2 МБ. Частичный результат не принят.');
  }
}

type RunInput = { sources: readonly IntelligenceSource[]; options: ProposalFocusedQuotePlanOptions; parts: readonly FocusedQuoteRawPart[] };
function assertRunInput(input: unknown): asserts input is RunInput {
  if (!object(input) || !keys(input, ['sources', 'options', 'parts']) || !object(input.options)
    || !keys(input.options, ['focus'], ['instruction', 'maxSourcePayloadBytes', 'maxUnitsPerBatch']) || !['work-scope', 'deliverables'].includes(String(input.options.focus))) throw new Error('Нужен один явно указанный фокус и исходные пакеты без дополнительных полей.');
  assertResponsePreparationSources(input.sources); assertRawParts(input.parts);
  if (input.options.instruction !== undefined && !safeText(input.options.instruction, 20_000)
    || input.options.maxSourcePayloadBytes !== undefined && (!Number.isSafeInteger(input.options.maxSourcePayloadBytes) || Number(input.options.maxSourcePayloadBytes) < 512 || Number(input.options.maxSourcePayloadBytes) > PROPOSAL_FOCUSED_QUOTE_LIMITS.payloadBytes)
    || input.options.maxUnitsPerBatch !== undefined && (!Number.isSafeInteger(input.options.maxUnitsPerBatch) || Number(input.options.maxUnitsPerBatch) < 1 || Number(input.options.maxUnitsPerBatch) > PROPOSAL_FOCUSED_QUOTE_LIMITS.unitsPerBatch)) throw new Error('Некорректное задание или пределы фокусного разбора.');
}
function captureRun(input: unknown) {
  assertRunInput(input); const captured = structuredClone(input); assertRunInput(captured);
  return { captured, serialized: JSON.stringify(captured) };
}

/** Offline assembly only: no provider calls, source hydration, item parsing,
 * storage or canonical source completion. A valid response still needs an
 * independent semantic/completeness review. Capture before the first await,
 * then revalidate the live bounded request before publishing any capability. */
export async function assembleFocusedQuoteRun(input: RunInput): Promise<FocusedQuoteRunProof> {
  const { captured, serialized } = captureRun(input), plan = await buildProposalFocusedQuotePlan(captured.sources, captured.options);
  if (captured.parts.length !== plan.batches.length || captured.parts.some((part, index) => part.batchId !== plan.batches[index].id)) throw new Error('Нужны все пакеты фокуса ровно один раз и в исходном порядке.');
  const receipt: FocusedQuoteRunReceipt = { version: 1, origin: 'model-focused-whole-quotes', focus: captured.options.focus, sourceSnapshotKey: plan.sourceSnapshotKey,
    parts: captured.parts.map(part => ({ ...part })), decisions: [], selections: [], counts: { units: 0, selected: 0, notSelected: 0, unclear: 0, batches: plan.batches.length } };
  for (const part of captured.parts) {
    const response = await parseProposalFocusedQuoteResponse(part.raw, plan, part.batchId, captured.sources);
    receipt.decisions.push(...response.units.map(unit => ({ unitId: unit.unitId, selected: unit.selected, reason: unit.reason })));
    receipt.selections.push(...response.selections.map(selection => ({ unitId: selection.unitId, sourceId: selection.sourceId, fragmentId: selection.fragmentId, locator: selection.locator, quote: selection.quote })));
    receipt.counts.units += response.units.length;
    for (const key of ['selected', 'notSelected', 'unclear'] as const) receipt.counts[key] += response.counts[key];
  }
  assertReceiptBudget(receipt);
  if (captureRun(input).serialized !== serialized) throw new Error('Материалы, задание или исходные ответы изменились во время разбора. Результат фокуса не выдан.');
  const proof: FocusedQuoteRunProof = freeze({ version: 1, receipt }); proofs.set(proof, { receipt, serialized: JSON.stringify(receipt) }); return proof;
}

function issued(proof: FocusedQuoteRunProof, focus: Focus) {
  const stored = proof && typeof proof === 'object' ? proofs.get(proof) : undefined;
  if (!stored || proof.version !== 1 || stored.receipt.focus !== focus || JSON.stringify(proof.receipt) !== stored.serialized) throw new Error('Нужен полный исходный неизменный результат именно этого фокуса. JSON-журнал не заменяет проверенный запуск.');
  return stored.receipt;
}
function addEvidence(output: IntelligenceEvidence[], field: string, sourceId: string, fragmentId: string | undefined, quote: string): void {
  for (let start = 0; start < quote.length;) {
    let end = Math.min(start + 2000, quote.length);
    if (end < quote.length && /[\uD800-\uDBFF]/u.test(quote[end - 1]) && /[\uDC00-\uDFFF]/u.test(quote[end])) end--;
    output.push({ field, sourceId, ...(fragmentId ? { fragmentId } : {}), quote: quote.slice(start, end) }); start = end;
    if (output.length > 500) throw new Error('Подтверждения проекции превышают 500 записей. Частичный проект не создан.');
  }
}
function body(receipt: FocusedQuoteRunReceipt): string {
  const value = receipt.selections.map(selection => selection.quote).join('\n\n');
  if (value.length > 20_000) throw new Error('Выбранные целые цитаты превышают 20 000 символов на поле. Ничего не усечено.');
  return value;
}
type ProjectionInput = { sources: readonly IntelligenceSource[]; work: FocusedQuoteRunProof; deliverables?: FocusedQuoteRunProof };
function captureProjection(input: unknown) {
  if (!object(input) || !keys(input, ['sources', 'work'], ['deliverables'])) throw new Error('Некорректный запрос проекции выбранных работ и результатов.');
  assertResponsePreparationSources(input.sources);
  const workProof = input.work as FocusedQuoteRunProof, deliverablesProof = input.deliverables as FocusedQuoteRunProof | undefined;
  const work = issued(workProof, 'work-scope'), deliverables = deliverablesProof === undefined ? undefined : issued(deliverablesProof, 'deliverables');
  const sources = structuredClone(input.sources); assertResponsePreparationSources(sources);
  return { sources, serializedSources: JSON.stringify(sources), work, deliverables, workProof, deliverablesProof };
}

/** A small real-field projection, NOT a ready CP. One aggregate service line
 * preserves selected work occurrences in source order; selected results own
 * the conclusion. No canonical completion/tail or automatic conditions run. */
export async function projectFocusedQuoteProposal(input: ProjectionInput): Promise<FocusedQuoteProjection> {
  const captured = captureProjection(input), { sources, work, deliverables } = captured, sourceSnapshotKey = await taskSourceSnapshotKey(sources);
  const publish = (result: FocusedQuoteProjection): FocusedQuoteProjection => {
    const current = captureProjection(input);
    if (current.serializedSources !== captured.serializedSources || current.workProof !== captured.workProof || current.deliverablesProof !== captured.deliverablesProof) throw new Error('Материалы или выбранные фокусы изменились во время проекции. Прежние карточки не заменены.');
    return result;
  };
  if (work.sourceSnapshotKey !== sourceSnapshotKey || deliverables && deliverables.sourceSnapshotKey !== sourceSnapshotKey) throw new Error('Источники изменились либо фокусы относятся к разным снимкам. Прежние карточки не заменены.');
  const runs = [work, ...(deliverables ? [deliverables] : [])], rawBytes = runs.reduce((total, run) => total + run.parts.reduce((sum, part) => sum + bytes(part.raw), 0), 0);
  if (rawBytes > RESPONSE_PREPARATION_LIMITS.rawBytes) throw new Error('Общий объём исходных ответов фокусов превышает 2 МБ. Частичный проект не создан.');
  const receipt: FocusedQuoteProjectionReceipt = { version: 1, origin: 'model-selected-focused-projection', sourceSnapshotKey, runs: structuredClone(runs), fieldOrigins: [], readiness: 'not-assessed', warnings: [] };
  if (work.counts.unclear) receipt.warnings.push('Назначение части фрагментов для состава работ не определено моделью. Полнота выбранных работ не установлена.');
  if (!deliverables) receipt.warnings.push('Отдельный отбор результатов не выполнен. Результаты не дополнены из источника автоматически.');
  else if (!deliverables.counts.selected || deliverables.counts.unclear) receipt.warnings.push('Отбор результатов пуст или содержит неопределённые решения. Полнота результата не установлена.');
  if (!work.counts.selected) {
    receipt.warnings.push('Модель не выбрала ни одного целого фрагмента состава работ. Локальный состав не подставлен вместо ответа.'); assertReceiptBudget(receipt);
    return publish({ status: work.counts.unclear ? 'incomplete' : 'empty', receipt });
  }
  const caption = deriveContractProposalCaption(sources);
  if (!caption) { receipt.warnings.push('Однозначное краткое наименование услуги из исходного документа не установлено. Оно не выдумано и не усечено.'); assertReceiptBudget(receipt); return publish({ status: 'incomplete', receipt }); }
  const fields: IntelligenceItem['fields'] = { title: caption.title, lines: [caption.lineTitle], lineDescriptions: [body(work)] }, evidence: IntelligenceEvidence[] = [];
  receipt.caption = caption;
  for (const field of ['title', 'lines'] as const) {
    receipt.fieldOrigins.push({ field, origin: 'source-derived-caption', unitIds: [] });
    for (const proof of caption.evidence) addEvidence(evidence, field, proof.sourceId, proof.fragmentId, proof.quote);
  }
  receipt.fieldOrigins.push({ field: 'lineDescriptions', origin: 'model-selected-whole-quotes', unitIds: work.selections.map(selection => selection.unitId) });
  for (const selection of work.selections) addEvidence(evidence, 'lineDescriptions', selection.sourceId, selection.fragmentId, selection.quote);
  if (deliverables?.counts.selected) {
    fields.conclusion = body(deliverables); receipt.fieldOrigins.push({ field: 'conclusion', origin: 'model-selected-whole-quotes', unitIds: deliverables.selections.map(selection => selection.unitId) });
    for (const selection of deliverables.selections) addEvidence(evidence, 'conclusion', selection.sourceId, selection.fragmentId, selection.quote);
  }
  const item: IntelligenceItem = { id: crypto.randomUUID(), destination: 'proposals', title: caption.title, fields, selectedFields: Object.keys(fields), sourceIds: [...caption.sourceIds], evidence };
  receipt.projectedItemId = item.id; assertReceiptBudget(receipt);
  return publish({ status: receipt.warnings.length ? 'incomplete' : 'candidate', item, receipt });
}
