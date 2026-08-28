import { describe, expect, it } from "vitest";
import { buildOutputPageOrder, parseOutputPages } from "./outputPages";

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
});
