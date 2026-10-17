import type { SourcePreparationProvenance, SourcePreparationResult } from "./sourcePreparedFacts";
import type { IntelligenceEvidence, IntelligenceFragment, IntelligenceItem, IntelligenceSource } from "./workbenchTypes";

export const PROPOSAL_PUBLIC_TERMS_LIMITS = Object.freeze({ items: 100, sources: 100, fragments: 5000, bytes: 2 * 1024 * 1024, fragment: 20_000, quote: 2000, clauses: 100, sectionClauses: 6, field: 20_000, evidence: 500, receipts: 500, resultBytes: 8 * 1024 * 1024 });
export interface ProposalPublicTermClause extends SourcePreparationProvenance { role: "scope" | "schedule" | "relative-validity" | "price-validity" }
export interface ProposalPublicTermSection {
  proposal: SourcePreparationProvenance; heading: SourcePreparationProvenance; clauses: ProposalPublicTermClause[];
}
export interface ProposalPublicTermsInventory { sections: ProposalPublicTermSection[]; limited: boolean }
type Row = { source: IntelligenceSource; fragment: IntelligenceFragment; index: number; number: number };
const literal = (text: string) => text.replace(/\s+/gu, " ").trim();
const validId = (value: string) => Boolean(value.trim()) && Array.from(value).length <= 128 && !/[\u0000-\u001f]/u.test(value);
const visible = (fragment: IntelligenceFragment) => fragment.sheetState !== "hidden" && fragment.sheetState !== "veryHidden";
const cpHeading = /^(?:коммерческое\s+предложение|кп)(?:\s*№\s*[\p{L}\d/._-]+)?\s*$/iu;
const cpHeadingPrefix = /^(?:коммерческое\s+предложение|кп)(?=$|[\s№:：])/iu;
const sectionHeading = /^(оговорки|условия\s+выполнения|срок\s+действия\s+предложения)\s*[:：]?$/iu;
const validityHeading = /^срок\s+действия\s+предложения\s*[:：]?$/iu;
const signoff = /^(?:с\s+уважением[,!]?|подпись\s*[:：]?|генеральный\s+директор)$/iu;
const closingHeading = /^(?:контакты|реквизиты|заключение)\s*[:：]$/iu;
const documentHeading = /^(?:договор|контракт|запрос\s+(?:предложений|котировок)|техническое\s+задание)(?:\s*№\s*[\p{L}\d/._-]+)?\s*$/iu;
const numberedDocumentHeading = /^(?:договор|контракт)\s*(?:№\s*)?[\p{L}\d/._-]+\s+от\s+\S[^\n\t]{0,150}$/iu;
const inlineValidity = /^срок\s+действия\s+коммерческого\s+предложения\s*[:：]\s*[1-9]\d{0,2}\s+календарных\s+дней[.;]?$/iu;
const inlinePriceValidity = /^стоимость\s+предложения\s+действительна\s+при\s+официальном\s+курсе\s+доллара\s+США\s+к\s+рублю\s+не\s+выше\s+\d{1,6}(?:[.,]\d{1,4})?\s+рублей\s+за\s+1\s+доллар\s+США\.$/iu;
const paragraphNumber = (fragment: IntelligenceFragment) => {
  const locator = /^Абзац\s+(\d+)$/iu.exec(fragment.locator);
  const id = fragment.id === undefined ? locator : /^paragraph-(\d+)$/u.exec(fragment.id);
  return id && (!locator || Number(locator[1]) === Number(id[1])) && Number.isSafeInteger(Number(id[1])) && Number(id[1]) > 0 ? Number(id[1]) : undefined;
};
const sameRun = (left: Row, right: Row) => left.source === right.source && left.fragment.sheetId === right.fragment.sheetId && right.index === left.index + 1;
const adjacent = (left: Row, right: Row) => sameRun(left, right) && right.number === left.number + 1;
const proof = (row: Row): SourcePreparationProvenance => ({ sourceId: row.source.id, sourceName: row.source.name, fragmentId: row.fragment.id, locator: row.fragment.locator, quote: row.fragment.text });
export function proposalPublicTermsOwnerIsUnambiguous(source: IntelligenceSource): boolean {
  const headings = (source.fragments || []).filter((fragment) => cpHeadingPrefix.test(fragment.text.trim()));
  if (headings.length !== 1 || !cpHeading.test(headings[0].text.trim()) || !visible(headings[0]) || paragraphNumber(headings[0]) === undefined) return false;
  return !(source.fragments || []).slice((source.fragments || []).indexOf(headings[0]) + 1).some((fragment) => documentHeading.test(fragment.text.trim()) || numberedDocumentHeading.test(fragment.text.trim()));
}
function role(text: string, heading: string): ProposalPublicTermClause["role"] | undefined {
  if (validityHeading.test(heading)) return /^[1-9]\d{0,2}\s+календарных\s+дней\s+с\s+даты\s+исходящего\s+письма[.;]?$/iu.test(text) ? "relative-validity" : undefined;
  if (/(?:периметр|дополнительн[а-я]*\s+работ)/iu.test(text) && /(?:согласован|согласовани)/iu.test(text)) return "scope";
  if (/(?:состав[а-я\s]+проектн[а-я\s]+команд|этап[а-я\s]+запуска\s+проекта)/iu.test(text) && /(?:согласован|уточняют|учетом|с\s+уч[её]том)/iu.test(text)) return "schedule";
}

