import { describe, expect, it } from "vitest";
import { applyImportReviewOverrides, buildImportReviewOverride, clearImportRowIssues, currentImportReviewIndex, importProblemRows, missingImportFields, nextImportProblemIndex, replaceImportReviewRow } from "./importReview";
import { normalizeStaffData } from "../modules/staff/Staff";
import type { StaffData } from "../modules/staff/types";

describe("поштучное дополнение импорта", () => {
  it("изменяет только выбранную запись", () => {
    const source = [{ id: "a", name: "Первый" }, { id: "b", name: "Второй" }, { id: "c", name: "Третий" }];
    const updated = replaceImportReviewRow(source, 1, { id: "b", name: "Исправленный" });
    expect(updated).toEqual([{ id: "a", name: "Первый" }, { id: "b", name: "Исправленный" }, { id: "c", name: "Третий" }]);
    expect(updated[0]).toBe(source[0]);
    expect(updated[2]).toBe(source[2]);
  });

  it("не изменяет список при недопустимом индексе", () => {
    const source = [{ id: "a" }, { id: "b" }];
    expect(replaceImportReviewRow(source, 3, { id: "x" })).toEqual(source);
  });

  it("сохраняет поштучные правки после повторного сопоставления колонок", () => {
    const reparsed = [{ name: "Первый из файла" }, { name: "Второй из файла" }];
    const reviewed = new Map([[1, { name: "Второй, дополненный вручную" }]]);
    expect(applyImportReviewOverrides(reparsed, reviewed)).toEqual([
      { name: "Первый из файла" },
      { name: "Второй, дополненный вручную" },
    ]);
  });

  it("сохраняет только действительно изменённые вручную поля", () => {
    const baseline = { name: "Анна", company: "Из файла", role: "Аудитор" };
    const edited = { ...baseline, company: "ООО СБК" };
    const override = buildImportReviewOverride(baseline, edited);
    expect(override).toEqual({ company: "ООО СБК" });
    expect(applyImportReviewOverrides([{ ...baseline, role: "Ведущий аудитор" }], new Map([[0, override]]))).toEqual([
      { name: "Анна", company: "ООО СБК", role: "Ведущий аудитор" },
    ]);
  });

  it("возвращает только отсутствующие поля и только проблемные строки", () => {
    const required = [
      { key: "company", label: "Юрлицо", missing: (item: { company: string; role: string }) => !item.company.trim() },
      { key: "role", label: "Должность", missing: (item: { company: string; role: string }) => !item.role.trim() },
    ];
    const rows = [{ company: "", role: "Аудитор" }, { company: "ООО СБК", role: "" }, { company: "ООО СБК", role: "Аудитор" }];
    expect(missingImportFields(rows[0], required)).toEqual([{ key: "company", label: "Юрлицо" }]);
    expect(importProblemRows(rows, (item) => missingImportFields(item, required).map((field) => field.label)).map(({ index, issues }) => ({ index, issues }))).toEqual([
      { index: 0, issues: ["Юрлицо"] },
      { index: 1, issues: ["Должность"] },
    ]);
  });

  it("снимает ошибки только с подтверждённой исходной строки", () => {
    const issues = ["Строка 2: нет ФИО", "Строка 3: нет отдела", "Общая ошибка файла"];
    expect(clearImportRowIssues(issues, 2)).toEqual(["Строка 3: нет отдела", "Общая ошибка файла"]);
  });

  it("переходит к следующей проблемной строке только по явному подтверждению", () => {
    expect(nextImportProblemIndex([1, 4, 8], 1)).toBe(4);
    expect(nextImportProblemIndex([1, 8], 4)).toBe(8);
    expect(nextImportProblemIndex([1], 4)).toBe(1);
    expect(nextImportProblemIndex([], 4)).toBeNull();
  });

  it("удерживает активную строку, когда первый введённый символ снимает ошибку пустого поля", () => {
    expect(currentImportReviewIndex(null, [0, 1], 2)).toBe(0);
    expect(currentImportReviewIndex(0, [1], 2)).toBe(0);
    expect(currentImportReviewIndex(0, [], 2)).toBe(0);
    expect(currentImportReviewIndex(5, [1], 2)).toBe(1);
  });

  it("нормализует legacy-карточку до поиска, списка и экспорта", () => {
    const legacy = { fullName: "Иванов Иван", role: "Аудитор", basis: "Трудовой договор", status: "Работает" } as StaffData;
    const normalized = normalizeStaffData(legacy);
    expect(normalized.documents).toEqual([]);
    expect(normalized.skills).toEqual([]);
    expect(normalized.competencies).toEqual([]);
    expect(normalized.industries).toEqual([]);
    expect(normalized.organizationalAssignments).toHaveLength(1);
    expect(normalized.organizationalAssignments[0].position).toBe("Аудитор");
  });
});
