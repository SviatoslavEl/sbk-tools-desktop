import { describe, expect, it } from "vitest";
import { detectStaffMapping, mapStaffRows } from "./import";
import { mergeStaffImportUpdate } from "./Staff";
import { emptyOrganizationalAssignment, emptyStaff, emptyStaffDocument, type StaffData } from "./types";
import { matchesStaffAssignmentFilters } from "./selection";

const fixture = (): StaffData => ({ ...emptyStaff(), fullName: "Иванов Иван", status: "Работает", notes: "Ручные сведения", phone: "+7 999 1112233", email: "keep@example.ru", disclosureAllowed: true, hourlyRate: 2500, skills: ["Аудит"], organizationalAssignments: [{ ...emptyOrganizationalAssignment(), id: "assignment", legalEntity: "ООО А", department: "ИБ", status: "Работает" }], documents: [
  { ...emptyStaffDocument("certificate"), id: "original", name: "ISO 27001", seriesNumber: "CERT-007", issuer: "Issuer", expiresDate: "2030-01-01", comment: "Проверено вручную", relativePath: "attachments/staff/person/cert.pdf", fileName: "cert.pdf", sha256: "HASH", sizeBytes: 123 },
  { ...emptyStaffDocument("certificate"), id: "other", name: "Другой сертификат" },
  { ...emptyStaffDocument("contract"), id: "contract", name: "Трудовой договор" },
] });
function update(previous: StaffData, headers: string[], row: string[]) {
  const mapping = detectStaffMapping(headers);
  const [imported] = mapStaffRows([row], mapping).items;
  return mergeStaffImportUpdate(previous, imported, mapping, row);
}

