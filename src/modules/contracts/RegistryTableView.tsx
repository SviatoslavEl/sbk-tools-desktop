import { useState } from "react";

export interface RegistryColumn { key: string; label: string; compact: boolean }
export function normalizeRegistryColumns(value: unknown, columns: RegistryColumn[]): string[] {
  const selected = Array.isArray(value) ? value.filter((key): key is string => typeof key === "string" && columns.some((column) => column.key === key)) : columns.filter((column) => column.compact).map((column) => column.key);
  // The first identifier column is always present, including invalid/old preferences.
  return [...new Set([columns[0].key, ...selected])];
}

export function RegistryTableView({ name, columns, count }: { name: "contracts" | "staff"; columns: RegistryColumn[]; count: number }) {
  const storageKey = `sbk-registry-columns-${name}-v1`;
  const [selected, setSelected] = useState(() => {
    try { return normalizeRegistryColumns(JSON.parse(localStorage.getItem(storageKey) || "null"), columns); }
    catch { return normalizeRegistryColumns(null, columns); }
  });
  const update = (value: string[]) => {
    const next = normalizeRegistryColumns(value, columns);
    setSelected(next);
    try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* In-memory choice still works when local storage is unavailable. */ }
  };
  const hidden = columns.flatMap((column, index) => selected.includes(column.key) ? [] : [index + 2]);
  return <div className="registry-display-options" data-workspace-viewer-allowed>
    <strong role="status">Найдено: {count}</strong>
    <button className="secondary small" type="button" onClick={() => update(columns.filter((column) => column.compact).map((column) => column.key))}>Кратко</button>
    <button className="secondary small" type="button" onClick={() => update(columns.map((column) => column.key))}>Подробно</button>
    <details><summary>Столбцы ({selected.length})</summary><div className="column-options">{columns.map((column, index) => <label className="checkbox-row" key={column.key}><input type="checkbox" disabled={index === 0} checked={selected.includes(column.key)} onChange={(event) => update(event.target.checked ? [...selected, column.key] : selected.filter((key) => key !== column.key))} />{column.label}</label>)}</div></details>
    <style>{hidden.map((index) => `.registry-${name}-table > thead > tr > :nth-child(${index}), .registry-${name}-table > tbody > tr:not(.department-group-row) > :nth-child(${index}) { display: none; }`).join("\n")}</style>
  </div>;
}
