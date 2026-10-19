import { completeIntelligenceConditions } from "./automaticConditions";
import { prepareIntelligenceSourceFacts, type SourcePreparationChange, type SourcePreparationSkipped } from "./sourcePreparedFacts";
import { collapseExpandedRequirementHeadings, deduplicateRequirements, type RequirementDeduplication } from "./requirementDeduplication";
import { completeSourceDates } from "./sourceDateCompletion";
import { completeSourceTextFields } from "./sourceTextCompletion";
import { completeSourcePositions } from "./sourcePositionCompletion";
import { completeSourceStaffCertificates } from "./sourceStaffCertificates";
import { completeContractProposalFields } from "./contractProposalCompletion";
import { extractProposalSourceFinancials } from "./proposalSourceFinancials";
import { extractProposalSourceParties } from "./proposalSourceParties";
import { createProposalSourceFinancials, type ProposalSourceFinancialCandidate } from "../proposals/sourcePricing";
import { quarantineConflictingFields } from "./quarantineConflictingFields";
import { buildIntelligenceResponseSchema, destinationLabels, fieldDefinitions, parseIntelligenceResult } from "./workbenchModel";
import { summarizeParsedModelContribution, validModelResponseContribution, type ModelResponseContribution } from "./modelContribution";
import { assertResponsePreparationRaw, assertResponsePreparationSources, RESPONSE_PREPARATION_LIMITS } from "./responsePreparationBounds";
import { assertPreparedSourceContract, assertSourceContractSources } from "./sourceContractPreparation";
import { assertProposalQuotePreparationRequest, prepareProposalQuoteSelection, validProposalQuoteProvenance, type ProposalQuoteProvenance } from "./proposalQuotePreparation";
export { RESPONSE_PREPARATION_LIMITS } from "./responsePreparationBounds";
import type { IntelligenceDestination, IntelligenceItem, IntelligenceSource } from "./workbenchTypes";

export interface SourcePreparationReceipt {
  origin?: "source-contract";
  changes: Array<SourcePreparationChange | RequirementDeduplication>;
  skipped: SourcePreparationSkipped[]; limited: boolean;
}
export type ResponsePreparationResult = ReturnType<typeof completeIntelligenceConditions> & { sourcePreparation?: SourcePreparationReceipt };
export interface ResponsePreparationRequest {
  revision: number; raw: string; sources: IntelligenceSource[]; destinations: IntelligenceDestination[];
}
export interface ResponsePreparationReply {
  origin?: "source-contract" | "model-selected-quotes";
  revision: number; prepared?: ResponsePreparationResult; empty?: true; failed?: string;
  /** Original parsed response before local supplementation; never a fact gate.
   * Kept outside prepared cards and absent for source-only/empty/failed replies. */
  modelContribution?: ModelResponseContribution;
  /** Actual raw quote-selection parts before the local source completion tail.
   * Never equivalent to an ordinary 19-field model response or approval. */
  modelQuoteProvenance?: ProposalQuoteProvenance;
}
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
const text = (value: unknown, maximum: number, nonempty = false): value is string => typeof value === "string" && value.length <= maximum && (!nonempty || Boolean(value.trim()));
const id = (value: unknown): value is string => text(value, 256, true) && Array.from(value).length <= 128 && !/[\u0000-\u001f]/u.test(value);
const array = (value: unknown, maximum: number, test: (entry: unknown) => boolean): value is unknown[] => Array.isArray(value) && value.length <= maximum && value.every(test);
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const keys = (value: Record<string, unknown>, allowed: readonly string[]) => Object.keys(value).every((key) => allowed.includes(key));
const optional = (value: Record<string, unknown>, key: string, test: (entry: unknown) => boolean) => !own(value, key) || value[key] === undefined || test(value[key]);
const distinct = (values: unknown[]) => new Set(values).size === values.length;
const errorLimit = 1000;

