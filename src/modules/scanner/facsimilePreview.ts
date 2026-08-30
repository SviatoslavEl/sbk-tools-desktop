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
      : { application: groupPages.length === 1 ? "current" : "explicitPages", pages: groupPages },
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
    region: selection.application === "all" && facsimile.placementMode && facsimile.placementMode !== "manual" ? facsimile.region : undefined,
    randomizeInRegion: selection.application === "all" && facsimile.placementMode === "random-region",
    randomSeed: facsimile.randomSeed,
  };
}

export function positionFacsimileInRegion(
  placement: FacsimilePlacementPayload,
  pageIndex: number,
): FacsimilePlacementPayload {
  if (!placement.region) return placement;
  const [rx, ry, rw, rh] = placement.region;
  const maxX = Math.max(rx, rx + rw - placement.width);
  const maxY = Math.max(ry, ry + rh - Math.min(placement.width, rh));
  if (!placement.randomizeInRegion) {
    return { ...placement, x: Math.min(Math.max(placement.x, rx), maxX), y: Math.min(Math.max(placement.y, ry), maxY) };
  }
  const fraction = (salt: number) => {
    let value = (Math.imul(placement.randomSeed || 42, 1_664_525) + Math.imul(pageIndex + 1, 1_013_904_223) + salt) >>> 0;
    value = (value ^ (value >>> 16)) >>> 0;
    return value / 0xFFFFFFFF;
  };
  return { ...placement, x: rx + (maxX - rx) * fraction(0), y: ry + (maxY - ry) * fraction(0x9E3779B9) };
}

export function facsimileAppliesTo(placement: FacsimilePlacementPayload, pageIndex: number): boolean {
  return placement.application === "all" || placement.pages.includes(pageIndex);
}

export function facsimileOverlayStyle(placement: FacsimilePlacementPayload) {
  return {
    left: `${placement.x * 100}%`,
    top: `${placement.y * 100}%`,
    width: `${placement.width * 100}%`,
    transform: `rotate(${placement.rotation}deg)`,
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

  constructor(private readonly limit = 8) {}

  get(key: string): T | undefined {
    const value = this.values.get(key);
    if (value === undefined) return undefined;
    this.values.delete(key);
    this.values.set(key, value);
    return value;
  }

  set(key: string, value: T): void {
    this.values.delete(key);
    this.values.set(key, value);
    while (this.values.size > this.limit) {
      const oldest = this.values.keys().next().value;
      if (oldest === undefined) break;
      this.values.delete(oldest);
    }
  }

  clear(): void {
    this.values.clear();
  }

  get size(): number {
    return this.values.size;
  }
}
