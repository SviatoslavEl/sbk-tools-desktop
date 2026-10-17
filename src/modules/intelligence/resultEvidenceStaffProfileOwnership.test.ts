import { describe, expect, it } from "vitest";
import { auditIntelligenceResult, getBlockingEvidenceFindings } from "./resultEvidence";
import type { IntelligenceFragment, IntelligenceItem, IntelligenceSource } from "./workbenchTypes";

const manager = "Альфов Алексей Андреевич", person = "Бетов Борис Борисович", other = "Гаммов Григорий Григорьевич";
const phone = "+7 (900) 100 0011, доб. 1234; +7 (900) 100 0022", email = "manager.qa@example.test";
const ownPhone = "+7 (900) 200 0033", ownEmail = "person.qa@example.test";
const paragraph = (number: number, text: string, extra: Partial<IntelligenceFragment> = {}): IntelligenceFragment => ({ id: `paragraph-${number}`, locator: `Абзац ${number}`, text, ...extra });
const row = (number: number, text: string, extra: Partial<IntelligenceFragment> = {}): IntelligenceFragment => ({ id: `table-row-${number}`, locator: `Таблица, строка ${number}`, text, ...extra });
const source = (fragments: IntelligenceFragment[], extra: Partial<IntelligenceSource> = {}): IntelligenceSource => ({ id: "staff-source", name: "Синтетические сведения команды QA", text: "Не восстанавливать исключённые фрагменты из агрегата", fragments, ...extra });
const card = (fields: IntelligenceItem["fields"], extra: Partial<IntelligenceItem> = {}): IntelligenceItem => ({ id: "staff-card", destination: "staff", title: "Специалист QA", fields: { fullName: person, ...fields }, selectedFields: ["fullName", ...Object.keys(fields)], sourceIds: ["staff-source"], evidence: [], ...extra });
const field = (report: ReturnType<typeof auditIntelligenceResult>, name: string) => report.fields.find((entry) => entry.field === name);
const blocked = (item: IntelligenceItem, input: IntelligenceSource, name: string) => {
  const report = auditIntelligenceResult([item], [input]);
  expect(field(report, name)?.status).not.toBe("confirmed");
  expect(getBlockingEvidenceFindings(report, item).some((finding) => finding.field === name)).toBe(true);
  return report;
};
const team = () => source([
  paragraph(1, "1. Контакт менеджера команды"), row(1, `ФИО\t${manager}`), row(2, "Должность\tМенеджер проекта"), row(3, `Телефон\t${phone}`), row(4, `Email\t${email}`),
  paragraph(2, "2. Лицензионная база партнёра"), row(5, "Лицензия\tФСТЭК"),
  paragraph(3, "3. Проектная команда"), row(10, "ФИО\tРоль\tВ штате\tОпыт"),
  row(11, `${other}\tТехнический директор\tДа\tБолее 25 лет в ИБ. Более 300 проектов за 5 лет.`),
  row(12, `${person}\tТимлид\tДа\t6 лет в ИБ и разработке ПО. Анализ защищённости.`),
]);

