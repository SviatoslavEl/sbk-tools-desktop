import { describe, expect, it } from "vitest";
import { auditIntelligenceResult, getBlockingEvidenceFindings } from "./resultEvidence";
import type { IntelligenceFragment, IntelligenceItem, IntelligenceSource } from "./workbenchTypes";

const advance = "Аванс — 50% в течение 5 календарных дней с даты подписания договора;";
const final = "Окончательный расчёт — 50% в течение 5 календарных дней с даты подписания акта либо истечения срока мотивированного отказа.";
const paragraph = (number: number, text: string, extra: Partial<IntelligenceFragment> = {}): IntelligenceFragment => ({ id: `paragraph-${number}`, locator: `Абзац ${number}`, text, ...extra });
const source = (fragments = [paragraph(1, "Условия оплаты:"), paragraph(2, advance), paragraph(3, final)], extra: Partial<IntelligenceSource> = {}): IntelligenceSource => ({ id: "source-a", name: "Синтетические условия QA", text: "Агрегат не восстанавливает исключённые фрагменты.", fragments, ...extra });
const card = (paymentTerms = `${advance}\n${final}`, extra: Partial<IntelligenceItem> = {}): IntelligenceItem => ({
  id: "proposal-a", title: "Технический аудит QA", destination: "proposals", fields: { paymentTerms }, selectedFields: ["paymentTerms"], sourceIds: ["source-a"],
  evidence: [{ field: "paymentTerms", sourceId: "source-a", fragmentId: "paragraph-2", quote: advance }, { field: "paymentTerms", sourceId: "source-a", fragmentId: "paragraph-3", quote: final }], ...extra,
});
const status = (report: ReturnType<typeof auditIntelligenceResult>) => report.fields.find((field) => field.field === "paymentTerms");
const blocked = (item: IntelligenceItem, sources: IntelligenceSource[]) => {
  const report = auditIntelligenceResult([item], sources);
  expect(status(report)?.status).not.toBe("confirmed");
  expect(getBlockingEvidenceFindings(report, item).length).toBeGreaterThan(0);
  return report;
};

