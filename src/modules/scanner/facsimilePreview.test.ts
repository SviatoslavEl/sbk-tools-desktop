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

  it("keeps an info-button click from activating its surrounding checkbox label", () => {
    const event = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
    suppressLabelActivation(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
  });

  it("supports one logical editable facsimile with unique geometry on 200 pages", () => {
    let logical = editable;
    for (let page = 0; page < 200; page += 1) logical = updateFacsimileGeometry(logical, page, { rotation: page, x: page / 1000 });
    const placements = buildFacsimilePlacements(logical, { application: "all", pages: [] }, 200);
    expect(placements).toHaveLength(200);
    expect(facsimileGeometry(logical, 199)).toMatchObject({ rotation: 199, x: 0.199 });
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
