import { describe, expect, it } from "vitest";
import { auditIntelligenceResult, extractIntelligenceDateFacts } from "./resultEvidence";
import { buildGroundedIntelligenceSchema } from "./sourceGrounding";
import { repairDateFromSource } from "./sourceRepairs";
import type { IntelligenceFragment, IntelligenceItem, IntelligenceSource } from "./workbenchTypes";

const outgoing = "Исх. № _____ от «14» апреля 2026";
const paragraph = (number: number, text: string, extra: Partial<IntelligenceFragment> = {}): IntelligenceFragment => ({ id: `paragraph-${number}`, locator: `Абзац ${number}`, text, ...extra });
const source = (fragments: IntelligenceFragment[], extra: Partial<IntelligenceSource> = {}): IntelligenceSource => ({ id: "source-a", name: "Синтетическое письмо QA", text: "Агрегат не восстанавливает исключённые строки", fragments, ...extra });
const proposal = (fields: IntelligenceItem["fields"] = {}): IntelligenceItem => ({ id: "proposal-a", title: "Аудит процессов QA", destination: "proposals", fields, selectedFields: Object.keys(fields), sourceIds: ["source-a"] });
const sample = () => source([paragraph(1, "ООО «Альфа QA»"), paragraph(2, "Коммерческое предложение"), paragraph(3, "Аудит процессов и подготовка рекомендаций"), paragraph(4, "Город QA | 2026"), paragraph(8, outgoing)]);
const dates = (input: IntelligenceSource) => extractIntelligenceDateFacts([input]).facts.filter((fact) => fact.event === "proposal-date");

