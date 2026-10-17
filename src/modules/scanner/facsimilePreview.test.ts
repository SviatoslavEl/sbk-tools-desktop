import { describe, expect, it, vi } from "vitest";
import {
  BoundedPreviewCache,
  applyGeometryToPages,
  buildFacsimilePlacement,
  buildFacsimilePlacements,
  facsimileAppliesTo,
  facsimileGeometry,
  facsimileOverlayStyle,
  facsimilePreviewGeometry,
  previewCacheKey,
  positionFacsimileInRegion,
  suppressLabelActivation,
  updateFacsimileGeometry,
} from "./facsimilePreview";

const editable = {
  imagePath: "C:\\fixtures\\stamp.png",
  imageUrl: "data:image/png;base64,stamp",
  fileName: "stamp.png",
  x: 0.21,
  y: 0.43,
  width: 0.27,
  rotation: -73,
  opacity: 0.64,
  removeLightBackground: true,
};

describe("facsimile preview model", () => {
  const page = { pageAspect: 210 / 297, imageAspect: 1 };
  const inRegion = (patch: Partial<ReturnType<typeof buildFacsimilePlacement>> = {}) => ({
    ...buildFacsimilePlacement(editable, { application: "all", pages: [] }),
    x: 0.1, y: 0.2, width: 40 / 210, rotation: 0,
    region: [0.1, 0.2, 20 / 210, 20 / 297] as [number, number, number, number],
    ...patch,
  });
  const rotatedBounds = (geometry: ReturnType<typeof facsimilePreviewGeometry>, pageAspect: number) => {
    const width = geometry.width * pageAspect, height = geometry.height;
    const angle = geometry.rotation * Math.PI / 180;
    const rotatedWidth = Math.abs(Math.cos(angle)) * width + Math.abs(Math.sin(angle)) * height;
    const rotatedHeight = Math.abs(Math.sin(angle)) * width + Math.abs(Math.cos(angle)) * height;
    const centerX = (geometry.x + geometry.width / 2) * pageAspect, centerY = geometry.y + height / 2;
    return { left: (centerX - rotatedWidth / 2) / pageAspect, top: centerY - rotatedHeight / 2,
      right: (centerX + rotatedWidth / 2) / pageAspect, bottom: centerY + rotatedHeight / 2,
      width: rotatedWidth / pageAspect, height: rotatedHeight };
  };

  it("previews a requested 40 mm stamp fitted to a 20 mm region without altering saved or worker width", () => {
    const placement = inRegion(), before = structuredClone(placement);
    Object.freeze(placement.region); Object.freeze(placement);
    const style = facsimileOverlayStyle(positionFacsimileInRegion(placement, 0), page);
    expect(parseFloat(style.width) / 100 * 210).toBeCloseTo(20, 10);
    expect(parseFloat(style.height!) / 100 * 297).toBeCloseTo(20, 10); expect(style.minHeight).toBe(0);
    expect(placement).toEqual(before); expect(placement.width * 210).toBeCloseTo(40, 10);
  });

  it("fits a wide signature by region height, using the actual image and A4 aspect ratios", () => {
    const geometry = facsimilePreviewGeometry(inRegion({ width: 60 / 210, region: [0.1, 0.2, 100 / 210, 5 / 297] }), { ...page, imageAspect: 4 });
    expect(geometry.width * 210).toBeCloseTo(20, 10); expect(geometry.height * 297).toBeCloseTo(5, 10);
  });

  it("uses a landscape page aspect for a tall image rather than assuming an A4 portrait page or square stamp", () => {
    const geometry = facsimilePreviewGeometry(inRegion({ width: 40 / 297, region: [0.1, 0.2, 50 / 297, 10 / 210] }), { pageAspect: 297 / 210, imageAspect: 0.5 });
    expect(geometry.width * 297).toBeCloseTo(5, 10); expect(geometry.height * 210).toBeCloseTo(10, 10);
  });

  it("fits the rotated bounding box after the first size reduction and clamps all ink into the region", () => {
    const placement = inRegion({ rotation: 45 });
    const geometry = facsimilePreviewGeometry(positionFacsimileInRegion(placement, 0), page);
    expect(geometry.width * 210).toBeCloseTo(20 / Math.SQRT2, 10);
    const bounds = rotatedBounds(geometry, page.pageAspect), [x, y, width, height] = placement.region!;
    expect(bounds.width).toBeCloseTo(width, 10); expect(bounds.height).toBeCloseTo(height, 10);
    expect(bounds.left).toBeCloseTo(x, 10); expect(bounds.top).toBeCloseTo(y, 10);
    expect(bounds.right).toBeCloseTo(x + width, 10); expect(bounds.bottom).toBeCloseTo(y + height, 10);
  });

  it("handles a 90 degree non-square signature with a second height-constrained fit", () => {
    const geometry = facsimilePreviewGeometry(inRegion({ width: 60 / 210, rotation: 90, region: [0.1, 0.2, 40 / 210, 25 / 297] }), { ...page, imageAspect: 4 });
    expect(geometry.width * 210).toBeCloseTo(25, 10); expect(geometry.height * 297).toBeCloseTo(6.25, 10);
    const bounds = rotatedBounds(geometry, page.pageAspect);
    expect(bounds.width * 210).toBeCloseTo(6.25, 10); expect(bounds.height * 297).toBeCloseTo(25, 10);
  });

  it("keeps the worker's pre-resize rotated anchor before the final region clamp, not an invented recentered anchor", () => {
    const placement = inRegion({ x: 0.12, y: 0.23, width: 20 / 210, rotation: 45, region: [0.1, 0.2, 25 / 210, 40 / 297] });
    const geometry = facsimilePreviewGeometry(placement, page), bounds = rotatedBounds(geometry, page.pageAspect);
    const firstBoxMm = 20 * Math.SQRT2;
    const originalLeftMm = placement.x * 210 + (20 - firstBoxMm) / 2;
    const originalTopMm = placement.y * 297 + (20 - firstBoxMm) / 2;
    const expectedLeftMm = Math.max(0.1 * 210, Math.min(originalLeftMm, 0.1 * 210 + 25 - 25));
    const expectedTopMm = Math.max(0.2 * 297, Math.min(originalTopMm, 0.2 * 297 + 40 - 25));
    expect(bounds.left * 210).toBeCloseTo(expectedLeftMm, 10); expect(bounds.top * 297).toBeCloseTo(expectedTopMm, 10);
    expect(geometry.rotation).toBe(45);
  });

  it("leaves manual placements without a region and legacy calls without dimensions unchanged", () => {
    const placement = buildFacsimilePlacement(editable, { application: "current", pages: [0] });
    expect(facsimileOverlayStyle(placement, page)).toEqual(facsimileOverlayStyle(placement));
    expect(facsimileOverlayStyle(inRegion()).width).toBe(`${40 / 210 * 100}%`);
    expect(facsimileOverlayStyle(inRegion(), { pageAspect: Number.NaN, imageAspect: 0 })).toEqual(facsimileOverlayStyle(inRegion()));
  });

  it("does not replace deterministic worker random placement with random positions based on the fitted width", () => {
    const placement = inRegion({ width: 40 / 210, region: [0.1, 0.2, 100 / 210, 10 / 297], randomizeInRegion: true, randomSeed: 77, randomRotationDegrees: 12 });
    const before = structuredClone(placement), first = positionFacsimileInRegion(placement, 0), second = positionFacsimileInRegion(placement, 1);
    const firstGeometry = facsimilePreviewGeometry(first, page), repeatedGeometry = facsimilePreviewGeometry(positionFacsimileInRegion(placement, 0), page);
    expect(firstGeometry).toEqual(repeatedGeometry); expect(first.width).toBe(placement.width); expect(second.x).not.toBe(first.x);
    expect(firstGeometry.rotation).toBe(first.rotation); expect(placement).toEqual(before);
    for (const positioned of [first, second]) {
      const bounds = rotatedBounds(facsimilePreviewGeometry(positioned, page), page.pageAspect), [x, y, width, height] = placement.region!;
      expect(bounds.left + 1e-12).toBeGreaterThanOrEqual(x); expect(bounds.top + 1e-12).toBeGreaterThanOrEqual(y);
      expect(bounds.right - 1e-12).toBeLessThanOrEqual(x + width); expect(bounds.bottom - 1e-12).toBeLessThanOrEqual(y + height);
    }
  });

  it("keeps the latest rotation in both the DOM overlay and worker payload", () => {
    const placement = buildFacsimilePlacement(editable, { application: "current", pages: [2] });
    expect(placement.rotation).toBe(-73);
    expect(placement.opacity).toBe(0.64);
    expect(facsimileOverlayStyle(placement)).toMatchObject({
      left: "21%",
      top: "43%",
      width: "27%",
      transform: "rotate(-73deg)",
      transformOrigin: "center center",
    });
  });

  it("applies current, explicit and all-page placements without a worker refresh", () => {
    const current = buildFacsimilePlacement(editable, { application: "current", pages: [2] });
    const range = buildFacsimilePlacement(editable, { application: "explicitPages", pages: [0, 3] });
    const all = buildFacsimilePlacement(editable, { application: "all", pages: [] });
    expect(facsimileAppliesTo(current, 2)).toBe(true);
    expect(facsimileAppliesTo(current, 1)).toBe(false);
    expect(facsimileAppliesTo(range, 3)).toBe(true);
    expect(facsimileAppliesTo(range, 2)).toBe(false);
    expect(facsimileAppliesTo(all, 99)).toBe(true);
  });

  it("keeps independent geometry for pages in an all-page placement", () => {
    const perPage = updateFacsimileGeometry(editable, 1, { x: 0.72, rotation: 90, opacity: 0.4 });
    const placements = buildFacsimilePlacements(perPage, { application: "all", pages: [] }, 3);
    expect(placements).toHaveLength(2);
    expect(placements.flatMap((placement) => placement.pages)).toEqual([0, 2, 1]);
    expect(placements.find((placement) => placement.pages.includes(1))).toMatchObject({ x: 0.72, rotation: 90, opacity: 0.4 });
    expect(facsimileGeometry(perPage, 0)).toMatchObject({ x: 0.21, rotation: -73, opacity: 0.64 });
  });

  it("groups equal page geometry and can copy the current page to a range", () => {
    const first = updateFacsimileGeometry(editable, 1, { width: 0.5, rotation: 30 });
    const copied = applyGeometryToPages(first, 1, [1, 3, 4]);
    const placements = buildFacsimilePlacements(copied, { application: "explicitPages", pages: [1, 3, 4] }, 5);
    expect(placements).toHaveLength(1);
    expect(placements[0]).toMatchObject({ application: "explicitPages", pages: [1, 3, 4], width: 0.5, rotation: 30 });
  });

  it("retains an all-page region in the final-preview/save payload after rotating just the current page", () => {
    const original = { ...editable, x: 0.62, y: 0.72, width: 40 / 210, rotation: 0,
      placementMode: "region" as const, region: [0.1, 0.29, 20 / 210, 20 / 297] as [number, number, number, number] };
    const edited = updateFacsimileGeometry(original, 0, { rotation: 56 });
    const selection = { application: "all" as const, pages: [] }, before = structuredClone(edited);
    const interactive = buildFacsimilePlacement({ ...edited, ...facsimileGeometry(edited, 0) }, selection);
    const finalPayload = buildFacsimilePlacements(edited, selection, 2);
    expect(finalPayload).toHaveLength(2);
    expect(finalPayload.every((placement) => placement.application === "explicitPages" && placement.region?.join() === original.region.join())).toBe(true);
    const first = finalPayload.find((placement) => facsimileAppliesTo(placement, 0))!;
    expect(first).toMatchObject({ pages: [0], rotation: 56, width: 40 / 210, region: original.region });
    expect(facsimileOverlayStyle(positionFacsimileInRegion(first, 0), page)).toEqual(facsimileOverlayStyle(positionFacsimileInRegion(interactive, 0), page));
    expect(edited).toEqual(before);
  });

  it.each([{ pages: [3] }, { pages: [1, 3] }])("keeps region and random rotation for single-page groups of explicit range $pages", ({ pages }) => {
    const original = { ...editable, placementMode: "random-region" as const,
      region: [0.1, 0.29, 0.2, 0.1] as [number, number, number, number], randomSeed: 91, randomRotationDegrees: 12 };
    const edited = updateFacsimileGeometry(original, 3, { rotation: 56 });
    const selection = { application: "explicitPages" as const, pages };
    const payload = buildFacsimilePlacements(edited, selection, 4);
    for (const pageIndex of pages) {
      const actual = payload.find((placement) => facsimileAppliesTo(placement, pageIndex))!;
      const interactive = buildFacsimilePlacement({ ...edited, ...facsimileGeometry(edited, pageIndex) }, selection);
      expect(actual).toMatchObject({ application: "explicitPages", region: original.region, randomizeInRegion: true, randomRotationDegrees: 12, randomSeed: 91 });
      expect(positionFacsimileInRegion(actual, pageIndex)).toMatchObject({
        x: positionFacsimileInRegion(interactive, pageIndex).x, y: positionFacsimileInRegion(interactive, pageIndex).y,
        rotation: positionFacsimileInRegion(interactive, pageIndex).rotation,
      });
    }
  });

  it("still omits region and random rotation when the original user selection is current-page only", () => {
    const original = { ...editable, placementMode: "random-region" as const,
      region: [0.1, 0.2, 0.3, 0.3] as [number, number, number, number], randomRotationDegrees: 12 };
    const payload = buildFacsimilePlacements(updateFacsimileGeometry(original, 1, { rotation: 56 }), { application: "current", pages: [1] }, 3);
    expect(payload).toHaveLength(1); expect(payload[0]).toMatchObject({ application: "current", pages: [1], rotation: 56, randomizeInRegion: false });
    expect(payload[0].region).toBeUndefined(); expect(payload[0].randomRotationDegrees).toBeUndefined();
  });

  it("uses a compact all-page payload while every page has the same geometry", () => {
    const placements = buildFacsimilePlacements(editable, { application: "all", pages: [] }, 50);
    expect(placements).toHaveLength(1);
    expect(placements[0]).toMatchObject({ application: "all", pages: [] });
  });

  it("uses deterministic per-page positions inside a selected region", () => {
    const placement = buildFacsimilePlacement({
      ...editable,
      placementMode: "random-region" as const,
      region: [0.1, 0.2, 0.6, 0.5] as [number, number, number, number],
      randomSeed: 77,
    }, { application: "all", pages: [] });
    const first = positionFacsimileInRegion(placement, 0);
    const repeated = positionFacsimileInRegion(placement, 0);
    const second = positionFacsimileInRegion(placement, 1);
    expect(first).toMatchObject(repeated);
    expect(first.x).toBeGreaterThanOrEqual(0.1);
    expect(first.x + first.width).toBeLessThanOrEqual(0.7);
    expect(first.y).toBeGreaterThanOrEqual(0.2);
    expect(second.x).not.toBe(first.x);
  });

  it("does not retain a hidden all-page region after switching to one page", () => {
    const placement = buildFacsimilePlacement({
      ...editable,
      placementMode: "region" as const,
      region: [0.1, 0.2, 0.6, 0.5] as [number, number, number, number],
    }, { application: "current", pages: [0] });
    expect(placement.region).toBeUndefined();
    expect(placement.randomizeInRegion).toBe(false);
  });

  it("supports an interactive region and deterministic random rotation for a page range", () => {
    const placement = buildFacsimilePlacement({
      ...editable,
      placementMode: "random-region" as const,
      region: [0.1, 0.2, 0.6, 0.5] as [number, number, number, number],
      randomRotationDegrees: 12,
      randomSeed: 91,
    }, { application: "explicitPages", pages: [1, 3] });
    expect(placement.region).toEqual([0.1, 0.2, 0.6, 0.5]);
    expect(placement.randomizeInRegion).toBe(true);
    expect(positionFacsimileInRegion(placement, 1).rotation).not.toBe(positionFacsimileInRegion(placement, 3).rotation);
  });

  it("keeps an info-button click from activating its surrounding checkbox label", () => {
    const event = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
    suppressLabelActivation(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
  });

  it("supports one logical editable facsimile with unique geometry on 5000 pages", () => {
    let logical = editable;
    for (let page = 0; page < 5_000; page += 1) logical = updateFacsimileGeometry(logical, page, { rotation: page % 360, x: page / 10_000 });
    const placements = buildFacsimilePlacements(logical, { application: "all", pages: [] }, 5_000);
    expect(placements).toHaveLength(5_000);
    expect(facsimileGeometry(logical, 4_999)).toMatchObject({ rotation: 319, x: 0.4999 });
  });

  it("does not include facsimile movement or angle in the document preview cache key", () => {
    const base = { inputPath: "C:\\doc.pdf", preset: "Офисный скан", pageIndex: 0, dpi: 200, quality: 84, pageRotation: 0, redactions: [] };
    expect(previewCacheKey(base)).toBe(previewCacheKey({ ...base }));
  });

  it("evicts old document previews instead of growing memory without a limit", () => {
    const cache = new BoundedPreviewCache<number>(2);
    cache.set("one", 1);
    cache.set("two", 2);
    expect(cache.get("one")).toBe(1);
    cache.set("three", 3);
    expect(cache.get("two")).toBeUndefined();
    expect(cache.get("one")).toBe(1);
    expect(cache.get("three")).toBe(3);
    expect(cache.size).toBe(2);
  });
});
