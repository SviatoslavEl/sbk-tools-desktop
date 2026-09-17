import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VersionHistory } from "./VersionHistory";
import { ConfirmDialog, Dialog } from "./Dialog";
import { Archive } from "../modules/archive/Archive";
import { TenderCalendar } from "../modules/tender-calendar/TenderCalendar";
import { emptyTenderSchedule } from "../modules/tender-calendar/types";
import type { StoredRecord } from "../lib/storage";

const runtime = vi.hoisted(() => ({
  cursor: 0, changed: false, editor: true,
  slots: [] as Array<{ value?: unknown; deps?: readonly unknown[]; cleanup?: () => void }>,
  effects: [] as Array<() => void>,
  list: vi.fn(), archiveOne: vi.fn(), archiveMany: vi.fn(), deleteOne: vi.fn(), deleteMany: vi.fn(), history: vi.fn(), restoreVersion: vi.fn(), scheduleArchive: vi.fn(),
  schedules: [] as StoredRecord<unknown>[],
}));
vi.mock("react", async (original) => {
  const memo = (factory: () => unknown, deps?: readonly unknown[]) => { const index = runtime.cursor++, old = runtime.slots[index]; if (!old || !old.deps || !deps || old.deps.length !== deps.length || old.deps.some((value, i) => !Object.is(value, deps[i]))) runtime.slots[index] = { value: factory(), deps }; return runtime.slots[index].value; };
  return {
    ...await original<typeof import("react")>(),
    useState: (initial: unknown) => { const index = runtime.cursor++; if (!runtime.slots[index]) runtime.slots[index] = { value: typeof initial === "function" ? initial() : initial }; return [runtime.slots[index].value, (next: unknown) => { const value = typeof next === "function" ? next(runtime.slots[index].value) : next; if (!Object.is(value, runtime.slots[index].value)) { runtime.slots[index].value = value; runtime.changed = true; } }]; },
    useRef: (initial: unknown) => { const index = runtime.cursor++; if (!runtime.slots[index]) runtime.slots[index] = { value: { current: initial } }; return runtime.slots[index].value; },
    useMemo: memo,
    useCallback: (callback: unknown, deps?: readonly unknown[]) => memo(() => callback, deps),
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => { const index = runtime.cursor++, old = runtime.slots[index]; if (old?.deps && deps && old.deps.length === deps.length && old.deps.every((value, i) => Object.is(value, deps[i]))) return; runtime.slots[index] = { ...old, deps }; runtime.effects.push(() => { old?.cleanup?.(); const cleanup = effect(); runtime.slots[index].cleanup = typeof cleanup === "function" ? cleanup : undefined; }); },
  };
});
vi.mock("react-dom", async (original) => ({ ...await original<typeof import("react-dom")>(), createPortal: (children: ReactNode) => children }));
vi.mock("../lib/storage", async (original) => ({ ...await original<typeof import("../lib/storage")>(), listRecords: runtime.list, archiveRecord: runtime.archiveOne, archiveRecords: runtime.archiveMany, deleteRecord: runtime.deleteOne, deleteRecords: runtime.deleteMany, recordHistory: runtime.history, restoreHistoryVersion: runtime.restoreVersion }));
vi.mock("../lib/workspaceAccess", () => ({ useWorkspaceAccess: () => ({ editor: runtime.editor, message: "Тестовый доступ" }) }));
vi.mock("../hooks/useRecords", () => ({ useRecords: (module: string) => ({ records: module === "tender-calendar" ? runtime.schedules : [], loading: false, error: null, archive: runtime.scheduleArchive }) }));

type Props = { children?: ReactNode; disabled?: boolean; closeDisabled?: boolean; className?: string; "aria-label"?: string; onClick?: (event: { stopPropagation: () => void }) => unknown; onChange?: (event: { target: { checked: boolean } }) => unknown; onConfirm?: () => Promise<void>; onClose?: () => void };
let tree: ReactNode;
let component: () => ReactNode;
function render() { runtime.cursor = 0; runtime.changed = false; tree = component(); for (const effect of runtime.effects.splice(0)) effect(); }
async function flush() { for (let i = 0; i < 24; i += 1) { await Promise.resolve(); if (runtime.changed) render(); } }
function nodes(node: ReactNode = tree): ReactElement<Props>[] { if (Array.isArray(node)) return node.flatMap((child) => nodes(child ?? null)); if (!isValidElement<Props>(node)) return []; return [node, ...nodes(node.props.children ?? null)]; }
function text(node: ReactNode = tree): string { if (Array.isArray(node)) return node.map((child) => text(child ?? null)).join(""); if (isValidElement<Props>(node)) return text(node.props.children ?? null); return typeof node === "string" || typeof node === "number" ? String(node) : ""; }
function button(label: string) { const found = nodes().find((node) => node.type === "button" && text(node) === label); if (!found) throw new Error(`Button missing: ${label}`); return found; }
function click(label: string) { return button(label).props.onClick?.({ stopPropagation: vi.fn() }); }
const confirm = () => nodes().find((node) => node.type === ConfirmDialog);
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const record = (id: string): StoredRecord => ({ id, title: `Тест ${id}`, payload: {}, archived: true, createdAt: "2026-09-17T10:00:00Z", updatedAt: "2026-09-17T10:00:00Z" });

