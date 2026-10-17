import { describe, expect, it } from "vitest";
import { collectLiteralCompleteness } from "./literalCompleteness";
import type { IntelligenceItem, IntelligenceSource } from "./workbenchTypes";

const primary = "QA-27/26", registry = "8100-2026-00037", full = `${primary} (${registry})`;
const source = (numbers: string[] = [full], dates: string[] = ["18.02.2026"]): IntelligenceSource => ({ id: "alias-source", name: "Синтетическая таблица опыта QA", text: "", fragments: [
  { id: "table-row-1", locator: "Таблица, строка 1", text: "№ п/п\tЗаказчик\tПредмет договора\tСумма договора" },
  ...numbers.map((number, index) => ({ id: `table-row-${index + 2}`, locator: `Таблица, строка ${index + 2}`, text: `${index + 1}.\tЗаказчик QA\tАудит QA. Договор № ${number} от ${dates[index] || dates[0]}.\t100 000,00` })),
] });
const card = (number: string, date?: string, id = "alias-card"): IntelligenceItem => ({ id, destination: "contracts", title: "Аудит QA", sourceIds: ["alias-source"], fields: { number, ...(date ? { date } : {}) }, selectedFields: ["number", ...(date ? ["date"] : [])] });
const missing = (items: IntelligenceItem[], input = source()) => collectLiteralCompleteness(items, [input]).filter((finding) => finding.code === "missing-contract-card");

describe("literal contract primary numbers with a separate compact registry identifier", () => {
  it.each([primary, full])("accepts the explicitly printed primary or full form: %s", (number) => {
    const input = source(), item = card(number, "2026-02-18"), before = structuredClone({ input, item });
    expect(missing([item], input)).toEqual([]); expect({ input, item }).toEqual(before);
  });

  it("allows the unique primary number without requiring an invented selected date", () => {
    expect(missing([card(primary)])).toEqual([]);
  });

  it.each([registry, `${primary}X`, "QA-27", `${primary} (8100-2026-00038)`])("does not substitute the registry token, prefix or wrong full identifier: %s", (number) => {
    const findings = missing([card(number, "2026-02-18")]);
    expect(findings).toHaveLength(1); expect(findings[0].evidence[0].quote).toBe(source().fragments![1].text);
  });

  it.each(["261", "редакция 2", "доп. № 261", "8100 2026 00037", "18-02-2026", "ALT-37"])("does not strip arbitrary parentheses from the actual contract number: %s", (suffix) => {
    const input = source([`${primary} (${suffix})`]);
    expect(missing([card(primary, "2026-02-18")], input)).toHaveLength(1);
    expect(missing([card(`${primary} (${suffix})`, "2026-02-18")], input)).toEqual([]);
  });

  it("requires the selected matching date for a primary repeated with different dates or registry identifiers", () => {
    const input = source([full, `${primary} (8100-2025-00012)`], ["18.02.2026", "18.02.2025"]);
    const one = missing([card(primary, "2026-02-18")], input);
    expect(one).toHaveLength(1); expect(one[0].message).toContain("2025-02-18");
    expect(missing([card(primary, "2026-02-18", "a"), card(primary, "2025-02-18", "b")], input)).toEqual([]);
    expect(missing([card(primary)], input)).toHaveLength(2);
    expect(missing([{ ...card(primary, "2026-02-18"), selectedFields: ["number"] }], input)).toHaveLength(2);
    expect(missing([card(full)], input)).toHaveLength(2);
  });

  it("does not conflate distinct full identifiers that share the same primary and date", () => {
    const other = `${primary} (8100-2026-00038)`, input = source([full, other]);
    expect(missing([card(primary, "2026-02-18")], input)).toHaveLength(2);
    expect(missing([card(full, "2026-02-18", "a"), card(other, "2026-02-18", "b")], input)).toEqual([]);
  });

  it("does not borrow numbers from unselected fields, uncited sources or excluded fragments", () => {
    expect(missing([{ ...card(primary), selectedFields: [], title: primary }])).toHaveLength(1);
    expect(missing([{ ...card(primary), sourceIds: ["foreign"] }])).toEqual([]);
    const input = source(); input.fragments = [];
    expect(missing([card(primary)], { ...input, text: source().fragments!.map((entry) => entry.text).join("\n") })).toEqual([]);
  });
});
