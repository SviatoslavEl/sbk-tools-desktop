import { buildProposalFocusedUnitSelectionPlan, parseProposalFocusedUnitSelectionResponse, PROPOSAL_FOCUSED_UNIT_SELECTION_LIMITS, type ProposalFocusedQuoteFocus, type ProposalFocusedUnitSelectionPlan, type ProposalFocusedUnitSelectionOptions, type ProposalFocusedUnitSelectionReference } from './proposalFocusedQuotePlan';
import { deriveContractProposalCaption, type ContractProposalCaption } from './contractProposalCompletion';
import { assertResponsePreparationRaw, assertResponsePreparationSources, RESPONSE_PREPARATION_LIMITS } from './responsePreparationBounds';
import { taskSourceSnapshotKey } from './taskSourceIdentity';
import type { IntelligenceEvidence, IntelligenceItem, IntelligenceSource } from './workbenchTypes';

type Focus = ProposalFocusedQuoteFocus;
export interface FocusedUnitSelectionRawPart { batchId: string; model: string; raw: string }
export interface FocusedUnitMaterialization extends ProposalFocusedUnitSelectionReference {
  origin: 'source-materialized-whole-fragment'; text: string;
}
export interface FocusedUnitSelectionRunReceipt {
  version: 2; origin: 'model-selection/source-materialized-fragments'; focus: Focus; sourceSnapshotKey: `sha256:${string}`;
  parts: FocusedUnitSelectionRawPart[];
  decisions: Array<{ unitId: string; selected: boolean | null; reason: string }>;
  references: ProposalFocusedUnitSelectionReference[];
  materializations: FocusedUnitMaterialization[];
  counts: { units: number; selected: number; notSelected: number; unclear: number; batches: number };
}
/** The JSON receipt is historical data, not the capability. Only this module's
 * private WeakMap can establish a parsed source/focus-bound in-memory run.
 * Neither this capability nor the receipt authenticates a provider call. */
