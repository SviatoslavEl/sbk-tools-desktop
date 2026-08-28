import { describe, expect, it } from "vitest";
import { buildPageWindow } from "./pageNavigation";

describe("large document page navigation", () => {
  it("never renders thousands of page buttons", () => {
    const order = Array.from({ length: 5_000 }, (_, index) => index);
    const result = buildPageWindow(order, 2_500);
    expect(result.pages.length).toBeLessThanOrEqual(17);
    expect(result.pages).toContain(2_500);
    expect(result.omittedBefore).toBeGreaterThan(2_000);
    expect(result.omittedAfter).toBeGreaterThan(2_000);
  });

  it("preserves custom final order", () => {
    expect(buildPageWindow([4, 2, 0, 1, 3], 0, 8).pages).toEqual([4, 2, 0, 1, 3]);
  });
});
