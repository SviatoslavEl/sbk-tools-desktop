import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StatusCenter } from "./StatusCenter";
import type { WorkspaceInfo } from "../../lib/storage";
import type { WorkspaceHealth } from "./health";

const runtime = vi.hoisted(() => ({ cursor: 0, changed: false, paused: false,
  slots: [] as Array<{ value?: unknown; deps?: readonly unknown[]; cleanup?: () => void }>, effects: [] as Array<() => void>, health: vi.fn(), policy: vi.fn(), activities: [] as unknown[] }));
vi.mock("react", async (original) => {
  const memo = (factory: () => unknown, deps?: readonly unknown[]) => { const index = runtime.cursor++, old = runtime.slots[index]; if (!old || !old.deps || !deps || old.deps.length !== deps.length || old.deps.some((value, i) => !Object.is(value, deps[i]))) runtime.slots[index] = { value: factory(), deps }; return runtime.slots[index].value; };
  return { ...await original<typeof import("react")>(),
    useState: (initial: unknown) => { const index = runtime.cursor++; if (!runtime.slots[index]) runtime.slots[index] = { value: typeof initial === "function" ? initial() : initial }; return [runtime.slots[index].value, (next: unknown) => { const value = typeof next === "function" ? next(runtime.slots[index].value) : next; if (!Object.is(value, runtime.slots[index].value)) { runtime.slots[index].value = value; runtime.changed = true; } }]; },
    useRef: (initial: unknown) => { const index = runtime.cursor++; if (!runtime.slots[index]) runtime.slots[index] = { value: { current: initial } }; return runtime.slots[index].value; },
    useCallback: (callback: unknown, deps?: readonly unknown[]) => memo(() => callback, deps),
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => { const index = runtime.cursor++, old = runtime.slots[index]; if (old?.deps && deps && old.deps.length === deps.length && old.deps.every((value, i) => Object.is(value, deps[i]))) return; runtime.slots[index] = { ...old, deps }; runtime.effects.push(() => { old?.cleanup?.(); const cleanup = effect(); runtime.slots[index].cleanup = typeof cleanup === "function" ? cleanup : undefined; }); },
  };
});
vi.mock("./health", () => ({ getWorkspaceHealth: runtime.health }));
vi.mock("../../lib/sharedWorkspace", () => ({ readSharedBackupPolicy: runtime.policy }));
vi.mock("../../lib/networkDiagnostics", () => ({ networkAccessIsPaused: () => runtime.paused, useNetworkAccess: () => ({ phase: runtime.paused ? "disconnected" : "connected" }) }));
vi.mock("../../lib/activity", () => ({ activityEvent: "qa-activity", getActivities: () => runtime.activities }));

type Props = { children?: ReactNode; open?: boolean; role?: string; disabled?: boolean; onClick?: () => unknown };
let tree: ReactNode;
const settings = vi.fn();
const workspace = { root: "/synthetic/shared", editor: false, writable: true, editorBusy: true, accessMessage: "Сеанс занят" } as WorkspaceInfo;
let health: WorkspaceHealth;
function nodes(node: ReactNode = tree): ReactElement<Props>[] { if (Array.isArray(node)) return node.flatMap((child) => nodes(child ?? null)); if (!isValidElement<Props>(node)) return []; return [node, ...nodes(node.props.children ?? null)]; }
function text(node: ReactNode = tree): string { if (Array.isArray(node)) return node.map((child) => text(child ?? null)).join(""); if (isValidElement<Props>(node)) return text(node.props.children ?? null); return typeof node === "string" || typeof node === "number" ? String(node) : ""; }
function render() { runtime.cursor = 0; runtime.changed = false; tree = StatusCenter({ workspace, onSettings: settings }); for (const effect of runtime.effects.splice(0)) effect(); }
async function flush() { for (let i = 0; i < 24; i += 1) { await Promise.resolve(); if (runtime.changed) render(); } }
function section(title: string) { return nodes().find((node) => node.type === "section" && nodes(node).some((child) => child.type === "h2" && text(child) === title))!; }
function primaryText(node: ReactNode): string { if (Array.isArray(node)) return node.map(primaryText).join(""); if (isValidElement<Props>(node)) return node.type === "details" ? "" : primaryText(node.props.children ?? null); return typeof node === "string" || typeof node === "number" ? String(node) : ""; }

