import { describe, expect, it } from "vitest";
import { auditIntelligenceResult, getBlockingEvidenceFindings } from "./resultEvidence";
import { extractSourcePositionFacts } from "./sourcePositionFacts";
import type { IntelligenceItem, IntelligenceSource } from "./workbenchTypes";

const skuA = "QA100_SERVER_A001", skuB = "QA100_SERVER_B002";
const components = (count: number, prefix: string) => Array.from({ length: count }, (_, index) => `- ${prefix}: компонент ${index + 1} — 1 шт;`).join("\n");
const descriptionA = components(19, "Состав Альфа"), descriptionB = components(13, "Состав Бета");
const detachedText = `№ п/п Артикул Изготовитель\n1 ${skuA} Сервер шт 2\n2 ${skuB} Сервер шт 2\nУсловия оплаты: 100% предоплата\nСервер QA в составе:\n${descriptionA}\nСервер QA в составе:\n${descriptionB}`;
const source = (text = detachedText, id = "source-a"): IntelligenceSource => ({ id, name: `Синтетический ${id}.pdf`, text, fragments: [{ id: "page-1", locator: "Страница 1", text }] });
const item = (descriptions = [descriptionA, descriptionB], fields: Partial<IntelligenceItem["fields"]> = {}): IntelligenceItem => ({ id: "proposal-a", title: "Серверные комплектации QA", destination: "proposals", sourceIds: ["source-a"], selectedFields: ["lines", "lineDescriptions"], fields: { lines: [skuA, skuB], lineDescriptions: descriptions, ...fields } as IntelligenceItem["fields"] });
const mapping = (report: ReturnType<typeof auditIntelligenceResult>) => report.findings.filter((finding) => finding.code === "ambiguous-sku-configuration");

