import { describe, expect, it } from "vitest";
import { historyChanges } from "./historyDiff";
describe("history field comparison", () => {
  it("compares scalar fields without treating metadata as business changes", () => {
    expect(historyChanges({ id: "a", name: "До", updatedAt: "yesterday" }, { id: "a", name: "После", updatedAt: "now" })).toEqual([{ field: "Название", before: "До", after: "После" }]);
  });
  it("shows document changes, booleans and deleted values", () => {
    const changes = historyChanges({ documents: [{ fileName: "старый.pdf" }], archived: false, inn: "123" }, { documents: [{ fileName: "новый.pdf" }], archived: true });
    expect(changes).toContainEqual({ field: "Документы / № 1 / Имя файла", before: "старый.pdf", after: "новый.pdf" });
    expect(changes).toContainEqual({ field: "Архив", before: "Нет", after: "Да" });
    expect(changes).toContainEqual({ field: "ИНН", before: "123", after: "—" });
  });
  it("does not invent changes for equal payloads", () => expect(historyChanges({ name: "A" }, { name: "A" })).toEqual([]));
});
