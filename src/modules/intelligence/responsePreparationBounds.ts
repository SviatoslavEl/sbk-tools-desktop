import type { IntelligenceSource } from "./workbenchTypes";
import { validPdfGridFragment } from "./pdfGrid";

/** Shared send/parse boundary, not an import limit or promise of extraction
 * completeness. One source may use the whole fragment budget, never exceed it. */
export const RESPONSE_PREPARATION_LIMITS = Object.freeze({
  rawBytes: 2 * 1024 * 1024, snapshotBytes: 8 * 1024 * 1024,
  sources: 100, fragmentsPerSource: 5000, fragments: 5000, warningsPerSource: 1000,
  items: 100, receipts: 25_600,
});
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const text = (value: unknown, maximum: number): value is string => typeof value === "string" && value.length <= maximum;
const id = (value: unknown): value is string => text(value, 256) && Boolean(value.trim()) && Array.from(value).length <= 128 && !/[\u0000-\u001f]/u.test(value);
const optional = (value: Record<string, unknown>, key: string, test: (entry: unknown) => boolean) => value[key] === undefined || test(value[key]);
const array = (value: unknown, maximum: number, test: (entry: unknown) => boolean): value is unknown[] => Array.isArray(value) && value.length <= maximum && value.every(test);
const keys = (value: Record<string, unknown>, allowed: readonly string[]) => Object.keys(value).every((key) => allowed.includes(key));
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
const label = (source: Record<string, unknown>, index: number) => `Источник «${typeof source.name === "string" && source.name.trim() ? source.name.slice(0, 160) : `№${index + 1}`}»`;

/** Validate the exact selected snapshot without dropping hidden fragments,
 * warnings, aggregate text or any raw data to make an oversized task pass. */
