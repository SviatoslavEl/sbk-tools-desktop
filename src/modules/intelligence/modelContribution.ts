import { destinationLabels, fieldDefinitions, MAX_INTELLIGENCE_ITEMS, parseIntelligenceResult } from "./workbenchModel";
import type { IntelligenceDestination, IntelligenceFieldValue, IntelligenceItem } from "./workbenchTypes";

/** A description of the original reply, BEFORE local source completion. These
 * counts are not a correctness, evidence, completeness or readiness verdict. */
export interface ModelResponseContribution {
  items: number;
  populatedItems: number;
  fields: number;
  evidence: number;
  destinations: Array<{ destination: IntelligenceDestination; items: number; fields: number }>;
}

const normalize = (value: string) => value.normalize("NFKC").toLocaleLowerCase("ru").replace(/\s+/gu, " ").trim();
const genericTitles = new Set(["Коммерческое предложение", "КП", "Проект КП", ...Object.values(destinationLabels)].map(normalize));
// The ordinary reply parser admits at most 500 evidence entries per item.
// This is a count budget, not a claim that any of those entries is valid proof.
const maxEvidencePerItem = 500;
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const exactKeys = (value: Record<string, unknown>, expected: readonly string[]) => Object.keys(value).length === expected.length && expected.every(key => Object.prototype.hasOwnProperty.call(value, key));
const count = (value: unknown, maximum: number): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
const destination = (value: unknown): value is IntelligenceDestination => typeof value === "string" && Object.prototype.hasOwnProperty.call(destinationLabels, value);
function populated(key: string, value: IntelligenceFieldValue): boolean {
  if (typeof value === "string") return Boolean(value.trim()) && !(key === "title" && genericTitles.has(normalize(value)));
  if (Array.isArray(value)) return value.some(entry => entry.trim());
  // Zero and false are real returned values, not missing data. Whether they
  // are appropriate is decided by the separate field/evidence audit.
  return true;
}

/** Consume the original, already parsed items BEFORE any source completion.
 * The worker owns this operation; no raw response is reparsed on the UI thread. */
export function summarizeParsedModelContribution(
  items: readonly IntelligenceItem[],
  destinations: readonly IntelligenceDestination[],
): ModelResponseContribution {
  const result: ModelResponseContribution = { items: items.length, populatedItems: 0, fields: 0, evidence: 0,
    destinations: destinations.map(destination => ({ destination, items: 0, fields: 0 })) };
  for (const item of items) {
    const fields = Object.entries(item.fields).filter(([key, value]) => populated(key, value)).length;
    result.populatedItems += Number(fields > 0);
    result.fields += fields;
    result.evidence += item.evidence?.length || 0;
    const destination = result.destinations.find(entry => entry.destination === item.destination)!;
    destination.items++;
    destination.fields += fields;
  }
  return result;
}

/** Compatibility/test helper. Native preparation uses the already parsed
 * overload above, not a second parse after the worker has completed. */
export function summarizeModelContribution(
  raw: string,
  sourceIds: readonly string[],
  destinations: readonly IntelligenceDestination[],
): ModelResponseContribution {
  return summarizeParsedModelContribution(parseIntelligenceResult(raw, sourceIds, { editableFields: true, destinations }), destinations);
}

/** Closed, source-agnostic worker receipt. Bounds and cross-count consistency
 * establish only that the diagnostic is well-shaped, never factual readiness. */
export function validModelResponseContribution(value: unknown): value is ModelResponseContribution {
  if (!object(value) || !exactKeys(value, ["items", "populatedItems", "fields", "evidence", "destinations"])
    || !count(value.items, MAX_INTELLIGENCE_ITEMS) || !count(value.populatedItems, value.items)
    || !count(value.evidence, value.items * maxEvidencePerItem)
    || !Array.isArray(value.destinations) || value.destinations.length < 1 || value.destinations.length > Object.keys(destinationLabels).length) return false;
  let items = 0, fields = 0, minimumPopulated = 0, maximumPopulated = 0;
  const seen = new Set<IntelligenceDestination>();
  for (const entry of value.destinations) {
    if (!object(entry) || !exactKeys(entry, ["destination", "items", "fields"]) || !destination(entry.destination)
      || seen.has(entry.destination) || !count(entry.items, MAX_INTELLIGENCE_ITEMS)
      || !count(entry.fields, entry.items * fieldDefinitions[entry.destination].length)) return false;
    seen.add(entry.destination);
    items += entry.items; fields += entry.fields;
    minimumPopulated += Math.ceil(entry.fields / fieldDefinitions[entry.destination].length);
    maximumPopulated += Math.min(entry.items, entry.fields);
  }
  return items === value.items && fields === value.fields
    && value.populatedItems >= minimumPopulated && value.populatedItems <= maximumPopulated;
}
