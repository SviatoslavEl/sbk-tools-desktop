import type { IntelligenceDestination, IntelligenceFieldValue, IntelligenceFragment, IntelligenceItem, IntelligenceSource } from "./workbenchTypes";
import { extractSourcePositionFacts } from "./sourcePositionFacts";
import { extractIntelligenceConditionFacts } from "./sourceConditionFacts";
import { collectLiteralCompleteness } from "./literalCompleteness";
import { contractIdentifiers } from "./contractIdentifiers";
import { extractProposalIdentifierFacts, proposalIdentifiers, type ProposalIdentifierFact } from "./proposalIdentifiers";
import { createRequirementComparator } from "./requirementDeduplication";
import { isOrganizerBeneficiarySupport } from "./sourceTextCompletion";
import { createProposalPublicTermsProver } from "./proposalPublicTerms";
import { extractPreparedTableFacts, isPrimaryContractAmountLabel, isPrimaryNmcLabel, unsupportedMonetaryUnit, type PreparedTableFacts, type SourcePreparationProvenance } from "./sourcePreparedFacts";

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
  supportingEvidence?: EvidenceExcerpt[];
}
export interface IntelligenceEvidenceReport {
  fields: FieldEvidenceStatus[]; findings: EvidenceFinding[]; coverage: CoverageCheck[];
}
export type IntelligenceDateEvent = "submission-start" | "submission-end" | "question-deadline" | "publication" | "revision" | "consideration" | "results" | "execution-start" | "execution-end" | "contract-date" | "proposal-date" | "valid-until";
export interface IntelligenceDateFact extends EvidenceExcerpt {
  iso: string;
  event: IntelligenceDateEvent;
  time?: string;
  timezone?: string;
  supportingEvidence?: EvidenceExcerpt[];
  /** A detected timezone conflict or uncertain submission-to-lot association.
   * Absence is not a guarantee of general semantic or legal applicability. */
  ambiguous?: boolean;
  lowerBound?: boolean;
}
export interface IntelligenceDateFacts {
  facts: IntelligenceDateFact[];
  /** True when an existing source/row/character/date parsing budget was reached. */
  limited: boolean;
}

type Role = "supplier" | "customer" | "internal" | "unknown";
type SourceUnit = EvidenceExcerpt & { text: string; normalizedText: string; normalizedSourceName: string; numbers: string[]; source: IntelligenceSource; sourceFragmentIndex: number; sheetState?: IntelligenceFragment["sheetState"]; index: number; fragmentKey: number; context: string; precedingContext: string; role: Role; nmcAmounts: string[]; nmcHeaders: EvidenceExcerpt[] };
type PersonBinding = { name: string; unit: SourceUnit };
type StaffProfileBinding = { names: string[]; unit: SourceUnit; sharedContacts?: true };
type StaffEducationBinding = { cells: string[]; header?: SourceUnit };
type UnitIndex = { tokens: Map<string, SourceUnit[]>; numbers: Map<string, SourceUnit[]>; phones: Map<string, SourceUnit[]>; contractNumbers: Map<string, SourceUnit[]>; proposalNumbers?: ProposalIdentifierFact[]; staffOwners: Map<number, PersonBinding>; staffProfileOwners: Map<number, StaffProfileBinding>; staffEducationCells: Map<number, StaffEducationBinding>; sourceNames: Set<string>; literalFragments: Array<{ key: number; unit: SourceUnit; text: string }>; ambiguousLotSources: Map<string, EvidenceExcerpt[]>; limited: boolean };
type SourceFact = { category: CoverageCheck["category"]; label: string; unit: SourceUnit; anchors: string[]; numbers: string[]; token?: string; extra?: string[]; qualifiers?: string[]; uncertain?: boolean };
type DateOccurrence = { iso: string; event: string; time?: string; timezone?: string; timezoneEvidence?: EvidenceExcerpt[]; eventEvidence?: EvidenceExcerpt[]; timezoneAmbiguous?: boolean; lowerBound?: boolean; unit: SourceUnit; quote: string };
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
const genericResultTitles = /^(?:закупка|тендер|договор|контракт|кп|коммерческое предложение|карточка|компания|сотрудник|документ)$/iu;
const currency = /(?:руб(?:\.|лей|ля)?|₽|\bRUB\b)/iu;
const foreignCurrency = /(?:\b(?:USD|EUR|CNY|KZT|BYN|JPY|GBP|CHF)\b|[$€¥₸£]|доллар[а-я]*|евро|юан[а-я]*|тенге|белорус[а-я\s]+рубл[а-я]*)/iu;
const moneyContext = /(?:нмцк?|начальн[а-я\s]*(?:максимальн[а-я\s]*)?цен|максимальн[а-я\s]+(?:цен|стоимост)|итогов[а-я\s]+(?:цен|стоимост|сумм)|итого|всего|общая\s+(?:цена|стоимость|сумма)|(?:цена|стоимость|сумма)\s+(?:договора|контракта))/iu;
const nmcLabel = /(?:н\s*м\s*цк?(?![а-я])|начальн[а-я\s]*максимальн[а-я\s]*цен[а-я]*|(?:предельн|максимальн)[а-я\s]+(?:цен|стоимост)[а-я\s]+(?:закупк|договора|контракта|лота))/iu;
const shareLabel = /(?:наша\s+доля|стоимость\s+нашей\s+(?:доли|части)|(?:стоимость|объ[её]м)\s+(?:наших\s+работ|работ\s+нашей\s+(?:компании|организации)))/iu;
const primaryLegacyNmcLabel = new RegExp(`^(?:${nmcLabel.source})`, "iu");
const primaryLegacyMoneyLabel = new RegExp(`^(?:${moneyContext.source})`, "iu");
function financialSentences(text: string): string[] {
  const clauses: string[] = []; let start = 0;
  for (const match of text.matchAll(/[;\t\n!?]|\.(?=\s|$)/gu)) {
    const at = match.index!;
    // A full stop in a monetary abbreviation or «т.ч.» / «т. е.» is not
    // permission to detach a later NMC mention from its penalty/security role.
    if (match[0] === "." && /(?:^|[^\p{L}])(?:руб|коп|тыс|млн|млрд|г|ч|е|п|т|др|проч|шт|ед|им)\s*$/iu.test(text.slice(Math.max(0, at - 16), at))) continue;
    clauses.push(text.slice(start, at)); start = at + 1;
  }
  clauses.push(text.slice(start)); return clauses;
}
const primaryNmcContext = (text: string) => financialSentences(text).some((clause) => {
  const primary = clause.trim().replace(/^(?:итого|всего)\s*[:—-]?\s+/iu, "");
  return isPrimaryNmcLabel(primary) || primaryLegacyNmcLabel.test(primary);
});
const primaryMoneyContext = (text: string) => text.split(/[;\t\n]/u).some((clause) => isPrimaryContractAmountLabel(clause) || isPrimaryNmcLabel(clause) || primaryLegacyMoneyLabel.test(clause.trim()));
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
  // Tabs/newlines separate cells or rows, never decimal grouping positions.
  const matches = value.match(/\d+(?:[ \u00a0\u202f]\d{3})*(?:[.,]\d+)?/gu) || [];
  return matches.map((entry) => entry.replace(/[ \u00a0\u202f]/g, "").replace(",", ".")).filter((entry) => Number.isFinite(Number(entry)));
}
function withoutListIndex(value: string): string { return value.replace(/^\s*\d{1,3}(?:\.\d{1,3})*[.)]\s+(?=\S)/u, ""); }
function businessNumbers(value: string): string[] { return numberTokens(withoutListIndex(value)); }
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
  if (emails.length) {
    const residue = emails.reduce((remaining, email) => remaining.split(email).join(""), candidate).replace(/[\s,;<>()[\]]/gu, "");
    if (!residue) { const actual = new Set(emailTokens(body)); return emails.every((email) => actual.has(email)); }
  }
  if (/^\+?[\d\s()-.]{9,}$/u.test(candidate)) {
    const expected = digits(candidate); return (text.match(/\+?\d[\d\s()-.]{7,}\d/gu) || []).some((phone) => digits(phone) === expected);
  }
  return candidate.length >= 3 && body.includes(candidate);
}
const russianCalendarMonths: Record<string, string> = { января: "01", февраля: "02", марта: "03", апреля: "04", мая: "05", июня: "06", июля: "07", августа: "08", сентября: "09", октября: "10", ноября: "11", декабря: "12" };
function calendarDatePattern(): RegExp {
  return /(?:\b(?:(\d{4})-(\d{2})-(\d{2})|(\d{2})[./](\d{2})[./](\d{4}))|(?<![\p{L}\d])(?:[«"“]\s*)?(\d{1,2})(?:\s*[»"”])?\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)\s+(\d{4}))(?!\d)(?:[ T,]+(?:в\s+)?(\d{1,2}:\d{2}(?::\d{2})?))?/giu;
}
function calendarIso(match: RegExpMatchArray): string {
  return match[1] ? `${match[1]}-${match[2]}-${match[3]}` : match[4] ? `${match[6]}-${match[5]}-${match[4]}` : `${match[9]}-${russianCalendarMonths[match[8].toLocaleLowerCase("ru")]}-${match[7].padStart(2, "0")}`;
}
function standaloneCalendarDate(text: string, match: RegExpMatchArray): boolean {
  // A shared month/year in “14–20 апреля 2026” does not make the last day
  // a unique scalar date. Do not promote it through either facts or evidence.
  return !match[7] || !/\d{1,2}(?:\s*[»"”])?\s*[-‐‑–—]\s*(?:[«"“]\s*)?$/u.test(text.slice(Math.max(0, (match.index || 0) - 32), match.index));
}
function canonicalQuoteDates(text: string): string[] {
  return [...text.matchAll(calendarDatePattern())].flatMap((match) => {
    const iso = calendarIso(match);
    const date = new Date(`${iso}T00:00:00Z`);
    return standaloneCalendarDate(text, match) && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === iso ? [iso] : [];
  });
}
function quoteSupportsValue(item: IntelligenceItem, field: string, quote: string): boolean {
  const value = item.fields[field];
  if (item.destination === "proposals" && field === "number" && typeof value === "string" && proposalIdentifiers(quote, true).some((identifier) => normalize(identifier) === normalize(value).replace(/^№\s*/u, ""))) return true;
  if (typeof value === "number") return hasNumber(quote, value) || field === "nmc" && splitRubleAmounts(quote, nmcLabel).some((amount) => Number(amount) === value);
  return strings(value).some((entry) => includesPhrase(quote, entry)
    // Literal quote existence, source selection and event/role checks are kept
    // separate. Canonicalizing an actual date does not change its event.
    || /(?:Date|Deadline)$|^(?:date|validUntil|availableFrom|availableTo)$/u.test(field) && /^\d{4}-\d{2}-\d{2}$/u.test(entry) && canonicalQuoteDates(quote).includes(entry)
    // An exact excerpt can substantiate one part of a note or proposal
    // description (whose full text is checked separately). This never applies
    // to dates, companies, prices, contacts or requirements.
    || (/^(?:notes|internalNote)$/u.test(field) || item.destination === "proposals" && field === "lineDescriptions") && Boolean(literalQuote(quote)) && literalQuote(entry).includes(literalQuote(quote)));
}
type CollectivePaymentProof = { evidence: EvidenceExcerpt[]; claims: Set<NonNullable<IntelligenceItem["evidence"]>[number]> };
type PreparedTableProof = { fields: Map<string, FieldEvidenceStatus>; claims: Set<NonNullable<IntelligenceItem["evidence"]>[number]> };
/** Table ownership comes from the same bounded grammar as source preparation,
 * but never from a receipt or a model claim. A header can support a value only
 * alongside the complete literal row that belongs to this exact card. */
function preparedTableProof(item: IntelligenceItem, items: readonly IntelligenceItem[], inventory: PreparedTableFacts): PreparedTableProof {
  const proof: PreparedTableProof = { fields: new Map(), claims: new Set() };
  const claims = item.evidence || [];
  if (inventory.limited || claims.length > 500) return proof;
  const sameClaim = (claim: NonNullable<IntelligenceItem["evidence"]>[number], entry: SourcePreparationProvenance, field: string) => claim.field === field && claim.sourceId === entry.sourceId && claim.fragmentId === entry.fragmentId && literalQuote(claim.quote) === literalQuote(entry.quote);
  const ownRow = (row: SourcePreparationProvenance, field: string) => claims.some((claim) => sameClaim(claim, row, field));
  const accept = (field: string, row: SourcePreparationProvenance, headers: SourcePreparationProvenance[]) => {
    if (!item.selectedFields.includes(field) || !ownRow(row, field)) return;
    proof.fields.set(field, { itemId: item.id, field, status: "confirmed", message: "Значение дословно подтверждено своей строкой и явно обозначенным столбцом текущей выбранной таблицы. Это проверка происхождения, не подтверждение полноты или юридической достоверности.", evidence: [row, ...headers] });
    for (const claim of claims) if (headers.some((header) => sameClaim(claim, header, field))) proof.claims.add(claim);
  };
  const rejectUnit = (field: string, row: SourcePreparationProvenance, headers: SourcePreparationProvenance[]) => {
    proof.fields.set(field, { itemId: item.id, field, status: "conflict", message: "В денежном столбце указаны другая валюта, масштаб, копейки или стоимость за единицу / период. Напечатанное число нельзя без отдельной проверки считать общей суммой в рублях. Автоматический пересчёт не выполнен.", evidence: [row, ...headers] });
  };
  const numberKey = (value: string) => normalize(value).replace(/^№\s*/u, "").replace(/\s+/gu, "");
  if (item.destination === "contracts" && item.selectedFields.includes("number") && item.selectedFields.includes("date") && typeof item.fields.number === "string" && typeof item.fields.date === "string") {
    const number = numberKey(item.fields.number), date = item.fields.date;
    const candidates = inventory.contracts.filter((fact) => item.sourceIds.includes(fact.sourceId) && fact.date === date && contractIdentifiers(`Договор № ${fact.number} от ${fact.date}`).some((alias) => numberKey(alias) === number));
    const unsafeAmount = candidates.find((fact) => unsupportedMonetaryUnit(fact.amountLabel, fact.amountText));
    if (unsafeAmount && typeof item.fields.amount === "number") rejectUnit("amount", unsafeAmount.row, [unsafeAmount.header]);
    // The primary token plus date cannot select between two separate registry
    // suffixes. Nor can equal identifiers choose between conflicting sources.
    if (candidates.length && new Set(candidates.map((fact) => numberKey(fact.number))).size === 1 && new Set(candidates.map((fact) => JSON.stringify(fact.fields))).size === 1) {
      for (const field of ["customer", "amount"]) {
        const candidate = candidates.find((fact) => ownRow(fact.row, field));
        if (!candidate || candidate.fields[field] !== item.fields[field]) continue;
        if (field === "amount" && unsafeAmount) continue;
        accept(field, candidate.row, [candidate.header]);
      }
    }
  }
  if (item.destination === "procurement" && item.selectedFields.includes("nmc") && typeof item.fields.nmc === "number") {
    const candidates = inventory.nmcs.filter((fact) => item.sourceIds.includes(fact.row.sourceId));
    const unsafeNmc = candidates.find((fact) => unsupportedMonetaryUnit(fact.totalLabel, fact.amountText));
    if (unsafeNmc) rejectUnit("nmc", unsafeNmc.row, unsafeNmc.headers);
    if (!unsafeNmc && candidates.length && new Set(candidates.map((fact) => fact.value)).size === 1 && candidates.every((fact) => items.filter((other) => other.destination === "procurement" && other.sourceIds.includes(fact.row.sourceId)).length === 1)) {
      const candidate = candidates.find((fact) => fact.value === item.fields.nmc && ownRow(fact.row, "nmc"));
      if (candidate) accept("nmc", candidate.row, candidate.headers);
    }
  }
  return proof;
}
/** Payment terms alone may retain separate, complete clauses from consecutive
 * paragraphs under one explicit payment heading. This is not a general
 * cross-fragment substring exception: both the field and its original quotes
 * must cover the full section in source order, without altered punctuation,
 * numbers or qualifications. Each proof keeps its own real locator/quote. */
