import { extractIntelligenceDateFacts, type EvidenceExcerpt, type IntelligenceDateFact } from "./resultEvidence";
import { dateFactField } from "./sourceGrounding";
import { extractSourcePositionFacts } from "./sourcePositionFacts";
import { extractIntelligenceConditionFacts } from "./sourceConditionFacts";
import { fieldDefinitions, intelligenceFieldError } from "./workbenchModel";
import type { IntelligenceEvidence, IntelligenceFieldValue, IntelligenceItem, IntelligenceSource } from "./workbenchTypes";

export type SourceRepair = Pick<IntelligenceItem, "fields" | "selectedFields" | "evidence">;
export interface ConditionCandidate extends EvidenceExcerpt { category: string; ambiguous?: boolean }
const fold = (value: string) => value.replace(/\s+/gu, " ").trim();
const conditionKey = (value: string) => value.normalize("NFKC").trim()
  .replace(/^(?:\d{1,3}(?:\.\d{1,3}){0,3}[.)]\s+|[oо]\t|[•▪●]\s*|[-–—]\s+)/iu, "")
  .toLocaleLowerCase("ru").replace(/ё/gu, "е").replace(/[–—]/gu, "-")
  .replace(/\s+/gu, " ").replace(/[.;,]+$/u, "").trim();
const noteKey = (item: IntelligenceItem) => item.destination === "proposals" ? "internalNote" : "notes";

function ownsQuote(item: IntelligenceItem, fact: EvidenceExcerpt, sources: readonly IntelligenceSource[]) {
  const matches = sources.filter((entry) => entry.id === fact.sourceId && item.sourceIds.includes(entry.id));
  const source = matches[0];
  if (matches.length !== 1 || !source || !fact.quote.trim()) throw new Error("Факт не относится к однозначно выбранным источникам этой карточки.");
  const fragments = source.fragments === undefined ? [{ text: source.text, locator: "Текст источника", id: undefined, sheetState: undefined, includedByUser: undefined }] : source.fragments;
  if (!fragments.some((fragment) => ((fragment.sheetState !== "hidden" && fragment.sheetState !== "veryHidden") || fragment.includedByUser === true)
    && (!fact.fragmentId || fragment.id === fact.fragmentId) && fragment.locator === fact.locator && fold(fragment.text).includes(fold(fact.quote)))) throw new Error("Исходная цитата изменилась или исключена. Повторите сверку источников.");
}
function appendText(old: IntelligenceFieldValue | undefined, quote: string) {
  if (old !== undefined && typeof old !== "string") throw new Error("Сначала исправьте некорректный текст в редактируемом поле; он не будет заменён автоматически.");
  const previous = old || "";
  return fold(previous).includes(fold(quote)) ? previous : [previous, quote].filter(Boolean).join("\n");
}
function evidenceFor(field: string, facts: readonly EvidenceExcerpt[]): IntelligenceEvidence[] {
  // Never truncate a claim and pretend that the complete condition was quoted.
  return facts.filter((fact) => fact.quote.length <= 2000).map((fact) => ({ field, sourceId: fact.sourceId, fragmentId: fact.fragmentId, quote: fact.quote }));
}
function finish(item: IntelligenceItem, fields: Record<string, IntelligenceFieldValue>, changed: string[], added: IntelligenceEvidence[], replaced: string[] = []): SourceRepair {
  for (const key of changed) {
    const definition = fieldDefinitions[item.destination].find((field) => field.key === key);
    if (!definition) throw new Error("Поле не поддерживается этим типом карточки.");
    const problem = intelligenceFieldError(definition, fields[key]);
    if (problem) throw new Error(`${definition.label}: ${problem}`);
  }
  const evidence = [...(item.evidence || []).filter((claim) => !replaced.includes(claim.field)), ...added]
    .filter((claim, index, all) => all.findIndex((other) => other.field === claim.field && other.sourceId === claim.sourceId && other.fragmentId === claim.fragmentId && other.quote === claim.quote) === index);
  if (evidence.length > 500) throw new Error("Слишком много подтверждающих цитат. Добавьте меньше условий за один раз.");
  return { fields, selectedFields: [...new Set([...item.selectedFields, ...changed])], evidence };
}

