import { describe, expect, it } from "vitest";
import { detectStaffMapping, mapStaffRows } from "./import";

describe("staff import mapping", () => {
  it("detects common aliases and maps reordered columns", () => {
    const headers = ["Рабочий статус", "Сотрудник", "Роль", "Тип сотрудничества"];
    const mapping = detectStaffMapping(headers);
    const result = mapStaffRows([["Работает", "Петров П.П.", "Инженер", "ГПХ"]], mapping);
    expect(result.issues).toEqual([]);
    expect(result.items[0]).toMatchObject({ fullName: "Петров П.П.", role: "Инженер", basis: "ГПХ", status: "Работает" });
  });

  it("reports unsupported controlled values without silently accepting them", () => {
    const mapping = detectStaffMapping(["ФИО", "Должность", "Основание", "Статус"]);
    const result = mapStaffRows([["Петров", "Инженер", "Неизвестно", "Отпуск"]], mapping);
    expect(result.issues).toHaveLength(2);
  });
});
