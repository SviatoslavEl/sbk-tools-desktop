export interface NormalizedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ResizeHandle = "nw" | "ne" | "sw" | "se";

const clamp = (value: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(maximum, value));

export function normalizeRect(rect: NormalizedRect, minimumSize = 0.01): NormalizedRect {
  const min = clamp(Number.isFinite(minimumSize) ? minimumSize : 0.01, 0.002, 1);
  const x = clamp(Number.isFinite(rect.x) ? rect.x : 0, 0, 1 - min);
  const y = clamp(Number.isFinite(rect.y) ? rect.y : 0, 0, 1 - min);
  return {
    x,
    y,
    width: clamp(Number.isFinite(rect.width) ? rect.width : min, min, 1 - x),
    height: clamp(Number.isFinite(rect.height) ? rect.height : min, min, 1 - y),
  };
}

export function updateRect(rect: NormalizedRect, update: Partial<NormalizedRect>, minimumSize = 0.01): NormalizedRect {
  const finiteUpdate = Object.fromEntries(Object.entries(update).filter(([, value]) => Number.isFinite(value))) as Partial<NormalizedRect>;
  return normalizeRect({ ...rect, ...finiteUpdate }, minimumSize);
}

export function moveRect(rect: NormalizedRect, deltaX: number, deltaY: number): NormalizedRect {
  const current = normalizeRect(rect);
  return {
    ...current,
    x: clamp(current.x + deltaX, 0, 1 - current.width),
    y: clamp(current.y + deltaY, 0, 1 - current.height),
  };
}

export function resizeRect(
  rect: NormalizedRect,
  handle: ResizeHandle,
  deltaX: number,
  deltaY: number,
  minimumSize = 0.01,
): NormalizedRect {
  const current = normalizeRect(rect, minimumSize);
  let left = current.x;
  let top = current.y;
  let right = current.x + current.width;
  let bottom = current.y + current.height;
  if (handle.includes("w")) left = clamp(left + deltaX, 0, right - minimumSize);
  else right = clamp(right + deltaX, left + minimumSize, 1);
  if (handle.includes("n")) top = clamp(top + deltaY, 0, bottom - minimumSize);
  else bottom = clamp(bottom + deltaY, top + minimumSize, 1);
  return normalizeRect({ x: left, y: top, width: right - left, height: bottom - top }, minimumSize);
}

export function facsimileHeight(width: number, pageAspect: number, imageAspect: number): number {
  const safePageAspect = Number.isFinite(pageAspect) && pageAspect > 0 ? pageAspect : 1;
  const safeImageAspect = Number.isFinite(imageAspect) && imageAspect > 0 ? imageAspect : 1;
  return width * safePageAspect / safeImageAspect;
}

export function rotatedSize(width: number, height: number, degrees: number): { width: number; height: number } {
  const radians = degrees * Math.PI / 180;
  const cosine = Math.abs(Math.cos(radians));
  const sine = Math.abs(Math.sin(radians));
  return { width: width * cosine + height * sine, height: width * sine + height * cosine };
}

export function normalizeFacsimile(
  geometry: { x: number; y: number; width: number; rotation: number },
  pageAspect: number,
  imageAspect: number,
  minimumWidth = 0.08,
  maximumWidth = 0.6,
): { x: number; y: number; width: number; rotation: number } {
  let width = clamp(Number.isFinite(geometry.width) ? geometry.width : minimumWidth, minimumWidth, maximumWidth);
  let height = facsimileHeight(width, pageAspect, imageAspect);
  let rotated = rotatedSize(width, height, geometry.rotation);
  if (rotated.width > 1 || rotated.height > 1) {
    const scale = Math.min(1 / rotated.width, 1 / rotated.height);
    width *= scale;
    height *= scale;
    rotated = rotatedSize(width, height, geometry.rotation);
  }
  let centerX = (Number.isFinite(geometry.x) ? geometry.x : 0) + width / 2;
  let centerY = (Number.isFinite(geometry.y) ? geometry.y : 0) + height / 2;
  centerX = clamp(centerX, rotated.width / 2, 1 - rotated.width / 2);
  centerY = clamp(centerY, rotated.height / 2, 1 - rotated.height / 2);
  return { x: centerX - width / 2, y: centerY - height / 2, width, rotation: geometry.rotation };
}

export function pointerDelta(
  start: { x: number; y: number },
  current: { x: number; y: number },
  bounds: { width: number; height: number },
): { x: number; y: number } {
  return {
    x: bounds.width > 0 ? (current.x - start.x) / bounds.width : 0,
    y: bounds.height > 0 ? (current.y - start.y) / bounds.height : 0,
  };
}

export function drawnRect(
  start: { x: number; y: number },
  current: { x: number; y: number },
  bounds: { left: number; top: number; width: number; height: number },
  circular = false,
  minimumSize = 0.015,
): NormalizedRect {
  const origin = { x: (start.x - bounds.left) / bounds.width, y: (start.y - bounds.top) / bounds.height };
  const point = { x: (current.x - bounds.left) / bounds.width, y: (current.y - bounds.top) / bounds.height };
  if (circular) {
    const pixelSize = Math.max(Math.abs(current.x - start.x), Math.abs(current.y - start.y), 8);
    const width = pixelSize / bounds.width;
    const height = pixelSize / bounds.height;
    return normalizeRect({ x: point.x < origin.x ? origin.x - width : origin.x, y: point.y < origin.y ? origin.y - height : origin.y, width, height }, minimumSize);
  }
  return normalizeRect({ x: Math.min(origin.x, point.x), y: Math.min(origin.y, point.y), width: Math.abs(point.x - origin.x), height: Math.abs(point.y - origin.y) }, minimumSize);
}

export function rotationFromPointer(
  center: { x: number; y: number },
  start: { x: number; y: number },
  current: { x: number; y: number },
  initialRotation: number,
): number {
  const angle = (point: { x: number; y: number }) => Math.atan2(point.y - center.y, point.x - center.x) * 180 / Math.PI;
  let rotation = initialRotation + angle(current) - angle(start);
  while (rotation > 180) rotation -= 360;
  while (rotation < -180) rotation += 360;
  return Math.round(rotation);
}
