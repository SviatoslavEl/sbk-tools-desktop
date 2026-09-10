export const MIN_PREVIEW_ZOOM = .5;
export const MAX_PREVIEW_ZOOM = 3;

export interface PreviewSize { width: number; height: number }
export interface PreviewPoint { x: number; y: number }
export interface PreviewAnchor { page: PreviewPoint; viewport: PreviewPoint }

export function previewWheelAction({ deltaY, shiftKey, panning, editing }: { deltaY: number; shiftKey: boolean; panning: boolean; editing: boolean }): "block" | "scroll" | "zoom" {
  // Changing either zoom or scroll mid-gesture invalidates the drag's original
  // screen coordinates (including the stored facsimile rotation center).
  if (panning || editing) return "block";
  return shiftKey || !deltaY ? "scroll" : "zoom";
}

export function clampPreviewZoom(value: number) {
  return Math.max(MIN_PREVIEW_ZOOM, Math.min(MAX_PREVIEW_ZOOM, value));
}

export function wheelPreviewZoom(current: number, delta: number, mode = 0) {
  const pixels = delta * (mode === 1 ? 16 : mode === 2 ? 400 : 1);
  return clampPreviewZoom(Number((current * Math.exp(-Math.max(-120, Math.min(120, pixels)) * .002)).toFixed(3)));
}

export function previewViewportLayout(viewport: PreviewSize, zoom: number, aspect: number) {
  const pageWidth = Math.min(720, viewport.width * .72) * clampPreviewZoom(zoom);
  const pageHeight = pageWidth / (aspect > 0 && Number.isFinite(aspect) ? aspect : .707);
  // A viewport of empty canvas on every side lets any page edge sit under the
  // cursor, even at minimum zoom, without hitting the browser's scroll clamp.
  return {
    pageWidth, pageHeight, pageLeft: viewport.width, pageTop: viewport.height,
    canvasWidth: pageWidth + viewport.width * 2,
    canvasHeight: pageHeight + viewport.height * 2,
  };
}

export function previewScrollForAnchor(layout: ReturnType<typeof previewViewportLayout>, anchor: PreviewAnchor) {
  return {
    x: layout.pageLeft + anchor.page.x * layout.pageWidth - anchor.viewport.x,
    y: layout.pageTop + anchor.page.y * layout.pageHeight - anchor.viewport.y,
  };
}

export function previewPointAtViewport(layout: ReturnType<typeof previewViewportLayout>, scroll: PreviewPoint, point: PreviewPoint) {
  return {
    x: (scroll.x + point.x - layout.pageLeft) / layout.pageWidth,
    y: (scroll.y + point.y - layout.pageTop) / layout.pageHeight,
  };
}