export interface FocusedUnitSelectionRunProof { readonly version: 2; readonly receipt: Readonly<FocusedUnitSelectionRunReceipt> }
export interface FocusedUnitSelectionProjectionReceipt {
  version: 2; origin: 'model-selection/source-materialized-projection'; sourceSnapshotKey: `sha256:${string}`;
  runs: FocusedUnitSelectionRunReceipt[]; caption?: ContractProposalCaption;
  fieldOrigins: Array<{ field: 'title' | 'lines' | 'lineDescriptions' | 'conclusion'; origin: 'source-derived-caption' | 'model-selected/source-materialized-text'; unitIds: string[] }>;
  readiness: 'not-assessed'; warnings: string[]; projectedItemId?: string;
}
export interface FocusedUnitSelectionProjection {
  status: 'candidate' | 'incomplete' | 'empty'; item?: IntelligenceItem; receipt: FocusedUnitSelectionProjectionReceipt;
}
const proofs = new WeakMap<FocusedUnitSelectionRunProof, { receipt: FocusedUnitSelectionRunReceipt; serialized: string }>();
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
const keys = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) => required.every(key => Object.prototype.hasOwnProperty.call(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const safeText = (value: unknown, maximum: number, nonempty = false): value is string => typeof value === 'string' && value.length <= maximum && (!nonempty || Boolean(value.trim()))
  && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value) && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
const id = (value: unknown): value is string => safeText(value, 256, true) && Array.from(value).length <= 128 && !/[\u0000-\u001f]/u.test(value);
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
function assertReceiptBudget(receipt: unknown): void {
  if (bytes(JSON.stringify(receipt)) > RESPONSE_PREPARATION_LIMITS.rawBytes) throw new Error('Журнал отбора фрагментов превышает 2 МБ. Источники и ответы не усечены.');
}
function assertRawParts(parts: unknown): asserts parts is FocusedUnitSelectionRawPart[] {
  if (!Array.isArray(parts) || !parts.length || parts.length > PROPOSAL_FOCUSED_UNIT_SELECTION_LIMITS.batches) throw new Error('Нужны исходные ответы всех пакетов одного фокуса, не более 64.');
  let total = 0; const seen = new Set<string>();
  for (const part of parts) {
    if (!object(part) || !keys(part, ['batchId', 'model', 'raw']) || !id(part.batchId) || seen.has(part.batchId) || !safeText(part.model, 200, true) || /[\u0000-\u001f]/u.test(part.model)) throw new Error('Некорректный или повторный исходный пакет фокуса.');
    assertResponsePreparationRaw(part.raw); total += bytes(part.raw); seen.add(part.batchId);
    if (total > RESPONSE_PREPARATION_LIMITS.rawBytes) throw new Error('Исходные ответы фокуса превышают 2 МБ. Частичный результат не принят.');
  }
}

type RunInput = { sources: readonly IntelligenceSource[]; options: ProposalFocusedUnitSelectionOptions; parts: readonly FocusedUnitSelectionRawPart[] };
function assertRunInput(input: unknown): asserts input is RunInput {
  if (!object(input) || !keys(input, ['sources', 'options', 'parts']) || !object(input.options)
    || !keys(input.options, ['focus'], ['instruction', 'maxSourcePayloadBytes', 'maxUnitsPerBatch']) || !['work-scope', 'deliverables'].includes(String(input.options.focus))) throw new Error('Нужен один явно указанный фокус и исходные пакеты без дополнительных полей.');
  assertResponsePreparationSources(input.sources); assertRawParts(input.parts);
  if (input.options.instruction !== undefined && !safeText(input.options.instruction, 20_000)
    || input.options.maxSourcePayloadBytes !== undefined && (!Number.isSafeInteger(input.options.maxSourcePayloadBytes) || Number(input.options.maxSourcePayloadBytes) < 512 || Number(input.options.maxSourcePayloadBytes) > PROPOSAL_FOCUSED_UNIT_SELECTION_LIMITS.payloadBytes)
    || input.options.maxUnitsPerBatch !== undefined && (!Number.isSafeInteger(input.options.maxUnitsPerBatch) || Number(input.options.maxUnitsPerBatch) < 1 || Number(input.options.maxUnitsPerBatch) > PROPOSAL_FOCUSED_UNIT_SELECTION_LIMITS.unitsPerBatch)) throw new Error('Некорректное задание или пределы фокусного разбора.');
}
function captureRun(input: unknown) {
  assertRunInput(input); const captured = structuredClone(input); assertRunInput(captured);
  return { captured, serialized: JSON.stringify(captured) };
}

/** Materialize ONLY a true decision's exact owner from the same fresh plan
 * and captured snapshot. This local text is not a model-extracted quote.
 * No aggregate text, lookup by content, source repair or fallback is allowed. */
function materialize(reference: ProposalFocusedUnitSelectionReference, plan: ProposalFocusedUnitSelectionPlan, batchId: string, sources: readonly IntelligenceSource[]): FocusedUnitMaterialization {
  const owner = plan.batches.find(batch => batch.id === batchId)?.units.find(unit => unit.unitId === reference.unitId);
  if (!owner || owner.sourceId !== reference.sourceId || owner.fragmentId !== reference.fragmentId || owner.fragmentIndex !== reference.fragmentIndex || owner.locator !== reference.locator) throw new Error('Выбранный фрагмент не принадлежит исходному пакету и снимку. Текст не подставлен.');
  const source = sources.find(value => value.id === reference.sourceId), fragment = source?.fragments?.[reference.fragmentIndex];
  if (!fragment || fragment.id !== reference.fragmentId || fragment.locator !== reference.locator || fragment.text !== owner.text
    || fragment.sheetState === 'hidden' || fragment.sheetState === 'veryHidden' || fragment.includedByUser === false) throw new Error('Исходный целый фрагмент изменился, скрыт или не выбран. Текст не подставлен.');
  if (!fragment.text.trim()) throw new Error('Выбранный фрагмент пуст. Результат фокуса не выдан; другой текст не подставлен.');
  return { origin: 'source-materialized-whole-fragment', unitId: reference.unitId, sourceId: reference.sourceId, fragmentId: reference.fragmentId, fragmentIndex: reference.fragmentIndex, locator: reference.locator, text: fragment.text };
}

/** Offline assembly only: parse all actual decisions, then locally materialize
 * selected source-owned whole fragments. No provider calls, item parsing,
 * storage or canonical source completion. Parsing is not provider authenticity
 * or a semantic/completeness PASS. Revalidate before publishing a capability. */
export async function assembleFocusedUnitSelectionRun(input: RunInput): Promise<FocusedUnitSelectionRunProof> {
  const { captured, serialized } = captureRun(input), plan = await buildProposalFocusedUnitSelectionPlan(captured.sources, captured.options);
  if (captured.parts.length !== plan.batches.length || captured.parts.some((part, index) => part.batchId !== plan.batches[index].id)) throw new Error('Нужны все пакеты фокуса ровно один раз и в исходном порядке.');
  const receipt: FocusedUnitSelectionRunReceipt = { version: 2, origin: 'model-selection/source-materialized-fragments', focus: captured.options.focus, sourceSnapshotKey: plan.sourceSnapshotKey,
    parts: captured.parts.map(part => ({ ...part })), decisions: [], references: [], materializations: [], counts: { units: 0, selected: 0, notSelected: 0, unclear: 0, batches: plan.batches.length } };
  for (const part of captured.parts) {
    const response = await parseProposalFocusedUnitSelectionResponse(part.raw, plan, part.batchId, captured.sources);
    const selected = response.units.filter(unit => unit.selected === true);
    if (response.version !== 2 || response.focus !== plan.focus || response.batchId !== part.batchId || response.sourceSnapshotKey !== plan.sourceSnapshotKey
      || response.references.length !== selected.length || response.references.some((reference, index) => reference.unitId !== selected[index].unitId)) throw new Error('Ссылки не соответствуют точным положительным решениям этого фокуса. Невыбранный текст не материализован.');
    receipt.decisions.push(...response.units.map(unit => ({ unitId: unit.unitId, selected: unit.selected, reason: unit.reason })));
    receipt.references.push(...response.references.map(reference => ({ ...reference })));
    receipt.materializations.push(...response.references.map(reference => materialize(reference, plan, part.batchId, captured.sources)));
    receipt.counts.units += response.units.length;
    for (const key of ['selected', 'notSelected', 'unclear'] as const) receipt.counts[key] += response.counts[key];
  }
  assertReceiptBudget(receipt);
  if (captureRun(input).serialized !== serialized) throw new Error('Материалы, задание или исходные ответы изменились во время разбора. Результат фокуса не выдан.');
  const proof: FocusedUnitSelectionRunProof = freeze({ version: 2, receipt }); proofs.set(proof, { receipt, serialized: JSON.stringify(receipt) }); return proof;
}

function issued(proof: FocusedUnitSelectionRunProof, focus: Focus) {
  const stored = proof && typeof proof === 'object' ? proofs.get(proof) : undefined;
  if (!stored || proof.version !== 2 || stored.receipt.focus !== focus || JSON.stringify(proof.receipt) !== stored.serialized) throw new Error('Нужен полный исходный неизменный результат именно этого фокуса версии 2. JSON-журнал или прежний quote-proof не заменяет проверенный разбор.');
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
function body(receipt: FocusedUnitSelectionRunReceipt): string {
  const value = receipt.materializations.map(materialization => materialization.text).join('\n\n');
  if (value.length > 20_000) throw new Error('Выбранные целые фрагменты превышают 20 000 символов на поле. Ничего не усечено.');
  return value;
}
type ProjectionInput = { sources: readonly IntelligenceSource[]; work: FocusedUnitSelectionRunProof; deliverables?: FocusedUnitSelectionRunProof };
function captureProjection(input: unknown) {
  if (!object(input) || !keys(input, ['sources', 'work'], ['deliverables'])) throw new Error('Некорректный запрос проекции выбранных работ и результатов.');
  assertResponsePreparationSources(input.sources);
  const workProof = input.work as FocusedUnitSelectionRunProof, deliverablesProof = input.deliverables as FocusedUnitSelectionRunProof | undefined;
  const work = issued(workProof, 'work-scope'), deliverables = deliverablesProof === undefined ? undefined : issued(deliverablesProof, 'deliverables');
  const sources = structuredClone(input.sources); assertResponsePreparationSources(sources);
  return { sources, serializedSources: JSON.stringify(sources), work, deliverables, workProof, deliverablesProof };
}

/** A small real-field projection, NOT a ready CP. One aggregate service line
 * preserves selected work occurrences in source order; selected results own
 * the conclusion. No canonical completion/tail or automatic conditions run. */
export async function projectFocusedUnitSelectionProposal(input: ProjectionInput): Promise<FocusedUnitSelectionProjection> {
  const captured = captureProjection(input), { sources, work, deliverables } = captured, sourceSnapshotKey = await taskSourceSnapshotKey(sources);
  const publish = (result: FocusedUnitSelectionProjection): FocusedUnitSelectionProjection => {
    const current = captureProjection(input);
    if (current.serializedSources !== captured.serializedSources || current.workProof !== captured.workProof || current.deliverablesProof !== captured.deliverablesProof) throw new Error('Материалы или выбранные фокусы изменились во время проекции. Прежние карточки не заменены.');
    return result;
  };
  if (work.sourceSnapshotKey !== sourceSnapshotKey || deliverables && deliverables.sourceSnapshotKey !== sourceSnapshotKey) throw new Error('Источники изменились либо фокусы относятся к разным снимкам. Прежние карточки не заменены.');
  const runs = [work, ...(deliverables ? [deliverables] : [])], rawBytes = runs.reduce((total, run) => total + run.parts.reduce((sum, part) => sum + bytes(part.raw), 0), 0);
  if (rawBytes > RESPONSE_PREPARATION_LIMITS.rawBytes) throw new Error('Общий объём исходных ответов фокусов превышает 2 МБ. Частичный проект не создан.');
  const receipt: FocusedUnitSelectionProjectionReceipt = { version: 2, origin: 'model-selection/source-materialized-projection', sourceSnapshotKey, runs: structuredClone(runs), fieldOrigins: [], readiness: 'not-assessed', warnings: [] };
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
  receipt.fieldOrigins.push({ field: 'lineDescriptions', origin: 'model-selected/source-materialized-text', unitIds: work.references.map(reference => reference.unitId) });
  for (const materialization of work.materializations) addEvidence(evidence, 'lineDescriptions', materialization.sourceId, materialization.fragmentId, materialization.text);
  if (deliverables?.counts.selected) {
    fields.conclusion = body(deliverables); receipt.fieldOrigins.push({ field: 'conclusion', origin: 'model-selected/source-materialized-text', unitIds: deliverables.references.map(reference => reference.unitId) });
    for (const materialization of deliverables.materializations) addEvidence(evidence, 'conclusion', materialization.sourceId, materialization.fragmentId, materialization.text);
  }
  const item: IntelligenceItem = { id: crypto.randomUUID(), destination: 'proposals', title: caption.title, fields, selectedFields: Object.keys(fields), sourceIds: [...caption.sourceIds], evidence };
  receipt.projectedItemId = item.id; assertReceiptBudget(receipt);
  return publish({ status: receipt.warnings.length ? 'incomplete' : 'candidate', item, receipt });
}
