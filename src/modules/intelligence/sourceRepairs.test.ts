import { describe, expect, it } from "vitest";
import { repairConditionsFromSources, repairDateFromSource, repairPositionFromSources, sourceRepairCleanup } from "./sourceRepairs";
import { auditIntelligenceResult, extractIntelligenceDateFacts } from "./resultEvidence";
import { extractIntelligenceConditionFacts } from "./sourceConditionFacts";
import { extractSourcePositionFacts } from "./sourcePositionFacts";
import type { IntelligenceDestination, IntelligenceItem, IntelligenceSource } from "./workbenchTypes";

const source = (text: string, id = "source-a"): IntelligenceSource => ({ id, name: "Синтетический источник", text, fragments: [{ id: "page-1", locator: "Страница 1", text }] });
const item = (destination: IntelligenceDestination, fields: IntelligenceItem["fields"] = {}): IntelligenceItem => ({ id: "card-a", destination, title: "QA", fields, selectedFields: Object.keys(fields), sourceIds: ["source-a"], evidence: [] });
const freeze = <T,>(value: T): T => { if (value && typeof value === "object") { Object.freeze(value); Object.values(value).forEach(freeze); } return value; };
const lines = (count: number, label: string) => Array.from({ length: count }, (_, index) => `- ${label} компонент ${index + 1} — 1 шт;`).join("\n");
const detached = () => source(`№ п/п Артикул Изготовитель\n1 QA-100_A шт 2\n2 QA-200_B шт 2\nУсловия оплаты: 100%\nСервер QA в составе:\n${lines(19, "Альфа")}\nСервер QA в составе:\n${lines(13, "Бета")}`);

