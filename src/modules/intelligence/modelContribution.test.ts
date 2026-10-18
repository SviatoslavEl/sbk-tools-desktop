import { describe, expect, it } from "vitest";
import { summarizeModelContribution, summarizeParsedModelContribution, validModelResponseContribution } from "./modelContribution";
import { fieldDefinitions, parseIntelligenceResult } from "./workbenchModel";

const reply = (fields: Record<string, unknown>, extra: Record<string, unknown> = {}) => JSON.stringify({ items: [
  { destination: "proposals", title: "Коммерческое предложение", fields, sourceIds: ["source-a"], ...extra },
] });

describe("original model contribution, not locally completed cards", () => {
  it("does not count source IDs, a generic display title or all-null schema fields as extracted data", () => {
    const raw = reply(Object.fromEntries(fieldDefinitions.proposals.filter(field => !["lines", "lineDescriptions"].includes(field.key)).map(field => [field.key, null])), { positions: null, evidence: [] });
    expect(summarizeModelContribution(raw, ["source-a"], ["proposals"])).toEqual({
      items: 1, populatedItems: 0, fields: 0, evidence: 0,
      destinations: [{ destination: "proposals", items: 1, fields: 0 }],
    });
    expect(summarizeModelContribution(reply({ title: "  Коммерческое   предложение " }), ["source-a"], ["proposals"]).fields).toBe(0);
    expect(summarizeModelContribution('{"items":[]}', ["source-a"], ["proposals"]).fields).toBe(0);
  });

  it("counts actual returned fields and paired positions without asserting correctness of their evidence", () => {
    const raw = reply({ issuerName: "ООО Исполнитель", paymentTerms: "   " }, {
      positions: [{ name: "Исследование системы", description: "Полный состав услуги" }],
      evidence: [{ field: "issuerName", sourceId: "source-a", quote: "Чужая, ещё не проверенная цитата" }],
    });
    expect(summarizeModelContribution(raw, ["source-a"], ["proposals"])).toMatchObject({
      items: 1, populatedItems: 1, fields: 3, evidence: 1,
    });
    // No source texts are accepted here: this diagnostic cannot produce a
    // source-grounded PASS from counting quotes or non-empty strings.
    expect(JSON.parse(raw).items[0].fields.paymentTerms).toBe("   ");
  });

  it("keeps missing directions and numeric zero visible, with no borrowing from other cards", () => {
    const raw = JSON.stringify({ items: [{ destination: "procurement", title: "Закупка", fields: { nmc: 0, requirements: [] }, sourceIds: ["source-a"] }] });
    expect(summarizeModelContribution(raw, ["source-a"], ["staff", "procurement"])).toEqual({
      items: 1, populatedItems: 1, fields: 1, evidence: 0,
      destinations: [{ destination: "staff", items: 0, fields: 0 }, { destination: "procurement", items: 1, fields: 1 }],
    });
  });

  it("uses the normal bounded parser and rejects malformed, duplicate-key or foreign-source replies", () => {
    for (const raw of ['{"items":[],"items":[]}', reply({ issuerName: "A" }, { sourceIds: ["foreign"] }), reply({ ownerPassword: "not-a-field" })]) {
      expect(() => summarizeModelContribution(raw, ["source-a"], ["proposals"])).toThrow();
    }
  });

  it("summarizes already parsed original items without mutating them or counting later local additions", () => {
    const items = parseIntelligenceResult(reply({ issuerName: "ООО Исполнитель" }, { positions: [{ name: "Анализ системы", description: "" }] }), ["source-a"], { editableFields: true, destinations: ["proposals"] });
    const before = structuredClone(items);
    Object.freeze(items); items.forEach(item => { Object.freeze(item.fields); Object.freeze(item); });
    const summary = summarizeParsedModelContribution(items, ["proposals"]);
    expect(summary).toMatchObject({ items: 1, populatedItems: 1, fields: 2, evidence: 0 });
    expect(validModelResponseContribution(summary)).toBe(true); expect(items).toEqual(before);
    const completed = structuredClone(items); completed[0].fields.paymentTerms = "Добавлено позже из источника";
    expect(summary.fields).toBe(2); expect(summarizeParsedModelContribution(completed, ["proposals"]).fields).toBe(3);
  });

  it("accepts closed zero/max count receipts without equating counts or evidence with proof", () => {
    const zero = summarizeModelContribution('{"items":[]}', ["source-a"], ["staff", "proposals"]);
    expect(validModelResponseContribution(zero)).toBe(true);
    const max = { items: 100, populatedItems: 100, fields: fieldDefinitions.staff.length * 100, evidence: 50_000,
      destinations: [{ destination: "staff", items: 100, fields: fieldDefinitions.staff.length * 100 }] };
    expect(validModelResponseContribution(max)).toBe(true);
  });

  it("rejects unknown keys, impossible destination totals, duplicate directions and unsafe count budgets", () => {
    const valid = summarizeModelContribution(reply({ issuerName: "ООО Исполнитель" }), ["source-a"], ["proposals"]);
    const invalid: unknown[] = [null, [], {}, { ...valid, sourceIds: ["source-a"] }, { ...valid, confirmed: true },
      { ...valid, fields: "1" }, { ...valid, items: -1 }, { ...valid, items: 101 }, { ...valid, items: Number.NaN },
      { ...valid, evidence: 501 }, { ...valid, evidence: 0.5 }, { ...valid, populatedItems: 2 }, { ...valid, populatedItems: 0 },
      { ...valid, fields: 0 }, { ...valid, destinations: [] }, { ...valid, destinations: [{ ...valid.destinations[0], unknown: true }] },
      { ...valid, destinations: [{ ...valid.destinations[0], destination: "unknown" }] },
      { ...valid, destinations: [valid.destinations[0], valid.destinations[0]] },
      { ...valid, destinations: [{ ...valid.destinations[0], items: 0 }] },
      { ...valid, destinations: [{ ...valid.destinations[0], fields: -1 }] },
      { ...valid, destinations: [{ ...valid.destinations[0], fields: fieldDefinitions.proposals.length + 1 }] },
      { ...valid, items: 0, populatedItems: 0, fields: 0, evidence: 1, destinations: [{ destination: "proposals", items: 0, fields: 0 }] },
    ];
    for (const receipt of invalid) expect(validModelResponseContribution(receipt), JSON.stringify(receipt)).toBe(false);
    // Every populated item has at least one field; every field belongs to a
    // populated item in its own direction, not another direction's capacity.
    expect(validModelResponseContribution({ items: 3, populatedItems: 1, fields: 2, evidence: 0,
      destinations: [{ destination: "staff", items: 2, fields: 1 }, { destination: "proposals", items: 1, fields: 1 }] })).toBe(false);
    expect(validModelResponseContribution({ items: 2, populatedItems: 2, fields: 1, evidence: 0,
      destinations: [{ destination: "staff", items: 2, fields: 1 }] })).toBe(false);
  });
});