function validItem(value: unknown): value is IntelligenceItem {
  if (!object(value) || !keys(value, ["id", "destination", "title", "fields", "selectedFields", "sourceIds", "evidence", "staffDocuments", "proposalSourceFinancials", "proposalSourceParties"])
    || !id(value.id) || typeof value.destination !== "string" || !own(destinationLabels, value.destination) || !text(value.title, 40_000)
    || !object(value.fields)) return false;
  const definitions = fieldDefinitions[value.destination as IntelligenceDestination], fields = value.fields;
  if (!Object.entries(fields).every(([key, entry]) => definitions.some((definition) => definition.key === key)
    && (text(entry, 200_000) || typeof entry === "boolean" || typeof entry === "number" && Number.isFinite(entry)
      || array(entry, 100, (part) => text(part, 40_000))))) return false;
  return array(value.selectedFields, definitions.length, (key) => typeof key === "string" && own(fields, key)) && distinct(value.selectedFields)
    && array(value.sourceIds, 100, id) && distinct(value.sourceIds)
    && optional(value, "evidence", (entry) => array(entry, 500, (claim) => object(claim)
      && typeof claim.field === "string" && definitions.some((definition) => definition.key === claim.field)
      && id(claim.sourceId) && (value.sourceIds as unknown[]).includes(claim.sourceId) && optional(claim, "fragmentId", id) && text(claim.quote, 4000, true)))
    && optional(value, "proposalSourceFinancials", (entry) => {
      if (value.destination !== "proposals" || !Array.isArray(entry) || entry.length > 100) return false;
      const candidateKeys = ["id", "sourceId", "sourceName", "sourceSha256", "fragmentId", "locator", "quote", "sourceKind", "scope", "positionName", "currency", "net", "vatAmount", "gross", "quantity", "unit", "unitPrice", "priceBasis", "tax", "issues"];
      if (!entry.every((candidate) => object(candidate) && keys(candidate, candidateKeys) && (value.sourceIds as unknown[]).includes(candidate.sourceId)
        && object(candidate.tax) && keys(candidate.tax, candidate.tax.kind === "vat" ? ["kind", "rate"] : ["kind"])
        && ["net", "vatAmount", "gross", "quantity", "unitPrice"].every((key) => optional(candidate, key, (part) => text(part, 40, true))))) return false;
      try { return JSON.stringify(createProposalSourceFinancials(entry as ProposalSourceFinancialCandidate[]).candidates) === JSON.stringify(entry); }
      catch { return false; }
    })
    && optional(value, "proposalSourceParties", (entry) => value.destination === "proposals" && array(entry, 200, (candidate) => object(candidate)
      && keys(candidate, ["id", "documentId", "sourceId", "sourceName", "sourceSha256", "role", "snapshot", "evidence", "issues"])
      && text(candidate.id, 200, true) && text(candidate.documentId, 200, true) && id(candidate.sourceId) && (value.sourceIds as unknown[]).includes(candidate.sourceId)
      && text(candidate.sourceName, 2000) && optional(candidate, "sourceSha256", (part) => typeof part === "string" && /^[a-f\d]{64}$/iu.test(part))
      && ["issuer", "recipient"].includes(String(candidate.role)) && object(candidate.snapshot)
      && keys(candidate.snapshot, ["name", "shortName", "inn", "kpp", "ogrn", "address", "contact", "paymentDetails"])
      && ["name", "shortName", "inn", "kpp", "ogrn", "address", "contact", "paymentDetails"].every((key) => text((candidate.snapshot as Record<string, unknown>)[key], 20_000))
      && array(candidate.evidence, 100, (part) => object(part) && keys(part, ["sourceId", "sourceName", "fragmentId", "locator", "quote"])
        && part.sourceId === candidate.sourceId && text(part.sourceName, 2000) && optional(part, "fragmentId", id) && text(part.locator, 20_000) && text(part.quote, 20_000, true))
      && array(candidate.issues, 100, (part) => text(part, 2000))))
    && optional(value, "staffDocuments", (entry) => {
      if (value.destination !== "staff" || !Array.isArray(entry) || entry.length > 100) return false;
      const documentKeys = ["id", "ownerFullName", "category", "name", "seriesNumber", "examDate", "reportedValidity", "sourceId", "fragmentId", "headerFragmentId", "quote", "headerQuote"];
      const owner = (part: string) => part.normalize("NFKC").toLocaleLowerCase("ru").replace(/\s+/gu, " ").trim();
      const safeText = (part: unknown, maximum: number, nonempty = false): part is string => text(part, maximum, nonempty) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(part);
      const date = (part: unknown) => part === "" || typeof part === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(part) && Number(part.slice(0, 4)) >= 1900 && Number(part.slice(0, 4)) <= 2200 && Number.isFinite(Date.parse(`${part}T00:00:00Z`)) && new Date(`${part}T00:00:00Z`).toISOString().slice(0, 10) === part;
      return entry.every((doc) => object(doc) && keys(doc, documentKeys) && documentKeys.every((key) => own(doc, key))
        && id(doc.id) && doc.category === "certificate" && safeText(doc.ownerFullName, 200, true) && typeof fields.fullName === "string" && owner(doc.ownerFullName) === owner(fields.fullName)
        && safeText(doc.name, 2000, true) && Array.isArray(fields.certificates) && fields.certificates.includes(doc.name)
        && safeText(doc.seriesNumber, 2000) && date(doc.examDate) && typeof doc.reportedValidity === "string" && ["Да", "Нет"].includes(doc.reportedValidity)
        && id(doc.sourceId) && (value.sourceIds as unknown[]).includes(doc.sourceId) && id(doc.fragmentId) && id(doc.headerFragmentId) && doc.fragmentId !== doc.headerFragmentId
        && safeText(doc.quote, 2000, true) && safeText(doc.headerQuote, 2000, true))
        && distinct(entry.map((doc) => doc.id)) && distinct(entry.map((doc) => JSON.stringify([doc.sourceId, doc.fragmentId])));
    });
}