beforeEach(() => {
  runtime.cursor = 0; runtime.changed = false; runtime.paused = false; runtime.slots = []; runtime.effects = []; runtime.activities = []; runtime.health.mockReset(); runtime.policy.mockReset(); settings.mockReset();
  health = { root: workspace.root, appVersion: "2.9.0", checkedAt: "2026-10-16T10:00:00Z", schemaVersion: 1, available: true, writable: true, writableBasis: "os", readLatencyMs: 20,
    editor: { busy: true, ownedByThisInstance: false, owner: { displayName: "QA user / QA-PC", userName: "QA user", deviceName: "QA-PC", startedAt: "2026-10-16T09:00:00Z" } },
    backup: { verification: { status: "not-recorded", message: "Дата копии не подтверждает её целостность; выполните проверку." } }, issues: [] };
  runtime.health.mockImplementation(async () => health); runtime.policy.mockResolvedValue({ source: "shared", policy: { backupHours: 24, lastSuccessAt: 0, lastError: "" } });
  const events = new EventTarget(); vi.stubGlobal("window", { setInterval: () => 1, clearInterval: vi.fn(), addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) });
});
afterEach(() => { for (const slot of runtime.slots) slot.cleanup?.(); vi.unstubAllGlobals(); });

describe("status center information hierarchy", () => {
  it("leads with state and next action, with paths and verification caveats in closed disclosures", async () => {
    render(); await flush();
    expect(primaryText(section("Рабочая папка"))).toContain("Доступна для чтения"); expect(primaryText(section("Рабочая папка"))).not.toContain(workspace.root);
    expect(primaryText(section("Резервная копия"))).toContain("Копий не найдено"); expect(primaryText(section("Резервная копия"))).toContain("Создайте резервную копию");
    expect(primaryText(section("Резервная копия"))).not.toContain("Дата копии"); expect(text(section("Резервная копия"))).toContain("Дата копии");
    expect(nodes().filter((node) => node.type === "details").every((node) => !node.props.open)).toBe(true);
  });
  it("shows the editor and device once, without implying that a recorded remote session is live", async () => {
    render(); await flush(); const card = section("Редактирование базы");
    expect(primaryText(card)).toContain("QA user"); expect(text(card).match(/QA-PC/g)).toHaveLength(1);
    expect(primaryText(card)).toContain("Активность этого сеанса не подтверждена"); expect(primaryText(card)).toContain("обратитесь к текущему редактору");
  });
  it("does not hide read, policy or operation errors in technical details", async () => {
    health.issues = [{ code: "read-failure", severity: "error", message: "Синтетическая ошибка чтения" }]; runtime.policy.mockRejectedValue(new Error("Синтетическая ошибка политики"));
    runtime.activities = [{ id: "one", status: "error", label: "Сохранение теста", message: "Синтетическая ошибка операции", startedAt: "2026-10-16T10:00:00Z" }];
    render(); await flush(); const main = primaryText(tree);
    expect(main).toContain("Синтетическая ошибка чтения"); expect(main).toContain("Синтетическая ошибка политики"); expect(main).toContain("Синтетическая ошибка операции"); expect(main).toContain("Ошибок: 1");
  });
  it("does not show a previously readable folder as current while file access is paused", async () => {
    render(); await flush(); runtime.paused = true; render(); await flush();
    expect(primaryText(section("Рабочая папка"))).toContain("Состояние неизвестно"); expect(primaryText(section("Рабочая папка"))).not.toContain("Доступна для чтения");
    expect(primaryText(section("Автоматическое резервирование"))).toContain("Приостановлено до восстановления связи");
    const refresh = nodes().find((node) => node.type === "button" && text(node) === "Проверить сейчас")!; expect(refresh.props.disabled).toBe(true);
    expect(runtime.health).toHaveBeenCalledOnce();
  });
  it("does not claim a policy read is running when opened with file access already paused", async () => {
    runtime.paused = true; render(); await flush();
    expect(primaryText(section("Автоматическое резервирование"))).toContain("недоступна до восстановления связи");
    expect(text()).not.toContain("Читаем политику"); expect(runtime.policy).not.toHaveBeenCalled(); expect(runtime.health).not.toHaveBeenCalled();
  });
  it("keeps last backup integrity uncertain and offers verification, not a success claim", async () => {
    health.backup.latest = { fileName: "qa.sbkbackup", path: "/synthetic/qa.sbkbackup", sizeBytes: 1024, modifiedAt: "2026-10-16T08:00:00Z", pinned: false };
    render(); await flush(); expect(primaryText(section("Резервная копия"))).toContain("Целостность не подтверждена");
    expect(primaryText(section("Резервная копия"))).not.toContain("qa.sbkbackup"); expect(text(section("Резервная копия"))).toContain("qa.sbkbackup");
  });
});
