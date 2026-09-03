import type { EditableFacsimile } from "./facsimilePreview";

export interface FacsimilePresetSettings {
  x: number;
  y: number;
  width: number;
  rotation: number;
  opacity: number;
  removeLightBackground: boolean;
  applyTo: "current" | "all" | "range";
  pageRange: string;
  placementMode: NonNullable<EditableFacsimile["placementMode"]>;
  region: [number, number, number, number];
  randomRotationDegrees: number;
  imageAspect: number;
}

const finite = (value: unknown, fallback: number, minimum: number, maximum: number) =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback;

export function captureFacsimilePreset(source: FacsimilePresetSettings): FacsimilePresetSettings {
  return normalizeFacsimilePreset(source);
}

export function normalizeFacsimilePreset(
  value: Partial<FacsimilePresetSettings> | null | undefined,
  fallbackWidth = 0.22,
): FacsimilePresetSettings {
  const applyTo = value?.applyTo === "all" || value?.applyTo === "range" ? value.applyTo : "current";
  const placementMode = value?.placementMode === "region" || value?.placementMode === "random-region"
    ? value.placementMode
    : "manual";
  const region = Array.isArray(value?.region) && value.region.length === 4
    ? value.region.map((entry, index) => finite(entry, index < 2 ? 0.1 : 0.8, 0, 1)) as [number, number, number, number]
    : [0.1, 0.1, 0.8, 0.8] as [number, number, number, number];
  return {
    x: finite(value?.x, 0.62, 0, 1),
    y: finite(value?.y, 0.72, 0, 1),
    width: finite(value?.width, fallbackWidth, 0.08, 0.6),
    rotation: finite(value?.rotation, 0, -180, 180),
    opacity: finite(value?.opacity, 1, 0.1, 1),
    removeLightBackground: value?.removeLightBackground !== false,
    applyTo,
    pageRange: typeof value?.pageRange === "string" ? value.pageRange : "",
    placementMode: applyTo === "current" ? "manual" : placementMode,
    region,
    randomRotationDegrees: finite(value?.randomRotationDegrees, 0, 0, 30),
    imageAspect: finite(value?.imageAspect, 3, 0.1, 20),
  };
}