/** Closed, same-page literal PDF clauses. Reading order does not establish a
 * recipient or issuer, and this never computes an expiry or a currency rate. */
function inlinePdfTerms(source: IntelligenceSource): ProposalPublicTermSection | undefined {
  const pages = (source.fragments || []).filter((fragment) => /^page-\d+$/u.test(fragment.id || ""));
  // Deliberately narrow: a second page/document cannot acquire this page's
  // conditions merely because it contains the same words or a grid overlay.
  if (pages.length !== 1 || !visible(pages[0])) return;
  const page = pages[0], coordinate = /^page-([1-9]\d*)$/u.exec(page.id!);
  if (!coordinate || page.locator !== `Страница ${coordinate[1]}`) return;
  const lines = page.text.split(/\r?\n/u), headings = lines.filter((line) => cpHeadingPrefix.test(line.trim()));
  if (headings.length !== 1 || !cpHeading.test(headings[0].trim()) || lines.some((line) => documentHeading.test(line.trim()) || numberedDocumentHeading.test(line.trim()))) return;
  const starts = lines.flatMap((line, index) => inlineValidity.test(line.trim()) ? [index] : []);
  if (starts.length !== 1) return;
  const index = starts[0], validity = lines[index], price = lines[index + 1], closing = lines[index + 2];
  if (!price || !inlinePriceValidity.test(price.trim()) || !closing || !/^условия\s+оплаты\s*[:：]\s*\S.+$/iu.test(closing.trim())
    || [headings[0], validity, price].some((quote) => quote.length > PROPOSAL_PUBLIC_TERMS_LIMITS.quote)) return;
  const evidence = (quote: string): SourcePreparationProvenance => ({ sourceId: source.id, sourceName: source.name, fragmentId: page.id, locator: page.locator, quote });
  return { proposal: evidence(headings[0]), heading: evidence(validity), clauses: [{ ...evidence(price), role: "price-validity" }] };
}

/** Narrow explicit public proposal sections, not generic NLP or a legal
 * conclusion. Every clause is a whole current literal paragraph. */
