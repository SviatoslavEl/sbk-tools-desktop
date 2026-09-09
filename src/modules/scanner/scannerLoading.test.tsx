import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
// @ts-expect-error Node's built-in module is available in the test runner.
import { readFileSync } from "node:fs";
import { Scanner } from "./Scanner";

describe("scanner loading controls", () => {
  it("does not offer zero-page arrangement and keeps save/tools disabled before a document is ready", () => {
    const html = renderToStaticMarkup(<Scanner />);
    expect(html).not.toContain("Итоговый порядок (0)");
    expect(html).not.toContain("Сохранение страниц");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Сохранить PDF<\/button>/);
    for (const label of ["Маркер", "Штрих", "Размытие", "Размытие для печати"]) {
      expect(html).toMatch(new RegExp(`<button[^>]*aria-label="${label}"[^>]*disabled=""`));
    }
  });

  it("binds readiness to the actual loaded image and current document/page/rotation/preset", () => {
    const source = readFileSync(new URL("./Scanner.tsx", import.meta.url), "utf8");
    expect(source).toContain("readyPreviewKey === currentPreviewKey && loadedPreviewUrl === displayedPreviewUrl");
    expect(source).toContain("setPageCount(0); setPreviewUrl(\"\"); setOriginalUrl(\"\"); setLoadedPreviewUrl(\"\"); setReadyPreviewKey(\"\")");
    expect(source).toContain('setLoadedPreviewUrl(event.currentTarget.getAttribute("src") || "")');
    expect(source).toContain('setPreviewing(true); setReadyPreviewKey("")');
    expect(source).toContain('if (!documentReady || activeJob)');
    expect(source).toContain('inputPath && pageCount > 0 && <fieldset disabled={!documentReady}');
    expect(source).toContain('documentReady && !showOriginal && annotations.filter');
  });
});
