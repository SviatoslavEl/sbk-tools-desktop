import { assertResponsePreparationSources } from "./responsePreparationBounds";
import type { EvidenceExcerpt } from "./resultEvidence";
import type { SourceRepair } from "./sourceRepairs";
import type { IntelligenceItem, IntelligenceSource } from "./workbenchTypes";

export type ProposalQuotedTextField = "introduction" | "conclusion" | "paymentTerms" | "deliveryTerms";
declare const sourceSnapshotType: unique symbol;
export interface ProposalQuotedTextSourceSnapshot { readonly [sourceSnapshotType]: true }
export interface ProposalQuotedTextPreview { value: string; evidence: EvidenceExcerpt[]; sourceSnapshot: ProposalQuotedTextSourceSnapshot }
// One exact RAM-only serialization per unchanged source-array epoch, not one
// full snapshot for every field preview. Tokens contain no source data. Every
// lookup is preceded by fresh validation AND serialization, never cache-only.
const serializedSnapshots = new WeakMap<ProposalQuotedTextSourceSnapshot, string>();
const sourceSnapshots = new WeakMap<readonly IntelligenceSource[], ProposalQuotedTextSourceSnapshot>();
function currentSourceSnapshot(sources: readonly IntelligenceSource[]): ProposalQuotedTextSourceSnapshot {
  assertResponsePreparationSources(sources);
  const serialized = JSON.stringify(sources), previous = sourceSnapshots.get(sources);
  if (previous && serializedSnapshots.get(previous) === serialized) return previous;
  const token = Object.freeze({}) as ProposalQuotedTextSourceSnapshot;
  serializedSnapshots.set(token, serialized); sourceSnapshots.set(sources, token);
  return token;
}
const fields: readonly string[] = ["introduction", "conclusion", "paymentTerms", "deliveryTerms"];
const limits = { claims: 500, quote: 2000, field: 20000 } as const;
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const identifier = (value: unknown): value is string => typeof value === "string" && value.length <= 256 && Boolean(value.trim()) && !/[\u0000-\u001f]/u.test(value);
function wellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}
function assertItem(item: IntelligenceItem, field: string): void {
  if (!item || item.destination !== "proposals" || !fields.includes(field)) throw new Error("Дословная замена доступна только для вступления, заключения, оплаты и сроков КП.");
  if (!object(item.fields) || Object.keys(item.fields).length > 500
    || !Array.isArray(item.sourceIds) || item.sourceIds.length > 100 || !item.sourceIds.every(identifier) || new Set(item.sourceIds).size !== item.sourceIds.length
    || !Array.isArray(item.selectedFields) || item.selectedFields.length > 500 || !item.selectedFields.every(identifier)) throw new Error("Данные карточки или выбранных источников изменились. Повторно откройте результат.");
  const current = item.fields[field];
  if (current !== undefined && (typeof current !== "string" || current.length > limits.field || !wellFormed(current))) throw new Error("Текущее поле должно содержать корректный текст не длиннее 20000 символов. Старое значение не заменено.");
  if (!Array.isArray(item.evidence) || !item.evidence.length || item.evidence.length > limits.claims) throw new Error("Для дословной замены нужны текущие подтверждающие цитаты; допускается не более 500 цитат.");
  for (const claim of item.evidence) {
    if (!object(claim) || !Object.keys(claim).every((key) => ["field", "sourceId", "fragmentId", "quote"].includes(key))
      || !identifier(claim.field) || !identifier(claim.sourceId) || typeof claim.quote !== "string" || claim.quote.length > limits.quote) throw new Error("Подтверждающие цитаты имеют неверный формат или превышают 2000 символов. Повторите сверку источников.");
  }
}

/** Explicit preview of existing literal claims, not extraction or confirmation
 * of their role, completeness, applicability, model quality or a new decision.
 * No aggregate source text is hydrated and no whitespace is normalized.
 * Blank lines separate excerpts; their source order adds no semantic relation. */
