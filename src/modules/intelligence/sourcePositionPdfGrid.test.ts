import { describe, expect, it } from "vitest";
import { extractSourcePositionFacts } from "./sourcePositionFacts";
import type { IntelligenceFragment, IntelligenceSource, PdfBounds } from "./workbenchTypes";
const components = (count: number, label: string) => Array.from({ length: count }, (_, index) => `- Компонент ${label} ${index + 1}: ${index + 1} шт;`).join("\n");
const composition = (count: number, label: string) => `Сервер Одинаковая модель в составе:\n${components(count, label)}`;
const grid = (row: number, cells: string[], extra: Partial<IntelligenceFragment> = {}): IntelligenceFragment => {
  const bottom = 900 - row * 200, top = bottom + 200;
  return { id: `page-1-grid-1-row-${row}`, locator: `Страница 1, таблица 1, строка ${row}`, text: cells.join("\t"), pdfGrid: { version: 1, page: 1, bounds: [0, bottom, cells.length * 100, top], cells: cells.map((text, column) => ({ text, bounds: [column * 100, bottom, (column + 1) * 100, top] as PdfBounds })) }, ...extra };
};
const source = (raw = true): IntelligenceSource => {
  const text = `Артикул\n1 QA-100_A шт 2\n2 QA-200_B шт 2\nУсловия оплаты: 100%\n${composition(19, "Альфа")}\n${composition(13, "Бета")}`;
  return { id: "grid-source", name: "Синтетическая таблица QA", text, fragments: [...(raw ? [{ id: "page-1", locator: "Страница 1", text }] : []), grid(1, ["Артикул", "Наименование оборудования предложенного к поставке"]), grid(2, ["QA-100_A", composition(19, "Альфа")]), grid(3, ["QA-200_B", composition(13, "Бета")])] };
};

describe("closed PDF cell SKU-composition provenance", () => {
  it.each([false, true])("binds two identical model names by actual cells and preserves all 19/13 components; raw=%s", (raw) => {
    const input = source(raw), before = structuredClone(input), result = extractSourcePositionFacts([input]);
    expect(result.positions.map((position) => position.sku)).toEqual(["QA-100_A", "QA-200_B"]); expect(result.configurations.map((configuration) => configuration.componentCount)).toEqual([19, 13]);
    expect(result.positions.every((position) => !position.ambiguous && position.associationProof === "pdf-table-row")).toBe(true);
    expect(result.configurations.map((configuration) => configuration.quote)).toEqual([composition(19, "Альфа"), composition(13, "Бета")]);
    for (const fact of [...result.positions, ...result.configurations]) expect(input.fragments!.find((fragment) => fragment.id === fact.fragmentId)?.text).toContain(fact.quote);
    expect(input).toEqual(before);
  });

  it("does not infer a pair from the order or equal count of detached raw blocks", () => {
    const input = source(); input.fragments = input.fragments!.slice(0, 1);
    const result = extractSourcePositionFacts([input]); expect(result.positions.every((position) => position.ambiguous && !position.configurationId)).toBe(true); expect(result.configurations.map((configuration) => configuration.componentCount)).toEqual([19, 13]);
  });

  it("does not erase independent OCR/coverage warnings to establish a geometrically proven association", () => {
    const input = source(); input.coverage = { complete: false, requiresOcr: true, pagesWithImages: [1] }; input.warnings = ["Изображения требуют проверки"];
    const result = extractSourcePositionFacts([input]); expect(result.positions.every((position) => position.associationProof === "pdf-table-row" && !position.ambiguous)).toBe(true); expect(input.coverage.complete).toBe(false); expect(input.warnings).toEqual(["Изображения требуют проверки"]);
  });

  it.each(["hidden", "veryHidden", "gap", "sheet", "table", "page", "duplicate-id", "geometry-gap", "column-shift", "text-mismatch", "bad-cell", "header-role"])("does not borrow closed-row ownership through %s", (change) => {
    const input = source(), fragments = input.fragments!, header = fragments[1], first = fragments[2];
    if (change === "hidden" || change === "veryHidden") { first.sheetState = change; first.includedByUser = true; }
    if (change === "gap") fragments.splice(2, 1);
    if (change === "sheet") first.sheetId = "other-sheet";
    if (change === "table") first.id = "page-1-grid-2-row-2";
    if (change === "page") first.pdfGrid!.page = 2;
    if (change === "duplicate-id") first.id = header.id;
    if (change === "geometry-gap") { first.pdfGrid!.bounds[3] -= 10; for (const cell of first.pdfGrid!.cells) cell.bounds[3] -= 10; }
    if (change === "column-shift") { first.pdfGrid!.cells[0].bounds[2] += 10; first.pdfGrid!.cells[1].bounds[0] += 10; }
    if (change === "text-mismatch") first.text += " Изменено";
    if (change === "bad-cell") first.pdfGrid!.cells[1].bounds[2] = Number.NaN;
    if (change === "header-role") { header.pdfGrid!.cells[0].text = "Номер договора"; header.text = header.pdfGrid!.cells.map((cell) => cell.text).join("\t"); }
    const result = extractSourcePositionFacts([input]); expect(result.positions.some((position) => position.associationProof === "pdf-table-row")).toBe(false);
  });

  it.each(["swapped", "changed-number", "duplicate-sku", "conflicting-source"])("keeps a conflicting explicit raw binding under review instead of replacing it: %s", (change) => {
    const input = source(), fragments = input.fragments!;
    if (change === "swapped") { fragments[0].text = `SKU: QA-100_A\n${composition(13, "Бета")}\nSKU: QA-200_B\n${composition(19, "Альфа")}`; }
    if (change === "changed-number") { fragments[2].pdfGrid!.cells[1].text = composition(19, "Альфа").replace("1 шт", "99 шт"); fragments[2].text = fragments[2].pdfGrid!.cells.map((cell) => cell.text).join("\t"); }
    if (change === "duplicate-sku") { fragments[3].pdfGrid!.cells[0].text = "QA-100_A"; fragments[3].text = fragments[3].pdfGrid!.cells.map((cell) => cell.text).join("\t"); }
    const sources = change === "conflicting-source" ? [input, { ...source(), id: "other-source" }] : [input];
    const result = extractSourcePositionFacts(sources);
    expect(result.positions.find((position) => position.sku === "QA-100_A")?.ambiguous).toBe(true);
  });

  it.each(["fragments", "bytes", "lines"])("charges PDF grid metadata against the existing %s budget before pairing", (kind) => {
    const input = source(false);
    if (kind === "fragments") input.fragments = Array.from({ length: 1001 }, (_, index) => grid(index + 1, ["QA", "Текст"]));
    if (kind === "bytes") input.fragments = Array.from({ length: 40 }, (_, index) => grid(index + 1, ["QA", "я".repeat(19_000)]));
    if (kind === "lines") input.fragments![1] = grid(2, ["QA-100_A", `Сервер QA в составе:\n${"- X\n".repeat(3001)}`]);
    const result = extractSourcePositionFacts([input]); expect(result.truncated).toBe(true); expect(result.positions.some((position) => position.associationProof === "pdf-table-row")).toBe(false);
  });
});
