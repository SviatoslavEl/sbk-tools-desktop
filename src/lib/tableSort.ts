export type SortDirection = "asc" | "desc";

export function compareSortValues(
  left: string | number | null | undefined,
  right: string | number | null | undefined,
  direction: SortDirection,
): number {
  const multiplier = direction === "asc" ? 1 : -1;
  if (typeof left === "number" && typeof right === "number") return (left - right) * multiplier;
  return String(left ?? "").localeCompare(String(right ?? ""), "ru", {
    numeric: true,
    sensitivity: "base",
  }) * multiplier;
}

export function toggleSort<Key extends string>(
  current: { key: Key; direction: SortDirection } | null,
  key: Key,
): { key: Key; direction: SortDirection } {
  return current?.key === key
    ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
    : { key, direction: "asc" };
}
