import { collectContractProposalFacts, type ContractProposalInventory } from "./contractProposalFacts";
import { extractPreparedTableFacts } from "./sourcePreparedFacts";
import { extractStaffCertificateFacts } from "./sourceStaffCertificates";
import { assertResponsePreparationSources } from "./responsePreparationBounds";
import { revalidateProposalSourceFinancials } from "./proposalSourceFinancials";
import type { ProposalSourceFinancialCandidate } from "../proposals/sourcePricing";
import type { IntelligenceDestination, IntelligenceFieldValue, IntelligenceFragment, IntelligenceItem, IntelligenceSource } from "./workbenchTypes";

/** Completeness is independent of factual trust. A review-ready result is an
 * editable candidate, never a certificate of legal correctness or a saved card. */
export type TaskCompletionStatus = "review-ready" | "partial" | "insufficient" | "not-assessed";
export interface TaskCompletionEvidence { sourceId: string; sourceName: string; fragmentId?: string; locator: string; quote: string }
export interface TaskCompletionObligation {
  id: string;
  destination: IntelligenceDestination;
  label: string;
  targetFields: readonly string[];
  evidence: readonly TaskCompletionEvidence[];
  /** Exact source text/value, not a model judgement or an inferred calculation. */
  expectedValue?: IntelligenceFieldValue;
  owner?: { field: string; value: string };
  ambiguous?: boolean;
  question?: string;
}
export interface TaskCompletionCheck {
  id: string; destination: IntelligenceDestination; label: string;
  status: "covered" | "missing" | "ambiguous" | "not-assessed";
  evidence: TaskCompletionEvidence[]; itemIds: string[]; matchedItemIds: string[];
}
export interface TaskCompletionIssue {
  id: string;
  code: "missing-core" | "missing-source-content" | "ambiguous-source-content" | "unknown-value" | "assessment-unavailable";
  severity: "missing" | "question" | "not-assessed";
  destination?: IntelligenceDestination;
  itemIds: string[]; message: string; evidence: TaskCompletionEvidence[]; obligationId?: string;
}
export interface TaskCompletionCounts { assessed: number; covered: number; missing: number; ambiguous: number; notAssessed: number; questions: number }
export interface ItemTaskCompletion {
  itemId: string; destination: IntelligenceDestination; status: TaskCompletionStatus;
  canTransferPrepared: boolean; issueIds: string[]; missingCore: string[];
  canOpenIncompleteDraft: boolean; priceReviewRequired: boolean;
}
export interface DestinationTaskCompletion {
  destination: IntelligenceDestination; status: TaskCompletionStatus | "no-applicable-data";
  itemIds: string[]; issueIds: string[]; counts: TaskCompletionCounts;
}
export interface TaskCompletionReport {
  status: TaskCompletionStatus; snapshotKey: string; limited: boolean;
  items: ItemTaskCompletion[]; destinations: DestinationTaskCompletion[];
  checks: TaskCompletionCheck[]; issues: TaskCompletionIssue[]; counts: TaskCompletionCounts;
}
export interface TaskCompletionOptions {
  destinations: readonly IntelligenceDestination[];
  /** Additional independently extracted obligations for any supported tool.
   * Provenance is rechecked against this exact source snapshot on every call. */
  obligations?: readonly TaskCompletionObligation[];
  /** An optional precomputed inventory is compared with a fresh collection.
   * Quote freshness alone cannot establish that no new section was omitted. */
  contractProposalInventory?: ContractProposalInventory;
}