function provenance(value: Record<string, unknown>, required: boolean): boolean {
  const check = (key: string, test: (entry: unknown) => boolean) => required ? test(value[key]) : optional(value, key, test);
  return check("sourceId", id) && check("sourceName", (entry) => text(entry, 20_000)) && check("locator", (entry) => text(entry, 20_000))
    && check("quote", (entry) => text(entry, 40_000, true)) && optional(value, "fragmentId", id)
    && check("category", (entry) => typeof entry === "string" && ["certificate", "document", "exception", "license", "quantity", "payment", "delivery", "requirement"].includes(entry));
}
const fieldValue = (entry: unknown) => text(entry, 200_000) || typeof entry === "boolean" || typeof entry === "number" && Number.isFinite(entry) || array(entry, 100, (part) => text(part, 40_000));
function sourceReceipt(value: unknown, items: IntelligenceItem[]): boolean {
  if (!object(value) || !keys(value, ["changes", "skipped", "limited", "origin"]) || typeof value.limited !== "boolean" || !optional(value, "origin", entry => entry === "source-contract")) return false;
  return array(value.changes, 500, (change) => {
    if (!object(change) || !keys(change, ["itemId", "field", "kind", "sourceId", "sourceName", "fragmentId", "locator", "quote", "previousValue", "value", "requiresReview"]) || change.requiresReview !== true) return false;
    const item = items.find((entry) => entry.id === change.itemId);
    if (!item || typeof change.field !== "string" || change.field !== "record" && !fieldDefinitions[item.destination].some((field) => field.key === change.field)) return false;
    if (change.kind === "deduplicated") return change.field === "requirements" && item.destination === "procurement"
      && array(change.previousValue, 100, (entry) => text(entry, 4000, true)) && array(change.value, 100, (entry) => text(entry, 4000, true))
      && !own(change, "sourceId") && !own(change, "quote");
    return ["added", "replaced", "created", "quarantined"].includes(String(change.kind))
      && id(change.sourceId) && item.sourceIds.includes(change.sourceId) && text(change.sourceName, 20_000)
      && optional(change, "fragmentId", id) && text(change.locator, 20_000) && text(change.quote, 4000, true)
      && optional(change, "previousValue", fieldValue) && optional(change, "value", fieldValue);
  }) && array(value.skipped, 500, (skip) => object(skip)
    && keys(skip, ["itemId", "field", "reason", "message", "requiresReview", "sourceId", "sourceName", "fragmentId", "locator", "quote"])
    && skip.requiresReview === true && text(skip.reason, 200, true) && text(skip.message, 20_000, true)
    && optional(skip, "itemId", (entry) => id(entry) && items.some((item) => item.id === entry))
    && optional(skip, "field", (entry) => text(entry, 256)) && optional(skip, "sourceId", id)
    && optional(skip, "sourceName", (entry) => text(entry, 20_000)) && optional(skip, "fragmentId", id)
    && optional(skip, "locator", (entry) => text(entry, 20_000)) && optional(skip, "quote", (entry) => text(entry, 40_000)));
}
function validPrepared(value: unknown): value is ResponsePreparationResult {
  if (!object(value) || !keys(value, ["items", "changes", "skipped", "limited", "sourcePreparation"]) || typeof value.limited !== "boolean"
    || !array(value.items, RESPONSE_PREPARATION_LIMITS.items, validItem) || !value.items.length) return false;
  const items = value.items as IntelligenceItem[];
  return distinct(items.map((entry) => entry.id))
    && array(value.changes, RESPONSE_PREPARATION_LIMITS.receipts, (change) => object(change) && change.field === "requirements"
      && (change.kind === "added" || change.kind === "present") && change.requiresReview === true && id(change.itemId)
      && items.some((item) => item.id === change.itemId) && provenance(change, true))
    && array(value.skipped, RESPONSE_PREPARATION_LIMITS.receipts, (skip) => object(skip) && skip.field === "requirements" && skip.requiresReview === true
      && text(skip.reason, 200, true) && text(skip.message, 20_000, true) && optional(skip, "itemId", id)
      && optional(skip, "itemIds", (entry) => array(entry, 100, id)) && provenance(skip, false))
    && optional(value, "sourcePreparation", (entry) => sourceReceipt(entry, items))
    && bytes(JSON.stringify(value)) <= RESPONSE_PREPARATION_LIMITS.snapshotBytes;
}

