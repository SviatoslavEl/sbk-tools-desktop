import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ScannerSizeSummary, scannerSizeSummary, totalScannerOutputBytes, type ScannerResultSize } from "./ScannerSizeSummary";

const split: ScannerResultSize = {
  inputPath: "/qa/source.pdf", resultPath: "/qa/blocks", kind: "split",
  originalBytes: 1000, outputBytes: totalScannerOutputBytes([600, 800]), fileCount: 2,
};
const props = {
  inputPath: split.inputPath, resultPath: split.resultPath, resultKind: "split" as const,
  originalBytes: 1000, estimatedOutputBytes: 700, savedResult: split,
};

describe("saved scanner output sizes", () => {
  it("compares the sum of every saved block, not the old 30% preview estimate", () => {
    const summary = scannerSizeSummary(props);
    expect(summary.outputBytes).toBe(1400);
    expect(summary.savingsPercent).toBeCloseTo(-40);
    const html = renderToStaticMarkup(<ScannerSizeSummary {...props} />);
    expect(html).toContain("Общий размер сохранённых блоков (2 PDF)");
    expect(html).toContain("Больше на 40%");
    expect(html).toContain("Сумма всех блоков сравнивается с полным исходным документом.");
    expect(html).not.toContain("примерно");
    expect(html).not.toContain("≈");
  });

  it("keeps actual source/output sizes together after page or preset previews change", () => {
    const summary = scannerSizeSummary({ ...props, originalBytes: 3000, estimatedOutputBytes: 100 });
    expect(summary.originalBytes).toBe(1000);
    expect(summary.outputBytes).toBe(1400);
    expect(summary.savingsPercent).toBeCloseTo(-40);
  });

  it.each([[], [600, undefined], [600, 0], [600, -1], [600, NaN], [600, Infinity], [600, .5], [Number.MAX_SAFE_INTEGER, 1]].map((files) => ({ files })))("does not advertise a partial or invalid group size: $files", ({ files }) => {
    expect(totalScannerOutputBytes(files)).toBeNull();
  });

  it("labels a completed output without reliable sizes as unknown, not the preview estimate", () => {
    const incomplete = { ...split, outputBytes: totalScannerOutputBytes([600, undefined]) };
    const summary = scannerSizeSummary({ ...props, savedResult: incomplete });
    expect(summary.outputBytes).toBeNull();
    expect(summary.savingsPercent).toBeNull();
    const html = renderToStaticMarkup(<ScannerSizeSummary {...props} savedResult={incomplete} />);
    expect(html).toContain("не получен");
    expect(html).not.toContain("30%");
    expect(html).not.toContain("≈");
  });

  it.each([
    { inputPath: "/qa/another.pdf" },
    { resultPath: "/qa/another-output" },
    { resultKind: "single" as const },
  ])("does not attach saved sizes to another input, result, or output kind: %j", (change) => {
    const summary = scannerSizeSummary({ ...props, ...change });
    expect(summary.outputBytes).toBeNull();
    expect(summary.savingsPercent).toBeNull();
  });

  it("returns to a genuine preview estimate after the saved-result view is cleared", () => {
    const previewProps = { ...props, resultPath: "", resultKind: "" as const };
    const summary = scannerSizeSummary(previewProps);
    expect(summary.outputBytes).toBe(700);
    expect(summary.savingsPercent).toBeCloseTo(30);
    const html = renderToStaticMarkup(<ScannerSizeSummary {...previewProps} />);
    expect(html).toContain("Оценка результата");
    expect(html).toContain("Меньше примерно на 30%");
    expect(html).toContain("≈");
  });

  it("handles a single saved PDF with the same consistent actual-size calculation", () => {
    const savedResult: ScannerResultSize = { ...split, kind: "single", fileCount: 1, originalBytes: 1100, outputBytes: 770 };
    const singleProps = { ...props, resultKind: "single" as const, savedResult };
    expect(scannerSizeSummary(singleProps).savingsPercent).toBeCloseTo(30);
    const html = renderToStaticMarkup(<ScannerSizeSummary {...singleProps} />);
    expect(html).toContain("Размер сохранённого PDF");
    expect(html).toContain("Меньше на 30%");
    expect(html).not.toContain("примерно");
  });
});