export const TASK_COMPLETION_LIMITS = Object.freeze({ items: 100, sources: 100, fragments: 5000, characters: 2 * 1024 * 1024, fragmentCharacters: 20_000, obligations: 1000, issues: 1500, fieldCharacters: 200_000 });
const destinations: IntelligenceDestination[] = ["procurement", "contracts", "staff", "counterparties", "proposals"];
const normalize = (value: string) => value.normalize("NFKC").toLocaleLowerCase("ru").replace(/ё/gu, "е").replace(/[‐‑–—]/gu, "-").replace(/\s+/gu, " ").trim();
const literal = (value: string) => value.replace(/\s+/gu, " ").trim();
const included = (fragment: NonNullable<IntelligenceSource["fragments"]>[number]) => !["hidden", "veryHidden"].includes(fragment.sheetState || "visible") || fragment.includedByUser === true;
const generic = /^(?:кп|коммерческое предложение|договор|контракт|закупка|тендер|сотрудник|компания|карточка|документ|услуги|работы|товары|состав работ|услуги по договору|неизвестно|не указано|сведения отсутствуют|null|undefined|n\/?a|[-_.\s…]+)$/iu;
const meaningful = (value: IntelligenceFieldValue | undefined): boolean => typeof value === "number" ? Number.isFinite(value) : typeof value === "string" ? Boolean(value.trim()) && !generic.test(value.trim()) : Array.isArray(value) && value.some((entry) => meaningful(entry));
const values = (item: IntelligenceItem, field: string): Array<string | number> => !item.selectedFields.includes(field) ? [] : Array.isArray(item.fields[field]) ? item.fields[field] as string[] : typeof item.fields[field] === "string" || typeof item.fields[field] === "number" ? [item.fields[field] as string | number] : [];
const has = (item: IntelligenceItem, fields: readonly string[]) => fields.some((field) => item.selectedFields.includes(field) && meaningful(item.fields[field]));
const reviewable = (item: IntelligenceItem): boolean => Boolean(item && typeof item.id === "string" && destinations.includes(item.destination) && Array.isArray(item.selectedFields) && item.selectedFields.every((field) => typeof field === "string") && Array.isArray(item.sourceIds) && item.sourceIds.every((id) => typeof id === "string") && item.fields && typeof item.fields === "object" && !Array.isArray(item.fields));
const hash = (value: string) => { let left = 2166136261, right = 5381; for (let index = 0; index < value.length; index++) { left = Math.imul(left ^ value.charCodeAt(index), 16777619); right = Math.imul(right, 33) ^ value.charCodeAt(index); } return `${(left >>> 0).toString(36)}-${(right >>> 0).toString(36)}`; };
const evidence = (source: IntelligenceSource, fragment: { id?: string; locator: string; text: string }): TaskCompletionEvidence => ({ sourceId: source.id, sourceName: source.name, ...(fragment.id ? { fragmentId: fragment.id } : {}), locator: fragment.locator, quote: fragment.text });
const count = (checks: readonly TaskCompletionCheck[], issues: readonly TaskCompletionIssue[]): TaskCompletionCounts => ({ assessed: checks.filter((check) => check.status === "covered" || check.status === "missing").length, covered: checks.filter((check) => check.status === "covered").length, missing: checks.filter((check) => check.status === "missing").length, ambiguous: checks.filter((check) => check.status === "ambiguous").length, notAssessed: checks.filter((check) => check.status === "not-assessed").length, questions: issues.filter((issue) => issue.severity === "question").length });
const status = (issues: readonly TaskCompletionIssue[], hasItems: boolean): TaskCompletionStatus => issues.some((issue) => issue.severity === "not-assessed") ? "not-assessed" : issues.some((issue) => issue.severity === "missing") || !hasItems ? "insufficient" : issues.some((issue) => issue.severity === "question") ? "partial" : "review-ready";
function validObligation(obligation: TaskCompletionObligation): boolean {
  const text = (value: unknown, limit: number): value is string => typeof value === "string" && value.length > 0 && value.length <= limit;
  const expected = obligation?.expectedValue;
  return Boolean(obligation && text(obligation.id, 256) && destinations.includes(obligation.destination) && text(obligation.label, 2000)
    && Array.isArray(obligation.targetFields) && obligation.targetFields.length > 0 && obligation.targetFields.length <= 30 && obligation.targetFields.every((field) => text(field, 128))
    && Array.isArray(obligation.evidence) && obligation.evidence.length > 0 && obligation.evidence.length <= 16 && obligation.evidence.every((proof) => proof && text(proof.sourceId, 128) && text(proof.sourceName, 20_000) && text(proof.locator, 20_000) && text(proof.quote, 20_000) && (proof.fragmentId === undefined || text(proof.fragmentId, 128)))
    && (expected === undefined || typeof expected === "number" && Number.isFinite(expected) || typeof expected === "boolean" || text(expected, 20_000) || Array.isArray(expected) && expected.length <= 100 && expected.every((value) => text(value, 20_000)))
    && (obligation.owner === undefined || text(obligation.owner.field, 128) && text(obligation.owner.value, 2000))
    && (obligation.question === undefined || text(obligation.question, 2000)) && (obligation.ambiguous === undefined || typeof obligation.ambiguous === "boolean"));
}

