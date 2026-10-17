import type { IntelligenceItem, IntelligenceSource } from "./workbenchTypes";
import { extractIntelligenceConditionFacts } from "./sourceConditionFacts";
import type { SourcePreparationChange } from "./sourcePreparedFacts";

export interface RequirementDeduplication {
  itemId: string; field: "requirements"; kind: "deduplicated";
  previousValue: string[]; value: string[]; requiresReview: true;
}
const key = (value: string) => value.normalize("NFKC").toLocaleLowerCase("ru")
  .replace(/ё/gu, "е").replace(/[‐‑–—]/gu, "-")
  .replace(/^\s*(?:\d{1,3}(?:\.\d{1,3}){0,3}[.)]\s+|[oо]\t|[•▪●]\s*|[-–—]\s+)/u, "")
  .replace(/\s+/gu, " ").replace(/[.;]+$/u, "").trim();

/** A tab-separated table ordinal is presentation only when the whole remaining
 * multi-cell body is present. Two different explicit component IDs remain
 * distinct, including when an unnumbered model copy would match both. */
export function createRequirementComparator(values: readonly string[]): (left: string, right: string) => boolean {
  const parts = new Map<string, { body: string; tableIndex?: string }>(), indexes = new Map<string, Set<string>>();
  const parse = (value: string) => {
    const cached = parts.get(value); if (cached) return cached;
    const row = /^\s*(\d{1,3}(?:\.\d{1,3}){0,3})[.)]?\t([\s\S]+)$/u.exec(value);
    const tableIndex = row && row[2].includes("\t") ? row[1] : undefined;
    const parsed = { body: key(tableIndex ? row![2] : value).replace(/[.,;]+$/u, ""), ...(tableIndex ? { tableIndex } : {}) };
    parts.set(value, parsed); return parsed;
  };
  for (const value of values) {
    const parsed = parse(value); if (!parsed.tableIndex) continue;
    const ids = indexes.get(parsed.body) || new Set<string>(); ids.add(parsed.tableIndex); indexes.set(parsed.body, ids);
  }
  return (left, right) => {
    const a = parse(left), b = parse(right);
    if (!a.body || a.body !== b.body) return false;
    if (a.tableIndex && b.tableIndex) return a.tableIndex === b.tableIndex;
    return !a.tableIndex && !b.tableIndex || (indexes.get(a.body)?.size || 0) <= 1;
  };
}

/** Only collapses literal duplicates, never semantically similar obligations,
 * differing quantities, alternatives, scopes or dates. Runs on a fresh model
 * response, before user edits; the original wire response remains unchanged. */
export function deduplicateRequirements(items: readonly IntelligenceItem[]): { items: IntelligenceItem[]; changes: RequirementDeduplication[] } {
  const changes: RequirementDeduplication[] = [];
  return { items: items.map((item) => {
    if (item.destination !== "procurement" || !Array.isArray(item.fields.requirements)) return item;
    const original = item.fields.requirements;
    if (original.length > 100 || original.some((entry) => typeof entry !== "string" || !entry.trim() || entry.length > 4000)) return item;
    const equal = createRequirementComparator(original), value = original.filter((entry, index) => !original.slice(0, index).some((previous) => equal(previous, entry)));
    if (value.length === original.length || !value.length) return item;
    changes.push({ itemId: item.id, field: "requirements", kind: "deduplicated", previousValue: [...original], value, requiresReview: true });
    return { ...item, fields: { ...item.fields, requirements: value } };
  }), changes };
}

/** When an exact model heading has already been supplemented with its unique
 * whole source row, retain that row once. No semantic paraphrase matching and
 * no removal unless the full condition AND proof text are already present. */
export function collapseExpandedRequirementHeadings(items: readonly IntelligenceItem[], sources: readonly IntelligenceSource[]): { items: IntelligenceItem[]; changes: SourcePreparationChange[] } {
  const inventory = extractIntelligenceConditionFacts(sources), changes: SourcePreparationChange[] = [];
  if (inventory.limited) return { items: [...items], changes };
  const next = items.map((item) => {
    const requirements = item.fields.requirements;
    if (item.destination !== "procurement" || !Array.isArray(requirements)) return item;
    const facts = inventory.facts.filter((fact) => fact.explicitTableTitle && item.sourceIds.includes(fact.sourceId));
    const value = requirements.filter((entry) => {
      const matching = facts.filter((fact) => key(fact.explicitTableTitle!) === key(entry));
      if (matching.length !== 1) return true;
      const fact = matching[0];
      if (!requirements.some((candidate) => key(candidate) === key(fact.quote))) return true;
      changes.push({ itemId: item.id, field: "requirements", kind: "replaced", previousValue: entry, value: fact.quote, sourceId: fact.sourceId, sourceName: fact.sourceName, fragmentId: fact.fragmentId, locator: fact.locator, quote: fact.quote, requiresReview: true });
      return false;
    });
    return value.length === requirements.length ? item : { ...item, fields: { ...item.fields, requirements: value } };
  });
  return changes.length > 500 ? { items: [...items], changes: [] } : { items: next, changes };
}
