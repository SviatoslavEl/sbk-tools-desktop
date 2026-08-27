import { cooperationBases, emptyOrganizationalAssignment, emptyStaff, emptyStaffDocument, workStatuses, type StaffData } from "./types";

export type StaffImportField = "fullName" | "birthDate" | "role" | "grade" | "primarySpecialization" | "additionalSpecializations" | "competencies" | "industries" | "skills" | "qualification" | "basis" | "basisOther" | "basisNumber" | "legalEntity" | "department" | "startDate" | "endDate" | "status" | "phone" | "email" | "contacts" | "experienceYears" | "experienceText" | "certificates" | "certificateStatuses" | "education" | "location" | "travelReadiness" | "availableFrom" | "availableTo" | "hourlyRate" | "disclosureAllowed" | "notes";
export type StaffImportMapping = Record<StaffImportField, number>;

export interface StaffImportDefaults { legalEntity: string; department: string; basis: StaffData["basis"]; status: StaffData["status"] }

export const staffImportFields: Array<[StaffImportField, string, string[]]> = [
  ["fullName", "ФИО *", ["фио", "сотрудник", "имя"]], ["birthDate", "Дата рождения", ["дата рождения", "рождение"]],
  ["role", "Должность / роль *", ["должность", "роль", "должность / роль"]], ["grade", "Грейд", ["грейд", "уровень"]],
  ["primarySpecialization", "Основная специализация", ["основная специализация"]], ["additionalSpecializations", "Дополнительные специализации", ["дополнительные специализации"]],
  ["competencies", "Ключевые компетенции", ["ключевые компетенции"]], ["industries", "Отраслевой опыт", ["отраслевой опыт", "отрасли"]],
  ["skills", "Навыки", ["навыки"]], ["qualification", "Квалификация", ["квалификация", "специализация"]],
  ["basis", "Основание", ["основание", "тип сотрудничества"]], ["basisOther", "Пояснение основания", ["пояснение основания", "иное основание"]],
  ["basisNumber", "Реквизиты основания", ["реквизиты основания", "номер основания", "договор"]], ["legalEntity", "Юрлицо", ["юрлицо", "юридическое лицо", "организация работодателя"]],
  ["department", "Отдел", ["отдел", "подразделение", "департамент"]], ["startDate", "Начало", ["начало", "дата начала"]], ["endDate", "Окончание", ["окончание", "дата окончания"]],
  ["status", "Статус", ["статус", "рабочий статус"]], ["phone", "Телефон", ["телефон", "phone"]], ["email", "Email", ["email", "электронная почта", "почта"]],
  ["contacts", "Контакты", ["контакты"]], ["experienceYears", "Стаж, лет", ["стаж* (вспом.), лет", "стаж (вспом.), лет", "стаж*"]], ["experienceText", "Описание стажа", ["стаж, лет", "описание стажа", "текстовый стаж"]],
  ["certificates", "Сертификаты", ["сертификаты"]], ["certificateStatuses", "Сроки сертификатов", ["срок действия сертификатов", "сроки сертификатов"]],
  ["education", "Образование", ["образование"]], ["location", "Город / страна", ["город / страна", "город", "локация"]], ["travelReadiness", "Командировки", ["готовность к командировкам", "командировки"]],
  ["availableFrom", "Доступен с", ["доступен с", "занятость с"]], ["availableTo", "Доступен до", ["доступен до", "занятость до"]],
  ["hourlyRate", "Ставка", ["ставка", "часовая ставка"]], ["disclosureAllowed", "Можно включать в заявку", ["можно включать в заявку", "раскрытие разрешено"]],
  ["notes", "Примечания", ["примечания", "комментарий", "примечание / требует проверки"]],
];

const normalized = (value: string) => value.toLowerCase().trim().replace(/\s+/g, " ");
const lines = (value: string) => value.split(/\r?\n|;/).map((entry) => entry.trim()).filter((entry) => entry && !/^не указано$/i.test(entry));

export function detectStaffMapping(headers: string[]): StaffImportMapping {
  return Object.fromEntries(staffImportFields.map(([key, , aliases]) => [key, headers.findIndex((header) => aliases.some((alias) => normalized(header) === normalized(alias))) ])) as StaffImportMapping;
}