/** Structural protocol guard, not a substitute for the existing evidence audit.
 * Passing the expected revision also rejects a well-formed stale response. */
export function validResponsePreparationReply(value: unknown, expectedRevision?: number, expectedOrigin?: "source-contract" | "model-selected-quotes"): value is ResponsePreparationReply {
  try {
    if (!object(value) || !keys(value, ["revision", "prepared", "empty", "failed", "origin", "modelContribution", "modelQuoteProvenance"]) || value.origin !== expectedOrigin || !Number.isSafeInteger(value.revision)
      || Number(value.revision) < -1 || expectedRevision !== undefined && value.revision !== expectedRevision) return false;
    const alternatives = [own(value, "prepared"), own(value, "empty"), own(value, "failed")];
    if (alternatives.filter(Boolean).length !== 1) return false;
    if (own(value, "modelContribution") && (expectedOrigin !== undefined || !own(value, "prepared") || !validModelResponseContribution(value.modelContribution))) return false;
    if (own(value, "modelQuoteProvenance") && (expectedOrigin !== "model-selected-quotes" || !own(value, "prepared") || !validProposalQuoteProvenance(value.modelQuoteProvenance))) return false;
    if (own(value, "failed")) return text(value.failed, errorLimit, true);
    if (Number(value.revision) < 0) return false;
    if (own(value, "empty")) return expectedOrigin !== "source-contract" && value.empty === true;
    if (!validPrepared(value.prepared) || value.prepared.sourcePreparation?.origin !== (expectedOrigin === "source-contract" ? "source-contract" : undefined)) return false;
    return expectedOrigin !== "model-selected-quotes" || validProposalQuoteProvenance(value.modelQuoteProvenance)
      && value.prepared.items.length === 1 && value.prepared.items[0].destination === "proposals" && value.modelQuoteProvenance.projectedItemId === value.prepared.items[0].id;
  } catch { return false; }
}

