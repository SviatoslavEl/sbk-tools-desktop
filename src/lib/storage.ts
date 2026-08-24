import { invoke } from "@tauri-apps/api/core";

export type ModuleId = "settings" | "calculator" | "scanner" | "contract-experience" | "staff";

export interface StoredRecord<T = unknown> {
  id: string;
  title: string;
  payload: T;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceInfo {
  root: string;
  portable: boolean;
  writable: boolean;
  schemaVersion: number;
  freeSpaceBytes: number;
}

export interface AttachmentInfo {
  relativePath: string;
  fileName: string;
  sizeBytes: number;
}

export interface BackupInfo {
  path: string;
  fileName: string;
  sizeBytes: number;
}

export interface SpreadsheetData {
  sheetName?: string;
  rows: string[][];
}

export interface HistoryEntry {
  action: "created" | "updated" | "archived" | "restored";
  createdAt: string;
}

const isTauri = () => "__TAURI_INTERNALS__" in window;
const fallbackKey = (module: ModuleId) => `sbk-tools:records:${module}`;

function readFallback<T>(module: ModuleId): StoredRecord<T>[] {
  try {
    return JSON.parse(localStorage.getItem(fallbackKey(module)) || "[]") as StoredRecord<T>[];
  } catch {
    return [];
  }
}

function writeFallback<T>(module: ModuleId, records: StoredRecord<T>[]) {
  localStorage.setItem(fallbackKey(module), JSON.stringify(records));
}

export async function getWorkspaceInfo(): Promise<WorkspaceInfo> {
  if (isTauri()) return invoke<WorkspaceInfo>("workspace_info");
  return {
    root: "ProductData (режим предпросмотра)",
    portable: true,
    writable: true,
    schemaVersion: 1,
    freeSpaceBytes: 0,
  };
}

export async function setWorkspaceLocation(path: string): Promise<string> {
  if (!isTauri()) throw new Error("Выбор рабочей папки доступен в desktop-версии");
  return invoke<string>("set_workspace_location", { path });
}

export async function readXlsx(path: string): Promise<SpreadsheetData> {
  if (!isTauri()) throw new Error("Импорт XLSX доступен в desktop-версии");
  return invoke<SpreadsheetData>("read_xlsx", { path });
}

export async function writeXlsx(path: string, data: SpreadsheetData): Promise<void> {
  if (!isTauri()) throw new Error("Экспорт XLSX доступен в desktop-версии");
  await invoke("write_xlsx", { path, data });
}

export async function listRecords<T>(module: ModuleId, includeArchived = false): Promise<StoredRecord<T>[]> {
  if (isTauri()) return invoke<StoredRecord<T>[]>("list_records", { module, includeArchived });
  return readFallback<T>(module).filter((record) => includeArchived || !record.archived);
}

export async function recordHistory(module: ModuleId, id: string): Promise<HistoryEntry[]> {
  if (!isTauri()) return [];
  return invoke<HistoryEntry[]>("record_history", { module, id });
}

export async function saveRecord<T>(
  module: ModuleId,
  title: string,
  payload: T,
  id?: string,
): Promise<StoredRecord<T>> {
  if (isTauri()) return invoke<StoredRecord<T>>("upsert_record", { module, id: id || null, title, payload });
  const records = readFallback<T>(module);
  const now = new Date().toISOString();
  const record: StoredRecord<T> = {
    id: id || crypto.randomUUID(),
    title,
    payload,
    archived: false,
    createdAt: records.find((item) => item.id === id)?.createdAt || now,
    updatedAt: now,
  };
  const index = records.findIndex((item) => item.id === record.id);
  if (index >= 0) records[index] = record;
  else records.unshift(record);
  writeFallback(module, records);
  return record;
}

export async function archiveRecord(module: ModuleId, id: string, archived = true): Promise<void> {
  if (isTauri()) {
    await invoke("archive_record", { module, id, archived });
    return;
  }
  const records = readFallback(module);
  const record = records.find((item) => item.id === id);
  if (record) {
    record.archived = archived;
    record.updatedAt = new Date().toISOString();
    writeFallback(module, records);
  }
}

export async function copyAttachment(
  sourcePath: string,
  module: ModuleId,
  recordId: string,
): Promise<AttachmentInfo> {
  if (!isTauri()) throw new Error("Вложения доступны в desktop-версии");
  return invoke<AttachmentInfo>("copy_attachment", { sourcePath, module, recordId });
}

export async function writeTextFile(path: string, content: string): Promise<void> {
  if (!isTauri()) {
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = path.split(/[\\/]/).pop() || "export.csv";
    link.click();
    URL.revokeObjectURL(link.href);
    return;
  }
  await invoke("write_text_file", { path, content });
}

export async function readTextFile(path: string): Promise<string> {
  if (!isTauri()) throw new Error("Импорт по пути доступен в desktop-версии");
  return invoke<string>("read_text_file", { path, maxBytes: 20 * 1024 * 1024 });
}

export async function createBackup(module?: ModuleId): Promise<BackupInfo> {
  if (!isTauri()) throw new Error("Резервные копии доступны в desktop-версии");
  return invoke<BackupInfo>("create_backup", { module: module || null });
}

export async function restoreBackup(path: string): Promise<void> {
  if (!isTauri()) throw new Error("Восстановление доступно в desktop-версии");
  await invoke("restore_backup", { path });
}

export function saveDraft<T>(key: string, value: T) {
  localStorage.setItem(`sbk-tools:draft:${key}`, JSON.stringify({ value, savedAt: new Date().toISOString() }));
}

export function readDraft<T>(key: string): T | null {
  try {
    return JSON.parse(localStorage.getItem(`sbk-tools:draft:${key}`) || "null")?.value ?? null;
  } catch {
    return null;
  }
}

export function clearDraft(key: string) {
  localStorage.removeItem(`sbk-tools:draft:${key}`);
}
