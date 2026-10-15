import type { IntelligenceDestination, IntelligenceFieldValue, IntelligenceFragment, IntelligenceItem, IntelligenceSource } from "./workbenchTypes";

export interface EvidenceExcerpt { sourceId: string; sourceName: string; fragmentId?: string; locator: string; quote: string; }
export type FieldEvidenceState = "confirmed" | "unverified" | "conflict" | "placeholder";
export interface FieldEvidenceStatus {
  itemId: string; field: string; status: FieldEvidenceState; message: string; evidence: EvidenceExcerpt[];
}
export interface EvidenceFinding {
  id: string; code: string; severity: "blocking" | "warning"; itemId: string; field?: string;
  message: string; evidence: EvidenceExcerpt[];
}
export interface CoverageCheck {
  id: string; category: "certificate" | "document" | "quantity" | "price" | "deadline-time" | "sku";
  status: "covered" | "missing" | "uncertain"; label: string; evidence: EvidenceExcerpt;
  itemIds: string[]; matchedItemIds: string[];
}
export interface IntelligenceEvidenceReport {
  fields: FieldEvidenceStatus[]; findings: EvidenceFinding[]; coverage: CoverageCheck[];
}

type Role = "supplier" | "customer" | "internal" | "unknown";
type SourceUnit = EvidenceExcerpt & { text: string; normalizedText: string; normalizedSourceName: string; numbers: string[]; source: IntelligenceSource; sheetState?: IntelligenceFragment["sheetState"]; index: number; fragmentKey: number; context: string; precedingContext: string; role: Role };
type UnitIndex = { tokens: Map<string, SourceUnit[]>; numbers: Map<string, SourceUnit[]>; phones: Map<string, SourceUnit[]>; sourceNames: Set<string>; limited: boolean };
type SourceFact = { category: CoverageCheck["category"]; label: string; unit: SourceUnit; anchors: string[]; numbers: string[]; token?: string; extra?: string[]; qualifiers?: string[]; uncertain?: boolean };
type DateOccurrence = { iso: string; event: string; time?: string; timezone?: string; unit: SourceUnit; quote: string };
const maxUnits = 5000;
const maxAuditCharacters = 2 * 1024 * 1024;
const maxUnitCharacters = 20000;
const maxCandidateUnits = 200;
const maxFacts = 256;
const maxCoverage = 256;
const maxFindings = 512;
const maxFieldChecks = 1000;
const maxDateOccurrences = 1000;
const placeholders = /^(?:(?:площадка|заказчик|поставщик|исполнитель|лицензии?|требования?|сведения|информация|срок|цена|нмц)\s*[:—-]?\s*)?(?:не\s+(?:указан[аоы]?|извест[а-я]*|определ[а-я]*|отраж[а-я]*|предоставлен[а-я]*)|нет\s+(?:сведений|информации|данных)|отсутству[а-я]*|неизвестно)(?:\s+[а-я\s]+)?[.!]?$/iu;
const genericPlaceholders = /^(?:заказчик|покупатель|поставщик|исполнитель|фио|ф\.?\s*и\.?\s*о\.?|краткое название|название компании|значение из источника|не применимо|n\/?a|null|undefined|[-_.\s…]+)$/iu;
const currency = /(?:руб(?:\.|лей|ля)?|₽|\bRUB\b)/iu;
const foreignCurrency = /(?:\b(?:USD|EUR|CNY|KZT|BYN|JPY|GBP|CHF)\b|[$€¥₸£]|доллар[а-я]*|евро|юан[а-я]*|тенге|белорус[а-я\s]+рубл[а-я]*)/iu;
const moneyContext = /(?:нмцк?|начальн[а-я\s]*(?:максимальн[а-я\s]*)?цен|максимальн[а-я\s]+(?:цен|стоимост)|итогов[а-я\s]+(?:цен|стоимост|сумм)|итого|всего|общая\s+(?:цена|стоимость|сумма)|(?:цена|стоимость|сумма)\s+(?:договора|контракта))/iu;
const nmcLabel = /(?:нмцк?(?![а-я])|начальн[а-я\s]*максимальн[а-я\s]*цен[а-я]*|(?:предельн|максимальн)[а-я\s]+(?:цен|стоимост)[а-я\s]+(?:закупк|договора|контракта|лота))/iu;
const shareLabel = /(?:наша\s+доля|стоимость\s+нашей\s+(?:доли|части)|(?:стоимость|объ[её]м)\s+(?:наших\s+работ|работ\s+нашей\s+(?:компании|организации)))/iu;
const unitPriceContext = /(?:цен[а-я]*\s+(?:за\s+)?(?:единиц|ед\.|шт)|за\s+од(?:ин|ну)|удельн|за единицу|единичн|unit\s+price)/iu;
const certificatePattern = /(?<![a-z0-9])(?:OSCP|OSEP|BSCP|OSWE|OSWP|KLCP|eJPT|eCPPT|CISSP|CISA|CISM|CEH|(?:CompTIA\s+)?PenTest\+?|HTB\s+CPTS)(?![a-z0-9])/giu;
const documentPattern = /(?:сертификат|лицензи|фстэк|фсб|тзки|егрюл|егрип|выписк[а-я\s]+из[а-я\s]+реестр|кнд\s*1120101|декларац|доверенност|полномочи|одобрени[а-я\s]+сделк|справк|заверен[а-я\s]+перевод|коммерческ[а-я\s]+предложен|подтверждающ[а-я\s]+документ|запрос\s+на\s+аккредитац|карточка\s+предприятия|проект\s+договора)/iu;
const obligationPattern = /(?:обязател|долж[а-я]*|необходим|требуе[а-я]*|предостав|представить|приложить|подтвердить|не менее|не более|не позднее|не ранее|гаранти|постоплат|предоплат|состав\s+заявки|документы\s+заявки|перечень\s+документов|[≥≤<>]=?)/iu;
const ignoredNumericContext = /(?:телефон|факс|инн\b|кпп\b|огрн|бик\b|расчетн[а-я\s]*счет|корреспондент|стат(?:ья|ьи|ей)|постановлен|федеральн[а-я\s]*закон)/iu;
const conditionalPatterns = [/при\s+наличии/iu, /(?:при|в\s+случае)\s+(?:необходимости|применимости)/iu, /если/iu, /за\s+исключением/iu, /(?:^|[^\p{L}])(?:либо|или)(?=$|[^\p{L}])/iu];
const significantStopWords = new Set(["требуется", "необходимо", "необходимы", "должен", "должна", "должны", "обязательно", "обязательный", "обязательные", "наличие", "предоставить", "представить", "документы", "документ", "заявки", "заявку", "заявка", "участник", "участника", "закупки", "закупка", "данные", "составе", "наличии", "который", "которых", "также", "всего", "рублей", "руб", "итого", "менее", "более", "дней", "года", "лет", "должно", "согласно"]);

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("ru").replace(/ё/g, "е").replace(/[«»„“”‘’]/g, '"').replace(/[‐‑–—]/g, "-").replace(/\s+/g, " ").trim();
}
function literalQuote(value: string): string { return value.replace(/\s+/gu, " ").trim(); }
function includedFragment(fragment: IntelligenceFragment): boolean {
  // For visible fragments false means default selection, not exclusion. The
  // extractor already returns only selected fragments; hidden history is opt-in.
  return fragment.sheetState !== "hidden" && fragment.sheetState !== "veryHidden" || fragment.includedByUser === true;
}
function fingerprint(value: unknown): string {
  const text = JSON.stringify(value); let hash = 2166136261, second = 5381;
  for (let index = 0; index < text.length; index++) { hash ^= text.charCodeAt(index); hash = Math.imul(hash, 16777619); second = Math.imul(second, 33) ^ text.charCodeAt(index); }
  return `${(hash >>> 0).toString(36)}-${(second >>> 0).toString(36)}`;
}
function excerpt(unit: SourceUnit, quote = unit.text): EvidenceExcerpt {
  return { sourceId: unit.sourceId, sourceName: unit.sourceName, fragmentId: unit.fragmentId, locator: unit.locator, quote };
}
function meaningful(value: IntelligenceFieldValue | undefined): boolean {
  return typeof value === "number" || typeof value === "boolean" || (typeof value === "string" && Boolean(value.trim())) || (Array.isArray(value) && value.some((entry) => entry.trim()));
}
function strings(value: IntelligenceFieldValue | undefined): string[] {
  return Array.isArray(value) ? value : value === undefined ? [] : [String(value)];
}
function emailTokens(value: string): string[] {
  // Bound malformed runs as well as successful matches: an unbounded local-part
  // regex retries every suffix of a long non-email token and becomes quadratic.
  return value.includes("@") ? value.match(/(?<![a-z0-9._%+-])[a-z0-9._%+-]{1,256}@[a-z0-9.-]{1,253}\.[a-z]{2,63}(?![a-z0-9.-])/giu) || [] : [];
}
function digits(value: string): string { return value.replace(/\D/g, ""); }
function numberTokens(value: string): string[] {
  const matches = value.match(/\d+(?:[\s\u00a0\u202f]\d{3})*(?:[.,]\d+)?/gu) || [];
  return matches.map((entry) => entry.replace(/[\s\u00a0\u202f]/g, "").replace(",", ".")).filter((entry) => Number.isFinite(Number(entry)));
}
function sameNumber(left: string, right: string): boolean { return Number(left) === Number(right); }
function hasNumber(text: string, value: number): boolean { return numberTokens(text).some((entry) => Number(entry) === value); }
function words(value: string): string[] {
  return [...new Set((normalize(value).match(/[\p{L}][\p{L}\d+_-]{2,}/gu) || []).filter((word) => !significantStopWords.has(word)))];
}
function stem(word: string): string { return /^[а-я]+$/u.test(word) && word.length > 6 ? word.slice(0, -2) : word; }
function includesPhrase(text: string, value: string): boolean {
  const body = normalize(text), candidate = normalize(value);
  if (!candidate) return false;
  const emails = emailTokens(candidate);
  if (emails?.length) return emails.every((email) => body.includes(email));
  if (/^\+?[\d\s()-.]{9,}$/u.test(candidate)) {
    const expected = digits(candidate); return (text.match(/\+?\d[\d\s()-.]{7,}\d/gu) || []).some((phone) => digits(phone) === expected);
  }
  return candidate.length >= 3 && body.includes(candidate);
}
function lineRole(text: string): Role {
  if (/(?:наш|внутренн[а-я]*)\s+(?:ответственн|координатор|менеджер)|ответственн[а-я\s]+(?:за\s+)?нашу\s+заявк/iu.test(text)) return "internal";
  if (/(?:^|[;\t])\s*(?:поставщик|исполнитель|продавец|отправитель)\s*[:—-]|(?:реквизиты|контакт|адрес)\s+(?:поставщика|исполнителя)/iu.test(text)) return "supplier";
  if (/(?:^|[;\t])\s*(?:заказчик|покупатель|получатель|адресат|организатор)\s*[:—-]|(?:для\s+нужд|реквизиты|контакт|адрес)\s+(?:заказчика|покупателя|организатора)/iu.test(text)) return "customer";
  return "unknown";
}
function createUnits(sources: readonly IntelligenceSource[]): { units: SourceUnit[]; limited: boolean } {
  const units: SourceUnit[] = []; let limited = false, characters = 0, fragmentKey = 0;
  for (const source of sources) {
    const normalizedSourceName = normalize(source.name);
    // An explicit fragments array is authoritative: discarded sheets/pages must
    // never re-enter evidence through the source's aggregate text.
    const fragments = source.fragments === undefined ? [{ text: source.text, locator: "Текст источника" }] : source.fragments;
    for (const fragment of fragments) {
      if (!includedFragment(fragment)) continue;
      fragmentKey++;
      const rows = fragment.text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
      let role: Role = "unknown";
      for (let index = 0; index < rows.length; index++) {
        if (units.length >= maxUnits || characters + rows[index].length > maxAuditCharacters) { limited = true; break; }
        const text = rows[index].slice(0, maxUnitCharacters); if (text.length !== rows[index].length) limited = true;
        for (const clause of text.split(/[;\t]/u)) { const explicit = lineRole(clause); if (explicit !== "unknown") role = explicit; }
        const context = rows.slice(Math.max(0, index - 1), Math.min(rows.length, index + 2)).map((line) => line.slice(0, maxUnitCharacters)).join("\n");
        const precedingContext = rows.slice(Math.max(0, index - 2), index).map((line) => line.slice(0, maxUnitCharacters)).join("\n");
        characters += text.length;
        units.push({ sourceId: source.id, sourceName: source.name, fragmentId: fragment.id, locator: fragment.locator, quote: text, text, normalizedText: normalize(text), normalizedSourceName, numbers: numberTokens(text), source, sheetState: fragment.sheetState, index: units.length, fragmentKey, context, precedingContext, role });
        if (limited) break;
      }
      if (limited) break;
    }
    if (limited) break;
  }
  return { units, limited };
}
function buildIndex(units: SourceUnit[]): UnitIndex {
  const index: UnitIndex = { tokens: new Map(), numbers: new Map(), phones: new Map(), sourceNames: new Set(), limited: false };
  const add = (map: Map<string, SourceUnit[]>, token: string, unit: SourceUnit) => { const values = map.get(token) || []; values.push(unit); map.set(token, values); };
  for (const unit of units) {
    index.sourceNames.add(unit.normalizedSourceName);
    for (const token of new Set([...(unit.normalizedText.match(/[\p{L}\d+_-]{3,}/gu) || []), ...emailTokens(unit.normalizedText)])) add(index.tokens, token, unit);
    for (const token of new Set(unit.numbers.map((value) => String(Number(value))))) add(index.numbers, token, unit);
    for (const phone of new Set((unit.text.match(/\+?\d[\d\s()-.]{7,}\d/gu) || []).map(digits))) add(index.phones, phone, unit);
  }
  return index;
}
function candidatesFor(value: string | number, index: UnitIndex): SourceUnit[] {
  let candidates: SourceUnit[] = [];
  if (typeof value === "number") candidates = index.numbers.get(String(value)) || [];
  else if (/^\+?[\d\s()-.]{9,}$/u.test(value.trim())) candidates = index.phones.get(digits(value)) || [];
  else {
    const normalized = normalize(value);
    const tokens = [...(normalized.match(/[\p{L}\d+_-]{3,}/gu) || []), ...emailTokens(normalized)];
    const options = tokens.map((token) => index.tokens.get(token) || index.numbers.get(token) || []).sort((a, b) => a.length - b.length);
    candidates = options[0] || [];
  }
  if (candidates.length > maxCandidateUnits) index.limited = true;
  return candidates.slice(0, maxCandidateUnits);
}
function matchesUnit(unit: SourceUnit, value: string, normalizedValue = normalize(value)): boolean {
  if (/^[\d\s()+.-]{9,}$/u.test(value) || /@/u.test(value)) return includesPhrase(unit.text, value);
  return normalizedValue.length >= 3 && unit.normalizedText.includes(normalizedValue);
}
function createFinding(item: IntelligenceItem, code: string, severity: EvidenceFinding["severity"], message: string, evidence: EvidenceExcerpt[], field?: string, itemFingerprint?: string): EvidenceFinding {
  return { id: `evidence-${fingerprint({ itemId: item.id, code, field, context: itemFingerprint || { value: field ? item.fields[field] : item.fields, title: item.title, selection: item.selectedFields, sourceIds: item.sourceIds }, evidence })}`, code, severity, itemId: item.id, field, message, evidence };
}
function isCritical(destination: IntelligenceDestination, field: string): boolean {
  if (/^(?:name|fullName|customer|performingLegalEntity|responsible|platform|inn|kpp|ogrn|address|amount|nmc|ourShareAmount|number|birthDate|.*Date|.*Deadline|availableFrom|availableTo|validUntil)$/u.test(field)) return true;
  if (destination === "proposals" && /^(?:issuer|recipient|addressee|contact|lines|lineDescriptions|paymentTerms|deliveryTerms)/u.test(field)) return true;
  return /^(?:contact|decisionMaker|certificates|education|licenses|requirements)/u.test(field);
}
function expectedRole(destination: IntelligenceDestination, field: string): Role {
  if (field === "responsible") return "internal";
  if (destination === "proposals") {
    if (/^(?:issuerName|contactName|contactPhone|contactEmail)$/u.test(field)) return "supplier";
    if (/^(?:recipient|addressee)/u.test(field)) return "customer";
  }
  if (field === "performingLegalEntity") return "supplier";
  if (field === "customer") return "customer";
  return "unknown";
}
function inlineValueRole(unit: SourceUnit, value: string): Role | undefined {
  const clauses = unit.text.split(/[;\t]/u);
  if (clauses.length < 2 || new Set(clauses.map(lineRole).filter((role) => role !== "unknown")).size < 2) return undefined;
  let carried: Role = "unknown"; const matching: Role[] = [];
  for (const clause of clauses) {
    const explicit = lineRole(clause); if (explicit !== "unknown") carried = explicit;
    if (includesPhrase(clause, value)) matching.push(carried);
  }
  return matching.length && matching.every((role) => role === matching[0]) ? matching[0] : "unknown";
}
function entityRole(unit: SourceUnit, value?: string): Role {
  const inline = value === undefined ? undefined : inlineValueRole(unit, value);
  if (inline !== undefined) return inline;
  if (lineRole(unit.text) !== "unknown") return lineRole(unit.text);
  // A later buyer heading must not retroactively claim a phone/address inside
  // the explicitly labeled supplier block immediately before it.
  // Names supplied by the model are not independent proof of nearby contacts'
  // roles. Without a source label, keep the role unknown for human review.
  return unit.role;
}