describe("staff CSV updates are additive and preserve document identity", () => {
  it("keeps the matched ID, attachment, manual metadata and all unmatched documents", () => {
    const previous = fixture(); const snapshot = structuredClone(previous);
    const result = update(previous, ["ФИО", "Сертификаты"], ["Иванов Иван", " iso   27001 ; Новый сертификат"]);
    expect(result.documents).toHaveLength(4);
    expect(result.documents.slice(0, 3)).toEqual(previous.documents);
    expect(result.documents[3].name).toBe("Новый сертификат");
    expect(previous).toEqual(snapshot);
    const repeated = update(result, ["ФИО", "Сертификаты"], ["Иванов Иван", "ISO 27001; Новый сертификат"]);
    expect(repeated.documents).toEqual(result.documents);
  });
  it("only an explicit certificate validity changes validity and never manual comments", () => {
    const previous = fixture();
    const result = update(previous, ["ФИО", "Сертификаты", "Сроки сертификатов"], ["Иванов Иван", "ISO 27001", "до 2035"]);
    expect(result.documents[0]).toEqual({ ...previous.documents[0], expiresDate: "2035-12-31", unlimited: false });
    const unlimited = update(result, ["ФИО", "Сертификаты", "Сроки сертификатов"], ["Иванов Иван", "ISO 27001", "бессрочно"]);
    expect(unlimited.documents[0]).toEqual({ ...previous.documents[0], expiresDate: "", unlimited: true });
  });
  it("blank mapped cells do not reset booleans, numbers, assignments or documents", () => {
    const previous = fixture();
    const result = update(previous, ["ФИО", "Сертификаты", "Сроки сертификатов", "Образование", "Примечания", "Ставка", "Можно включать в заявку", "Юрлицо", "Статус"], ["Иванов Иван", "", "", "", "", "", "", "", ""]);
    expect(result).toEqual(previous);
  });
  it("accepts explicit zero/false and preserves missing contact channels", () => {
    const result = update(fixture(), ["ФИО", "Ставка", "Можно включать в заявку", "Контакты"], ["Иванов Иван", "0", "нет", "+7 900 123-45-67"]);
    expect(result.hourlyRate).toBe(0); expect(result.disclosureAllowed).toBe(false);
    expect(result.email).toBe("keep@example.ru"); expect(result.phone).toBe("+7 900 123-45-67");
  });
  it("preserves assignment IDs and other jobs, adds skills without removing old ones", () => {
    const previous = fixture(); previous.organizationalAssignments.push({ ...emptyOrganizationalAssignment(), id: "second", legalEntity: "ООО Б", isPrimary: false });
    const result = update(previous, ["ФИО", "Отдел", "Навыки"], ["Иванов Иван", "Новый отдел", "ГОСТ; Аудит"]);
    expect(result.organizationalAssignments[0]).toEqual({ ...previous.organizationalAssignments[0], department: "Новый отдел" });
    expect(result.organizationalAssignments[1]).toEqual(previous.organizationalAssignments[1]);
    expect(result.skills).toEqual(["Аудит", "ГОСТ"]);
  });
  it("keeps diploma attachment and metadata when importing the same education", () => {
    const previous = fixture(); const diploma = { ...emptyStaffDocument("education"), id: "diploma", name: "Высшее техническое", issuer: "МГТУ", relativePath: "attachments/staff/person/diploma.pdf", seriesNumber: "123" }; previous.documents.push(diploma);
    expect(update(previous, ["ФИО", "Образование"], ["Иванов Иван", "Высшее техническое"]).documents).toEqual(previous.documents);
  });
  it("refuses ambiguous existing names before writing", () => {
    const previous = fixture(); previous.documents.push({ ...previous.documents[0], id: "duplicate", seriesNumber: "OTHER" });
    expect(() => update(previous, ["ФИО", "Сертификаты"], ["Иванов Иван", "ISO 27001"])).toThrow("неоднозначен");
  });
  it("deduplicates identical import lines but refuses conflicting validity values", () => {
    expect(update(fixture(), ["ФИО", "Сертификаты"], ["Иванов Иван", "Новый; Новый"]).documents).toHaveLength(4);
    expect(() => update(fixture(), ["ФИО", "Сертификаты", "Сроки сертификатов"], ["Иванов Иван", "ISO 27001; ISO 27001", "2030; 2031"])).toThrow("разных сроков");
  });
  it("does not guess the target of a status-only or mismatched import", () => {
    expect(() => update(fixture(), ["ФИО", "Сроки сертификатов"], ["Иванов Иван", "2030"])).toThrow("колонка с их названиями");
    expect(() => update(fixture(), ["ФИО", "Сертификаты", "Сроки сертификатов"], ["Иванов Иван", "ISO 27001; Новый", "2030"])).toThrow("Количество сроков");
  });
  it("never shifts a later certificate expiry over an explicit unspecified value", () => {
    const previous = fixture();
    const result = update(previous, ["ФИО", "Сертификаты", "Сроки сертификатов"], ["Иванов Иван", "ISO 27001; Другой сертификат", "не указано; 2035"]);
    expect(result.documents[0]).toEqual(previous.documents[0]);
    expect(result.documents[1].expiresDate).toBe("2035-12-31");
  });
  it.each(["действует", "2030-02-31", "31.13.2030"])("refuses unrecognized/invalid date %s instead of erasing validity", (validity) => {
    expect(() => update(fixture(), ["ФИО", "Сертификаты", "Сроки сертификатов"], ["Иванов Иван", "ISO 27001", validity])).toThrow("Не удалось распознать срок");
  });
});

describe("staff registry assignment filters", () => {
  const filters = { legalEntity: "ООО А", department: "Продажи", basis: "ГПХ", status: "Кандидат" };
  it("cannot combine one employer with another job's department/status/basis", () => {
    const person = fixture(); person.organizationalAssignments.push({ ...emptyOrganizationalAssignment(), legalEntity: "ООО Б", department: "Продажи", engagementType: "ГПХ", status: "Кандидат", isPrimary: false });
    expect(matchesStaffAssignmentFilters(person, filters)).toBe(false);
    expect(matchesStaffAssignmentFilters(person, { ...filters, legalEntity: "ООО Б" })).toBe(true);
  });
  it("supports empty filters and legacy staff without assignment arrays", () => {
    expect(matchesStaffAssignmentFilters(emptyStaff(), { legalEntity: "", department: "", basis: "", status: "" })).toBe(true);
    expect(matchesStaffAssignmentFilters({ ...emptyStaff(), basis: "ГПХ", status: "Кандидат" }, { legalEntity: "", department: "", basis: "ГПХ", status: "Кандидат" })).toBe(true);
  });
});
