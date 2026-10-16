import { describe, expect, it } from "vitest";
import { auditIntelligenceResult, getBlockingEvidenceFindings } from "./resultEvidence";
import type { IntelligenceDestination, IntelligenceFieldValue, IntelligenceItem, IntelligenceSource } from "./workbenchTypes";

const source = (text: string, extra: Partial<IntelligenceSource> = {}): IntelligenceSource => ({ id: "temporal-qa", name: "Синтетические сроки QA", text, ...extra });
const item = (fields: Record<string, IntelligenceFieldValue>, destination: IntelligenceDestination = "procurement", extra: Partial<IntelligenceItem> = {}): IntelligenceItem => ({ id: "temporal-item", title: "Синтетическая карточка QA", destination, fields, sourceIds: ["temporal-qa"], selectedFields: Object.keys(fields), ...extra });
const field = (report: ReturnType<typeof auditIntelligenceResult>, key: string) => report.fields.find((entry) => entry.field === key);
const deadline = (report: ReturnType<typeof auditIntelligenceResult>) => report.coverage.find((entry) => entry.category === "deadline-time");
const submission = "Срок подачи заявок: 18.05.2034 11:20 MSK";

describe("event-local dates, times and timezones", () => {
  it.each(["\n", "; ", ". "])("N05 does not borrow another event's zone across %j", (separator) => {
    const card = item({ submissionDeadline: "2034-05-18", notes: `Подача: 2034-05-18 11:20 UTC${separator}Редакция: 10.05.2034 09:10 MSK` });
    const report = auditIntelligenceResult([card], [source(submission)]);
    expect(deadline(report)?.status).toBe("missing");
    expect(getBlockingEvidenceFindings(report, card).some((entry) => entry.code === "missing-deadline-time")).toBe(true);
  });
  it("does not borrow the correct time from a different event with the correct zone", () => {
    const report = auditIntelligenceResult([item({ submissionDeadline: "2034-05-18", notes: "Подача: 2034-05-18 12:45 MSK\nРедакция: 10.05.2034 11:20 MSK" })], [source(submission)]);
    expect(deadline(report)?.status).toBe("missing");
  });
  it("keeps an explicit wrong date attached to its otherwise matching submission time", () => {
    const report = auditIntelligenceResult([item({ submissionDeadline: "2034-05-18", notes: "Подача: 2034-05-19 11:20 MSK" })], [source(submission)]);
    expect(deadline(report)?.status).toBe("missing");
  });
  it("does not use a numeric timezone offset as a clock time", () => {
    const report = auditIntelligenceResult([item({ submissionDeadline: "2034-05-18", notes: "Подача: 2034-05-18, UTC+11:20" })], [source("Срок подачи заявок: 18.05.2034 11:20")]);
    expect(deadline(report)?.status).toBe("missing");
  });
  it.each(["Подача: 2034-05-18 11:20 MSK", "Подача до 11:20 МСК", "Время подачи 11:20 UTC+3"])("accepts one correctly bound submission record: %s", (notes) => {
    expect(deadline(auditIntelligenceResult([item({ submissionDeadline: "2034-05-18", notes })], [source(submission)]))?.status).toBe("covered");
  });
  it("N06 does not treat a publication-only timezone as a document-wide declaration", () => {
    const text = "Время публикации в настоящем документе указано в MSK.\nДата публикации: 10.05.2034 09:10.\nСрок подачи заявок: 18.05.2034 11:20.";
    const report = auditIntelligenceResult([item({ submissionDeadline: "2034-05-18", notes: "Подача 11:20" })], [source(text)]);
    expect(deadline(report)?.label).not.toContain("MSK");
    expect(deadline(report)?.supportingEvidence).toBeUndefined();
    expect(deadline(report)?.status).toBe("covered");
  });
  it.each(["Время в документе указано в МСК (UTC+3).", "Все даты и время в документе указаны в MSK (UTC+03:00).", "Всё время в документе указано в МСК (UTC+3)."])("N07 canonicalizes equivalent global zones: %s", (declaration) => {
    const report = auditIntelligenceResult([item({ submissionDeadline: "2034-05-18", notes: "Подача 11:20 UTC+3" })], [source(`${declaration}\nСрок подачи заявок: 18.05.2034 11:20`)]);
    expect(deadline(report)?.status).toBe("covered");
    expect(deadline(report)?.label).not.toContain("требует уточнения");
  });
  it("accepts a separate explicit global quote in notes, but not a publication-only quote", () => {
    const input = "Время в документе указано в MSK.\nСрок подачи заявок: 18.05.2034 11:20";
    const correct = auditIntelligenceResult([item({ submissionDeadline: "2034-05-18", notes: "Срок подачи заявок: 18.05.2034 11:20\nВремя в документе указано в MSK." })], [source(input)]);
    expect(deadline(correct)?.status).toBe("covered");
    const wrong = auditIntelligenceResult([item({ submissionDeadline: "2034-05-18", notes: "Срок подачи заявок: 18.05.2034 11:20\nВремя публикации в документе указано в MSK." })], [source(input)]);
    expect(deadline(wrong)?.status).toBe("missing");
  });
  it("keeps truly different global or inline zones uncertain instead of choosing one", () => {
    for (const input of ["Время в документе указано в MSK и UTC.\nСрок подачи заявок: 18.05.2034 11:20", "Срок подачи заявок: 18.05.2034 11:20 MSK (UTC)"]) {
      const report = auditIntelligenceResult([item({ submissionDeadline: "2034-05-18", notes: "Подача 11:20 MSK" })], [source(input)]);
      expect(deadline(report)?.status).toBe("uncertain");
      expect(getBlockingEvidenceFindings(report, "temporal-item").some((entry) => entry.code === "missing-deadline-time")).toBe(true);
    }
  });
  it.each(["не может быть осуществлена ранее", "осуществляется не ранее", "не ранее"])("N08 recognizes the lower permitted delivery bound without promising actual start: %s", (phrase) => {
    const text = `Поставка осуществляется не позднее 15.02.2035 года, при этом поставка ${phrase} 20.01.2035 года.`;
    const report = auditIntelligenceResult([item({ executionStartDate: "2035-01-20", executionEndDate: "2035-02-15" })], [source(text)]);
    expect(field(report, "executionStartDate")?.status).toBe("confirmed");
    expect(field(report, "executionEndDate")?.status).toBe("confirmed");
    expect(field(report, "executionStartDate")?.message).toMatch(/нижн|не ранее/u);
    expect(field(report, "executionStartDate")?.message).toMatch(/не.*(?:обещ|фактическ)/u);
  });
  it.each([
    "Подведение итогов: не ранее 20.01.2035 года. Поставка товара — в течение 30 дней после договора.",
    "Поставка товара — в течение 30 дней после договора. Подведение итогов: не ранее 20.01.2035 года.",
    "Подведение итогов: не ранее 20.01.2035 года; поставка товара — в течение 30 дней после договора.",
  ])("N09 does not relabel a results date using delivery in another clause: %s", (text) => {
    const card = item({ executionStartDate: "2035-01-20" }); const report = auditIntelligenceResult([card], [source(text)]);
    expect(field(report, "executionStartDate")?.status).toBe("conflict");
    expect(getBlockingEvidenceFindings(report, card).some((entry) => entry.field === "executionStartDate")).toBe(true);
  });
  it("does not make a delivery lower bound into a publication or results date", () => {
    const report = auditIntelligenceResult([item({ publishedDate: "2035-01-20", submissionDeadline: "2035-01-20" })], [source("Поставка не может быть осуществлена ранее 20.01.2035 года.")]);
    expect(field(report, "publishedDate")?.status).not.toBe("confirmed"); expect(field(report, "submissionDeadline")?.status).not.toBe("confirmed");
  });
});