function collectivePaymentProof(item: IntelligenceItem, units: SourceUnit[]): CollectivePaymentProof | undefined {
  if (item.destination !== "proposals" || !item.selectedFields.includes("paymentTerms") || typeof item.fields.paymentTerms !== "string") return undefined;
  if (!item.evidence || item.evidence.length > 500 || item.fields.paymentTerms.length > maxUnitCharacters) return undefined;
  const value = literalQuote(item.fields.paymentTerms);
  const paymentClaims = item.evidence.map((claim, position) => ({ claim, position })).filter(({ claim }) => claim.field === "paymentTerms");
  if (!value || paymentClaims.length < 2 || paymentClaims.some(({ claim }) => claim.quote.length > maxUnitCharacters) || paymentClaims.reduce((sum, { claim }) => sum + claim.quote.length, 0) > maxAuditCharacters) return undefined;
  const claims = paymentClaims.map((entry) => ({ ...entry, quote: literalQuote(entry.claim.quote) }));
  const sourceOwners = new Map<string, IntelligenceSource>(), duplicateSources = new Set<string>();
  for (const unit of units) {
    const owner = sourceOwners.get(unit.sourceId);
    if (owner && owner !== unit.source) duplicateSources.add(unit.sourceId); else sourceOwners.set(unit.sourceId, unit.source);
  }
  const paragraphNumber = (unit: SourceUnit) => {
    const id = /^paragraph-(\d+)$/iu.exec(unit.fragmentId || ""), locator = /^Абзац\s+(\d+)$/iu.exec(unit.locator.trim());
    if (!id && !locator || id && locator && Number(id[1]) !== Number(locator[1])) return undefined;
    return Number((id || locator)![1]);
  };
  const fragment = (unit: SourceUnit) => unit.source.fragments?.[unit.sourceFragmentIndex];
  const adjacent = (previous: SourceUnit, current: SourceUnit) => {
    if (previous.source !== current.source || fragment(previous)?.sheetId !== fragment(current)?.sheetId) return false;
    if (previous.fragmentKey === current.fragmentKey) return true;
    const before = paragraphNumber(previous), after = paragraphNumber(current);
    return current.sourceFragmentIndex === previous.sourceFragmentIndex + 1 && before !== undefined && after === before + 1;
  };
  const explicitClosingAfterParagraphGap = (previous: SourceUnit, current: SourceUnit) => {
    const before = paragraphNumber(previous), after = paragraphNumber(current);
    // A later, explicit section heading is a terminator, not another payment
    // clause. Its omitted numeric paragraph may be outside selected material;
    // never bridge an actual skipped/hidden fragment or use this to join terms.
    return previous.source === current.source && fragment(previous)?.sheetId === fragment(current)?.sheetId
      && current.sourceFragmentIndex === previous.sourceFragmentIndex + 1 && before !== undefined && after !== undefined && after > before + 1
      && current.sheetState !== "hidden" && current.sheetState !== "veryHidden"
      && /^оговорки\s*[:：]$/iu.test(withoutListIndex(current.text));
  };
  let previous: SourceUnit | undefined, active = false, clauses: SourceUnit[] = [], characters = 0;
  const matches: CollectivePaymentProof[] = [];
  const finish = () => {
    if (active && clauses.length >= 2 && clauses.map((unit) => literalQuote(unit.text)).join(" ") === value) {
      const proof: CollectivePaymentProof = { evidence: [], claims: new Set() }; let last = -1;
      for (const unit of clauses) {
        const quote = literalQuote(unit.text);
        const found = claims.find(({ claim, position, quote: claimQuote }) => position > last && claim.sourceId === unit.sourceId && claim.fragmentId === unit.fragmentId && claimQuote === quote);
        if (!found) break;
        last = found.position; proof.claims.add(found.claim); proof.evidence.push(excerpt(unit, found.claim.quote));
      }
      if (proof.evidence.length === clauses.length) matches.push(proof);
    }
    active = false; clauses = []; characters = 0;
  };
  for (const unit of units) {
    if (previous && !adjacent(previous, unit)) {
      // A source boundary closes a section; a skipped paragraph or different
      // sheet within the same source cannot prove its intact continuation.
      if (previous.source !== unit.source || explicitClosingAfterParagraphGap(previous, unit)) finish(); else { active = false; clauses = []; characters = 0; }
    }
    previous = unit;
    if (duplicateSources.has(unit.sourceId) || unit.sheetState === "hidden" || unit.sheetState === "veryHidden" || /^table(?:-|$)/iu.test(unit.fragmentId || "") || /^Таблица(?:[^\p{L}]|$)/iu.test(unit.locator) || unit.text.includes("\t")) {
      active = false; clauses = []; characters = 0; continue;
    }
    if (/^(?:условия|порядок)\s+оплаты\s*[:.]?$/iu.test(withoutListIndex(unit.text))) { finish(); active = true; continue; }
    if (!active) continue;
    if (!/(?:аванс|предоплат|постоплат|оплат|плат[её]ж|расч[её]т)/iu.test(unit.text) || !/(?:\d\s*%|дн[её]й|календарных|подписан|при[её]мк|отказ)/iu.test(unit.text)) { finish(); continue; }
    characters += unit.text.length;
    if (clauses.length >= maxCandidateUnits || characters > maxUnitCharacters) { active = false; clauses = []; continue; }
    clauses.push(unit);
  }
  finish();
  // Repeated identical sections do not establish which occurrence was meant.
  return matches.length === 1 ? matches[0] : undefined;
}
function lineRole(text: string): Role {
  if (/(?:наш|внутренн[а-я]*)\s+(?:ответственн|координатор|менеджер)|ответственн[а-я\s]+(?:за\s+)?нашу\s+заявк/iu.test(text)) return "internal";
  if (/^(?:поставщик|исполнитель|продавец|отправитель)\s*$/iu.test(text.trim()) || /(?:^|[;\t])\s*(?:поставщик|исполнитель|продавец|отправитель)\s*(?:[:‐‑–—-]|\t)|(?:реквизиты|контакт|адрес)\s+(?:поставщика|исполнителя)/iu.test(text)) return "supplier";
  if (/^(?:заказчик|покупатель|получатель|адресат|организатор)\s*$/iu.test(text.trim()) || /(?:^|[;\t])\s*(?:заказчик|покупатель|получатель|адресат|организатор)\s*(?:[:‐‑–—-]|\t)|(?:для\s+нужд|реквизиты|контакт|адрес)\s+(?:заказчика|покупателя|организатора)/iu.test(text)) return "customer";
  return "unknown";
}
function roleClauses(text: string): string[] {
  // Split a sentence only when the next text is an explicit party label. Dots
  // in legal abbreviations, initials, domains and addresses are not boundaries.
  return text.split(/[;\t]|\.(?=\s*(?:(?:поставщик|исполнитель|продавец|отправитель|заказчик|покупатель|получатель|адресат|организатор)|(?:реквизиты|контакт|адрес)\s+(?:поставщика|исполнителя|заказчика|покупателя|организатора))\s*[:‐‑–—-])/iu);
}
interface NmcColumnHeader { row: number; excerpt: EvidenceExcerpt; }
function structuredNmc(fragment: IntelligenceFragment, source: IntelligenceSource, headers: Map<string, NmcColumnHeader>, cellBudget: { count: number; characters: number; limited: boolean }): { amounts: string[]; headers: EvidenceExcerpt[] } {
  const result = { amounts: [] as string[], headers: [] as EvidenceExcerpt[] };
  const raw = (fragment as IntelligenceFragment & { cells?: unknown }).cells;
  if (!fragment.sheetId || !Array.isArray(raw)) return result;
  const fragmentText = literalQuote(fragment.text);
  const cells: Array<{ column: string; row: number; text: string; number?: string }> = [];
  for (const entry of raw) {
    if (++cellBudget.count > 20000) { cellBudget.limited = true; break; }
    if (!entry || typeof entry !== "object") continue;
    const cell = entry as Record<string, unknown>, reference = typeof cell.reference === "string" ? /^([A-Z]{1,3})([1-9]\d{0,6})$/u.exec(cell.reference) : null;
    if (!reference || Number(reference[2]) > 1048576 || typeof cell.text !== "string" || cell.text.length > maxUnitCharacters) continue;
    cellBudget.characters += cell.text.length;
    if (cellBudget.characters > maxAuditCharacters) { cellBudget.limited = true; break; }
    if (!fragmentText.includes(literalQuote(cell.text))) continue;
    const numeric = cell.valueType === "number" && /^\d+(?:[.,]\d+)?(?:e[+-]?\d+)?$/iu.test(cell.text.trim()) ? cell.text.trim().replace(",", ".") : undefined;
    const number = numeric && Number.isFinite(Number(numeric)) && Number(numeric) >= 0 && Number(numeric) <= 1e12 && (cell.rawValue === undefined || typeof cell.rawValue === "string" && Number(cell.rawValue) === Number(numeric)) ? numeric : undefined;
    cells.push({ column: reference[1], row: Number(reference[2]), text: cell.text, number });
  }
  // The heading belongs to a coordinate, not every number in its row or source.
  for (const cell of cells) {
    const primary = cell.text.split(/[,;:]/u)[0].replace(/[()]/gu, " ");
    const key = `${fragment.sheetId}:${cell.column}`;
    if (cell.number === undefined && (nmcLabel.test(primary) || moneyContext.test(primary) || unitPriceContext.test(primary) || foreignCurrency.test(cell.text))) headers.delete(key);
    if (primaryNmcContext(primary) && currency.test(cell.text) && !unitPriceContext.test(primary) && !foreignCurrency.test(cell.text) && !/не\s+(?:указан[аоы]?|определ[её]н[аоы]?|извест[а-я]*)/iu.test(cell.text)) headers.set(key, { row: cell.row, excerpt: { sourceId: source.id, sourceName: source.name, fragmentId: fragment.id, locator: fragment.locator, quote: cell.text } });
  }
  if (!cells.some((cell) => /^(?:итого|всего)(?:\s|[,:‐‑–—-]|$)/iu.test(cell.text.trim()) && !/(?:подытог|subtotal|промежуточн|по\s+раздел)/iu.test(cell.text) && !/^(?:итого|всего)\s*[:,‐‑–—-]?\s*(?:сумма\s+)?ндс(?:[^\p{L}]|$)/iu.test(cell.text.trim()) && !unitPriceContext.test(cell.text) && !foreignCurrency.test(cell.text))) return result;
  for (const cell of cells) {
    const header = headers.get(`${fragment.sheetId}:${cell.column}`);
    if (cell.number === undefined || !header || header.row >= cell.row) continue;
    result.amounts.push(cell.number); result.headers.push(header.excerpt);
    // A completed total closes this header association; a later unrelated table
    // on the same sheet needs its own explicit heading.
    headers.delete(`${fragment.sheetId}:${cell.column}`);
  }
  return result;
}
function createUnits(sources: readonly IntelligenceSource[]): { units: SourceUnit[]; limited: boolean } {
  const units: SourceUnit[] = []; let limited = false, characters = 0, fragmentKey = 0;
  const cellBudget = { count: 0, characters: 0, limited: false };
  for (const source of sources) {
    const nmcColumns = new Map<string, NmcColumnHeader>();
    const normalizedSourceName = normalize(source.name);
    // An explicit fragments array is authoritative: discarded sheets/pages must
    // never re-enter evidence through the source's aggregate text.
    const fragments = source.fragments === undefined ? [{ text: source.text, locator: "Текст источника" }] : source.fragments;
    for (const [sourceFragmentIndex, fragment] of fragments.entries()) {
      if (!includedFragment(fragment)) continue;
      fragmentKey++;
      const nmc = structuredNmc(fragment, source, nmcColumns, cellBudget);
      const rows = fragment.text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
      let role: Role = "unknown";
      for (let index = 0; index < rows.length; index++) {
        if (units.length >= maxUnits || characters + rows[index].length > maxAuditCharacters) { limited = true; break; }
        const text = rows[index].slice(0, maxUnitCharacters); if (text.length !== rows[index].length) limited = true;
        for (const clause of roleClauses(text)) { const explicit = lineRole(clause); if (explicit !== "unknown") role = explicit; }
        const context = rows.slice(Math.max(0, index - 1), Math.min(rows.length, index + 2)).map((line) => line.slice(0, maxUnitCharacters)).join("\n");
        const precedingContext = rows.slice(Math.max(0, index - 2), index).map((line) => line.slice(0, maxUnitCharacters)).join("\n");
        characters += text.length;
        const nmcAmounts = [...new Set([...(index === 0 ? nmc.amounts : []), ...splitRubleAmounts(text, nmcLabel)])];
        units.push({ sourceId: source.id, sourceName: source.name, fragmentId: fragment.id, locator: fragment.locator, quote: text, text, normalizedText: normalize(text), normalizedSourceName, numbers: numberTokens(text), source, sourceFragmentIndex, sheetState: fragment.sheetState, index: units.length, fragmentKey, context, precedingContext, role, nmcAmounts, nmcHeaders: index === 0 ? nmc.headers : [] });
        if (limited) break;
      }
      if (limited) break;
    }
    if (limited) break;
  }
  return { units, limited: limited || cellBudget.limited };
}
function buildIndex(units: SourceUnit[], dates: DateOccurrence[]): UnitIndex {
  const index: UnitIndex = { tokens: new Map(), numbers: new Map(), phones: new Map(), contractNumbers: new Map(), staffOwners: new Map(), staffProfileOwners: staffProfileOwners(units), staffEducationCells: staffEducationCells(units), sourceNames: new Set(), literalFragments: [], ambiguousLotSources: new Map(), limited: false };
  const fragments = new Map<number, { unit: SourceUnit; rows: string[] }>();
  const add = (map: Map<string, SourceUnit[]>, token: string, unit: SourceUnit) => { const values = map.get(token) || []; values.push(unit); map.set(token, values); };
  let person: PersonBinding | undefined, personFragment = -1, personRows = 0, personCharacters = 0;
  for (const unit of units) {
    if (personFragment !== unit.fragmentKey) { person = undefined; personFragment = unit.fragmentKey; }
    const explicitPerson = explicitPersonName(unit.text);
    if (explicitPerson) { person = { name: explicitPerson, unit }; personRows = 0; personCharacters = 0; }
    else {
      personRows++; personCharacters += unit.text.length;
      if (personRows > 6 || personCharacters > 2000 || /^(?:\d+[.)]\s+|Ф\.?\s*И\.?\s*О\.?\s*\t)/iu.test(unit.text) || obligationPattern.test(unit.text)) person = undefined;
    }
    if (person) index.staffOwners.set(unit.index, person);
    const fragment = fragments.get(unit.fragmentKey) || { unit, rows: [] }; fragment.rows.push(unit.text); fragments.set(unit.fragmentKey, fragment);
    index.sourceNames.add(unit.normalizedSourceName);
    for (const token of new Set([...(unit.normalizedText.match(/[\p{L}\d+_-]{3,}/gu) || []), ...emailTokens(unit.normalizedText)])) add(index.tokens, token, unit);
    for (const token of new Set([...unit.numbers, ...unit.nmcAmounts].map((value) => String(Number(value))))) add(index.numbers, token, unit);
    for (const phone of new Set((unit.text.match(/\+?\d[\d\s()-.]{7,}\d/gu) || []).map(digits))) add(index.phones, phone, unit);
    for (const identifier of new Set(contractIdentifiers(unit.text))) add(index.contractNumbers, identifier, unit);
  }
  index.literalFragments = [...fragments].map(([key, { unit, rows }]) => ({ key, unit, text: literalQuote(rows.join("\n")) }));
  index.ambiguousLotSources = ambiguousLotSources(units, dates);
  return index;
}
function ambiguousLotSources(units: SourceUnit[], dates: DateOccurrence[]): Map<string, EvidenceExcerpt[]> {
  const result = new Map<string, EvidenceExcerpt[]>();
  const lotHeadings = new Map<string, Map<string, SourceUnit>>();
  for (const unit of units) {
    const match = /^лот\s*(?:№\s*)?([\p{L}\d][\p{L}\d/_-]{0,30})(?=\s|[:—-]|$)/iu.exec(unit.text);
    if (!match || unit.text.length > 300) continue;
    const headings = lotHeadings.get(unit.sourceId) || new Map<string, SourceUnit>(); headings.set(normalize(match[1]), unit); lotHeadings.set(unit.sourceId, headings);
  }
  for (const [sourceId, headings] of lotHeadings) {
    if (headings.size < 2) continue;
    const deadlines = dates.filter((date) => date.unit.sourceId === sourceId && date.event === "submission-end");
    if (new Set(deadlines.map((date) => `${date.iso}:${date.time || ""}:${date.timezone || ""}`)).size < 2) continue;
    result.set(sourceId, [...headings.values()].slice(0, 3).map((unit) => excerpt(unit)));
  }
  return result;
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
  if (destination === "staff" && /^(?:basis(?:Other|Number)?|experienceYears|experienceNotes|phone|email)$/u.test(field)) return true;
  return /^(?:contact|decisionMaker|certificates|education|licenses|requirements)/u.test(field);
}
function financialSummaryPositionLabel(value: string): boolean {
  // Whole labels only: "Услуги по расчёту НДС" is a service, not a VAT total.
  const text = normalize(value).replace(/[.:]\s*$/u, "");
  return /^(?:показатель\s*(?:[/|:—-]\s*)?значение|ндс(?:\s+\d+(?:[.,]\d+)?\s*%)?|(?:итого|всего|итоговая\s+(?:цена|стоимость|сумма))(?:\s+(?:без|с)\s+ндс)?|(?:цена|стоимость|сумма)(?:\s+(?:услуг|работ|товаров?|предложения))?\s+(?:без|с)\s+ндс)$/u.test(text);
}
function groupedConditionHeading(value: string): boolean {
  const heading = value.trim();
  return /(?:один|одного|одним|одна|одно)\s+из[^\n]{0,200}:\s*$/iu.test(heading)
    || /^(?:\d+[.)]\s*)?(?:(?:только|исключительно)\s+для[^:\n]{1,160}|для\s+(?:не)?резидент[^:\n]{0,140}):\s*$/iu.test(heading);
}
function groupedConditionQuote(value: string): boolean {
  const rows = value.split(/\r?\n/u).filter((row) => row.trim());
  return rows.length > 1 && groupedConditionHeading(rows[0]);
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
  const clauses = roleClauses(unit.text);
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

const dateEvents: Array<[IntelligenceDateEvent, RegExp]> = [
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
const lowerExecutionBound = /(?:не\s+ранее|не\s+может\s+быть\s+(?:осуществлен[а-я]*|выполнен[а-я]*|начат[а-я]*)\s+ранее)\s*$/iu;
const upperExecutionBound = /не\s+позднее\s*$/iu;
// A sentence or table-row boundary ends an event. Dots inside calendar dates
// are not boundaries; a delivery in the next sentence cannot label a results date.
function temporalClauses(value: string): string[] { return value.split(/[;!?\n]|\.(?=\s|$)/u); }
function detectDateEvent(before: string, after: string): string {
  let last = -1; let event = "other";
  for (const [name, pattern] of dateEvents) {
    pattern.lastIndex = 0;
    for (const match of before.matchAll(pattern)) { if ((match.index ?? -1) >= last) { last = match.index ?? -1; event = name; } }
  }
  const delivery = [...before.matchAll(/поставк[а-я]*|выполнени[а-я\s]+работ/giu)].pop();
  if (delivery && (delivery.index ?? -1) >= last) {
    if (lowerExecutionBound.test(before)) return "execution-start";
    if (upperExecutionBound.test(before)) return "execution-end";
  }
  if (event !== "other") return event;
  let first = Infinity;
  for (const [name, pattern] of dateEvents) {
    pattern.lastIndex = 0;
    for (const match of after.matchAll(pattern)) if ((match.index ?? Infinity) < first) { first = match.index ?? Infinity; event = name; }
  }
  return event;
}
function timezoneCodes(value: string): string[] {
  return value.match(/(?<![\p{L}\d])(?:МСК|MSK|по\s+московскому\s+времени|UTC(?:[+-]\d{1,2}(?::\d{2})?)?|GMT(?:[+-]\d{1,2})?|[+-]\d{2}:\d{2})(?![\p{L}\d:+-])/giu) || [];
}
function canonicalTimezone(value: string): string {
  if (/^(?:мск|msk|по\s+московскому\s+времени)$/iu.test(value)) return "MSK";
  const match = /^(?:(?:UTC|GMT))?([+-])(\d{1,2})(?::(\d{2}))?$/iu.exec(value);
  if (match) {
    const minutes = (Number(match[2]) * 60 + Number(match[3] || 0)) * (match[1] === "-" ? -1 : 1);
    if (minutes === 180) return "MSK";
    if (!minutes) return "UTC";
    return `UTC${minutes < 0 ? "-" : "+"}${Math.floor(Math.abs(minutes) / 60)}:${String(Math.abs(minutes) % 60).padStart(2, "0")}`;
  }
  return /^(?:UTC|GMT)$/iu.test(value) ? "UTC" : value.toUpperCase();
}
function adjacentTimezones(value: string): string[] {
  const zones: string[] = []; let rest = value;
  // Only a zone immediately attached to this time (and optional equivalent
  // aliases) belongs to the event. A later revision's zone is not a fallback.
  for (let index = 0; index < 4; index++) {
    const match = /^\s*(?:[,/]\s*|(?:и|или)\s+)?\(?\s*(МСК|MSK|по\s+московскому\s+времени|UTC(?:[+-]\d{1,2}(?::\d{2})?)?|GMT(?:[+-]\d{1,2})?|[+-]\d{2}:\d{2})(?![\p{L}\d:+-])\)?/iu.exec(rest);
    if (!match) break;
    zones.push(canonicalTimezone(match[1])); rest = rest.slice(match[0].length);
  }
  return [...new Set(zones)];
}
function globalTimezoneDeclarations(value: string): Array<{ quote: string; zones: string[] }> {
  return temporalClauses(value).flatMap((quote) => {
    const text = normalize(quote);
    const document = "(?:в\\s+(?:(?:настоящем|данном|этом|всем)\\s+)?документе)";
    const subject = new RegExp(`(?:^|,\\s*)(?:${document}\\s+)?(?:время\\s+${document}|все\\s+даты\\s+и\\s+время(?:\\s+${document})?|все\\s+время(?:\\s+${document})?)(?=\\s+(?:указан[оы]|приведен[оы]|задан[оы]|по|в\\s))`, "u");
    const start = subject.exec(text); if (!start) return [];
    // An explicit common rule may follow a revision prefix, but that prefix's
    // own timezone must not become the timezone of the common declaration.
    const declaration = text.slice(start.index);
    if (/(?:^|\s)не\s+(?:в\s|указан|приведен|задан)/u.test(declaration)) return [];
    // Some text layers omit the space in the explicit phrase "поясеMSK".
    // Repair only that comparison boundary, never arbitrary word suffixes or
    // the literal provenance copied into the card.
    const zoneText = declaration.replace(/(часовом\s+поясе)(?=(?:МСК|MSK|UTC|GMT)(?!\p{L}))/giu, "$1 ");
    const zones = [...new Set(timezoneCodes(zoneText).map(canonicalTimezone))];
    return zones.length ? [{ quote: quote.trim(), zones }] : [];
  });
}
function sourceTimezones(units: SourceUnit[]): Map<string, { zones: string[]; evidence: EvidenceExcerpt[] }> {
  const sources = new Map<string, { zones: string[]; evidence: EvidenceExcerpt[] }>();
  for (const unit of units) {
    const declarations = globalTimezoneDeclarations(unit.text); if (!declarations.length) continue;
    const previous = sources.get(unit.sourceId) || { zones: [], evidence: [] };
    previous.zones = [...new Set([...previous.zones, ...declarations.flatMap((declaration) => declaration.zones)])];
    // Canonicalize only the comparison. Provenance keeps the complete literal
    // row (including punctuation), so copying it never fabricates a quotation.
    if (previous.evidence.length < 3) previous.evidence.push(excerpt(unit));
    sources.set(unit.sourceId, previous);
  }
  return sources;
}
const proposalHeading = /^коммерческое\s+предложение(?:\s*№\s*[\p{L}\d/._-]+)?\s*$/iu;
function outgoingDateRow(text: string): boolean {
  const dates = [...text.matchAll(calendarDatePattern())];
  if (dates.length !== 1) return false;
  const date = dates[0], before = text.slice(0, date.index), after = text.slice((date.index || 0) + date[0].length);
  return /^\s*(?:исх\.?|исходящ(?:ий|ее))\s*(?:№\s*[\p{L}\d/_.-]{1,80}\s*)?от\s*$/iu.test(before)
    && /^\s*(?:г(?:ода|\.)?)?\s*[.;]?\s*$/iu.test(after);
}
/** Outgoing letters are proposals only inside an explicit, bounded CP header
 * sequence. DOCX drops empty paragraphs, so numeric ID gaps alone are not a
 * boundary; selected-array gaps (hidden/table/other sheet) are. */
function outgoingProposalContexts(units: SourceUnit[]): { contexts: Map<number, EvidenceExcerpt>; limited: boolean } {
  const contexts = new Map<number, EvidenceExcerpt>(), sources = new Map<IntelligenceSource, Map<number, SourceUnit[]>>();
  for (const unit of units) {
    const fragments = sources.get(unit.source) || new Map<number, SourceUnit[]>(), rows = fragments.get(unit.sourceFragmentIndex) || [];
    rows.push(unit); fragments.set(unit.sourceFragmentIndex, rows); sources.set(unit.source, fragments);
  }
  let visited = 0;
  for (const [source, selected] of sources) {
    const aggregate = source.fragments === undefined, fragments = source.fragments || [{ locator: "Текст источника", text: source.text }];
    let active: { heading: EvidenceExcerpt; paragraphs: number; characters: number; sheet: string } | undefined;
    const last = Math.max(...selected.keys());
    for (let index = 0; index <= last; index++) {
      if (++visited > maxUnits) return { contexts, limited: true };
      const fragment = fragments[index]; if (!fragment) { active = undefined; continue; }
      const sheet = fragment.sheetId || "";
      const paragraph = aggregate || /^paragraph-\d+$/u.test(fragment.id || "") || /^Абзац\s+\d+$/iu.test(fragment.locator);
      if (!paragraph || !includedFragment(fragment) || fragment.sheetState === "hidden" || fragment.sheetState === "veryHidden") { active = undefined; continue; }
      if (active && (++active.paragraphs > 8 || active.sheet !== sheet)) active = undefined;
      for (const unit of selected.get(index) || []) {
        if (proposalHeading.test(unit.text)) { active = { heading: excerpt(unit), paragraphs: 1, characters: unit.text.length, sheet }; continue; }
        if (!active) continue;
        if (aggregate) active.paragraphs++;
        active.characters += unit.text.length;
        if (active.paragraphs > 8 || active.characters > 1000) { active = undefined; continue; }
        const outgoing = outgoingDateRow(unit.text);
        const newSection = /^(?:(?:договор|контракт|запрос|приложение|спецификация|уведомление|заявка|акт|соглашение|письмо|техническое\s+предложение)(?:[^\p{L}]|$)|(?:раздел|глава)\s+\d|(?:\d+[.)]\s*)?(?:условия\s+оплаты|порядок\s+оплаты|реквизиты|срок\s+действия)\s*[:.]?\s*$)/iu.test(unit.text);
        if (newSection || detectDateEvent(unit.text, "") !== "other" || calendarDatePattern().test(unit.text) && !outgoing) { active = undefined; continue; }
        if (outgoing) { contexts.set(unit.index, active.heading); active = undefined; }
      }
    }
  }
  return { contexts, limited: false };
}
function dateOccurrences(units: SourceUnit[]): { dates: DateOccurrence[]; limited: boolean } {
  const occurrences: DateOccurrence[] = [];
  const commonTimezones = sourceTimezones(units);
  const outgoing = outgoingProposalContexts(units);
  const proposalHeadings = new Map<number, number>();
  for (const unit of units) if (proposalHeading.test(unit.text)) proposalHeadings.set(unit.fragmentKey, Math.min(proposalHeadings.get(unit.fragmentKey) ?? Infinity, unit.index));
  for (const unit of units) {
    const regex = calendarDatePattern();
    const matches = unit.text.matchAll(regex); let previousEnd = 0, current = matches.next();
    while (!current.done) {
      if (occurrences.length >= maxDateOccurrences) return { dates: occurrences, limited: true };
      const match = current.value, next = matches.next();
      const start = match.index ?? 0;
      const iso = calendarIso(match), time = match[10];
      const end = start + match[0].length;
      const beforeRaw = unit.text.slice(Math.max(previousEnd, start - 150), start), afterRaw = unit.text.slice(end, Math.min(next.done ? unit.text.length : next.value.index ?? unit.text.length, end + 100));
      const beforeClauses = temporalClauses(beforeRaw); let before = beforeClauses[beforeClauses.length - 1] || "";
      const after = temporalClauses(afterRaw)[0].split("\t")[0];
      const date = new Date(`${iso}T00:00:00Z`), parts = time?.split(":").map(Number);
      const valid = standaloneCalendarDate(unit.text, match) && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === iso && (!parts || parts[0] <= 23 && parts[1] <= 59 && (parts[2] === undefined || parts[2] <= 59));
      let event = valid ? detectDateEvent(before, after) : "other";
      const prior = occurrences[occurrences.length - 1];
      if (valid && event === "other" && prior?.unit === unit && /^execution-(?:start|end)$/u.test(prior.event) && beforeClauses.length === 1) {
        if (lowerExecutionBound.test(before)) event = "execution-start";
        if (upperExecutionBound.test(before)) event = "execution-end";
      }
      // PDF text often wraps a label across two rows before its scalar value.
      // Never inherit across a locator or another dated row: unresolved layouts
      // remain unverified instead of borrowing a nearby event from another field.
      if (valid && event === "other" && !before.trim()) {
        const preceding: string[] = [];
        for (let index = unit.index - 1; index >= Math.max(0, unit.index - 3); index--) {
          const previous = units[index];
          if (previous.fragmentKey !== unit.fragmentKey || calendarDatePattern().test(previous.text)) break;
          preceding.unshift(previous.text);
        }
        before = preceding.join(" ");
        event = detectDateEvent(before, "");
      }
      if (valid && event === "other" && /^\s*дата\s*[:—-]\s*$/iu.test(before) && (proposalHeadings.get(unit.fragmentKey) ?? Infinity) < unit.index) {
        const previous = units[unit.index - 1];
        const previousEvent = previous?.fragmentKey === unit.fragmentKey ? detectDateEvent(previous.text, "") : "other";
        if (previousEvent === "other" || previousEvent === "proposal-date") event = "proposal-date";
      }
      if (event === "proposal-date" && /(?:^|\s)(?:ссылка\s+на|см\.|согласно|в\s+ответ\s+на|в\s+соответствии\s+с)(?=\s|$)/iu.test(beforeRaw)) event = "other";
      const heading = valid && event === "other" ? outgoing.contexts.get(unit.index) : undefined;
      if (heading) event = "proposal-date";
      const inlineZones = time ? adjacentTimezones(afterRaw) : [];
      const common = !inlineZones.length && time ? commonTimezones.get(unit.sourceId) : undefined;
      const zones = inlineZones.length ? inlineZones : common?.zones || [];
      occurrences.push({ iso, event, time, timezone: zones.length === 1 ? zones[0] : undefined, timezoneEvidence: common?.evidence, ...(heading ? { eventEvidence: [heading] } : {}), timezoneAmbiguous: zones.length > 1, lowerBound: event === "execution-start" && lowerExecutionBound.test(before), unit, quote: unit.text.slice(Math.max(0, start - 100), Math.min(unit.text.length, start + match[0].length + 100)) });
      previousEnd = end; current = next;
    }
  }
  return { dates: occurrences, limited: outgoing.limited };
}

/** Bounded, source-only date candidates for review. This reuses the audit's
 * parser without inferring unknown events, mutating a card or correcting model
 * output. A recognized event is provenance, not proof that it belongs to a
 * particular result/lot; a complete document or model answer is not guaranteed. */
export function extractIntelligenceDateFacts(sources: readonly IntelligenceSource[]): IntelligenceDateFacts {
  const material = createUnits(sources), parsed = dateOccurrences(material.units);
  const lots = ambiguousLotSources(material.units, parsed.dates);
  const facts: IntelligenceDateFact[] = [];
  for (const date of parsed.dates) {
    const event = dateEvents.find(([name]) => name === date.event)?.[0];
    if (!event) continue; // Invalid dates/times and unknown events stay unassigned.
    const lotEvidence = event === "submission-end" ? lots.get(date.unit.sourceId) : undefined;
    const supporting = [...(date.timezoneEvidence || []), ...(date.eventEvidence || []), ...(lotEvidence || [])]
      .filter((entry, index, all) => all.findIndex((other) => other.sourceId === entry.sourceId && other.fragmentId === entry.fragmentId && other.locator === entry.locator && other.quote === entry.quote) === index);
    facts.push({
      ...excerpt(date.unit, date.quote), iso: date.iso, event,
      ...(date.time ? { time: date.time } : {}),
      ...(date.timezone ? { timezone: date.timezone } : {}),
      ...(supporting.length ? { supportingEvidence: supporting.map((entry) => ({ ...entry })) } : {}),
      ...(date.timezoneAmbiguous || lotEvidence ? { ambiguous: true } : {}),
      ...(date.lowerBound ? { lowerBound: true } : {}),
    });
  }
  return { facts, limited: material.limited || parsed.limited };
}
type NoteTimeOccurrence = { iso?: string; event: string; time: string; zones: string[] };
function dateImmediatelyAfterTime(value: string): string | undefined {
  // Only a directly attached day belongs to this clock record. A later label
  // such as "дата редакции" starts another event, even in the same sentence.
  let rest = value;
  for (let index = 0; index < 4; index++) {
    const zone = /^\s*(?:[,/]\s*|(?:и|или)\s+)?\(?\s*(?:МСК|MSK|по\s+московскому\s+времени|UTC(?:[+-]\d{1,2}(?::\d{2})?)?|GMT(?:[+-]\d{1,2})?|[+-]\d{2}:\d{2})(?![\p{L}\d:+-])\)?/iu.exec(rest);
    if (!zone) break; rest = rest.slice(zone[0].length);
  }
  return /^\s*[,()]?\s*(\d{4}-\d{2}-\d{2}|\d{2}[./]\d{2}[./]\d{4})(?!\d)/u.exec(rest)?.[1];
}
function submissionNoteTimes(note: string): NoteTimeOccurrence[] {
  const records: NoteTimeOccurrence[] = [];
  const common = [...new Set(globalTimezoneDeclarations(note).flatMap((declaration) => declaration.zones))];
  for (const clause of temporalClauses(note)) {
    const matches = [...clause.matchAll(/(?<![\d:+-])\d{1,2}:\d{2}(?::\d{2})?(?![\d:])/gu)]; let previousEnd = 0;
    for (const match of matches) {
      if (records.length >= maxDateOccurrences) return records;
      const start = match.index ?? 0, end = start + match[0].length;
      const before = clause.slice(previousEnd, start), after = clause.slice(end);
      let event = detectDateEvent(before, "");
      if (event === "other" && /(?:^|[^\p{L}])(?:подача|время\s+подачи)(?!\p{L})/iu.test(before)) event = "submission-end";
      const dates = canonicalQuoteDates(before), hasDate = /\d{4}-\d{2}-\d{2}|\d{2}[./]\d{2}[./]\d{4}/u.test(before);
      const following = dateImmediatelyAfterTime(after), followingDates = following ? canonicalQuoteDates(following) : [];
      const explicitDates = [...new Set([...(hasDate ? [dates[dates.length - 1] || "invalid"] : []), ...(following ? [followingDates[0] || "invalid"] : [])])];
      const inline = adjacentTimezones(after);
      records.push({ event, time: match[0], iso: explicitDates.length > 1 ? "invalid" : explicitDates[0], zones: inline.length ? inline : common });
      previousEnd = end;
    }
  }
  return records;
}
function sameTime(left: string, right: string): boolean { return [...left.split(":"), "0"].slice(0, 3).map(Number).join(":") === [...right.split(":"), "0"].slice(0, 3).map(Number).join(":"); }
function roleMessage(role: Role): string { return role === "supplier" ? "поставщика / исполнителя" : role === "customer" ? "заказчика / организатора" : "внутреннего ответственного"; }

function overallAmounts(unit: SourceUnit): string[] {
  const text = unit.text;
  if (foreignCurrency.test(text) || /^[\d\s.,₽]+$/u.test(text) && foreignCurrency.test(unit.precedingContext) || unitPriceContext.test(text) || /(?:нмц|цен[а-я]*|стоимост[а-я]*)[^;\n]{0,30}не\s+(?:указан|определен|извест)/iu.test(text)) return [];
  if (!moneyContext.test(text)) return unit.numbers.length === 1 && /^[\d\s.,₽]+$/u.test(text) && primaryMoneyContext(unit.context) && (currency.test(unit.context) || /нмц/iu.test(unit.context)) ? unit.numbers : [];
  const matches = [...text.matchAll(/\d+(?:[ \u00a0\u202f]\d{3})*(?:[.,]\d+)?\s*(?:руб(?:\.|лей|ля)?|₽|\bRUB\b)/giu)];
  if (matches.length) {
    // An amount after VAT or another unlabeled component does not inherit the
    // earlier "total" label. Repeated totals each need their own explicit label.
    return matches.flatMap((match, index) => primaryMoneyContext(financialSentences(text.slice(index ? (matches[index - 1].index || 0) + matches[index - 1][0].length : 0, match.index)).pop() || "") ? numberTokens(match[0]) : []);
  }
  return financialSentences(text).flatMap((clause) => { const numbers = numberTokens(clause); return numbers.length === 1 && primaryNmcContext(clause) ? numbers : []; });
}
function splitRubleAmounts(text: string, label: RegExp): string[] {
  if (foreignCurrency.test(text) || unitPriceContext.test(text) || /не\s+(?:указан[аоы]?|определ[её]н[аоы]?|извест[а-я]*)/iu.test(text)) return [];
  const results: string[] = [];
  for (const match of text.matchAll(/\b(\d+(?:[ \u00a0\u202f]\d{3})*)(?:\s*\([^()\n]{1,500}\))?\s*руб(?:\.|лей|ля)?\s*,?\s*(\d{1,2})\s*коп(?:\.|еек|ейки|ейка)?/giu)) {
    const rawPrefix = text.slice(0, match.index).split(/[;\t]/u).pop() || "", prefix = label === nmcLabel ? financialSentences(rawPrefix).pop() || "" : rawPrefix;
    const marker = label.exec(prefix.replace(/[()]/gu, " "));
    if (!marker || label === nmcLabel && !primaryNmcContext(prefix) || /\d/u.test(prefix.replace(/[()]/gu, " ").slice(marker.index + marker[0].length))) continue;
    const amount = `${match[1].replace(/\s/gu, "")}.${match[2].padStart(2, "0")}`;
    if (Number(amount) <= 1e12) results.push(amount);
  }
  return results;
}
function labeledAmounts(unit: SourceUnit, label: RegExp, allowScalarContext = false): string[] {
  const text = unit.text.replace(/[()]/gu, " ");
  const missing = /не\s+(?:указан[аоы]?|определ[её]н[аоы]?|извест[а-я]*)/iu;
  if (foreignCurrency.test(text) || unitPriceContext.test(text) || label.test(text) && missing.test(text)) return [];
  const split = splitRubleAmounts(unit.text, label);
  if (split.length) return split;
  if (/руб(?:\.|лей|ля)?[^;\t\n]{0,50}\d+\s*коп/iu.test(text)) return [];
  const matches = [...text.matchAll(/\d+(?:[ \u00a0\u202f]\d{3})*(?:[.,]\d+)?\s*(?:руб(?:\.|лей|ля)?|₽|\bRUB\b)/giu)];
  const amounts = matches.flatMap((match, index) => {
    const rawPrefix = text.slice(index ? (matches[index - 1].index || 0) + matches[index - 1][0].length : 0, match.index).split(/[;\t]/u).pop() || "", prefix = label === nmcLabel ? financialSentences(rawPrefix).pop() || "" : rawPrefix;
    const marker = label.exec(prefix);
    // A percentage/other amount between the label and this amount makes its
    // relation ambiguous ("our share 20% of a 100000-ruble total" is not 100000).
    return marker && (label !== nmcLabel || primaryNmcContext(prefix)) && !/\d/u.test(prefix.slice((marker.index || 0) + marker[0].length)) ? numberTokens(match[0]) : [];
  });
  if (amounts.length) return amounts;
  if (matches.length && !/^[\d\s.,]+(?:руб(?:\.|лей|ля)?|₽|RUB)\s*$/iu.test(text)) return [];
  if (!matches.length && label === nmcLabel) {
    const amounts = financialSentences(text).flatMap((clause) => { const numbers = numberTokens(clause); return numbers.length === 1 && primaryNmcContext(clause) ? numbers : []; });
    if (amounts.length) return amounts;
  }
  if (!matches.length && unit.numbers.length === 1 && label !== nmcLabel && label.test(text)) return unit.numbers;
  const preceding = unit.precedingContext.replace(/[()]/gu, " ");
  return allowScalarContext && unit.numbers.length === 1 && /^[\d\s.,₽]+(?:руб(?:\.|лей|ля)?|RUB)?\s*$/iu.test(text)
    && label.test(preceding) && (label !== nmcLabel || primaryNmcContext(preceding)) && !unitPriceContext.test(preceding) && !missing.test(preceding) && !foreignCurrency.test(preceding)
    && !/(?:инн|кпп|огрн|ндс|кол-во|количество|телефон)/iu.test(preceding) ? unit.numbers : [];
}
function explicitLegalNames(units: SourceUnit[]): Array<{ kind: "full" | "short"; value: string; unit: SourceUnit }> {
  const names: Array<{ kind: "full" | "short"; value: string; unit: SourceUnit }> = [];
  for (const unit of units) for (const match of unit.text.matchAll(/(?:^|[;\t])\s*(полное|краткое|сокращ[её]нное)\s+(?:(?:юридическое|фирменное|официальное)\s+)?(?:наименование|название)(?:\s+(?:юридического\s+лица|организации|компании))?\s*[:—-]\s*([^;\t\n]+)/giu)) {
    names.push({ kind: /^полное$/iu.test(match[1]) ? "full" : "short", value: normalize(match[2]).replace(/[.,]\s*$/u, ""), unit });
  }
  return names;
}
function wrappedAddressMatches(units: SourceUnit[], values: string[], index: UnitIndex): SourceUnit[] {
  const results: SourceUnit[] = [];
  const addressHeading = /(?:^|[^\p{L}])(?:адрес(?:\s+местонахождения|\s+места\s+нахождения|\s+поставщика|\s+покупателя|\s+заказчика|\s+поставки)?|место\s+нахождения)\s*[:—-]/iu;
  const newField = /(?:^|[^\p{L}])(?:адрес|почтовый\s+адрес|место\s+нахождения|инн|кпп|огрн|телефон|факс|банк|банковские\s+реквизиты|контакт|наименование|e[.-]?mail)\s*(?:[^:]{0,40}:|$)/iu;
  for (let position = 0; position < units.length; position++) {
    const first = units[position];
    if (!addressHeading.test(first.text) || first.text.includes("\t")) continue;
    const rows = [first.text];
    for (let step = 1; step < 4 && position + step < units.length; step++) {
      const next = units[position + step];
      if (next.fragmentKey !== first.fragmentKey || next.text.includes("\t") || newField.test(next.text) || lineRole(next.text) !== "unknown" || /^\d{6}(?:\D|$)/u.test(next.text) || rows.join("\n").length + next.text.length > 1800) break;
      rows.push(next.text);
      const text = rows.join("\n");
      if (values.some((value) => includesPhrase(text, value))) {
        results.push({ ...first, text, quote: text, normalizedText: normalize(text), numbers: numberTokens(text) });
        break;
      }
    }
    if (results.length >= maxCandidateUnits) { index.limited = true; break; }
  }
  return results;
}
function ambiguousLotDeadline(value: IntelligenceFieldValue, dates: DateOccurrence[], index: UnitIndex): boolean {
  return typeof value === "string" && dates.some((date) => date.iso === value && date.event === "submission-end" && index.ambiguousLotSources.has(date.unit.sourceId));
}

/** A bounded field-role check, not a legal classifier. A neighbouring license
 * or a regulator mentioned as a document recipient cannot license a different
 * list entry. Ambiguous mixed document entries stay available for review. */
function hasLicensingRole(value: string): boolean {
  const text = normalize(withoutListIndex(value));
  const explicitLicense = /(?<!\p{L})лицензи[а-я]*(?!\p{L})/iu.exec(text);
  const licensing = explicitLicense || /(?<!\p{L})(?:фстэк|фсб|тзки)(?!\p{L})/iu.exec(text);
  if (!licensing) return false;
  const otherDocument = /(?<!\p{L})(?:доверенност[а-я]*|декларац[а-я]*|сертификат[а-я]*)(?!\p{L})/iu.exec(text);
  // A regulator is not a document type, regardless of its word order. Prefer
  // the explicit license noun when present; a declaration about obtaining a
  // license is still a declaration, not the license itself.
  if (otherDocument && (!explicitLicense || otherDocument.index < explicitLicense.index)) return false;
  // "License ... signed by a representative under a power of attorney" is
  // still a license. A separately enumerated declaration/authorization is not.
  return !/(?:[;,\n]|\s+(?:и|или|либо)\s+)\s*(?:\d+[.)]\s*)?(?:копи[яиюй]\s+)?(?:доверенност[а-я]*|декларац[а-я]*|сертификат[а-я]*)(?!\p{L})/iu.test(value);
}

