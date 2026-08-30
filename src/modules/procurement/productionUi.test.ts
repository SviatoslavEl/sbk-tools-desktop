// Vitest runs in Node; the application tsconfig intentionally omits Node types.
// @ts-expect-error Node's built-in module is available in the test runner.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("рабочий реестр закупок", () => {
  it("не содержит автозасев или кнопку добавления демонстрационных записей", () => {
    const source = readFileSync(
      new URL("./Procurement.tsx", import.meta.url),
      "utf8",
    );
    expect(source).not.toContain("demoProcurements");
    expect(source).not.toContain("Добавить демо");
    expect(source).not.toContain("demo-procurements-v1");
  });
});
