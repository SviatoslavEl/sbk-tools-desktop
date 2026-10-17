import type { FacsimilePageSelection } from "./facsimilePages";

export interface FacsimilePlacementPayload {
  imagePath: string;
  imageUrl: string;
  fileName: string;
  x: number;
  y: number;
  width: number;
  rotation: number;
  opacity: number;
  removeLightBackground: boolean;
  application: FacsimilePageSelection["application"];
  pages: number[];
  region?: [number, number, number, number];
  randomizeInRegion?: boolean;
  randomRotationDegrees?: number;
  randomSeed?: number;
}

export interface EditableFacsimile {
  imagePath: string;
  imageUrl: string;
  fileName: string;
  x: number;
  y: number;
  width: number;
  rotation: number;
  opacity: number;
  removeLightBackground: boolean;
  placementMode?: "manual" | "region" | "random-region";
  region?: [number, number, number, number];
  randomSeed?: number;
  randomRotationDegrees?: number;
}

export type FacsimileGeometry = Pick<EditableFacsimile, "x" | "y" | "width" | "rotation" | "opacity" | "removeLightBackground">;

export interface PerPageFacsimile extends EditableFacsimile {
  pageGeometries?: Record<number, FacsimileGeometry>;
}

export function facsimileGeometry(facsimile: PerPageFacsimile, pageIndex: number): FacsimileGeometry {
  return facsimile.pageGeometries?.[pageIndex] || {
    x: facsimile.x,
    y: facsimile.y,
    width: facsimile.width,
    rotation: facsimile.rotation,
    opacity: facsimile.opacity,
    removeLightBackground: facsimile.removeLightBackground,
  };
}

export function updateFacsimileGeometry<T extends PerPageFacsimile>(
  facsimile: T,
  pageIndex: number,
  update: Partial<FacsimileGeometry>,
): T {
  return {
    ...facsimile,
    pageGeometries: {
      ...(facsimile.pageGeometries || {}),
      [pageIndex]: { ...facsimileGeometry(facsimile, pageIndex), ...update },
    },
  };
}

const geometryKey = (geometry: FacsimileGeometry) => JSON.stringify([
  geometry.x,
  geometry.y,
  geometry.width,
  geometry.rotation,
  geometry.opacity,
  geometry.removeLightBackground,
]);

export function selectedFacsimilePages(selection: FacsimilePageSelection, pageCount: number): number[] {
  return selection.application === "all"
    ? Array.from({ length: Math.max(0, pageCount) }, (_, index) => index)
    : [...selection.pages];
}

export function buildFacsimilePlacements(
  facsimile: PerPageFacsimile,
  selection: FacsimilePageSelection,
  pageCount: number,
): FacsimilePlacementPayload[] {
  if (selection.application === "all" && Object.keys(facsimile.pageGeometries || {}).length === 0) {
    return [buildFacsimilePlacement(facsimile, { application: "all", pages: [] })];
  }
  const pages = selectedFacsimilePages(selection, pageCount);
  if (!pages.length) return [];
  const groups = new Map<string, { geometry: FacsimileGeometry; pages: number[] }>();
  for (const page of pages) {
    const geometry = facsimileGeometry(facsimile, page);
    const key = geometryKey(geometry);
    const group = groups.get(key);
    if (group) group.pages.push(page);
    else groups.set(key, { geometry, pages: [page] });
  }
  return [...groups.values()].map(({ geometry, pages: groupPages }) => buildFacsimilePlacement(
    { ...facsimile, ...geometry },
    selection.application === "all" && groups.size === 1
      ? { application: "all", pages: [] }
      // A single-page group from an all/range selection still owns that
      // selection's region and random rotation. "current" is a user mode, not
      // a group-size optimization: buildFacsimilePlacement deliberately clears
      // its hidden region, which must not happen after per-page edits.
      : { application: selection.application === "current" ? "current" : "explicitPages", pages: groupPages },
  ));
}

export function applyGeometryToPages<T extends PerPageFacsimile>(facsimile: T, sourcePage: number, pages: number[]): T {
  const geometry = facsimileGeometry(facsimile, sourcePage);
  const pageGeometries = { ...(facsimile.pageGeometries || {}) };
  for (const page of pages) pageGeometries[page] = { ...geometry };
  return { ...facsimile, pageGeometries };
}

