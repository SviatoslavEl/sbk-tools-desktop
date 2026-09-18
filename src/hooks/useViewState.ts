import { useState, type Dispatch, type SetStateAction } from "react";
let scope = "";
const values = new Map<string, unknown>();
/** Session-only view preferences. No business records or credentials are persisted. */
export function setViewStateWorkspace(root: string) { if (scope !== root) { values.clear(); scope = root; } }
export function useViewState<T>(key: string, initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => values.has(key) ? values.get(key) as T : typeof initial === "function" ? (initial as () => T)() : initial);
  const owner = scope;
  const update: Dispatch<SetStateAction<T>> = (next) => setValue((current) => {
    const result = typeof next === "function" ? (next as (value: T) => T)(current) : next;
    if (owner === scope) values.set(key, result);
    return result;
  });
  return [value, update];
}