beforeEach(() => {
  runtime.cursor = 0; runtime.changed = false; runtime.slots = []; runtime.effects = []; runtime.editor = true; runtime.schedules = [];
  for (const fn of [runtime.list, runtime.archiveOne, runtime.archiveMany, runtime.deleteOne, runtime.deleteMany, runtime.history, runtime.restoreVersion, runtime.scheduleArchive]) fn.mockReset();
  runtime.list.mockResolvedValue([]);
  runtime.history.mockResolvedValue([{ id: 1, action: "updated", createdAt: "2026-09-17T10:00:00Z", snapshot: { name: "Прежнее" } }]);
  vi.stubGlobal("window", { confirm: vi.fn(() => true), dispatchEvent: vi.fn() });
  vi.stubGlobal("document", { body: {} });
});
afterEach(() => { for (const slot of runtime.slots) slot.cleanup?.(); vi.unstubAllGlobals(); });

describe("history and archive operation boundaries", () => {
  it("holds history confirmation open, blocks duplicate restores and surfaces failure for retry", async () => {
    const work = deferred<void>();
    const restore = vi.fn().mockReturnValueOnce(work.promise).mockResolvedValueOnce(undefined);
    component = () => VersionHistory({ module: "staff", id: "s", title: "Карточка", payload: { name: "Новое" }, onRestore: restore });
    render(); click("История"); await flush();
    click("Восстановить это состояние"); await flush();
    const pending = confirm()!;
    const outcome = pending.props.onConfirm!().catch((reason: Error) => reason);
    await pending.props.onConfirm!(); await flush();
    expect(restore).toHaveBeenCalledOnce();
    expect(confirm()).toBeDefined();
    expect(nodes().find((node) => node.type === Dialog)?.props.closeDisabled).toBe(true);
    pending.props.onClose?.(); await flush();
    expect(confirm()).toBeDefined();
    work.reject(new Error("Папка недоступна"));
    expect(await outcome).toMatchObject({ message: "Папка недоступна" }); await flush();
    expect(confirm()).toBeDefined();
    expect(text()).toContain("Папка недоступна");
    await confirm()!.props.onConfirm!(); await flush();
    expect(restore).toHaveBeenCalledTimes(2);
    expect(confirm()).toBeUndefined();
  });

  it("distinguishes archive loading/read failure from a verified empty archive", async () => {
    const loading = deferred<StoredRecord[]>();
    runtime.list.mockImplementation(() => loading.promise);
    component = Archive;
    render(); await flush();
    expect(text()).toContain("Загружаем архив");
    expect(text()).not.toContain("В архиве нет записей");
    loading.reject(new Error("Чтение не удалось")); await flush();
    expect(text()).toContain("Чтение не удалось");
    expect(text()).not.toContain("В архиве нет записей");
    runtime.list.mockResolvedValue([]);
    click("Повторить загрузку"); await flush();
    expect(text()).toContain("В архиве нет записей");
    expect(text()).not.toContain("Чтение не удалось");
  });

  it("serializes single-row restore and delete, keeping records visible on failure", async () => {
    runtime.list.mockImplementation(async (module: string) => module === "staff" ? [record("one"), record("two")] : []);
    const pending = deferred<void>(); runtime.archiveOne.mockReturnValueOnce(pending.promise);
    component = Archive; render(); await flush();
    const restoreClick = button("Восстановить").props.onClick!;
    restoreClick({ stopPropagation: vi.fn() }); restoreClick({ stopPropagation: vi.fn() });
    // Re-entry through a different action is also blocked by the same ref.
    click("Удалить навсегда"); await flush();
    expect(runtime.archiveOne).toHaveBeenCalledOnce();
    expect(runtime.deleteOne).not.toHaveBeenCalled();
    expect(nodes().filter((node) => node.type === "button" && text(node) === "Восстановить").every((node) => node.props.disabled)).toBe(true);
    pending.reject(new Error("Не удалось восстановить")); await flush();
    expect(text()).toContain("Тест one");
    expect(text()).toContain("Не удалось восстановить");
    runtime.archiveOne.mockResolvedValueOnce(undefined);
    click("Восстановить"); await flush();
    expect(runtime.archiveOne).toHaveBeenCalledTimes(2);
  });

  it("keeps a failed bulk confirmation with exact checked IDs and permits a later retry", async () => {
    runtime.list.mockImplementation(async (module: string) => module === "staff" ? [record("one"), record("two")] : []);
    runtime.archiveMany.mockRejectedValueOnce(new Error("Отказ групповой операции")).mockResolvedValueOnce(undefined);
    component = Archive; render(); await flush();
    nodes().find((node) => node.props["aria-label"] === "Выбрать Тест one")!.props.onChange!({ target: { checked: true } }); await flush();
    click("Восстановить выбранные (1)"); await flush();
    await expect(confirm()!.props.onConfirm!()).rejects.toThrow("Отказ групповой операции"); await flush();
    expect(confirm()).toBeDefined();
    expect(runtime.archiveMany).toHaveBeenCalledWith("staff", ["one"], false);
    await confirm()!.props.onConfirm!(); await flush();
    expect(confirm()).toBeUndefined();
    expect(runtime.archiveMany).toHaveBeenCalledTimes(2);
  });

  it("returns the calendar archive promise and only closes confirmation after success", async () => {
    runtime.schedules = [{ ...record("schedule"), archived: false, payload: { ...emptyTenderSchedule(), procurementTitle: "Проверка календаря" } }];
    runtime.scheduleArchive.mockRejectedValueOnce(new Error("Не записано")).mockResolvedValueOnce(undefined);
    component = TenderCalendar; render(); await flush();
    click("Распределение"); await flush();
    nodes().find((node) => node.props["aria-label"] === "Архивировать Проверка календаря")!.props.onClick!({ stopPropagation: vi.fn() }); await flush();
    await expect(confirm()!.props.onConfirm!()).rejects.toThrow("Не записано"); await flush();
    expect(confirm()).toBeDefined();
    await confirm()!.props.onConfirm!(); await flush();
    expect(confirm()).toBeUndefined();
    expect(runtime.scheduleArchive).toHaveBeenCalledTimes(2);
  });
});