interface SourceMaterial { source: IntelligenceSource; fragments: Array<{ id?: string; locator: string; text: string; index: number }> }
function materialFor(sources: readonly IntelligenceSource[]): { material: SourceMaterial[]; limited: boolean } {
  let characters = 0, fragments = 0, limited = false;
  const material = sources.map((source) => {
    const all: IntelligenceFragment[] = source.fragments === undefined ? source.text.split(/\r?\n/u).map((text) => ({ locator: "Текст источника", text })) : source.fragments;
    const ids = new Set<string>(), duplicates = new Set<string>();
    for (const fragment of all) { if (fragment.id && ids.has(fragment.id)) duplicates.add(fragment.id); if (fragment.id) ids.add(fragment.id); }
    const selected = all.map((fragment, index) => ({ ...fragment, index })).filter(included);
    for (const fragment of selected) {
      if (++fragments > TASK_COMPLETION_LIMITS.fragments || (characters += fragment.text.length) > TASK_COMPLETION_LIMITS.characters || fragment.text.length > TASK_COMPLETION_LIMITS.fragmentCharacters || fragment.id && duplicates.has(fragment.id)) limited = true;
    }
    return { source, fragments: selected };
  });
  return { material, limited };
}
function fresh(proof: TaskCompletionEvidence, material: readonly SourceMaterial[]): boolean {
  if (!proof || typeof proof.quote !== "string" || !proof.quote.trim() || proof.quote.length > 20_000) return false;
  const source = material.find((entry) => entry.source.id === proof.sourceId);
  if (!source || source.source.name !== proof.sourceName) return false;
  return source.fragments.some((fragment) => fragment.id === proof.fragmentId && (fragment.locator === proof.locator || source.source.fragments === undefined && proof.locator === `Текст, строка ${fragment.index + 1}`) && literal(fragment.text).includes(literal(proof.quote)));
}
function containsValue(haystack: string | number, expected: IntelligenceFieldValue): boolean {
  if (typeof expected === "number") return typeof haystack === "number" && haystack === expected;
  if (typeof expected !== "string" || typeof haystack !== "string") return false;
  const needle = normalize(expected), text = normalize(haystack);
  if (!needle) return false;
  let at = text.indexOf(needle);
  while (at >= 0) {
    const before = text[at - 1] || "", after = text[at + needle.length] || "";
    if (!/[\p{L}\p{N}]/u.test(before) && !/[\p{L}\p{N}]/u.test(after)) return true;
    at = text.indexOf(needle, at + 1);
  }
  return false;
}
function covered(item: IntelligenceItem, obligation: TaskCompletionObligation): boolean {
  const candidates = obligation.targetFields.flatMap((field) => values(item, field));
  if (obligation.expectedValue !== undefined) {
    const expected = Array.isArray(obligation.expectedValue) ? obligation.expectedValue : [obligation.expectedValue];
    return expected.length > 0 && expected.every((entry) => candidates.some((candidate) => containsValue(candidate, entry)));
  }
  return obligation.evidence.length > 0 && obligation.evidence.every((proof) => candidates.some((candidate) => containsValue(candidate, proof.quote)));
}
function core(item: IntelligenceItem): string[] {
  switch (item.destination) {
    case "proposals": return has(item, ["lines"]) && has(item, ["lineDescriptions", "introduction", "deliveryTerms"]) ? [] : ["Содержательные позиции и состав товаров / услуг"];
    case "contracts": return has(item, ["subject", "workScope"]) ? [] : ["Предмет или объём работ по договору"];
    case "procurement": return has(item, ["subject", "name"]) ? [] : ["Конкретный предмет закупки"];
    case "staff": return [...(has(item, ["fullName"]) ? [] : ["ФИО сотрудника"]), ...(has(item, ["role", "qualification", "skills", "primarySpecialization", "additionalSpecializations", "competencies", "certificates", "education", "experienceNotes"]) ? [] : ["Квалификация, роль или подтверждающие документы сотрудника"])];
    case "counterparties": return has(item, ["name", "shortName"]) ? [] : ["Наименование конкретной компании"];
  }
}

const roleLabels: Record<string, string> = { subject: "Предмет предложения", scope: "Состав работ", deliverable: "Передаваемые результаты", payment: "Условия и этапы оплаты", schedule: "Сроки и условия начала", dependency: "Входные материалы и зависимости", exclusion: "Границы и исключения работ", "aggregate-price": "Общая исходная цена и НДС" };
const publicFields = ["introduction", "lines", "lineDescriptions", "conclusion", "deliveryTerms", "paymentTerms"];
function proposalObligations(inventory: ContractProposalInventory): TaskCompletionObligation[] {
  return inventory.facts.map((fact) => ({ id: `proposal:${fact.id}`, destination: "proposals", label: roleLabels[fact.role] || "Условие исходного документа", targetFields: fact.role === "payment" ? ["paymentTerms"] : fact.role === "schedule" || fact.role === "dependency" || fact.role === "exclusion" ? ["deliveryTerms", "lineDescriptions", "introduction"] : publicFields,
    evidence: [{ sourceId: fact.sourceId, sourceName: fact.sourceName, ...(fact.fragmentId ? { fragmentId: fact.fragmentId } : {}), locator: fact.locator, quote: fact.quote }, ...fact.supportingEvidence],
    expectedValue: fact.quote,
    ambiguous: !inventory.documents.some((document) => document.documentId === fact.documentId && document.eligible),
  }));
}