describe("SKU to configuration evidence boundary", () => {
  it.each([false, true])("blocks detached matching even with both exact SKUs and complete 19/13-line descriptions (swapped=%s)", (swapped) => {
    const card = item(swapped ? [descriptionB, descriptionA] : undefined), input = source();
    const facts = extractSourcePositionFacts([input]);
    expect(facts.positions).toHaveLength(2); expect(facts.configurations.map((entry) => entry.componentCount)).toEqual([19, 13]);
    const report = auditIntelligenceResult([card], [input]), findings = mapping(report);
    expect(report.fields.find((field) => field.field === "lines")?.status).toBe("confirmed");
    expect(report.fields.find((field) => field.field === "lineDescriptions")?.status).toBe("confirmed");
    expect(findings).toHaveLength(1); expect(findings[0]).toMatchObject({ severity: "blocking", itemId: card.id, field: "lines" });
    expect(getBlockingEvidenceFindings(report, card)).toContain(findings[0]);
    expect(findings[0].evidence.some((entry) => entry.quote.includes(skuA))).toBe(true);
    expect(findings[0].evidence.some((entry) => entry.quote.includes(descriptionA))).toBe(true);
    expect(findings[0].evidence.some((entry) => entry.quote.includes(descriptionB))).toBe(true);
    expect(findings[0].evidence.every((entry) => entry.sourceId === input.id && entry.fragmentId === "page-1" && input.text.includes(entry.quote))).toBe(true);
  });
  it.each(["empty", "excluded"] as const)("does not let %s descriptions bypass known detached source compositions", (kind) => {
    const card = item(["", ""]); if (kind === "excluded") card.selectedFields = ["lines"];
    const report = auditIntelligenceResult([card], [source()]);
    expect(mapping(report)).toHaveLength(1);
    const missing = report.findings.find((finding) => finding.code === "missing-sku-configuration" && finding.field === "lines");
    expect(missing?.severity).toBe("blocking");
    expect(getBlockingEvidenceFindings(report, card)).toContain(missing);
  });
  it("uses normal explicit ACKs and does not treat a manual mapping of fields as an acknowledgement", () => {
    const original = item(["", ""]), originalReport = auditIntelligenceResult([original], [source()]);
    const oldId = mapping(originalReport)[0].id;
    expect(mapping(auditIntelligenceResult([original], [source()]))[0].id).toBe(oldId);
    expect(getBlockingEvidenceFindings(originalReport, original, [oldId]).some((finding) => finding.code === "ambiguous-sku-configuration")).toBe(false);
    const manuallyMapped = item();
    const mappedReport = auditIntelligenceResult([manuallyMapped], [source()]);
    expect(mapping(mappedReport)[0].id).not.toBe(oldId);
    expect(getBlockingEvidenceFindings(mappedReport, manuallyMapped, [oldId]).some((finding) => finding.code === "ambiguous-sku-configuration")).toBe(true);
  });
  it("invalidates the mapping ACK when either selected fields or source material changes", () => {
    const card = item(), input = source(), originalId = mapping(auditIntelligenceResult([card], [input]))[0].id;
    const selection = { ...card, selectedFields: [...card.selectedFields, "notes"] };
    const selectionReport = auditIntelligenceResult([selection], [input]);
    expect(getBlockingEvidenceFindings(selectionReport, selection, [originalId]).some((finding) => finding.code === "ambiguous-sku-configuration")).toBe(true);
    const changed = source(detachedText.replace("Состав Альфа: компонент 19", "Состав Альфа: уточнённый компонент 19"));
    const sourceReport = auditIntelligenceResult([card], [changed]);
    expect(mapping(sourceReport)[0].id).not.toBe(originalId);
    expect(getBlockingEvidenceFindings(sourceReport, card, [originalId]).some((finding) => finding.code === "ambiguous-sku-configuration")).toBe(true);
  });
  it("does not add this blocker to explicit same-header pairs with their own complete descriptions", () => {
    const text = `Артикул: ${skuA}\nНаименование: Сервер Альфа\nСостав:\n${descriptionA}\nАртикул: ${skuB}\nНаименование: Сервер Бета\nСостав:\n${descriptionB}`;
    const report = auditIntelligenceResult([item()], [source(text)]);
    expect(mapping(report)).toEqual([]);
    expect(report.findings.filter((finding) => finding.code === "missing-sku-configuration")).toEqual([]);
  });
  it.each(["partial", "unmatched", "empty"] as const)("keeps a known same-header composition blocked for a %s description", (kind) => {
    const text = `Артикул: ${skuA}\nНаименование: Сервер Альфа\nСостав:\n${descriptionA}`;
    const description = kind === "partial" ? descriptionA.split("\n")[0] : kind === "unmatched" ? "Неизвестная модель" : "";
    const card = item([description], { lines: [skuA] });
    const report = auditIntelligenceResult([card], [source(text)]);
    expect(report.findings.some((finding) => finding.code === "missing-sku-configuration" && finding.severity === "blocking" && finding.field === "lines")).toBe(true);
    expect(getBlockingEvidenceFindings(report, card).some((finding) => finding.code === "missing-sku-configuration")).toBe(true);
  });
  it("accepts the complete literal configuration quote as a superset of all bound components", () => {
    const input = source(`Артикул: ${skuA}\nНаименование: Сервер Альфа\nСостав:\n${descriptionA}`);
    const fullQuote = extractSourcePositionFacts([input]).configurations[0].quote;
    const report = auditIntelligenceResult([item([fullQuote], { lines: [skuA] })], [input]);
    expect(mapping(report)).toEqual([]); expect(report.findings.some((finding) => finding.code === "missing-sku-configuration")).toBe(false);
  });
  it("does not accept the opposite explicit same-header composition for an SKU", () => {
    const text = `Артикул: ${skuA}\nНаименование: Сервер Альфа\nСостав:\n${descriptionA}\nАртикул: ${skuB}\nНаименование: Сервер Бета\nСостав:\n${descriptionB}`;
    expect(mapping(auditIntelligenceResult([item([descriptionB, descriptionA])], [source(text)]))).toHaveLength(1);
  });
  it("does not borrow duplicate-SKU ambiguity from another uncited, unrelated source", () => {
    const text = `Артикул: ${skuA}\nНаименование: Сервер Альфа\nСостав:\n${descriptionA}`;
    const card = item([descriptionA], { lines: [skuA] });
    const report = auditIntelligenceResult([card], [source(text), source(text, "unrelated")]);
    expect(mapping(report)).toEqual([]);
  });
  it("does not block a plain single SKU without any source composition", () => {
    const card = item(["Кабель USB"], { lines: ["CABLE_QA100"] });
    const report = auditIntelligenceResult([card], [source("Артикул: CABLE_QA100\nНаименование: Кабель USB")]);
    expect(mapping(report)).toEqual([]); expect(report.findings.some((finding) => finding.code === "missing-sku-configuration")).toBe(false);
  });
  it("does not confuse an unrelated longer SKU with an ambiguous SKU prefix", () => {
    const card = item(["Кабель USB"], { lines: [`${skuA}LONGER`] });
    expect(mapping(auditIntelligenceResult([card], [source()]))).toEqual([]);
  });
  it("does not require an unrelated plain SKU to use another explicitly bound SKU's composition", () => {
    const text = `Артикул: CABLE_QA100\nНаименование: Кабель USB\nАртикул: ${skuA}\nНаименование: Сервер Альфа\nСостав:\n${descriptionA}`;
    const card = item([""], { lines: ["CABLE_QA100"] });
    const report = auditIntelligenceResult([card], [source(text)]);
    expect(mapping(report)).toEqual([]); expect(report.findings.some((finding) => finding.code === "missing-sku-configuration" && finding.field === "lines")).toBe(false);
  });
  it("does not borrow an uncited source's configurations or restore an excluded fragment", () => {
    const card = item(["Кабель USB"], { lines: ["CABLE_QA100"] });
    expect(mapping(auditIntelligenceResult([card], [source("Артикул: CABLE_QA100\nНаименование: Кабель USB"), source(detachedText, "other")]))).toEqual([]);
    expect(mapping(auditIntelligenceResult([item()], [{ ...source(), fragments: [] }]))).toEqual([]);
    expect(mapping(auditIntelligenceResult([item()], [{ ...source(), fragments: [{ id: "hidden", locator: "Скрытый", text: detachedText, sheetState: "hidden" }] }]))).toEqual([]);
  });
});

