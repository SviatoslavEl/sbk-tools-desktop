import type { IntelligenceEvidence, IntelligenceFragment, IntelligenceItem, IntelligenceSource } from "./workbenchTypes";
import type { SourcePreparationChange, SourcePreparationSkipped } from "./sourcePreparedFacts";
import { multipleLots } from "./automaticConditions";
import { completeProposalPublicTerms, extractProposalPublicTerms, proposalPublicTermsOwnerIsUnambiguous } from "./proposalPublicTerms";

export interface SourceTextCompletionResult { items: IntelligenceItem[]; changes: SourcePreparationChange[]; skipped: SourcePreparationSkipped[]; limited: boolean }
export const SOURCE_TEXT_LIMITS = Object.freeze({ items: 100, sources: 100, fragments: 5000, bytes: 2 * 1024 * 1024, fragment: 20000, quote: 2000, field: 20000, evidence: 500, receipts: 500, resultBytes: 8 * 1024 * 1024 });
type Material = { source: IntelligenceSource; fragment: IntelligenceFragment; index: number };
type Fact = { field: string; value: string; row: Material; support?: Material; append?: true; evidenceOnly?: true };
const normalized = (value: string) => value.normalize("NFKC").toLocaleLowerCase("ru").replace(/ё/gu, "е").replace(/\s+/gu, " ").trim();
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
const proof = (row: Material) => ({ sourceId: row.source.id, sourceName: row.source.name, fragmentId: row.fragment.id, locator: row.fragment.locator, quote: row.fragment.text });
const visible = (fragment: IntelligenceFragment) => fragment.sheetState !== "hidden" && fragment.sheetState !== "veryHidden";
const cpHeading = /^(?:коммерческое\s+предложение|кп)(?:\s*№\s*[\p{L}\d/._-]+)?\s*$/iu;
const absent = (value: unknown, field = "") => value === undefined || typeof value === "string" && (!value.trim() || /^(?:null|undefined|n\/a|не\s+(?:указан[аоы]?|предоставлен[аоы]?)|нет\s+данных)$/iu.test(value.trim()) || /^(?:title|name)$/u.test(field) && /^(?:коммерческое\s+предложение|кп|закупка|тендер)$/iu.test(value.trim()));
const paragraph = (entry: Material) => /^paragraph-\d+$/u.test(entry.fragment.id || "") || /^Абзац\s+\d+$/iu.test(entry.fragment.locator);
const adjacent = (left: Material, right: Material) => {
  const coordinate = (entry: Material) => /^paragraph-(\d+)$/u.exec(entry.fragment.id || "") || /^Абзац\s+(\d+)$/iu.exec(entry.fragment.locator);
  const a = coordinate(left), b = coordinate(right);
  return left.source === right.source && right.index === left.index + 1 && left.fragment.sheetId === right.fragment.sheetId && paragraph(left) && paragraph(right) && a && b && Number(b[1]) === Number(a[1]) + 1;
};

function platform(text: string): string | undefined {
  try {
    const url = new URL(text.trim());
    // This is an explicit procurement URL, never a company name derived from
    // a filename or an arbitrary website. Retain the literal host, not a label
    // invented by the model or a translated platform brand.
    return /^https?:$/u.test(url.protocol) && !url.username && !url.password && /^(?:www\.)?(?:bidzaar\.com|roseltorg\.ru|rts-tender\.ru|sberbank-ast\.ru)$/iu.test(url.hostname) ? url.hostname : undefined;
  } catch { return undefined; }
}

function sameTableRun(material: Material[], left: Material, right: Material): boolean {
  const coordinate = (entry: Material) => /^(.*-row-)(\d+)$/u.exec(entry.fragment.id || "");
  const ordered = [left, right].sort((a, b) => a.index - b.index), first = coordinate(ordered[0]);
  if (!first || ordered[1].index - ordered[0].index > 128) return false;
  const run = material.filter((entry) => entry.index >= ordered[0].index && entry.index <= ordered[1].index);
  return run.length === ordered[1].index - ordered[0].index + 1 && run.every((entry, index) => {
    const current = coordinate(entry);
    return entry.source === left.source && entry.fragment.sheetId === left.fragment.sheetId && current?.[1] === first[1] && Number(current[2]) === Number(first[2]) + index;
  });
}

