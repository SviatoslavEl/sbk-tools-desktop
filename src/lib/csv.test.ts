import { describe, expect, it } from "vitest";
import { escapeCsv, parseCsv, toCsv } from "./csv";

describe("CSV safety", () => {
  it("neutralizes spreadsheet formulas", () => {
    expect(escapeCsv("=WEBSERVICE(\"x\")")).toBe('"\'=WEBSERVICE(""x"")"');
    expect(escapeCsv("+1+1")).toBe("'+1+1");
  });

  it("round-trips Russian text and separators", () => {
    expect(parseCsv(toCsv(["Поле"], [["текст; ещё"]]))).toEqual([["Поле"], ["текст; ещё"]]);
  });
});
