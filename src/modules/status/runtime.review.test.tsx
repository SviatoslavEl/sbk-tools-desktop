import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StatusCenter } from "./StatusCenter";
import { GlobalSearch } from "../search/GlobalSearch";
import type { WorkspaceHealth } from "./health";
import type { WorkspaceInfo } from "../../lib/storage";
import type { SearchEntry } from "../search";
import { clearActivities, getActivities, startActivity, trackedOperation } from "../../lib/activity";
import { setViewStateWorkspace, useViewState } from "../../hooks/useViewState";

// Executes real component effects and callbacks with persistent state slots.
// This is a lifecycle test, not a browser/layout test; disk APIs are boundaries.
const runtime = vi.hoisted(() => ({ cursor: 0, changed: false,
  slots: [] as Array<{ value?: unknown; deps?: readonly unknown[]; cleanup?: () => void; effect?: () => void | (() => void) }>,
  effects: [] as Array<() => void>, health: vi.fn(), policy: vi.fn(), index: vi.fn(),
}));
vi.mock("react", async (original) => {
  const same = (left?: readonly unknown[], right?: readonly unknown[]) => left !== undefined && right !== undefined && left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
  const memo = (factory: () => unknown, deps?: readonly unknown[]) => { const index = runtime.cursor++; const previous = runtime.slots[index]; if (!previous || !same(previous.deps, deps)) runtime.slots[index] = { value: factory(), deps }; return runtime.slots[index].value; };
  return { ...await original<typeof import("react")>(),
    useState: (initial: unknown) => { const index = runtime.cursor++; if (!runtime.slots[index]) runtime.slots[index] = { value: typeof initial === "function" ? initial() : initial }; return [runtime.slots[index].value, (next: unknown) => { const value = typeof next === "function" ? next(runtime.slots[index].value) : next; if (!Object.is(value, runtime.slots[index].value)) { runtime.slots[index].value = value; runtime.changed = true; } }]; },
    useRef: (initial: unknown) => { const index = runtime.cursor++; if (!runtime.slots[index]) runtime.slots[index] = { value: { current: initial } }; return runtime.slots[index].value; },
    useMemo: memo, useCallback: (callback: unknown, deps?: readonly unknown[]) => memo(() => callback, deps),
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => { const index = runtime.cursor++; const previous = runtime.slots[index]; if (previous && same(previous.deps, deps)) return; runtime.slots[index] = { ...previous, deps, effect }; runtime.effects.push(() => { previous?.cleanup?.(); const cleanup = effect(); runtime.slots[index].cleanup = typeof cleanup === "function" ? cleanup : undefined; }); },
  };
});
vi.mock("./health", () => ({ getWorkspaceHealth: runtime.health }));
vi.mock("../../lib/sharedWorkspace", () => ({ readSharedBackupPolicy: runtime.policy }));
vi.mock("../search/index", async (original) => ({ ...await original<typeof import("../search/index")>(), loadSearchIndex: runtime.index }));

