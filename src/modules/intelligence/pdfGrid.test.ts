import { describe, expect, it } from "vitest";
import { validPdfGridFragment } from "./pdfGrid";
import { assertResponsePreparationSources } from "./responsePreparationBounds";
import { buildIntelligencePrompt } from "./workbenchModel";
import type { IntelligenceFragment, IntelligenceSource } from "./workbenchTypes";

const row = (): IntelligenceFragment => ({ id: "page-1-grid-1-row-1", locator: "Страница 1, таблица 1, строка 1", text: "Артикул\tНаименование", pdfGrid: { version: 1, page: 1, bounds: [10, 10, 100, 30], cells: [{ bounds: [10, 10, 40, 30], text: "Артикул" }, { bounds: [40, 10, 100, 30], text: "Наименование" }] } });
const source = (fragment = row()): IntelligenceSource => ({ id: "qa", name: "QA.pdf", text: fragment.text, fragments: [fragment] });

describe("bounded PDF grid snapshot transport", () => {
  it("retains exact closed row cells in prompt and parse snapshot", () => {
    const input = source(), before = structuredClone(input);
    expect(validPdfGridFragment(input.fragments![0])).toBe(true);
    expect(() => assertResponsePreparationSources([input])).not.toThrow();
    expect(buildIntelligencePrompt("КП", [input], ["proposals"])).toContain('"pdfGrid":{"version":1');
    expect(input).toEqual(before);
  });
  it.each(["page", "text", "overlap", "gap", "infinite", "extra", "tab", "many", "oversized", "rectangle"])('rejects malformed %s without erasing it', (variant) => {
    const fragment = row(), grid = fragment.pdfGrid!;
    switch (variant) {
      case "page": grid.page = 2; break;
      case "text": fragment.text += " changed"; break;
      case "overlap": grid.cells[1].bounds[0] = 30; break;
      case "gap": grid.cells[1].bounds[0] = 45; break;
      case "infinite": grid.bounds[3] = Infinity; break;
      case "extra": Object.assign(grid, { arbitrary: true }); break;
      case "tab": grid.cells[0].text += "\t"; fragment.text = grid.cells.map((cell) => cell.text).join("\t"); break;
      case "many": grid.cells = Array(65).fill(grid.cells[0]); break;
      case "oversized": grid.cells[0].text = "x".repeat(20_001); break;
      case "rectangle": grid.cells[0].bounds[2] = 9; break;
    }
    const before = structuredClone(fragment);
    expect(validPdfGridFragment(fragment)).toBe(false);
    expect(() => assertResponsePreparationSources([source(fragment)])).toThrow(/формат фрагментов/u);
    expect(fragment).toEqual(before);
  });
  it("does not send excluded hidden grid rows", () => {
    const hidden = { ...row(), sheetState: "hidden" as const };
    expect(buildIntelligencePrompt("КП", [source(hidden)], ["proposals"])).not.toContain('"pdfGrid"');
  });
  it("retains an OCR-layer marker and incomplete-source warning, never an accuracy acknowledgement", () => {
    const input = source(); input.fragments![0].pdfGrid!.textLayer = "ocr";
    input.coverage = { complete: false, requiresOcr: true }; input.warnings = ["Текст OCR требует сверки"];
    expect(() => assertResponsePreparationSources([input])).not.toThrow();
    const prompt = buildIntelligencePrompt("КП", [input], ["proposals"]);
    expect(prompt).toContain('"textLayer":"ocr"'); expect(prompt).toContain('"complete":false'); expect(prompt).toContain("Текст OCR требует сверки");
    Object.assign(input.fragments![0].pdfGrid!, { textLayer: "model-confirmed" });
    expect(validPdfGridFragment(input.fragments![0])).toBe(false);
  });
});
