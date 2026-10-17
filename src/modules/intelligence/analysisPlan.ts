import { parseUniqueJson } from "./uniqueJson";
import {
  buildIntelligenceResponseSchema, destinationLabels,
  MAX_INTELLIGENCE_ITEMS, MAX_INTELLIGENCE_RESULT_BYTES, parseIntelligenceResult,
} from "./workbenchModel";
import type { IntelligenceDestination, IntelligenceItem, IntelligenceSource } from "./workbenchTypes";
import { buildGroundedAnalysisInput } from "./groundedAnalysis";
import { assertResponsePreparationSources } from "./responsePreparationBounds";

export type AnalysisMode = "combined" | "by-destination";
export interface AnalysisPlanStep {
  destinations: IntelligenceDestination[];
  prompt: string;
  responseSchema: Record<string, unknown>;
  label: string;
}
export interface AnalysisResponsePart {
  text: string;
  destinations: readonly IntelligenceDestination[];
}

/** Preflight only: no requests, retries, model state or persistence. */
export function buildAnalysisPlan(
  instruction: string,
  sources: readonly IntelligenceSource[],
  destinations: readonly IntelligenceDestination[],
  mode: AnalysisMode = "combined",
): AnalysisPlanStep[] {
  if (mode !== "combined" && mode !== "by-destination") throw new Error("Неизвестный режим анализа.");
  // Validate the complete selection before splitting it. Otherwise repeated or
  // oversized selections could pass validation one destination at a time.
  buildIntelligenceResponseSchema(destinations);
  assertResponsePreparationSources(sources);
  const groups = mode === "combined" ? [[...destinations]] : destinations.map((destination) => [destination]);
  return groups.map((group) => {
    const input = buildGroundedAnalysisInput(instruction, sources, group);
    return { destinations: [...group], prompt: input.prompt, responseSchema: input.responseSchema,
      label: group.map((destination) => destinationLabels[destination]).join(" · ") };
  });
}

function responseJson(raw: string): string {
  const text = raw.trim();
  if (!text.startsWith("```")) return text;
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(text);
  if (!fenced) throw new Error("Ответ должен содержать один JSON-объект без дополнительного текста.");
  return fenced[1].trim();
}

/**
 * Atomically validate a completed batch. Keep the original wire objects, not
 * fields reconstructed from parsed items: nulls, editable mistakes and paired
 * proposal positions must survive intact. Empty parts are valid. The caller
 * decides whether an all-empty batch should replace an existing result.
 */
export function mergeAnalysisResponses(
  parts: readonly AnalysisResponsePart[],
  sourceIds: readonly string[],
): { text: string; items: IntelligenceItem[] } {
  if (!Array.isArray(parts) || !parts.length || parts.length > 5) throw new Error("Для объединения нужны ответы от 1 до 5 этапов анализа.");
  const destinations: IntelligenceDestination[] = [];
  const wireItems: unknown[] = [];
  let responseBytes = 0;
  for (const [index, part] of parts.entries()) {
    if (typeof part?.text !== "string" || !Array.isArray(part.destinations)) throw new Error(`Этап ${index + 1}: некорректный ответ или направления.`);
    buildIntelligenceResponseSchema(part.destinations);
    if (part.destinations.some((destination: IntelligenceDestination) => destinations.includes(destination))) throw new Error("Направления этапов не должны повторяться.");
    destinations.push(...part.destinations);
    if (destinations.length > 5) throw new Error("Выберите не более 5 направлений анализа.");
    responseBytes += new TextEncoder().encode(part.text).byteLength;
    if (responseBytes > MAX_INTELLIGENCE_RESULT_BYTES) throw new Error("Общий объём ответов ИИ превышает 2 МБ. Сократите число направлений или материалов.");
    try {
      // Uses the same grammar, duplicate-key guard, source whitelist and shape
      // limits as normal analysis. A bad part rejects the whole batch.
      parseIntelligenceResult(part.text, sourceIds, { editableFields: true, destinations: part.destinations });
      const wire = parseUniqueJson(responseJson(part.text));
      if (!wire || typeof wire !== "object" || !Array.isArray((wire as { items?: unknown }).items)) throw new Error("Ответ должен содержать массив items.");
      wireItems.push(...(wire as { items: unknown[] }).items);
      if (wireItems.length > MAX_INTELLIGENCE_ITEMS) throw new Error(`Общий результат содержит более ${MAX_INTELLIGENCE_ITEMS} карточек.`);
    } catch (reason) {
      throw new Error(`Этап ${index + 1}: ${reason instanceof Error ? reason.message : String(reason)}`);
    }
  }
  const text = JSON.stringify({ items: wireItems });
  if (new TextEncoder().encode(text).byteLength > MAX_INTELLIGENCE_RESULT_BYTES) throw new Error("Общий результат ИИ превышает 2 МБ.");
  const items = parseIntelligenceResult(text, sourceIds, { editableFields: true, destinations });
  return { text, items };
}
