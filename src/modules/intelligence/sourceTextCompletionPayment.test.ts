import { describe, expect, it } from "vitest";
import { completeSourceTextFields } from "./sourceTextCompletion";
import { auditIntelligenceResult, getBlockingEvidenceFindings } from "./resultEvidence";
import type { IntelligenceFragment, IntelligenceItem, IntelligenceSource } from "./workbenchTypes";

const advance = "Авансовый платеж — 50% от стоимости услуг в течение 5 календарных дней с даты подписания договора;";
const final = "Окончательный расчет — 50% в течение 5 календарных дней с даты подписания акта либо истечения срока мотивированного отказа.";
const paragraph = (n: number, text: string): IntelligenceFragment => ({ id: `paragraph-${n}`, locator: `Абзац ${n}`, text });
const source = (): IntelligenceSource => ({ id: "qa-source", name: "Синтетическое КП QA", text: "Не восстанавливать исключённые пункты", fragments: [paragraph(1, "Коммерческое предложение"), paragraph(2, "Условия оплаты:"), paragraph(3, advance), paragraph(4, final), paragraph(6, "Оговорки:")] });
const card = (): IntelligenceItem => ({ id: "qa-card", destination: "proposals", title: "КП", fields: { paymentTerms: `${advance}\n${final}` }, sourceIds: ["qa-source"], selectedFields: ["paymentTerms"], evidence: [] });

describe("complete literal payment-section proof recovery", () => {
  it("adds both real quotes and a normal evidence-change receipt without changing the field or existing claims", () => {
    const input = source(), item = card(), before = structuredClone({ input, item });
    item.evidence!.push({ field: "internalNote", sourceId: input.id, fragmentId: "paragraph-1", quote: "Коммерческое предложение" });
    const result = completeSourceTextFields([item], [input]), prepared = result.items[0];
    expect(prepared.fields).toEqual(item.fields); expect(prepared.selectedFields).toEqual(item.selectedFields);
    expect(prepared.evidence!.filter((claim) => claim.field === "paymentTerms")).toEqual(input.fragments!.slice(2, 4).map((fragment) => ({ field: "paymentTerms", sourceId: input.id, fragmentId: fragment.id, quote: fragment.text })));
    expect(prepared.evidence).toContainEqual(item.evidence![0]);
    expect(result.changes).toEqual([expect.objectContaining({ field: "paymentTerms", kind: "replaced", value: item.fields.paymentTerms, previousValue: item.fields.paymentTerms, requiresReview: true })]);
    expect(completeSourceTextFields(result.items, [input]).changes).toEqual([]);
    expect(input).toEqual(before.input); expect(item.fields).toEqual(before.item.fields); expect(item.evidence).toHaveLength(1);
    const report = auditIntelligenceResult(result.items, [input]);
    expect(report.fields.find((field) => field.field === "paymentTerms")?.status).toBe("confirmed");
    expect(getBlockingEvidenceFindings(report, prepared)).toEqual([]);
  });

  it("normalizes only whitespace for comparison and keeps an unknown issuer blocked", () => {
    const input = source(), item = card(); item.fields.paymentTerms = `  ${advance}\n\n  ${final}  `;
    item.fields.issuerName = "АО «Клиент QA»"; item.selectedFields.push("issuerName"); input.fragments!.unshift(paragraph(0, "АО «Клиент QA»"));
    const result = completeSourceTextFields([item], [input]);
    expect(result.items[0].fields.paymentTerms).toBe(item.fields.paymentTerms);
    const report = auditIntelligenceResult(result.items, [input]);
    expect(report.fields.find((field) => field.field === "paymentTerms")?.status).toBe("confirmed");
    expect(getBlockingEvidenceFindings(report, result.items[0]).some((finding) => finding.field === "issuerName")).toBe(true);
  });

  it.each(["hidden", "gap", "sheet", "new-heading-between", "partial", "changed-number", "missing-alternative", "reordered", "multiple-cards", "duplicate-header", "duplicate-fragment", "foreign", "deselected", "incomplete"])("does not recover %s payment proof", (variant) => {
    const input = source(), item = card(); let items = [item];
    if (variant === "hidden") { input.fragments![3].sheetState = "hidden"; input.fragments![3].includedByUser = true; }
    if (variant === "gap") { input.fragments![3].id = "paragraph-5"; input.fragments![3].locator = "Абзац 5"; }
    if (variant === "sheet") input.fragments![3].sheetId = "other-sheet";
    if (variant === "new-heading-between") { input.fragments![3] = paragraph(5, final); input.fragments!.splice(3, 0, paragraph(4, "Условия поставки:")); }
    if (variant === "partial") item.fields.paymentTerms = advance;
    if (variant === "changed-number") item.fields.paymentTerms = String(item.fields.paymentTerms).replace("50%", "60%");
    if (variant === "missing-alternative") item.fields.paymentTerms = String(item.fields.paymentTerms).replace(" либо истечения срока мотивированного отказа", "");
    if (variant === "reordered") item.fields.paymentTerms = `${final}\n${advance}`;
    if (variant === "multiple-cards") items = [item, { ...structuredClone(item), id: "other-card" }];
    if (variant === "duplicate-header") input.fragments!.push(paragraph(7, "Условия оплаты:"));
    if (variant === "duplicate-fragment") input.fragments!.push(structuredClone(input.fragments![2]));
    if (variant === "foreign") item.sourceIds = ["another-source"];
    if (variant === "deselected") item.selectedFields = [];
    if (variant === "incomplete") input.coverage = { complete: false, requiresOcr: false };
    const before = structuredClone({ input, items }), result = completeSourceTextFields(items, [input]);
    expect(result.items).toEqual(items); expect(result.changes).toEqual([]); expect({ input, items }).toEqual(before);
  });

  it("rolls back the whole card instead of partially adding proofs when the evidence budget is exceeded", () => {
    const input = source(), item = card();
    item.evidence = Array.from({ length: 499 }, (_, index) => ({ field: "internalNote", sourceId: input.id, quote: `Имеющаяся цитата ${index}` }));
    const result = completeSourceTextFields([item], [input]);
    expect(result.items).toEqual([item]); expect(result.changes).toEqual([]); expect(result.limited).toBe(true);
  });
});