export function mapStaffRows(rows: string[][], mapping: StaffImportMapping, defaults: StaffImportDefaults = { legalEntity: "", department: "", basis: "Трудовой договор", status: "Не указано" }): { items: StaffData[]; issues: string[] } {
  const issues: string[] = [];
  const value = (row: string[], key: StaffImportField) => mapping[key] >= 0 ? (row[mapping[key]] || "").trim() : "";
  const items = rows.filter((row) => row.some((cell) => cell.trim())).map((row, rowIndex) => {
    const rawBasis = value(row, "basis") || defaults.basis;
    const rawStatus = value(row, "status") || defaults.status;
    if (rawBasis && !cooperationBases.includes(rawBasis as never)) issues.push(`Строка ${rowIndex + 2}: неизвестное основание «${rawBasis}»`);
    if (rawStatus && !workStatuses.includes(rawStatus as never)) issues.push(`Строка ${rowIndex + 2}: неизвестный статус «${rawStatus}»`);
    const contacts = value(row, "contacts");
    const email = value(row, "email") || contacts.match(/[\w.+-]+@[\w.-]+\.[A-Za-zА-Яа-я]{2,}/)?.[0] || "";
    const phone = value(row, "phone") || contacts.match(/(?:\+7|8)[\d ()-]{9,}/)?.[0]?.trim() || "";
    const primarySpecialization = value(row, "primarySpecialization") || value(row, "qualification");
    const additionalSpecializations = lines(value(row, "additionalSpecializations"));
    const competencies = lines(value(row, "competencies"));
    const industries = lines(value(row, "industries"));
    const skillValues = [...lines(value(row, "skills")), ...additionalSpecializations, ...competencies];
    const rawExperience = value(row, "experienceYears") || value(row, "experienceText");
    const experienceYears = Number(rawExperience.replace(",", ".")) || Number(rawExperience.match(/\d+(?:[.,]\d+)?/)?.[0]?.replace(",", ".")) || 0;
    const certificateNames = lines(value(row, "certificates"));
    const certificateStatuses = lines(value(row, "certificateStatuses"));
    const documents = certificateNames.map((name, index) => ({ ...emptyStaffDocument("certificate"), type: "Сертификат", name, comment: certificateStatuses[index] || "Срок действия не указан" }));
    const education = value(row, "education");
    if (education && !/^не указано$/i.test(education)) documents.push({ ...emptyStaffDocument("education"), type: "Образование", name: education });
    const basis = cooperationBases.includes(rawBasis as never) ? rawBasis as StaffData["basis"] : "Иное";
    const status = workStatuses.includes(rawStatus as never) ? rawStatus as StaffData["status"] : "Не указано";
    const role = value(row, "role");
    const assignment = { ...emptyOrganizationalAssignment(), legalEntity: value(row, "legalEntity") || defaults.legalEntity, department: value(row, "department") || defaults.department, position: role, engagementType: basis, engagementOther: value(row, "basisOther"), status, basisNumber: value(row, "basisNumber"), startDate: value(row, "startDate"), endDate: value(row, "endDate") };
    return {
      ...emptyStaff(), fullName: value(row, "fullName"), birthDate: value(row, "birthDate"), role, grade: value(row, "grade"),
      skills: [...new Set(skillValues)], qualification: primarySpecialization, primarySpecialization, additionalSpecializations, competencies, industries,
      location: value(row, "location"), travelReadiness: value(row, "travelReadiness"), organizationalAssignments: [assignment],
      basis, basisOther: value(row, "basisOther"), basisNumber: value(row, "basisNumber"), startDate: value(row, "startDate"), endDate: value(row, "endDate"), status,
      phone, email, experienceYears, experienceNotes: value(row, "experienceText") || rawExperience, availableFrom: value(row, "availableFrom"), availableTo: value(row, "availableTo"),
      hourlyRate: Number(value(row, "hourlyRate").replace(",", ".")) || 0, disclosureAllowed: /^(да|yes|true|1)$/i.test(value(row, "disclosureAllowed")), documents,
      notes: [value(row, "notes"), contacts && !email && !phone ? `Исходные контакты: ${contacts}` : ""].filter(Boolean).join("\n"),
    };
  });
  return { items, issues };
}
