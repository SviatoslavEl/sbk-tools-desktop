import { describe, expect, it } from "vitest";
import { buildOutputPageBlocks, buildOutputPageOrder, parseOutputPages, safeOutputBlockName } from "./outputPages";

describe("output PDF page selection", () => {
  it("selects positions in the current output order after user reordering and deletions", () => {
    expect(buildOutputPageOrder([3, 0, 4, 1], "range", "1-2, 4", 5)).toEqual([3, 0, 1]);
    expect(buildOutputPageOrder([3, 0, 4, 1], "all", "", 5)).toEqual([3, 0, 4, 1]);
  });

  it("rejects an empty explicit range", () => {
    expect(() => parseOutputPages("range", "  ", 4)).toThrow("Укажите страницы итогового PDF");
  });

  it("rejects pages outside the document and reverse ranges", () => {
    expect(() => parseOutputPages("range", "1, 5", 4)).toThrow("только 4 стр");
    expect(() => parseOutputPages("range", "4-2", 4)).toThrow("Обратный диапазон");
  });

  it("rejects direct and overlapping repetitions", () => {
    expect(() => parseOutputPages("range", "1, 1", 4)).toThrow("повторно");
    expect(() => parseOutputPages("range", "1-3, 3-4", 4)).toThrow("Страница 3 указана повторно");
  });

  it("validates against the current output length rather than removed source pages", () => {
    expect(buildOutputPageOrder([4, 1], "range", "2", 5)).toEqual([1]);
    expect(() => buildOutputPageOrder([4, 1], "range", "3", 5)).toThrow("только 2 стр");
  });

  it("builds independent named blocks from arbitrary page ranges", () => {
    expect(buildOutputPageBlocks([3, 0, 4, 1], [
      { id: "a", name: "Договор", pageRange: "1-2, 4" },
      { id: "b", name: "Приложения", pageRange: "3" },
    ], 5)).toEqual([
      { id: "a", name: "Договор", fileName: "Договор", order: [3, 0, 1] },
      { id: "b", name: "Приложения", fileName: "Приложения", order: [4] },
    ]);
  });

  it("allows a page in several blocks but rejects empty, unsafe and duplicate names", () => {
    expect(buildOutputPageBlocks([0, 1, 2], [
      { id: "a", name: "Первый", pageRange: "1-2" },
      { id: "b", name: "Второй", pageRange: "2-3" },
    ], 3).map((block) => block.order)).toEqual([[0, 1], [1, 2]]);
    expect(() => buildOutputPageBlocks([0], [], 1)).toThrow("хотя бы один блок");
    expect(() => buildOutputPageBlocks([0], [{ id: "a", name: "  ", pageRange: "1" }], 1)).toThrow("название блока 1");
    expect(() => buildOutputPageBlocks([0], [
      { id: "a", name: "Блок", pageRange: "1" },
      { id: "b", name: "блок", pageRange: "1" },
    ], 1)).toThrow("используется повторно");
    expect(safeOutputBlockName('  Договор: часть / 1?.  ')).toBe("Договор часть 1");
  });
});
