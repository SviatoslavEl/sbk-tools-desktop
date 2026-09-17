import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "../../components/Dialog";
import type { StoredRecord } from "../../lib/storage";
import { ProcurementEditor } from "./Procurement";
import { Stage2Workspace } from "./Stage2Workspace";
import { emptyProcurement, type ProcurementData, type SnapshotLink } from "./types";

const runtime = vi.hoisted(() => ({
  cursor: 0, changed: false,
  slots: [] as Array<{ value?: unknown; deps?: readonly unknown[]; cleanup?: () => void }>,
  effects: [] as Array<() => void>,
}));
vi.mock("react", async (original) => {
  const memo = (factory: () => unknown, deps?: readonly unknown[]) => {
    const index = runtime.cursor++, old = runtime.slots[index];
    if (!old || !old.deps || !deps || old.deps.length !== deps.length || old.deps.some((value, i) => !Object.is(value, deps[i]))) runtime.slots[index] = { value: factory(), deps };
    return runtime.slots[index].value;
  };
  return {
    ...await original<typeof import("react")>(),
    useState: (initial: unknown) => {
      const index = runtime.cursor++;
      if (!runtime.slots[index]) runtime.slots[index] = { value: typeof initial === "function" ? initial() : initial };
      return [runtime.slots[index].value, (next: unknown) => {
        const value = typeof next === "function" ? next(runtime.slots[index].value) : next;
        if (!Object.is(value, runtime.slots[index].value)) { runtime.slots[index].value = value; runtime.changed = true; }
      }];
    },
    useRef: (initial: unknown) => { const index = runtime.cursor++; if (!runtime.slots[index]) runtime.slots[index] = { value: { current: initial } }; return runtime.slots[index].value; },
    useMemo: memo,
    useCallback: (callback: unknown, deps?: readonly unknown[]) => memo(() => callback, deps),
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
      const index = runtime.cursor++, old = runtime.slots[index];
      if (old?.deps && deps && old.deps.length === deps.length && old.deps.every((value, i) => Object.is(value, deps[i]))) return;
      runtime.slots[index] = { ...old, deps };
      runtime.effects.push(() => { old?.cleanup?.(); const cleanup = effect(); runtime.slots[index].cleanup = typeof cleanup === "function" ? cleanup : undefined; });
    },
  };
});
vi.mock("../../hooks/useRecords", () => ({ useRecords: () => ({ records: [], loading: false, error: null }) }));

type Props = {
  children?: ReactNode; disabled?: boolean; value?: string; className?: string;
  onClick?: () => unknown; onChange?: (event: { target: { value: string } }) => void;
  onConfirm?: () => unknown; onClose?: () => void;
};
type EditorProps = Parameters<typeof ProcurementEditor>[0];
let props: EditorProps;
let tree: ReactNode;
let target: EventTarget;
const saved = vi.fn(), closed = vi.fn();
function render() { runtime.cursor = 0; runtime.changed = false; tree = ProcurementEditor(props); for (const effect of runtime.effects.splice(0)) effect(); }
async function flush() { for (let i = 0; i < 24; i += 1) { await Promise.resolve(); if (runtime.changed) render(); } }
function nodes(node: ReactNode = tree): ReactElement<Props>[] { if (Array.isArray(node)) return node.flatMap((child) => nodes(child ?? null)); if (!isValidElement<Props>(node)) return []; return [node, ...nodes(node.props.children ?? null)]; }
function text(node: ReactNode = tree): string { if (Array.isArray(node)) return node.map((child) => text(child ?? null)).join(""); if (isValidElement<Props>(node)) return text(node.props.children ?? null); return typeof node === "string" || typeof node === "number" ? String(node) : ""; }
function button(label: string) { const result = nodes().find((node) => node.type === "button" && text(node) === label); if (!result) throw new Error(`Button missing: ${label}`); return result; }
function nameInput() { const label = nodes().find((node) => node.type === "label" && text(node).startsWith("Название *"))!; return nodes(label).find((node) => node.type === "input")!; }
function stage() { return nodes().find((node) => node.type === Stage2Workspace) as unknown as ReactElement<{ item: ProcurementData; onChange: (next: ProcurementData) => void }>; }
function confirm() { return nodes().find((node) => node.type === ConfirmDialog); }
function escape() { const event = new Event("keydown", { cancelable: true }); Object.defineProperty(event, "key", { value: "Escape" }); target.dispatchEvent(event); return event; }
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const link: SnapshotLink = { id: "snapshot", sourceModule: "calculator", sourceId: "calculation", title: "Зафиксированная цена", capturedAt: "2026-09-17T10:00:00Z", snapshot: { cost: 10 } };

