import { cooperationBases, emptyStaff, workStatuses, type StaffData } from "./types";

export type StaffImportField = "fullName" | "birthDate" | "role" | "grade" | "skills" | "qualification" | "basis" | "basisOther" | "basisNumber" | "startDate" | "endDate" | "status" | "phone" | "email" | "experienceYears" | "availableFrom" | "availableTo" | "hourlyRate" | "disclosureAllowed" | "notes";
export type StaffImportMapping = Record<StaffImportField, number>;

export const staffImportFields: Array<[StaffImportField, string, string[]]> = [
  ["fullName", "ФИО *", ["фио", "сотрудник", "имя"]],
  ["birthDate", "Дата рождения", ["дата рождения", "рождение"]],
  ["role", "Должность / роль *", ["должность", "роль", "должность / роль"]],
  ["grade", "Грейд", ["грейд", "уровень"]],
  ["skills", "Навыки", ["навыки", "компетенции"]],
  ["qualification", "Квалификация", ["квалификация", "специализация"]],
  ["basis", "Основание", ["основание", "тип сотрудничества"]],
  ["basisOther", "Пояснение основания", ["пояснение основания", "иное основание"]],
  ["basisNumber", "Реквизиты основания", ["реквизиты основания", "номер основания", "договор"]],
  ["startDate", "Начало", ["начало", "дата начала"]],
  ["endDate", "Окончание", ["окончание", "дата окончания"]],
  ["status", "Статус", ["статус", "рабочий статус"]],
  ["phone", "Телефон", ["телефон", "phone"]],
  ["email", "Email", ["email", "электронная почта", "почта"]],
  ["experienceYears", "Стаж", ["стаж", "стаж лет", "опыт"]],
  ["availableFrom", "Доступен с", ["доступен с", "занятость с"]],
  ["availableTo", "Доступен до", ["доступен до", "занятость до"]],
  ["hourlyRate", "Ставка", ["ставка", "часовая ставка"]],
  ["disclosureAllowed", "Можно включать в заявку", ["можно включать в заявку", "раскрытие разрешено"]],
  ["notes", "Примечания", ["примечания", "комментарий"]],
];

export function detectStaffMapping(headers: string[]): StaffImportMapping {
  return Object.fromEntries(staffImportFields.map(([key, , aliases]) => [key, headers.findIndex((header) => aliases.includes(header.toLowerCase().trim()))])) as StaffImportMapping;
}

export function mapStaffRows(rows: string[][], mapping: StaffImportMapping): { items: StaffData[]; issues: string[] } {
  const issues: string[] = [];
  const value = (row: string[], key: StaffImportField) => mapping[key] >= 0 ? (row[mapping[key]] || "").trim() : "";
  const items = rows.map((row, rowIndex) => {
    const rawBasis = value(row, "basis");
    const rawStatus = value(row, "status");
    if (rawBasis && !cooperationBases.includes(rawBasis as never)) issues.push(`Строка ${rowIndex + 2}: неизвестное основание «${rawBasis}»`);
    if (rawStatus && !workStatuses.includes(rawStatus as never)) issues.push(`Строка ${rowIndex + 2}: неизвестный статус «${rawStatus}»`);
    return {
      ...emptyStaff(),
      fullName: value(row, "fullName"),
      birthDate: value(row, "birthDate"),
      role: value(row, "role"),
      grade: value(row, "grade"),
      skills: value(row, "skills").split(/[,;]+/).map((skill) => skill.trim()).filter(Boolean),
      qualification: value(row, "qualification"),
      basis: cooperationBases.includes(rawBasis as never) ? rawBasis as StaffData["basis"] : rawBasis ? "Иное" : "Штат",
      basisOther: value(row, "basisOther"),
      basisNumber: value(row, "basisNumber"),
      startDate: value(row, "startDate"),
      endDate: value(row, "endDate"),
      status: workStatuses.includes(rawStatus as never) ? rawStatus as StaffData["status"] : "Работает",
      phone: value(row, "phone"),
      email: value(row, "email"),
      experienceYears: Number(value(row, "experienceYears")) || 0,
      availableFrom: value(row, "availableFrom"),
      availableTo: value(row, "availableTo"),
      hourlyRate: Number(value(row, "hourlyRate").replace(",", ".")) || 0,
      disclosureAllowed: /^(да|yes|true|1)$/i.test(value(row, "disclosureAllowed")),
      notes: value(row, "notes"),
    };
  });
  return { items, issues };
}