export function suppressLabelActivation(event: { preventDefault: () => void; stopPropagation: () => void }): void {
  event.preventDefault();
  event.stopPropagation();
}

export function buildFacsimilePlacement(
  facsimile: EditableFacsimile,
  selection: FacsimilePageSelection,
): FacsimilePlacementPayload {
  return {
    imagePath: facsimile.imagePath,
    imageUrl: facsimile.imageUrl,
    fileName: facsimile.fileName,
    x: facsimile.x,
    y: facsimile.y,
    width: facsimile.width,
    rotation: facsimile.rotation,
    opacity: facsimile.opacity,
    removeLightBackground: facsimile.removeLightBackground,
    application: selection.application,
    pages: selection.pages,
    region: selection.application !== "current" && facsimile.placementMode && facsimile.placementMode !== "manual" ? facsimile.region : undefined,
    randomizeInRegion: selection.application !== "current" && facsimile.placementMode === "random-region",
    randomRotationDegrees: selection.application !== "current" ? facsimile.randomRotationDegrees : undefined,
    randomSeed: facsimile.randomSeed,
  };
}

export function positionFacsimileInRegion(
  placement: FacsimilePlacementPayload,
  pageIndex: number,
): FacsimilePlacementPayload {
  const fraction = (salt: number) => {
    let value = (Math.imul(placement.randomSeed || 42, 1_664_525) + Math.imul(pageIndex + 1, 1_013_904_223) + salt) >>> 0;
    value = (value ^ (value >>> 16)) >>> 0;
    return value / 0xFFFFFFFF;
  };
  const randomizedRotation = placement.rotation
    + (fraction(0x85EBCA6B) * 2 - 1) * (placement.randomRotationDegrees || 0);
  if (!placement.region) return { ...placement, rotation: randomizedRotation };
  const [rx, ry, rw, rh] = placement.region;
  const maxX = Math.max(rx, rx + rw - placement.width);
  const maxY = Math.max(ry, ry + rh - Math.min(placement.width, rh));
  if (!placement.randomizeInRegion) {
    return { ...placement, x: Math.min(Math.max(placement.x, rx), maxX), y: Math.min(Math.max(placement.y, ry), maxY), rotation: randomizedRotation };
  }
  return {
    ...placement,
    x: rx + (maxX - rx) * fraction(0),
    y: ry + (maxY - ry) * fraction(0x9E3779B9),
    rotation: randomizedRotation,
  };
}

export function facsimileAppliesTo(placement: FacsimilePlacementPayload, pageIndex: number): boolean {
  return placement.application === "all" || placement.pages.includes(pageIndex);
}

export interface FacsimilePreviewMetrics {
  /** Actual page width / height, including the current page's rotation. */
  pageAspect: number;
  /** EXIF-corrected source image width / height. */
  imageAspect: number;
}
const knownPreviewDimensions = (metrics: FacsimilePreviewMetrics) => Number.isFinite(metrics.pageAspect) && metrics.pageAspect > 0
  && Number.isFinite(metrics.imageAspect) && metrics.imageAspect > 0;

/** Derived display geometry only; never pass it back as the requested width.
 * Mirrors the compositor's two fits and its expanded-bitmap anchor/clamp in
 * continuous page coordinates (raster rounding may differ by a pixel).
 * Call positionFacsimileInRegion first, using the original requested size, so
 * deterministic random placement is identical to the worker's per-page plan. */
