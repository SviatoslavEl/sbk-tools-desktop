import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke as nativeInvoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { applyNetworkAccessStatus, openNetworkDiagnosticsEvent, type DiagnosticStatus, type NetworkAccessStatus } from "../../lib/networkDiagnostics";
import { NetworkDiagnosticsPanel, NetworkOfflineNotice } from "./NetworkDiagnosticsPanel";
import { useRecords } from "../../hooks/useRecords";
import type { WorkspaceInfo } from "../../lib/storage";
// @ts-expect-error Node built-ins are provided by the test runner.
import { readFileSync } from "node:fs";

const hooks = vi.hoisted(() => ({ cursor: 0, changed: false,
  slots: [] as Array<{ value?: unknown; deps?: readonly unknown[]; cleanup?: () => void }>, effects: [] as Array<() => void>,
}));
vi.mock("react", async (original) => {
  const same = (a?: readonly unknown[], b?: readonly unknown[]) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  return { ...await original<typeof import("react")>(),
    useState: (initial: unknown) => { const i = hooks.cursor++; if (!hooks.slots[i]) hooks.slots[i] = { value: typeof initial === "function" ? initial() : initial }; return [hooks.slots[i].value, (next: unknown) => { const value = typeof next === "function" ? next(hooks.slots[i].value) : next; if (!Object.is(value, hooks.slots[i].value)) { hooks.slots[i].value = value; hooks.changed = true; } }]; },
    useRef: (initial: unknown) => { const i = hooks.cursor++; if (!hooks.slots[i]) hooks.slots[i] = { value: { current: initial } }; return hooks.slots[i].value; },
    useCallback: (callback: unknown, deps?: readonly unknown[]) => { const i = hooks.cursor++; if (!hooks.slots[i] || !same(hooks.slots[i].deps, deps)) hooks.slots[i] = { value: callback, deps }; return hooks.slots[i].value; },
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => { const i = hooks.cursor++; const previous = hooks.slots[i]; if (previous && same(previous.deps, deps)) return; hooks.slots[i] = { ...previous, deps }; hooks.effects.push(() => { previous?.cleanup?.(); const cleanup = effect(); hooks.slots[i].cleanup = typeof cleanup === "function" ? cleanup : undefined; }); },
  };
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));

type Props = { children?: ReactNode; disabled?: boolean; type?: string; value?: unknown; onClick?: () => unknown; onChange?: (event: { target: { value: string } }) => void };
let tree: ReactNode;
let component: () => ReactNode;
function render() { hooks.cursor = 0; hooks.changed = false; tree = component(); for (const effect of hooks.effects.splice(0)) effect(); }
async function flush() { for (let i = 0; i < 30; i++) { await Promise.resolve(); if (hooks.changed) render(); } }
function nodes(node: ReactNode = tree): ReactElement<Props>[] { if (Array.isArray(node)) return node.flatMap((child) => nodes(child ?? null)); if (!isValidElement<Props>(node)) return []; return [node, ...nodes(node.props.children ?? null)]; }
function text(node: ReactNode = tree): string { if (Array.isArray(node)) return node.map((child) => text(child ?? null)).join(""); if (isValidElement<Props>(node)) return text(node.props.children ?? null); return typeof node === "string" || typeof node === "number" ? String(node) : ""; }
function button(label: string) { const node = nodes().find((node) => node.type === "button" && text(node.props.children) === label); if (!node) throw new Error(`Missing button ${label}`); return node; }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((yes) => { resolve = yes; }); return { promise, resolve }; }
const net = (phase: NetworkAccessStatus["phase"]): NetworkAccessStatus => ({ phase, activeOperations: 0, changedAt: "", error: null, restartRequired: false });
const diagnostic = (enabled = false): DiagnosticStatus => ({ enabled, sessionId: "synthetic-session", pendingOperations: 0, writeFailures: 0, droppedEvents: 0, available: true, restartRequired: false });
const workspace = (patch: Partial<WorkspaceInfo> = {}): WorkspaceInfo => ({ root: "/synthetic/shared", portable: false, configured: true, writable: true, editor: false, editorBusy: false, accessControlled: true, accessMessage: "Режим просмотра", schemaVersion: 3, freeSpaceBytes: 1, ...patch });

