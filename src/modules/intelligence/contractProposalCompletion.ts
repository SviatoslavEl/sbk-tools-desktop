import { collectContractProposalFacts, type ContractProposalDocument, type ContractProposalFact, type ContractProposalInventory } from "./contractProposalFacts";
import type { SourcePreparationProvenance, SourcePreparationResult } from "./sourcePreparedFacts";
import type { IntelligenceDestination, IntelligenceEvidence, IntelligenceFieldValue, IntelligenceItem, IntelligenceSource } from "./workbenchTypes";

const LIMITS = Object.freeze({ items: 100, field: 20_000, evidence: 500, receipts: 500, bytes: 8 * 1024 * 1024, quote: 2000 });
const literal = (value: string) => value.replace(/\s+/gu, " ").trim();
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
const proof = (entry: SourcePreparationProvenance): SourcePreparationProvenance => ({ sourceId: entry.sourceId, sourceName: entry.sourceName, ...(entry.fragmentId ? { fragmentId: entry.fragmentId } : {}), locator: entry.locator, quote: entry.quote });
const unique = (facts: readonly ContractProposalFact[]) => facts.filter((fact, index) => facts.findIndex((other) => literal(other.quote) === literal(fact.quote)) === index);
const absent = (value: unknown, field: string) => value === undefined || typeof value === "string" && (!value.trim() || /^(?:null|не\s+указан[аоы]?|нет\s+данных)$/iu.test(value.trim()) || field === "title" && /^(?:коммерческое\s+предложение|кп)$/iu.test(value.trim()));
const claimKey = (claim: IntelligenceEvidence) => JSON.stringify([claim.field, claim.sourceId, claim.fragmentId, claim.quote]);

interface CanonicalField { field: string; value: IntelligenceFieldValue; evidence: SourcePreparationProvenance[] }
function titleFrom(facts: readonly ContractProposalFact[]): string | undefined {
  const subjects = facts.filter((fact) => fact.role === "subject");
  // Editorial shortening is limited to a printed subject phrase. Never use a
  // filename, a company name or a monetary total as the offered service.
  for (const fact of [...subjects.filter((entry) => /комплекс\s+услуг/iu.test(entry.quote)), ...subjects]) {
    const text = fact.quote.replace(/^\s*\d+(?:\.\d+)*[.)]\s*/u, "").trim();
    const match = /(?:комплекс\s+услуг\s+по|услуг[аи]?\s+по|работ[ыа]?\s+по|(?:предмет|наименование)\s*[:—-])\s+([^.;]{5,450})/iu.exec(text);
    const phrase = match?.[1].split(/,\s*(?:состав|перечень|определ[её]н|сформулирован|отраж[её]н)/iu)[0].trim();
    if (phrase && phrase.length <= 190 && !/^(?:направлениям|техническому\s+заданию|приложению)\b/iu.test(phrase)) return `КП: ${phrase}`;
  }
  const exact = subjects.map((fact) => fact.quote.replace(/^\s*\d+(?:\.\d+)*[.)]\s*/u, "").trim()).find((text) => text.length >= 10 && text.length <= 190 && !/\t/u.test(text));
  return exact;
}
function quotes(facts: readonly ContractProposalFact[]) { return unique(facts).map((fact) => fact.quote).join("\n\n"); }
function allEvidence(facts: readonly ContractProposalFact[]): SourcePreparationProvenance[] {
  const entries = facts.flatMap((fact) => [...fact.supportingEvidence, proof(fact)]);
  return entries.filter((entry, index) => entries.findIndex((other) => other.sourceId === entry.sourceId && other.fragmentId === entry.fragmentId && other.locator === entry.locator && other.quote === entry.quote) === index);
}
function canonicalFields(document: ContractProposalDocument, inventory: ContractProposalInventory): CanonicalField[] {
  const facts = inventory.facts.filter((fact) => fact.documentId === document.documentId);
  const subject = unique(facts.filter((fact) => fact.role === "subject"));
  const scope = unique(facts.filter((fact) => fact.role === "scope"));
  const deliverables = unique(facts.filter((fact) => fact.role === "deliverable"));
  const payment = unique(facts.filter((fact) => fact.role === "payment"));
  const delivery = unique(facts.filter((fact) => ["schedule", "dependency", "exclusion"].includes(fact.role)));
  const title = titleFrom(facts), fields: CanonicalField[] = [];
  if (title) fields.push({ field: "title", value: title, evidence: allEvidence(subject) });
  if (subject.length) fields.push({ field: "introduction", value: quotes(subject), evidence: allEvidence(subject) });
  const description = [scope.length ? `Состав работ по исходному документу:\n${quotes(scope)}` : "", deliverables.length ? `Результаты по исходному документу:\n${quotes(deliverables)}` : ""].filter(Boolean).join("\n\n");
  if (title && description) {
    fields.push({ field: "lines", value: [title.replace(/^КП:\s*/u, "")], evidence: allEvidence(subject) });
    fields.push({ field: "lineDescriptions", value: [description], evidence: allEvidence([...scope, ...deliverables]) });
  }
  if (payment.length) fields.push({ field: "paymentTerms", value: quotes(payment), evidence: allEvidence(payment) });
  if (delivery.length) fields.push({ field: "deliveryTerms", value: quotes(delivery), evidence: allEvidence(delivery) });
  for (const [role, field] of [["executor", "issuerName"], ["customer", "recipientName"]] as const) {
    const party = document.parties?.[role];
    if (party) fields.push({ field, value: party.value, evidence: party.evidence });
  }
  return fields;
}

