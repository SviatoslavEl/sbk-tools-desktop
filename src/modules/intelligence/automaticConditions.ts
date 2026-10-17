import { extractIntelligenceConditionFacts, type IntelligenceConditionFact } from "./sourceConditionFacts";
import { createRequirementComparator } from "./requirementDeduplication";
import type { IntelligenceEvidence, IntelligenceItem, IntelligenceSource } from "./workbenchTypes";

export type AutoConditionCategory = IntelligenceConditionFact["category"];
interface Provenance {
  sourceId: string; sourceName: string; fragmentId?: string; locator: string; quote: string;
  category: AutoConditionCategory;
}
export interface AutoConditionChange extends Provenance {
  itemId: string; field: "requirements"; kind: "added" | "present"; requiresReview: true;
}
export interface AutoConditionSkipped extends Partial<Provenance> {
  itemId?: string; itemIds?: string[]; field: "requirements";
  reason: string; message: string; requiresReview: true;
}
export interface AutoConditionResult {
  items: IntelligenceItem[]; changes: AutoConditionChange[]; skipped: AutoConditionSkipped[]; limited: boolean;
}

const characters = (text: string) => Array.from(text).length;
const placeholder = (value: unknown): boolean => typeof value === "string" && /^(?:null|undefined|n\/a)$/iu.test(value.trim());
const validId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && characters(value) <= 128 && !/[\u0000-\u001f]/u.test(value);
const documentException = (fact: IntelligenceConditionFact) => fact.category === "exception" && /(?:документ|заявк|сертификат|декларац|копи[яиюй])/iu.test(fact.quote);
const operational = (fact: IntelligenceConditionFact) => {
  if (fact.explicitTechnicalRole) return true;
  if (fact.explicitProcedure) return true;
  if (fact.category === "quantity" && fact.explicitTableRole === "quantity") return true;
  if (fact.category === "license") return /лицензи/iu.test(fact.quote);
  if (fact.category === "payment" || fact.category === "delivery") return true;
  if (fact.category === "quantity") return /(?:кол-во|количество|(?:^|\t)(?:шт|ед|компл)\.?\t\s*\d|долж[а-я]*|не\s+менее|не\s+более|требу[еёю][а-я]*)/iu.test(fact.quote);
  return fact.category === "requirement" && /(?:долж[а-я]*|обязател|требу[еёю][а-я]*|необходимо|не\s+допуска|запрещ|не\s+менее|не\s+более)/iu.test(fact.quote);
};
const transferable = (fact: IntelligenceConditionFact, includeOperational = false) => fact.category === "certificate" || fact.category === "document" || documentException(fact) || includeOperational && operational(fact);
const unscopedException = (fact: IntelligenceConditionFact) => fact.category === "exception" || fact.category === "requirement" && /^\s*(?:\d+(?:\.\d+)*[.)]\s*)?(?:если|в\s+случае|при\s+условии|за\s+исключением)(?:\s|[:,])/iu.test(fact.quote);
const provenance = (fact: IntelligenceConditionFact): Provenance => ({ sourceId: fact.sourceId, sourceName: fact.sourceName, fragmentId: fact.fragmentId, locator: fact.locator, quote: fact.quote, category: fact.category as AutoConditionCategory });
const sameEvidence = (left: IntelligenceEvidence, right: IntelligenceEvidence) => left.field === right.field && left.sourceId === right.sourceId && left.fragmentId === right.fragmentId && left.quote === right.quote;