beforeEach(() => {
  vi.useFakeTimers(); hooks.cursor = 0; hooks.changed = false; hooks.slots = []; hooks.effects = [];
  const events = new EventTarget();
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {}, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), dispatchEvent: events.dispatchEvent.bind(events), setInterval, clearInterval });
  applyNetworkAccessStatus(net("connected")); vi.mocked(nativeInvoke).mockReset(); vi.mocked(save).mockReset();
  vi.mocked(nativeInvoke).mockImplementation(async (command, args) => {
    if (command === "diagnostic_status") return diagnostic();
    if (command === "set_diagnostic_logging") return diagnostic(Boolean((args as { enabled: boolean }).enabled));
    if (command === "disconnect_workspace_network") return net("disconnected");
    if (command === "reconnect_workspace_network") return net("connected");
    if (command === "workspace_info") return workspace();
    return undefined;
  });
  component = () => NetworkDiagnosticsPanel({ ownerConfigured: true });
});
afterEach(() => { hooks.slots.forEach((slot) => slot.cleanup?.()); applyNetworkAccessStatus(net("connected")); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("network diagnostics panel real handlers and lifecycle", () => {
  it("offers a separate ordinary-password login after reconnect, never acquires automatically", async () => {
    let acquired = false;
    vi.mocked(nativeInvoke).mockImplementation(async (command, args) => {
      if (command === "reconnect_workspace_network") return net("connected");
      if (command === "workspace_info") return workspace({ editor: acquired });
      if (command === "switch_workspace_mode") { expect(args).toEqual({ editor: true, password: "ordinary-workspace-password" }); acquired = true; return undefined; }
      return diagnostic();
    });
    component = () => NetworkDiagnosticsPanel({ ownerConfigured: false });
    applyNetworkAccessStatus(net("disconnected")); render(); await flush();
    button("Подключить в режиме просмотра").props.onClick!(); await flush();
    expect(acquired).toBe(false); expect(text()).toContain("Обычный пароль рабочей папки");
    expect(button("Войти в обычный режим редактора").props.disabled).toBe(true);
    nodes().find((node) => node.type === "input")!.props.onChange!({ target: { value: "ordinary-workspace-password" } }); await flush();
    button("Войти в обычный режим редактора").props.onClick!(); await flush();
    expect(acquired).toBe(true); expect(text()).toContain("Обычный вход редактора выполнен");
    expect(vi.mocked(nativeInvoke).mock.calls.filter(([command]) => command === "switch_workspace_mode")).toHaveLength(1);
    expect(nodes().some((node) => node.props.value === "ordinary-workspace-password")).toBe(false);
  });
  it("leaves viewer mode and the form workflow intact after a wrong ordinary password", async () => {
    vi.mocked(nativeInvoke).mockImplementation(async (command) => {
      if (command === "workspace_info") return workspace();
      if (command === "switch_workspace_mode") throw new Error("Неверный пароль рабочей папки");
      return diagnostic();
    });
    component = () => NetworkDiagnosticsPanel({ ownerConfigured: false }); render(); await flush();
    button("Вернуться к редактированию").props.onClick!(); await flush();
    nodes().find((node) => node.type === "input")!.props.onChange!({ target: { value: "wrong-normal-password" } }); await flush();
    button("Войти в обычный режим редактора").props.onClick!(); await flush();
    expect(text()).toContain("Неверный пароль рабочей папки"); expect(text()).not.toContain("Обычный вход редактора выполнен");
    expect(button("Войти в обычный режим редактора").props.disabled).toBe(true);
    expect(nodes().find((node) => node.type === "input")!.props.value).toBe("");
  });
  it("rechecks a newly busy editor before login and never sends an acquisition request", async () => {
    let otherEditor = false;
    vi.mocked(nativeInvoke).mockImplementation(async (command) => command === "workspace_info" ? workspace({ accessControlled: false, editorBusy: otherEditor, editorOwner: otherEditor ? { displayName: "Другой сотрудник", userName: "other", deviceName: "other-pc", startedAt: "2026-10-01" } : undefined }) : diagnostic());
    component = () => NetworkDiagnosticsPanel({ ownerConfigured: false }); render(); await flush();
    button("Вернуться к редактированию").props.onClick!(); await flush();
    expect(button("Войти в обычный режим редактора").props.disabled).toBe(false);
    otherEditor = true;
    button("Войти в обычный режим редактора").props.onClick!(); await flush();
    expect(text()).toContain("Другой сотрудник"); expect(text()).toContain("Чужой сеанс не изменён");
    expect(button("Войти в обычный режим редактора").props.disabled).toBe(true);
    expect(vi.mocked(nativeInvoke).mock.calls.some(([command]) => command === "switch_workspace_mode")).toBe(false);
  });
  it("uses blank credentials only when the ordinary workspace has no password and the user explicitly clicks", async () => {
    let acquired = false;
    vi.mocked(nativeInvoke).mockImplementation(async (command, args) => {
      if (command === "workspace_info") return workspace({ accessControlled: false, editor: acquired });
      if (command === "switch_workspace_mode") { expect(args).toEqual({ editor: true, password: "" }); acquired = true; return undefined; }
      return diagnostic();
    });
    component = () => NetworkDiagnosticsPanel({ ownerConfigured: false }); render(); await flush();
    button("Вернуться к редактированию").props.onClick!(); await flush(); expect(acquired).toBe(false);
    button("Войти в обычный режим редактора").props.onClick!(); await flush(); expect(acquired).toBe(true);
    expect(text()).toContain("Режим редактора активен");
  });
  it("exposes a clickable local diagnostics action above a connected card without native commands", async () => {
    const open = vi.fn(); window.addEventListener(openNetworkDiagnosticsEvent, open);
    component = () => NetworkOfflineNotice({ overlay: true }); render(); await flush();
    button("Связь и диагностика").props.onClick!(); await flush();
    expect(open).toHaveBeenCalledOnce(); expect(nativeInvoke).not.toHaveBeenCalled();
    expect(text()).not.toContain("приостановлена");
    window.removeEventListener(openNetworkDiagnosticsEvent, open);
  });
  it("does not insert an offline banner into connected main content", async () => {
    component = () => NetworkOfflineNotice({}); render(); await flush();
    expect(tree).toBeNull(); expect(nativeInvoke).not.toHaveBeenCalled();
  });
  it("overrides the generic column notice layout so the text flex basis cannot stretch the banner vertically", () => {
    const css = readFileSync(new URL("../../App.css", import.meta.url), "utf8") as string;
    const banner = css.match(/\.network-offline-notice\s*\{([^}]+)\}/)?.[1];
    expect(banner).toContain("flex-direction: row");
    expect(banner).toContain("align-self: start");
    expect(banner).toContain("flex-shrink: 0");
    const app = readFileSync(new URL("../../App.tsx", import.meta.url), "utf8") as string;
    expect(app).toContain("networkPaused ? <small>Данные не обновляются</small>");
  });
  it("allows local logging without owner login and explains the scope", async () => {
    component = () => NetworkDiagnosticsPanel({ ownerConfigured: false }); render(); await flush();
    expect(nodes().filter((node) => node.type === "input")).toHaveLength(0);
    expect(button("Включить журналирование").props.disabled).toBe(false);
    button("Включить журналирование").props.onClick!(); await flush();
    expect(nativeInvoke).toHaveBeenCalledWith("set_diagnostic_logging", { enabled: true });
    expect(text()).toContain("Журналирование включено");
    expect(text()).toContain("Без паролей, содержимого документов и автоматической отправки");
    expect(text()).toContain("до перезапуска СБК");
  });
  it("requires an owner password, prevents duplicate disconnects and clears the secret", async () => {
    const pending = deferred<NetworkAccessStatus>();
    vi.mocked(nativeInvoke).mockImplementation(async (command) => command === "disconnect_workspace_network" ? pending.promise : diagnostic());
    render(); await flush(); expect(button("Отключить связь на этом компьютере").props.disabled).toBe(true);
    nodes().find((node) => node.type === "input")!.props.onChange!({ target: { value: "synthetic-owner-password" } }); await flush();
    const click = button("Отключить связь на этом компьютере").props.onClick!; click(); click(); await flush();
    expect(vi.mocked(nativeInvoke).mock.calls.filter(([command]) => command === "disconnect_workspace_network")).toEqual([["disconnect_workspace_network", { password: "synthetic-owner-password" }]]);
    pending.resolve(net("disconnected")); await flush();
    expect(nodes().some((node) => node.props.value === "synthetic-owner-password")).toBe(false);
    expect(text()).toContain("неактуальны"); expect(text()).toContain("Отключено на этом компьютере");
    button("Подключить в режиме просмотра").props.onClick!(); await flush();
    expect(nativeInvoke).toHaveBeenCalledWith("reconnect_workspace_network");
    expect(vi.mocked(nativeInvoke).mock.calls.some(([command]) => command === "switch_workspace_mode")).toBe(false);
  });
  it("exports in the same panel while owner authentication is pending, without duplicate local or network actions", async () => {
    const disconnect = deferred<NetworkAccessStatus>();
    const exporting = deferred<void>();
    vi.mocked(nativeInvoke).mockImplementation(async (command) => {
      if (command === "disconnect_workspace_network") return disconnect.promise;
      if (command === "export_diagnostic_bundle") return exporting.promise;
      return diagnostic();
    });
    vi.mocked(save).mockResolvedValue("C:\\Temp\\diagnostics-pending.zip");
    render(); await flush();
    nodes().find((node) => node.type === "input")!.props.onChange!({ target: { value: "synthetic-owner-password" } }); await flush();
    const disconnectClick = button("Отключить связь на этом компьютере").props.onClick!;
    disconnectClick(); disconnectClick(); await flush();
    // Authentication can wait before the backend has even entered disconnecting.
    expect(text()).toContain("Подключено");
    expect(button("Отключить связь на этом компьютере").props.disabled).toBe(true);
    expect(button("Экспорт диагностики…").props.disabled).toBe(false);
    expect(text()).toContain("экспорт диагностики доступны во время ожидания");
    const exportClick = button("Экспорт диагностики…").props.onClick!;
    exportClick(); exportClick(); await flush();
    expect(save).toHaveBeenCalledOnce();
    expect(nativeInvoke).toHaveBeenCalledWith("export_diagnostic_bundle", { path: "C:\\Temp\\diagnostics-pending.zip" });
    expect(button("Экспорт диагностики…").props.disabled).toBe(true);
    expect(button("Включить журналирование").props.disabled).toBe(true);
    button("Включить журналирование").props.onClick!(); await flush();
    expect(vi.mocked(nativeInvoke).mock.calls.some(([command]) => command === "set_diagnostic_logging")).toBe(false);
    expect(vi.mocked(nativeInvoke).mock.calls.filter(([command]) => command === "disconnect_workspace_network")).toHaveLength(1);
    expect(vi.mocked(nativeInvoke).mock.calls.filter(([command]) => command === "export_diagnostic_bundle")).toHaveLength(1);
    exporting.resolve(); await flush();
    expect(text()).toContain("Диагностический ZIP сохранён");
    expect(button("Экспорт диагностики…").props.disabled).toBe(false);
    expect(button("Отключить связь на этом компьютере").props.disabled).toBe(true);
    disconnect.resolve(net("disconnected")); await flush();
    expect(text()).toContain("Диагностический ZIP сохранён");
  });
  it("keeps local status and logging available during disconnecting, with independent duplicate protection", async () => {
    const disconnect = deferred<NetworkAccessStatus>();
    const logging = deferred<DiagnosticStatus>();
    vi.mocked(nativeInvoke).mockImplementation(async (command) => {
      if (command === "disconnect_workspace_network") return disconnect.promise;
      if (command === "set_diagnostic_logging") return logging.promise;
      return diagnostic();
    });
    render(); await flush();
    nodes().find((node) => node.type === "input")!.props.onChange!({ target: { value: "synthetic-owner-password" } }); await flush();
    button("Отключить связь на этом компьютере").props.onClick!(); await flush();
    applyNetworkAccessStatus(net("disconnecting")); await flush();
    await vi.advanceTimersByTimeAsync(3000); await flush();
    expect(vi.mocked(nativeInvoke).mock.calls.filter(([command]) => command === "diagnostic_status")).toHaveLength(2);
    expect(button("Включить журналирование").props.disabled).toBe(false);
    const loggingClick = button("Включить журналирование").props.onClick!;
    loggingClick(); loggingClick(); await flush();
    expect(vi.mocked(nativeInvoke).mock.calls.filter(([command]) => command === "set_diagnostic_logging")).toEqual([["set_diagnostic_logging", { enabled: true }]]);
    expect(button("Экспорт диагностики…").props.disabled).toBe(true);
    expect(button("Подключить в режиме просмотра").props.disabled).toBe(true);
    logging.resolve(diagnostic(true)); await flush();
    expect(text()).toContain("Журналирование включено");
    expect(button("Экспорт диагностики…").props.disabled).toBe(false);
    expect(button("Подключить в режиме просмотра").props.disabled).toBe(true);
    disconnect.resolve(net("disconnected")); await flush();
  });
  it.each(["reconnect_workspace_network", "workspace_info", "switch_workspace_mode"])("keeps local diagnostics usable while %s waits and preserves export success on completion", async (pendingCommand) => {
    const pending = deferred<unknown>();
    let acquired = false;
    vi.mocked(nativeInvoke).mockImplementation(async (command, args) => {
      if (command === pendingCommand) return pending.promise;
      if (command === "workspace_info") return workspace({ accessControlled: false, editor: acquired });
      if (command === "set_diagnostic_logging") return diagnostic(Boolean((args as { enabled: boolean }).enabled));
      return diagnostic();
    });
    component = () => NetworkDiagnosticsPanel({ ownerConfigured: false });
    if (pendingCommand === "reconnect_workspace_network") applyNetworkAccessStatus(net("disconnected"));
    render(); await flush();
    button(pendingCommand === "reconnect_workspace_network" ? "Подключить в режиме просмотра" : "Вернуться к редактированию").props.onClick!(); await flush();
    if (pendingCommand === "switch_workspace_mode") { button("Войти в обычный режим редактора").props.onClick!(); await flush(); }
    expect(vi.mocked(nativeInvoke).mock.calls.filter(([command]) => command === pendingCommand)).toHaveLength(1);
    expect(text()).toContain("экспорт диагностики доступны во время ожидания");
    expect(button("Включить журналирование").props.disabled).toBe(false);
    button("Включить журналирование").props.onClick!(); await flush();
    expect(nativeInvoke).toHaveBeenCalledWith("set_diagnostic_logging", { enabled: true });
    expect(text()).toContain("Журналирование включено");
    vi.mocked(save).mockResolvedValueOnce("C:\\Temp\\diagnostics-wait.zip");
    expect(button("Экспорт диагностики…").props.disabled).toBe(false);
    button("Экспорт диагностики…").props.onClick!(); await flush();
    expect(nativeInvoke).toHaveBeenCalledWith("export_diagnostic_bundle", { path: "C:\\Temp\\diagnostics-wait.zip" });
    expect(text()).toContain("Диагностический ZIP сохранён");
    acquired = pendingCommand === "switch_workspace_mode";
    pending.resolve(pendingCommand === "reconnect_workspace_network" ? net("connected") : pendingCommand === "workspace_info" ? workspace() : undefined); await flush();
    expect(text()).toContain("Диагностический ZIP сохранён");
    expect(text()).not.toContain("экспорт диагностики доступны во время ожидания");
    if (pendingCommand === "reconnect_workspace_network") expect(text()).toContain("Подключение восстановлено в режиме просмотра");
    if (pendingCommand === "switch_workspace_mode") expect(text()).toContain("Обычный вход редактора выполнен");
  });
  it("exports locally while disconnected, and cancelling the picker does not export", async () => {
    applyNetworkAccessStatus(net("disconnected")); render(); await flush();
    vi.mocked(save).mockResolvedValueOnce(null);
    button("Экспорт диагностики…").props.onClick!(); await flush();
    expect(vi.mocked(nativeInvoke).mock.calls.some(([command]) => command === "export_diagnostic_bundle")).toBe(false);
    vi.mocked(save).mockResolvedValueOnce("C:\\Temp\\diagnostics-new.zip");
    button("Экспорт диагностики…").props.onClick!(); await flush();
    expect(nativeInvoke).toHaveBeenCalledWith("export_diagnostic_bundle", { path: "C:\\Temp\\diagnostics-new.zip" });
    expect(text()).toContain("никуда не отправлен");
    await vi.advanceTimersByTimeAsync(9000); await flush();
    expect(vi.mocked(nativeInvoke).mock.calls.every(([command]) => ["diagnostic_status", "export_diagnostic_bundle"].includes(command))).toBe(true);
  });
  it("does not overwrite logging toggle with an older pending status poll", async () => {
    render(); await flush(); const pending = deferred<DiagnosticStatus>();
    vi.mocked(nativeInvoke).mockImplementation(async (command) => command === "diagnostic_status" ? pending.promise : diagnostic(true));
    await vi.advanceTimersByTimeAsync(3000); await flush();
    button("Включить журналирование").props.onClick!(); await flush();
    pending.resolve(diagnostic(false)); await flush();
    expect(text()).toContain("Журналирование включено");
  });
  it("does not perform native operations in browser preview", async () => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    render(); await flush(); expect(nativeInvoke).not.toHaveBeenCalled();
    expect(text()).toContain("Предпросмотр интерфейса");
    expect(button("Включить журналирование").props.disabled).toBe(true);
    expect(button("Экспорт диагностики…").props.disabled).toBe(true);
  });
  it("does not claim reconnection when the backend returns a failed transition", async () => {
    applyNetworkAccessStatus(net("disconnected"));
    vi.mocked(nativeInvoke).mockImplementation(async (command) => command === "reconnect_workspace_network" ? { ...net("disconnectFailed"), error: "Папка недоступна" } : diagnostic());
    render(); await flush(); button("Подключить в режиме просмотра").props.onClick!(); await flush();
    expect(text()).toContain("Папка недоступна");
    expect(text()).toContain("Отключение не завершено");
    expect(text()).not.toContain("Подключение восстановлено");
  });
});