describe("full Russian calendar dates and bounded outgoing proposal context", () => {
  it("retains the literal day/month/year and explicit heading across adjacent selected paragraphs", () => {
    const input = sample(), before = structuredClone(input), result = dates(input);
    expect(result).toHaveLength(1); expect(result[0]).toMatchObject({ iso: "2026-04-14", event: "proposal-date", fragmentId: "paragraph-8", locator: "Абзац 8", quote: outgoing, supportingEvidence: [{ fragmentId: "paragraph-2", quote: "Коммерческое предложение" }] });
    expect(input).toEqual(before);
  });

  it("uses the same date for canonical evidence, schema candidates and explicit repair without autoapplying", () => {
    const input = sample(), item = proposal({ documentDate: "2026-04-14" }); item.evidence = [{ field: "documentDate", sourceId: input.id, fragmentId: "paragraph-8", quote: outgoing }];
    const report = auditIntelligenceResult([item], [input]); expect(report.fields.find((entry) => entry.field === "documentDate")?.status).toBe("confirmed");
    expect(report.findings.some((entry) => /^(?:invalid-evidence-quote|evidence-does-not-support-value|missing-proposal-date)$/u.test(entry.code))).toBe(false);
    const empty = proposal(), before = structuredClone(empty), fact = dates(input)[0];
    expect(JSON.stringify(buildGroundedIntelligenceSchema([input], ["proposals"]).schema)).toContain('"2026-04-14"');
    const patch = repairDateFromSource(empty, fact, [input]); expect(empty).toEqual(before); expect(patch.fields.documentDate).toBe("2026-04-14");
    expect(patch.evidence?.find((entry) => entry.field === "documentDate")?.quote).toBe(outgoing);
  });

  it.each([
    ["января", "01"], ["февраля", "02"], ["марта", "03"], ["апреля", "04"], ["мая", "05"], ["июня", "06"],
    ["июля", "07"], ["августа", "08"], ["сентября", "09"], ["октября", "10"], ["ноября", "11"], ["декабря", "12"],
  ])("canonicalizes the full genitive month %s only with day and year", (month, number) => {
    const literal = `Дата КП: 7 ${month} 2028 года.`;
    expect(extractIntelligenceDateFacts([source([paragraph(1, literal)])]).facts).toMatchObject([{ iso: `2028-${number}-07`, event: "proposal-date", quote: literal }]);
  });

  it.each(["Исх. № ___ от апреля 2026", "Исх. № ___ от «31» апреля 2026", "Исх. № ___ от «29» февраля 2026", "Исх. № ___ от «14» апрель 2026", "Исх. № ___ от 14–20 апреля 2026", "Исх. № ___ от апрель 2026"])("does not guess an incomplete, impossible or period date: %s", (text) => {
    expect(dates(source([paragraph(1, "Коммерческое предложение"), paragraph(2, text)]))).toEqual([]);
  });

  it.each(["Дата КП: 14–20 апреля 2026", "Дата КП: 14 – 20 апреля 2026"])("does not turn the end of a Russian day range into a unique date: %s", (text) => {
    const input = source([paragraph(1, text)]), item = proposal({ documentDate: "2026-04-20" });
    item.evidence = [{ field: "documentDate", sourceId: input.id, fragmentId: "paragraph-1", quote: text }];
    expect(dates(input)).toEqual([]);
    const report = auditIntelligenceResult([item], [input]);
    expect(report.fields.find((entry) => entry.field === "documentDate")?.status).not.toBe("confirmed");
    expect(report.findings.some((entry) => entry.code === "evidence-does-not-support-value")).toBe(true);
  });

  it.each(["Запрос информации", "Договор оказания услуг", "Ссылка на коммерческое предложение"])("does not use an ordinary %s heading or filename as CP proof", (heading) => {
    expect(dates(source([paragraph(1, heading), paragraph(2, outgoing)], { name: "Коммерческое предложение.docx" }))).toEqual([]);
  });

  it.each(["Ссылка на Исх. № 1 от «14» апреля 2026", "Ссылка на коммерческое предложение от «14» апреля 2026"])("does not reclassify a document reference as this proposal's date: %s", (text) => {
    expect(dates(source([paragraph(1, "Коммерческое предложение"), paragraph(2, text)]))).toEqual([]);
  });

  it.each(["Договор оказания услуг", "Условия оплаты:", "Раздел 2. Документы", "Дата редакции: 13.04.2026"])("retires the CP heading at a new document, section or dated event: %s", (text) => {
    expect(dates(source([paragraph(1, "Коммерческое предложение"), paragraph(2, text), paragraph(3, outgoing)]))).toEqual([]);
  });

  it.each([false, true])("does not inherit through a hidden paragraph; opted-in=%s", (includedByUser) => {
    expect(dates(source([paragraph(1, "Коммерческое предложение"), paragraph(2, "История", { sheetState: "hidden", includedByUser }), paragraph(3, outgoing)]))).toEqual([]);
    expect(dates(source([paragraph(1, "Коммерческое предложение", { sheetState: "hidden", includedByUser }), paragraph(2, outgoing)]))).toEqual([]);
  });

  it("does not inherit across a table, unrelated fragment, sheet or foreign source", () => {
    for (const middle of [{ id: "table-row-1", locator: "Таблица, строка 1", text: "Показатель\tЗначение" }, { id: "page-1", locator: "Страница 1", text: "Другая область" }, paragraph(2, "Промежуточный текст", { sheetId: "different" })]) {
      expect(dates(source([paragraph(1, "Коммерческое предложение"), middle, paragraph(3, outgoing)]))).toEqual([]);
    }
    const input = source([paragraph(1, outgoing)]), foreign = source([paragraph(1, "Коммерческое предложение")], { id: "other" });
    expect(extractIntelligenceDateFacts([input, foreign]).facts.filter((fact) => fact.event === "proposal-date")).toEqual([]);
  });

  it("never restores a heading from aggregate text and honours the bounded context", () => {
    expect(dates(source([paragraph(2, outgoing)], { text: `Коммерческое предложение\n${outgoing}` }))).toEqual([]);
    const many = [paragraph(1, "Коммерческое предложение"), ...Array.from({ length: 7 }, (_, index) => paragraph(index + 2, "Промежуточный текст")), paragraph(9, outgoing)];
    expect(dates(source(many))).toEqual([]);
    expect(dates(source([paragraph(1, "Коммерческое предложение"), paragraph(2, "я".repeat(1001)), paragraph(3, outgoing)]))).toEqual([]);
  });
});
