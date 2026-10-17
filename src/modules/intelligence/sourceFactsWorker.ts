import { extractIntelligenceDateFacts } from "./resultEvidence";
import { extractSourcePositionFacts } from "./sourcePositionFacts";
import { extractIntelligenceConditionFacts } from "./sourceConditionFacts";
import type { IntelligenceSource } from "./workbenchTypes";

export function collectSourceFacts(sources: readonly IntelligenceSource[]) {
  if (!Array.isArray(sources) || sources.length > 100 || sources.some((source) => !source || typeof source.id !== "string" || !source.id.length || source.id.length > 128 || /[\u0000-\u001f]/u.test(source.id) || typeof source.name !== "string" || typeof source.text !== "string" || source.fragments !== undefined && !Array.isArray(source.fragments)) || new Set(sources.map((source) => source.id)).size !== sources.length) throw new Error("Invalid source selection");
  return { dates: extractIntelligenceDateFacts(sources), positions: extractSourcePositionFacts(sources), conditions: extractIntelligenceConditionFacts(sources) };
}
export type SourceFactsInventory = ReturnType<typeof collectSourceFacts>;
export interface SourceFactsRequest { revision: number; sources: IntelligenceSource[] }
export interface SourceFactsReply { revision: number; inventory?: SourceFactsInventory; failed?: boolean }
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const optional = (value: unknown, type: "string" | "boolean") => value === undefined || typeof value === type;
const excerpt = (value: unknown): value is Record<string, unknown> => object(value) && ["sourceId", "sourceName", "locator", "quote"].every((key) => typeof value[key] === "string") && optional(value.fragmentId, "string");
const bounded = (value: unknown, maximum: number, test: (entry: unknown) => boolean): value is unknown[] => Array.isArray(value) && value.length <= maximum && value.every(test);
const reasons = (value: unknown) => bounded(value, 100, (entry) => typeof entry === "string");
const association = (value: Record<string, unknown>) => value.associationProof === undefined || value.associationProof === "pdf-table-row";
/** Validate the worker protocol before UI code reads nested arrays/strings. */
export function validSourceFactsInventory(value: unknown): value is SourceFactsInventory {
  if (!object(value) || !object(value.dates) || !object(value.positions) || !object(value.conditions)) return false;
  const dateEvents = new Set(["submission-start", "submission-end", "question-deadline", "publication", "revision", "consideration", "results", "execution-start", "execution-end", "contract-date", "proposal-date", "valid-until"]);
  const categories = new Set(["requirement", "certificate", "license", "document", "quantity", "payment", "delivery", "exception"]);
  return typeof value.dates.limited === "boolean" && bounded(value.dates.facts, 1000, (fact) => excerpt(fact) && typeof fact.iso === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(fact.iso) && typeof fact.event === "string" && dateEvents.has(fact.event) && optional(fact.time, "string") && optional(fact.timezone, "string") && optional(fact.ambiguous, "boolean") && optional(fact.lowerBound, "boolean") && (fact.supportingEvidence === undefined || bounded(fact.supportingEvidence, 16, excerpt)))
    && typeof value.conditions.limited === "boolean" && bounded(value.conditions.facts, 256, (fact) => excerpt(fact) && typeof fact.category === "string" && categories.has(fact.category) && optional(fact.ambiguous, "boolean")
      && (fact.explicitTechnicalRole === undefined || fact.explicitTechnicalRole === true)
      && (fact.supportingEvidence === undefined || bounded(fact.supportingEvidence, 16, excerpt)))
    && typeof value.positions.truncated === "boolean" && reasons(value.positions.warnings)
    && bounded(value.positions.positions, 100, (fact) => excerpt(fact) && ["id", "sku", "name", "description"].every((key) => typeof fact[key] === "string") && typeof fact.ambiguous === "boolean" && reasons(fact.reasons) && optional(fact.configurationId, "string") && association(fact))
    && bounded(value.positions.configurations, 100, (fact) => excerpt(fact) && ["id", "name", "description"].every((key) => typeof fact[key] === "string") && Number.isSafeInteger(fact.componentCount) && Number(fact.componentCount) >= 0 && typeof fact.ambiguous === "boolean" && reasons(fact.reasons) && optional(fact.sku, "string") && optional(fact.positionId, "string") && association(fact));
}
export function runSourceFacts(request: unknown): SourceFactsReply {
  const revision = object(request) && Number.isSafeInteger(request.revision) && Number(request.revision) >= 0 ? Number(request.revision) : -1;
  try {
    if (revision < 0 || !object(request)) throw new Error("Invalid revision");
    return { revision, inventory: collectSourceFacts(request.sources as IntelligenceSource[]) };
  } catch { return { revision, failed: true }; }
}
// This module is also imported for a pure fallback. A Window is not a worker:
// never overwrite the host application's window.onmessage during that import.
if (typeof self !== "undefined" && typeof document === "undefined" && typeof self.postMessage === "function") {
  const worker = self as unknown as { onmessage: ((event: MessageEvent<SourceFactsRequest>) => void) | null; postMessage: (message: SourceFactsReply) => void };
  worker.onmessage = (event) => worker.postMessage(runSourceFacts(event.data));
}