describe("operational conditions kept only once in selected notes", () => {
  const procurement = (notes: string, selected = true): IntelligenceItem => ({ id: "procurement-a", title: "Поставка QA", destination: "procurement", fields: { notes }, selectedFields: selected ? ["notes"] : [], sourceIds: ["source-a"] });
  it.each(["Условия оплаты: постоплата через 14 рабочих дней после принятия УПД.", "Требуется поставка не более чем за 45 дней после уведомления.", "Гарантия: не менее 3 лет."])("accepts a full literal selected operational note without duplicating requirements: %s", (condition) => {
    const card = procurement(condition), report = auditIntelligenceResult([card], [source(condition)]);
    expect(report.coverage.filter((check) => check.category === "quantity")).not.toHaveLength(0);
    expect(report.coverage.filter((check) => check.category === "quantity").every((check) => check.status === "covered")).toBe(true);
    expect(report.findings.some((finding) => finding.code === "missing-quantity")).toBe(false);
  });
  it("does not accept a deselected note or an edited threshold as operational coverage", () => {
    const condition = "Условия оплаты: постоплата через 14 рабочих дней после принятия УПД.";
    for (const card of [procurement(condition, false), procurement(condition.replace("14", "7"))]) expect(auditIntelligenceResult([card], [source(condition)]).findings.some((finding) => finding.code === "missing-quantity")).toBe(true);
  });
  it.each(["Требуется сертификат OSCP — не менее 5 специалистов.", "Необходимо предоставить выписку из ЕГРЮЛ.", "Требуется количество серверов: 10 шт."])("does not use notes as a shortcut for a certificate, application document or plain quantity: %s", (condition) => {
    const report = auditIntelligenceResult([procurement(condition)], [source(condition)]);
    expect(report.coverage.some((check) => check.status === "missing")).toBe(true);
    expect(report.findings.some((finding) => /^missing-(?:certificate|document|quantity)$/u.test(finding.code))).toBe(true);
  });
});