/** Only explicit name slots, table first cells and standalone person headings.
 * This is not NER: initials, inflected names and detached pages need review. */
function explicitPersonName(value: string): string | undefined {
  const text = withoutListIndex(value), cells = text.split("\t");
  const label = /^(?:ф\.?\s*и\.?\s*о\.?|сотрудник|специалист|владелец\s+сертификата)(?=\s|[:—-]|$)\s*[:—-]?\s*/iu;
  let slot = label.test(cells[0]) ? cells[0].replace(label, "") || cells[1] || "" : cells[0];
  if (cells.length > 1 && /^\d+[.)]?$/u.test(slot.trim())) slot = cells[1];
  slot = slot.trim().replace(/[.;:]$/u, "");
  return /^(?:\p{Lu}\p{Ll}+(?:[-'’]\p{Lu}?\p{Ll}+)*)(?:\s+\p{Lu}\p{Ll}+(?:[-'’]\p{Lu}?\p{Ll}+)*){1,3}$/u.test(slot) ? normalize(slot) : undefined;
}

/** Profile facts need their own bounded owner scope. The older certificate /
 * cooperation-basis index deliberately retains its existing narrower rules. */
function staffProfileOwners(units: SourceUnit[]): Map<number, StaffProfileBinding> {
  const result = new Map<number, StaffProfileBinding>(), sources = new Map<string, IntelligenceSource>(), duplicateSources = new Set<string>();
  for (const unit of units) {
    const previous = sources.get(unit.sourceId);
    if (previous && previous !== unit.source) duplicateSources.add(unit.sourceId); else sources.set(unit.sourceId, unit.source);
  }
  const coordinate = (unit: SourceUnit): { kind: string; number: number } | undefined => {
    const paragraph = /^paragraph-(\d+)$/iu.exec(unit.fragmentId || "") || /^Абзац\s+(\d+)$/iu.exec(unit.locator);
    if (paragraph) return { kind: "paragraph", number: Number(paragraph[1]) };
    const table = /^(table(?:-\d+)?)-row-(\d+)$/iu.exec(unit.fragmentId || "");
    return table ? { kind: table[1], number: Number(table[2]) } : undefined;
  };
  const adjacent = (left: SourceUnit, right: SourceUnit) => {
    if (left.source !== right.source || left.source.fragments?.[left.sourceFragmentIndex]?.sheetId !== right.source.fragments?.[right.sourceFragmentIndex]?.sheetId) return false;
    if (left.fragmentKey === right.fragmentKey) return true;
    const previous = coordinate(left), next = coordinate(right);
    return right.sourceFragmentIndex === left.sourceFragmentIndex + 1 && previous && next && previous.kind === next.kind && next.number === previous.number + 1;
  };
  let active: StaffProfileBinding | undefined, previous: SourceUnit | undefined, rows = 0, characters = 0;
  const labelledName = /^(?:ф\.?\s*и\.?\s*о\.?|сотрудник|специалист|владелец\s+сертификата)(?=\s|[:—-]|$)/iu;
  const continuation = /^(?:должность|роль|телефон|тел\.|мобильный(?:\s+телефон)?|e-?mail|электронная\s+почта|почта|опыт(?:\s+работы)?|стаж(?:\s+работы)?|описание\s+опыта|проекты|образование|учебное\s+заведение|вуз|диплом|специальность|квалификация)\s*[:\t—-]/iu;
  for (const unit of units) {
    if (previous && !adjacent(previous, unit)) active = undefined;
    previous = unit;
    if (duplicateSources.has(unit.sourceId) || unit.sheetState === "hidden" || unit.sheetState === "veryHidden") { active = undefined; continue; }
    const text = withoutListIndex(unit.text), name = explicitPersonName(unit.text);
    if (name) {
      const binding: StaffProfileBinding = { names: [name], unit }; result.set(unit.index, binding);
      // A horizontal person row owns its cells, not the next unlabelled row.
      active = !text.includes("\t") || labelledName.test(text) ? binding : undefined;
      rows = 0; characters = text.length; continue;
    }
    const shared = /^общие\s+контакты\s+(?:для\s+)?(?:сотрудников|специалистов)\s*:\s*(.+)$/iu.exec(text);
    if (shared) {
      const names = shared[1].split(";").map((part) => explicitPersonName(part.trim()));
      active = names.length >= 2 && names.length <= 10 && names.every(Boolean) ? { names: names as string[], unit, sharedContacts: true } : undefined;
      rows = 0; characters = text.length; continue;
    }
    if (!active) continue;
    rows++; characters += text.length;
    if (rows > 6 || characters > 2000 || !continuation.test(text) || obligationPattern.test(text.replace(continuation, ""))) { active = undefined; continue; }
    if (active.sharedContacts && !/^(?:телефон|тел\.|мобильный(?:\s+телефон)?|e-?mail|электронная\s+почта|почта)\s*[:\t—-]/iu.test(text)) { active = undefined; continue; }
    result.set(unit.index, active);
  }
  return result;
}

