import { describe, expect, it } from "vitest";
import { facsimileWidthFromMm, suggestedFacsimileWidthMm } from "./facsimileSize";

describe("physical facsimile sizing", () => {
  it("fits a 40 mm stamp to portrait and landscape A4", () => {
    expect(facsimileWidthFromMm(40, 210) * 210).toBeCloseTo(40);
    expect(facsimileWidthFromMm(40, 297) * 297).toBeCloseTo(40);
  });
  it("fits a signature without using preview zoom or image resolution", () => {
    expect(facsimileWidthFromMm(60, 210) * 210).toBeCloseTo(60);
    expect(suggestedFacsimileWidthMm(1200 / 400)).toBe(60);
    expect(suggestedFacsimileWidthMm(300 / 300)).toBe(40);
  });
  it("rejects invalid dimensions and bounds excessive values", () => {
    expect(() => facsimileWidthFromMm(NaN, 210)).toThrow();
    expect(() => facsimileWidthFromMm(40, 0)).toThrow();
    expect(facsimileWidthFromMm(1000, 210)).toBe(.6);
  });
});
