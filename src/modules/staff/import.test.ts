import { describe, expect, it } from "vitest";
import { detectStaffMapping, mapStaffRows } from "./import";
import { matchStaff, type StaffSelectionCriteria } from "./selection";

describe("импорт реестра кадров", () => {
  it("распознаёт заголовки предоставленного файла и применяет юрлицо с отделом", () => {
    const headers = ["ID сотрудника", "ФИО", "Должность / роль", "Основная специализация", "Дополнительные специализации", "Ключевые компетенции", "Отраслевой опыт", "Стаж, лет", "Стаж* (вспом.), лет", "Сертификаты", "Срок действия сертификатов", "Образование", "Город / страна", "Готовность к командировкам", "Контакты", "Примечание / требует проверки"];
    const mapping = detectStaffMapping(headers);
    const parsed = mapStaffRows([["EMP-001", "Иванов Иван Иванович", "Ведущий аудитор", "Информационная безопасность", "Персональные данные; ИТ-аудит", "ГОСТ; 152-ФЗ", "Финансы; промышленность", "Свыше восьми лет", "8", "CISA; ISO 27001", "до 2030; бессрочно", "Высшее техническое", "Москва", "Да", "+7 900 000-00-00, test@example.ru", "Готов"]], mapping, { legalEntity: "ООО СБК", department: "ИБ", basis: "Штат", status: "Работает" });
    expect(parsed.issues).toEqual([]);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].organizationalAssignments[0]).toMatchObject({ legalEntity: "ООО СБК", department: "ИБ", position: "Ведущий аудитор", status: "Работает" });
    expect(parsed.items[0].documents).toHaveLength(3);
    expect(parsed.items[0].documents[0]).toMatchObject({ expiresDate: "2030-12-31", unlimited: false });
    expect(parsed.items[0].documents[1]).toMatchObject({ expiresDate: "", unlimited: true });
    expect(parsed.items[0].experienceYears).toBe(8);
    const defaultSelection: StaffSelectionCriteria = { procurementTitle: "", keywords: "ГОСТ", legalEntity: "ООО СБК", department: "ИБ", position: "Ведущий аудитор", status: "Работает", minExperienceYears: 0, maxHourlyRate: 0, location: "", travelRequired: false, availableFrom: "", availableTo: "", validDocumentsOnly: true, disclosureOnly: false };
    expect(matchStaff(parsed.items[0], defaultSelection, "2026-08-28").score).toBeGreaterThan(0);
  });
});
