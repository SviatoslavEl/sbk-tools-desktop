import { describe, expect, it } from "vitest";
import { buildIntelligenceHandoff, emptyIntelligenceItem } from "./workbenchModel";
import type { IntelligenceSource } from "./workbenchTypes";

const phrase = "SYNTHETIC EXCLUDED CLAIM";
function note(source: IntelligenceSource, quote = phrase, fragmentId?: string) {
  const item = { ...emptyIntelligenceItem("procurement"), fields: { subject: "Synthetic review" }, selectedFields: ["subject"], sourceIds: [source.id], evidence: [{ field: "subject", sourceId: source.id, quote, ...(fragmentId ? { fragmentId } : {}) }] };
  const draft = buildIntelligenceHandoff(item, [source], "synthetic-workspace");
  if (draft.destination !== "procurement") throw new Error("Wrong direction");
  return draft.data.notes;
}

describe("provenance uses the same selected material as evidence audit", () => {
  it.each([
    { id: "qa", name: "QA", text: phrase, fragments: [] },
    { id: "qa", name: "QA", text: `Visible\n${phrase}`, fragments: [{ id: "v", locator: "Visible", text: "Visible" }] },
    { id: "qa", name: "QA", text: phrase, fragments: [{ id: "hidden", locator: "Hidden", text: phrase, sheetState: "hidden" as const }] },
  ])("never calls an excluded aggregate quote found", (source) => {
    expect(note(source)).not.toContain("Цитаты, найденные");
    expect(note(source)).not.toContain(phrase);
  });

  it("does not invent a quote by concatenating separate fragments", () => {
    const source = { id: "qa", name: "QA", text: "FIRST PART\nSECOND PART", fragments: [{ id: "a", locator: "A", text: "FIRST PART" }, { id: "b", locator: "B", text: "SECOND PART" }, { id: "h", locator: "Hidden", text: "History", sheetState: "hidden" as const }] };
    expect(note(source, "FIRST PART\nSECOND PART")).not.toContain("Цитаты, найденные");
  });

  it("keeps full-text and eligible fragment quotes, with their actual locator", () => {
    expect(note({ id: "qa", name: "QA", text: phrase })).toContain(phrase);
    const source = { id: "qa", name: "QA", text: phrase, fragments: [{ id: "v", locator: "Paragraph QA", text: phrase }] };
    expect(note(source, phrase, "v")).toContain(`Paragraph QA: ${phrase}`);
    expect(note(source)).toContain(`Paragraph QA: ${phrase}`);
    expect(note({ ...source, fragments: [{ ...source.fragments[0], sheetState: "hidden", includedByUser: true }] })).toContain(phrase);
    expect(note(source, phrase, "missing")).not.toContain("Цитаты, найденные");
  });
});