describe("bounded collective literal evidence for proposal payment terms", () => {
  it("confirms two full ordered clauses with two original quotes, not a fabricated joined quote", () => {
    const item = card(), input = source(), before = structuredClone({ item, input });
    const report = auditIntelligenceResult([item], [input]);
    expect(status(report)?.status).toBe("confirmed");
    expect(status(report)?.evidence).toEqual([
      { sourceId: input.id, sourceName: input.name, fragmentId: "paragraph-2", locator: "Абзац 2", quote: advance },
      { sourceId: input.id, sourceName: input.name, fragmentId: "paragraph-3", locator: "Абзац 3", quote: final },
    ]);
    expect(getBlockingEvidenceFindings(report, item)).toEqual([]);
    expect(status(report)?.message).toContain("не заключение о применимости, полноте");
    expect({ item, input }).toEqual(before);
  });

  it("permits only whitespace presentation differences in the complete field and quotes", () => {
    const item = card(`  ${advance}\n\n${final.replace(/ /gu, "\t")}  `);
    item.evidence![0].quote = advance.replace(/ /gu, "\n");
    const report = auditIntelligenceResult([item], [source()]);
    expect(status(report)?.status).toBe("confirmed"); expect(getBlockingEvidenceFindings(report, item)).toEqual([]);
  });

  it.each([
    `${advance.replace("5 календарных", "6 календарных")}\n${final}`,
    `${advance}\n${final.replace("50%", "40%")}`,
    `${advance}\n${final.replace(" либо истечения срока мотивированного отказа", "")}`,
    `${final}\n${advance}`,
    `${advance}\n${final}\nЛюбые дополнительные условия допустимы.`,
  ])("does not authorize modified, shortened, reordered or appended values: %s", (value) => {
    blocked(card(value), [source()]);
  });

  it("keeps the independent missing-final-clause block even when the extra quote is real", () => {
    const item = card(advance), report = auditIntelligenceResult([item], [source()]);
    expect(getBlockingEvidenceFindings(report, item).some((finding) => finding.code === "missing-payment-clause" && finding.field === undefined)).toBe(true);
    expect(report.findings.some((finding) => finding.code === "evidence-does-not-support-value")).toBe(true);
  });

  it.each([false, true])("does not carry a payment heading across hidden history, opt-in=%s", (includedByUser) => {
    const item = card(); item.evidence![1].fragmentId = "paragraph-4";
    blocked(item, [source([paragraph(1, "Условия оплаты:"), paragraph(2, advance), paragraph(3, "История", { sheetState: "hidden", includedByUser }), paragraph(4, final)])]);
  });

  it("does not bridge omitted paragraph numbers even when the selected array is compacted", () => {
    const item = card(); item.evidence![1].fragmentId = "paragraph-4";
    blocked(item, [source([paragraph(1, "Условия оплаты:"), paragraph(2, advance), paragraph(4, final)])]);
  });

  it("does not bridge an empty source fragment", () => {
    const item = card(); item.evidence![1].fragmentId = "paragraph-4";
    blocked(item, [source([paragraph(1, "Условия оплаты:"), paragraph(2, advance), paragraph(3, ""), paragraph(4, final)])]);
  });

  it("closes a complete payment section at an explicit next heading despite a later paragraph-number gap", () => {
    const input = source([paragraph(35, "Условия оплаты:"), paragraph(36, advance), paragraph(37, final), paragraph(39, "Оговорки:")]);
    const item = card(); item.evidence![0].fragmentId = "paragraph-36"; item.evidence![1].fragmentId = "paragraph-37";
    const before = structuredClone({ input, item }), report = auditIntelligenceResult([item], [input]);
    expect(status(report)?.status).toBe("confirmed");
    expect(status(report)?.evidence).toEqual([
      { sourceId: input.id, sourceName: input.name, fragmentId: "paragraph-36", locator: "Абзац 36", quote: advance },
      { sourceId: input.id, sourceName: input.name, fragmentId: "paragraph-37", locator: "Абзац 37", quote: final },
    ]);
    expect(getBlockingEvidenceFindings(report, item)).toEqual([]); expect({ input, item }).toEqual(before);
  });

  it("still rejects a paragraph-number gap between payment clauses even when the next heading is explicit", () => {
    const item = card(); item.evidence![0].fragmentId = "paragraph-36"; item.evidence![1].fragmentId = "paragraph-38";
    blocked(item, [source([paragraph(35, "Условия оплаты:"), paragraph(36, advance), paragraph(38, final), paragraph(39, "Оговорки:")])]);
  });

  it.each([false, true])("does not close through a selected or excluded hidden fragment after the clauses, opt-in=%s", (includedByUser) => {
    const item = card(); item.evidence![0].fragmentId = "paragraph-36"; item.evidence![1].fragmentId = "paragraph-37";
    blocked(item, [source([paragraph(35, "Условия оплаты:"), paragraph(36, advance), paragraph(37, final), paragraph(38, "История", { sheetState: "hidden", includedByUser }), paragraph(39, "Оговорки:")])]);
  });

  it("does not close through an empty source fragment after the clauses", () => {
    const item = card(); item.evidence![0].fragmentId = "paragraph-36"; item.evidence![1].fragmentId = "paragraph-37";
    blocked(item, [source([paragraph(35, "Условия оплаты:"), paragraph(36, advance), paragraph(37, final), paragraph(38, ""), paragraph(39, "Оговорки:")])]);
  });

  it("does not close a paragraph-number gap using a heading on another sheet", () => {
    const item = card(); item.evidence![0].fragmentId = "paragraph-36"; item.evidence![1].fragmentId = "paragraph-37";
    blocked(item, [source([paragraph(35, "Условия оплаты:"), paragraph(36, advance), paragraph(37, final), paragraph(39, "Оговорки:", { sheetId: "different" })])]);
  });

  it.each(["Оговорки: действуют дополнительные условия.", "Прочие условия:", "Иные пояснения."])("does not use an uncertain following fragment to close a paragraph-number gap: %s", (following) => {
    const item = card(); item.evidence![0].fragmentId = "paragraph-36"; item.evidence![1].fragmentId = "paragraph-37";
    blocked(item, [source([paragraph(35, "Условия оплаты:"), paragraph(36, advance), paragraph(37, final), paragraph(39, following)])]);
  });

  it.each([
    paragraph(3, "Условия поставки:"),
    paragraph(3, "Иные обязательства сторон."),
    paragraph(3, "Цена\tСумма", { id: "table-row-1", locator: "Таблица, строка 1" }),
    paragraph(3, "Промежуточный текст", { sheetId: "another-sheet" }),
  ])("does not join across another section, unrelated text, table or sheet: %j", (middle) => {
    const item = card(); item.evidence![1].fragmentId = "paragraph-4";
    blocked(item, [source([paragraph(1, "Условия оплаты:"), paragraph(2, advance), middle, paragraph(4, final)])]);
  });

  it("does not join two sources even when both sources and individual quotes are selected", () => {
    const item = card(undefined, { sourceIds: ["source-a", "source-b"] }); item.evidence![1].sourceId = "source-b";
    blocked(item, [source([paragraph(1, "Условия оплаты:"), paragraph(2, advance)]), source([paragraph(3, final)], { id: "source-b" })]);
  });

  it.each(["Порядок расчёта цены:", "Оплата", ""])("does not infer a payment section from a filename or a different heading: %s", (heading) => {
    blocked(card(), [source([paragraph(1, heading), paragraph(2, advance), paragraph(3, final)], { name: "Условия оплаты.docx" })]);
  });

  it("accepts separate real line quotes within one explicitly headed fragment", () => {
    const input = source([{ id: "payment", locator: "Абзац 1", text: `Условия оплаты:\n${advance}\n${final}` }]);
    const item = card(); item.evidence = item.evidence!.map((claim) => ({ ...claim, fragmentId: "payment" }));
    const report = auditIntelligenceResult([item], [input]);
    expect(status(report)?.status).toBe("confirmed"); expect(status(report)?.evidence.map((entry) => entry.quote)).toEqual([advance, final]);
    expect(getBlockingEvidenceFindings(report, item)).toEqual([]);
  });

  it("does not choose between duplicate source IDs", () => {
    blocked(card(), [source(), source()]);
  });

  it("does not confirm an over-budget collective section by accepting its prefix", () => {
    const clauses = Array.from({ length: 201 }, (_, index) => `Платёж ${index + 1} — 1% в течение 5 дней после подписания акта.`);
    const input = source([paragraph(1, "Условия оплаты:"), ...clauses.map((text, index) => paragraph(index + 2, text))]);
    const item = card(clauses.join("\n")); item.evidence = clauses.map((quote, index) => ({ field: "paymentTerms", sourceId: input.id, fragmentId: `paragraph-${index + 2}`, quote }));
    blocked(item, [input]);
  });

  it.each(["foreign", "missing-quote", "stale", "reordered", "missing-fragment"])("requires all original claims to resolve in order to their current fragments: %s", (variant) => {
    const item = card();
    if (variant === "foreign") item.evidence![1].sourceId = "foreign";
    if (variant === "missing-quote") item.evidence!.pop();
    if (variant === "stale") item.evidence![1].quote = final.replace("5 календарных", "9 календарных");
    if (variant === "reordered") item.evidence!.reverse();
    if (variant === "missing-fragment") delete item.evidence![1].fragmentId;
    blocked(item, [source(), source([paragraph(3, final)], { id: "foreign" })]);
  });

  it("does not reconstruct payment text from an authoritative empty selection or an uncited source", () => {
    blocked(card(), [source([], { text: `Условия оплаты:\n${advance}\n${final}` }), source(undefined, { id: "foreign" })]);
  });

  it("does not apply the collective exception to another field or destination", () => {
    const item = card(), another = { ...item, fields: { deliveryTerms: item.fields.paymentTerms }, selectedFields: ["deliveryTerms"], evidence: item.evidence!.map((claim) => ({ ...claim, field: "deliveryTerms" })) };
    const report = auditIntelligenceResult([another], [source()]);
    expect(report.fields.find((field) => field.field === "deliveryTerms")?.status).not.toBe("confirmed");
    expect(getBlockingEvidenceFindings(report, another).length).toBeGreaterThan(0);
    blocked(card(undefined, { destination: "procurement" }), [source()]);
  });

  it("does not excuse an unrelated additional quote after the full payment has been supported", () => {
    const item = card(); item.evidence!.push({ field: "paymentTerms", sourceId: "source-a", fragmentId: "paragraph-4", quote: "Порядок поставки согласуется отдельно." });
    const report = auditIntelligenceResult([item], [source([paragraph(1, "Условия оплаты:"), paragraph(2, advance), paragraph(3, final), paragraph(4, "Порядок поставки согласуется отдельно.")])]);
    expect(status(report)?.status).toBe("confirmed");
    expect(getBlockingEvidenceFindings(report, item).some((finding) => finding.code === "evidence-does-not-support-value")).toBe(true);
  });

  it("invalidates old review acknowledgements after a payment value or source quote changes", () => {
    const item = card(`${advance.replace("5 календарных", "6 календарных")}\n${final}`), original = auditIntelligenceResult([item], [source()]);
    const acknowledged = getBlockingEvidenceFindings(original, item).map((finding) => finding.id);
    expect(getBlockingEvidenceFindings(original, item, acknowledged)).toEqual([]);
    const changed = { ...item, fields: { paymentTerms: `${advance.replace("5 календарных", "7 календарных")}\n${final}` } };
    expect(getBlockingEvidenceFindings(auditIntelligenceResult([changed], [source()]), changed, acknowledged).length).toBeGreaterThan(0);
    const changedSource = source([paragraph(1, "Условия оплаты:"), paragraph(2, advance.replace("5 календарных", "8 календарных")), paragraph(3, final)]);
    expect(getBlockingEvidenceFindings(auditIntelligenceResult([item], [changedSource]), item, acknowledged).length).toBeGreaterThan(0);
  });
});
