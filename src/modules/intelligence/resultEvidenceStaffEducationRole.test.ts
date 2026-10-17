import { describe, expect, it } from "vitest";
import { auditIntelligenceResult, getBlockingEvidenceFindings } from "./resultEvidence";
import type { IntelligenceFragment, IntelligenceItem, IntelligenceSource } from "./workbenchTypes";

const person = "Бетов Борис Борисович", other = "Гаммов Григорий Григорьевич";
const row = (number: number, text: string, extra: Partial<IntelligenceFragment> = {}): IntelligenceFragment => ({ id: `table-row-${number}`, locator: `Таблица, строка ${number}`, text, ...extra });
const paragraph = (number: number, text: string, extra: Partial<IntelligenceFragment> = {}): IntelligenceFragment => ({ id: `paragraph-${number}`, locator: `Абзац ${number}`, text, ...extra });
const source = (fragments: IntelligenceFragment[], id = "qa-source"): IntelligenceSource => ({ id, name: "Синтетические данные образования QA", text: "Не возвращать исключённые строки из агрегата", fragments });
const card = (education: string[], extra: Partial<IntelligenceItem> = {}): IntelligenceItem => ({ id: "qa-card", title: "Образование специалиста QA", destination: "staff", fields: { fullName: person, education }, selectedFields: ["fullName", "education"], sourceIds: ["qa-source"], evidence: [], ...extra });
const educationStatus = (item: IntelligenceItem, input: IntelligenceSource[]) => auditIntelligenceResult([item], input).fields.find((entry) => entry.field === "education");
const blocked = (item: IntelligenceItem, input: IntelligenceSource[]) => {
  const report = auditIntelligenceResult([item], input);
  expect(report.fields.find((entry) => entry.field === "education")?.status).not.toBe("confirmed");
  expect(getBlockingEvidenceFindings(report, item).some((entry) => entry.field === "education")).toBe(true);
  return report;
};