describe("D4-R02 staff experience and contact ownership without certificate/basis dependencies", () => {
  it("blocks every borrowed field while keeping the actual name and untouched inputs", () => {
    const item = card({ experienceYears: 25, experienceNotes: "Более 300 проектов за 5 лет", phone, email }), input = team(), before = structuredClone({ item, input });
    const report = auditIntelligenceResult([item], [input]);
    expect(field(report, "fullName")?.status).toBe("confirmed");
    for (const name of ["experienceYears", "experienceNotes", "phone", "email"]) {
      expect(field(report, name)?.status).not.toBe("confirmed");
      expect(getBlockingEvidenceFindings(report, item).some((finding) => finding.field === name)).toBe(true);
    }
    expect(item.fields.certificates).toBeUndefined(); expect(item.fields.basis).toBeUndefined(); expect(item.evidence).toEqual([]);
    expect({ item, input }).toEqual(before);
  });

  it.each<IntelligenceItem["fields"]>([{ experienceYears: 25 }, { experienceNotes: "Более 300 проектов за 5 лет" }, { phone }, { email }])("guards an isolated borrowed field: %j", (fields) => {
    blocked(card(fields), team(), Object.keys(fields)[0]);
  });

  it("confirms the selected person's literal six years and own description", () => {
    const item = card({ experienceYears: 6, experienceNotes: "6 лет в ИБ и разработке ПО." }), report = auditIntelligenceResult([item], [team()]);
    for (const name of ["experienceYears", "experienceNotes"]) { expect(field(report, name)?.status).toBe("confirmed"); expect(getBlockingEvidenceFindings(report, item).some((finding) => finding.field === name)).toBe(false); }
  });

  it("confirms own contacts in an explicit person table row", () => {
    const item = card({ phone: ownPhone, email: ownEmail }), input = source([row(1, `${person}\t6 лет опыта\t${ownPhone}\t${ownEmail}`)]), report = auditIntelligenceResult([item], [input]);
    expect(field(report, "phone")?.status).toBe("confirmed"); expect(field(report, "email")?.status).toBe("confirmed");
  });

  it("confirms the named manager's own vertical-table contacts, not every staff card", () => {
    const item = card({ phone, email }, { fields: { fullName: manager, phone, email }, selectedFields: ["fullName", "phone", "email"] });
    const report = auditIntelligenceResult([item], [team()]);
    expect(field(report, "phone")?.status).toBe("confirmed"); expect(field(report, "email")?.status).toBe("confirmed");
  });

  it.each([false, true])("confirms explicit FIO/experience/contact paragraph blocks; fragments=%s", (fragments) => {
    const rows = [`ФИО: ${person}`, "Опыт работы: 6 лет", `Телефон: ${ownPhone}`, `Email: ${ownEmail}`];
    const input: IntelligenceSource = fragments ? source(rows.map((text, index) => paragraph(index + 1, text))) : { id: "staff-source", name: "Синтетический блок QA", text: rows.join("\n") };
    const item = card({ experienceYears: 6, phone: ownPhone, email: ownEmail }), report = auditIntelligenceResult([item], [input]);
    for (const name of ["experienceYears", "phone", "email"]) expect(field(report, name)?.status).toBe("confirmed");
  });

  it.each(["experienceYears", "experienceNotes", "phone", "email"])("requires review when ownership is unknown: %s", (name) => {
    const fields = { experienceYears: 6, experienceNotes: "Анализ защищённости", phone: ownPhone, email: ownEmail };
    const input = source([paragraph(1, `Список специалистов: ${person}`), paragraph(2, "Опыт: 6 лет. Анализ защищённости"), paragraph(3, `Телефон: ${ownPhone}; Email: ${ownEmail}`)]);
    blocked(card({ [name]: fields[name as keyof typeof fields] }), input, name);
  });

  it("does not mistake project counts or project-duration years for career experience", () => {
    const input = source([row(1, `${person}\tБолее 25 проектов за 5 лет. 6 лет опыта в ИБ.`)]);
    blocked(card({ experienceYears: 25 }), input, "experienceYears"); blocked(card({ experienceYears: 5 }), input, "experienceYears");
    expect(field(auditIntelligenceResult([card({ experienceYears: 6 })], [input]), "experienceYears")?.status).toBe("confirmed");
  });

  it("switches owners at the next explicit person and never borrows a quoted manager block", () => {
    const input = source([paragraph(1, `ФИО: ${person}`), paragraph(2, "Опыт: 6 лет"), paragraph(3, `ФИО: ${manager}`), paragraph(4, `Телефон: ${phone}`), paragraph(5, `Email: ${email}`)]);
    blocked(card({ phone, email }), input, "phone"); blocked(card({ phone, email }), input, "email");
    const quote = source([paragraph(1, `ФИО: ${person}`), paragraph(2, `Цитата менеджера: «${manager}»`), paragraph(3, `Телефон: ${phone}`), paragraph(4, `Email: ${email}`)]);
    blocked(card({ phone, email }), quote, "phone"); blocked(card({ phone, email }), quote, "email");
  });

  it.each(["Лицензионная база партнёра:", "Реквизиты компании:", "Контакты менеджера:", "2. Новый раздел"])("ends person ownership at an unrelated heading: %s", (heading) => {
    const input = source([paragraph(1, `ФИО: ${person}`), paragraph(2, heading), paragraph(3, `Телефон: ${phone}; Email: ${email}`)]);
    blocked(card({ phone, email }), input, "email");
  });

  it("does not let a manager-labelled cell become the row employee's contacts", () => {
    const input = source([row(1, `${person}\tОпыт: 6 лет\tКонтакт менеджера: ${manager}; ${phone}; ${email}`)]);
    blocked(card({ phone, email }), input, "phone"); blocked(card({ phone, email }), input, "email");
    expect(field(auditIntelligenceResult([card({ experienceYears: 6 })], [input]), "experienceYears")?.status).toBe("confirmed");
  });

  it.each([false, true])("never inherits contact ownership through hidden history; opted-in=%s", (includedByUser) => {
    const input = source([paragraph(1, `ФИО: ${person}`), paragraph(2, "Архив", { sheetState: "hidden", includedByUser }), paragraph(3, `Email: ${email}`)]);
    blocked(card({ email }), input, "email");
  });

  it("does not carry an owner across a sheet, table, selected-array gap or unlabelled table row", () => {
    for (const middle of [paragraph(2, "Прочие сведения", { sheetId: "other" }), row(8, "Цена\t1000"), paragraph(4, "Новый блок")]) {
      const input = source([paragraph(1, `ФИО: ${person}`), middle, paragraph(5, `Email: ${email}`)]);
      blocked(card({ email }), input, "email");
    }
    blocked(card({ email }), source([row(1, `${person}\t6 лет опыта`), row(2, `Нет ФИО\t${email}`)]), "email");
  });

  it("requires source ownership independently from stale evidence UUIDs and uncited positive controls", () => {
    const item = card({ email }, { evidence: [{ field: "email", sourceId: "stale-source", fragmentId: "paragraph-2", quote: email }] });
    const input = source([paragraph(1, `ФИО: ${person}`), paragraph(2, `ФИО: ${manager}`), paragraph(3, `Email: ${email}`)]);
    const report = auditIntelligenceResult([item], [input, source([row(1, `${person}\t${email}`)], { id: "uncited" })]);
    expect(field(report, "email")?.status).not.toBe("confirmed"); expect(getBlockingEvidenceFindings(report, item).some((finding) => finding.code === "evidence-source-not-cited")).toBe(true);
  });

  it("keeps explicitly shared contacts only for the named employees, never shared experience", () => {
    const input = source([paragraph(1, `Общие контакты сотрудников: ${person}; ${other}`), paragraph(2, `Телефон: ${ownPhone}`), paragraph(3, `Email: ${ownEmail}`), paragraph(4, "Опыт: 6 лет")]);
    const report = auditIntelligenceResult([card({ phone: ownPhone, email: ownEmail })], [input]);
    expect(field(report, "phone")?.status).toBe("confirmed"); expect(field(report, "email")?.status).toBe("confirmed");
    const foreign = card({ email: ownEmail }, { fields: { fullName: manager, email: ownEmail }, selectedFields: ["fullName", "email"] });
    blocked(foreign, input, "email"); blocked(card({ experienceYears: 6 }), input, "experienceYears");
  });

  it("keeps ACK explicit and invalidates it after an employee or source changes", () => {
    const item = card({ experienceYears: 25, email }), input = team(), report = auditIntelligenceResult([item], [input]);
    const acks = getBlockingEvidenceFindings(report, item).map((finding) => finding.id);
    expect(acks.length).toBeGreaterThan(0); expect(getBlockingEvidenceFindings(report, item, acks)).toEqual([]);
    const changed = { ...item, fields: { ...item.fields, fullName: other } };
    expect(getBlockingEvidenceFindings(auditIntelligenceResult([changed], [input]), changed, acks).length).toBeGreaterThan(0);
    const moved = source(team().fragments!.map((entry) => entry.id === "table-row-12" ? { ...entry, text: entry.text.replace("6 лет", "7 лет") } : entry));
    expect(getBlockingEvidenceFindings(auditIntelligenceResult([item], [moved]), item, acks).length).toBeGreaterThan(0);
  });

  it("does not review fields excluded from transfer or mutate certificate/basis guards", () => {
    const item = card({ phone, email, experienceYears: 25, certificates: ["OSCP"], basis: "Трудовой договор" }); item.selectedFields = ["fullName"];
    expect(getBlockingEvidenceFindings(auditIntelligenceResult([item], [team()]), item)).toEqual([]);
  });
});