/** Wire evidence has a 2000-character quote budget. Split a long literal row
 * losslessly into contiguous pieces; keep its real fragment and locator. */
function evidenceClaims(field: string, evidence: readonly SourcePreparationProvenance[]): IntelligenceEvidence[] {
  return evidence.flatMap((entry) => {
    const parts: IntelligenceEvidence[] = [];
    for (let start = 0; start < entry.quote.length;) {
      let end = Math.min(start + LIMITS.quote, entry.quote.length);
      if (end < entry.quote.length && /[\uD800-\uDBFF]/u.test(entry.quote[end - 1]) && /[\uDC00-\uDFFF]/u.test(entry.quote[end])) end--;
      parts.push({ field, sourceId: entry.sourceId, ...(entry.fragmentId ? { fragmentId: entry.fragmentId } : {}), quote: entry.quote.slice(start, end) });
      start = end;
    }
    return parts;
  });
}
function documentFor(item: IntelligenceItem, items: readonly IntelligenceItem[], inventory: ContractProposalInventory): ContractProposalDocument | undefined {
  const candidates = inventory.documents.filter((document) => document.eligible && document.complete && document.sourceIds.every((id) => item.sourceIds.includes(id)));
  if (candidates.length !== 1 || inventory.documents.some((document) => document.sourceIds.some((id) => item.sourceIds.includes(id)) && document.documentId !== candidates[0].documentId)) return;
  if (items.filter((other) => other.destination === "proposals" && candidates[0].sourceIds.some((id) => other.sourceIds.includes(id))).length !== 1) return;
  return candidates[0];
}
function wholeSubset(previous: string, canonical: string): boolean {
  const old = literal(previous), full = literal(canonical);
  return Boolean(old) && full.includes(old);
}
function emptyUnboundProposal(item: IntelligenceItem): boolean {
  const genericTitle = (value: string) => /^(?:коммерческое\s+предложение|кп|проект\s+(?:коммерческого\s+предложения|кп))\s*[.:]?$/iu.test(value.trim());
  if (item.destination !== "proposals" || item.sourceIds.length || item.title.trim() && !genericTitle(item.title)) return false;
  // Inspect every field, not just selected fields: unchecked model facts must
  // never acquire an inferred source owner. Zero and false are also facts.
  if (Object.entries(item.fields).some(([field, value]) => typeof value === "string" ? Boolean(value.trim()) && !(field === "title" && genericTitle(value)) : !Array.isArray(value) || value.length > 0)) return false;
  return [item.evidence, item.staffDocuments, item.proposalSourceFinancials, item.proposalSourceParties].every((value) => value === undefined || Array.isArray(value) && value.length === 0);
}

/** Literal source-derived preparation, never a provider response or approval.
 * No dates, prices, quantities, files, contacts or acknowledgements are made. */
