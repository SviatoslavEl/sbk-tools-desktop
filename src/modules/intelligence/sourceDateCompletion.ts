import { extractIntelligenceDateFacts, type IntelligenceDateFact } from "./resultEvidence";
import { dateFactField } from "./sourceGrounding";
import { multipleLots } from "./automaticConditions";
import type { SourcePreparationChange, SourcePreparationResult } from "./sourcePreparedFacts";
import type { IntelligenceEvidence, IntelligenceItem, IntelligenceSource } from "./workbenchTypes";

/** Supplements a single, unambiguously owned procurement/CP draft only. The
 * source date inventory never grants a date to every company, lot or person. */
export function completeSourceDates(items: readonly IntelligenceItem[], sources: readonly IntelligenceSource[]): SourcePreparationResult {
  const unchanged: SourcePreparationResult = { items: [...items], changes: [], skipped: [], limited: false };
  if (!items.some((item) => item.destination === "procurement" || item.destination === "proposals")) return unchanged;
  const validIds = (values: readonly { id?: string }[]) => values.every((value) => typeof value.id === "string" && Boolean(value.id.trim()) && Array.from(value.id).length <= 128 && !/[\u0000-\u001f]/u.test(value.id)) && new Set(values.map((value) => value.id)).size === values.length;
  const duplicateFragments = sources.some((source) => {
    const ids = (source.fragments || []).flatMap((fragment) => fragment.id ? [fragment.id] : []);
    return new Set(ids).size !== ids.length;
  });
  if (items.length > 100 || sources.length > 100 || !validIds(items) || !validIds(sources) || duplicateFragments) return { ...unchanged, limited: true, skipped: [{ reason: "date-input-identity", message: "Слишком много карточек / источников либо повторяются их идентификаторы или фрагменты. Автодополнение дат не выполнено.", requiresReview: true }] };
  const inventory = extractIntelligenceDateFacts(sources);
  if (inventory.limited) return { ...unchanged, limited: true, skipped: [{ reason: "date-inventory-limit", message: "Разбор дат достиг предела. Даты не дополнены частично; проверьте исходники.", requiresReview: true }] };
  const result: SourcePreparationResult = { items: [...items], changes: [], skipped: [], limited: false };
  const sourceMap = new Map(sources.map((source) => [source.id, source]));
  const seenSources = new Set<string>(), duplicateSources = new Set<string>();
  for (const source of sources) { if (seenSources.has(source.id)) duplicateSources.add(source.id); seenSources.add(source.id); }
  const fresh = (fact: IntelligenceDateFact) => {
    const source = sourceMap.get(fact.sourceId);
    if (!source || duplicateSources.has(fact.sourceId) || source.name !== fact.sourceName) return false;
    const fragments = source.fragments === undefined ? [{ locator: "Текст источника", text: source.text }] : source.fragments;
    return [fact, ...(fact.supportingEvidence || [])].every((proof) => proof.sourceId === source.id && proof.sourceName === source.name
      && fragments.some((fragment) => fragment.sheetState !== "hidden" && fragment.sheetState !== "veryHidden"
        && fragment.id === proof.fragmentId && fragment.locator === proof.locator && fragment.text.replace(/\s+/gu, " ").includes(proof.quote.replace(/\s+/gu, " "))));
  };
  const withLiteralEventContext = (fact: IntelligenceDateFact): IntelligenceDateFact => {
    // The shared parser can recognize a label on the immediately preceding
    // line of the SAME fragment. A date-only excerpt must keep that literal
    // label when copied into notes, never a generated "submission" assertion.
    if (!/^\s*[«"“]?\s*\d/u.test(fact.quote)) return fact;
    const source = sourceMap.get(fact.sourceId)!;
    const fragments = source.fragments === undefined ? [{ locator: "Текст источника", text: source.text }] : source.fragments;
    const fragment = fragments.find((entry) => entry.id === fact.fragmentId && entry.locator === fact.locator);
    if (!fragment) return fact;
    const position = fragment.text.indexOf(fact.quote);
    if (position < 0) return fact;
    const lineStart = fragment.text.lastIndexOf("\n", position - 1) + 1;
    if (!lineStart || fragment.text.slice(lineStart, position).trim()) return fact;
    const previousStart = fragment.text.lastIndexOf("\n", lineStart - 2) + 1;
    const label = fragment.text.slice(previousStart, lineStart).trim();
    if (!label || label.length > 200 || !/[:：]\s*$/u.test(label)) return fact;
    const quote = fragment.text.slice(previousStart, position + fact.quote.length).trim();
    return Array.from(quote).length <= 2000 ? { ...fact, quote } : fact;
  };
  for (const [index, item] of items.entries()) {
    if (item.destination !== "procurement" && item.destination !== "proposals") continue;
    const facts = inventory.facts.filter((fact) => item.sourceIds.includes(fact.sourceId) && dateFactField(item.destination, fact.event) && fresh(fact));
    const fields = [...new Set(facts.map((fact) => dateFactField(item.destination, fact.event)!))];
    for (const field of fields) {
      const candidates = facts.filter((fact) => dateFactField(item.destination, fact.event) === field);
      const ambiguous = candidates.some((fact) => fact.ambiguous || fact.lowerBound || multipleLots(sourceMap.get(fact.sourceId)!)
        || items.filter((candidate) => candidate.destination === item.destination && candidate.sourceIds.includes(fact.sourceId)).length !== 1);
      if (ambiguous || new Set(candidates.map((fact) => JSON.stringify([fact.iso, fact.time || "", fact.timezone || ""]))).size !== 1) {
        result.skipped.push({ itemId: item.id, field, reason: "ambiguous-date-owner", message: "Событие, дата, время или принадлежность карточке неоднозначны. Дата не назначена автоматически.", requiresReview: true }); continue;
      }
      const fact = withLiteralEventContext(candidates[0]), proofs = [fact, ...(fact.supportingEvidence || [])];
      if (!/^(?:19\d{2}|20\d{2}|21\d{2}|2200)-\d{2}-\d{2}$/u.test(fact.iso) || proofs.some((proof) => !proof.quote.trim() || Array.from(proof.quote).length > 2000)) continue;
      const current = result.items[index], notesField = item.destination === "procurement" ? "notes" : "internalNote";
      const patch = { ...current.fields, [field]: fact.iso }, evidence = [...(current.evidence || [])], changes: SourcePreparationChange[] = [];
      const noteQuotes = proofs.map((proof) => proof.quote);
      const originalNote = current.fields[notesField];
      if (originalNote !== undefined && typeof originalNote !== "string") continue;
      const note = [...(typeof originalNote === "string" && originalNote.trim() ? [originalNote] : []), ...noteQuotes.filter((quote) => typeof originalNote !== "string" || !originalNote.replace(/\s+/gu, " ").includes(quote.replace(/\s+/gu, " ")))].join("\n");
      // Preserve the complete event (including printed clock/timezone and its
      // supporting declaration), not just an ISO day stripped of qualifiers.
      if (note.length > 20_000) { result.skipped.push({ itemId: item.id, field, reason: "date-context-limit", message: "Полный контекст даты не помещается в примечания. Дата и контекст не усечены и не дополнены частично.", requiresReview: true }); continue; }
      patch[notesField] = note;
      for (const target of [field, notesField]) {
        const previousValue = current.fields[target], value = patch[target];
        if (previousValue !== value || !current.selectedFields.includes(target)) changes.push({ itemId: item.id, field: target, kind: previousValue === undefined ? "added" : "replaced", ...(previousValue !== undefined ? { previousValue } : {}), value, sourceId: fact.sourceId, sourceName: fact.sourceName, fragmentId: fact.fragmentId, locator: fact.locator, quote: fact.quote, requiresReview: true });
        for (const proof of target === field ? [fact] : proofs) {
          const claim: IntelligenceEvidence = { field: target, sourceId: proof.sourceId, fragmentId: proof.fragmentId, quote: proof.quote };
          if (!evidence.some((entry) => entry.field === claim.field && entry.sourceId === claim.sourceId && entry.fragmentId === claim.fragmentId && entry.quote === claim.quote)) evidence.push(claim);
        }
      }
      if (evidence.length > 500) continue;
      result.items[index] = { ...current, fields: patch, selectedFields: [...new Set([...current.selectedFields, field, notesField])], evidence };
      result.changes.push(...changes);
    }
  }
  if (result.changes.length + result.skipped.length > 500 || new TextEncoder().encode(JSON.stringify(result)).byteLength > 8 * 1024 * 1024) return { ...unchanged, limited: true, skipped: [{ reason: "date-preparation-limit", message: "Дополнение дат достигло предела. Вся операция отменена без усечения; разделите материалы.", requiresReview: true }] };
  return result;
}
