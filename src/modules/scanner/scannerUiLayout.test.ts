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

  it("показывает инструменты и эффекты рядом с документом", () => {
    const component = readFileSync(new URL("./Scanner.tsx", import.meta.url), "utf8");
    const scannerStyles = readFileSync(new URL("./scanner.css", import.meta.url), "utf8");
    const appStyles = readFileSync(new URL("../../App.css", import.meta.url), "utf8");

    expect(component.match(/className="geometry-control-card"/g)).toHaveLength(1);
    expect(component).toContain("scanner-document-tools");
    expect(component).toContain("DrawingToolIcon");
    expect(component).toContain("Добавленные эффекты");
    expect(component).toContain("Прозрачность / сила");
    expect(component).toContain("updateAnnotationIntensity");
    expect(component).not.toContain("Безвозвратное скрытие");
    expect(component).not.toContain("Точные координаты");
    expect(component).not.toContain("updateAnnotationRect");
    expect(component).not.toContain("updateRedactionRect");
    expect(component).toContain('blur: { color: "#ffffff", intensity: .6, shape: "rectangle" as const }');
    expect(component).toContain('const ellipse = drawingTool === "print_blur"');
    expect(component).not.toContain('drawingTool === "blur" || drawingTool === "print_blur"');
    expect(scannerStyles).toContain(".surface.scanner-controls { position: relative; z-index: 8; min-width: 0; max-width: 100%");
    expect(scannerStyles).toContain(".scanner-document-tools");
    expect(scannerStyles).toContain(".applied-effects-panel");
    expect(scannerStyles).toContain("grid-template-columns: repeat(2, minmax(0, 1fr))");
    expect(appStyles).toContain(".preset-grid { display: grid; min-width: 0; grid-template-columns: repeat(2, minmax(0, 1fr))");
    expect(scannerStyles).not.toContain("repeat(5, minmax(58px, .7fr))");
    expect(appStyles).not.toContain("repeat(4, 70px)");
    expect(component).toContain("Несколько PDF · блоки страниц");
    expect(component).toContain("Добавить блок");
    expect(component).toContain("Сохранить блоки PDF");
    expect(scannerStyles).toContain(".split-block-row { display: grid; min-width: 0;");
    expect(component).toContain("Листы объединяемого документа");
    expect(component).toContain("mergePageOrder");
  });

  it("совпадает по непрозрачности и толщине штриха с итоговым PDF", () => {
    const component = readFileSync(new URL("./Scanner.tsx", import.meta.url), "utf8");
    const scannerStyles = readFileSync(new URL("./scanner.css", import.meta.url), "utf8");
    const worker = readFileSync(new URL("../../../scanner-worker/src/scandocument/annotations.py", import.meta.url), "utf8");
    expect(component).toContain("opacity: entry.intensity");
    expect(component).not.toContain("entry.intensity * .65");
    expect(component).toContain('"--stroke-thickness"');
    expect(scannerStyles).toContain("height: var(--stroke-thickness, 35%)");
    expect(scannerStyles).not.toContain("border-top: 3px solid");
    expect(worker).toContain("round(255 * annotation.intensity)");
    expect(worker).not.toContain("min(0.7, annotation.intensity * 0.65)");
  });

  it("показывает объединение файлов и приветственный экран до инициализации", () => {
    const component = readFileSync(new URL("./Scanner.tsx", import.meta.url), "utf8");
    const app = readFileSync(new URL("../../App.tsx", import.meta.url), "utf8");
    const html = readFileSync(new URL("../../../index.html", import.meta.url), "utf8");

    expect(component).toContain("Объединение файлов");
    expect(component).toContain('operation: "merge"');
    expect(component).toContain("Сборка общего документа");
    expect(component).toContain("mergePreviewUrl");
    expect(component).toContain("Предпросмотр страницы");
    expect(app).toContain("setStartupDelayElapsed(true), 3500");
    expect(html).toContain("Запускаем СБК Инструменты");
    expect(html).toContain("preload-progress");
  });
});
