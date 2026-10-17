import { describe, expect, it } from "vitest";
import { auditIntelligenceResult, getBlockingEvidenceFindings } from "./resultEvidence";
import type { IntelligenceFieldValue, IntelligenceFragment, IntelligenceItem, IntelligenceSource } from "./workbenchTypes";

const person = "Бетов Борис Борисович", other = "Гаммов Григорий Григорьевич";
const ownCertificate = "Система:Консалтинг. Основы управления", foreignCertificate = "Система:Профессионал. Оперативный учет 7.7";
const row = (number: number, text: string, extra: Partial<IntelligenceFragment> = {}): IntelligenceFragment => ({ id: `sheet-1-row-${number}`, locator: `Лист QA, A${number}:M${number}`, sheetId: "1", sheetState: "visible", text, ...extra });
const paragraph = (number: number, text: string, extra: Partial<IntelligenceFragment> = {}): IntelligenceFragment => ({ id: `paragraph-${number}`, locator: `Абзац ${number}`, text, ...extra });
const source = (fragments: IntelligenceFragment[], extra: Partial<IntelligenceSource> = {}): IntelligenceSource => ({ id: "source-qa", name: "Синтетический реестр QA", text: "Агрегат не восстанавливает исключённые строки", fragments, ...extra });
const card = (field: string, value: IntelligenceFieldValue): IntelligenceItem => ({ id: "person-qa", title: "Профиль специалиста QA", destination: "staff", fields: { fullName: person, [field]: value }, selectedFields: ["fullName", field], sourceIds: ["source-qa"], evidence: [] });
const audit = (item: IntelligenceItem, input: IntelligenceSource) => auditIntelligenceResult([item], [input]);
const status = (report: ReturnType<typeof audit>, field: string) => report.fields.find((entry) => entry.field === field);
const ownerFindings = (report: ReturnType<typeof audit>) => report.findings.filter((entry) => /^staff-owner-/u.test(entry.code));
const genericFields: Array<[string, IntelligenceFieldValue]> = [
  ["role", "Инженер интеграций"], ["grade", "Ведущий"], ["skills", ["Проверка приложений"]], ["qualification", "Инженер-программист"],
  ["primarySpecialization", "Разработка интеграций"], ["additionalSpecializations", [foreignCertificate]], ["competencies", ["Аудит инфраструктуры"]],
  ["industries", ["Промышленность"]], ["location", "Новосибирск"], ["travelReadiness", "Командировки согласованы"], ["notes", "Работает удалённо"],
  ["hourlyRate", 1550], ["birthDate", "1990-02-03"], ["availableFrom", "2026-11-01"], ["availableTo", "2026-12-01"],
  ["startDate", "2026-11-02"], ["endDate", "2026-12-02"],
];
const fieldText = (field: string, value: IntelligenceFieldValue) => `${field === "startDate" ? "Начало работ" : field === "endDate" ? "Окончание работ" : field}: ${Array.isArray(value) ? value.join("; ") : value}`;

