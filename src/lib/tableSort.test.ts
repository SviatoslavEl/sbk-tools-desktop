import { describe, expect, it } from "vitest";
import { compareSortValues, toggleSort } from "./tableSort";

describe("table sorting", () => {
  it("sorts Russian text and embedded numbers in both directions", () => {
    expect(compareSortValues("Договор 2", "Договор 10", "asc")).toBeLessThan(0);
    expect(compareSortValues("Договор 2", "Договор 10", "desc")).toBeGreaterThan(0);
  });

  it("starts ascending and toggles the active column", () => {
    expect(toggleSort(null, "name")).toEqual({ key: "name", direction: "asc" });
    expect(toggleSort({ key: "name", direction: "asc" }, "name")).toEqual({ key: "name", direction: "desc" });
  });
});
