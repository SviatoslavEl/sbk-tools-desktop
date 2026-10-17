import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
// @ts-expect-error Node's built-in module is available in the test runner.
import { readFileSync } from "node:fs";
import { Scanner } from "./Scanner";

describe("scanner loading controls", () => {
  it("allows the measured canvas to shrink below 240px and bounds ready plus OCR-return panels together", () => {
    const css = readFileSync(new URL("./scanner.css", import.meta.url), "utf8");
    const canvasRule = css.match(/\.scanner-layout \.scanner-preview-scroll > \.preview-workspace\s*\{([^}]+)\}/)?.[1];
    expect(canvasRule).toContain("min-height: 0");
    expect(canvasRule).not.toContain("240px");
    const footerRule = css.match(/\.scanner-result-footer\s*\{([^}]+)\}/)?.[1];
    expect(footerRule).toContain("min-height: 0");
    expect(footerRule).toContain("max-height: var(--scanner-summary-max-height, 30dvh)");
    expect(footerRule).not.toContain("max-height: 40%");
    expect(footerRule).toContain("overflow-y: auto");
  });

  it("keeps arrangement, saving and output tools out of the empty scanner", () => {
    const html = renderToStaticMarkup(<Scanner />);
    expect(html).not.toContain("Итоговый порядок (0)");
    expect(html).not.toContain("Сохранение страниц");
    expect(html).not.toContain("Сохранить PDF");
    expect(html).toMatch(/<button[^>]*class="primary"[^>]*>Выбрать файл<\/button>/);
    expect(html).not.toContain("Выбрать PDF или DOCX");
    for (const label of ["Маркер", "Штрих", "Размытие", "Размытие для печати"]) {
      expect(html).not.toContain(`aria-label="${label}"`);
    }
  });

  it("binds readiness to the actual loaded image and current document/page/rotation/preset", () => {
    const source = readFileSync(new URL("./Scanner.tsx", import.meta.url), "utf8");
    expect(source).toContain("readyPreviewKey === currentPreviewKey && loadedPreviewUrl === displayedPreviewUrl");
    expect(source).toContain('${preset}\\n${dpi}\\n${quality}\\n${compressionMode}');
    expect(source).toContain('${selectedPreset}\\n${dpi}\\n${quality}\\n${compressionMode}');
    expect(source).toContain("setPageCount(0); setPreviewUrl(\"\"); setOriginalUrl(\"\"); setLoadedPreviewUrl(\"\"); setReadyPreviewKey(\"\")");
    expect(source).toContain('setLoadedPreviewUrl(event.currentTarget.getAttribute("src") || "")');
    expect(source).toContain('setPreviewing(true); setReadyPreviewKey("")');
    expect(source).toContain('if (!documentReady || activeJob)');
    expect(source).toContain('inputPath && pageCount > 0 && <ScannerPageControls disabled={!documentReady}');
    expect(source).toContain('documentReady && !showOriginal && annotations.filter');
  });
});