const dateEvents: Array<[string, RegExp]> = [
  ["submission-start", /(?:начал[а-я\s]+(?:подач|при[её]м)|(?:подач|при[её]м)[а-я\s]+(?:начина|с\s*$))/giu],
  ["submission-end", /(?:окончани[а-я\s]+(?:подач|при[её]м)|(?:срок|дата)[а-я\s]+(?:подач|при[её]м)|при[её]м\s+(?:предложений|заявок)\s+до|(?:подать|представить)\s+заявк[а-я\s]+до)/giu],
  ["question-deadline", /(?:срок|дата|окончани)[а-я\s]+(?:вопрос|разъяснен)/giu],
  ["publication", /(?:дата\s+публикации|опубликован[а-я]*|дата\s+размещения\s+извещения)/giu],
  ["revision", /(?:дата\s+редакции|редакция|обновлен[а-я]*|дата\s+расч[её]та)/giu],
  ["consideration", /(?:рассмотрени[а-я\s]+заявок|дата\s+рассмотрения)/giu],
  ["results", /(?:подведени[а-я\s]+итогов|итоги\s+закупки)/giu],
  ["execution-start", /(?:начал[а-я\s]+(?:работ|исполнени|поставк)|(?:поставка|выполнение\s+работ)[а-я\s:,-]*(?:не\s+ранее|начало))/giu],
  ["execution-end", /(?:окончани[а-я\s]+(?:работ|исполнени|поставк)|(?:поставка|выполнение\s+работ)[а-я\s:,-]*(?:не\s+позднее|до\s*$))/giu],
  ["contract-date", /(?:дата\s+договора|договор\s*(?:№[^\n]{0,40})?\s+от)/giu],
  ["proposal-date", /(?:дата\s+кп|коммерческое\s+предложение\s+от)/giu],
  ["valid-until", /(?:действует\s+до|срок\s+действия\s+до|действительно\s+до)/giu],
];
const expectedDateEvents: Record<string, string[]> = {
  publishedDate: ["publication"], questionDeadline: ["question-deadline"], submissionDeadline: ["submission-end"],
  executionStartDate: ["execution-start"], executionEndDate: ["execution-end"], startDate: ["execution-start"], endDate: ["execution-end"],
  date: ["contract-date"], documentDate: ["proposal-date"], validUntil: ["valid-until"],
};
function detectDateEvent(before: string, after: string, context: string): string {
  if (/поставк|выполнени[а-я\s]+работ/iu.test(context)) {
    if (/не\s+ранее\s*$/iu.test(before)) return "execution-start";
    if (/не\s+позднее\s*$/iu.test(before)) return "execution-end";
  }
  let last = -1; let event = "other";
  for (const [name, pattern] of dateEvents) {
    pattern.lastIndex = 0;
    for (const match of before.matchAll(pattern)) { if ((match.index ?? -1) >= last) { last = match.index ?? -1; event = name; } }
  }
  if (event !== "other") return event;
  let first = Infinity;
  for (const [name, pattern] of dateEvents) {
    pattern.lastIndex = 0;
    for (const match of after.matchAll(pattern)) if ((match.index ?? Infinity) < first) { first = match.index ?? Infinity; event = name; }
  }
  if (event !== "other") return event;
  if (/поставк|выполнени[а-я\s]+работ/iu.test(context)) {
    if (/не\s+ранее\s*$/iu.test(before)) return "execution-start";
    if (/не\s+позднее\s*$/iu.test(before)) return "execution-end";
  }
  return "other";
}
function dateOccurrences(units: SourceUnit[]): { dates: DateOccurrence[]; limited: boolean } {
  const occurrences: DateOccurrence[] = [];
  for (const unit of units) {
    const regex = /\b(?:(\d{4})-(\d{2})-(\d{2})|(\d{2})[./](\d{2})[./](\d{4}))(?:[ T,]+(\d{1,2}:\d{2}(?::\d{2})?))?(?:\s*\(?\s*(МСК|MSK|UTC(?:[+-]\d{1,2}(?::\d{2})?)?|GMT(?:[+-]\d{1,2})?|[+-]\d{2}:\d{2})\)?)?/giu;
    const matches = unit.text.matchAll(regex); let previousEnd = 0, current = matches.next();
    while (!current.done) {
      if (occurrences.length >= maxDateOccurrences) return { dates: occurrences, limited: true };
      const match = current.value, next = matches.next();
      const start = match.index ?? 0;
      const iso = match[1] ? `${match[1]}-${match[2]}-${match[3]}` : `${match[6]}-${match[5]}-${match[4]}`;
      const end = start + match[0].length;
      const beforeRaw = unit.text.slice(Math.max(previousEnd, start - 150), start), afterRaw = unit.text.slice(end, Math.min(next.done ? unit.text.length : next.value.index ?? unit.text.length, end + 100));
      const beforeClauses = beforeRaw.split(/;/u), before = beforeClauses[beforeClauses.length - 1] || "", after = afterRaw.split(/[;\t]/u)[0];
      const date = new Date(`${iso}T00:00:00Z`), parts = match[7]?.split(":").map(Number);
      const valid = Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === iso && (!parts || parts[0] <= 23 && parts[1] <= 59 && (parts[2] === undefined || parts[2] <= 59));
      let event = valid ? detectDateEvent(before, after, unit.context) : "other";
      // PDF text often wraps a label across two rows before its scalar value.
      // Never inherit across a locator or another dated row: unresolved layouts
      // remain unverified instead of borrowing a nearby event from another field.
      if (valid && event === "other" && !before.trim()) {
        const preceding: string[] = [];
        for (let index = unit.index - 1; index >= Math.max(0, unit.index - 3); index--) {
          const previous = units[index];
          if (previous.fragmentKey !== unit.fragmentKey || /\d{2}[./]\d{2}[./]\d{4}|\d{4}-\d{2}-\d{2}/u.test(previous.text)) break;
          preceding.unshift(previous.text);
        }
        event = detectDateEvent(preceding.join(" "), "", unit.context);
      }
      occurrences.push({ iso, event, time: match[7], timezone: match[8], unit, quote: unit.text.slice(Math.max(0, start - 100), Math.min(unit.text.length, start + match[0].length + 100)) });
      previousEnd = end; current = next;
    }
  }
  return { dates: occurrences, limited: false };
}
function roleMessage(role: Role): string { return role === "supplier" ? "поставщика / исполнителя" : role === "customer" ? "заказчика / организатора" : "внутреннего ответственного"; }