function staffProfileText(unit: SourceUnit): string {
  const foreign = /(?<!\p{L})(?:контакт(?:ы|ное\s+лицо)?|телефон|e-?mail|почта|цитата|комментарий|образование|диплом|квалификация)\s+(?:менеджера|координатора|заказчика|поставщика|другого\s+(?:сотрудника|специалиста))(?=$|[^\p{L}])/iu.exec(unit.text);
  return foreign ? unit.text.slice(0, foreign.index) : unit.text;
}

/** Education is a separate source role, not every literal string owned by an
 * employee. Only an explicit cell/label or actual academic-document context
 * qualifies; experience, courses and certificates do not imply a degree. */
function staffEducationCells(units: SourceUnit[]): Map<number, StaffEducationBinding> {
  const result = new Map<number, StaffEducationBinding>();
  const label = /^(?:образование|учебное\s+заведение|вуз|диплом|специальность|квалификация)(?:\s*\([^)]{0,100}\))?\s*(?:[:—-]|$)/iu;
  const academic = (cell: string) => !/^(?:опыт|стаж|проекты|работа)(?=$|[^\p{L}])/iu.test(cell) && !/(?:сертификат|курс|семинар|тренинг)/iu.test(cell) && (/^диплом(?=$|[^\p{L}])/iu.test(cell) || /(?:университет|институт|академи[яи])[^\t:]{0,160}(?:квалификаци|специальност|бакалавр|магистр|инженер)/iu.test(cell));
  const adjacent = (left: SourceUnit, right: SourceUnit) => {
    if (left.source !== right.source || left.source.fragments?.[left.sourceFragmentIndex]?.sheetId !== right.source.fragments?.[right.sourceFragmentIndex]?.sheetId) return false;
    if (left.fragmentKey === right.fragmentKey) return right.index === left.index + 1;
    const a = /^(table(?:-\d+)?)-row-(\d+)$/u.exec(left.fragmentId || ""), b = /^(table(?:-\d+)?)-row-(\d+)$/u.exec(right.fragmentId || "");
    return Boolean(a && b && a[1] === b[1] && Number(b[2]) === Number(a[2]) + 1 && right.sourceFragmentIndex === left.sourceFragmentIndex + 1);
  };
  let header: { unit: SourceUnit; previous: SourceUnit; column: number; columns: number } | undefined;
  for (const unit of units) {
    if (header && !adjacent(header.previous, unit)) header = undefined;
    if (unit.sheetState === "hidden" || unit.sheetState === "veryHidden") { header = undefined; continue; }
    const cells = staffProfileText(unit).split("\t").map((cell) => cell.trim()), column = cells.findIndex((cell) => label.test(cell));
    if (cells.some((cell) => /^(?:фио|ф\.?\s*и\.?\s*о\.?)$/iu.test(cell)) && column >= 0) { header = { unit, previous: unit, column, columns: cells.length }; continue; }
    const own = cells.filter((cell) => label.test(cell) || academic(cell));
    if (header) {
      if (cells.length !== header.columns || !explicitPersonName(unit.text)) header = undefined;
      else { own.push(cells[header.column]); header.previous = unit; }
    }
    if (own.length) result.set(unit.index, { cells: own, ...(header ? { header: header.unit } : {}) });
  }
  return result;
}

