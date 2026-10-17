import { describe, expect, it } from "vitest";
import { buildAnalysisPlan, mergeAnalysisResponses } from "./analysisPlan";
import { buildIntelligenceHandoff, parseIntelligenceResult, validateIntelligenceItem } from "./workbenchModel";
import type { IntelligenceDestination, IntelligenceSource } from "./workbenchTypes";

const sources: IntelligenceSource[] = [
  { id: "source-a", name: "Синтетический источник A", text: "Условие A", sha256: "a".repeat(64) },
  { id: "source-b", name: "Синтетический источник B", text: "Условие B", sha256: "b".repeat(64) },
];
const sourceIds = sources.map((source) => source.id);
const directions: IntelligenceDestination[] = ["procurement", "contracts", "staff", "counterparties", "proposals"];
const wireItem = (destination: IntelligenceDestination, fields: Record<string, unknown>, usedSources = ["source-a"]) => ({ destination, title: "Синтетическая карточка", fields, sourceIds: usedSources });
const response = (destination: IntelligenceDestination, fields: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ text: JSON.stringify({ items: [{ ...wireItem(destination, fields), ...extra }] }), destinations: [destination] });
const empty = (destination: IntelligenceDestination) => ({ text: '{"items":[]}', destinations: [destination] });

describe("analysis planning without IO", () => {
  it("defaults to one combined request with the exact full selection", () => {
    const plan = buildAnalysisPlan("Подготовь карточки", sources, directions);
    expect(plan).toHaveLength(1);
    expect(plan[0].destinations).toEqual(directions);
    expect(plan[0].label).toBe("Закупки · Опыт по договорам · Кадры · Контрагенты · Коммерческие предложения");
    expect(JSON.stringify(plan[0].responseSchema)).toContain('"anyOf"');
    for (const source of sources) expect(plan[0].prompt).toContain(source.text);
  });

  it("keeps user order, all selected sources and one direction per strict schema", () => {
    const input = ["proposals", "procurement", "counterparties"] as IntelligenceDestination[];
    const before = structuredClone({ input, sources });
    const plan = buildAnalysisPlan("Извлеки сведения", sources, input, "by-destination");
    expect(plan.map((step) => step.destinations)).toEqual(input.map((destination) => [destination]));
    for (const [index, step] of plan.entries()) {
      expect(JSON.stringify(step.responseSchema)).not.toContain('"anyOf"');
      const variant = (step.responseSchema.properties as { items: { items: { properties: { destination: { enum: string[] } } } } }).items.items;
      expect(variant.properties.destination.enum).toEqual([input[index]]);
      for (const source of sources) expect(step.prompt).toContain(source.text);
    }
    expect({ input, sources }).toEqual(before);
    plan[0].destinations.push("staff");
    expect(input).toEqual(before.input);
  });

  it("plans one or five stages, never an empty, duplicate or out-of-scope selection", () => {
    expect(buildAnalysisPlan("Задача", sources, ["proposals"], "by-destination")).toHaveLength(1);
    expect(buildAnalysisPlan("Задача", sources, directions, "by-destination")).toHaveLength(5);
    for (const selection of [[], ["staff", "staff"], [...directions, "staff"], ["__proto__"]]) {
      expect(() => buildAnalysisPlan("Задача", sources, selection as IntelligenceDestination[], "by-destination")).toThrow(/направлен/u);
    }
    expect(() => buildAnalysisPlan("", sources, ["staff"], "by-destination")).toThrow(/задач/u);
    expect(() => buildAnalysisPlan("Задача", sources, ["staff"], "parallel" as "combined")).toThrow(/режим/u);
    expect(() => buildAnalysisPlan("Задача", [{ ...sources[0], text: "я".repeat(600_000) }], ["staff"], "by-destination")).toThrow(/1 МБ/u);
  });
});