/** Conservative, explicit source roles only. General contract signatories are
 * not employees; a customer heading is not proof of a procurement or our group. */
function labeledObligations(material: readonly SourceMaterial[], requested: readonly IntelligenceDestination[]): TaskCompletionObligation[] {
  const result: TaskCompletionObligation[] = [];
  const add = (source: IntelligenceSource, fragment: { id?: string; locator: string; text: string }, destination: IntelligenceDestination, field: string, value: string, owner?: TaskCompletionObligation["owner"]) => {
    if (!value.trim() || generic.test(value.trim())) return;
    result.push({ id: `label:${hash(JSON.stringify([source.id, fragment.id, fragment.locator, destination, field, value, owner]))}`, destination, label: `${destination === "counterparties" ? "Реквизиты компании" : destination === "staff" ? "Сведения сотрудника" : destination === "contracts" ? "Предмет договора" : "Предмет закупки"}: ${value}`, targetFields: [field], expectedValue: value, evidence: [evidence(source, fragment)], ...(owner ? { owner } : {}) });
  };
  for (const { source, fragments } of material) {
    let company: string | undefined, staff: string | undefined, previous = -1;
    for (const fragment of fragments) {
      if (fragment.index !== previous + 1) { company = undefined; staff = undefined; }
      previous = fragment.index;
      for (const line of fragment.text.split(/\r?\n/u)) {
      const text = line.trim();
      const companyName = /^(?:полное\s+(?:юридическое\s+)?наименование(?:\s+(?:компании|организации))?|наименование\s+(?:компании|организации)|(?:исполнитель|поставщик|заказчик|покупатель))\s*[:：]\s*((?:ООО|АО|ПАО|ОАО|ЗАО|ИП|общество\s+с\s+ограниченной\s+ответственностью)\s+.+)$/iu.exec(text);
      const person = /^сотрудник\s*[:：]\s*([\p{L}’'-]+\s+[\p{L}’'-]+(?:\s+[\p{L}’'-]+)?)\s*$/iu.exec(text);
      if (companyName) { company = companyName[1].trim(); staff = undefined; if (requested.includes("counterparties")) add(source, fragment, "counterparties", "name", company, { field: "name", value: company }); }
      else if (person) { staff = person[1].trim(); company = undefined; if (requested.includes("staff")) add(source, fragment, "staff", "fullName", staff, { field: "fullName", value: staff }); }
      // Any intervening document/party/person heading closes the previous role.
      else if (/^(?:договор|контракт|новая\s+закупка|резюме|фио|контактное\s+лицо|исполнитель|поставщик|заказчик|покупатель)(?=$|[\s:№])/iu.test(text)) { company = undefined; staff = undefined; }
      if (requested.includes("procurement")) { const subject = /^(?:предмет|наименование)\s+закупки\s*[:：]\s*(.+)$/iu.exec(text); if (subject) add(source, fragment, "procurement", "subject", subject[1]); }
      if (requested.includes("contracts")) { const subject = /^предмет\s+(?:договора|контракта)\s*[:：]\s*(.+)$/iu.exec(text); if (subject) add(source, fragment, "contracts", "subject", subject[1]); }
      if (company && requested.includes("counterparties")) {
        const row = /^(ИНН|КПП|ОГРН|ОГРНИП|(?:юридический\s+)?адрес|контактные\s+данные)\s*[:：]\s*(.+)$/iu.exec(text);
        if (row) { const field = /инн/iu.test(row[1]) ? "inn" : /кпп/iu.test(row[1]) ? "kpp" : /огрн/iu.test(row[1]) ? "ogrn" : /адрес/iu.test(row[1]) ? "address" : "contact"; add(source, fragment, "counterparties", field, row[2], { field: "name", value: company }); }
      }
      if (staff && requested.includes("staff")) { const row = /^(должность|квалификация|образование|сертификат)\s*[:：]\s*(.+)$/iu.exec(text); if (row) add(source, fragment, "staff", /должность/iu.test(row[1]) ? "role" : /квалификация/iu.test(row[1]) ? "qualification" : /образование/iu.test(row[1]) ? "education" : "certificates", row[2], { field: "fullName", value: staff }); }
      }
    }
  }
  return result;
}

/** Pure task-level gate. It never fills fields, acknowledges facts, persists
 * data, calls a model or treats a semantic question as an invented value. */
export function evaluateTaskCompletion(items: readonly IntelligenceItem[], sources: readonly IntelligenceSource[], options: TaskCompletionOptions): TaskCompletionReport {
  const report: TaskCompletionReport = { status: "not-assessed", snapshotKey: "invalid", limited: false, items: [], destinations: [], checks: [], issues: [], counts: count([], []) };
  const requested = Array.isArray(options?.destinations) ? [...new Set(options.destinations.filter((destination) => destinations.includes(destination)))] : [];
  const addIssue = (issue: Omit<TaskCompletionIssue, "id">) => { if (report.issues.length < TASK_COMPLETION_LIMITS.issues) report.issues.push({ ...issue, id: `task:${hash(JSON.stringify([report.snapshotKey, issue]))}` }); else report.limited = true; };
  let material: SourceMaterial[] = [], obligations: TaskCompletionObligation[] = [];
  try {
    if (!requested.length || requested.length !== options.destinations.length || !Array.isArray(items) || items.length > TASK_COMPLETION_LIMITS.items || new Set(items.map((item) => item.id)).size !== items.length) throw new Error("Неверный снимок направлений или карточек задачи.");
    assertResponsePreparationSources(sources);
    let itemCharacters = 0;
    if (options.obligations !== undefined && (!Array.isArray(options.obligations) || options.obligations.length > TASK_COMPLETION_LIMITS.obligations || !options.obligations.every(validObligation))) throw new Error("Неверный или слишком большой перечень независимых обязательств.");
    for (const item of items) {
      if (!reviewable(item) || !requested.includes(item.destination) || item.sourceIds.length > 100 || item.selectedFields.length > 100 || Object.keys(item.fields).length > 100) throw new Error("Карточка не относится к снимку выбранных направлений.");
      if (item.id.length > 128 || typeof item.title !== "string" || item.title.length > 20_000 || item.sourceIds.some((id: string) => id.length > 128) || item.selectedFields.some((field: string) => field.length > 128)) throw new Error("Метаданные карточки превышают бюджет оценки полноты.");
      for (const value of Object.values(item.fields)) {
        if (!(typeof value === "number" && Number.isFinite(value) || typeof value === "boolean" || typeof value === "string" && value.length <= TASK_COMPLETION_LIMITS.fieldCharacters || Array.isArray(value) && value.length <= 100 && value.every((entry) => typeof entry === "string" && entry.length <= TASK_COMPLETION_LIMITS.fieldCharacters))) throw new Error("Поля карточки превышают бюджет оценки полноты.");
        itemCharacters += typeof value === "string" ? value.length : Array.isArray(value) ? value.reduce((total, entry) => total + entry.length, 0) : 1;
        if (itemCharacters > 8 * 1024 * 1024) throw new Error("Общий результат превышает бюджет оценки полноты. Разделите задачу; ничего не усечено.");
      }
    }
    const collected = materialFor(sources); material = collected.material;
    report.snapshotKey = hash(JSON.stringify({ items, sources, destinations: requested, obligations: options.obligations }));
    if (collected.limited) throw new Error("Достигнут бюджет оценки полноты или повторены идентификаторы фрагментов. Разделите материалы; полнота не установлена.");
    const inventory = requested.some((destination) => ["proposals", "contracts", "counterparties"].includes(destination)) ? collectContractProposalFacts(sources) : undefined;
    if (inventory) {
      if (options.contractProposalInventory && JSON.stringify(options.contractProposalInventory) !== JSON.stringify(inventory)) throw new Error("Снимок договорных разделов устарел. Повторите оценку по актуальным материалам.");
      if (inventory.limited) throw new Error("Разбор договорных разделов достиг бюджета. Полнота КП не установлена.");
      if (requested.includes("proposals")) {
        obligations.push(...proposalObligations(inventory));
        for (const ambiguity of inventory.ambiguities) addIssue({ code: "ambiguous-source-content", severity: "question", destination: "proposals", itemIds: items.filter((item) => item.destination === "proposals" && ambiguity.evidence.some((proof) => item.sourceIds.includes(proof.sourceId))).map((item) => item.id), message: ambiguity.message, evidence: ambiguity.evidence.filter((proof) => fresh(proof, material)) });
        for (const document of inventory.documents) if (!document.complete) addIssue({ code: "assessment-unavailable", severity: "not-assessed", destination: "proposals", itemIds: items.filter((item) => item.destination === "proposals" && item.sourceIds.some((id: string) => document.sourceIds.includes(id))).map((item) => item.id), message: "Исходный договор / ТЗ извлечён не полностью; проверить полноту КП по всем разделам пока невозможно.", evidence: [] });
        for (const item of items) if (item.destination === "proposals" && inventory.documents.filter((document) => document.sourceIds.some((id) => item.sourceIds.includes(id))).length > 1) addIssue({ code: "ambiguous-source-content", severity: "question", destination: "proposals", itemIds: [item.id], message: "В одну карточку включены несколько самостоятельных договоров / ТЗ. Их принадлежность одному проекту и применимость общих условий не установлены; не объединяйте цены и обязательства автоматически.", evidence: [] });
      }
      if (requested.includes("counterparties")) for (const document of inventory.documents) for (const [role, party] of Object.entries(document.parties || {})) {
        if (party) obligations.push({ id: `contract-party:${document.documentId}:${role}`, destination: "counterparties", label: `Отдельный контрагент из договора: ${party.value}`, targetFields: ["name", "shortName"], owner: { field: "name", value: party.value }, expectedValue: party.value, evidence: party.evidence });
      }
      if (requested.includes("contracts")) for (const document of inventory.documents) {
        const facts = inventory.facts.filter((fact) => fact.documentId === document.documentId);
        const heading = document.kind === "contract" ? document.heading : document.kind === "technical-task" ? undefined : facts.flatMap((fact) => fact.supportingEvidence).find((proof) => /^(?:договор|контракт)(?=$|[\s№])/iu.test(proof.quote.trim()));
        if (!heading) continue; // A standalone technical task is not a contract.
        const owners = items.filter((item) => item.destination === "contracts" && item.sourceIds.some((id: string) => document.sourceIds.includes(id)));
        const associated = owners.filter((item) => core(item).length === 0);
        const current = document.complete && fresh(heading, material);
        const check: TaskCompletionCheck = { id: `contract-document:${document.documentId}`, destination: "contracts", label: "Отдельная карточка опыта по явному договору", status: !current ? "not-assessed" : !owners.length || !associated.length ? "missing" : "ambiguous", evidence: [heading, ...facts.filter((fact) => fact.role === "subject").slice(0, 2)], itemIds: owners.map((item) => item.id), matchedItemIds: [] };
        report.checks.push(check);
        addIssue({ code: !current ? "assessment-unavailable" : check.status === "missing" ? "missing-source-content" : "ambiguous-source-content", severity: !current ? "not-assessed" : check.status === "missing" ? "missing" : "question", destination: "contracts", itemIds: check.itemIds, obligationId: check.id, message: !current ? "Явный договор извлечён не полностью. Сверить полноту карточки опыта по этому источнику пока невозможно." : check.status === "missing" ? "В источнике есть самостоятельный договор с предметом / составом работ, но его содержательная карточка опыта не подготовлена. Карточка КП не заменяет договор в другом выбранном направлении." : "Для явного договора подготовлена карточка опыта, но полное соответствие её предмета, объёма и сторон этому документу не установлено независимо. Сверьте конкретный договор по приведённым разделам; карточки не распределяются по порядку.", evidence: check.evidence });
      }
    }
    if (requested.includes("contracts") || requested.includes("procurement")) {
      const tables = extractPreparedTableFacts(sources);
      if (tables.limited) throw new Error("Разбор явных таблиц достиг бюджета. Полнота результата не установлена.");
      if (requested.includes("contracts")) for (const fact of tables.contracts) for (const [field, expectedValue] of Object.entries(fact.fields)) obligations.push({ id: `contract:${hash(JSON.stringify([fact.sourceId, fact.number, fact.date, field]))}`, destination: "contracts", label: `Договор № ${fact.number} от ${fact.date}: ${field}`, targetFields: [field], expectedValue, owner: { field: "number", value: fact.number }, evidence: [fact.row, fact.header] });
      if (requested.includes("procurement")) for (const fact of tables.nmcs) obligations.push({ id: `nmc:${hash(JSON.stringify(fact.row))}`, destination: "procurement", label: "Явная общая начальная цена закупки", targetFields: ["nmc"], expectedValue: fact.value, evidence: [fact.row, ...fact.headers] });
    }
    if (requested.includes("staff")) {
      const certificates = extractStaffCertificateFacts(sources);
      if (certificates.limited) throw new Error("Разбор сертификатов достиг бюджета. Полнота кадровых сведений не установлена.");
      for (const doc of certificates.documents) obligations.push({ id: `certificate:${doc.id}`, destination: "staff", label: `Сертификат ${doc.ownerFullName}: ${doc.name}`, targetFields: ["certificates"], expectedValue: doc.name, owner: { field: "fullName", value: doc.ownerFullName }, evidence: [{ sourceId: doc.sourceId, sourceName: sources.find((source) => source.id === doc.sourceId)!.name, fragmentId: doc.fragmentId, locator: material.find((entry) => entry.source.id === doc.sourceId)!.fragments.find((fragment) => fragment.id === doc.fragmentId)!.locator, quote: doc.quote }] });
    }
    obligations.push(...labeledObligations(material, requested), ...(options.obligations || []));
    if (obligations.length > TASK_COMPLETION_LIMITS.obligations || new Set(obligations.map((obligation) => obligation.id)).size !== obligations.length) throw new Error("Перечень проверяемых обязательств превышает бюджет или содержит повторённые идентификаторы.");
    const financials = new Map<string, ProposalSourceFinancialCandidate[]>();
    for (const item of items) if (item.destination === "proposals") {
      const candidates = (item as IntelligenceItem & { proposalSourceFinancials?: ProposalSourceFinancialCandidate[] }).proposalSourceFinancials;
      if (candidates?.length) financials.set(item.id, revalidateProposalSourceFinancials(candidates, sources, item.sourceIds));
    }
    for (const obligation of obligations) {
      if (!requested.includes(obligation.destination) || !validObligation(obligation)) throw new Error("Неверный контракт оценки полноты.");
      const candidates = items.filter((item) => item.destination === obligation.destination && obligation.evidence.some((proof) => item.sourceIds.includes(proof.sourceId)) && (!obligation.owner || values(item, obligation.owner.field).some((value) => typeof value === "string" && normalize(value) === normalize(obligation.owner!.value))));
      const fallback = candidates.length ? candidates : items.filter((item) => item.destination === obligation.destination && obligation.evidence.some((proof) => item.sourceIds.includes(proof.sourceId)));
      const current = obligation.evidence.every((proof) => fresh(proof, material));
      const associationAmbiguous = candidates.length > 1;
      const financialMatch = (item: IntelligenceItem) => obligation.id.startsWith("proposal:") && obligation.label === roleLabels["aggregate-price"] && (financials.get(item.id) || []).some((candidate) => obligation.evidence.some((proof) => candidate.sourceId === proof.sourceId && candidate.fragmentId === proof.fragmentId && literal(candidate.quote) === literal(proof.quote)));
      const matches = current && !obligation.ambiguous && !associationAmbiguous ? candidates.filter((item) => covered(item, obligation) || financialMatch(item)) : [];
      const check: TaskCompletionCheck = { id: obligation.id, destination: obligation.destination, label: obligation.label, status: !current ? "not-assessed" : obligation.ambiguous || associationAmbiguous ? "ambiguous" : matches.length ? "covered" : "missing", evidence: [...obligation.evidence], itemIds: fallback.map((item) => item.id), matchedItemIds: matches.map((item) => item.id) };
      report.checks.push(check);
      if (check.status !== "covered") addIssue({ code: !current ? "assessment-unavailable" : obligation.ambiguous || associationAmbiguous ? "ambiguous-source-content" : "missing-source-content", severity: !current ? "not-assessed" : obligation.ambiguous || associationAmbiguous ? "question" : "missing", destination: obligation.destination, itemIds: check.itemIds, obligationId: obligation.id, message: !current ? `Снимок источника изменился или подтверждение недоступно: ${obligation.label}. Повторите оценку по актуальным материалам.` : associationAmbiguous ? `Одному исходному условию соответствуют несколько карточек: ${obligation.label}. Уточните принадлежность; содержание одной карточки не подтверждает полноту другой.` : obligation.ambiguous ? obligation.question || `Нельзя однозначно связать с карточкой: ${obligation.label}. Уточните принадлежность по источнику.` : `В переносимом результате не сохранено: ${obligation.label}. Добавьте доступное содержание из источника; исключение поля не устраняет этот пропуск.`, evidence: check.evidence });
    }
    for (const item of items) {
      for (const missing of core(item)) addIssue({ code: "missing-core", severity: "missing", destination: item.destination, itemIds: [item.id], message: `Смысловое ядро результата не подготовлено: ${missing}. Название и сведения о сторонах не заменяют содержание.`, evidence: [] });
      const cited = sources.filter((source) => item.sourceIds.includes(source.id));
      if (!cited.length || item.sourceIds.some((id: string) => !sources.some((source) => source.id === id))) addIssue({ code: "assessment-unavailable", severity: "not-assessed", destination: item.destination, itemIds: [item.id], message: "Для карточки не установлен актуальный исходный материал. Нельзя подтвердить полноту задачи без связи с источником.", evidence: [] });
      if (cited.some((source) => source.coverage && (!source.coverage.complete || source.coverage.requiresOcr))) addIssue({ code: "assessment-unavailable", severity: "not-assessed", destination: item.destination, itemIds: [item.id], message: "Текст извлечён не полностью или требуется OCR. Пропущенные области не оценены; результат нельзя считать полностью подготовленным.", evidence: [] });
      const itemChecks = report.checks.filter((check) => check.itemIds.includes(item.id));
      if (!itemChecks.length) addIssue({ code: "unknown-value", severity: "question", destination: item.destination, itemIds: [item.id], message: "Независимый перечень доступных сведений для этой карточки не установлен. Проверьте полноту по исходнику; наличие заполненных полей само по себе её не подтверждает.", evidence: [] });
      const priceChecks = itemChecks.filter((check) => check.label === roleLabels["aggregate-price"]);
      if (item.destination === "proposals" && (financials.has(item.id) || priceChecks.length)) addIssue({ code: "unknown-value", severity: "question", destination: "proposals", itemIds: [item.id], message: financials.has(item.id)
        ? "Общая исходная цена извлечена, но не применена к новому КП. В редакторе КП подтвердите использование цены этого договора именно для выбранного объёма; проверьте валюту, НДС и назначение цены. До этого итог нового КП не считается согласованным."
        : "Общая исходная цена указана в договоре / ТЗ, но её применимость к новому КП не установлена. Сохранение денежной цитаты не заменяет согласование цены. В редакторе проверьте исходные суммы, валюту и НДС и задайте цену для выбранного объёма.",
        evidence: financials.has(item.id) ? (financials.get(item.id) || []).map((candidate) => ({ sourceId: candidate.sourceId, sourceName: candidate.sourceName, ...(candidate.fragmentId ? { fragmentId: candidate.fragmentId } : {}), locator: candidate.locator, quote: candidate.quote })) : priceChecks.flatMap((check) => check.evidence) });
    }
  } catch (reason) {
    report.limited = true;
    addIssue({ code: "assessment-unavailable", severity: "not-assessed", itemIds: Array.isArray(items) ? items.slice(0, TASK_COMPLETION_LIMITS.items).filter(Boolean).map((item) => item.id) : [], message: reason instanceof Error ? reason.message : "Оценка полноты не выполнена. Повторите анализ по актуальному снимку материалов.", evidence: [] });
  }
  if (report.limited && !report.issues.some((issue) => issue.severity === "not-assessed")) {
    if (report.issues.length >= TASK_COMPLETION_LIMITS.issues) report.issues.pop();
    addIssue({ code: "assessment-unavailable", severity: "not-assessed", itemIds: [], message: "Достигнут бюджет замечаний. Полнота всей задачи не установлена; разделите материалы и повторите анализ.", evidence: [] });
  }
  for (const item of Array.isArray(items) ? items.slice(0, TASK_COMPLETION_LIMITS.items).filter((item) => reviewable(item) && requested.includes(item.destination)) : []) {
    const issues = report.issues.filter((issue) => issue.itemIds.includes(item.id) || !issue.destination && issue.severity === "not-assessed");
    const readiness = status(issues, true);
    const missingCore = core(item);
    const priceReviewRequired = issues.some((issue) => issue.code === "unknown-value" && issue.message.startsWith("Общая исходная цена"));
    report.items.push({ itemId: item.id, destination: item.destination, status: readiness, canTransferPrepared: readiness === "review-ready", canOpenIncompleteDraft: readiness !== "not-assessed" && missingCore.length === 0, priceReviewRequired, issueIds: issues.map((issue) => issue.id), missingCore });
  }
  for (const destination of requested) {
    const destinationItems = report.items.filter((item) => item.destination === destination), checks = report.checks.filter((check) => check.destination === destination), issues = report.issues.filter((issue) => issue.destination === destination || !issue.destination);
    const readiness = !destinationItems.length && !checks.length && !issues.length ? "no-applicable-data" : status(issues, destinationItems.length > 0);
    report.destinations.push({ destination, status: readiness, itemIds: destinationItems.map((item) => item.itemId), issueIds: issues.map((issue) => issue.id), counts: count(checks, issues) });
  }
  report.counts = count(report.checks, report.issues);
  report.status = status(report.issues, report.items.length > 0);
  return report;
}

/** No reviewed/ACK argument: agreeing to missing content never makes it covered. */
export function getItemTaskCompletion(report: TaskCompletionReport, itemId: string): ItemTaskCompletion | undefined { return report.items.find((item) => item.itemId === itemId); }
export function canTransferPreparedItem(report: TaskCompletionReport, itemId: string): boolean { return getItemTaskCompletion(report, itemId)?.canTransferPrepared === true; }
