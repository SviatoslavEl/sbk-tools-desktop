import { invoke as nativeInvoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";

export type NetworkPhase = "connected" | "disconnecting" | "disconnected" | "disconnectFailed" | "reconnecting";
export interface NetworkAccessStatus {
  phase: NetworkPhase;
  activeOperations: number;
  changedAt: string;
  error: string | null;
  restartRequired: false;
}
export interface DiagnosticStatus {
  enabled: boolean;
  sessionId: string;
  pendingOperations: number;
  writeFailures: number;
  droppedEvents: number;
  available: boolean;
  restartRequired: false;
}

export const networkAccessEvent = "sbk-network-access-changed";
export const openNetworkDiagnosticsEvent = "sbk-open-network-diagnostics";
export const networkDiagnosticsShortcutLabel = "Ctrl/⌘+Shift+D";
export const networkPausedMessage = "Связь с общей базой на этом компьютере приостановлена. Показаны последние загруженные данные — они могут быть неактуальны. Запись и работа с файлами недоступны.";
let current: NetworkAccessStatus = { phase: "connected", activeOperations: 0, changedAt: "", error: null, restartRequired: false };
const subscribers = new Set<() => void>();
export const isDesktopRuntime = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
export const getNetworkAccessSnapshot = () => current;
export const networkAccessIsPaused = () => current.phase !== "connected";

/** Works above a modal without closing it, saving a form, or changing tools. */
export function subscribeNetworkDiagnosticsShortcut(
  target: Pick<Window, "addEventListener" | "removeEventListener">,
  open: () => void,
) {
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.repeat || event.isComposing || event.altKey
      || !event.shiftKey || !(event.ctrlKey || event.metaKey)
      || !(event.code === "KeyD" || event.key.toLowerCase() === "d")) return;
    event.preventDefault();
    open();
  };
  const options = { capture: true };
  target.addEventListener("keydown", onKeyDown, options);
  return () => target.removeEventListener("keydown", onKeyDown, options);
}

export function applyNetworkAccessStatus(next: NetworkAccessStatus) {
  // A delayed poll must not overwrite a newer transition delivered by an event.
  if (current.changedAt && next.changedAt && Date.parse(next.changedAt) < Date.parse(current.changedAt)) return;
  const changed = next.phase !== current.phase;
  current = next;
  subscribers.forEach((notify) => notify());
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(networkAccessEvent, { detail: next }));
    if (changed && next.phase === "connected") window.dispatchEvent(new Event("sbk-workspace-refresh"));
  }
}

export function useNetworkAccess() {
  const [status, setStatus] = useState(getNetworkAccessSnapshot);
  useEffect(() => {
    const update = () => setStatus(getNetworkAccessSnapshot());
    subscribers.add(update); update();
    return () => { subscribers.delete(update); };
  }, []);
  return status;
}

export async function refreshNetworkAccessStatus() {
  const status = await nativeInvoke<NetworkAccessStatus>("network_access_status");
  applyNetworkAccessStatus(status);
  return status;
}

/** One app-level monitor. These commands only inspect process-local state. */
export function startNetworkAccessMonitor() {
  if (!isDesktopRuntime()) return () => undefined;
  let stopped = false;
  let running = false;
  let unlisten: (() => void) | undefined;
  const refresh = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const status = await nativeInvoke<NetworkAccessStatus>("network_access_status");
      if (!stopped) applyNetworkAccessStatus(status);
    } catch { /* Preserve the last confirmed state; never infer a successful reconnect. */ }
    finally { running = false; }
  };
  void listen<NetworkAccessStatus>("network-access-changed", ({ payload }) => { if (!stopped) applyNetworkAccessStatus(payload); })
    .then((dispose) => { if (stopped) dispose(); else unlisten = dispose; }).catch(() => undefined);
  void refresh();
  const timer = window.setInterval(() => void refresh(), 1000);
  return () => { stopped = true; window.clearInterval(timer); unlisten?.(); };
}

export async function disconnectWorkspaceNetwork(password: string) {
  try {
    const status = await nativeInvoke<NetworkAccessStatus>("disconnect_workspace_network", { password });
    applyNetworkAccessStatus(status);
    return status;
  } catch (error) {
    // Cleanup can fail after the backend gate has already closed.
    await refreshNetworkAccessStatus().catch(() => undefined);
    throw error;
  }
}
export async function reconnectWorkspaceNetwork() {
  try {
    const status = await nativeInvoke<NetworkAccessStatus>("reconnect_workspace_network");
    applyNetworkAccessStatus(status);
    return status;
  } catch (error) {
    await refreshNetworkAccessStatus().catch(() => undefined);
    throw error;
  }
}
export const getDiagnosticStatus = () => nativeInvoke<DiagnosticStatus>("diagnostic_status");
export const setDiagnosticLogging = (enabled: boolean) => nativeInvoke<DiagnosticStatus>("set_diagnostic_logging", { enabled });
export const exportDiagnosticBundle = (path: string) => nativeInvoke<void>("export_diagnostic_bundle", { path });

const localCommands = new Set(["startup_status", "report_startup_ui_visible", "quit_application"]);
/** UI guard supplements the native gate; it is not an authorization boundary. */
export function assertNetworkAccess() {
  if (networkAccessIsPaused()) throw new Error(networkPausedMessage);
}
export function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!localCommands.has(command) && networkAccessIsPaused()) return Promise.reject(new Error(networkPausedMessage));
  return nativeInvoke<T>(command, args);
}
export const openDocumentPath = (path: string) => invoke<void>("open_document_path", { path });