export function previewProposalQuotedText(item: IntelligenceItem, field: string, sources: readonly IntelligenceSource[]): ProposalQuotedTextPreview {
  const sourceSnapshot = currentSourceSnapshot(sources);
  assertItem(item, field);
  const claims = item.evidence!.filter((claim) => claim.field === field);
  if (!claims.length) throw new Error("Для этого поля нет текущих цитат. Добавлять текст из других полей или всего источника автоматически нельзя.");
  const sourceIds = new Set(claims.map((claim) => claim.sourceId));
  if (sourceIds.size !== 1) throw new Error("Дословная замена не объединяет разные документы. Выберите цитаты одного источника.");
  const sourceId = claims[0].sourceId;
  const source = sources.find((entry) => entry.id === sourceId);
  if (!source || !item.sourceIds.includes(sourceId)) throw new Error("Источник цитат больше не выбран для этой карточки. Повторите сверку источников.");
  if (!source.fragments?.length) throw new Error("У источника нет однозначных фрагментов с идентификаторами. Повторно добавьте документ; общий текст не подставляется.");
  const fragmentIds = new Set<string>();
  for (const fragment of source.fragments) if (fragment.id !== undefined) {
    if (fragmentIds.has(fragment.id)) throw new Error("В источнике повторяются идентификаторы фрагментов. Повторно добавьте документ.");
    fragmentIds.add(fragment.id);
  }
  const excerpts: Array<{ fragmentIndex: number; start: number; end: number; evidence: EvidenceExcerpt }> = [];
  for (const claim of claims) {
    if (!identifier(claim.fragmentId) || !claim.quote.trim() || !wellFormed(claim.quote)) throw new Error("Цитате нужен идентификатор фрагмента и непустой корректный текст без оборванных символов.");
    const fragmentIndex = source.fragments.findIndex((entry) => entry.id === claim.fragmentId);
    const fragment = source.fragments[fragmentIndex];
    if (!fragment || (fragment.sheetState === "hidden" || fragment.sheetState === "veryHidden") && fragment.includedByUser !== true) throw new Error("Фрагмент цитаты изменился, исключён или находится на скрытом листе без явного выбора.");
    const start = fragment.text.indexOf(claim.quote);
    if (start < 0) throw new Error("Цитата больше не совпадает с текущим фрагментом дословно. Пробелы и исходный текст не исправляются автоматически.");
    if (fragment.text.indexOf(claim.quote, start + 1) !== -1) throw new Error("Цитата встречается во фрагменте несколько раз; её расположение неоднозначно. Выберите более полную цитату.");
    const end = start + claim.quote.length;
    if (excerpts.some((entry) => entry.fragmentIndex === fragmentIndex && entry.start === start && entry.end === end)) continue; // Exact same occurrence only; original claims are retained on apply.
    excerpts.push({ fragmentIndex, start, end, evidence: { sourceId, sourceName: source.name, fragmentId: fragment.id, locator: fragment.locator, quote: claim.quote } });
  }
  excerpts.sort((left, right) => left.fragmentIndex - right.fragmentIndex || left.start - right.start);
  for (let index = 1; index < excerpts.length; index++) {
    const previous = excerpts[index - 1], current = excerpts[index];
    if (previous.fragmentIndex === current.fragmentIndex && current.start < previous.end) throw new Error("Цитаты одного фрагмента перекрываются. Оставьте неперекрывающиеся полные цитаты; исходные подтверждения не изменены.");
  }
  const value = excerpts.map((entry) => entry.evidence.quote).join("\n\n");
  if (value.length > limits.field) throw new Error("Текст из цитат превышает 20000 символов. Ничего не усечено и не заменено.");
  return { value, evidence: excerpts.map((entry) => entry.evidence), sourceSnapshot };
}

/** Human action only. Recompute from current claims/sources immediately before
 * applying; stale text or a changed preview cannot overwrite the current field.
 * Other fields, original evidence and all raw/source data remain unchanged. */
export function applyProposalQuotedText(item: IntelligenceItem, field: string, sources: readonly IntelligenceSource[], expected: { previousValue: string | undefined; value: string; sourceSnapshot: ProposalQuotedTextSourceSnapshot }): SourceRepair {
  const preview = previewProposalQuotedText(item, field, sources);
  if (!object(expected) || !Object.prototype.hasOwnProperty.call(expected, "previousValue") || expected.previousValue !== undefined && typeof expected.previousValue !== "string" || typeof expected.value !== "string" || expected.value.length > limits.field
    || !object(expected.sourceSnapshot) || !serializedSnapshots.has(expected.sourceSnapshot)) throw new Error("Предварительный просмотр устарел или отсутствует. Повторно проверьте дословную замену.");
  if (item.fields[field] !== expected.previousValue || preview.value !== expected.value || preview.sourceSnapshot !== expected.sourceSnapshot) throw new Error("Поле, цитаты или материалы изменились после предварительного просмотра. Повторите проверку; старое значение сохранено.");
  return {
    fields: { ...item.fields, [field]: preview.value },
    selectedFields: item.selectedFields.includes(field) ? [...item.selectedFields] : [...item.selectedFields, field],
    evidence: item.evidence,
  };
}
