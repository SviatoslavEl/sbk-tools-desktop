export type ColoredAnnotationKind = "marker" | "stroke";

// Keep the pre-colour-picker defaults for old and newly created effects.
export const DEFAULT_ANNOTATION_COLORS: Record<ColoredAnnotationKind, string> = {
  marker: "#ffd84d",
  stroke: "#202020",
};

export const ANNOTATION_COLOR_CHOICES = [
  { value: "#ffd84d", label: "Жёлтый" },
  { value: "#70d69b", label: "Зелёный" },
  { value: "#70b8ff", label: "Голубой" },
  { value: "#f49ac2", label: "Розовый" },
  { value: "#202020", label: "Тёмно-серый" },
  { value: "#000000", label: "Чёрный" },
  { value: "#ffffff", label: "Белый" },
] as const;

export function isColoredAnnotationKind(kind: string | null): kind is ColoredAnnotationKind {
  return kind === "marker" || kind === "stroke";
}

/** CSS and the worker receive the same opaque RGB value; opacity is separate. */
export function annotationColor(kind: string, value: unknown): string {
  if (typeof value === "string" && /^#[\da-f]{6}$/i.test(value.trim())) return value.trim().toLowerCase();
  return isColoredAnnotationKind(kind) ? DEFAULT_ANNOTATION_COLORS[kind] : "#ffffff";
}

export function updateAnnotationColor<T extends { id: string; kind: string; color: string }>(items: T[], id: string, color: unknown): T[] {
  return items.map((item) => item.id === id && isColoredAnnotationKind(item.kind)
    ? { ...item, color: annotationColor(item.kind, color) }
    : item);
}

export function colorCheckmark(color: string): string {
  const rgb = annotationColor("marker", color).slice(1);
  const channels = [0, 2, 4].map((index) => Number.parseInt(rgb.slice(index, index + 2), 16));
  return channels[0] * .299 + channels[1] * .587 + channels[2] * .114 > 150 ? "#18243b" : "#ffffff";
}
