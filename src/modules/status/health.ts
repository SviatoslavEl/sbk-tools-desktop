import { invoke } from "@tauri-apps/api/core";
import type { WorkspaceInfo } from "../../lib/storage";
export interface WorkspaceHealth {
  checkedAt: string; appVersion: string; schemaVersion: number; root: string;
  available: boolean; writable: boolean; writableBasis: string; readLatencyMs: number;
  editor: { busy: boolean; ownedByThisInstance: boolean; owner?: WorkspaceInfo["editorOwner"] | null; message?: string | null };
  backup: { latest?: { fileName: string; path: string; sizeBytes: number; modifiedAt: string; pinned: boolean | null } | null; verification: {status: string; message: string} };
  issues: Array<{ code: string; severity: "warning" | "error"; message: string }>;
}
export async function getWorkspaceHealth(workspace: WorkspaceInfo): Promise<WorkspaceHealth> {
  if ("__TAURI_INTERNALS__" in window) return invoke<WorkspaceHealth>("workspace_health");
  return {
    checkedAt: new Date().toISOString(), appVersion: "Предпросмотр", schemaVersion: workspace.schemaVersion, root: workspace.root,
    available: false, writable: false, writableBasis: "preview", readLatencyMs: 0,
    editor: { busy: workspace.editorBusy, ownedByThisInstance: workspace.editor, owner: workspace.editorOwner },
    backup: { verification: { status: "unavailable", message: "Резервные копии и диагностика диска доступны в установленном приложении." } },
    issues: [{ code: "preview", severity: "warning", message: "Предпросмотр интерфейса. Проверки сетевой папки здесь не выполняются." }],
  };
}
