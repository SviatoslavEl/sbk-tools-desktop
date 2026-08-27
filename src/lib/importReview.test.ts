import { describe, expect, it } from "vitest";
import { applyImportReviewOverrides, clearImportRowIssues, replaceImportReviewRow } from "./importReview";

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

  it("снимает ошибки только с подтверждённой исходной строки", () => {
    const issues = ["Строка 2: нет ФИО", "Строка 3: нет отдела", "Общая ошибка файла"];
    expect(clearImportRowIssues(issues, 2)).toEqual(["Строка 3: нет отдела", "Общая ошибка файла"]);
  });
});
