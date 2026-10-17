import { completeIntelligenceConditions } from "./automaticConditions";
import { prepareIntelligenceSourceFacts, type SourcePreparationChange, type SourcePreparationSkipped } from "./sourcePreparedFacts";
import { collapseExpandedRequirementHeadings, deduplicateRequirements, type RequirementDeduplication } from "./requirementDeduplication";
import { completeSourceDates } from "./sourceDateCompletion";
import { completeSourceTextFields } from "./sourceTextCompletion";
import { completeSourcePositions } from "./sourcePositionCompletion";
import { completeSourceStaffCertificates } from "./sourceStaffCertificates";
import { quarantineConflictingFields } from "./quarantineConflictingFields";
import { buildIntelligenceResponseSchema, destinationLabels, fieldDefinitions, parseIntelligenceResult } from "./workbenchModel";
import { assertResponsePreparationRaw, assertResponsePreparationSources, RESPONSE_PREPARATION_LIMITS } from "./responsePreparationBounds";
export { RESPONSE_PREPARATION_LIMITS } from "./responsePreparationBounds";
import type { IntelligenceDestination, IntelligenceItem, IntelligenceSource } from "./workbenchTypes";

export interface SourcePreparationReceipt {
  changes: Array<SourcePreparationChange | RequirementDeduplication>;
  skipped: SourcePreparationSkipped[]; limited: boolean;
}
export type ResponsePreparationResult = ReturnType<typeof completeIntelligenceConditions> & { sourcePreparation?: SourcePreparationReceipt };
export interface ResponsePreparationRequest {
  revision: number; raw: string; sources: IntelligenceSource[]; destinations: IntelligenceDestination[];
}
export interface ResponsePreparationReply {
  revision: number; prepared?: ResponsePreparationResult; empty?: true; failed?: string;
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
  if (!object(value) || !keys(value, ["id", "destination", "title", "fields", "selectedFields", "sourceIds", "evidence", "staffDocuments"])
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
  if (!object(value) || !keys(value, ["changes", "skipped", "limited"]) || typeof value.limited !== "boolean") return false;
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
export function validResponsePreparationReply(value: unknown, expectedRevision?: number): value is ResponsePreparationReply {
  try {
    if (!object(value) || !keys(value, ["revision", "prepared", "empty", "failed"]) || !Number.isSafeInteger(value.revision)
      || Number(value.revision) < -1 || expectedRevision !== undefined && value.revision !== expectedRevision) return false;
    const alternatives = [own(value, "prepared"), own(value, "empty"), own(value, "failed")];
    if (alternatives.filter(Boolean).length !== 1) return false;
    if (own(value, "failed")) return text(value.failed, errorLimit, true);
    if (Number(value.revision) < 0) return false;
    return own(value, "empty") ? value.empty === true : validPrepared(value.prepared);
  } catch { return false; }
}

/** Local, atomic preparation only: no model, filesystem, database or storage.
 * raw and sources remain untouched; malformed answers never yield partial cards. */
export function runResponsePreparation(request: unknown): ResponsePreparationReply {
  const revision = object(request) && Number.isSafeInteger(request.revision) && Number(request.revision) >= 0 ? Number(request.revision) : -1;
  try {
    if (revision < 0 || !object(request) || !keys(request, ["revision", "raw", "sources", "destinations"])
      || !Array.isArray(request.destinations)) throw new Error("Некорректный запрос подготовки ответа.");
    assertResponsePreparationRaw(request.raw);
    assertResponsePreparationSources(request.sources);
    // The normal schema guard rejects unknown, duplicate and empty directions.
    buildIntelligenceResponseSchema(request.destinations as IntelligenceDestination[]);
    const sources = request.sources, items = parseIntelligenceResult(request.raw, sources.map((source) => source.id), {
      editableFields: true, destinations: request.destinations as IntelligenceDestination[],
    });
    const deduplicated = deduplicateRequirements(items);
    const sourcePrepared = prepareIntelligenceSourceFacts(deduplicated.items, sources, request.destinations as IntelligenceDestination[]);
    const staffPrepared = completeSourceStaffCertificates(sourcePrepared.items, sources, request.destinations as IntelligenceDestination[]);
    if (!staffPrepared.items.length) {
      if (sourcePrepared.limited || staffPrepared.limited) throw new Error("Явные таблицы не разобраны полностью: достигнут предел подготовки. Разделите материалы и повторите анализ.");
      return { revision, empty: true };
    }
    const textPrepared = completeSourceTextFields(staffPrepared.items, sources);
    const dated = completeSourceDates(textPrepared.items, sources);
    const positioned = completeSourcePositions(dated.items, sources);
    const completed = completeIntelligenceConditions(positioned.items, sources, { includeOperational: true });
    const expanded = collapseExpandedRequirementHeadings(completed.items, sources);
    const quarantined = quarantineConflictingFields(expanded.items, sources);
    const receipt: SourcePreparationReceipt = { changes: [...deduplicated.changes, ...sourcePrepared.changes, ...staffPrepared.changes, ...textPrepared.changes, ...dated.changes, ...positioned.changes, ...expanded.changes, ...quarantined.changes], skipped: [...sourcePrepared.skipped, ...staffPrepared.skipped, ...textPrepared.skipped, ...dated.skipped, ...positioned.skipped, ...quarantined.skipped], limited: sourcePrepared.limited || staffPrepared.limited || textPrepared.limited || dated.limited || positioned.limited || quarantined.limited };
    const prepared: ResponsePreparationResult = { ...completed, items: quarantined.items, ...(receipt.changes.length || receipt.skipped.length || receipt.limited ? { sourcePreparation: receipt } : {}) };
    if (!validPrepared(prepared)) throw new Error("Результат подготовки ответа некорректен или превышает допустимый объём. Разделите материалы.");
    return { revision, prepared };
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : "Не удалось подготовить ответ ИИ.";
    return { revision, failed: message.slice(0, errorLimit) || "Не удалось подготовить ответ ИИ." };
  }
}

// Importing the pure fallback in a Window must never replace window.onmessage.
if (typeof self !== "undefined" && typeof document === "undefined" && typeof self.postMessage === "function") {
  const worker = self as unknown as { onmessage: ((event: MessageEvent<unknown>) => void) | null; postMessage: (reply: ResponsePreparationReply) => void };
  worker.onmessage = (event) => worker.postMessage(runResponsePreparation(event.data));
}
