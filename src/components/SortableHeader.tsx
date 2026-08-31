import type { SortDirection } from "../lib/tableSort";

export function SortableHeader<Key extends string>({
  label,
  column,
  active,
  direction,
  onSort,
}: {
  label: string;
  column: Key;
  active: boolean;
  direction: SortDirection;
  onSort: (column: Key) => void;
}) {
  return <th aria-sort={active ? (direction === "asc" ? "ascending" : "descending") : "none"}>
    <button className="sortable-header" type="button" onClick={() => onSort(column)}>
      <span>{label}</span><span aria-hidden="true">{active ? (direction === "asc" ? "↑" : "↓") : "↕"}</span>
    </button>
  </th>;
}