export function facsimilePreviewGeometry(placement: FacsimilePlacementPayload, metrics: FacsimilePreviewMetrics) {
  const knownDimensions = knownPreviewDimensions(metrics);
  const pageAspect = knownDimensions ? metrics.pageAspect : 1;
  const imageAspect = knownDimensions ? metrics.imageAspect : 1;
  const requested = { x: placement.x, y: placement.y, width: placement.width,
    height: placement.width * pageAspect / imageAspect, rotation: placement.rotation };
  if (!placement.region || !knownDimensions) return requested;
  const [rx, ry, rw, rh] = placement.region;
  if (![rx, ry, rw, rh, placement.x, placement.y, placement.width, placement.rotation].every(Number.isFinite) || rw <= 0 || rh <= 0) return requested;
  const clamp = (value: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(maximum, value));
  // Work in physical page units: page height is 1 and width is pageAspect.
  let width = pageAspect * clamp(placement.width, 0.02, 0.95), height = width / imageAspect;
  const regionWidth = pageAspect * rw, regionHeight = rh;
  const firstScale = Math.min(1, regionWidth / width, regionHeight / height);
  width *= firstScale; height *= firstScale;
  const angle = placement.rotation * Math.PI / 180;
  const cosine = Math.abs(Math.cos(angle)), sine = Math.abs(Math.sin(angle));
  let rotatedWidth = width * cosine + height * sine, rotatedHeight = width * sine + height * cosine;
  // Pillow expands around the old centre before fitting that rotated bitmap.
  // Its top-left anchor does not get re-centred after the second resize.
  let left = pageAspect * clamp(placement.x, 0, 1) + (width - rotatedWidth) / 2;
  let top = clamp(placement.y, 0, 1) + (height - rotatedHeight) / 2;
  const secondScale = Math.min(1, regionWidth / rotatedWidth, regionHeight / rotatedHeight);
  width *= secondScale; height *= secondScale;
  rotatedWidth *= secondScale; rotatedHeight *= secondScale;
  left = clamp(left, pageAspect * rx, pageAspect * (rx + rw) - rotatedWidth);
  top = clamp(top, ry, ry + rh - rotatedHeight);
  // Convert the fitted rotated bitmap anchor back to CSS's unrotated box;
  // transform-origin:center then produces the same final ink bounds.
  return { x: (left + (rotatedWidth - width) / 2) / pageAspect,
    y: top + (rotatedHeight - height) / 2, width: width / pageAspect, height, rotation: placement.rotation };
}

export function facsimileOverlayStyle(placement: FacsimilePlacementPayload, metrics?: FacsimilePreviewMetrics) {
  const derived = metrics ? facsimilePreviewGeometry(placement, metrics) : undefined;
  const displayed = derived || placement;
  return {
    left: `${displayed.x * 100}%`,
    top: `${displayed.y * 100}%`,
    width: `${displayed.width * 100}%`,
    // The legacy 10px overlay minimum must not move the rotation centre or ink
    // when a narrow region fits a signature below 10 displayed pixels high.
    ...(derived && metrics && placement.region && knownPreviewDimensions(metrics)
      ? { height: `${derived.height * 100}%`, minHeight: 0 } : {}),
    transform: `rotate(${displayed.rotation}deg)`,
    transformOrigin: "center center",
  } as const;
}

export interface PreviewCacheKeyInput {
  inputPath: string;
  preset: string;
  pageIndex: number;
  dpi: number;
  quality: number;
  pageRotation: number;
  redactions: unknown[];
  annotations?: unknown[];
  compressionMode?: string;
}

export function previewCacheKey(input: PreviewCacheKeyInput): string {
  return JSON.stringify([
    input.inputPath,
    input.preset,
    input.pageIndex,
    input.dpi,
    input.quality,
    input.pageRotation,
    input.redactions,
    input.annotations,
    input.compressionMode,
  ]);
}

export class BoundedPreviewCache<T> {
  private readonly values = new Map<string, T>();

  constructor(private readonly limit = 8, private readonly maxWeight = Infinity, private readonly weight: (value: T) => number = () => 1,
    private readonly dispose: (value: T) => void = () => undefined) {}

  has(key: string): boolean { return this.values.has(key); }

  get(key: string): T | undefined {
    const value = this.values.get(key);
    if (value === undefined) return undefined;
    this.values.delete(key);
    this.values.set(key, value);
    return value;
  }

  set(key: string, value: T): void {
    const previous = this.values.get(key);
    this.values.delete(key);
    if (previous !== undefined && previous !== value) this.dispose(previous);
    this.values.set(key, value);
    while (this.values.size > this.limit || this.totalWeight > this.maxWeight) {
      const oldest = this.values.keys().next().value;
      if (oldest === undefined) break;
      const evicted = this.values.get(oldest)!;
      this.values.delete(oldest);
      this.dispose(evicted);
    }
  }

  clear(): void {
    const values = [...this.values.values()];
    this.values.clear();
    values.forEach(this.dispose);
  }

  get size(): number {
    return this.values.size;
  }

  get totalWeight(): number {
    return [...this.values.values()].reduce((sum, value) => sum + Math.max(0, this.weight(value)), 0);
  }
}