export function multipleLots(source: IntelligenceSource): boolean {
  const texts = source.fragments === undefined ? [source.text] : source.fragments.filter((fragment) => fragment.sheetState !== "hidden" && fragment.sheetState !== "veryHidden" || fragment.includedByUser === true).map((fragment) => fragment.text);
  const lots = new Set<string>();
  for (const text of texts) {
    // Only explicit line headings count. Prose such as «Лот включает…» or a
    // reference to another lot is not a lot identifier. Letter IDs must be a
    // single letter, Roman numeral or contain a number, never an arbitrary verb.
    for (const line of text.split(/\r?\n/u)) {
      if (/^\s*лоты\s*(?:№|#)?\s*[\p{L}\p{N}]{1,16}\s*(?:[-–—,;/]|и\s+|и(?=\s*№?\s*\d)\s*)(?:\s*№)?\s*[\p{L}\p{N}]{1,16}(?=$|[^\p{L}\p{N}])/iu.test(line)) return true;
      if (/^\s*лот\s*(?:№|#)?\s*\d{1,6}\s*[–—]\s*\d{1,6}(?=$|[^\p{L}\p{N}])/iu.test(line)) return true;
      const match = /^\s*лот\s*(?:[:(]\s*)?(?:№|#)?\s*([\p{L}\p{N}]{1,16}(?:[._/-][\p{L}\p{N}]{1,16})*)(?=\s*(?:$|[):.\t–—]))/iu.exec(line);
      if (match && (/\p{N}/u.test(match[1]) || /^\p{L}$/u.test(match[1]) || /^[IVXLCDM]+$/iu.test(match[1]))) lots.add(match[1].toUpperCase());
    }
  }
  return lots.size > 1;
}

/**
 * Supplements parsed procurement drafts, never the raw model reply. All facts
 * are freshly extracted from this snapshot. No cards, files, mandatory flags,
 * review acknowledgments, credentials or other destinations are manufactured.
 * A failing card is unchanged in full; receipts never imply full extraction.
 */
export function completeIntelligenceConditions(items: readonly IntelligenceItem[], sources: readonly IntelligenceSource[], options: { includeOperational?: boolean } = {}): AutoConditionResult {
  const result: AutoConditionResult = { items: [...items], changes: [], skipped: [], limited: false };
  const skip = (reason: string, message: string, extra: Partial<AutoConditionSkipped> = {}) => result.skipped.push({ field: "requirements", requiresReview: true, reason, message, ...extra });
  if (!items.some((item) => item.destination === "procurement")) return result;
  if (items.length > 100 || sources.length > 100) { result.limited = true; skip("input-limit", "Превышен предел карточек или источников. Автодополнение не выполнено."); return result; }
  const duplicateIds = new Set(sources.flatMap((source, index) => sources.findIndex((entry) => entry.id === source.id) !== index ? [source.id] : []));
  const currentSources = sources.filter((source) => {
    if (!validId(source.id) || duplicateIds.has(source.id)) { skip("invalid-source", "Источник с отсутствующим или повторяющимся идентификатором исключён.", { ...(typeof source.id === "string" ? { sourceId: source.id } : {}) }); return false; }
    return true;
  });
  const inventory = extractIntelligenceConditionFacts(currentSources);
  if (inventory.limited) { result.limited = true; skip("inventory-limit", "Разбор источников достиг предела. Автодополнение остановлено целиком; список найденных условий может быть неполным."); return result; }
  const sourceMap = new Map(currentSources.map((source) => [source.id, source]));
  const multiLotIds = new Set(currentSources.filter(multipleLots).map((source) => source.id));
  const plans = new Map<number, IntelligenceConditionFact[]>();
  for (const fact of inventory.facts) {
    const canTransfer = transferable(fact, options.includeOperational);
    if (!canTransfer && !unscopedException(fact)) continue;
    const owners = items.flatMap((item, index) => item.destination === "procurement" && Array.isArray(item.sourceIds) && item.sourceIds.includes(fact.sourceId) ? [index] : []);
    const proof = canTransfer ? provenance(fact) : { sourceId: fact.sourceId, sourceName: fact.sourceName, fragmentId: fact.fragmentId, locator: fact.locator, quote: fact.quote };
    if (!owners.length) { if (canTransfer) skip("unowned-source", "Условие не относится к источникам карточки закупки.", proof); continue; }
    if (!canTransfer) { skip("untransferred-exception", "Отдельная оговорка не содержит явной связи с документами или сертификатами. Проверьте её применимость вручную.", { ...proof, itemIds: owners.map((index) => items[index].id) }); continue; }
    if (fact.automaticTransferRestriction) {
      skip(fact.automaticTransferRestriction, fact.automaticTransferRestriction === "detached-scope"
        ? "Ограничение или альтернатива находятся в отдельном фрагменте. Условие не перенесено без его области применимости; проверьте исходные фрагменты."
        : "Справочный документ относится к обоснованию цены или ранее полученным предложениям, а не к составу заявки. Он не добавлен как обязанность участника.", { ...proof, itemIds: owners.map((index) => items[index].id) });
      continue;
    }
    if (owners.length !== 1) { skip("multiple-cards", "Один источник используется несколькими карточками закупки. Распределение условий не угадано.", { ...proof, itemIds: owners.map((index) => items[index].id) }); continue; }
    const owner = owners[0];
    if (multiLotIds.has(fact.sourceId)) { skip("multiple-lots", "В источнике несколько лотов. Применимость условия к карточке не назначена автоматически.", { ...proof, itemId: items[owner].id }); continue; }
    const source = sourceMap.get(fact.sourceId)!;
    const fragments = source.fragments === undefined ? [{ text: source.text, id: undefined, locator: "Текст источника", sheetState: undefined, includedByUser: undefined }] : source.fragments;
    if (!fragments.some((fragment) => (fragment.sheetState !== "hidden" && fragment.sheetState !== "veryHidden" || fragment.includedByUser === true) && fragment.id === fact.fragmentId && fragment.locator === fact.locator && fragment.text.includes(fact.quote))
      || fact.supportingEvidence?.some((support) => support.sourceId !== fact.sourceId || !fragments.some((fragment) => fragment.sheetState !== "hidden" && fragment.sheetState !== "veryHidden" && fragment.id === support.fragmentId && fragment.locator === support.locator && fragment.text === support.quote))) { skip("stale-fact", "Полная цитата или её заголовок больше не найдены в доступном фрагменте.", { ...proof, itemId: items[owner].id }); continue; }
    plans.set(owner, [...(plans.get(owner) || []), fact]);
  }
  for (const [index, facts] of plans) {
    const item = items[index];
    if (!item.fields || typeof item.fields !== "object" || Array.isArray(item.fields) || !Array.isArray(item.selectedFields) || !validId(item.id) || items.filter((entry) => entry.id === item.id).length !== 1 || !Array.isArray(item.sourceIds) || new Set(item.sourceIds).size !== item.sourceIds.length) {
      for (const fact of facts) skip("invalid-card", "Карточка или принадлежность источников имеют неверный формат. Автодополнение не выполнено.", { ...provenance(fact), itemId: item.id });
      continue;
    }
    if (item.evidence !== undefined && (!Array.isArray(item.evidence) || item.evidence.some((claim) => !claim || typeof claim !== "object" || typeof claim.field !== "string" || typeof claim.sourceId !== "string" || typeof claim.quote !== "string"))) {
      for (const fact of facts) skip("invalid-evidence", "Список исходных цитат повреждён. Карточка не изменена.", { ...provenance(fact), itemId: item.id });
      continue;
    }
    // Weak models sometimes encode unknown as text despite the nullable wire
    // schema. Only exact absence markers may be removed; meaningful malformed
    // text is never silently converted into a list or discarded.
    const original = item.fields.requirements;
    const old = placeholder(original) ? undefined : Array.isArray(original) ? original.filter((entry) => !placeholder(entry)) : original;
    let failure = "", message = "";
    if (old !== undefined && (!Array.isArray(old) || old.some((entry) => typeof entry !== "string" || !entry.trim() || characters(entry) > 2000))) { failure = "invalid-requirements"; message = "Исходное поле требований имеет неверный формат. Оно сохранено без изменения; автоматическое дополнение этой карточки не выполнено."; }
    const entries = Array.isArray(old) ? [...old] : [], evidence = [...(item.evidence || [])], changes: AutoConditionChange[] = [];
    const equalRequirement = createRequirementComparator([...entries.filter((entry) => typeof entry === "string"), ...facts.map((fact) => fact.quote)]);
    if (entries.length > 100 || evidence.length > 500) { failure = "existing-limit"; message = "Исходная карточка уже превышает предел требований или цитат. Автодополнение не выполнено."; result.limited = true; }
    for (const fact of facts) {
      if (failure) break;
      if (characters(fact.quote) > 2000) { failure = "condition-too-long"; message = "Полное условие длиннее 2000 символов. Оно не усечено; автодополнение этой карточки остановлено."; result.limited = true; break; }
      const present = entries.some((entry) => equalRequirement(entry, fact.quote));
      if (!present) entries.push(fact.quote);
      const claim: IntelligenceEvidence = { field: "requirements", sourceId: fact.sourceId, fragmentId: fact.fragmentId, quote: fact.quote };
      if (!evidence.some((entry) => sameEvidence(entry, claim))) evidence.push(claim);
      for (const support of fact.supportingEvidence || []) {
        const scopeClaim: IntelligenceEvidence = { field: "requirements", sourceId: support.sourceId, fragmentId: support.fragmentId, quote: support.quote };
        if (!evidence.some((entry) => sameEvidence(entry, scopeClaim))) evidence.push(scopeClaim);
      }
      if (entries.length > 100 || evidence.length > 500) { failure = entries.length > 100 ? "requirements-limit" : "evidence-limit"; message = "Все выбранные условия не помещаются в предел 100 требований / 500 цитат. Карточка не изменена, условия не усечены."; result.limited = true; break; }
      changes.push({ ...provenance(fact), itemId: item.id, field: "requirements", kind: present ? "present" : "added", requiresReview: true });
    }
    if (failure) { for (const fact of facts) skip(failure, message, { ...provenance(fact), itemId: item.id }); continue; }
    result.items[index] = { ...item, fields: { ...item.fields, requirements: entries }, selectedFields: [...new Set([...item.selectedFields, "requirements"])], evidence };
    result.changes.push(...changes);
  }
  return result;
}

export const autoCompleteCertificateDocuments = completeIntelligenceConditions;