function procurementFacts(material: Material[]): Fact[] {
  const facts: Fact[] = [];
  const numberedParagraph = (row: Material) => {
    const id = /^paragraph-([1-9]\d*)$/u.exec(row.fragment.id || ""), locator = /^Абзац\s+([1-9]\d*)$/iu.exec(row.fragment.locator);
    return Boolean(id && locator && id[1] === locator[1]);
  };
  const taskHeadings = material.filter((row) => numberedParagraph(row) && /^техническое\s+задание$/iu.test(row.fragment.text.trim()));
  const oneTechnicalDocument = taskHeadings.length === 1 && !material.some((row) => /^(?:(?:договор|контракт)(?:\s|$)|коммерческое\s+предложение(?:\s|$))/iu.test(row.fragment.text.trim()));
  if (oneTechnicalDocument) {
    const heading = taskHeadings[0], next = material.find((row) => row.index === heading.index + 1);
    if (next && numberedParagraph(next) && adjacent(heading, next) && /^на\s+(?:поставк|оказание|выполнение)[^\n\t]{1,280}\s+для\s+нужд\s+\S/iu.test(next.fragment.text.trim())) {
      facts.push({ field: "name", value: next.fragment.text.trim(), row: next });
    }
  }
  for (const row of material) {
    if (!oneTechnicalDocument || row.index <= taskHeadings[0].index || !numberedParagraph(row)) continue;
    // Only explicit role labels, not filenames, salutation order or an
    // organizer's identity. The explanatory user definition is not a name.
    const customer = /^Заказчик\s*[-–—:]\s*(.+?),\s*конечный\s+пользователь(?:,|\s)/iu.exec(row.fragment.text.trim());
    if (customer && customer[1].length <= 1000 && /^(?:акционерн[а-я\s]+банк|акционерное\s+общество|публичное\s+акционерное\s+общество|общество\s+с\s+ограниченной\s+ответственностью|(?:АКБ|АО|ПАО|ООО)\s)/iu.test(customer[1])) {
      facts.push({ field: "customer", value: customer[1], row });
    }
    const subject = /^Предмет\s+закупки\s*:\s*(\S[\s\S]*)$/iu.exec(row.fragment.text.trim());
    if (subject && subject[1].length <= 2000) facts.push({ field: "subject", value: subject[1], row });
  }
  const rows = material.flatMap((row) => {
    const cells = row.fragment.text.split("\t");
    if (cells.length !== 2 || cells.some((cell) => /\r?\n/u.test(cell)) || !cells[1].trim()) return [];
    const label = cells[0].trim().replace(/[:：]$/u, ""), value = cells[1].trim();
    return [{ row, label, value }];
  });
  const requestLabel = /^(?:запрос|предмет\s+(?:закупки|договора|запроса))$/iu;
  const customerLabel = /^заказчик(?:\s*\(наименование\))?$/iu;
  const companyKey = (value: string) => normalized(value).replace(/["«»„“”]/gu, "").replace(/^(?:ао|пао|оао|зао|ооо|ано)\s+/iu, "").replace(/[.;]$/u, "").trim();
  const beneficiaryRows = rows.flatMap(({ row, label, value }) => {
    const match = requestLabel.test(label) ? /(?:^|\s)для\s+нужд\s+(.+)$/iu.exec(value) : null;
    return match ? [{ key: companyKey(match[1]), row }] : [];
  });
  const beneficiaries = [...new Set(beneficiaryRows.map((entry) => entry.key))];
  const hasCustomer = rows.some(({ label }) => customerLabel.test(label));
  const organizerLabel = /^организатор(?:\s*\(наименование\))?$/iu;
  const organizers = new Set(rows.filter(({ label }) => organizerLabel.test(label)).map(({ value }) => normalized(value)));
  for (const { row, label, value } of rows) {
    if (/^(?:запрос|наименование\s+закупки|название\s+закупки)$/iu.test(label)) facts.push({ field: "name", value, row });
    if (requestLabel.test(label)) facts.push({ field: "subject", value, row });
    if (customerLabel.test(label)) facts.push({ field: "customer", value, row });
    if (!hasCustomer && organizers.size === 1 && organizerLabel.test(label) && beneficiaries.length === 1) {
      // An organizer is not necessarily the customer. Only a separate explicit
      // request naming this same company as beneficiary establishes this role.
      // A short name may precede a literal legal-form expansion, not arbitrary
      // parenthesized business text; never derive either name from a filename.
      const expanded = /^(.+?)\s*\((?:акционерное\s+общество|публичное\s+акционерное\s+общество|общество\s+с\s+ограниченной\s+ответственностью)\s/iu.exec(value);
      const support = beneficiaryRows.find((entry) => sameTableRun(material, entry.row, row))?.row;
      if (support && [companyKey(value), ...(expanded ? [companyKey(expanded[1])] : [])].includes(beneficiaries[0])) facts.push({ field: "customer", value, row, support });
    }
    if (/^(?:ссылка|площадка|электронная\s+(?:торговая\s+)?площадка|этп)$/iu.test(label)) {
      const host = platform(value); if (host) facts.push({ field: "platform", value: host, row });
    }
  }
  return facts;
}

/** Narrow collective role proof only. The request establishes why an organizer
 * is the customer; its short legal name need not repeat the full expansion.
 * It never confirms arbitrary aliases or exempts the organizer's value proof. */
export function isOrganizerBeneficiarySupport(value: string, source: IntelligenceSource, claim: IntelligenceEvidence, claims: readonly IntelligenceEvidence[]): boolean {
  if (value.length > SOURCE_TEXT_LIMITS.field || claims.length > SOURCE_TEXT_LIMITS.evidence || claim.field !== "customer" || claim.sourceId !== source.id || !claim.fragmentId) return false;
  const selected = source.fragments || [];
  if (selected.length > SOURCE_TEXT_LIMITS.fragments) return false;
  let charged = 0;
  const duplicateIds = new Set(selected.filter((fragment, index) => fragment.id && selected.findIndex((entry) => entry.id === fragment.id) !== index).map((fragment) => fragment.id));
  const material: Material[] = [];
  for (const [index, fragment] of selected.entries()) {
    if (!visible(fragment)) continue;
    if (fragment.text.length > SOURCE_TEXT_LIMITS.fragment || (charged += bytes(fragment.text)) > SOURCE_TEXT_LIMITS.bytes) return false;
    if (!fragment.id || duplicateIds.has(fragment.id)) continue;
    material.push({ source, fragment, index });
  }
  const facts = procurementFacts(material).filter((fact) => fact.field === "customer");
  if (!facts.length || new Set(facts.map((fact) => fact.value)).size !== 1 || facts[0].value !== value) return false;
  const exact = (entry: IntelligenceEvidence, row: Material) => entry.field === "customer" && entry.sourceId === source.id && entry.fragmentId === row.fragment.id && entry.quote === row.fragment.text;
  return facts.some((fact) => fact.support && exact(claim, fact.support) && claims.some((entry) => exact(entry, fact.support!)) && claims.some((entry) => exact(entry, fact.row)));
}

function paymentProofFacts(material: Material[], item: IntelligenceItem, proposalHeading: Material): Fact[] {
  if (!item.selectedFields.includes("paymentTerms") || typeof item.fields.paymentTerms !== "string" || !item.fields.paymentTerms.trim()
    || proposalHeading.source.coverage?.complete === false || proposalHeading.source.coverage?.requiresOcr) return [];
  const whitespace = (value: string) => value.replace(/\s+/gu, " ").trim();
  const number = (row: Material) => {
    const id = /^paragraph-(\d+)$/u.exec(row.fragment.id || ""), locator = /^Абзац\s+(\d+)$/iu.exec(row.fragment.locator);
    return (!id && !locator || id && locator && id[1] !== locator[1]) ? undefined : Number((id || locator)![1]);
  };
  const headings = material.filter((row) => row.index > proposalHeading.index && number(row) !== undefined && /^(?:условия|порядок)\s+оплаты\s*[:.]?$/iu.test(row.fragment.text.trim()));
  if (headings.length !== 1) return [];
  const heading = headings[0], clauses: Material[] = [];
  let previous = heading, closed = false, characters = 0;
  for (const row of material.filter((entry) => entry.index > heading.index)) {
    const sameScope = row.source === previous.source && row.fragment.sheetId === previous.fragment.sheetId && row.index === previous.index + 1;
    const before = number(previous), after = number(row), text = row.fragment.text.trim();
    const closing = /^(?:оговорки|условия\s+(?:выполнения|поставки)|срок\s+действия\s+предложения|реквизиты|контакты|заключение)\s*[:：]$/iu.test(text);
    // The closing heading may follow an omitted empty paragraph; this never
    // joins payment clauses across a hidden/excluded fragment or numeric gap.
    if (sameScope && before !== undefined && after !== undefined && after > before && closing) { closed = true; break; }
    if (!sameScope || before === undefined || after !== before + 1 || /\t/u.test(text)) return [];
    if (!/(?:аванс|предоплат|постоплат|оплат|плат[её]ж|расч[её]т)/iu.test(text) || !/(?:\d\s*%|дн[её]й|календарных|подписан|при[её]мк|отказ)/iu.test(text)) return [];
    if (clauses.length >= 200 || (characters += row.fragment.text.length) > SOURCE_TEXT_LIMITS.field) return [];
    clauses.push(row); previous = row;
  }
  // A selected snapshot ending mid-section must not manufacture completeness.
  // Recover only a whole, explicitly terminated section, never a partial50%.
  if (!closed || clauses.length < 2 || whitespace(clauses.map((row) => row.fragment.text).join("\n")) !== whitespace(item.fields.paymentTerms)) return [];
  return clauses.map((row) => ({ field: "paymentTerms", value: item.fields.paymentTerms as string, row, evidenceOnly: true }));
}

function proposalFacts(material: Material[], item: IntelligenceItem, preserveReviewNote = false): Fact[] {
  const headings = material.filter((row) => cpHeading.test(row.fragment.text.trim()));
  if (headings.length !== 1) return [];
  const facts: Fact[] = [], heading = headings[0], next = material.find((row) => row.index === heading.index + 1);
  if (next && adjacent(heading, next) && next.fragment.text.trim().length <= 300 && !/[\t\n]/u.test(next.fragment.text)
    && /(?:аудит|анализ|оказание|услуг|поставк|разработк|подготовк|тестирован)/iu.test(next.fragment.text)
    && !/(?:нмц|стоимость|цена|инн|заказчик|поставщик|исполнитель|дата|срок)/iu.test(next.fragment.text)) facts.push({ field: "title", value: next.fragment.text.trim(), row: next });
  let section: { heading: Material; rows: number } | undefined, previous: Material | undefined;
  for (const row of material) {
    if (previous && !adjacent(previous, row)) section = undefined;
    previous = row;
    const text = row.fragment.text.trim();
    if (/^(?:благодарим|предлагаем|направляем|представляем)[^\n]{0,200}(?:коммерческ[а-я\s]+предложен|услуг|работ|проект)/iu.test(text)) facts.push({ field: "introduction", value: text, row });
    if (!preserveReviewNote) continue;
    if (/^(?:оговорки|условия\s+выполнения|срок\s+действия\s+предложения)\s*[:：]?$/iu.test(text)) { section = { heading: row, rows: 0 }; continue; }
    if (!section) continue;
    if (++section.rows > 6 || !paragraph(row) || /[:：]$/u.test(text)) { section = undefined; continue; }
    const relativeValidity = /^\d{1,3}\s+календарных\s+дней\s+с\s+даты\s+исходящего\s+письма[.;]?$/iu.test(text);
    const agreedScope = /(?:периметр|дополнительн[а-я]*\s+работ|состав[а-я\s]+проектн[а-я\s]+команд|этап[а-я\s]+запуска\s+проекта)/iu.test(text) && /(?:согласован|согласовани|уточняют|учетом|с\s+уч[её]том)/iu.test(text);
    if (relativeValidity || agreedScope) facts.push({ field: "internalNote", value: text, row, support: section.heading, append: true });
  }
  return [...facts, ...paymentProofFacts(material, item, heading)];
}

/** Source-first literal text only. No cards, dates, prices, permissions, links
 * to files or acknowledgements are created. Relative validity remains text;
 * public execution/validity caveats have their own narrowly scoped literal
 * preparation and proof. Private notes are never used as their source. */
export function completeSourceTextFields(items: readonly IntelligenceItem[], sources: readonly IntelligenceSource[]): SourceTextCompletionResult {
  const result: SourceTextCompletionResult = { items: [...items], changes: [], skipped: [], limited: false };
  const skip = (reason: string, message: string, extra: Partial<SourcePreparationSkipped> = {}) => result.skipped.push({ reason, message, requiresReview: true, ...extra });
  const limit = (): SourceTextCompletionResult => ({ items: [...items], changes: [], skipped: [{ reason: "source-text-limit", message: "Предел подготовки текста достигнут. Ничего не усечено; разделите материалы.", requiresReview: true }], limited: true });
  if (items.length > SOURCE_TEXT_LIMITS.items || sources.length > SOURCE_TEXT_LIMITS.sources) return limit();
  if (!items.some((item) => item.destination === "procurement" || item.destination === "proposals")) return result;
  const material = new Map<string, Material[]>(), duplicateSources = new Set(sources.filter((source, index) => sources.findIndex((entry) => entry.id === source.id) !== index).map((source) => source.id));
  let fragments = 0, totalBytes = 0;
  for (const source of sources) {
    if (!source.id || duplicateSources.has(source.id)) { skip("invalid-source", "Источник с отсутствующим или повторённым идентификатором не использован."); continue; }
    const selected = source.fragments === undefined ? [{ locator: "Текст источника", text: source.text }] : source.fragments;
    const duplicateFragments = new Set(selected.filter((row, index) => row.id && selected.findIndex((entry) => entry.id === row.id) !== index).map((row) => row.id));
    const rows: Material[] = [];
    for (const [index, fragment] of selected.entries()) {
      if (++fragments > SOURCE_TEXT_LIMITS.fragments) return limit();
      if (!visible(fragment)) continue;
      if ((totalBytes += bytes(fragment.text)) > SOURCE_TEXT_LIMITS.bytes || fragment.text.length > SOURCE_TEXT_LIMITS.fragment) return limit();
      if (fragment.id && duplicateFragments.has(fragment.id)) continue;
      rows.push({ source, fragment, index });
    }
    material.set(source.id, rows);
  }
  const publicInventory = items.some((item) => item.destination === "proposals")
    ? extractProposalPublicTerms(sources) : { sections: [], limited: false };
  const publicSources = new Set(publicInventory.sections.map((section) => section.heading.sourceId));
  for (const [index, item] of items.entries()) {
    if (item.destination !== "procurement" && item.destination !== "proposals") continue;
    const facts: Fact[] = [];
    for (const id of item.sourceIds) {
      const rows = material.get(id), source = rows?.[0]?.source; if (!rows || !source) continue;
      if (items.filter((entry) => entry.destination === item.destination && entry.sourceIds.includes(id)).length !== 1 || item.destination === "procurement" && multipleLots(source)) { skip("ambiguous-card-scope", "Источник относится к нескольким карточкам или лотам. Текст не распределён автоматически.", { itemId: item.id, sourceId: id }); continue; }
      const sourceFacts = item.destination === "procurement" ? procurementFacts(rows) : proposalFacts(rows, item, !publicInventory.limited && !publicSources.has(id) && proposalPublicTermsOwnerIsUnambiguous(source));
      if (sourceFacts.some((fact) => fact.field === "internalNote")) skip("proposal-public-terms-review", "Буквальные оговорки сохранены только в приватной заметке для проверки: публичная секция не подтверждена полностью или не закрыта. Они не перенесены в экспортируемые условия.", { itemId: item.id, field: "deliveryTerms", sourceId: id });
      facts.push(...sourceFacts);
    }
    const fields = { ...item.fields }, evidence = [...(item.evidence || [])], changes: SourcePreparationChange[] = [];
    let failed = false;
    for (const field of [...new Set(facts.map((fact) => fact.field))]) {
      const candidates = facts.filter((fact) => fact.field === field), append = field === "internalNote", evidenceOnly = candidates.every((fact) => fact.evidenceOnly);
      if (new Set(candidates.map((fact) => fact.row.source.id)).size > 1 || !append && new Set(candidates.map((fact) => normalized(fact.value))).size > 1) { skip("conflicting-source-text", "Источники содержат разные значения текстового поля; значение не выбрано по порядку.", { itemId: item.id, field }); continue; }
      if (!append && !evidenceOnly && !absent(fields[field], field) || append && fields[field] !== undefined && typeof fields[field] !== "string") continue;
      const entries = (append || evidenceOnly ? candidates : candidates.slice(0, 1)).flatMap((fact) => fact.support ? [fact.support, fact.row] : [fact.row]);
      if (entries.some((entry) => entry.fragment.text.length > SOURCE_TEXT_LIMITS.quote)) { failed = true; break; }
      const original = fields[field]; let value = append ? String(original || "") : candidates[0].value;
      if (append) for (const entry of entries) if (!normalized(value).includes(normalized(entry.fragment.text))) value += `${value ? "\n" : ""}${entry.fragment.text}`;
      if (value.length > SOURCE_TEXT_LIMITS.field) { failed = true; break; }
      fields[field] = value;
      if (!append && !evidenceOnly) for (let at = evidence.length - 1; at >= 0; at--) if (evidence[at].field === field) evidence.splice(at, 1);
      const evidenceBefore = evidence.length;
      for (const entry of entries) {
        const claim = { field, sourceId: entry.source.id, fragmentId: entry.fragment.id, quote: entry.fragment.text };
        if (!evidence.some((old) => old.field === field && old.sourceId === claim.sourceId && old.fragmentId === claim.fragmentId && old.quote === claim.quote)) evidence.push(claim);
      }
      if (evidence.length > SOURCE_TEXT_LIMITS.evidence) { failed = true; break; }
      if (value !== original || !item.selectedFields.includes(field) || evidenceOnly && evidence.length > evidenceBefore) changes.push({ itemId: item.id, field, kind: original === undefined ? "added" : "replaced", ...proof(candidates[0].row), ...(original === undefined ? {} : { previousValue: original }), value, requiresReview: true });
    }
    if (failed) { result.limited = true; skip("source-text-card-limit", "Полные цитаты или поля не помещаются в предел. Карточка оставлена без изменений.", { itemId: item.id }); continue; }
    if (changes.length) result.items[index] = { ...item, fields, selectedFields: [...new Set([...item.selectedFields, ...changes.map((change) => change.field)])], evidence, ...(absent(item.title, "title") && typeof fields.title === "string" ? { title: fields.title } : {}) };
    result.changes.push(...changes);
  }
  const publicTerms = completeProposalPublicTerms(result.items, sources);
  const combined = { items: publicTerms.items, changes: [...result.changes, ...publicTerms.changes], skipped: [...result.skipped, ...publicTerms.skipped], limited: result.limited || publicTerms.limited };
  return combined.changes.length + combined.skipped.length > SOURCE_TEXT_LIMITS.receipts || bytes(JSON.stringify(combined)) > SOURCE_TEXT_LIMITS.resultBytes ? limit() : combined;
}
