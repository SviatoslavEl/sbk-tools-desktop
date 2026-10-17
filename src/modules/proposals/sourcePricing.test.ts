import { describe, expect, it } from "vitest";
import { cloneProposal, createProposal, createProposalLine } from "./defaults";
import { buildProposalPublic } from "./exportPublic";
import { priceProposal } from "./pricing";
import { applyProposalSourcePrice, createProposalSourceFinancials, dismissProposalSourcePricing, normalizeProposalSourceCandidate, proposalSourcePricingIssues, type ProposalSourceFinancialCandidate } from "./sourcePricing";

const candidate = (patch: Partial<ProposalSourceFinancialCandidate> = {}): ProposalSourceFinancialCandidate => ({ id: "price-a", sourceId: "doc-a", sourceName: "Исходный договор", fragmentId: "p3", locator: "Абзац 3", quote: "Стоимость всего комплекса 1220 рублей с НДС 22%", sourceKind: "contract", scope: "aggregate", currency: "RUB", net: "1000", vatAmount: "220", gross: "1220", tax: { kind: "vat", rate: 22 }, issues: [], ...patch });
function proposal(patch: Partial<ProposalSourceFinancialCandidate> = {}) {
  const data = createProposal(new Date(2035, 0, 1)); data.title = "Проверка системы"; data.issuer.name = "Исполнитель"; data.recipient.name = "Заказчик";
  data.lines = [{ ...createProposalLine(), title: "Анализ", description: "Проверить исходники" }, { ...createProposalLine(), title: "Отчёт", description: "Результат DOCX/PDF" }];
  data.sourceFinancials = createProposalSourceFinancials([candidate(patch)]); return data;
}
const confirmed = { sameProject: true, aggregateAsSingleLine: true };

describe("explicit private source price application", () => {
  it("uses one aggregate without inventing five prices, preserving every scope block and original data", () => {
    const data = proposal(), before = structuredClone(data), next = applyProposalSourcePrice(data, "price-a", confirmed);
    expect(next.lines).toHaveLength(1); expect(next.lines[0]).toMatchObject({ title: "Проверка системы", unit: "комплекс", quantity: "1", unitPrice: "1220", priceBasis: "gross", tax: { kind: "vat", rate: 22 }, description: "Анализ\nПроверить исходники\n\nОтчёт\nРезультат DOCX/PDF" });
    expect(priceProposal(next.lines).totals).toMatchObject({ netMinor: "100000", vatMinor: "22000", grossMinor: "122000" });
    expect(proposalSourcePricingIssues(next)).toEqual([]); expect(data).toEqual(before);
  });
  it("requires same-project, one-complex and replacement confirmations independently", () => {
    const data = proposal(); expect(() => applyProposalSourcePrice(data, "price-a", { sameProject: false, aggregateAsSingleLine: true })).toThrow(/тому же проекту/u);
    expect(() => applyProposalSourcePrice(data, "price-a", { sameProject: true })).toThrow(/сводную/u);
    data.lines[0].unitPrice = "5"; expect(() => applyProposalSourcePrice(data, "price-a", confirmed)).toThrow(/уже введены/u);
    expect(applyProposalSourcePrice(data, "price-a", { ...confirmed, replaceExistingPrices: true }).lines[0].unitPrice).toBe("1220");
  });
  it.each([{ tax: { kind: "unknown" } }, { currency: "USD" }, { sourceKind: "procurementLimit" }, { gross: "1230" }, { issues: ["Уточните объём"] }] as Partial<ProposalSourceFinancialCandidate>[]) ("does not apply uncertain source pricing %j", (patch) => expect(() => applyProposalSourcePrice(proposal(patch), "price-a", confirmed)).toThrow());
  it("does not lose conditions by truncating a long scope or pricing an empty scope", () => {
    const data = proposal(); data.lines = []; expect(() => applyProposalSourcePrice(data, "price-a", confirmed)).toThrow(/состав/u);
    data.lines = [{ ...createProposalLine(), title: "Комплекс", description: "X".repeat(20_001) }]; expect(() => applyProposalSourcePrice(data, "price-a", confirmed)).toThrow(/не помещается/u);
  });
  it("applies a true position only by unique unchanged name, preserving exact source quantity and unit", () => {
    const data = proposal({ scope: "position", positionName: "Анализ", quantity: "2", unit: "час", unitPrice: "610", priceBasis: "gross" });
    const next = applyProposalSourcePrice(data, "price-a", { sameProject: true });
    expect(next.lines[0]).toMatchObject({ unitPrice: "610", quantity: "2", unit: "час", title: "Анализ" }); expect(next.lines[1].unitPrice).toBe("");
    data.lines[1].title = "Анализ"; expect(() => applyProposalSourcePrice(data, "price-a", confirmed)).toThrow(/единственной/u);
    data.lines[0].title = "Изменено"; data.lines[1].title = "Отчёт"; expect(() => applyProposalSourcePrice(data, "price-a", confirmed)).toThrow();
  });
  it("invalidates old applicability when project, scope, price, party or source candidate changes", () => {
    const next = applyProposalSourcePrice(proposal(), "price-a", confirmed);
    for (const change of [(data: typeof next) => { data.title += " новая"; }, (data: typeof next) => { data.recipient.name = "Другой"; }, (data: typeof next) => { data.recipient.inn = "1234567890"; }, (data: typeof next) => { data.deliveryTerms = "Иной объём"; }, (data: typeof next) => { data.paymentTerms = "Другой порядок оплаты"; }, (data: typeof next) => { data.lines[0].description += " новые работы"; }, (data: typeof next) => { data.lines[0].unitPrice = "2"; }, (data: typeof next) => { data.sourceFinancials!.candidates[0].gross = "2"; }]) {
      const edited = structuredClone(next); change(edited); expect(proposalSourcePricingIssues(edited)).not.toEqual([]);
    }
    expect(cloneProposal(next).sourceFinancials?.decision).toBeUndefined(); expect(proposalSourcePricingIssues(cloneProposal(next))).not.toEqual([]);
    const reapplied = applyProposalSourcePrice(next, "price-a", { ...confirmed, replaceExistingPrices: true }); expect(reapplied.lines[0].description).toBe(next.lines[0].description);
  });
  it("lets a reviewer reject source pricing, keeps legacy proposals unaffected, and excludes private source evidence from public output", () => {
    const data = proposal(), rejected = dismissProposalSourcePricing(data); expect(proposalSourcePricingIssues(rejected)).toEqual([]); expect(rejected.lines[0].unitPrice).toBe("");
    const next = applyProposalSourcePrice(data, "price-a", confirmed); const output = buildProposalPublic(next);
    expect(output.totals.grossMinor).toBe("122000"); expect(JSON.stringify(output)).not.toContain("Исходный договор"); expect(output).not.toHaveProperty("sourceFinancials");
    delete data.sourceFinancials; expect(proposalSourcePricingIssues(data)).toEqual([]);
  });
  it("normalizes decimals but rejects number coercion, unsupported tax and unsafe candidates", () => {
    expect(normalizeProposalSourceCandidate(candidate({ gross: "1 220,00" })).gross).toBe("1220");
    for (const patch of [{ gross: 1220 }, { gross: "1e3" }, { tax: { kind: "vat", rate: 99 } }, { quote: "\u0000" }, { sourceSha256: "not-a-hash" }]) expect(() => normalizeProposalSourceCandidate(candidate(patch as any))).toThrow();
  });
});