describe("licensing morphology and proposal date labels", () => {
  it.each(["пункту", "пунктом", "пункте", "пункта", "пунктов"])("N10 does not read the ending of %s as a licensed activity letter", (form) => {
    const requirement = `Требуется лицензия ФСТЭК по ${form} 7 Положения.`;
    const report = auditIntelligenceResult([item({ licenses: [requirement] })], [source(requirement)]);
    expect(report.coverage.find((entry) => entry.category === "document")?.status).toBe("covered");
  });
  it("still requires actual lettered subclauses and business numbers", () => {
    const text = "Требуется лицензия ФСТЭК, по подпунктам «б», «е» пункта 7 Положения.";
    const report = auditIntelligenceResult([item({ licenses: ["Требуется лицензия ФСТЭК по пункту 7 Положения."] })], [source(text)]);
    expect(report.coverage.find((entry) => entry.category === "document")?.status).toBe("missing");
  });
  it("N11 confirms a generic date label under a genuine proposal heading", () => {
    const text = "КОММЕРЧЕСКОЕ ПРЕДЛОЖЕНИЕ\nДата: 04.06.2034\nУсловия оплаты: 100% предоплата.";
    const report = auditIntelligenceResult([item({ documentDate: "2034-06-04" }, "proposals")], [source(text)]);
    expect(field(report, "documentDate")?.status).toBe("confirmed");
  });
  it.each(["Дата редакции: 04.06.2034", "Действует до: 04.06.2034", "Дата поставки: 04.06.2034"])("does not replace another explicitly labelled event with the proposal date: %s", (label) => {
    const report = auditIntelligenceResult([item({ documentDate: "2034-06-04" }, "proposals")], [source(`КОММЕРЧЕСКОЕ ПРЕДЛОЖЕНИЕ\n${label}`)]);
    expect(field(report, "documentDate")?.status).not.toBe("confirmed");
  });
  it("does not borrow a proposal heading from another source or a hidden fragment", () => {
    const card = item({ documentDate: "2034-06-04" }, "proposals");
    const other = source("КОММЕРЧЕСКОЕ ПРЕДЛОЖЕНИЕ", { id: "other" });
    expect(field(auditIntelligenceResult([card], [source("Дата: 04.06.2034"), other]), "documentDate")?.status).not.toBe("confirmed");
    const hidden = source("", { fragments: [{ id: "old", locator: "История", text: "КОММЕРЧЕСКОЕ ПРЕДЛОЖЕНИЕ", sheetState: "hidden" }, { id: "date", locator: "Дата QA", text: "Дата: 04.06.2034" }] });
    expect(field(auditIntelligenceResult([card], [hidden]), "documentDate")?.status).not.toBe("confirmed");
  });
});
