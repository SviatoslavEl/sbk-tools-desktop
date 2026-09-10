import { describe, expect, it } from "vitest";
import { MAX_PREVIEW_ZOOM, MIN_PREVIEW_ZOOM, clampPreviewZoom, previewPointAtViewport, previewScrollForAnchor, previewViewportLayout, previewWheelAction, wheelPreviewZoom, type PreviewAnchor, type PreviewPoint } from "./previewViewport";

const viewport = { width: 740, height: 610 };
const points = [0, .01, .5, .99, 1];

function expectPoint(actual: PreviewPoint, expected: PreviewPoint) {
  expect(actual.x).toBeCloseTo(expected.x, 10);
  expect(actual.y).toBeCloseTo(expected.y, 10);
}

describe("scanner cursor-anchored viewport", () => {
  it("blocks both zoom and native Shift/horizontal scrolling throughout a page edit or pan", () => {
    for (const interaction of [{ panning: true, editing: false }, { panning: false, editing: true }, { panning: true, editing: true }]) {
      for (const shiftKey of [true, false]) for (const deltaY of [-100, 0, 100]) {
        expect(previewWheelAction({ ...interaction, shiftKey, deltaY })).toBe("block");
      }
    }
  });

  it("restores wheel zoom and native scrolling as soon as no pointer gesture is active", () => {
    const released = { panning: false, editing: false };
    expect(previewWheelAction({ ...released, shiftKey: false, deltaY: -100 })).toBe("zoom");
    expect(previewWheelAction({ ...released, shiftKey: false, deltaY: 100 })).toBe("zoom");
    expect(previewWheelAction({ ...released, shiftKey: true, deltaY: 100 })).toBe("scroll");
    expect(previewWheelAction({ ...released, shiftKey: false, deltaY: 0 })).toBe("scroll");
  });

  it("can place every page corner under every viewport corner without scroll clamping at every supported scale", () => {
    for (const zoom of [MIN_PREVIEW_ZOOM, .75, 1, 1.8, MAX_PREVIEW_ZOOM]) {
      for (const aspect of [.707, 1.414]) {
        const layout = previewViewportLayout(viewport, zoom, aspect);
        for (const x of points) for (const y of points) {
          for (const viewportX of [0, viewport.width / 2, viewport.width]) for (const viewportY of [0, viewport.height / 2, viewport.height]) {
            const anchor = { page: { x, y }, viewport: { x: viewportX, y: viewportY } };
            const scroll = previewScrollForAnchor(layout, anchor);
            expect(scroll.x).toBeGreaterThanOrEqual(0);
            expect(scroll.y).toBeGreaterThanOrEqual(0);
            expect(scroll.x).toBeLessThanOrEqual(layout.canvasWidth - viewport.width + 1e-9);
            expect(scroll.y).toBeLessThanOrEqual(layout.canvasHeight - viewport.height + 1e-9);
            expectPoint(previewPointAtViewport(layout, scroll, anchor.viewport), anchor.page);
          }
        }
      }
    }
  });

  it("keeps the focal point through rapid wheel bursts, alternating zoom and zoom-out after panning", () => {
    let zoom = 1;
    let layout = previewViewportLayout(viewport, zoom, .707);
    let scroll = previewScrollForAnchor(layout, { page: { x: .95, y: .04 }, viewport: { x: 100, y: 490 } });
    for (const delta of [-32, -16, -110, -100, 10, 15, 120, 120, 120, 120, 120, 120]) {
      const cursor = { x: 100, y: 490 };
      const before = previewPointAtViewport(layout, scroll, cursor);
      zoom = wheelPreviewZoom(zoom, delta);
      layout = previewViewportLayout(viewport, zoom, .707);
      scroll = previewScrollForAnchor(layout, { page: before, viewport: cursor });
      expectPoint(previewPointAtViewport(layout, scroll, cursor), before);
      expect(scroll.x).toBeGreaterThanOrEqual(0);
      expect(scroll.y).toBeGreaterThanOrEqual(0);
    }
  });

  it("retains the document center after resizing/fullscreen and a portrait-to-landscape page change", () => {
    const center = { x: .31, y: .72 };
    for (const size of [viewport, { width: 1240, height: 770 }, { width: 450, height: 420 }]) {
      for (const aspect of [.707, 1.414]) {
        const layout = previewViewportLayout(size, 2.4, aspect);
        const anchor: PreviewAnchor = { page: center, viewport: { x: size.width / 2, y: size.height / 2 } };
        expectPoint(previewPointAtViewport(layout, previewScrollForAnchor(layout, anchor), anchor.viewport), center);
      }
    }
  });

  it("keeps normalized overlay geometry aligned when zooming at a point on an overlay", () => {
    const overlay = { x: .62, y: .72, width: .22, height: .08 };
    const anchor = { page: { x: overlay.x + overlay.width / 2, y: overlay.y + overlay.height / 2 }, viewport: { x: 512, y: 359 } };
    for (const zoom of [.5, 1, 1.625, 3]) {
      const layout = previewViewportLayout(viewport, zoom, .707);
      const scroll = previewScrollForAnchor(layout, anchor);
      const overlayCenter = {
        x: layout.pageLeft + (overlay.x + overlay.width / 2) * layout.pageWidth - scroll.x,
        y: layout.pageTop + (overlay.y + overlay.height / 2) * layout.pageHeight - scroll.y,
      };
      expectPoint(overlayCenter, anchor.viewport);
    }
  });

  it("uses the same zoom limits for wheel and toolbar", () => {
    expect(clampPreviewZoom(100)).toBe(MAX_PREVIEW_ZOOM);
    expect(clampPreviewZoom(-100)).toBe(MIN_PREVIEW_ZOOM);
    expect(wheelPreviewZoom(MAX_PREVIEW_ZOOM, -100)).toBe(MAX_PREVIEW_ZOOM);
    expect(wheelPreviewZoom(MIN_PREVIEW_ZOOM, 100)).toBe(MIN_PREVIEW_ZOOM);
  });
});
