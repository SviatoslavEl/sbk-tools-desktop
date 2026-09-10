// Vitest runs in Node; the application tsconfig intentionally omits Node types.
// @ts-expect-error Node's built-in module is available in the test runner.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("предпросмотр сканера", () => {
  it("резервирует строку эффектов до первого рисунка и сворачивает список до начала жеста", () => {
    const component = readFileSync(new URL("./Scanner.tsx", import.meta.url), "utf8");
    const effectsLine = component.split("\n").find((line: string) => line.includes('className="applied-effects-panel"'));
    expect(effectsLine).toContain("inputPath && <fieldset");
    expect(effectsLine).not.toContain("annotations.length > 0 &&");
    expect(effectsLine).toContain("!annotations.length) event.preventDefault(); else setDrawingTool(null)");
    const toolsLine = component.split("\n").find((line: string) => line.includes('className="scanner-document-tools"'));
    expect(toolsLine).toContain("effectsPanel.current.open = false; setDrawingTool");
  });

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

    expect(component).toContain('"open_scanner_output", { path, reveal: action === "reveal" }');
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
    expect(component).toContain('marker: "Непрозрачность"');
    expect(component).toContain('stroke: "Непрозрачность"');
    expect(component).toContain('blur: "Сила размытия"');
    expect(component).toContain('print_blur: "Сила размытия"');
    expect(component).toContain("Непрозрачность на всех выбранных страницах");
    expect(component).toContain('${drawingIntensityLabels[entry.kind]} «${drawingToolLabels[entry.kind]}», страница ${entry.page + 1}');
    expect(component).not.toContain("Прозрачность / сила");
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
    expect(component).not.toContain('"--stroke-thickness"');
    expect(scannerStyles).toContain(".annotation-overlay.stroke::before { content: \"\"; position: absolute; inset: 0; background: currentColor; border-radius: 999px;");
    expect(scannerStyles).not.toContain("var(--stroke-thickness");
    expect(scannerStyles).not.toContain("border-top: 3px solid");
    expect(worker).toContain("round(255 * annotation.intensity)");
    expect(worker).not.toContain("min(0.7, annotation.intensity * 0.65)");
    expect(worker).not.toContain("annotation.intensity * 0.35");
    expect(worker).toContain("radius=min(right - left, bottom - top) / 2");
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
    expect(app).toContain("installedFastStart");
    expect(app).toContain("if (installedFastStart) return;");
    expect(app).toContain("setStartupDelayElapsed(true), 3500");
    expect(app).toContain("getStartupStatus");
    expect(app).toContain("reportStartupUiVisible");
    expect(app).toContain("Проверяем рабочую папку");
    expect(app).toContain("Открываем базы данных");
    expect(app).toContain("Выбрать другую папку");
    expect(app).toContain("Повторить");
    expect(html).toContain("Запускаем СБК Инструменты");
    expect(html).toContain("preload-progress");
  });
});
