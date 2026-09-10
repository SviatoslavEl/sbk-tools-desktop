import { describe, expect, it } from "vitest";
import { wheelPreviewZoom } from "./previewViewport";
describe("scanner wheel zoom", () => {
  it("zooms in/up and out/down", () => {
    expect(wheelPreviewZoom(1, -100)).toBeGreaterThan(1);
    expect(wheelPreviewZoom(1, 100)).toBeLessThan(1);
  });
  it("respects the same limits as toolbar zoom", () => {
    expect(wheelPreviewZoom(3, -99999)).toBe(3);
    expect(wheelPreviewZoom(.5, 99999)).toBe(.5);
  });
  it("normalizes line deltas and leaves zero unchanged", () => {
    expect(wheelPreviewZoom(1, 1, 1)).toBe(wheelPreviewZoom(1, 16));
    expect(wheelPreviewZoom(1, 0)).toBe(1);
  });
});
