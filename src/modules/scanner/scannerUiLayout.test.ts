// Vitest runs in Node; the application tsconfig intentionally omits Node types.
// @ts-expect-error Node's built-in module is available in the test runner.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("предпросмотр сканера", () => {
  it("разворачивает одностраничный документ без пустой колонки миниатюр", () => {
    const component = readFileSync(new URL("./Scanner.tsx", import.meta.url), "utf8");
    const styles = readFileSync(new URL("../../App.css", import.meta.url), "utf8");

    expect(component).toContain('pageCount > 1 ? "" : "single-page"');
    expect(styles).toContain(".preview-workspace.single-page");
    expect(styles).toContain("grid-template-columns: minmax(0, 1fr)");
  });

  it("показывает готовый PDF в системной папке и ограничивает открываемые пути", () => {
    const component = readFileSync(new URL("./Scanner.tsx", import.meta.url), "utf8");
    const capability = readFileSync(
      new URL("../../../src-tauri/capabilities/default.json", import.meta.url),
      "utf8",
    );

    expect(component).toContain("await revealItemInDir(path)");
    expect(component).toContain("revealGeneratedFile(resultPath)");
    expect(capability).toContain('"path": "$HOME/**"');
    expect(capability).toContain('"path": "$TEMP/**"');
  });
});