export function assertResponsePreparationSources(value: unknown): asserts value is IntelligenceSource[] {
  const limits = RESPONSE_PREPARATION_LIMITS;
  if (!Array.isArray(value) || value.length > limits.sources) throw new Error(`Для анализа допускается не более ${limits.sources} источников. Выберите меньше документов и разделите задачу.`);
  let fragments = 0;
  let characters = 0, lastName = "Материалы";
  const snapshotLimit = () => new Error(`${lastName}: выбранные материалы с фрагментами и предупреждениями превышают 8 МБ. Выберите меньше документов или листов и разделите задачу. Ничего не усечено.`);
  const charge = (count: number) => { characters += count; if (characters > limits.snapshotBytes) throw snapshotLimit(); };
  const boundedText = (entry: unknown, maximum: number): entry is string => {
    if (!text(entry, maximum)) return false;
    // UTF-16 length is a lower bound for the serialized UTF-8 snapshot. Stop
    // before JSON.stringify can allocate the sum of many individually valid
    // 8 MiB strings (exact bytes/escaping are checked once at the end).
    charge(entry.length);
    return true;
  };
  const metadata = (entry: unknown, depth = 0): boolean => {
    if (depth > 4) return false;
    if (typeof entry === "string") return boundedText(entry, limits.snapshotBytes);
    if (entry === null || typeof entry === "boolean" || typeof entry === "number" && Number.isFinite(entry)) { charge(1); return true; }
    if (Array.isArray(entry)) { charge(entry.length + 2); return entry.length <= 16_384 && entry.every((part) => metadata(part, depth + 1)); }
    if (!object(entry) || Object.keys(entry).length > 16) return false;
    charge(Object.keys(entry).length + 2);
    return Object.entries(entry).every(([key, part]) => boundedText(key, 256) && metadata(part, depth + 1));
  };
  const fragmentMetadata = ["section", "noteId", "noteType", "page", "hasImages", "textCoverage", "sheet", "cellRange", "cells"] as const;
  const pages = (entry: unknown) => {
    if (!Array.isArray(entry) || entry.length > 100_000) return false;
    charge(entry.length + 2);
    return entry.every((page) => Number.isSafeInteger(page) && Number(page) >= 0);
  };
  const ids = new Set<string>();
  for (const [index, source] of value.entries()) {
    if (!object(source)) throw new Error(`Источник №${index + 1} имеет неверный формат. Повторно добавьте документ.`);
    const name = label(source, index);
    lastName = name;
    if (typeof source.text === "string" && source.text.length > limits.snapshotBytes) throw snapshotLimit();
    if (!keys(source, ["id", "name", "text", "sha256", "warnings", "fragments", "coverage"]) || !id(source.id) || ids.has(source.id) || !boundedText(source.name, 20_000) || !boundedText(source.text, limits.snapshotBytes)
      || !optional(source, "sha256", (entry) => boundedText(entry, 128))) throw new Error(`${name}: неверные данные или повторяющийся идентификатор. Повторно добавьте документ; крупный материал разделите.`);
    ids.add(source.id);
    if (Array.isArray(source.warnings) && source.warnings.length > limits.warningsPerSource) throw new Error(`${name}: ${source.warnings.length} предупреждений извлечения, предел — ${limits.warningsPerSource}. Выберите меньше листов или разделите документ и повторно добавьте материалы. Ничего не усечено.`);
    if (!optional(source, "warnings", (entry) => array(entry, limits.warningsPerSource, (warning) => boundedText(warning, 20_000)))) throw new Error(`${name}: неверный формат предупреждений. Повторно добавьте документ.`);
    if (source.fragments !== undefined) {
      if (Array.isArray(source.fragments) && source.fragments.length > limits.fragmentsPerSource) throw new Error(`${name}: ${source.fragments.length} фрагментов, предел — ${limits.fragmentsPerSource}. Выберите меньше листов или разделите документ. Ничего не усечено.`);
      if (!array(source.fragments, limits.fragmentsPerSource, (fragment) => object(fragment)
        && keys(fragment, ["id", "locator", "text", "sheetId", "sheetState", "includedByUser", "pdfGrid", ...fragmentMetadata])
        && boundedText(fragment.locator, 20_000) && boundedText(fragment.text, limits.snapshotBytes)
        && optional(fragment, "pdfGrid", () => validPdfGridFragment(fragment) && metadata(fragment.pdfGrid))
        && fragmentMetadata.every((key) => optional(fragment, key, (entry) => metadata(entry)))
        && optional(fragment, "id", id) && optional(fragment, "sheetId", id)
        && optional(fragment, "sheetState", (entry) => ["visible", "hidden", "veryHidden"].includes(String(entry)))
        && optional(fragment, "includedByUser", (entry) => typeof entry === "boolean"))) throw new Error(`${name}: неверный формат фрагментов. Повторно добавьте документ.`);
      fragments += source.fragments.length;
      if (fragments > limits.fragments) throw new Error(`${name}: суммарно выбрано ${fragments} фрагментов, общий предел — ${limits.fragments}. Выберите меньше листов или разделите материалы на несколько задач. Ничего не усечено.`);
    }
    if (source.coverage !== undefined && (!object(source.coverage) || !keys(source.coverage, ["complete", "requiresOcr", "pagesWithoutText", "pagesWithImages"]) || typeof source.coverage.complete !== "boolean" || typeof source.coverage.requiresOcr !== "boolean"
      || !optional(source.coverage, "pagesWithoutText", pages)
      || !optional(source.coverage, "pagesWithImages", pages))) throw new Error(`${name}: неверные данные полноты документа. Повторно добавьте материал.`);
  }
  // Checked only after bounded arrays/strings: avoids serializing an unbounded
  // malformed shape. This is the full snapshot, not just the model prompt.
  let serialized: string;
  try { serialized = JSON.stringify(value); } catch { throw new Error("Не удалось проверить материалы. Повторно добавьте документы."); }
  if (bytes(serialized) > limits.snapshotBytes) throw snapshotLimit();
}

export function assertResponsePreparationRaw(raw: unknown): asserts raw is string {
  if (typeof raw !== "string") throw new Error("Ответ ИИ должен быть текстом JSON.");
  if (raw.length > RESPONSE_PREPARATION_LIMITS.rawBytes || bytes(raw) > RESPONSE_PREPARATION_LIMITS.rawBytes) throw new Error("Ответ ИИ превышает 2 МБ. Разделите материалы или число направлений и повторите задачу. Ответ не усечён.");
}