function overallAmounts(unit: SourceUnit): string[] {
  const text = unit.text;
  if (foreignCurrency.test(text) || /^[\d\s.,₽]+$/u.test(text) && foreignCurrency.test(unit.precedingContext) || unitPriceContext.test(text) || /(?:нмц|цен[а-я]*|стоимост[а-я]*)[^;\n]{0,30}не\s+(?:указан|определен|извест)/iu.test(text)) return [];
  if (!moneyContext.test(text)) return unit.numbers.length === 1 && /^[\d\s.,₽]+$/u.test(text) && moneyContext.test(unit.context) && (currency.test(unit.context) || /нмц/iu.test(unit.context)) ? unit.numbers : [];
  const matches = [...text.matchAll(/\d+(?:[ \u00a0\u202f]\d{3})*(?:[.,]\d+)?\s*(?:руб(?:\.|лей|ля)?|₽|\bRUB\b)/giu)];
  if (matches.length) {
    // An amount after VAT or another unlabeled component does not inherit the
    // earlier "total" label. Repeated totals each need their own explicit label.
    return matches.flatMap((match, index) => moneyContext.test(text.slice(index ? (matches[index - 1].index || 0) + matches[index - 1][0].length : 0, match.index)) ? numberTokens(match[0]) : []);
  }
  return unit.numbers.length === 1 && /нмц|начальн[а-я\s]*(?:максимальн[а-я\s]*)?цен/iu.test(text) ? unit.numbers : [];
}
function labeledAmounts(unit: SourceUnit, label: RegExp, allowScalarContext = false): string[] {
  const text = unit.text.replace(/[()]/gu, " ");
  const missing = /не\s+(?:указан[аоы]?|определ[её]н[аоы]?|извест[а-я]*)/iu;
  if (foreignCurrency.test(text) || unitPriceContext.test(text) || label.test(text) && missing.test(text)) return [];
  const matches = [...text.matchAll(/\d+(?:[ \u00a0\u202f]\d{3})*(?:[.,]\d+)?\s*(?:руб(?:\.|лей|ля)?|₽|\bRUB\b)/giu)];
  const amounts = matches.flatMap((match, index) => {
    const prefix = text.slice(index ? (matches[index - 1].index || 0) + matches[index - 1][0].length : 0, match.index).split(/[;\t]/u).pop() || "";
    const marker = label.exec(prefix);
    // A percentage/other amount between the label and this amount makes its
    // relation ambiguous ("our share 20% of a 100000-ruble total" is not 100000).
    return marker && !/\d/u.test(prefix.slice((marker.index || 0) + marker[0].length)) ? numberTokens(match[0]) : [];
  });
  if (amounts.length) return amounts;
  if (matches.length && !/^[\d\s.,]+(?:руб(?:\.|лей|ля)?|₽|RUB)\s*$/iu.test(text)) return [];
  if (!matches.length && unit.numbers.length === 1 && label.test(text)) return unit.numbers;
  const preceding = unit.precedingContext.replace(/[()]/gu, " ");
  return allowScalarContext && unit.numbers.length === 1 && /^[\d\s.,₽]+(?:руб(?:\.|лей|ля)?|RUB)?\s*$/iu.test(text)
    && label.test(preceding) && !unitPriceContext.test(preceding) && !missing.test(preceding) && !foreignCurrency.test(preceding)
    && !/(?:инн|кпп|огрн|ндс|кол-во|количество|телефон)/iu.test(preceding) ? unit.numbers : [];
}
function explicitLegalNames(units: SourceUnit[]): Array<{ kind: "full" | "short"; value: string; unit: SourceUnit }> {
  const names: Array<{ kind: "full" | "short"; value: string; unit: SourceUnit }> = [];
  for (const unit of units) for (const match of unit.text.matchAll(/(?:^|[;\t])\s*(полное|краткое|сокращ[её]нное)\s+(?:(?:юридическое|фирменное|официальное)\s+)?(?:наименование|название)(?:\s+(?:юридического\s+лица|организации|компании))?\s*[:—-]\s*([^;\t\n]+)/giu)) {
    names.push({ kind: /^полное$/iu.test(match[1]) ? "full" : "short", value: normalize(match[2]).replace(/[.,]\s*$/u, ""), unit });
  }
  return names;
}