describe("explicit source repairs preserve validation and inputs", () => {
  it("repairs only the selected date event and keeps full global timezone evidence", () => {
    const input = source("Редакция извещения от 01.08.2039,09:30, время в документе указано в часовом поясеMSK\nСрок подачи: 03.08.2039,11:45");
    const fact = extractIntelligenceDateFacts([input]).facts.find((entry) => entry.event === "submission-end")!;
    const card = item("procurement", { name: "QA", publishedDate: "2039-07-01", submissionDeadline: "неверно", notes: "Старая заметка" });
    const before = structuredClone({ input, fact, card }); freeze(input); freeze(fact); freeze(card);
    const patch = repairDateFromSource(card, fact, [input]);
    expect(patch.fields.submissionDeadline).toBe("2039-08-03"); expect(patch.fields.publishedDate).toBe("2039-07-01");
    expect(patch.fields.notes).toContain("Старая заметка"); expect(patch.fields.notes).toContain("11:45 MSK");
    expect(patch.fields.notes).toContain(fact.supportingEvidence![0].quote);
    expect(patch.evidence?.some((claim) => claim.quote === fact.supportingEvidence![0].quote)).toBe(true);
    expect({ input, fact, card }).toEqual(before);
  });

  it("rejects stale timezone/supporting evidence, unrelated events, hidden and foreign dates", () => {
    const first = source("Время в документе указано в часовом поясе MSK\nСрок подачи: 03.08.2039,11:45");
    const old = extractIntelligenceDateFacts([first]).facts.find((entry) => entry.event === "submission-end")!;
    const changed = source(first.text.replace("MSK", "UTC"));
    expect(() => repairDateFromSource(item("procurement"), old, [changed])).toThrow(/больше не/u);
    expect(() => repairDateFromSource(item("procurement"), { ...old, event: "publication" }, [first])).toThrow();
    expect(() => repairDateFromSource(item("proposals"), old, [first])).toThrow(/событие/u);
    expect(() => repairDateFromSource(item("procurement"), old, [source(first.text, "foreign")])).toThrow();
    const hidden = source(first.text); hidden.fragments![0].sheetState = "hidden";
    expect(() => repairDateFromSource(item("procurement"), old, [hidden])).toThrow();
  });

  it("retains lower-bound context and rejects lot/timezone ambiguity", () => {
    const input = source("Поставка не может быть осуществлена ранее 29.12.2039.");
    const fact = extractIntelligenceDateFacts([input]).facts.find((entry) => entry.event === "execution-start")!;
    expect(fact.lowerBound).toBe(true);
    expect(repairDateFromSource(item("procurement"), fact, [input]).fields.notes).toContain("не ранее; нижняя допустимая граница");
    const lots = source("Лот 1: Сервер\nСрок подачи: 03.08.2039 11:45 MSK\nЛот 2: Аудит\nСрок подачи: 04.08.2039 15:30 MSK");
    const ambiguous = extractIntelligenceDateFacts([lots]).facts.find((entry) => entry.ambiguous)!;
    expect(() => repairDateFromSource(item("procurement"), ambiguous, [lots])).toThrow(/лот/u);
  });

  it("bulk-adds full conditions atomically, preserves qualifiers and routes payment to notes", () => {
    const input = source("1. Сертификат OSCP — не менее 5 специалистов.\n2. Копия доверенности, если подписывает представитель.\n3. Лицензия ФСТЭК б, е.\n4. Условия оплаты: 100% предоплата.");
    const facts = extractIntelligenceConditionFacts([input]).facts;
    const card = item("procurement", { requirements: ["Существующее требование"], notes: "Существующая заметка" });
    const before = structuredClone({ input, facts, card }); freeze(input); freeze(facts); freeze(card);
    const patch = repairConditionsFromSources(card, facts, [input]);
    expect(patch.fields.requirements).toEqual(["Существующее требование", facts[0].quote, facts[1].quote]);
    expect(patch.fields.licenses).toEqual([facts[2].quote]); expect(patch.fields.notes).toContain(facts[3].quote);
    for (const claim of patch.evidence || []) expect(input.text).toContain(claim.quote);
    expect({ input, facts, card }).toEqual(before);
  });

  it("deduplicates presentation only, never business numbers or exceptions", () => {
    const input = source("o\tСертификат OSCP — не менее 5;\n1. Сертификат OSEP — не менее 2;");
    const facts = extractIntelligenceConditionFacts([input]).facts;
    const card = item("procurement", { requirements: ["Сертификат OSCP — не менее 5", "Сертификат OSEP — не менее 5;"] });
    const patch = repairConditionsFromSources(card, facts, [input]);
    expect(patch.fields.requirements).toEqual([...card.fields.requirements as string[], facts[1].quote]);
    expect(patch.evidence?.some((claim) => claim.quote === facts[0].quote)).toBe(true);
    const repeat = repairConditionsFromSources({ ...card, ...patch }, facts, [input]); expect(repeat.fields.requirements).toEqual(patch.fields.requirements);
  });

  it("does not mislabel a licensing or application exception as a delivery term", () => {
    const input = source("Информация и документы могут не включаться в заявку, если находятся в открытом реестре и в заявку включена декларация.");
    const facts = extractIntelligenceConditionFacts([input]).facts;
    expect(facts[0].category).toBe("exception");
    const patch = repairConditionsFromSources(item("proposals"), facts, [input]);
    expect(patch.fields.internalNote).toBe(input.text); expect(patch.fields.deliveryTerms).toBeUndefined();
  });

  it("rejects a stale shortened condition, foreign/hidden sources and overflowing bulk without input mutation", () => {
    const input = source("1. Участник должен представить копию лицензии.");
    const fact = extractIntelligenceConditionFacts([input]).facts[0], card = item("procurement", { requirements: ["Прежнее"] });
    const before = structuredClone(card);
    expect(() => repairConditionsFromSources(card, [fact], [source(`${input.text} Если сведения отсутствуют в открытом реестре.`)])).toThrow(/изменилось/u);
    expect(() => repairConditionsFromSources(card, [fact], [source(input.text, "foreign")])).toThrow();
    const hidden = source(input.text); hidden.fragments![0].sheetState = "hidden";
    expect(() => repairConditionsFromSources(card, [fact], [hidden])).toThrow();
    expect(() => repairConditionsFromSources(card, Array(101).fill(fact), [input])).toThrow(/100/u);
    expect(card).toEqual(before);
  });

  it("assigns explicitly chosen detached SKU/configuration pairs with 19/13 components and literal titles", () => {
    const input = detached(), facts = extractSourcePositionFacts([input]); const card = item("proposals");
    const before = structuredClone({ input, card }); freeze(input); freeze(card);
    const apply = (current: IntelligenceItem, at: number) => repairPositionFromSources(current, -1, facts.positions[at].id, facts.configurations[at].id, [input], { skuQuote: facts.positions[at].quote, configurationQuote: facts.configurations[at].quote, description: facts.configurations[at].description });
    const first = apply(card, 0), second = apply({ ...card, ...first }, 1);
    expect(second.fields.lines).toEqual(["QA-100_A", "QA-200_B"]); expect(second.fields.lineDescriptions).toEqual(facts.configurations.map((fact) => fact.quote));
    expect((second.fields.lineDescriptions as string[]).every((description) => description.includes("Сервер QA в составе:"))).toBe(true);
    expect((second.fields.lineDescriptions as string[]).map((description) => description.split("\n").filter((line) => line.startsWith("- ")).length)).toEqual([19, 13]);
    expect(second.evidence?.filter((claim) => claim.field === "lines").map((claim) => claim.quote)).toEqual(["QA-100_A", "QA-200_B"]);
    for (const claim of second.evidence || []) expect(input.text).toContain(claim.quote);
    const audit = auditIntelligenceResult([{ ...card, ...second }], [input]);
    expect(audit.fields.find((field) => field.field === "lines")?.status).toBe("confirmed");
    expect(audit.fields.find((field) => field.field === "lineDescriptions")?.status).toBe("confirmed");
    expect({ input, card }).toEqual(before);
  });

  it("rejects foreign/stale mappings and exact duplicate SKU assignment without prefix false positives", () => {
    const input = detached(), facts = extractSourcePositionFacts([input]), card = item("proposals");
    const expected = { skuQuote: facts.positions[0].quote, configurationQuote: facts.configurations[0].quote, description: facts.configurations[0].description };
    expect(() => repairPositionFromSources(card, -1, facts.positions[0].id, facts.configurations[0].id, [source(input.text.replace("Альфа компонент 1", "Изменённый компонент 1"))], expected)).toThrow(/изменились/u);
    const other = source(`SKU: OTHER-100\nСервер в составе:\n${lines(1, "CPU")}`, "foreign"), foreignFacts = extractSourcePositionFacts([other]);
    expect(() => repairPositionFromSources(card, -1, facts.positions[0].id, foreignFacts.configurations[0].id, [input, other])).toThrow();
    expect(() => repairPositionFromSources(item("proposals", { lines: ["QA-100_A"], lineDescriptions: ["old"] }), -1, facts.positions[0].id, facts.configurations[0].id, [input])).toThrow(/уже назначен/u);
    expect(() => repairPositionFromSources(item("proposals", { lines: ["QA-100_AB"], lineDescriptions: ["old"] }), -1, facts.positions[0].id, facts.configurations[0].id, [input])).not.toThrow();
  });

  it("cleanup removes invalid dates and string placeholders without guessing replacements", () => {
    const card = item("procurement", { name: "QA", submissionDeadline: "2110-26-16", notes: "null", nmc: 0 });
    const before = structuredClone(card), cleaned = sourceRepairCleanup(card);
    expect(cleaned.keys).toEqual(["submissionDeadline", "notes"]); expect(cleaned.patch.fields).toEqual({ name: "QA", nmc: 0 }); expect(card).toEqual(before);
  });
});