/** Explicit user action only. No model response, record or source is mutated. */
export function repairDateFromSource(item: IntelligenceItem, requested: IntelligenceDateFact, sources: readonly IntelligenceSource[]): SourceRepair {
  const scoped = sources.filter((source) => item.sourceIds.includes(source.id));
  const identity = (fact: IntelligenceDateFact) => JSON.stringify([fact.sourceId, fact.fragmentId, fact.locator, fact.quote, fact.event, fact.iso, fact.time, fact.timezone, Boolean(fact.lowerBound), Boolean(fact.ambiguous), (fact.supportingEvidence || []).map((entry) => [entry.sourceId, entry.fragmentId, entry.locator, entry.quote])]);
  const fact = extractIntelligenceDateFacts(scoped).facts.find((entry) => identity(entry) === identity(requested));
  if (!fact) throw new Error("Дата больше не подтверждается текущим источником.");
  if (fact.ambiguous) throw new Error("Сначала уточните связь с лотом или противоречивый часовой пояс. Автоматический выбор не выполнен.");
  const key = dateFactField(item.destination, fact.event);
  if (!key) throw new Error("Это событие нельзя подставить в дату этой карточки.");
  ownsQuote(item, fact, sources);
  const fields: Record<string, IntelligenceFieldValue> = { ...item.fields, [key]: fact.iso }, changed = [key];
  const excerpts = [fact, ...(fact.supportingEvidence || [])];
  for (const excerpt of excerpts) ownsQuote(item, excerpt, sources);
  const notes = noteKey(item);
  const label = fieldDefinitions[item.destination].find((field) => field.key === key)!.label;
  const context = `${label}: ${fact.iso}${fact.time ? ` ${fact.time}` : ""}${fact.timezone ? ` ${fact.timezone}` : ""}${fact.lowerBound ? " (не ранее; нижняя допустимая граница)" : ""} — ${fact.quote}`;
  fields[notes] = appendText(fields[notes], context);
  for (const excerpt of fact.supportingEvidence || []) fields[notes] = appendText(fields[notes], excerpt.quote);
  changed.push(notes);
  return finish(item, fields, changed, [...evidenceFor(key, [fact]), ...evidenceFor(notes, excerpts)], [key]);
}

/** Add complete literal candidates. Applicability still belongs to the reviewer. */
export function repairConditionsFromSources(item: IntelligenceItem, facts: readonly ConditionCandidate[], sources: readonly IntelligenceSource[]): SourceRepair {
  if (!facts.length || facts.length > 100) throw new Error("Выберите от 1 до 100 условий.");
  const current = extractIntelligenceConditionFacts(sources.filter((source) => item.sourceIds.includes(source.id))).facts;
  const fields = { ...item.fields }, changed: string[] = [], added: IntelligenceEvidence[] = [];
  for (const fact of facts) {
    ownsQuote(item, fact, sources);
    if (!current.some((entry) => entry.sourceId === fact.sourceId && entry.fragmentId === fact.fragmentId && entry.locator === fact.locator && entry.quote === fact.quote && entry.category === fact.category && Boolean(entry.ambiguous) === Boolean(fact.ambiguous))) throw new Error("Условие изменилось, исключено или больше не найдено целиком. Повторите разбор источников.");
    let key: string = noteKey(item);
    if (item.destination === "procurement") key = fact.category === "license" ? "licenses" : ["payment", "delivery"].includes(fact.category) ? "notes" : "requirements";
    if (item.destination === "proposals") key = fact.category === "payment" ? "paymentTerms" : fact.category === "delivery" ? "deliveryTerms" : "internalNote";
    if (item.destination === "staff" && fact.category === "certificate") key = "certificates";
    const definition = fieldDefinitions[item.destination].find((field) => field.key === key)!;
    if (definition.kind === "list") {
      const previous = fields[key];
      if (previous !== undefined && (!Array.isArray(previous) || previous.some((entry) => typeof entry !== "string"))) throw new Error(`${definition.label}: сначала исправьте неверный формат списка. Старое значение сохранено.`);
      const entries = [...(previous || [])];
      if (!entries.some((entry) => conditionKey(entry) === conditionKey(fact.quote))) entries.push(fact.quote);
      fields[key] = entries;
    } else fields[key] = appendText(fields[key], fact.quote);
    changed.push(key); added.push(...evidenceFor(key, [fact]));
  }
  return finish(item, fields, [...new Set(changed)], added);
}

