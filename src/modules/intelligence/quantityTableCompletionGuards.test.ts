import { describe, expect, it } from "vitest";
import { completeIntelligenceConditions } from "./automaticConditions";
import { extractIntelligenceConditionFacts } from "./sourceConditionFacts";
import type { IntelligenceFragment, IntelligenceItem, IntelligenceSource } from "./workbenchTypes";

const header = "№ пп\tНаименование оборудования\tХарактеристики\tКол-во\nшт.";
const parent = "1\tСервер в составе:\t10";
const memory = "1.1\tМодуль памяти\t16GB ECC RDIMM\t2";
const cable = "1.2\tКабель\t\tКабель питания 220В\t\t2";
const row = (number: number, text: string, extra: Partial<IntelligenceFragment> = {}): IntelligenceFragment => ({ id: `table-1-row-${number}`, locator: `Таблица 1, строка ${number}`, text, ...extra });
const input = (fragments = [row(1, header), row(2, parent), row(3, memory), row(4, cable)]): IntelligenceSource => ({ id: "quantity-source", name: "Синтетическая комплектация QA", text: "Не восстанавливать исключённый агрегат", fragments });
const card = (): IntelligenceItem => ({ id: "quantity-card", title: "Комплектация QA", destination: "procurement", fields: {}, selectedFields: [], sourceIds: ["quantity-source"], evidence: [] });
const apply = (source: IntelligenceSource) => completeIntelligenceConditions([card()], [source], { includeOperational: true });

describe("independent quantity-table ownership boundaries", () => {
  it("preserves all literal merged/hierarchical rows without structured counts, mandatory flags or SKU mapping", () => {
    const source = input(), before = structuredClone(source), result = apply(source);
    expect(result.items[0].fields).toEqual({ requirements: [parent, memory, cable] });
    expect(result.items[0].selectedFields).toEqual(["requirements"]);
    expect(result.items[0].evidence?.map((entry) => entry.quote)).toEqual([parent, memory, cable]);
    expect(result.changes.map((entry) => entry.category)).toEqual(["quantity", "quantity", "quantity"]);
    expect(result.changes.every((entry) => entry.requiresReview === true)).toBe(true);
    expect(source).toEqual(before);
  });

  it.each(["hidden", "veryHidden", "gap", "sheet", "table", "duplicate", "paragraph"])("does not inherit quantity-table ownership through %s", (change) => {
    const source = input(), fragments = source.fragments!;
    if (change === "hidden" || change === "veryHidden") fragments[1].sheetState = change;
    if (change === "gap") fragments.splice(1, 1);
    if (change === "sheet") fragments[1].sheetId = "different-sheet";
    if (change === "table") fragments[1].id = "table-2-row-2";
    if (change === "duplicate") fragments[1].id = fragments[0].id;
    if (change === "paragraph") fragments[1].id = "paragraph-2";
    expect(extractIntelligenceConditionFacts([source]).facts.find((fact) => fact.quote === memory)?.explicitTableRole).toBeUndefined();
    expect(apply(source).changes.some((entry) => entry.quote === memory || entry.quote === cable)).toBe(false);
  });

  it.each(["", "-2", "=2+2", "не указано"])("does not invent a quantity when the trailing cell is %s", (quantity) => {
    const source = input([row(1, header), row(2, `1\tМодуль памяти\tECC RDIMM\t${quantity}`)]);
    expect(extractIntelligenceConditionFacts([source]).facts.some((fact) => fact.explicitTableRole === "quantity")).toBe(false);
    expect(apply(source).changes).toEqual([]);
  });

  it("retains historical price scope across a quantity header and reports skipped whole rows", () => {
    const source = input([row(1, "Источники ценовой информации:"), row(2, header), row(3, parent), row(4, memory), row(5, cable)]), result = apply(source);
    expect(result.changes).toEqual([]); expect(result.items[0].fields).toEqual({});
    expect(result.skipped.filter((entry) => entry.reason === "informational-document").map((entry) => entry.quote)).toEqual([parent, memory, cable]);
  });

  it("never restores a quantity table from excluded aggregate text or accepts a supplied fact role", () => {
    const source = input(); source.text = source.fragments!.map((fragment) => fragment.text).join("\n"); source.fragments = [];
    Object.assign(source, { facts: [{ quote: memory, category: "quantity", explicitTableRole: "quantity" }] });
    expect(apply(source).changes).toEqual([]);
  });
});