export function extractProposalPublicTerms(sources: readonly IntelligenceSource[]): ProposalPublicTermsInventory {
  const sections: ProposalPublicTermSection[] = [];
  const limited = (): ProposalPublicTermsInventory => ({ sections: [], limited: true });
  if (sources.length > PROPOSAL_PUBLIC_TERMS_LIMITS.sources || sources.some((source) => !validId(source.id)) || new Set(sources.map((source) => source.id)).size !== sources.length) return limited();
  let fragments = 0, bytes = 0, clauses = 0;
  for (const source of sources) {
    const selected = source.fragments || [];
    const ids = selected.flatMap((fragment) => fragment.id === undefined ? [] : [fragment.id]);
    if (new Set(ids).size !== ids.length || ids.some((id) => !validId(id))) return limited();
    for (const fragment of selected) {
      if (++fragments > PROPOSAL_PUBLIC_TERMS_LIMITS.fragments || fragment.text.length > PROPOSAL_PUBLIC_TERMS_LIMITS.fragment || (bytes += new TextEncoder().encode(fragment.text).byteLength) > PROPOSAL_PUBLIC_TERMS_LIMITS.bytes) return limited();
    }
    const inline = inlinePdfTerms(source);
    if (inline) { if (++clauses > PROPOSAL_PUBLIC_TERMS_LIMITS.clauses) return limited(); sections.push(inline); continue; }
    if (!proposalPublicTermsOwnerIsUnambiguous(source)) continue;
    const headings = selected.flatMap((fragment, index) => cpHeading.test(fragment.text.trim()) ? [{ fragment, index }] : []);
    const mainNumber = paragraphNumber(headings[0].fragment);
    if (mainNumber === undefined) continue;
    const main: Row = { source, ...headings[0], number: mainNumber };
    const owned: ProposalPublicTermSection[] = [];
    let section: { heading: Row; last: Row; clauses: ProposalPublicTermClause[] } | undefined;
    let invalid = false, active = true;
    const close = () => {
      if (section?.clauses.length) owned.push({ proposal: proof(main), heading: proof(section.heading), clauses: section.clauses });
      section = undefined;
    };
    for (let index = main.index + 1; index < selected.length && active; index++) {
      const fragment = selected[index], number = paragraphNumber(fragment);
      if (!visible(fragment)) { invalid = true; break; }
      if (number === undefined) { if (section || sectionHeading.test(fragment.text.trim())) invalid = true; section = undefined; if (invalid) break; continue; }
      const row: Row = { source, fragment, index, number }, text = fragment.text.trim();
      if (fragment.sheetId !== main.fragment.sheetId || documentHeading.test(text) || numberedDocumentHeading.test(text)) { invalid ||= Boolean(section); active = false; continue; }
      if (signoff.test(text) || closingHeading.test(text)) {
        // Omitted empty DOCX paragraphs may cause a numeric gap before the
        // literal sign-off, but never between heading and accepted clauses.
        if (section && (!sameRun(section.last, row) || row.number <= section.last.number || closingHeading.test(text) && !adjacent(section.last, row))) invalid = true;
        if (!invalid) close();
        active = false; continue;
      }
      if (sectionHeading.test(text)) {
        if (section && !adjacent(section.last, row)) { invalid = true; break; }
        close(); section = { heading: row, last: row, clauses: [] }; continue;
      }
      if (!section) continue;
      if (!adjacent(section.last, row) || /[:：]$/u.test(text)) { invalid = true; break; }
      const clauseRole = role(text, section.heading.fragment.text.trim());
      if (!clauseRole) { invalid = true; break; }
      if (fragment.text.length > PROPOSAL_PUBLIC_TERMS_LIMITS.quote || section.heading.fragment.text.length > PROPOSAL_PUBLIC_TERMS_LIMITS.quote || main.fragment.text.length > PROPOSAL_PUBLIC_TERMS_LIMITS.quote || ++clauses > PROPOSAL_PUBLIC_TERMS_LIMITS.clauses || section.clauses.length >= PROPOSAL_PUBLIC_TERMS_LIMITS.sectionClauses) return limited();
      section.clauses.push({ ...proof(row), role: clauseRole }); section.last = row;
    }
    // A selected prefix is not a closed section, even if the original source
    // once claimed complete extraction. Require the visible literal terminator.
    if (section) invalid = true;
    if (!invalid) sections.push(...owned);
  }
  return { sections, limited: false };
}

