import { describe, expect, it } from "vitest";
import { collapseExpandedRequirementHeadings, deduplicateRequirements } from "./requirementDeduplication";
import type { IntelligenceItem, IntelligenceSource } from "./workbenchTypes";
const card = (requirements: string[]): IntelligenceItem => ({ id: "qa", title: "QA", destination: "procurement", fields: { requirements }, selectedFields: ["requirements"], sourceIds: ["qa-source"] });

describe("literal model requirements deduplication", () => {
  it("frees a 100-entry model list without losing any of its 13 distinct requirements", () => {
    const distinct = Array.from({ length: 13 }, (_, index) => `Требуется не менее ${index + 1} специалиста для группы ${index + 1}.`);
    const input = card([...distinct, ...Array.from({ length: 87 }, (_, index) => `${index + 14}. ${distinct[index % 13]}`)]), before = structuredClone(input);
    const result = deduplicateRequirements([input]);
    expect(result.items[0].fields.requirements).toEqual(distinct);
    expect(result.changes).toEqual([{ itemId: "qa", field: "requirements", kind: "deduplicated", previousValue: input.fields.requirements, value: distinct, requiresReview: true }]);
    expect(input).toEqual(before); expect(deduplicateRequirements(result.items).changes).toEqual([]);
  });
  it("never merges different counts, scopes, alternatives or deadlines", () => {
    const original = ["Не менее 2 OSCP", "Не менее 3 OSCP", "OSCP или OSEP", "OSCP и OSEP", "Для нерезидента: перевод", "Для резидента: перевод", "Поставка 30 дней", "Поставка 45 дней"];
    expect(deduplicateRequirements([card(original)]).changes).toEqual([]);
  });
  it("keeps equivalent formatting only once but retains the original full first formulation", () => {
    expect(deduplicateRequirements([card(["1. Требуется отчёт — полный.", "2. требуется отчет - полный;"])]).items[0].fields.requirements).toEqual(["1. Требуется отчёт — полный."]);
  });
  it("does not auto-select excluded fields, alter evidence or deduplicate other destinations", () => {
    const input = { ...card(["A", "A"]), selectedFields: [], evidence: [{ field: "requirements", sourceId: "qa-source", quote: "A" }] };
    const result = deduplicateRequirements([input]).items[0]; expect(result.selectedFields).toEqual([]); expect(result.evidence).toBe(input.evidence);
    expect(deduplicateRequirements([{ ...input, destination: "staff" }]).changes).toEqual([]);
  });
  it("leaves malformed/over-limit lists for the normal validation path", () => {
    for (const requirements of [["", ""], Array(101).fill("A"), ["A".repeat(4001), "A".repeat(4001)]]) expect(deduplicateRequirements([card(requirements)]).changes).toEqual([]);
  });

  it("collapses the exact full body with and without a leading tab-separated row number", () => {
    const body = "Общая правоспособность\tУчастник должен обладать ресурсами и соответствовать требованиям раздела 5\tДекларация участника";
    const item = card([body, `1\t${body}`]), before = structuredClone(item);
    expect(deduplicateRequirements([item]).items[0].fields.requirements).toEqual([body]);
    expect(item).toEqual(before);
  });

  it("collapses a complete component body when only its table-row index was omitted", () => {
    const body = "Шасси\t1U, шкаф 19 дюймов, глубина не более 800мм\t1";
    expect(deduplicateRequirements([card([body, `1.1\t${body}`])]).items[0].fields.requirements).toEqual([body]);
  });

  it("preserves a multiline full table body and all OR/number qualifiers while removing only the omitted ordinal", () => {
    const body = "Документы\tЛицензия или декларация\nДля нерезидента — перевод; не менее 2 документов\tПодтверждение";
    expect(deduplicateRequirements([card([body, `3\t${body}`])]).items[0].fields.requirements).toEqual([body]);
    expect(deduplicateRequirements([card([body, `3\t${body.replace("2 документов", "3 документов")}`])]).changes).toEqual([]);
  });

  it("never merges different explicit component indexes or strips a component identifier inside the body", () => {
    const body = "Серверный модуль\tМодель QA-1.1\t1";
    const original = [body, `1.1\t${body}`, `1.2\t${body}`, "1.1 Компонент QA-1.1", "1.2 Компонент QA-1.1"];
    expect(deduplicateRequirements([card(original)]).items[0].fields.requirements).toEqual(original);
  });
});

describe("exact explicit table heading expansion", () => {
  const row = "1\tПроверяющая группа\tРуководитель и не менее ___ специалистов\tРезюме членов группы";
  const input: IntelligenceSource = { id: "qa-source", name: "Требования QA", text: "", fragments: [
    { id: "sheet-1-row-1", locator: "Лист QA A1:D1", text: "№\tНаименование требования\tСодержание требования\tДокументы / сведения для подтверждения" },
    { id: "sheet-1-row-2", locator: "Лист QA A2:D2", text: row },
  ] };
  it("retains a whole proven source row once instead of its redundant exact short heading", () => {
    const item = card(["Проверяющая группа", row]), before = structuredClone({ item, input }), result = collapseExpandedRequirementHeadings([item], [input]);
    expect(result.items[0].fields.requirements).toEqual([row]); expect(result.changes[0]).toMatchObject({ previousValue: "Проверяющая группа", value: row, quote: row, requiresReview: true });
    expect({ item, input }).toEqual(before);
  });
  it("never removes a heading before the full row is present, or a paraphrase/changed condition", () => {
    for (const requirements of [["Проверяющая группа"], ["Нужна проверяющая группа", row], ["Проверяющая группа", row.replace("___", "3")]]) expect(collapseExpandedRequirementHeadings([card(requirements)], [input]).changes).toEqual([]);
  });
  it("does not select a source, restore an excluded row or choose among same-titled conditions", () => {
    const item = card(["Проверяющая группа", row]);
    expect(collapseExpandedRequirementHeadings([{ ...item, sourceIds: [] }], [input]).changes).toEqual([]);
    expect(collapseExpandedRequirementHeadings([item], [{ ...input, fragments: [] }]).changes).toEqual([]);
    const duplicate = { ...input.fragments![1], id: "sheet-1-row-3", text: row.replace(/^1/u, "2").replace("___", "4") };
    expect(collapseExpandedRequirementHeadings([item], [{ ...input, fragments: [...input.fragments!, duplicate] }]).changes).toEqual([]);
  });
});