/** Explicit academic-document owners override the first person in a table row.
 * This intentionally does not resolve initials, inflection or arbitrary NER:
 * an unresolved owner remains reviewable instead of inheriting the row FIO. */
function staffEducationOwners(cell: string): { names: string[]; unknown: boolean } {
  const result = { names: [] as string[], unknown: false };
  const head = (offset: number) => cell.slice(offset).split(/[:;,\t\r\n]/u, 1)[0].trim();
  const accept = (value: string) => {
    if (!value || value.length > 200) { result.unknown = true; return; }
    const name = explicitPersonName(value);
    if (name) result.names.push(name); else result.unknown = true;
  };
  const role = /(?<!\p{L})(?:диплом|образование|квалификация)(?!\p{L})/giu;
  let count = 0;
  for (const match of cell.matchAll(role)) {
    if (++count > 20) { result.unknown = true; break; }
    const prefix = head(match.index! + match[0].length);
    if (!prefix || /^(?:о\s+(?:высшем|среднем)(?:\s+профессиональном)?\s+образовании|о\s+профессиональной\s+переподготовке|бакалавр[а]?|магистр[а]?|специалист[а]?|инженер[а]?|высшее|среднее(?:\s+профессиональное)?|№\s*[\p{L}\d][\p{L}\d/._-]{0,79})$/iu.test(prefix)) continue;
    accept(prefix.replace(/^(?:(?:на\s+имя|выдан[ао]?|получен[ао]?)\s+){1,3}/iu, ""));
  }
  const owner = /(?<!\p{L})(?:владелец(?:\s+(?:диплома|документа))?|фио\s+(?:владельца|получателя)(?:\s+(?:диплома|документа))?|на\s+имя|выдан[ао]?)(?!\p{L})\s*[:—-]?\s*/giu;
  for (const match of cell.matchAll(owner)) {
    if (++count > 20) { result.unknown = true; break; }
    accept(head(match.index! + match[0].length).replace(/^на\s+имя\s+/iu, ""));
  }
  return result;
}

function staffEducationField(item: IntelligenceItem, values: string[], matches: SourceUnit[], index: UnitIndex): FieldEvidenceStatus {
  const name = typeof item.fields.fullName === "string" ? normalize(item.fields.fullName) : "";
  const proofs = values.filter((value) => value.trim()).map((value) => {
    const literal = matches.filter((unit) => includesPhrase(staffProfileText(unit), value));
    const cells = (unit: SourceUnit) => index.staffEducationCells.get(unit.index)?.cells.filter((cell) => includesPhrase(cell, value)) || [];
    const owned = literal.filter((unit) => {
      const owner = index.staffProfileOwners.get(unit.index);
      return name && owner?.names.includes(name) && !owner.sharedContacts && cells(unit).some((cell) => {
        const explicit = staffEducationOwners(cell);
        return !obligationPattern.test(cell) && !explicit.unknown && explicit.names.every((person) => person === name);
      });
    });
    const foreignOwner = literal.some((unit) => cells(unit).some((cell) => staffEducationOwners(cell).names.some((person) => person !== name)));
    return { literal, owned, foreignOwner };
  });
  const confirmed = proofs.length > 0 && proofs.every((proof) => proof.owned.length > 0);
  const contradictory = proofs.some((proof) => !proof.owned.length && (proof.foreignOwner || proof.literal.some((unit) => { const owner = index.staffProfileOwners.get(unit.index); return owner && !owner.names.includes(name); })));
  const evidence = proofs.flatMap((proof) => (proof.owned.length ? proof.owned : proof.literal).flatMap((unit) => {
    const owner = index.staffProfileOwners.get(unit.index)?.unit, header = index.staffEducationCells.get(unit.index)?.header;
    return [owner, header, unit].filter((entry): entry is SourceUnit => Boolean(entry)).map((entry) => excerpt(entry));
  })).filter((entry, position, all) => all.findIndex((other) => other.sourceId === entry.sourceId && other.fragmentId === entry.fragmentId && other.quote === entry.quote) === position).slice(0, 3);
  return { itemId: item.id, field: "education", status: confirmed ? "confirmed" : contradictory ? "conflict" : "unverified", message: confirmed
    ? "Текст найден в явно обозначенном образовании / академическом документе именно этого сотрудника. Уровень образования, подлинность и полнота отдельно не устанавливаются."
    : "Дословное наличие текста не подтверждает образование этого сотрудника. Нужны собственный явно обозначенный столбец / блок образования или академический документ; опыт, проекты, сертификаты и курсы сами по себе не подтверждают высшее образование. Исходные значения не изменены.", evidence };
}

function staffExperienceYears(text: string): string[] {
  return [...text.matchAll(/(?<![\p{L}\d])(\d{1,3}(?:[.,]\d+)?)\s*(?:лет|года?|год)(?=$|[^\p{L}])/giu)].flatMap((match) => {
    const start = match.index || 0, before = text.slice(Math.max(0, start - 80), start).split("\t").pop() || "", after = text.slice(start + match[0].length, start + match[0].length + 40);
    if (/(?:за|в\s+течение|последние)\s*$/iu.test(before)) return [];
    return /(?:опыт|стаж)(?:\s+работы)?\s*[:—-]?\s*(?:(?:более|свыше|около|не\s+менее)\s*)?$/iu.test(before) || /^\s*(?:опыта?|стажа|работы|в(?=\s|$))(?=$|[^\p{L}])/iu.test(after) ? [match[1].replace(",", ".")] : [];
  });
}

function staffProfileField(item: IntelligenceItem, field: string, values: string[], matches: SourceUnit[], index: UnitIndex): FieldEvidenceStatus {
  const name = typeof item.fields.fullName === "string" ? normalize(item.fields.fullName) : "", contacts = field === "phone" || field === "email";
  const proofs = values.filter((value) => value.trim()).map((value) => {
    const literal = matches.filter((unit) => field === "experienceYears" ? staffExperienceYears(staffProfileText(unit)).some((years) => sameNumber(years, value)) : includesPhrase(staffProfileText(unit), value));
    const owned = literal.filter((unit) => {
      const owner = index.staffProfileOwners.get(unit.index);
      return name && owner?.names.includes(name) && (contacts || !owner.sharedContacts) && !obligationPattern.test(unit.text);
    });
    return { literal, owned };
  });
  const confirmed = proofs.every((proof) => proof.owned.length > 0), contradictory = proofs.some((proof) => !proof.owned.length && proof.literal.some((unit) => {
    const owner = index.staffProfileOwners.get(unit.index); return owner && !owner.names.includes(name);
  }));
  const evidence = proofs.flatMap((proof) => (proof.owned.length ? proof.owned : proof.literal).flatMap((unit) => {
    const owner = index.staffProfileOwners.get(unit.index)?.unit; return owner && owner !== unit ? [excerpt(owner), excerpt(unit)] : [excerpt(unit)];
  })).filter((entry, position, all) => all.findIndex((other) => other.sourceId === entry.sourceId && other.fragmentId === entry.fragmentId && other.quote === entry.quote) === position).slice(0, 3);
  return { itemId: item.id, field, status: confirmed ? "confirmed" : contradictory ? "conflict" : "unverified", message: confirmed
    ? "Значение дословно найдено в явной строке или ограниченном блоке этого сотрудника. Для общих контактов сотрудник должен быть явно перечислен. Это не проверка подлинности или полноты сведений."
    : "Наличие стажа, проектов или контактов в общем документе не подтверждает их принадлежность этому сотруднику. Проверьте ФИО и владельца сведений; контакты менеджера и опыт другого специалиста не подтверждают карточку. Исходные значения не изменены.", evidence };
}

