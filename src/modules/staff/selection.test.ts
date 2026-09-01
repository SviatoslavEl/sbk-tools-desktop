import { describe, expect, it } from "vitest";
import { emptyOrganizationalAssignment, emptyStaff, emptyStaffDocument } from "./types";
import { matchStaff, staffDocumentsValid, travelReady, type StaffSelectionCriteria } from "./selection";

const criteria = (patch: Partial<StaffSelectionCriteria> = {}): StaffSelectionCriteria => ({
  procurementTitle: "Аудит информационной безопасности", keywords: "ГОСТ", legalEntity: "", department: "", position: "", status: "", minExperienceYears: 0, maxHourlyRate: 0, location: "", travelRequired: false, availableFrom: "", availableTo: "", validDocumentsOnly: false, disclosureOnly: true, certificateMode: "", certificateQuery: "", educationRequired: false, educationQuery: "", cooperationMode: "", ...patch,
});

describe("подбор кадров", () => {
  it("исключает нерелевантного сотрудника несмотря на стаж и доступность", () => {
    const item = { ...emptyStaff(), role: "Инженер-строитель", experienceYears: 12, disclosureAllowed: true, experienceNotes: "Монтаж зданий" };
    expect(matchStaff(item, criteria()).score).toBe(0);
  });

  it("учитывает индивидуальное назначение, период, ставку и документы", () => {
    const assignment = { ...emptyOrganizationalAssignment(), legalEntity: "ООО СБК", department: "Аудит", position: "Аудитор", status: "Работает" as const };
    const document = { ...emptyStaffDocument("certificate"), name: "ГОСТ", expiresDate: "2027-01-01" };
    const item = { ...emptyStaff(), role: "Аудитор", experienceYears: 8, competencies: ["информационная безопасность", "ГОСТ"], organizationalAssignments: [assignment], availableFrom: "2026-08-01", availableTo: "2026-12-31", hourlyRate: 3500, disclosureAllowed: true, documents: [document] };
    const match = matchStaff(item, criteria({ legalEntity: "ООО СБК", department: "Аудит", position: "Аудитор", availableFrom: "2026-09-01", availableTo: "2026-11-30", maxHourlyRate: 4000, validDocumentsOnly: true }), "2026-08-28");
    expect(match.score).toBeGreaterThan(0);
    expect(match.reasons.join(" ")).toContain("Документы действуют");
    expect(matchStaff({ ...item, hourlyRate: 4500 }, criteria({ maxHourlyRate: 4000 }), "2026-08-28").score).toBe(0);
  });

  it("считает просроченный или отсутствующий документ невалидным", () => {
    expect(staffDocumentsValid(emptyStaff(), "2026-08-28")).toBe(false);
    expect(staffDocumentsValid({ ...emptyStaff(), documents: [{ ...emptyStaffDocument(), expiresDate: "2026-08-27" }] }, "2026-08-28")).toBe(false);
    expect(staffDocumentsValid({ ...emptyStaff(), documents: [{ ...emptyStaffDocument("education"), name: "Диплом" }] }, "2026-08-28")).toBe(true);
    expect(staffDocumentsValid({ ...emptyStaff(), documents: [{ ...emptyStaffDocument("certificate"), name: "Сертификат" }] }, "2026-08-28")).toBe(false);
  });

  it("сопоставляет все организационные фильтры с одним назначением", () => {
    const item = { ...emptyStaff(), disclosureAllowed: true, organizationalAssignments: [
      { ...emptyOrganizationalAssignment(), id: "one", legalEntity: "ООО А", department: "Аудит", position: "Аудитор", status: "Работает" as const, isPrimary: true },
      { ...emptyOrganizationalAssignment(), id: "two", legalEntity: "ООО Б", department: "Проекты", position: "Руководитель", status: "Кандидат" as const, isPrimary: false },
    ] };
    expect(matchStaff(item, criteria({ legalEntity: "ООО А", position: "Руководитель", disclosureOnly: false })).score).toBe(0);
    const match = matchStaff(item, criteria({ legalEntity: "ООО Б", position: "Руководитель", status: "Кандидат", disclosureOnly: false }));
    expect(match.score).toBeGreaterThan(0);
    expect(match.assignmentId).toBe("two");
  });

  it("фильтрует по сертификату, образованию и совместительству", () => {
    const item = { ...emptyStaff(), role: "Аудитор", competencies: ["ГОСТ", "информационная безопасность"], disclosureAllowed: true, organizationalAssignments: [
      { ...emptyOrganizationalAssignment(), engagementType: "Внешнее совместительство" as const, position: "Аудитор" },
    ], documents: [
      { ...emptyStaffDocument("certificate"), name: "ISO 27001 Lead Auditor", expiresDate: "2027-05-01" },
      { ...emptyStaffDocument("education"), name: "Диплом по информационной безопасности", issuer: "МИФИ" },
    ] };
    const matched = matchStaff(item, criteria({ certificateMode: "valid", certificateQuery: "ISO 27001", educationRequired: true, educationQuery: "МИФИ", cooperationMode: "part-time" }), "2026-09-01");
    expect(matched.score).toBeGreaterThan(0);
    expect(matched.reasons.join(" ")).toContain("действующий сертификат");
    expect(matchStaff(item, criteria({ cooperationMode: "Внутреннее совместительство" }), "2026-09-01").score).toBe(0);
    expect(matchStaff(item, criteria({ certificateQuery: "CISSP" }), "2026-09-01").score).toBe(0);
  });

  it("не принимает отрицательную готовность к командировкам", () => {
    expect(travelReady("Готов к командировкам")).toBe(true);
    expect(travelReady("Готов, ограничений нет")).toBe(true);
    expect(travelReady("Не готов к командировкам")).toBe(false);
    expect(travelReady("Командировки невозможны")).toBe(false);
  });
});
