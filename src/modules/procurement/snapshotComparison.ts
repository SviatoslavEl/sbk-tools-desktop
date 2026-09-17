import type { SnapshotLink } from "./types";

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`).join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}

export function snapshotDifferences(snapshot: SnapshotLink["snapshot"], current: unknown) {
  if (!current || typeof current !== "object" || Array.isArray(current)) return null;
  const payload = current as Record<string, unknown>;
  return [...new Set([...Object.keys(snapshot), ...Object.keys(payload)])].filter((key) => stable(snapshot[key]) !== stable(payload[key])).map((key) => ({ key, snapshot: snapshot[key], current: payload[key] }));
}

export function snapshotValue(value: unknown) {
  if (value == null || value === "") return "Не указано";
  if (typeof value === "boolean") return value ? "Да" : "Нет";
  return typeof value === "object" ? JSON.stringify(value, null, 2) : String(value);
}

export const snapshotFieldLabels: Record<string, string> = {
  number: "Номер", fullName: "ФИО", name: "Название", customer: "Заказчик", subject: "Предмет", role: "Роль", grade: "Грейд", skills: "Навыки", basis: "Основание сотрудничества", qualification: "Квалификация", documents: "Документы", startDate: "Дата начала", endDate: "Дата окончания", availableFrom: "Доступен с", availableTo: "Доступен до", disclosureAllowed: "Разрешение на раскрытие", paymentStatus: "Оплата", stage: "Стадия договора", amount: "Сумма", cost: "Себестоимость", notes: "Примечания", attachments: "Вложения", contact: "Контакт", price: "Цена", margin: "Маржа",
};
