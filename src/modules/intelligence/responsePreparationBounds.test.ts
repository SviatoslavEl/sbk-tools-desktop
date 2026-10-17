import { describe, expect, it } from "vitest";
import { assertResponsePreparationRaw, assertResponsePreparationSources, RESPONSE_PREPARATION_LIMITS } from "./responsePreparationBounds";
import { buildAnalysisPlan } from "./analysisPlan";
import { runResponsePreparation } from "./responsePreparationWorker";
import type { IntelligenceSource } from "./workbenchTypes";

const source = (count = 1, id = "source-a"): IntelligenceSource => ({ id, name: "Синтетический документ DOCX", text: "Название закупки.", fragments: Array.from({ length: count }, (_, index) => ({ id: `p-${index}`, locator: `Абзац ${index + 1}`, text: "Текст." })) });
const raw = '{"items":[{"destination":"procurement","title":"QA","fields":{"name":"QA"}}]}';
const prepare = (input: IntelligenceSource) => runResponsePreparation({ revision: 1, raw, sources: [input], destinations: ["procurement"] });
const error = (run: () => void) => { try { run(); return ""; } catch (reason) { return (reason as Error).message; } };

describe("one bounded source contract before send and response preparation", () => {
  it("L01 accepts the native DOCX fragment count 1392 at both boundaries without changing the snapshot", () => {
    const input = source(1392), before = structuredClone(input);
    // Native DOCX fragments retain their section metadata at runtime.
    input.fragments = input.fragments!.map((part, index) => ({ ...part, section: `Абзац ${index + 1}` }));
    before.fragments = structuredClone(input.fragments);
    expect(() => assertResponsePreparationSources([input])).not.toThrow();
    expect(buildAnalysisPlan("Извлеки закупку", [input], ["procurement"])).toHaveLength(1);
    expect(prepare(input).failed).toBeUndefined(); expect(input).toEqual(before);
  });
  it("retains bounded native PDF/DOCX/XLSX metadata without stripping any data to pass", () => {
    const input = source();
    Object.assign(input.fragments![0], { section: "Таблица", page: 1, hasImages: true, textCoverage: "partial", sheet: "Лист 1", cellRange: "A1", cells: [{ reference: "A1", text: "Значение", rawValue: "Значение", valueType: "s", numberFormat: "General", hasFormula: false }] });
    const before = structuredClone(input); expect(() => assertResponsePreparationSources([input])).not.toThrow(); expect(prepare(input).failed).toBeUndefined(); expect(input).toEqual(before);
    Object.assign(input.fragments![0], { cells: [{ deep: { nested: { too: { far: "Неограниченная структура" } } } }] });
    expect(() => assertResponsePreparationSources([input])).toThrow(/формат фрагментов/u);
  });
  it("L01 rejects native XLSX warning count 5172 before model/send and gives the identical manual-parse reason", () => {
    const input = { ...source(1769), name: "Синтетическая форма XLSX", warnings: Array(5172).fill("Проверьте формулу.") }, before = structuredClone(input);
    const message = error(() => buildAnalysisPlan("Извлеки закупку", [input], ["procurement"]));
    expect(message).toContain(input.name); expect(message).toContain("5172"); expect(message).toContain("1000"); expect(message).toMatch(/меньше листов|разделите/u);
    expect(prepare(input).failed).toBe(message); expect(input).toEqual(before);
  });
  it("allows at most 5000 per source and at most 5000 across sources, not 5000 for every source", () => {
    expect(() => assertResponsePreparationSources([source(5000)])).not.toThrow();
    expect(error(() => assertResponsePreparationSources([source(5001)]))).toMatch(/5001.*5000/u);
    expect(error(() => assertResponsePreparationSources([source(2501), source(2500, "source-b")]))).toMatch(/суммарно.*5001.*5000/u);
    expect(() => assertResponsePreparationSources([source(2500), source(2500, "source-b")])).not.toThrow();
  });
  it("keeps snapshot 8 MiB, raw 2 MiB and warning 1000 bounds rather than raising unrelated limits", () => {
    expect(RESPONSE_PREPARATION_LIMITS.snapshotBytes).toBe(8 * 1024 * 1024); expect(RESPONSE_PREPARATION_LIMITS.rawBytes).toBe(2 * 1024 * 1024);
    const input = source(); input.warnings = Array(1000).fill("Предупреждение."); expect(() => assertResponsePreparationSources([input])).not.toThrow();
    input.warnings.push("Ещё"); expect(error(() => assertResponsePreparationSources([input]))).toMatch(/1001.*1000/u);
    expect(() => assertResponsePreparationRaw("x".repeat(2 * 1024 * 1024))).not.toThrow();
    expect(() => assertResponsePreparationRaw("я".repeat(1024 * 1024 + 1))).toThrow(/2 МБ/u);
    const large = { ...source(), text: "я".repeat(4 * 1024 * 1024) };
    expect(() => assertResponsePreparationSources([large])).toThrow(/8 МБ/u);
  });
  it("never resurrects hidden or explicitly excluded aggregate text while preflighting or preparing", () => {
    const input: IntelligenceSource = { id: "source-a", name: "Синтетический XLSX", text: "Сертификат OSCP — не менее 99 специалистов.", fragments: [{ id: "visible", locator: "Лист 1", text: "Название закупки." }, { id: "hidden", locator: "Архив", sheetState: "hidden", text: "Сертификат OSCP — не менее 99 специалистов." }] };
    const plan = buildAnalysisPlan("Извлеки закупку", [input], ["procurement"]);
    expect(plan[0].prompt).not.toContain("99 специалистов"); expect(prepare(input).prepared?.changes).toEqual([]);
    input.fragments = []; expect(buildAnalysisPlan("Извлеки закупку", [input], ["procurement"])[0].prompt).not.toContain("99 специалистов");
    expect(prepare(input).prepared?.changes).toEqual([]);
  });
});
