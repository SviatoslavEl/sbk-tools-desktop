import { describe, expect, it } from "vitest";
import { auditIntelligenceResult, getBlockingEvidenceFindings } from "./resultEvidence";
import { extractProposalIdentifierFacts } from "./proposalIdentifiers";
import type { IntelligenceItem, IntelligenceSource } from "./workbenchTypes";
const source = (text: string, extra: Partial<IntelligenceSource> = {}): IntelligenceSource => ({ id: "proposal-source", name: "Синтетический документ QA", text, ...extra });
const card = (number: string, extra: Partial<IntelligenceItem> = {}): IntelligenceItem => ({ id: "proposal-card", destination: "proposals", title: "Поставка оборудования QA", fields: { number }, selectedFields: ["number"], sourceIds: ["proposal-source"], evidence: [], ...extra });
const status = (item: IntelligenceItem, sources: IntelligenceSource[]) => auditIntelligenceResult([item], sources).fields.find((field) => field.field === "number")?.status;

describe("proposal numbers require the document-number role", () => {
  it.each([
    ["Коммерческое предложение № КП/26-А от 14.04.2026", "КП/26-А"], ["КП №QA-123", "QA-123"], ["Номер КП: ИТ/А", "ИТ/А"], ["Номер коммерческого предложения: ABC", "ABC"], ["КП № 7", "7"], ["Коммерческое предложение № б/н", "б/н"],
  ])("keeps literal valid proposal identifiers: %s", (text, number) => {
    const input = source(text), item = card(number, { evidence: [{ field: "number", sourceId: "proposal-source", quote: text }] });
    expect(status(item, [input])).toBe("confirmed"); expect(getBlockingEvidenceFindings(auditIntelligenceResult([item], [input]), item)).toEqual([]);
  });

  it.each(["Сервер АЛЬФА R120 G2", "QA_SKU-100_A", "123-ФЗ", "ДГ-234", "ДВ-987", "ПР-99"])("does not greenlight a literal model/SKU/law/other-document number: %s", (value) => {
    const input = source(`Сервер АЛЬФА R120 G2 в составе:\nАртикул: QA_SKU-100_A\nФедеральный закон № 123-ФЗ\nДоговор № ДГ-234\nДоверенность № ДВ-987\nПриложение № ПР-99`), item = card(value), before = structuredClone(item);
    expect(status(item, [input])).not.toBe("confirmed"); expect(getBlockingEvidenceFindings(auditIntelligenceResult([item], [input]), item).some((finding) => finding.field === "number")).toBe(true); expect(item).toEqual(before);
  });

  it.each(["В ответ на коммерческое предложение № QA-100", "Согласно КП № QA-100", "Ссылка на КП № QA-100", "Получено коммерческое предложение № QA-100", "1. Коммерческое предложение № QA-100", "КП № ______", "КП № UNKNOWN", "Договор на поставку оборудования № QA-100"])("does not borrow a referenced or empty identifier: %s", (text) => {
    expect(status(card("QA-100"), [source(text)])).not.toBe("confirmed");
  });

  it("accepts outgoing numbers only under the explicit bounded current proposal heading", () => {
    const input = source("", { fragments: [{ id: "paragraph-2", locator: "Абзац 2", text: "Коммерческое предложение" }, { id: "paragraph-8", locator: "Абзац 8", text: "Исх. № QA-100 от 14.04.2026" }] });
    expect(status(card("QA-100"), [input])).toBe("confirmed"); expect(extractProposalIdentifierFacts([input]).facts[0].supportingEvidence?.[0].quote).toBe("Коммерческое предложение");
    expect(status(card("QA-100"), [source("Исх. № QA-100 от 14.04.2026")])).toBe("conflict");
  });

  it.each(["hidden", "new-heading", "sheet", "table", "foreign-source", "dated-event"])("stops an outgoing proposal context at %s", (change) => {
    const parts = [{ id: "paragraph-1", locator: "Абзац 1", text: "Коммерческое предложение", sheetId: "1", sheetState: "visible" as "visible" | "hidden" }, { id: "paragraph-2", locator: "Абзац 2", text: "Исх. № QA-100 от 14.04.2026", sheetId: "1", sheetState: "visible" as "visible" | "hidden" }];
    if (change === "hidden") parts[0].sheetState = "hidden";
    if (change === "sheet") parts[1].sheetId = "2";
    if (change === "table") parts[1].id = "table-row-2";
    if (change === "new-heading" || change === "dated-event") parts.splice(1, 0, { ...parts[0], id: "paragraph-middle", text: change === "new-heading" ? "Договор поставки" : "Срок действия: 21.04.2026" });
    const sources = change === "foreign-source" ? [source("", { fragments: [parts[0]] }), source("", { id: "foreign", fragments: [parts[1]] })] : [source("", { fragments: parts })];
    expect(status(card("QA-100"), sources)).not.toBe("confirmed");
  });

  it("ignores removed aggregate, uncited sources and hidden opted-in histories", () => {
    expect(status(card("QA-100"), [source("КП № QA-100", { fragments: [] })])).not.toBe("confirmed");
    expect(status(card("QA-100", { sourceIds: ["old-source"] }), [source("КП № QA-100")])).not.toBe("confirmed");
    expect(status(card("QA-100"), [source("", { fragments: [{ id: "hidden", locator: "История", text: "КП № QA-100", sheetState: "hidden", includedByUser: true }] })])).not.toBe("confirmed");
  });
});