beforeEach(() => {
  runtime.cursor = 0; runtime.changed = false; runtime.slots = []; runtime.effects = [];
  saved.mockReset().mockResolvedValue(undefined); closed.mockReset();
  const record: StoredRecord<ProcurementData> = { id: "procurement", title: "Закупка", archived: false, createdAt: "2026-09-17T10:00:00Z", updatedAt: "2026-09-17T10:00:00Z", payload: { ...emptyProcurement(), name: "Закупка", customer: "Заказчик", subject: "Работы", nmc: 100, calculations: [structuredClone(link)] } };
  props = { record, onSave: saved, onClose: closed, readOnly: false };
  target = new EventTarget();
  vi.stubGlobal("window", { addEventListener: target.addEventListener.bind(target), removeEventListener: target.removeEventListener.bind(target), dispatchEvent: target.dispatchEvent.bind(target) });
});
afterEach(() => { for (const slot of runtime.slots) slot.cleanup?.(); vi.unstubAllGlobals(); });

describe("procurement save and close lifecycle", () => {
  it("blocks same-tick duplicate saves and stale mutation handlers until the write finishes", async () => {
    const writing = deferred<void>(); saved.mockReturnValueOnce(writing.promise);
    render();
    const save = button("Сохранить закупку").props.onClick!;
    const changeName = nameInput().props.onChange!;
    const previousStage = stage().props;
    save(); save();
    changeName({ target: { value: "Не должно попасть в запись" } });
    previousStage.onChange({ ...previousStage.item, notes: "Отложенный результат" });
    await flush();
    expect(saved).toHaveBeenCalledOnce();
    expect(nameInput().props.value).toBe("Закупка");
    expect(stage().props.item.notes).toBe("");
    expect(button("Сохраняем…").props.disabled).toBe(true);
    writing.resolve(); await flush();
    expect(text()).toContain("Закупка сохранена в рабочей папке");
    expect(button("Сохранить закупку").props.disabled).toBe(false);
  });

  it("preserves dirty form data after a failure and permits one explicit retry", async () => {
    saved.mockRejectedValueOnce(new Error("Сеть недоступна"));
    render(); nameInput().props.onChange!({ target: { value: "Исправленная закупка" } }); await flush();
    button("Сохранить закупку").props.onClick!(); await flush();
    expect(text()).toContain("Закупка не сохранена");
    expect(text()).toContain("Сеть недоступна");
    expect(text()).toContain("есть несохранённые изменения");
    expect(nameInput().props.value).toBe("Исправленная закупка");
    expect(closed).not.toHaveBeenCalled();
    button("Сохранить закупку").props.onClick!(); await flush();
    expect(saved).toHaveBeenCalledTimes(2);
    expect(saved.mock.calls[1][0].name).toBe("Исправленная закупка");
    expect(saved.mock.calls[1][0].calculations).toEqual([link]);
    expect(text()).not.toContain("есть несохранённые изменения");
  });

  it("does not let the hook's internal Escape close a clean form during a pending save", async () => {
    const writing = deferred<void>(); saved.mockReturnValueOnce(writing.promise);
    render(); button("Сохранить закупку").props.onClick!();
    expect(escape().defaultPrevented).toBe(true); await flush();
    escape(); button("Закрыть").props.onClick!(); await flush();
    expect(closed).not.toHaveBeenCalled();
    writing.resolve(); await flush(); escape();
    expect(closed).toHaveBeenCalledOnce();
  });

  it("protects an already-open discard callback if saving starts before confirmation", async () => {
    const writing = deferred<void>(); saved.mockReturnValueOnce(writing.promise);
    render(); nameInput().props.onChange!({ target: { value: "Несохранённое" } }); await flush();
    escape(); await flush();
    const discard = confirm()!.props.onConfirm!;
    button("Сохранить закупку").props.onClick!();
    discard(); await flush(); escape();
    expect(closed).not.toHaveBeenCalled();
    const unload = new Event("beforeunload", { cancelable: true });
    target.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    writing.reject(new Error("Сеть недоступна")); await flush();
    escape(); await flush();
    expect(confirm()).toBeDefined();
    confirm()!.props.onConfirm!();
    expect(closed).toHaveBeenCalledOnce();
  });

  it("rejects stale field, snapshot, expert and save callbacks after edit rights are lost", async () => {
    render();
    const changeName = nameInput().props.onChange!;
    const save = button("Сохранить закупку").props.onClick!;
    const expert = stage().props;
    button("3 Цена").props.onClick!(); await flush();
    const selection = nodes().find((node) => typeof node.type === "function" && node.type.name === "LinkSelection") as ReactElement<{
      addLink: (key: "calculations", value: SnapshotLink) => void;
      remove: (key: "calculations", id: string) => void;
    }>;
    props = { ...props, readOnly: true }; render();
    changeName({ target: { value: "Запрещённая правка" } });
    selection.props.addLink("calculations", { ...link, id: "new", sourceId: "new" });
    selection.props.remove("calculations", link.id);
    expert.onChange({ ...expert.item, notes: "Запоздалая обработка документа" });
    save(); await flush();
    expect(saved).not.toHaveBeenCalled();
    expect(stage().props.item.name).toBe("Закупка");
    expect(stage().props.item.notes).toBe("");
    expect(stage().props.item.calculations).toEqual([link]);
    expect(text()).toContain("Режим просмотра");
  });
});