function fieldStatus(item: IntelligenceItem, field: string, value: IntelligenceFieldValue, units: SourceUnit[], dates: DateOccurrence[], index: UnitIndex): FieldEvidenceStatus {
  const values = strings(value), normalizedValues = values.map(normalize); const selectedRole = expectedRole(item.destination, field);
  if (values.some((entry) => placeholders.test(normalize(entry)) || genericPlaceholders.test(normalize(entry)))) return { itemId: item.id, field, status: "placeholder", message: "Это заглушка отсутствующих сведений, а не подтверждённый факт. Укажите фактическое значение или исключите поле.", evidence: [] };
  if ((field === "name" || field === "title") && normalizedValues.some((entry) => index.sourceNames.has(entry))) return { itemId: item.id, field, status: "placeholder", message: "Имя файла не подтверждает название закупки или карточки. Укажите название по содержанию.", evidence: [] };
  const candidateUnits = [...new Set(values.flatMap((entry) => candidatesFor(typeof value === "number" ? value : entry, index)))];
  if (candidateUnits.length > maxCandidateUnits) index.limited = true;
  const matches = candidateUnits.slice(0, maxCandidateUnits).filter((unit) => values.some((entry, position) => typeof value === "number" ? unit.numbers.some((number) => Number(number) === value) : matchesUnit(unit, entry, normalizedValues[position])));
  if (item.destination === "counterparties" && field === "name") {
    const names = explicitLegalNames(units), full = names.filter((entry) => entry.kind === "full"), correct = full.filter((entry) => normalizedValues.includes(entry.value));
    if (correct.length) return { itemId: item.id, field, status: "confirmed", message: "Название совпадает с явно указанным полным наименованием в источнике.", evidence: correct.slice(0, 3).map((entry) => excerpt(entry.unit)) };
    const abbreviated = names.filter((entry) => entry.kind === "short" && normalizedValues.includes(entry.value));
    if (full.length && abbreviated.length) return { itemId: item.id, field, status: "conflict", message: "Выбрано явно указанное краткое наименование вместо полного. Проверьте полное юридическое наименование компании.", evidence: [...full, ...abbreviated].slice(0, 3).map((entry) => excerpt(entry.unit)) };
    if (full.length) return { itemId: item.id, field, status: "unverified", message: "Источник явно указывает полное наименование, но значение поля с ним не совпадает. Не заменяйте его сокращением или частью названия.", evidence: full.slice(0, 3).map((entry) => excerpt(entry.unit)) };
  }
  if (field === "responsible") {
    const internal = matches.filter((unit) => values.some((entry) => (inlineValueRole(unit, entry) ?? lineRole(unit.text)) === "internal"));
    if (internal.length) return { itemId: item.id, field, status: "confirmed", message: "В источнике явно указан внутренний ответственный; наличие текста не подтверждает его назначение в вашей базе.", evidence: internal.slice(0, 3).map((unit) => excerpt(unit)) };
    return { itemId: item.id, field, status: matches.length ? "conflict" : "unverified", message: "Контакт заказчика или поставщика не становится вашим ответственным за заявку. Подтвердите внутреннее назначение отдельно.", evidence: matches.slice(0, 3).map((unit) => excerpt(unit)) };
  }
  if (field === "platform") {
    if (/^(?:еис|единая информационная система|zakupki\.gov\.ru)$/iu.test(normalize(String(value)))) return { itemId: item.id, field, status: "conflict", message: "Номер или публикация в ЕИС не подтверждают название электронной торговой площадки.", evidence: matches.slice(0, 3).map((unit) => excerpt(unit)) };
    const platforms = matches.filter((unit) => /(?:площадк|оператор\s+электронн|https?:\/\/|bidzaar|roseltorg|sberbank-ast|rts-tender)/iu.test(unit.context));
    return { itemId: item.id, field, status: platforms.length ? "confirmed" : "unverified", message: platforms.length ? "Название площадки найдено в контексте площадки или её адреса." : "Выбранные источники не подтверждают название торговой площадки.", evidence: platforms.slice(0, 3).map((unit) => excerpt(unit)) };
  }
  if (field === "nmc" || field === "amount" || field === "ourShareAmount") {
    const contextual = matches.filter((unit) => (field === "nmc" ? labeledAmounts(unit, nmcLabel, true) : field === "ourShareAmount" ? labeledAmounts(unit, shareLabel) : overallAmounts(unit)).some((amount) => typeof value === "number" && sameNumber(amount, String(value))));
    if (contextual.length && (typeof value !== "number" || value !== 0 || /(?:нмц|начальн[а-я\s]+цен)[^\n]{0,60}\b0(?:[.,]00)?\b/iu.test(contextual[0].text))) return { itemId: item.id, field, status: "confirmed", message: "Число найдено в контексте общей цены. Проверьте валюту и то, что это итог, а не цена единицы.", evidence: contextual.slice(0, 3).map((unit) => excerpt(unit)) };
    return { itemId: item.id, field, status: matches.length ? "conflict" : "unverified", message: field === "ourShareAmount" ? "Общая цена договора не подтверждает нашу долю. Нужна явно указанная стоимость нашей доли / наших работ; процент нельзя подменять общей суммой." : "Цена не подтверждена как итог соответствующего договора / закупки. Цена строки, рыночная котировка или ноль в шаблоне не устанавливают НМЦ; для НМЦ требуется её явное обозначение.", evidence: matches.slice(0, 3).map((unit) => excerpt(unit)) };
  }
  if (expectedDateEvents[field] && typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    const sameDates = dates.filter((entry) => entry.iso === value);
    const correct = sameDates.filter((entry) => expectedDateEvents[field].includes(entry.event));
    return { itemId: item.id, field, status: correct.length ? "confirmed" : sameDates.length ? "conflict" : "unverified", message: correct.length ? "Дата найдена рядом с обозначением соответствующего события." : sameDates.length ? "Такая дата есть в источнике, но относится к другому событию или событие не подтверждено. Не подменяйте подачу поставкой, публикацию редакцией или работы подведением итогов." : "В выбранных источниках нет явной даты этого события. Относительная длительность не является календарной датой.", evidence: (correct.length ? correct : sameDates).slice(0, 3).map((entry) => excerpt(entry.unit, entry.quote)) };
  }
  if (selectedRole !== "unknown") {
    const role = (unit: SourceUnit) => entityRole(unit, values.find((entry) => matchesUnit(unit, entry)));
    const correct = matches.filter((unit) => role(unit) === selectedRole);
    const opposite = matches.filter((unit) => role(unit) !== "unknown" && role(unit) !== selectedRole);
    if (opposite.length && !correct.length) return { itemId: item.id, field, status: "conflict", message: `Сведения находятся в контексте другой стороны: ${roleMessage(role(opposite[0]))}. Не переносите их в поля ${roleMessage(selectedRole)}.`, evidence: opposite.slice(0, 3).map((unit) => excerpt(unit)) };
    return { itemId: item.id, field, status: correct.length ? "confirmed" : "unverified", message: correct.length ? `Значение и принадлежность к стороне ${roleMessage(selectedRole)} подтверждены текстовым контекстом.` : `Наличие значения не подтверждает принадлежность к стороне ${roleMessage(selectedRole)}. Проверьте роль компании и её контактов.`, evidence: (correct.length ? correct : matches).slice(0, 3).map((unit) => excerpt(unit)) };
  }
  const allMatched = values.every((entry, position) => matches.some((unit) => typeof value === "number" ? unit.numbers.some((number) => Number(number) === value) : matchesUnit(unit, entry, normalizedValues[position])));
  return { itemId: item.id, field, status: allMatched ? "confirmed" : "unverified", message: allMatched ? "Значение найдено в выбранном тексте; это проверка наличия, не заключение о полноте или юридической достоверности." : "Дословное подтверждение в выбранных источниках не найдено. Краткое изложение может отличаться от исходника — проверьте его вручную.", evidence: matches.slice(0, 3).map((unit) => excerpt(unit)) };
}

