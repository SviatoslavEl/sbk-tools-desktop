import { describe, expect, it } from "vitest";
import { parseFacsimilePages } from "./facsimilePages";

describe("facsimile page selection", () => {
  it.each(["", "текст", "0", "5-3", "1,,3", "1-"])("rejects invalid explicit range %j", (value) => {
    expect(() => parseFacsimilePages("range", value, 0, 10)).toThrow();
  });

  it("parses 1-3, 5 into zero-based explicit pages", () => {
    expect(parseFacsimilePages("range", "1-3, 5", 0, 10)).toEqual({
      application: "explicitPages",
      pages: [0, 1, 2, 4],
    });
  });

  it("rejects pages outside the document", () => {
    expect(() => parseFacsimilePages("range", "1-3, 11", 0, 10)).toThrow(/только 10/);
  });

  it("never represents an empty explicit selection as all pages", () => {
    expect(parseFacsimilePages("all", "", 0, 10)).toEqual({ application: "all", pages: [] });
    expect(parseFacsimilePages("current", "", 4, 10)).toEqual({ application: "current", pages: [4] });
  });
});