describe("fresh wide054: a literal staff value also needs its own employee", () => {
  it("blocks a foreign specialization without relying on certificates, basis, claims or incomplete-coverage blockers", () => {
    const input = source([row(4, "\tКонтактное лицо\tСертификат\tДействителен\tДата сдачи\tНомер сертификата"), row(5, `\t${person}`), row(6, `\t\t${person}\t${ownCertificate}\tДа\t17.04.2025\tQA-100`), row(9, `\t${other}`), row(10, `\t\t${other}\t${foreignCertificate}\tДа\t12.10.2006\tQA-200`)]);
    const item = card("additionalSpecializations", [foreignCertificate]), before = structuredClone({ item, input });
    const report = audit(item, input);
    expect(status(report, "fullName")?.status).toBe("confirmed");
    expect(status(report, "additionalSpecializations")?.status).toBe("conflict");
    expect(ownerFindings(report)).toEqual([expect.objectContaining({ code: "staff-owner-conflict", severity: "blocking", field: "additionalSpecializations" })]);
    expect(status(report, "additionalSpecializations")?.evidence.some((entry) => entry.fragmentId === "sheet-1-row-10" && entry.quote.includes(other))).toBe(true);
    expect(item.evidence).toEqual([]); expect(item.fields.certificates).toBeUndefined(); expect(item.fields.basis).toBeUndefined();
    expect({ item, input }).toEqual(before);
  });

  it.each(genericFields)("downgrades a borrowed scalar/list/date value in %s", (field, value) => {
    const item = card(field, value), report = audit(item, source([row(1, `${person}\tСвой профиль`), row(2, `${other}\t${fieldText(field, value)}`)]));
    expect(status(report, field)?.status).toBe("conflict");
    expect(ownerFindings(report)).toContainEqual(expect.objectContaining({ field, code: "staff-owner-conflict", severity: "blocking" }));
  });

  it.each(genericFields)("keeps %s when an explicit own row proves the same value despite other employees' duplicates", (field, value) => {
    const item = card(field, value), report = audit(item, source([row(1, `${other}\t${fieldText(field, value)}`), row(2, `${person}\t${fieldText(field, value)}`)]));
    expect(status(report, field)?.status).toBe("confirmed"); expect(ownerFindings(report)).toEqual([]);
  });

  it("requires every nonempty list entry to belong to the selected employee", () => {
    const item = card("skills", ["Проверка приложений", "Аудит инфраструктуры"]);
    const report = audit(item, source([row(1, `${person}\tПроверка приложений`), row(2, `${other}\tАудит инфраструктуры`)]));
    expect(status(report, "skills")?.status).toBe("conflict"); expect(ownerFindings(report)[0]?.field).toBe("skills");
    expect(item.fields.skills).toEqual(["Проверка приложений", "Аудит инфраструктуры"]);
  });

  it("keeps a genuinely owned certificate name shared by other holders with different document numbers", () => {
    const item = card("certificates", [ownCertificate]);
    const input = source([row(4, "\tКонтактное лицо\tСертификат\tДействителен\tДата сдачи\tНомер сертификата"), row(5, `\t\t${other}\t${ownCertificate}\tДа\t17.04.2024\tQA-OTHER-200`), row(6, `\t\t${person}\t${ownCertificate}\tДа\t17.04.2025\tQA-OWN-100`)]);
    const report = audit(item, input);
    expect(status(report, "certificates")?.status).toBe("confirmed"); expect(ownerFindings(report)).toEqual([]);
    expect(status(report, "certificates")?.evidence).toEqual([expect.objectContaining({ fragmentId: "sheet-1-row-6", quote: expect.stringContaining("QA-OWN-100") })]);
    expect(item.fields.certificates).toEqual([ownCertificate]); expect(item.evidence).toEqual([]);
  });

  it("shows only own value proofs when a generic specialization also occurs in foreign rows", () => {
    const item = card("additionalSpecializations", [foreignCertificate]);
    item.evidence = [{ field: "additionalSpecializations", sourceId: "source-qa", fragmentId: "sheet-1-row-1", quote: foreignCertificate }];
    const input = source([row(1, `${other}\t${foreignCertificate}`), row(2, `${person}\t${foreignCertificate}`), row(3, `Дельтов Дмитрий Дмитриевич\t${foreignCertificate}`)]), before = structuredClone(item);
    const report = audit(item, input);
    expect(status(report, "additionalSpecializations")?.status).toBe("confirmed");
    expect(status(report, "additionalSpecializations")?.evidence).toEqual([expect.objectContaining({ fragmentId: "sheet-1-row-2", quote: expect.stringContaining(person) })]);
    expect(item).toEqual(before);
  });

  it("does not let an owned unrelated date borrow the same calendar date's foreign event", () => {
    const item = card("startDate", "2026-11-02"), report = audit(item, source([row(1, `${person}\tДата публикации: 02.11.2026`), row(2, `${other}\tНачало работ: 02.11.2026`)]));
    expect(status(report, "startDate")?.status).toBe("conflict"); expect(ownerFindings(report)[0]?.code).toBe("staff-owner-conflict");
  });

  it("keeps a genuinely owned event date in the source's printed calendar format", () => {
    const item = card("startDate", "2026-11-02"), report = audit(item, source([row(1, `${other}\tНачало работ: 02.11.2026`), row(2, `${person}\tНачало работ: 02.11.2026`)]));
    expect(status(report, "startDate")?.status).toBe("confirmed"); expect(ownerFindings(report)).toEqual([]);
  });

  it("turns globally present but unowned text into a blocking review, not a generic warning", () => {
    const item = card("role", "Инженер интеграций"), report = audit(item, source([paragraph(1, `Список специалистов: ${person}`), paragraph(2, "Должность: Инженер интеграций")]));
    expect(status(report, "role")?.status).toBe("unverified");
    expect(ownerFindings(report)).toEqual([expect.objectContaining({ field: "role", code: "staff-owner-unverified", severity: "blocking" })]);
  });

  it("keeps an explicitly bounded own paragraph role, including aggregate text without fragments", () => {
    const item = card("role", "Инженер интеграций"), rows = [`ФИО: ${person}`, "Должность: Инженер интеграций"];
    for (const input of [source(rows.map((text, index) => paragraph(index + 1, text))), source([], { fragments: undefined, text: rows.join("\n") })]) {
      expect(status(audit(item, input), "role")?.status).toBe("confirmed");
    }
  });

  it.each(["hidden", "gap", "sheet", "table", "foreign-heading"])("does not inherit paragraph ownership across %s", (change) => {
    const fragments = [paragraph(1, `ФИО: ${person}`), paragraph(2, "Должность: Инженер интеграций")];
    if (change === "hidden") fragments.splice(1, 0, paragraph(2, "Архив", { sheetState: "hidden" }));
    if (change === "gap") fragments[1] = paragraph(4, fragments[1].text);
    if (change === "sheet") fragments[1].sheetId = "other";
    if (change === "table") fragments[1] = row(2, fragments[1].text);
    if (change === "foreign-heading") fragments.splice(1, 0, paragraph(2, `ФИО: ${other}`));
    const report = audit(card("role", "Инженер интеграций"), source(fragments));
    expect(status(report, "role")?.status).not.toBe("confirmed"); expect(ownerFindings(report).length).toBeGreaterThan(0);
  });

  it("rejects opted-in hidden own data and does not resurrect an excluded aggregate", () => {
    const item = card("skills", ["Проверка приложений"]);
    const report = audit(item, source([row(1, `${person}\tПроверка приложений`, { sheetState: "hidden", includedByUser: true })]));
    expect(status(report, "skills")?.status).toBe("unverified"); expect(ownerFindings(report)[0]?.code).toBe("staff-owner-unverified");
    const excluded = audit(item, source([], { text: `${person}\tПроверка приложений` }));
    expect(status(excluded, "skills")?.status).not.toBe("confirmed");
  });

  it("cannot borrow a fresh positive source that the card did not cite or use stale claim UUIDs as ownership", () => {
    const item = card("additionalSpecializations", [foreignCertificate]);
    item.evidence = [{ field: "additionalSpecializations", sourceId: "stale-source", fragmentId: "sheet-1-row-2", quote: foreignCertificate }];
    const input = source([row(1, `${person}\tСвой профиль`), row(2, `${other}\t${foreignCertificate}`)]);
    const report = auditIntelligenceResult([item], [input, source([row(1, `${person}\t${foreignCertificate}`)], { id: "uncited-source" })]);
    expect(status(report, "additionalSpecializations")?.status).toBe("conflict");
    expect(report.findings.some((entry) => entry.code === "evidence-source-not-cited")).toBe(true);
  });

  it("does not upgrade missing, placeholder, wrong-event, certificate or education-role failures", () => {
    const input = source([row(1, `${person}\tОпыт: 6 лет\tДата публикации: 2026-11-02\tПроверка приложений`)]);
    for (const [field, value] of [["role", "Несуществующая роль"], ["role", "Неизвестно"], ["startDate", "2026-11-02"], ["certificates", ["OSCP"]], ["education", ["Проверка приложений"]]] as Array<[string, IntelligenceFieldValue]>) {
      const report = audit(card(field, value), input);
      expect(status(report, field)?.status).not.toBe("confirmed"); expect(ownerFindings(report)).toEqual([]);
    }
  });

  it("retains explicit own certificate/basis, academic and contact guards", () => {
    const item = card("basis", "ИП"); item.fields = { fullName: person, basis: "ИП", certificates: ["OSCP"], education: ["Институт QA, квалификация инженер"], phone: "+7 900 100 1111" }; item.selectedFields = Object.keys(item.fields);
    const input = source([], { fragments: undefined, text: `ФИО: ${person}\nОснование сотрудничества: ИП\nСертификаты: OSCP\nФИО: ${person}\nОбразование: Институт QA, квалификация инженер\nТелефон: +7 900 100 1111` });
    const report = audit(item, input);
    for (const field of item.selectedFields) expect(status(report, field)?.status).toBe("confirmed");
    expect(ownerFindings(report)).toEqual([]);
  });

  it("keeps explicit shared contacts without treating a shared-contact heading as shared skills", () => {
    const input = source([paragraph(1, `Общие контакты сотрудников: ${person}; ${other}`), paragraph(2, "Телефон: +7 900 100 1111"), paragraph(3, "Проверка приложений")]);
    expect(status(audit(card("phone", "+7 900 100 1111"), input), "phone")?.status).toBe("confirmed");
    const report = audit(card("skills", ["Проверка приложений"]), input);
    expect(status(report, "skills")?.status).toBe("unverified"); expect(ownerFindings(report)[0]?.code).toBe("staff-owner-unverified");
  });

  it("retains an explicit review ACK and invalidates it when person/source changes; deselected fields are untouched", () => {
    const item = card("role", "Инженер интеграций"), input = source([row(1, `${person}\tСвой профиль`), row(2, `${other}\tИнженер интеграций`)]), before = structuredClone({ item, input });
    const report = audit(item, input), ids = getBlockingEvidenceFindings(report, item).map((entry) => entry.id);
    expect(ids.length).toBeGreaterThan(0); expect(getBlockingEvidenceFindings(report, item, ids)).toEqual([]);
    const changed = { ...item, fields: { ...item.fields, fullName: "Дельтов Дмитрий Дмитриевич" } };
    expect(getBlockingEvidenceFindings(audit(changed, input), changed, ids).length).toBeGreaterThan(0);
    const moved = source(input.fragments!.map((entry) => entry.id === "sheet-1-row-2" ? { ...entry, text: `${other}\tИнженер интеграций. Новая запись` } : entry));
    expect(getBlockingEvidenceFindings(audit(item, moved), item, ids).length).toBeGreaterThan(0);
    const deselected = { ...item, selectedFields: ["fullName"] };
    expect(ownerFindings(audit(deselected, input))).toEqual([]); expect({ item, input }).toEqual(before);
  });
});
