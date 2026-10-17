import { describe, expect, it } from "vitest";
import { completeIntelligenceConditions } from "./automaticConditions";
import { extractIntelligenceConditionFacts } from "./sourceConditionFacts";
import type { IntelligenceItem, IntelligenceSource } from "./workbenchTypes";

const card = (requirements: string[] = []): IntelligenceItem => ({ id: "qa-card", title: "Контрольная закупка", destination: "procurement", fields: { requirements }, selectedFields: ["requirements"], sourceIds: ["qa-source"], evidence: [] });
const source = (text: string): IntelligenceSource => ({ id: "qa-source", name: "Синтетические условия QA", text, fragments: [{ id: "paragraph-1", locator: "Абзац 1", text }] });
const reduction = "После подачи первого предложения: Участники могут только понижать цену (редукцион). Минимальный шаг изменения цены: 0,01 % от своего предложения";
const extension = "Автопродление приёма предложений\t15 мин.";

describe("literal procurement completeness without numbered-body duplicates", () => {
  it("retains eight full application-table bodies once and preserves all exact source quotes", () => {
    const bodies = Array.from({ length: 8 }, (_, index) => `Условие группы ${index + 1}\tУчастник должен представить документ или обоснованное исключение для ${index + 1} группы\tДекларация группы ${index + 1}`);
    const input: IntelligenceSource = { id: "qa-source", name: "Требования QA", text: "", fragments: [
      { id: "sheet-1-row-1", locator: "Лист QA A1:D1", text: "№\tНаименование требования\tСодержание требования\tДокументы / сведения для подтверждения" },
      ...bodies.map((body, index) => ({ id: `sheet-1-row-${index + 2}`, locator: `Лист QA A${index + 2}:D${index + 2}`, text: `${index + 1}\t${body}` })),
    ] };
    const item = card(bodies), before = structuredClone({ item, input }), result = completeIntelligenceConditions([item], [input], { includeOperational: true });
    expect(result.items[0].fields.requirements).toEqual(bodies); expect(result.changes).toHaveLength(8);
    expect(result.changes.every((entry) => entry.kind === "present")).toBe(true);
    expect(result.items[0].evidence).toHaveLength(8); expect({ item, input }).toEqual(before);
  });

  it("does not duplicate a complete component body but never collapses two explicit component IDs", () => {
    const body = "Шасси\t1U, шкаф 19 дюймов, глубина не более 800мм\t1";
    const input: IntelligenceSource = { id: "qa-source", name: "Количество QA", text: "", fragments: [
      { id: "table-row-1", locator: "Таблица, строка 1", text: "№\tНаименование оборудования\tХарактеристика\tКоличество" },
      { id: "table-row-2", locator: "Таблица, строка 2", text: `1.1\t${body}` },
    ] };
    expect(completeIntelligenceConditions([card([body])], [input], { includeOperational: true }).items[0].fields.requirements).toEqual([body]);
    input.fragments!.push({ id: "table-row-3", locator: "Таблица, строка 3", text: `1.2\t${body}` });
    expect(completeIntelligenceConditions([card([body])], [input], { includeOperational: true }).items[0].fields.requirements).toEqual([body, `1.1\t${body}`, `1.2\t${body}`]);
  });

  it("preserves full reduction and conditional extension clauses without changing any deadline", () => {
    const input = source(`${reduction}\n${extension}`), item = card(); item.fields.submissionDeadline = "2036-10-20";
    const before = structuredClone({ item, input }), result = completeIntelligenceConditions([item], [input], { includeOperational: true });
    expect(result.items[0].fields.requirements).toEqual([reduction, extension]);
    expect(result.items[0].fields.submissionDeadline).toBe("2036-10-20");
    expect(result.changes.every((entry) => entry.requiresReview && entry.quote === reduction || entry.quote === extension)).toBe(true);
    expect({ item, input }).toEqual(before);
    expect(extractIntelligenceConditionFacts([input]).facts.every((entry) => entry.ambiguous)).toBe(true);
  });

  it("does not auto-transfer procedure clauses without opt-in operational completion or through foreign/hidden/multi-card scope", () => {
    const input = source(reduction), item = card();
    expect(completeIntelligenceConditions([item], [input]).items[0].fields.requirements).toEqual([]);
    expect(completeIntelligenceConditions([{ ...item, sourceIds: ["foreign"] }], [input], { includeOperational: true }).items[0].fields.requirements).toEqual([]);
    input.fragments![0].sheetState = "hidden";
    expect(completeIntelligenceConditions([item], [input], { includeOperational: true }).items[0].fields.requirements).toEqual([]);
    input.fragments![0].sheetState = "visible";
    const duplicate = { ...item, id: "second" };
    const result = completeIntelligenceConditions([item, duplicate], [input], { includeOperational: true });
    expect(result.items).toEqual([item, duplicate]); expect(result.skipped.some((entry) => entry.reason === "multiple-cards")).toBe(true);
  });
});
