import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke as nativeInvoke } from "@tauri-apps/api/core";
import {
  applyNetworkAccessStatus, disconnectWorkspaceNetwork, exportDiagnosticBundle,
  getDiagnosticStatus, getNetworkAccessSnapshot, invoke, networkAccessIsPaused,
  openDocumentPath, reconnectWorkspaceNetwork, setDiagnosticLogging, subscribeNetworkDiagnosticsShortcut,
  type NetworkAccessStatus,
} from "./networkDiagnostics";
import { chooseDirectory, chooseOpenPath, chooseSavePath } from "./files";
import { open, save } from "@tauri-apps/plugin-dialog";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
const status = (phase: NetworkAccessStatus["phase"], changedAt = ""): NetworkAccessStatus => ({ phase, activeOperations: 0, changedAt, error: null, restartRequired: false });
beforeEach(() => {
  const events = new EventTarget();
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {}, dispatchEvent: events.dispatchEvent.bind(events), addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) });
  applyNetworkAccessStatus(status("connected"));
  vi.clearAllMocks();
});
afterEach(() => { applyNetworkAccessStatus(status("connected")); vi.unstubAllGlobals(); });

describe("network diagnostics native contract and UI gate", () => {
  it.each([
    { ctrlKey: true, metaKey: false, key: "D", code: "KeyD" },
    { ctrlKey: false, metaKey: true, key: "D", code: "KeyD" },
    { ctrlKey: true, metaKey: false, key: "В", code: "KeyD" },
  ])("opens one diagnostic view above a dirty modal with Ctrl/Command and any keyboard layout: %j", (keys) => {
    const target = new EventTarget();
    const dirtyCard = { text: "Несохранённый договор", mounted: true };
    let showDiagnostics = false;
    const openDiagnostics = vi.fn(() => { showDiagnostics = true; });
    const unsubscribe = subscribeNetworkDiagnosticsShortcut(target as unknown as Window, openDiagnostics);
    const press = () => {
      const event = Object.assign(new Event("keydown", { cancelable: true }), { ...keys, shiftKey: true, altKey: false, repeat: false, isComposing: false });
      target.dispatchEvent(event); return event;
    };
    expect(press().defaultPrevented).toBe(true); press();
    expect(showDiagnostics).toBe(true);
    expect(dirtyCard).toEqual({ text: "Несохранённый договор", mounted: true });
    expect(nativeInvoke).not.toHaveBeenCalled();
    unsubscribe(); const calls = openDiagnostics.mock.calls.length;
    expect(press().defaultPrevented).toBe(false); expect(openDiagnostics).toHaveBeenCalledTimes(calls);
  });
  it.each([{ shiftKey: false }, { ctrlKey: false }, { altKey: true }, { repeat: true }, { isComposing: true }, { key: "K", code: "KeyK" }])("does not intercept ordinary typing or an unrelated shortcut: %j", (patch) => {
    const target = new EventTarget(); const openDiagnostics = vi.fn();
    const unsubscribe = subscribeNetworkDiagnosticsShortcut(target as unknown as Window, openDiagnostics);
    const event = Object.assign(new Event("keydown", { cancelable: true }), { key: "D", code: "KeyD", ctrlKey: true, metaKey: false, shiftKey: true, altKey: false, repeat: false, isComposing: false, ...patch });
    target.dispatchEvent(event); unsubscribe();
    expect(event.defaultPrevented).toBe(false); expect(openDiagnostics).not.toHaveBeenCalled();
  });
  it("sends the owner password only for explicit disconnect, never caches it", async () => {
    vi.mocked(nativeInvoke).mockResolvedValueOnce(status("disconnected"));
    await disconnectWorkspaceNetwork("synthetic-owner-credential");
    expect(nativeInvoke).toHaveBeenCalledExactlyOnceWith("disconnect_workspace_network", { password: "synthetic-owner-credential" });
    expect(networkAccessIsPaused()).toBe(true);
    expect(JSON.stringify(getNetworkAccessSnapshot())).not.toContain("credential");
  });
  it("reconnects without acquiring editor or sending a password", async () => {
    applyNetworkAccessStatus(status("disconnected"));
    const refreshed = vi.fn(); window.addEventListener("sbk-workspace-refresh", refreshed);
    vi.mocked(nativeInvoke).mockResolvedValueOnce(status("connected"));
    await reconnectWorkspaceNetwork();
    expect(nativeInvoke).toHaveBeenCalledExactlyOnceWith("reconnect_workspace_network");
    expect(refreshed).toHaveBeenCalledOnce();
  });
  it.each(["disconnecting", "disconnected", "disconnectFailed", "reconnecting"] as const)("blocks ordinary calls and source-file dialogs in %s", async (phase) => {
    applyNetworkAccessStatus(status(phase));
    for (const command of ["workspace_info", "workspace_owner_info", "workspace_health", "list_records", "read_draft", "upsert_record", "scanner_run", "proposal_render", "create_registry_archive"]) {
      await expect(invoke(command)).rejects.toThrow("приостановлена");
    }
    await expect(openDocumentPath("Z:\\source.pdf")).rejects.toThrow("приостановлена");
    await expect(chooseDirectory("Папка")).rejects.toThrow("приостановлена");
    await expect(chooseOpenPath("Открыть", ["pdf"])).rejects.toThrow("приостановлена");
    await expect(chooseSavePath("Сохранить", "Z:\\out.pdf", ["pdf"])).rejects.toThrow("приостановлена");
    expect(nativeInvoke).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
  });
  it("keeps local diagnostics and startup/quit usable while disconnected", async () => {
    applyNetworkAccessStatus(status("disconnected"));
    vi.mocked(nativeInvoke).mockResolvedValue(undefined);
    await getDiagnosticStatus(); await setDiagnosticLogging(true); await exportDiagnosticBundle("C:\\Temp\\diagnostics-new.zip");
    await invoke("startup_status"); await invoke("quit_application");
    expect(vi.mocked(nativeInvoke).mock.calls).toEqual([
      ["diagnostic_status"], ["set_diagnostic_logging", { enabled: true }], ["export_diagnostic_bundle", { path: "C:\\Temp\\diagnostics-new.zip" }], ["startup_status", undefined], ["quit_application", undefined],
    ]);
  });
  it("fetches confirmed gate state after disconnect failure without claiming completion", async () => {
    vi.mocked(nativeInvoke).mockRejectedValueOnce(new Error("cleanup failed")).mockResolvedValueOnce({ ...status("disconnectFailed"), error: "Cleanup remains pending" });
    await expect(disconnectWorkspaceNetwork("synthetic")).rejects.toThrow("cleanup failed");
    expect(getNetworkAccessSnapshot().phase).toBe("disconnectFailed");
    expect(networkAccessIsPaused()).toBe(true);
  });
  it("ignores an older connected status after a confirmed disconnect", () => {
    applyNetworkAccessStatus(status("disconnected", "2026-10-01T10:02:00Z"));
    applyNetworkAccessStatus(status("connected", "2026-10-01T10:01:00Z"));
    expect(getNetworkAccessSnapshot().phase).toBe("disconnected");
  });
  it("routes document opening through the custom native gate when connected", async () => {
    await openDocumentPath("C:\\Temp\\source.pdf");
    expect(nativeInvoke).toHaveBeenCalledExactlyOnceWith("open_document_path", { path: "C:\\Temp\\source.pdf" });
  });
});