function matchesStaffValue(unit: SourceUnit, value: string): boolean {
  // The legal status ИП is an explicit two-letter choice, not a substring in
  // "КИП". Do not lower the generic three-character matcher for other fields.
  return matchesUnit(unit, value) || normalize(value) === "ип" && unit.normalizedText.split(/[^\p{L}\d_-]+/u).includes("ип");
}

function staffOwnedField(item: IntelligenceItem, field: string, values: string[], matches: SourceUnit[], index: UnitIndex): FieldEvidenceStatus {
  const name = typeof item.fields.fullName === "string" ? normalize(item.fields.fullName) : "";
  const proofs = values.filter((entry) => entry.trim()).map((value) => {
    const literal = matches.filter((unit) => matchesStaffValue(unit, value));
    const owned = literal.filter((unit) => name && index.staffOwners.get(unit.index)?.name === name && !obligationPattern.test(unit.text));
    return { literal, owned };
  });
  const confirmed = proofs.every((proof) => proof.owned.length > 0);
  const contradictory = proofs.some((proof) => !proof.owned.length && proof.literal.some((unit) => index.staffOwners.has(unit.index) && index.staffOwners.get(unit.index)!.name !== name));
  const evidence = proofs.flatMap((proof) => (proof.owned.length ? proof.owned : proof.literal).flatMap((unit) => {
    const owner = index.staffOwners.get(unit.index)?.unit;
    return owner && owner !== unit ? [excerpt(owner), excerpt(unit)] : [excerpt(unit)];
  })).filter((entry, position, all) => all.findIndex((other) => other.sourceId === entry.sourceId && other.fragmentId === entry.fragmentId && other.quote === entry.quote) === position).slice(0, 3);
  return { itemId: item.id, field, status: confirmed ? "confirmed" : contradictory ? "conflict" : "unverified", message: confirmed
    ? "Значение дословно найдено в явной строке или ограниченном блоке указанного сотрудника. Это не проверка подлинности документа."
    : "Наличие сведений в общем документе не подтверждает их принадлежность этому сотруднику. Проверьте ФИО и владельца каждого сертификата / основания сотрудничества; чужие данные и общие требования команды не подтверждают карточку. Исходные значения не изменены.", evidence };
}

/** A final, lowering-only owner boundary for every staff value. Specialized
 * date/event, education, certificate and experience checks must have succeeded
 * first; an owned substring can never turn their failures into confirmation.
 * Model claims/receipts are not owner facts. Every nonempty list entry needs
 * its own current literal row or explicitly bounded person block. */
function staffOwnershipGate(item: IntelligenceItem, result: FieldEvidenceStatus, value: IntelligenceFieldValue, units: SourceUnit[], dates: DateOccurrence[], index: UnitIndex): FieldEvidenceStatus | undefined {
  if (item.destination !== "staff" || result.field === "fullName" || result.status !== "confirmed") return undefined;
  const field = result.field, name = typeof item.fields.fullName === "string" ? normalize(item.fields.fullName) : "";
  const legacyOwner = /^(?:certificates|basis(?:Other|Number)?)$/u.test(field), contacts = field === "phone" || field === "email";
  const owner = (unit: SourceUnit): StaffProfileBinding | undefined => {
    if (unit.sheetState === "hidden" || unit.sheetState === "veryHidden") return undefined;
    const previous = legacyOwner ? index.staffOwners.get(unit.index) : undefined;
    return previous ? { names: [previous.name], unit: previous.unit } : index.staffProfileOwners.get(unit.index);
  };
  const proofs = strings(value).filter((entry) => entry.trim()).map((entry) => {
    const calendar = /(?:Date)$|^(?:availableFrom|availableTo)$/u.test(field) && /^\d{4}-\d{2}-\d{2}$/u.test(entry);
    // Date/event proof must belong to the same row, not an equal date in the
    // target person's unrelated publication beside another employee's works.
    const dateUnits = calendar ? dates.filter((date) => date.iso === entry && (!expectedDateEvents[field] || expectedDateEvents[field].includes(date.event))).map((date) => date.unit) : [];
    const candidates = calendar ? [...new Set(dateUnits)] : legacyOwner && normalize(entry) === "ип" ? units.filter((unit) => matchesStaffValue(unit, entry)) : candidatesFor(typeof value === "number" ? value : entry, index);
    if (candidates.length > maxCandidateUnits) index.limited = true;
    const literal = candidates.slice(0, maxCandidateUnits).filter((unit) => {
      const text = staffProfileText(unit);
      if (calendar) return canonicalQuoteDates(text).includes(entry);
      if (typeof value === "number") return field === "experienceYears" ? staffExperienceYears(text).some((years) => sameNumber(years, entry)) : hasNumber(text, value);
      return includesPhrase(text, entry) || legacyOwner && normalize(entry) === "ип" && normalize(text).split(/[^\p{L}\d_-]+/u).includes("ип");
    });
    const owned = literal.filter((unit) => {
      const binding = owner(unit);
      // The noun «Должность» is a profile label, not the obligation «должен».
      const profileText = unit.text.replace(/(?<!\p{L})должность(?!\p{L})/giu, "");
      return name && binding?.names.includes(name) && (contacts || !binding.sharedContacts) && !obligationPattern.test(profileText);
    });
    return { literal, owned };
  });
  const excerpts = (matches: SourceUnit[]) => matches.flatMap((unit) => {
    const heading = owner(unit)?.unit; return heading && heading !== unit ? [excerpt(heading), excerpt(unit)] : [excerpt(unit)];
  }).filter((entry, position, all) => all.findIndex((other) => other.sourceId === entry.sourceId && other.fragmentId === entry.fragmentId && other.quote === entry.quote) === position).slice(0, 3);
  if (proofs.length && proofs.every((proof) => proof.owned.length)) return { ...result, evidence: excerpts(proofs.flatMap((proof) => proof.owned)) };
  const contradictory = proofs.some((proof) => !proof.owned.length && proof.literal.some((unit) => {
    const binding = owner(unit); return binding && !binding.names.includes(name);
  }));
  const evidence = excerpts(proofs.filter((proof) => !proof.owned.length).flatMap((proof) => proof.literal));
  return { itemId: item.id, field, status: contradictory ? "conflict" : "unverified", message: contradictory
    ? "Значение найдено у другого сотрудника, но не подтверждено собственной строкой указанного ФИО. Для списка требуется связь каждого значения с этим сотрудником. Проверьте владельца сведений; исходные значения и ссылки не изменены."
    : "Значение найдено в общем источнике, но его принадлежность этому сотруднику не подтверждена явной строкой или ограниченным блоком ФИО. Требуется отдельная проверка владельца каждого значения; исходные сведения не изменены.", evidence };
}

type TemporalNoteIssue = Pick<FieldEvidenceStatus, "status" | "message" | "evidence">;
/** Operational claims inside notes do not evade the date/event gate merely
 * because the structured deadline is empty. Unknown prose stays advisory. */
function procurementNoteIssue(item: IntelligenceItem, dates: DateOccurrence[]): TemporalNoteIssue | undefined {
  const note = item.fields.notes; if (typeof note !== "string" || !note.trim()) return undefined;
  const material = createUnits([{ id: "note", name: "Примечания карточки", text: note }]), parsed = dateOccurrences(material.units);
  const issue = (related: DateOccurrence[], message: string): TemporalNoteIssue => ({ status: related.length ? "conflict" : "unverified", message, evidence: related.slice(0, 3).map((date) => excerpt(date.unit, date.quote)) });
  if (material.limited || parsed.limited) return issue([], "Примечания превышают предел точной проверки дат. Проверьте операционные сроки перед переносом; автоматическое подтверждение не выполнено.");
  const relevant = /^(?:submission-(?:start|end)|question-deadline|publication|execution-(?:start|end))$/u;
  for (const date of parsed.dates) {
    let event = date.event;
    const dateStart = date.unit.text.search(/\d{4}-\d{2}-\d{2}|\d{2}[./]\d{2}[./]\d{4}/u);
    if (event === "other" && dateStart >= 0 && /(?:^|[^\p{L}])подача\s*(?:до\s*)?[:—-]?\s*$/iu.test(date.unit.text.slice(0, dateStart))) event = "submission-end";
    if (!relevant.test(event)) continue;
    const same = dates.filter((candidate) => candidate.iso === date.iso), correct = same.filter((candidate) => candidate.event === event);
    if (!correct.length) return issue(same, "Примечания утверждают календарный срок события, которого выбранные источники не подтверждают. Не подменяйте подачу окном поставки, дату публикации редакцией или неизвестное время концом дня. Исправьте утверждение либо явно подтвердите его по источнику.");
    if (date.time && !correct.some((candidate) => candidate.time && sameTime(candidate.time, date.time!) && !date.timezoneAmbiguous && (!date.timezone || candidate.timezone && canonicalTimezone(candidate.timezone) === canonicalTimezone(date.timezone)))) return issue(correct, "Время или часовой пояс в примечаниях не подтверждены для того же события и даты. Не достраивайте 23:59:59 или часовой пояс по умолчанию; уточните их по документу.");
  }
  for (const record of submissionNoteTimes(note).filter((entry) => entry.event === "submission-end")) {
    const selected = item.selectedFields.includes("submissionDeadline") && typeof item.fields.submissionDeadline === "string" ? item.fields.submissionDeadline : undefined;
    const iso = record.iso || selected;
    const related = dates.filter((date) => (!iso || date.iso === iso) && date.event === "submission-end");
    if (!related.some((date) => date.time && sameTime(date.time, record.time) && record.zones.length <= 1 && (!record.zones.length || date.timezone && record.zones[0] === canonicalTimezone(date.timezone)))) return issue(related, "Указанное в примечаниях время подачи / часовой пояс не подтверждено источником для этого события. Это требует решения перед переносом, даже если отдельное поле срока не заполнено.");
  }
  return undefined;
}