const entries = (sections: readonly ProposalPublicTermSection[]) => sections.flatMap((section) => [section.heading, ...section.clauses]);
const claimKey = (claim: IntelligenceEvidence) => JSON.stringify([claim.field, claim.sourceId, claim.fragmentId, claim.quote]);
export function proposalPublicTermsNeedProof(value: string): boolean {
  // Only the explicit headed block format added by this preparation. Ordinary
  // standalone delivery prose keeps its existing evidence contract.
  return value.split(/\r?\n/u).some((text) => sectionHeading.test(text.trim()) || /^срок\s+действия\s+коммерческого\s+предложения\s*[:：]/iu.test(text.trim()) || /^стоимость\s+предложения\s+действительна\s+при\s+официальном\s+курсе/iu.test(text.trim()));
}
function isOrderedWholeClauseSubset(value: string, sections: readonly ProposalPublicTermSection[]): boolean {
  if (!value.trim() || value.length > PROPOSAL_PUBLIC_TERMS_LIMITS.field || proposalPublicTermsNeedProof(value)) return false;
  let remaining = literal(value), consumed = false;
  for (const clause of sections.flatMap((section) => section.clauses)) {
    const text = literal(clause.quote);
    if (remaining !== text && !remaining.startsWith(`${text} `)) continue;
    remaining = remaining.slice(text.length).trim(); consumed = true;
    if (!remaining) break;
  }
  return consumed && !remaining;
}

/** Preserves private notes and any existing public prefix. An unsupported old
 * prefix is not made trustworthy by appending new source-backed paragraphs. */
export function completeProposalPublicTerms(items: readonly IntelligenceItem[], sources: readonly IntelligenceSource[]): SourcePreparationResult {
  const unchanged = (): SourcePreparationResult => ({ items: [...items], changes: [], skipped: [], limited: false });
  const stop = (): SourcePreparationResult => ({ ...unchanged(), limited: true, skipped: [{ reason: "proposal-public-terms-limit", message: "Публичные оговорки не дополнены: достигнут предел или повторяются идентификаторы. Исходные значения не усечены.", requiresReview: true }] });
  if (!items.some((item) => item.destination === "proposals")) return unchanged();
  if (items.length > PROPOSAL_PUBLIC_TERMS_LIMITS.items || items.some((item) => !validId(item.id)) || new Set(items.map((item) => item.id)).size !== items.length) return stop();
  const inventory = extractProposalPublicTerms(sources);
  if (inventory.limited) return stop();
  const result = unchanged();
  for (const [index, item] of items.entries()) {
    if (item.destination !== "proposals") continue;
    const sections = inventory.sections.filter((section) => item.sourceIds.includes(section.heading.sourceId));
    if (!sections.length) continue;
    if (new Set(sections.map((section) => section.heading.sourceId)).size !== 1 || sections.some((section) => items.filter((other) => other.destination === "proposals" && other.sourceIds.includes(section.heading.sourceId)).length !== 1)) {
      result.skipped.push({ itemId: item.id, field: "deliveryTerms", reason: "ambiguous-proposal-public-terms", message: "Оговорки относятся к нескольким источникам или карточкам. Распределение не выполнено по порядку.", requiresReview: true }); continue;
    }
    const previous = item.fields.deliveryTerms;
    if (previous !== undefined && typeof previous !== "string") { result.skipped.push({ itemId: item.id, field: "deliveryTerms", reason: "invalid-proposal-public-terms", message: "Формат условий повреждён. Старое значение сохранено без изменений.", requiresReview: true }); continue; }
    // Canonicalize only a fully consumed, correctly ordered sequence of whole
    // source paragraphs. A paraphrase, shorter clause, changed number, foreign
    // suffix or reordered text can never be consumed by this exact matcher.
    let value = typeof previous === "string" && isOrderedWholeClauseSubset(previous, sections)
      ? entries(sections).map((entry) => entry.quote).join("\n") : previous || "";
    // Existing literal paragraphs are kept once; no semantic paraphrase or
    // number-insensitive deduplication is permitted.
    for (const entry of entries(sections)) if (!literal(value).includes(literal(entry.quote))) value += `${value ? "\n" : ""}${entry.quote}`;
    const evidence = [...(item.evidence || [])], keys = new Set(evidence.map(claimKey));
    for (const entry of sections.flatMap((section) => [section.proposal, section.heading, ...section.clauses])) {
      const claim: IntelligenceEvidence = { field: "deliveryTerms", sourceId: entry.sourceId, fragmentId: entry.fragmentId, quote: entry.quote };
      if (!keys.has(claimKey(claim))) { evidence.push(claim); keys.add(claimKey(claim)); }
    }
    if (value.length > PROPOSAL_PUBLIC_TERMS_LIMITS.field || evidence.length > PROPOSAL_PUBLIC_TERMS_LIMITS.evidence) return stop();
    if (value !== previous || evidence.length !== (item.evidence || []).length || !item.selectedFields.includes("deliveryTerms")) {
      result.items[index] = { ...item, fields: { ...item.fields, deliveryTerms: value }, selectedFields: [...new Set([...item.selectedFields, "deliveryTerms"])], evidence };
      const primary = sections[0].clauses[0];
      result.changes.push({ sourceId: primary.sourceId, sourceName: primary.sourceName, fragmentId: primary.fragmentId, locator: primary.locator, quote: primary.quote, itemId: item.id, field: "deliveryTerms", kind: previous === undefined ? "added" : "replaced", ...(previous === undefined ? {} : { previousValue: previous }), value, requiresReview: true });
    }
  }
  return result.changes.length + result.skipped.length > PROPOSAL_PUBLIC_TERMS_LIMITS.receipts || new TextEncoder().encode(JSON.stringify(result)).byteLength > PROPOSAL_PUBLIC_TERMS_LIMITS.resultBytes ? stop() : result;
}