describe("atomic aggregation of scoped analysis responses", () => {
  it("combines original wire values and per-item sources in deterministic stage order", () => {
    const procurement = response("procurement", { name: "Закупка", nmc: null, submissionDeadline: "неверная дата" });
    const counterparty = response("counterparties", { name: "Компания", inn: "ошибочный ИНН" }, { sourceIds: ["source-b"], evidence: [{ field: "name", sourceId: "source-b", fragmentId: null, quote: "Компания" }] });
    const before = structuredClone([procurement, counterparty]);
    const result = mergeAnalysisResponses([procurement, counterparty], sourceIds);
    expect(JSON.parse(result.text).items).toEqual(before.flatMap((part) => JSON.parse(part.text).items));
    expect([procurement, counterparty]).toEqual(before);
    expect(result.items.map((item) => item.destination)).toEqual(["procurement", "counterparties"]);
    expect(result.items.map((item) => item.sourceIds)).toEqual([["source-a"], ["source-b"]]);
    expect(new Set(result.items.map((item) => item.id)).size).toBe(2);
    expect(result.items[0].fields).toEqual({ name: "Закупка", submissionDeadline: "неверная дата" });
    expect(result.items[1].fields.inn).toBe("ошибочный ИНН");
    expect(validateIntelligenceItem(result.items[0])).not.toEqual([]);
    expect(validateIntelligenceItem(result.items[1])).not.toEqual([]);
    const reparsed = parseIntelligenceResult(result.text, sourceIds, { editableFields: true, destinations: ["procurement", "counterparties"] });
    expect(reparsed.map(({ id: _id, ...item }) => item)).toEqual(result.items.map(({ id: _id, ...item }) => item));
  });

  it("preserves paired proposal objects, complete multiline descriptions and handoff ordering", () => {
    const descriptions = [19, 13].map((length, position) => Array.from({ length }, (_, index) => `SKU-${position + 1}: компонент ${index + 1}; \"точная строка\"`).join("\n"));
    const positions = descriptions.map((description, index) => ({ name: `Комплектация SKU-${index + 1}`, description }));
    const proposal = response("proposals", { title: "Тестовый КП", issuerName: null }, { positions });
    const result = mergeAnalysisResponses([empty("procurement"), proposal], sourceIds);
    expect(JSON.parse(result.text).items[0].positions).toEqual(positions);
    expect(result.items[0].fields.lines).toEqual(positions.map((position) => position.name));
    expect(result.items[0].fields.lineDescriptions).toEqual(descriptions);
    expect(result.items[0].fields.issuerName).toBeUndefined();
    const handoff = buildIntelligenceHandoff(result.items[0], sources, "/synthetic/workspace");
    expect(handoff.destination).toBe("proposals");
    if (handoff.destination !== "proposals") throw new Error("Unexpected handoff");
    expect(handoff.data.lines.map((line) => line.description)).toEqual(descriptions);
    expect(handoff.data.lines.map((line) => line.title)).toEqual(positions.map((position) => position.name));
  });

  it("accepts one fenced answer, empty parts and all-empty results without inventing items", () => {
    const part = response("staff", { fullName: "Тестовый сотрудник" });
    part.text = `\n\`\`\`json\n${part.text}\n\`\`\`\n`;
    expect(mergeAnalysisResponses([empty("procurement"), part], sourceIds).items).toHaveLength(1);
    expect(mergeAnalysisResponses(directions.map(empty), sourceIds)).toEqual({ text: '{"items":[]}', items: [] });
  });

  it("accepts a single combined part with several directions", () => {
    const part = { destinations: ["staff", "proposals"] as IntelligenceDestination[], text: JSON.stringify({ items: [wireItem("staff", { fullName: "QA" }), { ...wireItem("proposals", { title: "КП" }), positions: null }] }) };
    const result = mergeAnalysisResponses([part], sourceIds);
    expect(result.items.map((item) => item.destination)).toEqual(["staff", "proposals"]);
    expect(JSON.parse(result.text).items[1].positions).toBeNull();
  });

  it.each([
    '{"items":[],"items":[]}',
    '{"items":[{"destination":"staff","title":"QA","fields":{"fullName":"A","fullName":"B"}}]}',
    '{"items":[{"destination":"staff","title":"QA","fields":{"fullName":"A"},"sourceIds":["foreign-source"]}]}',
    '{"items":[{"destination":"staff","title":"QA","fields":{"fullName":"A"},"id":"existing-record"}]}',
    '{"items":[{"destination":"staff","title":"QA","fields":{"fullName":"A"},"evidence":[{"field":"fullName","sourceId":"source-a","quote":"A","quote":"B"}]}]}',
    '```json\n{"items":[]}\n``` extra',
    '{"items":[{"destination":"staff","title":"QA","fields":{"fullName":{"name":"unsafe"}}}]}',
  ])("rejects the whole batch for a bad second response without returning partial items: %s", (text) => {
    expect(() => mergeAnalysisResponses([response("procurement", { name: "Предыдущая часть" }), { text, destinations: ["staff"] }], sourceIds)).toThrow(/Этап 2/u);
  });

  it("never allows a result from another stage direction, repeated stages or invalid source selections", () => {
    expect(() => mergeAnalysisResponses([{ ...response("staff", { fullName: "QA" }), destinations: ["procurement"] }], sourceIds)).toThrow(/сценарий/u);
    expect(() => mergeAnalysisResponses([empty("staff"), response("staff", { fullName: "QA" })], sourceIds)).toThrow(/повтор/u);
    expect(() => mergeAnalysisResponses([empty("staff")], ["source-a", "source-a"])).toThrow(/источник/u);
    expect(() => mergeAnalysisResponses([], sourceIds)).toThrow(/от 1 до 5/u);
    expect(() => mergeAnalysisResponses([...directions.map(empty), empty("staff")], sourceIds)).toThrow(/от 1 до 5/u);
  });

  it("rejects more than 100 cards across otherwise valid stages", () => {
    const parts = ["procurement", "staff"].map((destination, index) => ({ destinations: [destination] as IntelligenceDestination[], text: JSON.stringify({ items: Array.from({ length: index ? 50 : 51 }, () => wireItem(destination as IntelligenceDestination, destination === "staff" ? { fullName: "QA" } : { name: "QA" })) }) }));
    expect(() => mergeAnalysisResponses(parts, sourceIds)).toThrow(/более 100/u);
  });

  it("enforces the shared 2 MB budget rather than permitting 2 MB per stage", () => {
    const parts = ["procurement", "staff"].map((destination) => ({ destinations: [destination] as IntelligenceDestination[], text: JSON.stringify({ items: Array.from({ length: 12 }, () => wireItem(destination as IntelligenceDestination, { notes: "x".repeat(90_000) })) }) }));
    for (const part of parts) expect(parseIntelligenceResult(part.text, sourceIds, { editableFields: true, destinations: part.destinations })).toHaveLength(12);
    expect(() => mergeAnalysisResponses(parts, sourceIds)).toThrow(/Общий объём.*2 МБ/u);
  });
});
