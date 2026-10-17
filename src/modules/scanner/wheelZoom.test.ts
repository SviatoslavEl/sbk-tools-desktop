import { describe, expect, it } from "vitest";
import { clampPreviewZoom, MAX_PREVIEW_ZOOM, MIN_PREVIEW_ZOOM, previewZoomLabel, wheelPreviewZoom } from "./previewViewport";
describe("scanner wheel zoom", () => {
  it("zooms in/up and out/down", () => {
    expect(wheelPreviewZoom(1, -100)).toBeGreaterThan(1);
    expect(wheelPreviewZoom(1, 100)).toBeLessThan(1);
  });
  it("respects the same limits as toolbar zoom", () => {
    expect(wheelPreviewZoom(MAX_PREVIEW_ZOOM, -99999)).toBe(MAX_PREVIEW_ZOOM);
    expect(wheelPreviewZoom(MIN_PREVIEW_ZOOM, 99999)).toBe(MIN_PREVIEW_ZOOM);
    expect(wheelPreviewZoom(MAX_PREVIEW_ZOOM, -99999)).toBe(clampPreviewZoom(MAX_PREVIEW_ZOOM + .25));
    expect(wheelPreviewZoom(MIN_PREVIEW_ZOOM, 99999)).toBe(clampPreviewZoom(MIN_PREVIEW_ZOOM - .25));
  });
  it("normalizes line deltas and leaves zero unchanged", () => {
    expect(wheelPreviewZoom(1, 1, 1)).toBe(wheelPreviewZoom(1, 16));
    expect(wheelPreviewZoom(1, 0)).toBe(1);
  });
  it("keeps a tiny positive fit scale readable instead of claiming zero percent", () => {
    expect(previewZoomLabel(.001)).toBe("0,1%");
    expect(previewZoomLabel(.00001)).toBe("0,001%");
    expect(previewZoomLabel(1)).toBe("100%");
  });
});
