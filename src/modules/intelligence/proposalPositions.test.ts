import { describe, expect, it } from "vitest";
import { buildIntelligenceHandoff, buildIntelligencePrompt, buildIntelligenceResponseSchema, parseIntelligenceResult, validateIntelligenceItem } from "./workbenchModel";

const source = { id: "source-qa", name: "Synthetic material", text: "Server QA-A CPU-A; Server QA-B CPU-B" };
const card = (positions: unknown, fields: Record<string, unknown> = {}) => ({ destination: "proposals", title: "Synthetic proposal", fields, sourceIds: [source.id], positions });
const parse = (value: unknown, editableFields = false) => parseIntelligenceResult(JSON.stringify({ items: [value] }), [source.id], { editableFields });

describe("paired proposal response positions", () => {
  it("requests closed pairs instead of two independent arrays", () => {
    const schema = buildIntelligenceResponseSchema(["proposals"]) as any;
    const item = schema.properties.items.items;
    expect(item.required).toContain("positions");
    expect(item.properties.positions.type).toEqual(["array", "null"]);
    expect(item.properties.positions.maxItems).toBe(100);
    expect(item.properties.positions.items.additionalProperties).toBe(false);
    expect(item.properties.positions.items.required).toEqual(["name", "description"]);
    expect(item.properties.fields.properties.lines).toBeUndefined();
    expect(item.properties.fields.properties.lineDescriptions).toBeUndefined();
    expect(buildIntelligencePrompt("Prepare", [source], ["proposals"])).toContain("positions");
  });

  it("preserves two names with their full multiline descriptions through handoff", () => {
    const [item] = parse(card([{ name: "QA-A", description: "CPU-A\nRAM-A\nDisk-A" }, { name: "QA-B", description: "CPU-B\nRAM-B" }], { title: "Synthetic proposal" }));
    expect(item.fields.lines).toEqual(["QA-A", "QA-B"]);
    expect(item.fields.lineDescriptions).toEqual(["CPU-A\nRAM-A\nDisk-A", "CPU-B\nRAM-B"]);
    const draft = buildIntelligenceHandoff(item, [source], "synthetic-workspace");
    if (draft.destination !== "proposals") throw new Error("Wrong direction");
    expect(draft.data.lines.map(({ title, description, quantity, unitPrice }) => ({ title, description, quantity, unitPrice }))).toEqual([
      { title: "QA-A", description: "CPU-A\nRAM-A\nDisk-A", quantity: "", unitPrice: "" },
      { title: "QA-B", description: "CPU-B\nRAM-B", quantity: "", unitPrice: "" },
    ]);
  });

  it("retains empty descriptions and null unknown positions without guessing", () => {
    expect(parse(card([{ name: "QA-A", description: "" }]))[0].fields.lineDescriptions).toEqual([""]);
    const [unknown] = parse(card(null), true);
    expect(unknown.fields).toEqual({});
    expect(validateIntelligenceItem(unknown).join(" ")).toContain("Выберите хотя бы одно заполненное поле");
  });

  it.each([
    card([{ name: "QA-A", description: "text", unitPrice: 1 }]),
    card([{ name: "QA-A", description: { text: "nested" } }]),
    card([{ name: "QA-A" }]),
    card([{ name: "QA-A", description: "text\u0000" }]),
    card(Array.from({ length: 101 }, () => ({ name: "QA", description: "" }))),
    card([{ name: "QA-A", description: "" }], { lines: ["different"] }),
    { ...card([{ name: "QA-A", description: "" }]), destination: "procurement" },
  ])("rejects unsafe, ambiguous or misplaced pair payloads", (value) => expect(() => parse(value, true)).toThrow());

  it("keeps editable overlong names blocked and rejects oversized descriptions", () => {
    const [item] = parse(card([{ name: "Я".repeat(201), description: "" }]), true);
    expect(validateIntelligenceItem(item).join(" ")).toContain("200");
    expect(() => parse(card([{ name: "QA", description: "x".repeat(20_001) }]), true)).toThrow();
  });

  it("continues to read legacy arrays without hiding a mismatch", () => {
    const [item] = parse({ destination: "proposals", title: "Legacy", fields: { lines: ["QA-A", "QA-B"], lineDescriptions: ["CPU-A"] }, sourceIds: [source.id] }, true);
    expect(validateIntelligenceItem(item).join(" ")).toContain("в том же порядке и количестве");
  });
});