/** Shared pure source tail; neither caller can introduce acknowledgements. */
function prepareItems(items: IntelligenceItem[], sources: IntelligenceSource[], destinations: IntelligenceDestination[]): ResponsePreparationResult | undefined {
    const deduplicated = deduplicateRequirements(items);
    const sourcePrepared = prepareIntelligenceSourceFacts(deduplicated.items, sources, destinations);
    const staffPrepared = completeSourceStaffCertificates(sourcePrepared.items, sources, destinations);
    const contractPrepared = completeContractProposalFields(staffPrepared.items, sources, destinations);
    if (!contractPrepared.items.length) {
      if (sourcePrepared.limited || staffPrepared.limited || contractPrepared.limited) throw new Error("Источники не разобраны полностью: достигнут предел подготовки. Разделите материалы и повторите анализ.");
      return undefined;
    }
    const textPrepared = completeSourceTextFields(contractPrepared.items, sources);
    const dated = completeSourceDates(textPrepared.items, sources);
    const positioned = completeSourcePositions(dated.items, sources);
    const completed = completeIntelligenceConditions(positioned.items, sources, { includeOperational: true });
    const expanded = collapseExpandedRequirementHeadings(completed.items, sources);
    const quarantined = quarantineConflictingFields(expanded.items, sources);
    const receipt: SourcePreparationReceipt = { changes: [...deduplicated.changes, ...sourcePrepared.changes, ...staffPrepared.changes, ...contractPrepared.changes, ...textPrepared.changes, ...dated.changes, ...positioned.changes, ...expanded.changes, ...quarantined.changes], skipped: [...sourcePrepared.skipped, ...staffPrepared.skipped, ...contractPrepared.skipped, ...textPrepared.skipped, ...dated.skipped, ...positioned.skipped, ...quarantined.skipped], limited: sourcePrepared.limited || staffPrepared.limited || contractPrepared.limited || textPrepared.limited || dated.limited || positioned.limited || quarantined.limited };
    const financialItems = quarantined.items.map((item) => {
      if (item.destination !== "proposals") return item;
      const financial = extractProposalSourceFinancials(sources.filter((source) => item.sourceIds.includes(source.id)));
      receipt.limited ||= financial.limited;
      for (const message of financial.issues) receipt.skipped.push({ itemId: item.id, field: "source-price", reason: "financial-review", message, requiresReview: true });
      const candidates = financial.candidates.filter((candidate) => {
        if (quarantined.items.filter((other) => other.destination === "proposals" && other.sourceIds.includes(candidate.sourceId)).length === 1) return true;
        receipt.skipped.push({ itemId: item.id, field: "source-price", reason: "financial-owner-ambiguous", message: "Один источник связан с несколькими КП. Общая цена не сопоставлена с конкретным проектом и не предлагается к применению автоматически.", requiresReview: true });
        return false;
      });
      const partyResult = extractProposalSourceParties(sources.filter((source) => item.sourceIds.includes(source.id)));
      receipt.limited ||= partyResult.limited;
      for (const message of partyResult.issues) receipt.skipped.push({ itemId: item.id, field: "source-party", reason: "party-review", message, requiresReview: true });
      const parties = partyResult.candidates.filter((candidate) => quarantined.items.filter((other) => other.destination === "proposals" && other.sourceIds.includes(candidate.sourceId)).length === 1);
      for (const candidate of parties) for (const message of candidate.issues) receipt.skipped.push({ itemId: item.id, field: "source-party", reason: "party-field-review", message, requiresReview: true });
      return { ...item, ...(candidates.length ? { proposalSourceFinancials: candidates } : {}), ...(parties.length ? { proposalSourceParties: parties } : {}) };
    });
    const prepared: ResponsePreparationResult = { ...completed, items: financialItems, ...(receipt.changes.length || receipt.skipped.length || receipt.limited ? { sourcePreparation: receipt } : {}) };
    if (!validPrepared(prepared)) throw new Error("Результат подготовки ответа некорректен или превышает допустимый объём. Разделите материалы.");
    return prepared;
}

/** Local, atomic preparation only: no model, filesystem, database or storage.
 * The explicitly different source route accepts no raw/model items at all.
 * Existing provider parsing, including its rejection rules, stays unchanged. */
