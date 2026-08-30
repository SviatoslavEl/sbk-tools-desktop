import { describe, expect, it, vi } from "vitest";
import {
  BoundedPreviewCache,
  applyGeometryToPages,
  buildFacsimilePlacement,
  buildFacsimilePlacements,
  facsimileAppliesTo,
  facsimileGeometry,
  facsimileOverlayStyle,
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