function fieldStatus(item: IntelligenceItem, field: string, value: IntelligenceFieldValue, units: SourceUnit[], dates: DateOccurrence[], index: UnitIndex): FieldEvidenceStatus {
  const values = strings(value), normalizedValues = values.map(normalize); const selectedRole = expectedRole(item.destination, field);
  if (values.some((entry) => placeholders.test(normalize(entry)) || genericPlaceholders.test(normalize(entry)))) return { itemId: item.id, field, status: "placeholder", message: "Это заглушка отсутствующих сведений, а не подтверждённый факт. Укажите фактическое значение или исключите поле.", evidence: [] };
  if ((field === "name" || field === "title") && normalizedValues.some((entry) => index.sourceNames.has(entry))) return { itemId: item.id, field, status: "placeholder", message: "Имя файла не подтверждает название закупки или карточки. Укажите название по содержанию.", evidence: [] };
  if (item.destination === "proposals" && field === "lineDescriptions") {
    const descriptions = values.filter((entry) => entry.trim());
    const proofs = descriptions.map((description) => {
      const literalDescription = literalQuote(description);
      const candidates = candidatesFor(description, index), keys = new Set(candidates.map((unit) => unit.fragmentKey));
      const hasTokens = /[\p{L}\d+_-]{3,}/u.test(normalize(description));
      const fragments = keys.size ? index.literalFragments.filter((fragment) => keys.has(fragment.key)) : hasTokens ? [] : index.literalFragments;
      if (fragments.length > maxCandidateUnits) index.limited = true;
      return { description, match: fragments.slice(0, maxCandidateUnits).find((fragment) => fragment.text.includes(literalDescription)) };
    });
    const confirmed = proofs.every((proof) => proof.match);
    return { itemId: item.id, field, status: confirmed ? "confirmed" : "unverified", message: confirmed ? "Каждое непустое описание дословно найдено в одном выбранном фрагменте. Это не подтверждает соответствие описания конкретной SKU или полноту комплектации." : "Полное дословное описание не найдено в одном выбранном фрагменте. Не объединяйте части разных страниц, листов или источников без проверки.", evidence: proofs.filter((proof) => proof.match).slice(0, 3).map((proof) => excerpt(proof.match!.unit, proof.description)) };
  }
  if (item.destination === "procurement" && field === "subject" && typeof value === "string" && /\r?\n/u.test(value)) {
    // A wrapped, explicitly labelled subject is one literal fragment, not two
    // independent sentences to stitch together using global substring matches.
    const fragments = index.literalFragments.filter((fragment) => {
      const match = /^Предмет\s+закупки\s*:\s*(\S[\s\S]*)$/iu.exec(fragment.text.trim());
      return match && literalQuote(match[1]) === literalQuote(value);
    });
    return { itemId: item.id, field, status: fragments.length ? "confirmed" : "unverified", message: fragments.length ? "Полный предмет закупки дословно найден в одном выбранном фрагменте после явной метки. Переносы строк сохранены; полнота остальных условий этим не подтверждается." : "Полный многострочный предмет закупки не подтверждён одним явно подписанным фрагментом. Части разных абзацев не объединены автоматически.", evidence: fragments.slice(0, 3).map((fragment) => excerpt(fragment.unit, value)) };
  }
  const candidateUnits = [...new Set(values.flatMap((entry) => candidatesFor(typeof value === "number" ? value : entry, index)))];
  if (candidateUnits.length > maxCandidateUnits) index.limited = true;
  const addressField = /^(?:address|recipientAddress)$/u.test(field);
  const matches = candidateUnits.slice(0, maxCandidateUnits).filter((unit) => values.some((entry, position) => typeof value === "number" ? [...unit.numbers, ...(field === "nmc" ? unit.nmcAmounts : [])].some((number) => Number(number) === value) : addressField ? unit.text.split("\t").some((cell) => includesPhrase(cell, entry)) : matchesUnit(unit, entry, normalizedValues[position])));
  if (addressField) matches.push(...wrappedAddressMatches(units, values, index));
  if (item.destination === "proposals" && field === "number") {
    if (!index.proposalNumbers) {
      const parsed = extractProposalIdentifierFacts([...new Set(units.map((unit) => unit.source))]);
      index.proposalNumbers = parsed.facts; index.limited ||= parsed.limited;
    }
    const number = typeof value === "string" ? normalize(value).replace(/^№\s*/u, "") : "";
    const proof = index.proposalNumbers.filter((fact) => normalize(fact.value) === number);
    return { itemId: item.id, field, status: proof.length ? "confirmed" : matches.length ? "conflict" : "unverified", message: proof.length
      ? "Номер найден после явного обозначения КП либо в исходящей строке ограниченного заголовком КП блока. Это проверка роли номера, не подлинности документа."
      : "Значение не подтверждено именно как номер коммерческого предложения. Название модели, SKU, номер договора, приложения или доверенности не является номером КП; оставьте поле неизвестным либо укажите явный номер по источнику.", evidence: proof.length ? proof.slice(0, 2).flatMap((fact) => [fact, ...(fact.supportingEvidence || [])]) : matches.slice(0, 3).map((unit) => excerpt(unit)) };
  }
  if (item.destination === "staff" && field === "basis" && normalizedValues.includes("ип")) {
    const short = units.filter((unit) => matchesStaffValue(unit, "ИП"));
    if (short.length > maxCandidateUnits) index.limited = true;
    matches.push(...short.slice(0, maxCandidateUnits));
  }
  if (item.destination === "procurement" && field === "licenses") {
    const misplaced = values.filter((entry) => entry.trim() && (!hasLicensingRole(entry) || !/(?<!\p{L})лицензи[а-я]*(?!\p{L})/iu.test(entry) && matches.some((unit) => matchesUnit(unit, entry)) && !matches.some((unit) => matchesUnit(unit, entry) && unit.text.split(/[;\t\n]/u).some((clause) => includesPhrase(clause, entry) && hasLicensingRole(clause)))));
    if (misplaced.length) {
      const proof = matches.filter((unit) => misplaced.some((entry) => matchesUnit(unit, entry)));
      return { itemId: item.id, field, status: proof.length ? "conflict" : "unverified", message: "В поле «Лицензии» есть строки без явного лицензионного содержания или смешаны разные документы. Доверенность, декларация, сертификат и другие документы заявки сами по себе не являются лицензиями. Проверьте назначение каждой строки: исправьте поле / перенесите документ в требования либо явно подтвердите применимость. Исходные значения не изменены.", evidence: proof.slice(0, 3).map((unit) => excerpt(unit)) };
    }
  }
  if (item.destination === "staff" && /^(?:certificates|basis(?:Other|Number)?)$/u.test(field)) return staffOwnedField(item, field, values, matches, index);
  if (item.destination === "staff" && field === "education") return staffEducationField(item, values, matches, index);
  if (item.destination === "staff" && /^(?:experienceYears|experienceNotes|phone|email)$/u.test(field)) return staffProfileField(item, field, values, matches, index);
  if (item.destination === "procurement" && field === "requirements" && values.some((entry) => /\r?\n/u.test(entry))) {
    const proofs = values.map((entry) => {
      const candidates = candidatesFor(entry, index), keys = new Set(candidates.map((unit) => unit.fragmentKey));
      const fragments = index.literalFragments.filter((fragment) => keys.has(fragment.key));
      if (fragments.length > maxCandidateUnits) index.limited = true;
      return { entry, proof: entry.trim() ? fragments.slice(0, maxCandidateUnits).find((fragment) => fragment.text.includes(literalQuote(entry))) : undefined };
    });
    if (proofs.every((entry) => entry.proof)) return { itemId: item.id, field, status: "confirmed", message: "Каждый полный пункт дословно найден внутри одного выбранного фрагмента. Заголовки, альтернативы и исключения сохранены как текст; это не подтверждает применимость, одобрение или полноту условий.", evidence: proofs.slice(0, 3).map((entry) => excerpt(entry.proof!.unit, entry.entry)) };
  }
  if (item.destination === "contracts" && field === "number") {
    // Exact contextual identifiers need their own index: valid short letters
    // and slash-separated parts may have no three-character text token.
    const numberCandidates = [...new Set(normalizedValues.flatMap((entry) => index.contractNumbers.get(entry) || []))];
    if (numberCandidates.length > maxCandidateUnits) index.limited = true;
    const correct = numberCandidates.slice(0, maxCandidateUnits);
    return { itemId: item.id, field, status: correct.length ? "confirmed" : "unverified", message: correct.length ? "Заполненный идентификатор найден рядом с явным обозначением номера договора / контракта." : "Заполненный номер договора не подтверждён. Название вида документа, пустой шаблон и номера приложений, законов или доверенностей не являются его номером.", evidence: (correct.length ? correct : matches).slice(0, 3).map((unit) => excerpt(unit)) };
  }
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
    const contextual = matches.filter((unit) => (field === "nmc" ? [...unit.nmcAmounts, ...labeledAmounts(unit, nmcLabel, true)] : field === "ourShareAmount" ? labeledAmounts(unit, shareLabel) : overallAmounts(unit)).some((amount) => typeof value === "number" && sameNumber(amount, String(value))));
    if (contextual.length && (typeof value !== "number" || value !== 0 || /(?:нмц|начальн[а-я\s]+цен)[^\n]{0,60}\b0(?:[.,]00)?\b/iu.test(contextual[0].text))) return { itemId: item.id, field, status: "confirmed", message: "Число найдено в контексте общей цены. Проверьте валюту и то, что это итог, а не цена единицы.", evidence: contextual.slice(0, 3).flatMap((unit) => [excerpt(unit), ...(field === "nmc" ? unit.nmcHeaders : [])]).slice(0, 4) };
    return { itemId: item.id, field, status: matches.length ? "conflict" : "unverified", message: field === "ourShareAmount" ? "Общая цена договора не подтверждает нашу долю. Нужна явно указанная стоимость нашей доли / наших работ; процент нельзя подменять общей суммой." : "Цена не подтверждена как итог соответствующего договора / закупки. Цена строки, рыночная котировка или ноль в шаблоне не устанавливают НМЦ; для НМЦ требуется её явное обозначение.", evidence: matches.slice(0, 3).map((unit) => excerpt(unit)) };
  }
  if (expectedDateEvents[field] && typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    const sameDates = dates.filter((entry) => entry.iso === value);
    const correct = sameDates.filter((entry) => expectedDateEvents[field].includes(entry.event));
    if (item.destination === "procurement" && field === "submissionDeadline" && ambiguousLotDeadline(value, dates, index)) return { itemId: item.id, field, status: "unverified", message: "В источнике несколько лотов с разными сроками подачи. Наличие даты в файле не подтверждает её связь с этим лотом: сверьте лот, дату и время, затем явно подтвердите решение. Автоматическая смысловая привязка не выполнена.", evidence: [...correct.slice(0, 2).map((entry) => excerpt(entry.unit, entry.quote)), ...correct.flatMap((entry) => index.ambiguousLotSources.get(entry.unit.sourceId) || [])].slice(0, 5) };
    return { itemId: item.id, field, status: correct.length ? "confirmed" : sameDates.length ? "conflict" : "unverified", message: correct.length ? correct.every((entry) => entry.lowerBound) ? "Указана нижняя допустимая граница поставки / работ (не ранее), а не обещание фактического начала в этот день." : "Дата найдена рядом с обозначением соответствующего события." : sameDates.length ? "Такая дата есть в источнике, но относится к другому событию или событие не подтверждено. Не подменяйте подачу поставкой, публикацию редакцией или работы подведением итогов." : "В выбранных источниках нет явной даты этого события. Относительная длительность не является календарной датой.", evidence: (correct.length ? correct : sameDates).slice(0, 3).map((entry) => excerpt(entry.unit, entry.quote)) };
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
    const required = obligationPattern.test(unit.text) || /(?:документы\s+заявки|состав\s+заявки|перечень\s+документов)/iu.test(unit.context) || withoutListIndex(unit.text) !== unit.text && documentPattern.test(unit.text);
    if (required && documentPattern.test(unit.text) && !certificates.length && !placeholders.test(normalize(unit.text))) {
      const activity = /(?:(?:подпункт|пункт)(?:ами|ам|ы|ов|ах|у|ом|е|а)?(?!\p{L})|пп\.?|вид(?:ы|ов)\s+работ)\s*[:—-]?\s*([^.;\n]{1,100})/iu.exec(unit.text);
      const letters = activity ? [...activity[1].matchAll(/(?:^|[\s,\/«"'(])([а-я])(?=[\s,\/»"')]|$)/giu)].map((match) => match[1]).filter((letter) => !/^и$/iu.test(letter)) : [];
      facts.push({ category: "document", label: unit.text, unit, anchors: words(unit.text).slice(0, 14), numbers: businessNumbers(unit.text), extra: /фстэк|тзки/iu.test(unit.text) ? [...new Set(letters)] : [], qualifiers: requirementQualifiers(unit.text) });
    }
    if ((obligationPattern.test(unit.text) || tableQuantity) && /\d/u.test(unit.text) && !ignoredNumericContext.test(unit.text) && !certificates.length && !documentPattern.test(unit.text) && !moneyContext.test(unit.text) && !/\b\d{2}[./]\d{2}[./]\d{4}|\b\d{4}-\d{2}-\d{2}/u.test(unit.text)) facts.push({ category: "quantity", label: unit.text, unit, anchors: words(unit.text).slice(0, 14), numbers: tableQuantity ? [columns[columns.length - 1].replace(",", ".")] : businessNumbers(unit.text), qualifiers: requirementQualifiers(unit.text) });
    // An arbitrary supplier's "total" must not become a mandatory tender NMC.
    for (const amount of [...new Set([...unit.nmcAmounts, ...labeledAmounts(unit, nmcLabel, true)])].filter((entry) => Number(entry) > 0)) { if (facts.length >= maxFacts) { limited = true; break; } facts.push({ category: "price", label: `Явная общая цена: ${Number(amount)}`, unit, anchors: [], numbers: [amount] }); }
  }
  const seen = new Set<string>();
  return { facts: facts.slice(0, maxFacts).filter((fact) => { const key = `${fact.category}:${fact.unit.sourceId}:${normalize(fact.label)}:${fact.token || ""}`; if (seen.has(key)) return false; seen.add(key); return true; }), limited: limited || facts.length > maxFacts };
}
function outputEntries(item: IntelligenceItem, fields: string[]): string[] {
  return fields.filter((field) => item.selectedFields.includes(field)).flatMap((field) => strings(item.fields[field]));
}
function notesCoverOperationalCondition(item: IntelligenceItem, fact: SourceFact): boolean {
  // The repair desk stores payment/delivery clauses in notes, not a duplicate
  // requirements row. Only a complete literal clause may satisfy this shortcut;
  // a certificate/document or unrelated number in notes is never sufficient.
  if (fact.category !== "quantity" || !/(?<!\p{L})(?:оплат|постоплат|предоплат|аванс|постав(?:к|ить|лен)|достав|гаранти|срок[а-я]*\s+(?:выполнен|оказан|исполнен|реакци)|восстановлен)/iu.test(fact.unit.text)) return false;
  const quote = literalQuote(fact.unit.text);
  return Boolean(quote) && outputEntries(item, ["notes"]).some((note) => literalQuote(note).includes(quote));
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
  return lexical && letterActivities && fact.numbers.every((number) => businessNumbers(text).some((value) => sameNumber(value, number))) && conditionalPatterns.every((pattern) => !pattern.test(fact.unit.text) || pattern.test(text));
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
  const tableInventory = items.some((item) => item.destination === "contracts" || item.destination === "procurement") ? extractPreparedTableFacts(sources) : undefined;
  limited ||= tableInventory?.limited || false;
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
    const selectedDates = dates.filter((entry) => allowed.has(entry.unit.sourceId));
    const scope = { units: selectedUnits, dates: selectedDates, index: buildIndex(selectedUnits, selectedDates) }; fieldScopes.set(key, scope); return scope;
  };
  const sourceFingerprint = fingerprint(sources.map((source) => ({ id: source.id, name: source.name, sha256: source.sha256, warnings: source.warnings, coverage: source.coverage, material: source.fragments === undefined ? source.text : source.fragments })));
  const itemFingerprints = new Map(items.map((item) => [item.id, fingerprint({ title: item.title, fields: item.fields, selectedFields: item.selectedFields, sourceIds: item.sourceIds, evidence: item.evidence, staffDocuments: item.staffDocuments, sourceFingerprint })]));
  const finding = (item: IntelligenceItem, code: string, severity: EvidenceFinding["severity"], message: string, evidence: EvidenceExcerpt[], field?: string) => createFinding(item, code, severity, message, evidence, field, itemFingerprints.get(item.id));
  const provePublicTerms = items.some((item) => item.destination === "proposals" && item.selectedFields.includes("deliveryTerms")) ? createProposalPublicTermsProver(sources) : undefined;
  for (const item of items) {
    if (fieldChecks >= maxFieldChecks || report.findings.length >= maxFindings) { limited = true; break; }
    const scope = getFieldScope(item);
    const paymentProof = material.limited ? undefined : collectivePaymentProof(item, scope.units);
    const publicTermsProof = material.limited ? undefined : provePublicTerms?.prove(item, items);
    const tableProof = material.limited || !tableInventory ? undefined : preparedTableProof(item, items, tableInventory);
    for (const field of [...new Set(item.selectedFields)]) {
      if (fieldChecks >= maxFieldChecks || report.findings.length >= maxFindings) { limited = true; break; }
      const value = item.fields[field]; if (!meaningful(value)) continue;
      fieldChecks++;
      const noteIssue = item.destination === "procurement" && field === "notes" ? procurementNoteIssue(item, scope.dates) : undefined;
      const strictPublicTerms = field === "deliveryTerms" && Boolean(provePublicTerms?.needsProof(item));
      const valueResult: FieldEvidenceStatus = strictPublicTerms ? { itemId: item.id, field, status: publicTermsProof ? "confirmed" : "unverified", message: publicTermsProof
        ? "Все публичные оговорки дословно подтверждены полными цитатами и заголовками выбранного КП в исходном порядке. Это проверка происхождения текста, не полноты или юридической применимости."
        : "Полный текст публичных оговорок, их порядок, область или принадлежность одному выбранному КП не подтверждены. Корректная добавленная оговорка не подтверждает остальные условия; проверьте всё поле перед переносом.", evidence: publicTermsProof?.evidence || [] }
        : noteIssue ? { itemId: item.id, field, ...noteIssue } : tableProof?.fields.get(field) || (field === "paymentTerms" && paymentProof
        ? { itemId: item.id, field, status: "confirmed", message: "Полные условия оплаты дословно подтверждены отдельными цитатами в порядке одной явно обозначенной секции. Это проверка наличия текста, не заключение о применимости, полноте документа или юридической достоверности.", evidence: paymentProof.evidence }
        : fieldStatus(item, field, value!, scope.units, scope.dates, scope.index));
      const ownerResult = staffOwnershipGate(item, valueResult, value!, scope.units, scope.dates, scope.index), ownerIssue = ownerResult && ownerResult.status !== "confirmed", result = ownerResult || valueResult;
      report.fields.push(result);
      if (result.status !== "confirmed") report.findings.push(finding(item, ownerIssue ? result.status === "conflict" ? "staff-owner-conflict" : "staff-owner-unverified" : item.destination === "procurement" && field === "submissionDeadline" && ambiguousLotDeadline(value!, scope.dates, scope.index) ? "ambiguous-lot-deadline" : result.status === "placeholder" ? "placeholder-value" : result.status === "conflict" ? "semantic-conflict" : "unverified-value", ownerIssue || noteIssue || isCritical(item.destination, field) || result.status !== "unverified" ? "blocking" : "warning", result.message, result.evidence, field));
    }
    if (genericPlaceholders.test(normalize(item.title)) || genericResultTitles.test(normalize(item.title)) || sources.some((source) => normalize(source.name) === normalize(item.title))) report.findings.push(finding(item, "placeholder-title", "warning", "Название результата похоже на шаблон или имя файла. Проверьте смысловое название.", []));
    if (item.destination === "proposals" && item.selectedFields.includes("lines") && report.findings.length < maxFindings) {
      const summaries = strings(item.fields.lines).map((value, position) => ({ value, position })).filter((entry) => financialSummaryPositionLabel(entry.value));
      if (summaries.length) report.findings.push(finding(item, "financial-summary-position", "blocking", `В позициях ${summaries.map((entry) => entry.position + 1).join(", ")} обнаружены служебная шапка или финансовые итоги, а не отдельные товары / услуги. Проверьте состав позиций; стоимость, НДС и общий итог указываются в ценовых полях редактора КП. Исходный ответ и позиции не изменены.`, scope.units.filter((unit) => summaries.some((entry) => includesPhrase(unit.text, entry.value))).slice(0, 3).map((unit) => excerpt(unit)), "lines"));
    }
    for (const claim of item.evidence || []) {
      if (report.findings.length >= maxFindings) { limited = true; break; }
      if (!item.selectedFields.includes(claim.field) || !meaningful(item.fields[claim.field])) continue;
      if (!item.sourceIds.includes(claim.sourceId)) report.findings.push(finding(item, "evidence-source-not-cited", "blocking", "Цитата относится к источнику, не указанному для этой карточки. Проверьте связь документов и происхождение значения до переноса.", [], claim.field));
      const source = sources.find((entry) => entry.id === claim.sourceId);
      const candidates = source ? [...quoteGroups.values()].filter((group) => group.unit.sourceId === source.id && (!claim.fragmentId || group.unit.fragmentId === claim.fragmentId)) : [];
      const quote = literalQuote(claim.quote), quoted = candidates.filter((group) => quote && group.text.includes(quote)).map((group) => group.unit);
      if (!claim.quote.trim() || !quoted.length) report.findings.push(finding(item, "invalid-evidence-quote", "blocking", "Указанная моделью цитата или фрагмент не найдены среди выбранных материалов. Эта ссылка не подтверждает поле.", [], claim.field));
      else if (!paymentProof?.claims.has(claim) && !publicTermsProof?.claims.has(claim) && !tableProof?.claims.has(claim) && !quoteSupportsValue(item, claim.field, claim.quote)
        && !(item.destination === "procurement" && claim.field === "customer" && typeof item.fields.customer === "string" && source && item.sourceIds.includes(source.id)
          && sources.filter((entry) => entry.id === source.id).length === 1 && isOrganizerBeneficiarySupport(item.fields.customer, source, claim, item.evidence || []))) report.findings.push(finding(item, "evidence-does-not-support-value", "blocking", "Цитата есть в источнике, но не содержит заявленное значение поля. Проверьте значение и ссылку.", quoted.slice(0, 2).map((unit) => excerpt(unit, claim.quote)), claim.field));
    }
    for (const source of sources) {
      if (report.findings.length >= maxFindings) { limited = true; break; }
      if (source.coverage && (!source.coverage.complete || source.coverage.requiresOcr)) report.findings.push(finding(item, "incomplete-source-coverage", "blocking", `Текст «${source.name}» извлечён не полностью${source.coverage.requiresOcr ? "; требуется проверка OCR" : ""}. Неподтверждённые области документа не проверены этим анализом.`, [{ sourceId: source.id, sourceName: source.name, locator: "Качество извлечения", quote: (source.warnings || []).join("\n") || "Есть области без извлечённого текста." }]));
      else if (source.warnings?.length) report.findings.push(finding(item, "source-warning", "warning", `В источнике «${source.name}» есть предупреждения извлечения; учитывайте их при проверке результата.`, [{ sourceId: source.id, sourceName: source.name, locator: "Предупреждения источника", quote: source.warnings.join("\n") }]));
      if (source.fragments?.some((fragment) => includedFragment(fragment) && (fragment.sheetState === "hidden" || fragment.sheetState === "veryHidden"))) report.findings.push(finding(item, "hidden-sheet-history", "warning", `Выбраны скрытые листы «${source.name}». Скрытая история может относиться к другой закупке; проверьте даты, заказчика и связь с текущей карточкой.`, units.filter((unit) => unit.sourceId === source.id && (unit.sheetState === "hidden" || unit.sheetState === "veryHidden")).slice(0, 2).map((unit) => excerpt(unit))));
    }
  }

  const requirement = requirementFacts(units); limited ||= requirement.limited;
  const conditionPresentation = new Map([...new Set(units.map((unit) => unit.sourceId))].map((sourceId) => [sourceId, createRequirementComparator([
    ...units.filter((unit) => unit.sourceId === sourceId).map((unit) => unit.text),
    ...items.flatMap((item) => outputEntries(item, ["requirements", "licenses"])),
  ])]));
  for (const fact of requirement.facts) {
    if (report.coverage.length >= maxCoverage || report.findings.length >= maxFindings) { limited = true; break; }
    const candidates = targetItems(items, "procurement", fact.unit.sourceId); if (!candidates.length) continue;
    const matched = candidates.filter((item) => fact.category === "price" ? item.selectedFields.includes("nmc") && typeof item.fields.nmc === "number" && Number(item.fields.nmc) === Number(fact.numbers[0]) : outputEntries(item, ["requirements", "licenses"]).some((entry) => coversFact(entry, fact) || !fact.uncertain && conditionPresentation.get(fact.unit.sourceId)?.(entry, fact.unit.text)) || notesCoverOperationalCondition(item, fact));
    const check: CoverageCheck = { id: `coverage-${fingerprint({ source: fact.unit.sourceId, quote: fact.label, category: fact.category, token: fact.token })}`, category: fact.category, status: fact.uncertain ? "uncertain" : matched.length ? "covered" : "missing", label: fact.label, evidence: excerpt(fact.unit), itemIds: candidates.map((item) => item.id), matchedItemIds: matched.map((item) => item.id), ...(fact.category === "price" && fact.unit.nmcHeaders.length ? { supportingEvidence: fact.unit.nmcHeaders } : {}) };
    report.coverage.push(check);
    if (!matched.length) for (const item of candidates) { if (report.findings.length >= maxFindings) { limited = true; break; } report.findings.push(finding(item, `missing-${fact.category}`, "blocking", fact.category === "price" ? "В выбранном источнике есть явная общая цена, но она не отражена в выбранной НМЦ. Проверьте итог и валюту." : "Обязательное условие из выбранного текста не найдено с его числами и оговорками в переносимых требованиях. Добавьте точное условие или подтвердите его неприменимость.", [check.evidence], fact.category === "price" && meaningful(item.fields.nmc) ? "nmc" : undefined)); }
  }
  if (items.some((item) => item.destination === "procurement") && units.some((unit) => groupedConditionHeading(unit.text))) {
    const grouped = extractIntelligenceConditionFacts(sources); limited ||= grouped.limited;
    for (const fact of grouped.facts.filter((entry) => groupedConditionQuote(entry.quote))) {
      for (const item of targetItems(items, "procurement", fact.sourceId)) {
        if (report.findings.length >= maxFindings) { limited = true; break; }
        // Separate literal children never establish the heading's OR/scope.
        // Requiring the full contiguous quote does not approve applicability.
        if (outputEntries(item, ["requirements"]).some((entry) => literalQuote(entry).includes(literalQuote(fact.quote)))) continue;
        report.findings.push(finding(item, "incomplete-grouped-condition", "blocking", "В источнике документы объединены общей альтернативой или оговоркой применимости. Отдельные строки без полного заголовка могут превратить «один из» в «все» или убрать ограничение. Сохраните целую дословную группу либо явно подтвердите неприменимость; автоматическое смысловое одобрение не выполнено.", [{ sourceId: fact.sourceId, sourceName: fact.sourceName, fragmentId: fact.fragmentId, locator: fact.locator, quote: fact.quote }], item.selectedFields.includes("requirements") && meaningful(item.fields.requirements) ? "requirements" : undefined));
      }
    }
  }
  const noteTimes = new Map<string, NoteTimeOccurrence[]>();
  for (const date of dates.filter((entry) => entry.event === "submission-end" && entry.time)) {
    if (report.coverage.length >= maxCoverage || report.findings.length >= maxFindings) { limited = true; break; }
    const candidates = targetItems(items, "procurement", date.unit.sourceId); if (!candidates.length) continue;
    const lotAmbiguous = candidates.some((item) => getFieldScope(item).index.ambiguousLotSources.has(date.unit.sourceId));
    const matched = candidates.filter((item) => !date.timezoneAmbiguous && item.selectedFields.includes("submissionDeadline") && item.fields.submissionDeadline === date.iso && outputEntries(item, ["notes"]).some((note) => {
      let records = noteTimes.get(note); if (!records) { records = submissionNoteTimes(note); noteTimes.set(note, records); }
      return records.some((record) => record.event === "submission-end" && (!record.iso || record.iso === date.iso) && sameTime(record.time, date.time!) && record.zones.length <= 1 && (!date.timezone || record.zones.includes(canonicalTimezone(date.timezone))));
    }));
    const check: CoverageCheck = { id: `coverage-${fingerprint({ source: date.unit.sourceId, date: date.iso, time: date.time, timezone: date.timezone, timezoneAmbiguous: date.timezoneAmbiguous, lotAmbiguous })}`, category: "deadline-time", status: date.timezoneAmbiguous || lotAmbiguous ? "uncertain" : matched.length ? "covered" : "missing", label: `Подача: ${date.iso} ${date.time}${date.timezone ? ` ${date.timezone}` : ""}${date.timezoneAmbiguous ? " — часовой пояс требует уточнения" : ""}${lotAmbiguous ? " — связь с лотом требует проверки" : ""}`, evidence: excerpt(date.unit, date.quote), itemIds: candidates.map((item) => item.id), matchedItemIds: lotAmbiguous ? [] : matched.map((item) => item.id), ...(date.timezoneEvidence?.length ? { supportingEvidence: date.timezoneEvidence } : {}) };
    report.coverage.push(check);
    if (!matched.length) for (const item of candidates) { if (report.findings.length >= maxFindings) { limited = true; break; } report.findings.push(finding(item, "missing-deadline-time", "blocking", date.timezoneAmbiguous ? "Источник содержит противоречивые указания часового пояса. Уточните пояс срока подачи по документу; автоматический выбор не выполнен." : "Источник указывает время подачи и, возможно, часовой пояс. Одна дата не сохраняет это условие: добавьте время и указанный пояс в переносимые примечания.", [check.evidence, ...(check.supportingEvidence || [])])); }
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
  const proposalItems = items.filter((item) => item.destination === "proposals" && item.selectedFields.includes("lines") && strings(item.fields.lines).some((line) => line.trim()));
  if (proposalItems.length) {
    const inventory = extractSourcePositionFacts(sources);
    limited ||= inventory.truncated;
    const relationReasons = new Set(["unbound-configuration", "unbound-sku", "multiple-sku-section", "multiple-configurations", "duplicate-sku", "duplicate-fragment-id", "conflicting-pdf-row"]);
    for (const item of proposalItems) {
      if (report.findings.length >= maxFindings) { limited = true; break; }
      const scoped = (sourceId: string) => !item.sourceIds.length || item.sourceIds.includes(sourceId);
      const positions = inventory.positions.filter((position) => scoped(position.sourceId));
      const configurations = inventory.configurations.filter((configuration) => scoped(configuration.sourceId));
      const lines = strings(item.fields.lines), descriptions = item.selectedFields.includes("lineDescriptions") ? strings(item.fields.lineDescriptions) : [];
      const ambiguousEvidence: EvidenceExcerpt[] = [], missingEvidence: EvidenceExcerpt[] = [];
      const add = (entries: EvidenceExcerpt[], fact: EvidenceExcerpt) => {
        if (entries.length < 6 && !entries.some((entry) => entry.sourceId === fact.sourceId && entry.fragmentId === fact.fragmentId && entry.quote === fact.quote)) entries.push({ sourceId: fact.sourceId, sourceName: fact.sourceName, fragmentId: fact.fragmentId, locator: fact.locator, quote: fact.quote });
      };
      const related = (reasons: string[], sku?: string) => reasons.some((reason) => relationReasons.has(reason) && (reason !== "duplicate-sku" || !sku || positions.filter((position) => normalize(position.sku) === normalize(sku)).length > 1));
      for (const [index, line] of lines.entries()) {
        const lineSkus = normalize(line).split(/[^a-z0-9_./-]+/u);
        const named = positions.filter((position) => lineSkus.includes(normalize(position.sku)));
        for (const position of named) {
          const sourceConfigurations = configurations.filter((configuration) => configuration.sourceId === position.sourceId);
          const sameSourceConfigurations = sourceConfigurations.filter((configuration) => configuration.positionId === position.id || !configuration.positionId || related(configuration.reasons, configuration.sku));
          const description = descriptions[index]?.trim() || "";
          const matched = sourceConfigurations.filter((configuration) => description
            ? includesPhrase(description, configuration.description) || includesPhrase(configuration.description, description)
            : configuration.name.length >= 3 && includesPhrase(line, configuration.name));
          if (!sameSourceConfigurations.length && !matched.length) continue; // A plain SKU has no claim to another position's composition.
          const proven = Boolean(description) && matched.some((configuration) => includesPhrase(description, configuration.description) && configuration.id === position.configurationId && configuration.positionId === position.id && !related(position.reasons, position.sku) && !related(configuration.reasons, configuration.sku));
          const detached = !position.configurationId || related(position.reasons, position.sku);
          if (!proven && (detached || matched.length)) {
            add(ambiguousEvidence, position);
            for (const configuration of (matched.length ? matched : sameSourceConfigurations).slice(0, 2)) add(ambiguousEvidence, configuration);
          }
          const containsFullComposition = Boolean(description) && sameSourceConfigurations.some((configuration) => includesPhrase(description, configuration.description));
          if (!containsFullComposition && sameSourceConfigurations.length && (detached || Boolean(position.configurationId))) {
            add(missingEvidence, position);
            for (const configuration of sameSourceConfigurations.slice(0, 2)) add(missingEvidence, configuration);
          }
        }
      }
      if (ambiguousEvidence.length) report.findings.push(finding(item, "ambiguous-sku-configuration", "blocking", "Связь артикула с полным составом требует отдельной проверки по оригиналу. Наличие обоих текстов, порядок таблицы и составов или ручная подстановка не доказывают соответствие. Проверьте каждую пару SKU → состав и явно подтвердите решение.", ambiguousEvidence, "lines"));
      // Keep this attached to selected lines: removing/deselecting descriptions
      // or keeping only one literal component must not hide a known composition.
      if (missingEvidence.length && report.findings.length < maxFindings) report.findings.push(finding(item, "missing-sku-configuration", "blocking", "В источнике найден полный состав, но переносимое описание пусто, исключено либо не сохраняет этот состав целиком. Добавьте полный состав отдельной позиции и проверьте его связь с артикулом; отдельный компонент не подтверждает полноту.", missingEvidence, "lines"));
    }
  }
  const completeness = collectLiteralCompleteness(items, sources, items.some((item) => item.destination === "proposals") ? extractIntelligenceDateFacts(sources).facts : []);
  for (const candidate of completeness) {
    if (report.findings.length >= maxFindings) { limited = true; break; }
    const item = items.find((entry) => entry.id === candidate.itemId);
    if (item) report.findings.push(finding(item, candidate.code, "blocking", candidate.message, candidate.evidence, candidate.field));
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
