import { describe, expect, it } from "vitest";
import {
  BoundedPreviewCache,
  buildFacsimilePlacement,
  facsimileAppliesTo,
  facsimileOverlayStyle,
  previewCacheKey,
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
