import { describe, expect, it } from "vitest";
import { extractProposalSourceFinancials, revalidateProposalSourceFinancials } from "./proposalSourceFinancials";
import type { IntelligenceSource } from "./workbenchTypes";

const price = "Стоимость Услуг составляет 1 000,00 рублей, кроме того налог на добавленную стоимость по ставке 22% в размере 220,00 рублей. Итого стоимость Услуг с учетом НДС составляет 1 220,00 рублей.";
const source = (text = price, patch: Partial<IntelligenceSource> = {}): IntelligenceSource => ({ id: "document-a", name: "Материалы", text: `Договор оказания услуг\n${text}`, sha256: "a".repeat(64), fragments: [{ id: "heading", locator: "Абзац 1", text: "Договор оказания услуг" }, { id: "financial", locator: "Абзац 3", text }], ...patch });

describe("literal source-owned proposal finances", () => {
  it("extracts coherent exact aggregate values and their evidence, without per-block price or advance", () => {
    const material = source(), before = structuredClone(material);
    const result = extractProposalSourceFinancials([material]);
    expect(result.limited).toBe(false); expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ sourceId: material.id, sourceSha256: material.sha256, fragmentId: "financial", locator: "Абзац 3", quote: price,
      scope: "aggregate", sourceKind: "contract", currency: "RUB", net: "1000", vatAmount: "220", gross: "1220", tax: { kind: "vat", rate: 22 }, issues: [] });
    expect(result.candidates[0]).not.toHaveProperty("quantity"); expect(result.candidates[0]).not.toHaveProperty("unitPrice"); expect(material).toEqual(before);
  });
  it("supports a generic total with included tax and no-tax total, keeping 0% distinct", () => {
    expect(extractProposalSourceFinancials([source("Стоимость работ составляет 500,00 рублей, в том числе НДС 20%.")]).candidates[0]).toMatchObject({ gross: "500", tax: { kind: "vat", rate: 20 }, issues: [] });
    expect(extractProposalSourceFinancials([source("Стоимость работ составляет 500,00 рублей без НДС.")]).candidates[0]).toMatchObject({ net: "500", tax: { kind: "none" }, issues: [] });
    expect(extractProposalSourceFinancials([source("Стоимость работ составляет 500,00 рублей, в том числе НДС 0%.")]).candidates[0]).toMatchObject({ gross: "500", tax: { kind: "vat", rate: 0 }, issues: [] });
    expect(extractProposalSourceFinancials([source("Стоимость услуг без НДС: 100 000,00 рублей; НДС 22%: 22 000,00 рублей; итого с НДС: 122 000,00 рублей.")]).candidates[0]).toMatchObject({ net: "100000", vatAmount: "22000", gross: "122000", tax: { kind: "vat", rate: 22 }, issues: [] });
    const netOnly = extractProposalSourceFinancials([source("Стоимость услуг без НДС: 100 000,00 рублей.")]).candidates[0];
    expect(netOnly.tax.kind).toBe("unknown");
  });
  it("never turns an unknown tax, foreign currency or inconsistent declaration into applicable RUB pricing", () => {
    const unknown = extractProposalSourceFinancials([source("Стоимость работ с учетом НДС составляет 500,00 рублей.")]).candidates[0];
    expect(unknown).toMatchObject({ gross: "500", tax: { kind: "unknown" } }); expect(unknown.issues.join(" ")).toMatch(/НДС/u);
    const foreign = extractProposalSourceFinancials([source("Стоимость работ составляет 500,00 USD без НДС.")]).candidates[0];
    expect(foreign.currency).toBe("USD"); expect(foreign.issues.join(" ")).toMatch(/рубли/u);
    const inconsistent = extractProposalSourceFinancials([source(price.replace("1 220,00", "1 230,00"))]).candidates[0];
    expect(inconsistent.issues.join(" ")).toMatch(/не согласуются/u);
  });
  it("does not resurrect aggregate text from an empty fragment selection or hidden history", () => {
    expect(extractProposalSourceFinancials([source(price, { fragments: [] })]).candidates).toEqual([]);
    const material = source(); material.fragments![1].sheetState = "hidden";
    expect(extractProposalSourceFinancials([material]).candidates).toEqual([]);
    material.fragments![1].includedByUser = true;
    expect(extractProposalSourceFinancials([material]).candidates).toHaveLength(1);
  });
  it("does not use filename, percentages, penalties, scaled prices or NMC as a quotation", () => {
    expect(extractProposalSourceFinancials([source("Аванс 30% от стоимости услуг 500 рублей, кроме того НДС 20%.")]).candidates).toEqual([]);
    expect(extractProposalSourceFinancials([source("Штраф: стоимость работ составляет 500 рублей без НДС.")]).candidates).toEqual([]);
    expect(extractProposalSourceFinancials([source("Стоимость работ составляет 500 тыс. рублей без НДС.")]).candidates).toEqual([]);
    const material = source(price, { name: "Коммерческое предложение.docx" }); expect(extractProposalSourceFinancials([material]).candidates[0].sourceKind).toBe("contract");
    const limit = source("Предельная цена договора составляет 500 рублей без НДС.");
    const candidate = extractProposalSourceFinancials([limit]).candidates[0];
    expect(candidate.sourceKind).toBe("procurementLimit"); expect(candidate.issues.join(" ")).toMatch(/не является/u);
  });
  it("keeps different totals unresolved instead of taking the first or summing them", () => {
    const material = source(); material.fragments!.push({ id: "other-price", locator: "Абзац 9", text: price.replace(/1 000,00/gu, "2 000,00").replace(/220,00/gu, "440,00").replace("1 440,00", "2 440,00") });
    const result = extractProposalSourceFinancials([material]); expect(result.candidates).toHaveLength(2);
    expect(result.candidates.every((candidate) => candidate.issues.some((issue) => issue.includes("несколько различных")))).toBe(true);
  });
  it("re-extracts before handoff and rejects source, quote, amount, role or selection mutations", () => {
    const material = source(), candidates = extractProposalSourceFinancials([material]).candidates;
    expect(revalidateProposalSourceFinancials(candidates, [material], [material.id])).toEqual(candidates);
    for (const patch of [{ gross: "999" }, { quote: "invented" }, { sourceKind: "offer" as const }, { sourceSha256: "b".repeat(64) }]) expect(() => revalidateProposalSourceFinancials([{ ...candidates[0], ...patch }], [material], [material.id])).toThrow(/не подтверждается/u);
    expect(() => revalidateProposalSourceFinancials(candidates, [source(price, { fragments: [] })], [material.id])).toThrow();
    expect(() => revalidateProposalSourceFinancials(candidates, [source(price, { id: "other" })], ["other"])).toThrow();
  });
  it("fails closed on duplicate fragment IDs and large clauses, and supports genuine whole-text sources", () => {
    const material = source(); material.fragments!.push({ ...material.fragments![1] });
    expect(extractProposalSourceFinancials([material]).candidates).toEqual([]);
    expect(extractProposalSourceFinancials([source(price.repeat(50))])).toMatchObject({ candidates: [], limited: true });
    expect(extractProposalSourceFinancials([source(price, { fragments: undefined })]).candidates).toHaveLength(1);
    expect(extractProposalSourceFinancials([source(price, { name: "X".repeat(2001) })])).toMatchObject({ candidates: [], limited: true });
  });
  it("does not select the first of contradictory taxes or total declarations inside one paragraph", () => {
    const contradiction = extractProposalSourceFinancials([source(`${price} Стоимость работ без НДС: 2000 рублей.`)]);
    expect(contradiction.candidates).toEqual([]); expect(contradiction.issues.length).toBeGreaterThan(0);
    const taxConflict = extractProposalSourceFinancials([source("Стоимость работ составляет 500 рублей без НДС; НДС 20%.")]).candidates[0];
    expect(taxConflict.tax.kind).toBe("unknown"); expect(taxConflict.issues.length).toBeGreaterThan(0);
  });
});
