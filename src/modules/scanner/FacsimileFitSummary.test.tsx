import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FacsimileFitSummary, fittedFacsimileSize } from "./FacsimileFitSummary";
import type { FacsimilePlacementPayload } from "./facsimilePreview";

const placement: FacsimilePlacementPayload = { imagePath: "/qa/stamp.png", imageUrl: "data:image/png;base64,QA", fileName: "stamp.png", x: .1, y: .2, width: 40 / 210, rotation: 0, opacity: 1, removeLightBackground: true, application: "all", pages: [], region: [.1, .2, 20 / 210, 20 / 297] };

describe("physical facsimile fit explanation does not rewrite the requested size", () => {
  it("distinguishes a requested40mm stamp from a20mm image fitted to its region", () => {
    const before = structuredClone(placement);
    const size = fittedFacsimileSize(placement, 0, [210, 297], 1)!;
    expect(size.requestedWidthMm).toBeCloseTo(40); expect(size.widthMm).toBeCloseTo(20); expect(size.heightMm).toBeCloseTo(20); expect(size.reduced).toBe(true);
    const html = renderToStaticMarkup(<FacsimileFitSummary placement={placement} pageIndex={0} pageSizeMm={[210, 297]} imageAspect={1} />);
    expect(html).toContain("≈ 20 × 20 мм"); expect(html).toContain("уменьшено до области"); expect(html).toContain("Задано по ширине: 40 мм");
    expect(html).toContain("без рамки поворота"); expect(placement).toEqual(before);
  });

  it("keeps image proportions and explains additional fitting after rotation", () => {
    const rotated = { ...placement, rotation: 55 };
    const size = fittedFacsimileSize(rotated, 2, [210, 297], 4)!;
    expect(size.widthMm).toBeLessThan(40); expect(size.widthMm / size.heightMm).toBeCloseTo(4); expect(size.reduced).toBe(true);
    const html = renderToStaticMarkup(<FacsimileFitSummary placement={rotated} pageIndex={2} pageSizeMm={[210, 297]} imageAspect={4} />);
    expect(html).toContain("На стр. 3"); expect(html).toContain("на других страницах вписывание может отличаться");
  });

  it("does not invent physical sizes while page dimensions are unknown, and reports an unfitted image honestly", () => {
    expect(renderToStaticMarkup(<FacsimileFitSummary placement={placement} pageIndex={0} pageSizeMm={null} imageAspect={4} />)).toBe("");
    expect(fittedFacsimileSize(placement, 0, [0, 297], 1)).toBeNull();
    const largeRegion = { ...placement, region: [.1, .2, .5, .5] as [number, number, number, number] };
    const html = renderToStaticMarkup(<FacsimileFitSummary placement={largeRegion} pageIndex={0} pageSizeMm={[210, 297]} imageAspect={4} />);
    expect(html).toContain("≈ 40 × 10 мм"); expect(html).toContain("без уменьшения");
  });
});