export function runResponsePreparation(request: unknown): ResponsePreparationReply {
  const revision = object(request) && Number.isSafeInteger(request.revision) && Number(request.revision) >= 0 ? Number(request.revision) : -1;
  const sourceOnly = object(request) && request.origin === "source-contract";
  const origin = sourceOnly ? { origin: "source-contract" as const } : {};
  try {
    if (sourceOnly) {
      if (revision < 0 || !object(request) || !keys(request, ["origin", "revision", "sources"])) throw new Error("Некорректный запрос локальной подготовки договора.");
      assertSourceContractSources(request.sources);
      const prepared = prepareItems([], request.sources, ["proposals"]);
      if (!prepared || prepared.limited || !prepared.sourcePreparation || prepared.sourcePreparation.limited) throw new Error("Договор не подготовлен целиком в пределах допустимого объёма. Частичный результат не принят.");
      assertPreparedSourceContract(prepared.items, request.sources);
      prepared.sourcePreparation = { ...prepared.sourcePreparation, origin: "source-contract" };
      if (!validPrepared(prepared)) throw new Error("Локальный проект договора превышает допустимый объём.");
      return { revision, ...origin, prepared };
    }
    if (revision < 0 || !object(request) || !keys(request, ["revision", "raw", "sources", "destinations"])
      || !Array.isArray(request.destinations)) throw new Error("Некорректный запрос подготовки ответа.");
    assertResponsePreparationRaw(request.raw);
    assertResponsePreparationSources(request.sources);
    buildIntelligenceResponseSchema(request.destinations as IntelligenceDestination[]);
    const items = parseIntelligenceResult(request.raw, request.sources.map(source => source.id), { editableFields: true, destinations: request.destinations as IntelligenceDestination[] });
    const modelContribution = summarizeParsedModelContribution(items, request.destinations as IntelligenceDestination[]);
    const prepared = prepareItems(items, request.sources, request.destinations as IntelligenceDestination[]);
    return prepared ? { revision, prepared, modelContribution } : { revision, empty: true };
  } catch (reason) {
    const fallback = sourceOnly ? "Не удалось подготовить локальный проект договора." : "Не удалось подготовить ответ ИИ.";
    const message = reason instanceof Error ? reason.message : fallback;
    return { revision, ...origin, failed: message.slice(0, errorLimit) || fallback };
  }
}

/** Separate asynchronous quote route: raw parts are parsed as their real
 * schema, never wrapped in an invented ordinary model response. */
export async function runProposalQuotePreparation(request: unknown): Promise<ResponsePreparationReply> {
  const revision = object(request) && Number.isSafeInteger(request.revision) && Number(request.revision) >= 0 ? Number(request.revision) : -1;
  const origin = "model-selected-quotes" as const;
  try {
    assertProposalQuotePreparationRequest(request, true);
    const captured = structuredClone(request);
    const selected = await prepareProposalQuoteSelection({ revision: captured.revision, sources: captured.sources, parts: captured.parts, ...(captured.options === undefined ? {} : { options: captured.options }) });
    if (!selected.item) return { revision, origin, empty: true };
    // This existing tail is deliberately source-derived; its additions remain
    // in sourcePreparation and cannot increase the model selection receipt.
    const prepared = prepareItems([selected.item], captured.sources, ["proposals"]);
    if (!prepared || prepared.limited || prepared.sourcePreparation?.limited) throw new Error("Полный проект по выбранным цитатам не подготовлен в пределах допустимого объёма. Частичный результат не принят.");
    const reply: ResponsePreparationReply = { revision, origin, prepared, modelQuoteProvenance: selected.provenance };
    if (!validResponsePreparationReply(reply, revision, origin)) throw new Error("Проект или журнал выбранных цитат некорректен. Прежние результаты не заменены.");
    return reply;
  } catch (reason) {
    return { revision, origin, failed: (reason instanceof Error ? reason.message : "Не удалось подготовить проект по выбранным цитатам.").slice(0, errorLimit) || "Не удалось подготовить проект по выбранным цитатам." };
  }
}

// Importing the pure fallback in a Window must never replace window.onmessage.
if (typeof self !== "undefined" && typeof document === "undefined" && typeof self.postMessage === "function") {
  const worker = self as unknown as { onmessage: ((event: MessageEvent<unknown>) => void) | null; postMessage: (reply: ResponsePreparationReply) => void };
  worker.onmessage = (event) => {
    if (object(event.data) && event.data.origin === "model-selected-quotes") void runProposalQuotePreparation(event.data).then(reply => worker.postMessage(reply));
    else worker.postMessage(runResponsePreparation(event.data));
  };
}