/** Confirms the entire public field, never a subset or an arbitrary prefix.
 * Role/context claims must coexist with every full current literal clause. */
export function createProposalPublicTermsProver(sources: readonly IntelligenceSource[]) {
  // One fresh bounded inventory per synchronous audit, never a persisted
  // receipt or a global cache; each card still has its own owner/claim checks.
  const inventory = extractProposalPublicTerms(sources);
  const prove = (item: IntelligenceItem, items: readonly IntelligenceItem[]): { evidence: SourcePreparationProvenance[]; claims: Set<IntelligenceEvidence> } | undefined => {
  if (inventory.limited || item.destination !== "proposals" || !item.selectedFields.includes("deliveryTerms") || typeof item.fields.deliveryTerms !== "string" || !item.fields.deliveryTerms.trim() || items.length > PROPOSAL_PUBLIC_TERMS_LIMITS.items || new Set(items.map((entry) => entry.id)).size !== items.length) return;
  const sections = inventory.sections.filter((section) => item.sourceIds.includes(section.heading.sourceId));
  if (!sections.length || new Set(sections.map((section) => section.heading.sourceId)).size !== 1 || sections.some((section) => items.filter((other) => other.destination === "proposals" && other.sourceIds.includes(section.heading.sourceId)).length !== 1)) return;
  if (literal(item.fields.deliveryTerms) !== literal(entries(sections).map((entry) => entry.quote).join("\n"))) return;
  const required = sections.flatMap((section) => [section.proposal, section.heading, ...section.clauses]);
  if ((item.evidence || []).length > PROPOSAL_PUBLIC_TERMS_LIMITS.evidence) return;
  const claims = new Set<IntelligenceEvidence>();
  for (const entry of required) {
    const matching = item.evidence?.filter((candidate) => candidate.field === "deliveryTerms" && candidate.sourceId === entry.sourceId && candidate.fragmentId === entry.fragmentId && candidate.quote === entry.quote);
    if (!matching?.length) return;
    for (const claim of matching) claims.add(claim);
  }
  return { evidence: entries(sections), claims };
  };
  return { prove, needsProof: (item: IntelligenceItem) => {
    const value = item.fields.deliveryTerms;
    if (item.destination !== "proposals" || typeof value !== "string") return false;
    if (proposalPublicTermsNeedProof(value)) return true;
    const text = literal(value);
    return text.length >= 16 && inventory.sections.some((section) => item.sourceIds.includes(section.heading.sourceId) && section.clauses.some((clause) => text.includes(literal(clause.quote)) || literal(clause.quote).includes(text)));
  } };
}
export function proveProposalPublicTerms(item: IntelligenceItem, items: readonly IntelligenceItem[], sources: readonly IntelligenceSource[]) {
  return createProposalPublicTermsProver(sources).prove(item, items);
}