describe("records survive a network pause", () => {
  it("retains cached records, ignores late replies and sends no paused refresh reads", async () => {
    let records!: ReturnType<typeof useRecords<{ value: string }>>;
    const first = [{ id: "1", title: "Cached", payload: { value: "keep" }, archived: false, createdAt: "", updatedAt: "" }];
    vi.mocked(nativeInvoke).mockResolvedValue(first);
    component = () => { records = useRecords<{ value: string }>("staff"); return null; };
    render(); await flush(); expect(records.records).toEqual(first);
    const pending = deferred<unknown[]>(); vi.mocked(nativeInvoke).mockReturnValueOnce(pending.promise);
    void records.reload(); await flush();
    applyNetworkAccessStatus(net("disconnected")); await flush();
    window.dispatchEvent(new Event("sbk-workspace-refresh")); await flush();
    pending.resolve([]); await flush();
    expect(records.records).toEqual(first); expect(records.loading).toBe(false);
    expect(nativeInvoke).toHaveBeenCalledTimes(2);
    vi.mocked(nativeInvoke).mockResolvedValueOnce(first);
    applyNetworkAccessStatus(net("connected")); await flush();
    expect(nativeInvoke).toHaveBeenCalledTimes(3); expect(records.records).toEqual(first);
  });
});