/** SKU and composition are deliberately selected independently by the user. */
export function repairPositionFromSources(item: IntelligenceItem, positionIndex: number, skuId: string, configurationId: string, sources: readonly IntelligenceSource[], expected?: { skuQuote: string; configurationQuote: string; description: string }): SourceRepair {
  if (item.destination !== "proposals") throw new Error("Составы доступны только для КП.");
  const inventory = extractSourcePositionFacts(sources.filter((source) => item.sourceIds.includes(source.id)));
  const sku = inventory.positions.find((entry) => entry.id === skuId), configuration = inventory.configurations.find((entry) => entry.id === configurationId);
  if (!sku || !configuration || sku.sourceId !== configuration.sourceId) throw new Error("Выберите артикул и состав из одного источника этой карточки.");
  if (expected && (sku.quote !== expected.skuQuote || configuration.quote !== expected.configurationQuote || configuration.description !== expected.description)) throw new Error("Выбранные артикул или состав изменились. Повторите сверку по текущему источнику.");
  ownsQuote(item, sku, sources); ownsQuote(item, configuration, sources);
  const oldNames = item.fields.lines, oldDescriptions = item.fields.lineDescriptions;
  if (oldNames !== undefined && (!Array.isArray(oldNames) || oldNames.some((entry) => typeof entry !== "string")) || oldDescriptions !== undefined && (!Array.isArray(oldDescriptions) || oldDescriptions.some((entry) => typeof entry !== "string"))) throw new Error("Сначала исправьте формат позиций. Старые данные не изменены.");
  const names = [...(oldNames || [])], descriptions = [...(oldDescriptions || [])];
  if (descriptions.length > names.length) throw new Error("Есть описания без позиций. Сначала восстановите их связь в редакторе позиций.");
  while (descriptions.length < names.length) descriptions.push("");
  const index = positionIndex === -1 ? names.length : positionIndex;
  if (!Number.isInteger(index) || index < 0 || index > names.length || index >= 100) throw new Error("Выберите существующую или новую позицию.");
  const hasSku = (name: string) => name.toLocaleUpperCase("en-US").split(/[^A-Z0-9_./-]+/u).includes(sku.sku.toLocaleUpperCase("en-US"));
  if (names.some((name, at) => at !== index && hasSku(name))) throw new Error("Этот артикул уже назначен другой позиции. Проверьте состав, не дублируйте комплектацию.");
  // Joining a detached model name and SKU would manufacture a nonliteral
  // title/quote. The exact SKU is a valid, individually verifiable short name.
  names[index] = sku.sku;
  // Keep the literal model heading as well as every component. A SKU-only
  // short title must not erase the equipment model from the resulting card.
  descriptions[index] = configuration.quote;
  const skuProof = { ...sku, quote: sku.sku }, descriptionProof = configuration;
  return finish(item, { ...item.fields, lines: names, lineDescriptions: descriptions }, ["lines", "lineDescriptions"], [...evidenceFor("lines", [skuProof]), ...evidenceFor("lineDescriptions", [descriptionProof])]);
}

export function sourceRepairCleanup(item: IntelligenceItem): { keys: string[]; patch: SourceRepair } {
  const fields = { ...item.fields };
  const keys = Object.keys(fields).filter((key) => {
    const value = fields[key], definition = fieldDefinitions[item.destination].find((field) => field.key === key);
    return typeof value === "string" && (/^(?:null|undefined|n\/a)$/iu.test(value.trim()) || Boolean(definition?.kind === "date" && intelligenceFieldError(definition, value)));
  });
  for (const key of keys) delete fields[key];
  return { keys, patch: { fields, selectedFields: item.selectedFields.filter((key) => !keys.includes(key)), evidence: (item.evidence || []).filter((claim) => !keys.includes(claim.field)) } };
}
