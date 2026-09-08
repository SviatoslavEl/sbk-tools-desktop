export interface FieldChange { field: string; before: string; after: string }
const labels: Record<string, string> = {
  name: "Название", fullName: "ФИО", number: "Номер", customer: "Заказчик", performer: "Исполнитель",
  amount: "Сумма", paidAmount: "Оплачено", stage: "Стадия", paymentStatus: "Оплата", actsStatus: "Акты",
  startDate: "Дата начала", endDate: "Дата окончания", notes: "Примечание", responsible: "Ответственный",
  contact: "Контакт", phone: "Телефон", email: "E-mail", position: "Должность", department: "Отдел",
  legalEntity: "Юрлицо", documents: "Документы", assignments: "Места работы", basis: "Основание",
  status: "Статус", inn: "ИНН", kpp: "КПП", ogrn: "ОГРН", address: "Адрес", shortName: "Краткое название",
  scope: "Внутренняя / внешняя", decisionMakers: "Лица, принимающие решения", authorizedSigners: "Право подписи",
  fileName: "Имя файла", archived: "Архив", disclosureAllowed: "Раскрытие разрешено",
  grade: "Грейд", skills: "Навыки", qualification: "Квалификация", birthDate: "Дата рождения",
  specialization: "Специализация", city: "Город", cooperationBasis: "Основание сотрудничества",
  subject: "Предмет договора", date: "Дата", performingLegalEntity: "Юрлицо-исполнитель",
  ourAmount: "Стоимость нашей части", industry: "Отрасль", serviceType: "Вид услуги", standards: "Стандарты",
  scopeOfWork: "Состав работ", contractRole: "Роль в договоре", nextImportantDate: "Ближайшая важная дата",
  plannedPaymentDate: "Плановая дата оплаты", actualPaymentDate: "Фактическая дата оплаты",
  mainSpecialization: "Основная специализация", additionalSpecializations: "Дополнительные специализации",
  keyCompetencies: "Ключевые компетенции", industryExperience: "Отраслевой опыт", engagementType: "Основание сотрудничества",
};
function flatten(value: unknown, path = "", output: Record<string, string> = {}) {
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    if (!entries.length && path) output[path] = "—";
    for (const [key, nested] of entries) {
      if (["id", "createdAt", "updatedAt", "schemaVersion"].includes(key)) continue;
      flatten(nested, [path, labels[key] || (/^\d+$/.test(key) ? `№ ${Number(key) + 1}` : key)].filter(Boolean).join(" / "), output);
    }
  } else output[path] = value == null || value === "" ? "—" : typeof value === "boolean" ? (value ? "Да" : "Нет") : String(value);
  return output;
}
export function historyChanges(before: unknown, after: unknown): FieldChange[] {
  const left = flatten(before), right = flatten(after);
  return [...new Set([...Object.keys(left), ...Object.keys(right)])].sort().flatMap((field) =>
    (left[field] ?? "—") === (right[field] ?? "—") ? [] : [{ field, before: left[field] ?? "—", after: right[field] ?? "—" }]);
}