describe("staff education needs its own role and current person ownership", () => {
  it("does not label literal experience/project text as education", () => {
    const text = "6 лет в ИБ и разработке ПО. Анализ защищённости.", input = source([row(1, "ФИО\tРоль\tОпыт"), row(2, `${person}\tТимлид\t${text}`)]), item = card([text]), before = structuredClone({ input, item });
    blocked(item, [input]); expect({ input, item }).toEqual(before);
  });

  it("requires the matching education cell, not a different education column in the same row", () => {
    const input = source([row(1, "ФИО\tОбразование\tОпыт"), row(2, `${person}\tВысшее, МГУ\t6 лет в ИБ`)]);
    expect(educationStatus(card(["Высшее, МГУ"]), [input])?.status).toBe("confirmed");
    blocked(card(["6 лет в ИБ"]), [input]);
  });

  it.each(["МГУ, инженер", "СПбГУ, магистр", "НИУ ВШЭ, бакалавр"])("keeps explicitly owned education labels with abbreviated institutions: %s", (value) => {
    const input = source([paragraph(1, `ФИО: ${person}`), paragraph(2, `Образование: ${value}`)]);
    expect(educationStatus(card([value]), [input])?.status).toBe("confirmed");
    expect(getBlockingEvidenceFindings(auditIntelligenceResult([card([value])], [input]), card([value]))).toEqual([]);
  });

  it.each(["Диплом: МГУ, инженер, 2015", "Московский государственный университет, квалификация инженер"])("retains actual academic document/institution context within the person's row: %s", (value) => {
    const input = source([row(1, `${person}\t${value}`)]);
    expect(educationStatus(card([value]), [input])?.status).toBe("confirmed");
  });

  it.each(["Сертификат OSCP", "Курс повышения квалификации в университете", "Пройден семинар «Высшее образование»"])("does not infer academic education from a certificate/course or embedded words: %s", (value) => {
    blocked(card([value]), [source([row(1, `${person}\t${value}`)])]);
  });

  it("preserves literal course details when the source itself labels them education, without inventing a degree", () => {
    const value = "Курс повышения квалификации, 72 часа", input = source([row(1, `${person}\tОбразование: ${value}`)]);
    expect(educationStatus(card([value]), [input])?.status).toBe("confirmed");
    blocked(card(["Высшее"]), [input]);
  });

  it("rejects another person's diploma and unlabeled ownerless education with blocking review", () => {
    const value = "Высшее, МГУ", input = source([row(1, "ФИО\tОбразование"), row(2, `${other}\t${value}`)]);
    expect(educationStatus(card([value]), [input])?.status).toBe("conflict");
    expect(educationStatus(card([value]), [source([paragraph(1, `Образование: ${value}`)])])?.status).toBe("unverified");
    blocked(card([value]), [source([paragraph(1, `Образование: ${value}`)])]);
  });

  it.each(["hidden", "gap", "sheet", "foreign-source", "heading"])("does not inherit the person's education block through %s", (change) => {
    const value = "Высшее, МГУ", fragments = [paragraph(1, `ФИО: ${person}`), paragraph(2, `Образование: ${value}`)];
    if (change === "hidden") fragments[0].sheetState = "hidden";
    if (change === "gap") { fragments[1].id = "paragraph-4"; fragments[1].locator = "Абзац 4"; }
    if (change === "sheet") fragments[1].sheetId = "other";
    if (change === "heading") fragments.splice(1, 0, paragraph(2, "Новый раздел:"));
    const input = source(fragments, change === "foreign-source" ? "foreign" : "qa-source");
    blocked(card([value]), [input]);
  });

  it("does not inherit an education column through a hidden row or table boundary", () => {
    const value = "Высшее, МГУ";
    for (const middle of [row(2, `${other}\tНет данных`, { sheetState: "hidden" }), paragraph(2, "Иной раздел")]) {
      blocked(card([value]), [source([row(1, "ФИО\tОбразование"), middle, row(3, `${person}\t${value}`)])]);
    }
  });

  it("cannot turn an explicit person's requirement into an actual obtained education", () => {
    const value = "Требуется высшее техническое образование", input = source([row(1, `${person}\tОбразование: ${value}`)]);
    blocked(card([value]), [input]);
  });

  it("does not attribute an explicitly foreign education comment to the row employee", () => {
    const value = "Московский государственный университет, квалификация инженер";
    blocked(card([value]), [source([row(1, `${person}\tОбразование другого специалиста: ${value}`)])]);
  });

  it.each([
    `Диплом ${other}: МГУ, инженер, 2015`,
    `Образование: Диплом ${other}: МГУ, инженер, 2015`,
    `Диплом на имя ${other}: МГУ, инженер, 2015`,
    `Диплом: МГУ, инженер, 2015; владелец диплома: ${other}`,
  ])("does not let the first row person own an explicitly named foreign academic document: %s", (cell) => {
    const item = card(["МГУ, инженер, 2015"]), input = source([row(1, `${person}\t${cell}`)]);
    const report = blocked(item, [input]); expect(report.fields.find((entry) => entry.field === "education")?.status).toBe("conflict");
  });

  it.each([
    `Диплом ${person}: МГУ, инженер, 2015`,
    `Диплом: МГУ, инженер, 2015; владелец диплома: ${person}`,
    "Диплом: МГУ, инженер, 2015",
    "Диплом о высшем образовании: МГУ, инженер, 2015",
    "Диплом № 12345: МГУ, инженер, 2015",
  ])("keeps the row owner's genuine academic document: %s", (cell) => {
    const item = card(["МГУ, инженер, 2015"]), input = source([row(1, `${person}\t${cell}`)]);
    expect(educationStatus(item, [input])?.status).toBe("confirmed");
  });

  it.each(["Диплом сотрудника: МГУ, инженер, 2015", "Диплом Гаммов Г. Г.: МГУ, инженер, 2015", "Диплом: МГУ, инженер, 2015; владелец диплома: не указан"])("requires review for an unresolved explicit academic owner: %s", (cell) => {
    blocked(card(["МГУ, инженер, 2015"]), [source([row(1, `${person}\t${cell}`)])]);
  });

  it("invalidates review after changing the person/source and ignores education excluded from transfer", () => {
    const item = card(["6 лет в ИБ"]), input = source([row(1, `${person}\tОпыт: 6 лет в ИБ`)]), report = auditIntelligenceResult([item], [input]);
    const ack = getBlockingEvidenceFindings(report, item).map((entry) => entry.id); expect(ack.length).toBeGreaterThan(0);
    expect(getBlockingEvidenceFindings(report, item, ack)).toEqual([]);
    const changed = { ...item, fields: { ...item.fields, fullName: other } };
    expect(getBlockingEvidenceFindings(auditIntelligenceResult([changed], [input]), changed, ack).length).toBeGreaterThan(0);
    const moved = structuredClone(input); moved.fragments![0].text += " Новая версия.";
    expect(getBlockingEvidenceFindings(auditIntelligenceResult([item], [moved]), item, ack).length).toBeGreaterThan(0);
    item.selectedFields = ["fullName"]; expect(getBlockingEvidenceFindings(auditIntelligenceResult([item], [input]), item)).toEqual([]);
  });
});
