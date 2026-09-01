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
  const currentOrder = active
    ? direction === "asc" ? "по возрастанию" : "по убыванию"
    : "сортировка не выбрана";
  return <th scope="col" aria-sort={active ? (direction === "asc" ? "ascending" : "descending") : "none"}>
    <button
      className="sortable-header"
      type="button"
      aria-label={`Сортировать по столбцу «${label}». Сейчас: ${currentOrder}`}
      aria-pressed={active}
      title={`Сортировать по столбцу «${label}»`}
      onClick={() => onSort(column)}
    >
      <span>{label}</span><span aria-hidden="true">{active ? (direction === "asc" ? "↑" : "↓") : "↕"}</span>
    </button>
  </th>;
}
