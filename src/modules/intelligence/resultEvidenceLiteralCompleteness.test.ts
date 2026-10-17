import { describe, expect, it } from "vitest";
import { auditIntelligenceResult, getBlockingEvidenceFindings } from "./resultEvidence";
import type { IntelligenceItem, IntelligenceSource } from "./workbenchTypes";

const source = (text: string, extra: Partial<IntelligenceSource> = {}): IntelligenceSource => ({ id: "source-a", name: "Синтетическое КП и опыт QA", text, ...extra });
const proposal = (fields: IntelligenceItem["fields"] = {}): IntelligenceItem => ({ id: "item-a", title: "Технический аудит QA", destination: "proposals", fields, selectedFields: Object.keys(fields), sourceIds: ["source-a"] });
const text = "Коммерческое предложение\nДата: 14.04.2027\nУсловия оплаты:\nАванс — 50% в течение 5 календарных дней после подписания договора.\nОкончательный расчёт — 50% в течение 5 календарных дней после приёмки.\nСрок действия предложения: 30 дней.";
const completeness = (report: ReturnType<typeof auditIntelligenceResult>) => report.findings.filter((entry) => /^(?:missing-proposal-date|missing-payment-clause|missing-contract-card|literal-completeness-limit)$/u.test(entry.code));

describe("literal completeness is integrated into the review gate", () => {
  it("blocks omitted date/final payment even if their fields are absent or excluded", () => {
    const item = proposal({ paymentTerms: "Аванс — 50% в течение 5 календарных дней после подписания договора." }), report = auditIntelligenceResult([item], [source(text)]);
    expect(completeness(report).map((entry) => entry.code)).toEqual(expect.arrayContaining(["missing-proposal-date", "missing-payment-clause"]));
    for (const issue of completeness(report)) { expect(issue.field).toBeUndefined(); expect(getBlockingEvidenceFindings(report, item)).toContainEqual(issue); }
  });

  it("uses normal ACK fingerprints without auto-filling the cards", () => {
    const item = proposal(), input = source(text), before = structuredClone({ item, input }), report = auditIntelligenceResult([item], [input]), issues = completeness(report);
    expect(issues.length).toBeGreaterThan(0); expect({ item, input }).toEqual(before);
    expect(getBlockingEvidenceFindings(report, item, issues.map((entry) => entry.id)).some((entry) => issues.some((issue) => issue.code === entry.code))).toBe(false);
    const next = auditIntelligenceResult([item], [source(`${text}\nДополнительная оговорка.`)]);
    expect(getBlockingEvidenceFindings(next, item, issues.map((entry) => entry.id)).some((entry) => issues.some((issue) => issue.code === entry.code))).toBe(true);
  });

  it("keeps exact complete date/payment and unrelated destinations on the positive path", () => {
    const item = proposal({ documentDate: "2027-04-14", paymentTerms: text.split("\n").slice(3, 5).join("\n") });
    expect(completeness(auditIntelligenceResult([item], [source(text)]))).toEqual([]);
    expect(completeness(auditIntelligenceResult([{ ...item, destination: "staff" }], [source(text)]))).toEqual([]);
    expect(completeness(auditIntelligenceResult([{ ...item, sourceIds: ["unrelated"] }], [source(text)]))).toEqual([]);
  });

  it("requires a decision for an unrepresented explicit contract row, without creating another card", () => {
    const fragments = ["№ п/п\tПредмет договора\tЗаказчик\tСумма договора", "1\tДоговор № QA-A от 10.01.2027, аудит\tООО Альфа\t100000 руб.", "2\tДоговор № QA-B от 11.02.2027, анализ\tООО Бета\t200000 руб."].map((text, index) => ({ id: `table-row-${index + 1}`, locator: `Таблица, строка ${index + 1}`, text }));
    const item: IntelligenceItem = { ...proposal({ number: "QA-A" }), destination: "contracts" }, items = [item], report = auditIntelligenceResult(items, [source("", { fragments })]);
    expect(completeness(report).some((entry) => entry.code === "missing-contract-card")).toBe(true);
    expect(getBlockingEvidenceFindings(report, item).some((entry) => entry.code === "missing-contract-card")).toBe(true); expect(items).toEqual([item]);
  });
});
