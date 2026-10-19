import { describe, expect, it } from "vitest";
import { auditIntelligenceResult } from "./resultEvidence";
import { proposalQuoteNeedsConditionReview } from "./proposalQuoteCompleteness";
import type { IntelligenceItem, IntelligenceSource } from "./workbenchTypes";

const quote = "По согласованию сторон выдать результат, подготовленный на основе представленных материалов. При этом услуги подлежат оплате в полном размере.";
const consequence = "Услуги подлежат оплате в полном размере";
const source: IntelligenceSource = { id: "s", name: "Условия", text: quote, fragments: [{ id: "part-a", locator: "Условие A", text: quote }] };
const card = (value: string, field = "paymentTerms"): IntelligenceItem => ({ id: "p", destination: "proposals", title: "Проект исследования", sourceIds: ["s"], fields: { [field]: value }, selectedFields: [field], evidence: [{ field, sourceId: "s", fragmentId: "part-a", quote }] });

describe("a complete conditional quote does not approve a shortened proposal field", () => {
  it.each(["paymentTerms", "deliveryTerms"])("requires review of missing qualifications in %s, without modifying raw values/quotes", field => {
    const item = card(consequence, field), before = structuredClone({ item, source });
    const report = auditIntelligenceResult([item], [source]);
    expect(report.fields.find(entry => entry.field === field)?.status).toBe("unverified");
    expect(report.findings).toEqual(expect.arrayContaining([expect.objectContaining({ field, severity: "blocking", code: "unverified-value" })]));
    expect({ item, source }).toEqual(before);
  });

  it("does not call a fully retained literal quote incomplete", () => {
    const item = card(quote);
    expect(proposalQuoteNeedsConditionReview(item, "paymentTerms")).toBe(false);
    expect(auditIntelligenceResult([item], [source]).fields.find(entry => entry.field === "paymentTerms")?.status).toBe("confirmed");
  });

  it("treats a qualified paraphrase as requiring human review, not a proved semantic conflict", () => {
    const item = card("При согласии сторон результат по полученным материалам оплачивается полностью.");
    expect(proposalQuoteNeedsConditionReview(item, "paymentTerms")).toBe(true);
    const report = auditIntelligenceResult([item], [source]);
    expect(report.fields.find(entry => entry.field === "paymentTerms")?.status).not.toBe("conflict");
  });

  it("does not broaden this check to names, prices, internal notes or excluded fields", () => {
    for (const field of ["title", "price", "internalNote"]) expect(proposalQuoteNeedsConditionReview(card(consequence, field), field)).toBe(false);
    const item = card(consequence); item.selectedFields = [];
    expect(proposalQuoteNeedsConditionReview(item, "paymentTerms")).toBe(false);
  });

  it("never turns a forged or foreign quote into a valid confirmation", () => {
    const item = card(consequence); item.evidence![0].quote = "Если вымышленное событие произошло, оплата полная.";
    expect(auditIntelligenceResult([item], [source]).findings.some(entry => entry.code === "invalid-evidence-quote" && entry.severity === "blocking")).toBe(true);
    item.evidence![0] = { field: "paymentTerms", sourceId: "foreign", fragmentId: "part-a", quote };
    expect(auditIntelligenceResult([item], [source]).findings.some(entry => entry.code === "evidence-source-not-cited")).toBe(true);
  });
});
