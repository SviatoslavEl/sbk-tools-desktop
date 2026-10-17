import { extractSourcePositionFacts } from "./sourcePositionFacts";
import { multipleLots } from "./automaticConditions";
import type { SourcePreparationChange, SourcePreparationResult } from "./sourcePreparedFacts";
import type { IntelligenceEvidence, IntelligenceItem, IntelligenceSource } from "./workbenchTypes";
const fold = (value: string) => value.replace(/\s+/gu, " ").trim();
const hasSku = (name: string, sku: string) => name.toUpperCase().split(/[^A-Z0-9_./-]+/u).includes(sku.toUpperCase());

/** Fresh source-proven SKU pairs only. Raw/model ordering cannot choose a
 * composition; the canonical source pair fills or creates its own SKU slot.
 * No record, raw response, ACK or source is mutated. */
export function completeSourcePositions(items: readonly IntelligenceItem[], sources: readonly IntelligenceSource[]): SourcePreparationResult {
  const unchanged = (): SourcePreparationResult => ({ items: [...items], changes: [], skipped: [], limited: false });
  const rollback = (reason: string, message: string): SourcePreparationResult => ({ ...unchanged(), limited: true, skipped: [{ reason, message, requiresReview: true }] });
  if (!items.some((item) => item.destination === "proposals")) return unchanged();
  if (items.length > 100 || sources.length > 100 || new Set(items.map((item) => item.id)).size !== items.length || new Set(sources.map((source) => source.id)).size !== sources.length) return rollback("position-input-limit", "Повторяются идентификаторы или превышен предел карточек / источников. Составы не назначены автоматически.");
  const inventory = extractSourcePositionFacts(sources);
  if (inventory.truncated) return rollback("position-inventory-limit", "Разбор составов достиг предела. Полные описания не усечены и не дополнены частично; разделите материалы.");
  const result = unchanged();
  for (const [index, item] of items.entries()) {
    if (item.destination !== "proposals") continue;
    const scoped = inventory.positions.filter((position) => item.sourceIds.includes(position.sourceId));
    const pairs = scoped.flatMap((position) => {
      const source = sources.find((entry) => entry.id === position.sourceId), configuration = inventory.configurations.find((entry) => entry.id === position.configurationId && entry.positionId === position.id);
      const proof = configuration && { sourceId: configuration.sourceId, sourceName: configuration.sourceName, fragmentId: configuration.fragmentId, locator: configuration.locator, quote: configuration.quote };
      if (!source || !configuration || !proof) return [];
      const fragments = source.fragments === undefined ? [{ locator: "Текст источника", text: source.text, id: undefined, sheetState: undefined }] : source.fragments;
      const visible = [position, configuration].every((fact) => fragments.some((fragment) => fragment.sheetState !== "hidden" && fragment.sheetState !== "veryHidden" && fragment.id === fact.fragmentId && fragment.locator === fact.locator && fold(fragment.text).includes(fold(fact.quote))));
      const ambiguous = position.ambiguous || configuration.ambiguous || multipleLots(source) || items.filter((other) => other.destination === "proposals" && other.sourceIds.includes(source.id)).length !== 1;
      if (ambiguous || !visible) { result.skipped.push({ ...proof, itemId: item.id, field: "lineDescriptions", reason: "ambiguous-position-owner", message: "Связь SKU с полным составом или карточкой неоднозначна. Распределение по порядку не выполнено; сопоставьте состав вручную.", requiresReview: true }); return []; }
      return [{ position, configuration, proof }];
    });
    if (!pairs.length) continue;
    const oldNames = item.fields.lines, oldDescriptions = item.fields.lineDescriptions;
    if (oldNames !== undefined && (!Array.isArray(oldNames) || oldNames.some((name) => typeof name !== "string")) || oldDescriptions !== undefined && (!Array.isArray(oldDescriptions) || oldDescriptions.some((description) => typeof description !== "string"))) { result.skipped.push({ itemId: item.id, reason: "invalid-position-fields", message: "Формат позиций повреждён. Старые значения сохранены без изменений.", requiresReview: true }); continue; }
    const names = [...(oldNames || [])], descriptions = [...(oldDescriptions || [])];
    if (descriptions.length > names.length) { result.skipped.push({ itemId: item.id, reason: "detached-position-descriptions", message: "Есть описания без позиций. Сначала восстановите их связь вручную; автоматическая перестановка не выполнена.", requiresReview: true }); continue; }
    while (descriptions.length < names.length) descriptions.push("");
    let failed = false;
    for (const { position, configuration } of pairs) {
      const matches = names.flatMap((name, at) => hasSku(name, position.sku) ? [at] : []);
      if (matches.length > 1 || matches.some((at) => scoped.some((other) => other.sku !== position.sku && hasSku(names[at], other.sku))) || configuration.quote.length > 20_000 || position.quote.length > 4000 || configuration.quote.length > 4000) { failed = true; break; }
      const at = matches.length ? matches[0] : names.length;
      names[at] = position.sku; descriptions[at] = configuration.quote;
    }
    if (failed || names.length > 100) { result.skipped.push({ itemId: item.id, reason: "position-proof-limit", message: "Есть дублирующая/смешанная SKU или полный состав не помещается в предел. Карточка не изменена частично; проверьте позиции вручную.", requiresReview: true }); continue; }
    const patch: SourcePreparationChange[] = [], fields = { ...item.fields, lines: names, lineDescriptions: descriptions };
    const evidence: IntelligenceEvidence[] = (item.evidence || []).filter((claim) => claim.field !== "lines" && claim.field !== "lineDescriptions");
    for (const pair of pairs) {
      evidence.push({ field: "lines", sourceId: pair.position.sourceId, fragmentId: pair.position.fragmentId, quote: pair.position.sku });
      evidence.push({ field: "lineDescriptions", sourceId: pair.proof.sourceId, fragmentId: pair.proof.fragmentId, quote: pair.proof.quote });
    }
    if (evidence.length > 500) { result.skipped.push({ itemId: item.id, reason: "position-evidence-limit", message: "Полные подтверждения превышают предел. Карточка не изменена.", requiresReview: true }); continue; }
    for (const field of ["lines", "lineDescriptions"] as const) if (JSON.stringify(item.fields[field]) !== JSON.stringify(fields[field]) || !item.selectedFields.includes(field)) patch.push({ ...pairs[0].proof, itemId: item.id, field, kind: item.fields[field] === undefined ? "added" : "replaced", ...(item.fields[field] !== undefined ? { previousValue: item.fields[field] } : {}), value: fields[field], requiresReview: true });
    result.items[index] = { ...item, fields, selectedFields: [...new Set([...item.selectedFields, "lines", "lineDescriptions"])], evidence };
    result.changes.push(...patch);
  }
  if (result.changes.length + result.skipped.length > 500 || new TextEncoder().encode(JSON.stringify(result)).byteLength > 8 * 1024 * 1024) return rollback("position-result-limit", "Дополнение составов достигло предела. Вся операция отменена без усечения исходных значений.");
  return result;
}