export function completeContractProposalFields(items: readonly IntelligenceItem[], sources: readonly IntelligenceSource[], destinations: readonly IntelligenceDestination[]): SourcePreparationResult {
  const unchanged = (): SourcePreparationResult => ({ items: [...items], changes: [], skipped: [], limited: false });
  const stop = (reason: string, message: string): SourcePreparationResult => ({ ...unchanged(), limited: true, skipped: [{ reason, message, requiresReview: true }] });
  if (!destinations.includes("proposals")) return unchanged();
  if (items.length > LIMITS.items || new Set(items.map((item) => item.id)).size !== items.length) return stop("contract-proposal-item-limit", "Состав КП не подготовлен: превышен предел либо повторяются идентификаторы карточек.");
  const inventory = collectContractProposalFacts(sources);
  if (inventory.limited) return stop("contract-proposal-inventory-limit", "Договор или ТЗ не разобраны целиком. Частичное дополнение не выполнено; разделите материалы.");
  const result = unchanged();
  const eligible = inventory.documents.filter((document) => document.eligible && document.complete);
  // A provider may return one schema-valid empty shell with sourceIds:[]
  // instead of items:[]. The explicit sole КП task and fresh unique document,
  // not any model value or a prior ACK, establish the source-derived owner.
  // Preserve the shell's ID and the raw response; meaningful unbound replies
  // keep their unresolved ownership and are never blessed by this recovery.
  if (destinations.length === 1 && result.items.length === 1 && eligible.length === 1 && inventory.documents.length === 1 && emptyUnboundProposal(result.items[0])) {
    const document = eligible[0], original = result.items[0], fact = inventory.facts.find((entry) => entry.documentId === document.documentId);
    if (fact) {
      result.items[0] = { ...original, sourceIds: [...document.sourceIds] };
      result.changes.push({ ...proof(fact), quote: fact.quote.slice(0, LIMITS.quote), itemId: original.id, field: "record", kind: "replaced", previousValue: [], value: [...document.sourceIds], requiresReview: true });
      result.skipped.push({ ...proof(fact), quote: fact.quote.slice(0, LIMITS.quote), itemId: original.id, reason: "contract-proposal-empty-shell-bound", message: "Пустая карточка ИИ не указала источники. По явно выбранной задаче КП она связана с единственным полностью извлечённым договором / ТЗ и дополнена его данными. Исходный ответ сохранён; проверьте применимость исходных условий.", requiresReview: true });
    }
  }
  // Creation is deliberately restricted to the explicit standalone КП task.
  // A multi-direction request must not manufacture a new intention or owner.
  if (!items.some((item) => item.destination === "proposals") && destinations.length === 1 && eligible.length === 1 && inventory.documents.length === 1) {
    const document = eligible[0], fields = canonicalFields(document, inventory);
    const title = fields.find((field) => field.field === "title")?.value;
    if (typeof title === "string" && fields.some((field) => field.field === "lineDescriptions")) {
      const fact = inventory.facts.find((entry) => entry.documentId === document.documentId)!;
      const item: IntelligenceItem = { id: crypto.randomUUID(), destination: "proposals", title, fields: {}, sourceIds: [...document.sourceIds], selectedFields: [], evidence: [] };
      result.items.push(item);
      result.changes.push({ ...proof(fact), quote: fact.quote.slice(0, LIMITS.quote), itemId: item.id, field: "record", kind: "created", requiresReview: true });
    }
  }
  for (const [index, original] of result.items.entries()) {
    if (original.destination !== "proposals") continue;
    const document = documentFor(original, result.items, inventory);
    if (!document) {
      if (inventory.documents.some((entry) => entry.sourceIds.some((id) => original.sourceIds.includes(id)))) result.skipped.push({ itemId: original.id, reason: "contract-proposal-owner", message: "Состав и условия не распределены: несколько карточек / документов либо неполный выбранный текст. Проверьте принадлежность материалов.", requiresReview: true });
      continue;
    }
    const canonical = canonicalFields(document, inventory);
    if (canonical.some((field) => typeof field.value === "string" ? field.value.length > LIMITS.field : Array.isArray(field.value) && field.value.some((text) => text.length > LIMITS.field))) return stop("contract-proposal-field-limit", "Полный состав или условия не помещаются в 20 000 символов на блок. Ничего не усечено и карточки не изменены частично; разделите проект.");
    let item = { ...original, fields: { ...original.fields }, selectedFields: [...original.selectedFields], evidence: [...(original.evidence || [])] };
    const hasPositions = Array.isArray(item.fields.lines) && item.fields.lines.some((line) => line.trim())
      && !(JSON.stringify(item.fields.lines) === JSON.stringify(canonical.find((field) => field.field === "lines")?.value)
        && JSON.stringify(item.fields.lineDescriptions) === JSON.stringify(canonical.find((field) => field.field === "lineDescriptions")?.value));
    const canonicalDescription = canonical.find((field) => field.field === "lineDescriptions");
    const actions = hasPositions && canonicalDescription ? [...canonical.filter((field) => !["lines", "lineDescriptions"].includes(field.field)), { ...canonicalDescription, field: "conclusion", value: (canonicalDescription.value as string[])[0] }] : canonical;
    for (const field of actions) {
      const previous = item.fields[field.field];
      // Deselecting an existing value is a user choice; the coverage gate will
      // still report missing obligations, but preparation must not reselect it.
      if (previous !== undefined && !item.selectedFields.includes(field.field) && !absent(previous, field.field)) continue;
      if (!absent(previous, field.field) && !(Array.isArray(previous) && !previous.length)
        && !["introduction", "conclusion", "deliveryTerms", "paymentTerms"].includes(field.field)
        && JSON.stringify(previous) !== JSON.stringify(field.value)) continue;
      let value = previous;
      if (absent(previous, field.field) || Array.isArray(previous) && !previous.length) value = field.value;
      else if (typeof previous === "string" && typeof field.value === "string" && ["introduction", "conclusion", "deliveryTerms", "paymentTerms"].includes(field.field)) {
        value = wholeSubset(previous, field.value) ? field.value : literal(previous).includes(literal(field.value)) ? previous : `${previous}\n\n${field.value}`;
      }
      if (value === undefined || typeof value === "string" && value.length > LIMITS.field || Array.isArray(value) && value.some((part) => part.length > LIMITS.field)) return stop("contract-proposal-field-limit", "Полный состав вместе с существующим текстом не помещается в блок. Дополнение отменено без усечения исходных значений.");
      // Exact source claims prove the source-derived text, not an arbitrary
      // older prefix which the closed prover deliberately will not approve.
      const additions = evidenceClaims(field.field, field.evidence), evidence = [...item.evidence!], keys = new Set(evidence.map(claimKey));
      for (const claim of additions) if (!keys.has(claimKey(claim))) { evidence.push(claim); keys.add(claimKey(claim)); }
      if (evidence.length > LIMITS.evidence) return stop("contract-proposal-evidence-limit", "Полные подтверждения превышают предел. Частичное дополнение не выполнено.");
      const changed = JSON.stringify(previous) !== JSON.stringify(value) || !item.selectedFields.includes(field.field);
      if (changed || evidence.length !== item.evidence!.length) {
        item = { ...item, fields: { ...item.fields, [field.field]: value }, selectedFields: [...new Set([...item.selectedFields, field.field])], evidence };
        if (field.field === "title" && typeof value === "string" && (/^(?:коммерческое\s+предложение|кп|новая\s+карточка)/iu.test(item.title) || !item.title.trim())) item.title = value;
        const origin = field.evidence[0];
        if (origin) result.changes.push({ ...proof(origin), quote: origin.quote.slice(0, LIMITS.quote), itemId: item.id, field: field.field, kind: previous === undefined ? "added" : "replaced", ...(previous === undefined ? {} : { previousValue: previous }), value, requiresReview: true });
      }
    }
    result.items[index] = item;
    result.skipped.push({ itemId: item.id, reason: "contract-proposal-derived-review", message: "Проект дополнен дословными разделами договора / ТЗ. Это исходные условия, не новая согласованная оферта. Проверьте применимость к этому проекту, цену и конкретные неоднозначности перед отправкой.", requiresReview: true });
  }
  if (result.changes.length + result.skipped.length > LIMITS.receipts || bytes(JSON.stringify(result)) > LIMITS.bytes) return stop("contract-proposal-result-limit", "Полный результат превышает предел. Подготовка отменена без частичного усечения.");
  return result;
}