type NodeProps = { children?: ReactNode; onClick?: () => unknown; onChange?: (event: { target: { value: string; checked: boolean } }) => void; disabled?: boolean; value?: unknown; className?: string };
const workspace: WorkspaceInfo = { root: "/synthetic/A", configured: true, portable: false, editor: false, editorBusy: true, writable: true, accessControlled: true, accessMessage: "Просмотр", schemaVersion: 3, freeSpaceBytes: 1 };
const health = (name = "Иванов"): WorkspaceHealth => ({ root: workspace.root, checkedAt: "2026-09-18T10:00:00Z", appVersion: "2.9.0", schemaVersion: 3, available: true, writable: true, writableBasis: "last-known-os-access-not-a-write-probe", readLatencyMs: 12, editor: { busy: true, ownedByThisInstance: false, owner: { displayName: name, userName: "user", deviceName: "Тестовый ПК", startedAt: "2026-09-18T09:00:00Z" } }, backup: { latest: null, verification: { status: "not-recorded", message: "Проверка не зафиксирована" } }, issues: [] });
const policy = { source: "shared", policy: { version: 1, backupHours: 24, retentionCount: 10, retentionDays: 180, lastSuccessAt: 0, lastAttemptAt: 0, lastError: "", lastBackupPath: "" } };
const searchEntry = (title: string): SearchEntry => ({ id: title, title, tool: "contracts", archived: false, fields: [title], updatedAt: "2026-09-18" });
let tree: ReactNode;
let component: () => ReactNode;
function render() { runtime.cursor = 0; runtime.changed = false; tree = component(); for (const effect of runtime.effects.splice(0)) effect(); }
async function flush() { for (let count = 0; count < 30; count++) { await Promise.resolve(); if (runtime.changed) render(); } }
function nodes(node: ReactNode = tree): ReactElement<NodeProps>[] { if (Array.isArray(node)) return node.flatMap((child) => nodes(child ?? null)); if (!isValidElement<NodeProps>(node)) return []; return [node, ...nodes(node.props.children ?? null)]; }
function text(node: ReactNode = tree): string { if (Array.isArray(node)) return node.map((child) => text(child ?? null)).join(""); if (isValidElement<NodeProps>(node)) return text(node.props.children ?? null); return typeof node === "string" || typeof node === "number" ? String(node) : ""; }
function button(label: string) { const result = nodes().find((node) => node.type === "button" && text(node.props.children) === label); if (!result) throw new Error(`Missing button ${label}`); return result; }
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function strictReplay() { for (const slot of runtime.slots) slot.cleanup?.(); for (const slot of runtime.slots) { if (slot.effect) { const cleanup = slot.effect(); slot.cleanup = typeof cleanup === "function" ? cleanup : undefined; } } }
beforeEach(() => {
  vi.useFakeTimers(); runtime.cursor = 0; runtime.changed = false; runtime.slots = []; runtime.effects = [];
  for (const mock of [runtime.health, runtime.policy, runtime.index]) mock.mockReset();
  runtime.health.mockResolvedValue(health()); runtime.policy.mockResolvedValue(policy); runtime.index.mockResolvedValue({ entries: [], errors: [] });
  const events = new EventTarget();
  vi.stubGlobal("window", { addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), dispatchEvent: events.dispatchEvent.bind(events), setInterval, clearInterval });
  clearActivities(); component = () => StatusCenter({ workspace, onSettings: vi.fn() });
});
afterEach(() => { runtime.slots.forEach((slot) => slot.cleanup?.()); clearActivities(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("status center lifecycle", () => {
  it("does not invent a free editor or absent backups before the first response", async () => {
    const pending = deferred<WorkspaceHealth>(); runtime.health.mockReturnValue(pending.promise);
    render(); await flush(); expect(text()).not.toContain("Нет активного редактора"); expect(text()).not.toContain("Копий не найдено");
    pending.reject(new Error("SMB disconnected")); await flush(); expect(text()).toContain("Состояние неизвестно"); expect(text()).toContain("SMB disconnected"); expect(button("Проверить сейчас").props.disabled).toBe(false);
  });
  it("keeps the independently read backup policy when disk health fails", async () => {
    runtime.health.mockRejectedValue(new Error("SMB health unavailable"));
    render(); await flush(); expect(text()).toContain("Каждые 24 ч"); expect(text()).not.toContain("Читаем политику…");
  });
  it("shows policy failure independently of a successful disk check", async () => {
    runtime.policy.mockRejectedValue(new Error("policy unreadable")); render(); await flush();
    expect(text()).toContain("Иванов"); expect(text()).toContain("policy unreadable"); expect(text()).toContain("приостанавливаются");
  });
  it("reports both independent failures without leaving a false loading state", async () => {
    runtime.health.mockRejectedValue(new Error("health failed")); runtime.policy.mockRejectedValue(new Error("policy failed")); render(); await flush();
    expect(text()).toContain("health failed"); expect(text()).toContain("policy failed"); expect(text()).not.toContain("Читаем политику…"); expect(button("Проверить сейчас").props.disabled).toBe(false);
  });
  it("rejects a response for a different active workspace", async () => {
    runtime.health.mockResolvedValue({ ...health("Пользователь другой базы"), root: "/synthetic/B" }); render(); await flush();
    expect(text()).toContain("состояние другой рабочей папки"); expect(text()).not.toContain("Пользователь другой базы"); expect(text()).toContain("Состояние неизвестно");
  });
  it("survives StrictMode replay without accepting the first stale response", async () => {
    const old = deferred<WorkspaceHealth>(); const current = deferred<WorkspaceHealth>();
    runtime.health.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise); render(); strictReplay(); await flush();
    expect(runtime.health).toHaveBeenCalledTimes(2); current.resolve(health("Текущий")); await flush(); old.resolve(health("Устаревший")); await flush();
    expect(text()).toContain("Текущий"); expect(text()).not.toContain("Устаревший"); expect(button("Проверить сейчас").props.disabled).toBe(false);
  });
  it("does not overlap polling and preserves an explicitly stale last result on refresh failure", async () => {
    render(); await flush(); const pending = deferred<WorkspaceHealth>(); runtime.health.mockReturnValue(pending.promise);
    button("Проверить сейчас").props.onClick!(); await flush(); await vi.advanceTimersByTimeAsync(45_000); await flush(); expect(runtime.health).toHaveBeenCalledTimes(2);
    pending.reject(new Error("network lost")); await flush(); expect(text()).toContain("Иванов"); expect(text()).toContain("Свежая проверка не выполнена"); expect(text()).toContain("Состояние неизвестно");
  });
});

describe("global search lifecycle", () => {
  it("ignores an obsolete initial read after StrictMode replay", async () => {
    const old = deferred<{ entries: SearchEntry[]; errors: string[] }>(); const current = deferred<{ entries: SearchEntry[]; errors: string[] }>();
    runtime.index.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise); component = () => GlobalSearch({ onClose: vi.fn(), onNavigate: vi.fn() }); render(); strictReplay(); await flush();
    current.resolve({ entries: [searchEntry("новая")], errors: [] }); await flush(); old.resolve({ entries: [searchEntry("старая"), searchEntry("другая")], errors: ["stale"] }); await flush();
    expect(text()).toContain("В индексе 1 карточек"); expect(text()).not.toContain("stale");
  });
  it("keeps healthy partial results and routes only the clicked record", async () => {
    const navigate = vi.fn(); const close = vi.fn(); runtime.index.mockResolvedValue({ entries: [searchEntry("Тестовый договор")], errors: ["Кадры: offline"] });
    component = () => GlobalSearch({ onClose: close, onNavigate: navigate }); render(); await flush();
    nodes().find((node) => node.type === "input")!.props.onChange!({ target: { value: "Тестовый", checked: false } }); await flush();
    expect(text()).toContain("Индекс неполный"); expect(text()).toContain("Найдено: 1"); const hit = nodes().find((node) => node.props.className === "search-result")!;
    hit.props.onClick!(); expect(navigate).toHaveBeenCalledWith("contracts", "Тестовый договор"); expect(close).toHaveBeenCalledOnce();
  });
});

describe("session activity isolation", () => {
  it("ignores late completion from the previous workspace", () => { const finish = startActivity("old"); clearActivities(); startActivity("new"); finish(new Error("old error")); expect(getActivities()).toHaveLength(1); expect(getActivities()[0]).toMatchObject({ label: "new", status: "running" }); });
  it("retains all running work while bounding finished history", () => { startActivity("long"); for (let index = 0; index < 40; index++) startActivity(`finished-${index}`)(); expect(getActivities().filter((entry) => entry.status === "running").map((entry) => entry.label)).toEqual(["long"]); expect(getActivities().filter((entry) => entry.status !== "running")).toHaveLength(30); });
  it("records rejected operations as failures and preserves the original rejection", async () => { const error = new Error("Unavailable"); await expect(trackedOperation("read", async () => { throw error; })).rejects.toBe(error); expect(getActivities()[0]).toMatchObject({ status: "error", message: "Error: Unavailable" }); });
});

describe("view preference scope", () => {
  it("remembers a view within one workspace but not after switching workspaces", () => {
    setViewStateWorkspace("/view-test/first"); runtime.cursor = 0;
    const [, update] = useViewState("test:search", ""); update("Компания первого пространства");
    runtime.slots = []; runtime.cursor = 0;
    expect(useViewState("test:search", "")[0]).toBe("Компания первого пространства");
    setViewStateWorkspace("/view-test/second"); runtime.slots = []; runtime.cursor = 0;
    expect(useViewState("test:search", "")[0]).toBe("");
    setViewStateWorkspace("");
  });
  it("does not let an old view callback contaminate the new workspace cache", () => {
    setViewStateWorkspace("/view-test/first"); runtime.cursor = 0;
    const [, oldUpdate] = useViewState("test:search", "");
    setViewStateWorkspace("/view-test/second"); oldUpdate("late old value"); runtime.slots = []; runtime.cursor = 0;
    expect(useViewState("test:search", "")[0]).toBe("");
    setViewStateWorkspace("");
  });
});