function requirementQualifiers(text: string): string[] {
  const qualifiers = conditionalPatterns.flatMap((pattern, index) => pattern.test(text) ? [`conditional:${index}`] : []);
  for (const match of normalize(text).matchAll(/(не\s+менее|как\s+минимум|минимум|не\s+более|максимум|не\s+ранее|не\s+позднее|более|менее|>=|<=|≥|≤|>|<)\s*(\d+(?:[.,]\d+)?)/gu)) {
    const label = /^(?:не менее|как минимум|минимум|>=|≥)$/u.test(match[1]) ? "min" : /^(?:не более|максимум|<=|≤)$/u.test(match[1]) ? "max" : /^(?:более|>)$/u.test(match[1]) ? "greater" : /^(?:менее|<)$/u.test(match[1]) ? "less" : match[1];
    qualifiers.push(`${label}:${Number(match[2].replace(",", "."))}`);
  }
  return qualifiers;
}
function certificateSegment(text: string, matches: RegExpMatchArray[], index: number): { text: string; count?: string; uncertain: boolean } {
  const match = matches[index], start = match.index || 0, end = start + match[0].length;
  const leftDelimiter = Math.max(text.lastIndexOf(";", start), text.lastIndexOf("\t", start));
  const rightDelimiters = [text.indexOf(";", end), text.indexOf("\t", end)].filter((position) => position >= 0);
  const left = Math.max(leftDelimiter + 1, index ? (matches[index - 1].index || 0) + matches[index - 1][0].length : 0);
  const right = Math.min(rightDelimiters.length ? Math.min(...rightDelimiters) : text.length, matches[index + 1]?.index ?? text.length);
  const before = text.slice(left, start); let after = text.slice(end, right);
  const prefixPattern = /(?:(?:не\s+менее|не\s+более|минимум|максимум|от|[≥≤<>]=?)\s*)?(\d+)\s*(?:специалист[а-я]*|сотрудник[а-я]*|человек|шт\.?)\s*(?:с\s*(?:сертификат[а-я]*\s*)?)?$/giu;
  if (matches[index + 1] && matches[index + 1].index === right) {
    const nextCount = prefixPattern.exec(after);
    if (nextCount && /[,]\s*$/u.test(after.slice(0, nextCount.index))) after = after.slice(0, nextCount.index);
  }
  const suffix = /^\s*[(:—-]?\s*(?:(?:не\s+менее|не\s+более|минимум|максимум|от|[≥≤<>]=?)\s*)?(\d+)\s*(?:специалист|сотрудник|человек|шт\.?)/iu.exec(after);
  prefixPattern.lastIndex = 0; const prefixes = [...before.matchAll(prefixPattern)];
  const prefix = prefixes[prefixes.length - 1], count = suffix?.[1] || prefix?.[1];
  const own = count ? suffix ? `${match[0]}${after}` : `${prefix?.[0] || ""}${match[0]}${after}` : `${before}${match[0]}${after}`;
  const clauseEnd = rightDelimiters.length ? Math.min(...rightDelimiters) : text.length;
  return { text: own, count, uncertain: !count && /\d+\s*(?:специалист|сотрудник|человек|шт\.?)/iu.test(text.slice(leftDelimiter + 1, clauseEnd)) };
}
function requirementFacts(units: SourceUnit[]): { facts: SourceFact[]; limited: boolean } {
  const facts: SourceFact[] = []; let limited = false, quantityTableSource = "";
  for (const unit of units) {
    if (facts.length >= maxFacts) { limited = true; break; }
    // DOCX tables can express mandatory quantities without repeating "required"
    // in every row. Preserve the last numeric quantity only after an explicit
    // equipment/quantity header; never infer it from arbitrary prose or prices.
    const tableRow = /^table-row-\d+$/u.test(unit.fragmentId || "");
    if (!tableRow || quantityTableSource !== unit.sourceId) quantityTableSource = "";
    if (tableRow && /наименовани/iu.test(unit.text) && /кол(?:ичество|-во)/iu.test(unit.text)) quantityTableSource = unit.sourceId;
    const columns = unit.text.split("\t").map((column) => column.trim());
    const tableQuantity = quantityTableSource === unit.sourceId && columns.length >= 3 && /^\d+(?:[.,]\d+)?$/u.test(columns[columns.length - 1]) && /[\p{L}]/u.test(columns.slice(1, -1).join(" "));
    certificatePattern.lastIndex = 0;
    const certificates: RegExpMatchArray[] = [];
    for (const match of unit.text.matchAll(certificatePattern)) { if (certificates.length >= maxFacts) { limited = true; break; } certificates.push(match); }
    for (let index = 0; index < certificates.length; index++) {
      if (facts.length >= maxFacts) { limited = true; break; }
      const certificate = certificates[index][0], segment = certificateSegment(unit.text, certificates, index);
      facts.push({ category: "certificate", label: segment.text, unit, anchors: [normalize(certificate)], numbers: segment.count ? [segment.count] : [], token: certificate, qualifiers: requirementQualifiers(segment.text), uncertain: segment.uncertain });
    }
    const required = obligationPattern.test(unit.text) || /(?:документы\s+заявки|состав\s+заявки|перечень\s+документов)/iu.test(unit.context) || /^\d{1,3}[.)]\s+/u.test(unit.text) && documentPattern.test(unit.text);
    if (required && documentPattern.test(unit.text) && !certificates.length && !placeholders.test(normalize(unit.text))) {
      const activity = /(?:подпункт(?:ами|ы|ов|ах)?|пункт(?:ами|ы|ов|ах)?|пп\.?|вид(?:ы|ов)\s+работ)\s*[:—-]?\s*([^.;\n]{1,100})/iu.exec(unit.text);
      const letters = activity ? [...activity[1].matchAll(/(?:^|[\s,\/«"'(])([а-я])(?=[\s,\/»"')]|$)/giu)].map((match) => match[1]).filter((letter) => !/^и$/iu.test(letter)) : [];
      facts.push({ category: "document", label: unit.text, unit, anchors: words(unit.text).slice(0, 14), numbers: numberTokens(unit.text), extra: /фстэк|тзки/iu.test(unit.text) ? [...new Set(letters)] : [], qualifiers: requirementQualifiers(unit.text) });
    }
    if ((obligationPattern.test(unit.text) || tableQuantity) && /\d/u.test(unit.text) && !ignoredNumericContext.test(unit.text) && !certificates.length && !documentPattern.test(unit.text) && !moneyContext.test(unit.text) && !/\b\d{2}[./]\d{2}[./]\d{4}|\b\d{4}-\d{2}-\d{2}/u.test(unit.text)) facts.push({ category: "quantity", label: unit.text, unit, anchors: words(unit.text).slice(0, 14), numbers: tableQuantity ? [columns[columns.length - 1].replace(",", ".")] : numberTokens(unit.text), qualifiers: requirementQualifiers(unit.text) });
    // An arbitrary supplier's "total" must not become a mandatory tender NMC.
    for (const amount of labeledAmounts(unit, nmcLabel, true).filter((entry) => Number(entry) > 0)) { if (facts.length >= maxFacts) { limited = true; break; } facts.push({ category: "price", label: `Явная общая цена: ${amount}`, unit, anchors: [], numbers: [amount] }); }
  }
  const seen = new Set<string>();
  return { facts: facts.slice(0, maxFacts).filter((fact) => { const key = `${fact.category}:${fact.unit.sourceId}:${normalize(fact.label)}:${fact.token || ""}`; if (seen.has(key)) return false; seen.add(key); return true; }), limited: limited || facts.length > maxFacts };
}
function outputEntries(item: IntelligenceItem, fields: string[]): string[] {
  return fields.filter((field) => item.selectedFields.includes(field)).flatMap((field) => strings(item.fields[field]));
}
function coversFact(text: string, fact: SourceFact): boolean {
  if (fact.uncertain) return false;
  if (fact.category === "certificate") {
    certificatePattern.lastIndex = 0; const certificates = [...text.matchAll(certificatePattern)];
    return certificates.some((match, index) => {
      if (normalize(match[0]) !== normalize(fact.token || "")) return false;
      const segment = certificateSegment(text, certificates, index), qualifiers = requirementQualifiers(segment.text);
      return (fact.qualifiers || []).every((entry) => qualifiers.includes(entry)) && fact.numbers.every((number) => sameNumber(segment.count || "NaN", number));
    });
  }
  const qualifiers = requirementQualifiers(text);
  if (!(fact.qualifiers || []).every((entry) => qualifiers.includes(entry))) return false;
  const tokens = words(text).map(stem), anchors = fact.anchors.map(stem);
  const lexical = anchors.length > 0 && anchors.filter((anchor) => tokens.some((token) => token === anchor || (anchor.length >= 5 && token.startsWith(anchor)))).length >= Math.max(1, Math.ceil(anchors.length * .6));
  const letterActivities = (fact.extra || []).every((letter) => new RegExp(`(?:^|[\\s,/«"'(])${letter}(?=[\\s,/»"')]|$)`, "iu").test(text));
  return lexical && letterActivities && fact.numbers.every((number) => numberTokens(text).some((value) => sameNumber(value, number))) && conditionalPatterns.every((pattern) => !pattern.test(fact.unit.text) || pattern.test(text));
}
function targetItems(items: readonly IntelligenceItem[], destination: IntelligenceDestination, sourceId: string): IntelligenceItem[] {
  const candidates = items.filter((item) => item.destination === destination);
  const citing = candidates.filter((item) => item.sourceIds.includes(sourceId));
  // A model cannot hide an omitted selected workbook simply by omitting its ID.
  return citing.length ? citing : candidates;
}
function skuTokens(text: string): string[] {
  const values = text.match(/\b[A-Z0-9]{5,}(?:[_-][A-Z0-9]{3,})+\b/gu) || [];
  const labeled = [...text.matchAll(/(?:артикул|sku)\s*[:№-]?\s*([A-Z0-9][A-Z0-9_-]{4,39})/giu)].map((match) => match[1]);
  return [...new Set([...values, ...labeled])];
}
function skuFacts(units: SourceUnit[]): { facts: SourceFact[]; limited: boolean } {
  const facts: SourceFact[] = []; let limited = false;
  for (const unit of units) {
    if (facts.length >= maxFacts) { limited = true; break; }
    const tokens = skuTokens(unit.text);
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index], start = unit.text.indexOf(token), next = tokens[index + 1] ? unit.text.indexOf(tokens[index + 1], start + token.length) : unit.text.length;
      let context = unit.text.slice(start, Math.min(next, start + 700));
      if (tokens.length === 1) for (const following of units.slice(unit.index + 1, unit.index + 13)) {
        if (following.sourceId !== unit.sourceId || following.fragmentId !== unit.fragmentId || skuTokens(following.text).length || context.length + following.text.length > 700) break;
        context += `\n${following.text}`;
      }
      const cpus = context.match(/(?:Intel\s+)?Xeon\s+\d{4}[A-Z]?/giu) || [];
      facts.push({ category: "sku", label: `Отдельная комплектация: ${token}`, unit, anchors: [], numbers: [], token, extra: cpus });
    }
  }
  const seen = new Set<string>();
  return { facts: facts.slice(0, maxFacts).filter((fact) => { const key = `${fact.unit.sourceId}:${fact.token}`; if (seen.has(key)) return false; seen.add(key); return true; }), limited: limited || facts.length > maxFacts };
}

/** Deterministic evidence checks over selected text only. This deliberately does
 * not claim complete language understanding or replace a review of the document. */
export function auditIntelligenceResult(items: readonly IntelligenceItem[], sources: readonly IntelligenceSource[]): IntelligenceEvidenceReport {
  const report: IntelligenceEvidenceReport = { fields: [], findings: [], coverage: [] };
  const material = createUnits(sources), units = material.units; let limited = material.limited, fieldChecks = 0;
  const dateMaterial = dateOccurrences(units), dates = dateMaterial.dates; limited ||= dateMaterial.limited;
  // A proof may span several lines, but never several fragments/locators. Only
  // whitespace can differ in a literal quote; case, punctuation and letters may not.
  const quoteGroups = new Map<number, { unit: SourceUnit; rows: string[]; text: string }>();
  for (const unit of units) {
    const group = quoteGroups.get(unit.fragmentKey) || { unit, rows: [], text: "" }; group.rows.push(unit.text); quoteGroups.set(unit.fragmentKey, group);
  }
  for (const group of quoteGroups.values()) { group.text = literalQuote(group.rows.join("\n")); group.rows = []; }
  const fieldScopes = new Map<string, { units: SourceUnit[]; dates: DateOccurrence[]; index: UnitIndex }>();
  const getFieldScope = (item: IntelligenceItem) => {
    const ids = [...new Set(item.sourceIds)].sort(), key = JSON.stringify(ids); const cached = fieldScopes.get(key); if (cached) return cached;
    const allowed = new Set(ids), selectedUnits = units.filter((unit) => allowed.has(unit.sourceId));
    const scope = { units: selectedUnits, dates: dates.filter((entry) => allowed.has(entry.unit.sourceId)), index: buildIndex(selectedUnits) }; fieldScopes.set(key, scope); return scope;
  };
  const sourceFingerprint = fingerprint(sources.map((source) => ({ id: source.id, name: source.name, sha256: source.sha256, warnings: source.warnings, coverage: source.coverage, material: source.fragments === undefined ? source.text : source.fragments })));
  const itemFingerprints = new Map(items.map((item) => [item.id, fingerprint({ title: item.title, fields: item.fields, selectedFields: item.selectedFields, sourceIds: item.sourceIds, evidence: item.evidence, sourceFingerprint })]));
  const finding = (item: IntelligenceItem, code: string, severity: EvidenceFinding["severity"], message: string, evidence: EvidenceExcerpt[], field?: string) => createFinding(item, code, severity, message, evidence, field, itemFingerprints.get(item.id));
  for (const item of items) {
    if (fieldChecks >= maxFieldChecks || report.findings.length >= maxFindings) { limited = true; break; }
    const scope = getFieldScope(item);
    for (const field of [...new Set(item.selectedFields)]) {
      if (fieldChecks >= maxFieldChecks || report.findings.length >= maxFindings) { limited = true; break; }
      const value = item.fields[field]; if (!meaningful(value)) continue;
      fieldChecks++;
      const result = fieldStatus(item, field, value!, scope.units, scope.dates, scope.index); report.fields.push(result);
      if (result.status !== "confirmed") report.findings.push(finding(item, result.status === "placeholder" ? "placeholder-value" : result.status === "conflict" ? "semantic-conflict" : "unverified-value", isCritical(item.destination, field) || result.status !== "unverified" ? "blocking" : "warning", result.message, result.evidence, field));
    }
    if (genericPlaceholders.test(normalize(item.title)) || sources.some((source) => normalize(source.name) === normalize(item.title))) report.findings.push(finding(item, "placeholder-title", "warning", "Название результата похоже на шаблон или имя файла. Проверьте смысловое название.", []));
    for (const claim of item.evidence || []) {
      if (report.findings.length >= maxFindings) { limited = true; break; }
      if (!item.selectedFields.includes(claim.field) || !meaningful(item.fields[claim.field])) continue;
      if (!item.sourceIds.includes(claim.sourceId)) report.findings.push(finding(item, "evidence-source-not-cited", "blocking", "Цитата относится к источнику, не указанному для этой карточки. Проверьте связь документов и происхождение значения до переноса.", [], claim.field));
      const source = sources.find((entry) => entry.id === claim.sourceId);
      const candidates = source ? [...quoteGroups.values()].filter((group) => group.unit.sourceId === source.id && (!claim.fragmentId || group.unit.fragmentId === claim.fragmentId)) : [];
      const quote = literalQuote(claim.quote), quoted = candidates.filter((group) => quote && group.text.includes(quote)).map((group) => group.unit);
      if (!claim.quote.trim() || !quoted.length) report.findings.push(finding(item, "invalid-evidence-quote", "blocking", "Указанная моделью цитата или фрагмент не найдены среди выбранных материалов. Эта ссылка не подтверждает поле.", [], claim.field));
      else if (!strings(item.fields[claim.field]).some((value) => includesPhrase(claim.quote, value) || (typeof item.fields[claim.field] === "number" && hasNumber(claim.quote, item.fields[claim.field] as number)))) report.findings.push(finding(item, "evidence-does-not-support-value", "blocking", "Цитата есть в источнике, но не содержит заявленное значение поля. Проверьте значение и ссылку.", quoted.slice(0, 2).map((unit) => excerpt(unit, claim.quote)), claim.field));
    }
    for (const source of sources) {
      if (report.findings.length >= maxFindings) { limited = true; break; }
      if (source.coverage && (!source.coverage.complete || source.coverage.requiresOcr)) report.findings.push(finding(item, "incomplete-source-coverage", "blocking", `Текст «${source.name}» извлечён не полностью${source.coverage.requiresOcr ? "; требуется проверка OCR" : ""}. Неподтверждённые области документа не проверены этим анализом.`, [{ sourceId: source.id, sourceName: source.name, locator: "Качество извлечения", quote: (source.warnings || []).join("\n") || "Есть области без извлечённого текста." }]));
      else if (source.warnings?.length) report.findings.push(finding(item, "source-warning", "warning", `В источнике «${source.name}» есть предупреждения извлечения; учитывайте их при проверке результата.`, [{ sourceId: source.id, sourceName: source.name, locator: "Предупреждения источника", quote: source.warnings.join("\n") }]));
      if (source.fragments?.some((fragment) => includedFragment(fragment) && (fragment.sheetState === "hidden" || fragment.sheetState === "veryHidden"))) report.findings.push(finding(item, "hidden-sheet-history", "warning", `Выбраны скрытые листы «${source.name}». Скрытая история может относиться к другой закупке; проверьте даты, заказчика и связь с текущей карточкой.`, units.filter((unit) => unit.sourceId === source.id && (unit.sheetState === "hidden" || unit.sheetState === "veryHidden")).slice(0, 2).map((unit) => excerpt(unit))));
    }
  }

  const requirement = requirementFacts(units); limited ||= requirement.limited;
  for (const fact of requirement.facts) {
    if (report.coverage.length >= maxCoverage || report.findings.length >= maxFindings) { limited = true; break; }
    const candidates = targetItems(items, "procurement", fact.unit.sourceId); if (!candidates.length) continue;
    const matched = candidates.filter((item) => fact.category === "price" ? item.selectedFields.includes("nmc") && typeof item.fields.nmc === "number" && Number(item.fields.nmc) === Number(fact.numbers[0]) : outputEntries(item, ["requirements", "licenses", "notes"]).some((entry) => coversFact(entry, fact)));
    const check: CoverageCheck = { id: `coverage-${fingerprint({ source: fact.unit.sourceId, quote: fact.label, category: fact.category, token: fact.token })}`, category: fact.category, status: fact.uncertain ? "uncertain" : matched.length ? "covered" : "missing", label: fact.label, evidence: excerpt(fact.unit), itemIds: candidates.map((item) => item.id), matchedItemIds: matched.map((item) => item.id) };
    report.coverage.push(check);
    if (!matched.length) for (const item of candidates) { if (report.findings.length >= maxFindings) { limited = true; break; } report.findings.push(finding(item, `missing-${fact.category}`, "blocking", fact.category === "price" ? "В выбранном источнике есть явная общая цена, но она не отражена в выбранной НМЦ. Проверьте итог и валюту." : "Обязательное условие из выбранного текста не найдено с его числами и оговорками в переносимых требованиях. Добавьте точное условие или подтвердите его неприменимость.", [check.evidence], fact.category === "price" && meaningful(item.fields.nmc) ? "nmc" : undefined)); }
  }
  for (const date of dates.filter((entry) => entry.event === "submission-end" && entry.time)) {
    if (report.coverage.length >= maxCoverage || report.findings.length >= maxFindings) { limited = true; break; }
    const candidates = targetItems(items, "procurement", date.unit.sourceId); if (!candidates.length) continue;
    const matched = candidates.filter((item) => item.selectedFields.includes("submissionDeadline") && item.fields.submissionDeadline === date.iso && outputEntries(item, ["notes"]).some((note) => (note.match(/(?<!\d)\d{1,2}:\d{2}(?::\d{2})?(?![\d:])/gu) || []).some((time) => time === date.time) && (!date.timezone || (note.match(/(?<![\p{L}\d])(?:МСК|MSK|UTC(?:[+-]\d{1,2}(?::\d{2})?)?|GMT(?:[+-]\d{1,2})?|[+-]\d{2}:\d{2})(?![\p{L}\d:+-])/giu) || []).some((zone) => normalize(zone) === normalize(date.timezone!)))));
    const check: CoverageCheck = { id: `coverage-${fingerprint({ source: date.unit.sourceId, date: date.iso, time: date.time, timezone: date.timezone })}`, category: "deadline-time", status: matched.length ? "covered" : "missing", label: `Подача: ${date.iso} ${date.time}${date.timezone ? ` ${date.timezone}` : ""}`, evidence: excerpt(date.unit, date.quote), itemIds: candidates.map((item) => item.id), matchedItemIds: matched.map((item) => item.id) };
    report.coverage.push(check);
    if (!matched.length) for (const item of candidates) { if (report.findings.length >= maxFindings) { limited = true; break; } report.findings.push(finding(item, "missing-deadline-time", "blocking", "Источник указывает время подачи и, возможно, часовой пояс. Одна дата не сохраняет это условие: добавьте время и указанный пояс в переносимые примечания.", [check.evidence])); }
  }
  const positions = skuFacts(units), sku = positions.facts; limited ||= positions.limited;
  for (const fact of sku) {
    if (report.coverage.length >= maxCoverage || report.findings.length >= maxFindings) { limited = true; break; }
    const candidates = targetItems(items, "proposals", fact.unit.sourceId); if (!candidates.length) continue;
    const uniqueExtras = (fact.extra || []).filter((extra) => sku.filter((other) => (other.extra || []).some((value) => normalize(value) === normalize(extra))).length === 1);
    const matched = candidates.filter((item) => {
      const lines = item.selectedFields.includes("lines") ? strings(item.fields.lines) : [];
      const descriptions = item.selectedFields.includes("lineDescriptions") ? strings(item.fields.lineDescriptions) : [];
      return lines.some((line, index) => includesPhrase(`${line}\n${descriptions[index] || ""}`, fact.token || "") || uniqueExtras.some((extra) => includesPhrase(`${line}\n${descriptions[index] || ""}`, extra)));
    });
    const check: CoverageCheck = { id: `coverage-${fingerprint({ source: fact.unit.sourceId, sku: fact.token })}`, category: "sku", status: matched.length ? "covered" : "missing", label: fact.label, evidence: excerpt(fact.unit), itemIds: candidates.map((item) => item.id), matchedItemIds: matched.map((item) => item.id) };
    report.coverage.push(check);
    if (!matched.length) for (const item of candidates) { if (report.findings.length >= maxFindings) { limited = true; break; } report.findings.push(finding(item, "missing-sku", "blocking", "Комплектация из источника не найдена как отдельная позиция КП. Добавьте её название и отдельное описание, сохранив артикул или различающие характеристики.", [check.evidence], "lines")); }
  }
  // Some PDF text layers place the SKU table before all detailed blocks. In
  // that layout a CPU cannot safely be assigned to a SKU by nearest line. Still
  // expose an omitted distinguishing CPU instead of calling bare SKU names a
  // complete configuration. This checks presence, not the SKU/CPU association.
  for (const source of sources) {
    if (new Set(sku.filter((fact) => fact.unit.sourceId === source.id).map((fact) => fact.token)).size < 2) continue;
    const cpus = new Map<string, { value: string; unit: SourceUnit }>();
    for (const unit of units.filter((entry) => entry.sourceId === source.id)) for (const value of unit.text.match(/(?:Intel\s+)?Xeon\s+\d{4}[A-Z]?/giu) || []) cpus.set(normalize(value).replace(/^intel\s+/u, ""), { value: value.replace(/^Intel\s+/iu, ""), unit });
    if (cpus.size < 2) continue;
    for (const { value, unit } of cpus.values()) {
      if (report.coverage.length >= maxCoverage || report.findings.length >= maxFindings) { limited = true; break; }
      const candidates = targetItems(items, "proposals", source.id); if (!candidates.length) continue;
      const matched = candidates.filter((item) => outputEntries(item, ["lines", "lineDescriptions"]).some((text) => includesPhrase(text, value)));
      const check: CoverageCheck = { id: `coverage-${fingerprint({ source: source.id, configuration: value })}`, category: "sku", status: matched.length ? "covered" : "missing", label: `Характеристика комплектации (связь с артикулом требует проверки): ${value}`, evidence: excerpt(unit), itemIds: candidates.map((item) => item.id), matchedItemIds: matched.map((item) => item.id) };
      report.coverage.push(check);
      if (!matched.length) for (const item of candidates) { if (report.findings.length >= maxFindings) { limited = true; break; } report.findings.push(finding(item, "missing-sku-configuration", "blocking", "В документе несколько артикулов и разные процессоры, но эта характеристика отсутствует в переносимых позициях. Проверьте отдельные описания и соответствие артикулу; наличие одного артикула не подтверждает полноту комплектации.", [check.evidence])); }
    }
  }
  for (const item of items.filter((entry) => entry.destination === "proposals" && entry.selectedFields.includes("lines"))) {
    if (report.findings.length >= maxFindings) { limited = true; break; }
    const lines = strings(item.fields.lines), descriptions = item.selectedFields.includes("lineDescriptions") ? strings(item.fields.lineDescriptions) : [];
    for (let index = 0; index < lines.length; index++) {
      if (report.findings.length >= maxFindings) { limited = true; break; }
      const combined = `${lines[index]}\n${descriptions[index] || ""}`;
      const merged = sku.filter((fact) => includesPhrase(combined, fact.token || "") || (fact.extra || []).some((extra) => sku.filter((other) => (other.extra || []).some((value) => normalize(value) === normalize(extra))).length === 1 && includesPhrase(combined, extra)));
      if (new Set(merged.map((fact) => fact.token)).size > 1) report.findings.push(finding(item, "merged-sku-line", "blocking", `В позиции ${index + 1} смешаны несколько разных комплектаций. Одна позиция должна соответствовать одной SKU; разделите названия и описания.`, merged.slice(0, 3).map((fact) => excerpt(fact.unit)), "lines"));
    }
  }
  if (limited || [...fieldScopes.values()].some((scope) => scope.index.limited)) for (const item of items) report.findings.push(finding(item, "audit-limit", "blocking", "Локальная проверка достигла бюджета: не более 5000 строк / 2 млн символов, 20000 символов в строке, 1000 полей, 1000 дат, 256 условий, 512 замечаний и 200 текстовых совпадений на значение. Полнота проверки не подтверждена; разделите задачу или выполните отдельную проверку вручную.", []));
  report.findings = report.findings.filter((entry, index, all) => all.findIndex((other) => other.id === entry.id) === index);
  return report;
}

/** Review acknowledgements are ephemeral UI state. IDs include current values,
 * selections and evidence, so an old acknowledgement cannot authorize new data. */
export function getBlockingEvidenceFindings(report: IntelligenceEvidenceReport, item: IntelligenceItem | string, reviewedFindingIds: readonly string[] = []): EvidenceFinding[] {
  const itemId = typeof item === "string" ? item : item.id; const reviewed = new Set(reviewedFindingIds);
  return report.findings.filter((entry) => entry.itemId === itemId && entry.severity === "blocking" && !reviewed.has(entry.id) && (typeof item === "string" || !entry.field || item.selectedFields.includes(entry.field)));
}