export interface ContractProposalFieldProof {
  itemId: string;
  field: string;
  status: "confirmed";
  message: string;
  evidence: SourcePreparationProvenance[];
}
export interface ContractProposalProof { fields: Map<string, ContractProposalFieldProof>; claims: Set<IntelligenceEvidence> }

/** Recollect fresh source facts and prove the WHOLE canonical field. The proof
 * is neither a generic multi-fragment exception nor a legal approval. */
export function createContractProposalProver(sources: readonly IntelligenceSource[]) {
  const inventory = collectContractProposalFacts(sources);
  return { prove(item: IntelligenceItem, items: readonly IntelligenceItem[]): ContractProposalProof | undefined {
    if (inventory.limited || item.destination !== "proposals" || items.length > LIMITS.items || new Set(items.map((entry) => entry.id)).size !== items.length || (item.evidence || []).length > LIMITS.evidence) return;
    const document = documentFor(item, items, inventory);
    if (!document) return;
    const fields = new Map<string, ContractProposalFieldProof>(), claims = new Set<IntelligenceEvidence>();
    const canonical = canonicalFields(document, inventory), description = canonical.find((field) => field.field === "lineDescriptions");
    const alternatives = description ? [...canonical, { ...description, field: "conclusion", value: (description.value as string[])[0] }] : canonical;
    for (const expected of alternatives) {
      if (!item.selectedFields.includes(expected.field) || JSON.stringify(item.fields[expected.field]) !== JSON.stringify(expected.value)) continue;
      const required = evidenceClaims(expected.field, expected.evidence);
      const matching = required.map((claim) => item.evidence?.filter((entry) => claimKey(entry) === claimKey(claim)) || []);
      if (!required.length || matching.some((entries) => !entries.length)) continue;
      fields.set(expected.field, { itemId: item.id, field: expected.field, status: "confirmed", message: "Весь исходный текст раздела подтверждён свежими цитатами своего договора / ТЗ и их ролью. Это проверка происхождения и сохранения текста, не согласование новой оферты или юридической применимости.", evidence: expected.evidence });
      matching.flat().forEach((entry) => claims.add(entry));
    }
    return { fields, claims };
  } };
}
