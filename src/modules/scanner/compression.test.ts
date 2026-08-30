import { describe, expect, it } from "vitest";
import { compressionProfile } from "./compression";

describe("scanner compression profiles", () => {
  it("uses the explicit maximum-compression quality floor", () => {
    expect(compressionProfile("maximum")).toEqual({ targetRatio: .25, dpi: 120, quality: 55 });
  });
});
