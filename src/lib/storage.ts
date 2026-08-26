import { invoke } from "@tauri-apps/api/core";

export type ModuleId = "settings" | "calculator" | "scanner" | "contract-experience" | "staff" | "procurement";

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
  sha256: string;
  mimeType: string;
}

export interface AttachmentAudit {
  referencedFiles: number;
  storedFiles: number;
  orphanedFiles: number;
  orphanedBytes: number;
  removedFiles: number;
}

export interface BackupInfo {
  path: string;
  fileName: string;
  sizeBytes: number;
}

export interface BackupListItem extends BackupInfo { modifiedAt: string; pinned: boolean }
export interface BackupVerification { sha256: string; createdAt: string; modules: string[]; files: number; unpackedBytes: number }

export interface SpreadsheetData {
  sheetName?: string;
  rows: string[][];
}

export interface HistoryEntry {
  id: number;
  action: "created" | "updated" | "archived" | "restored" | "version-restored";
  createdAt: string;
  snapshot?: true;
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

export async function restoreHistoryVersion<T>(module: ModuleId, id: string, historyId: number): Promise<StoredRecord<T>> {
  if (!isTauri()) throw new Error("История версий доступна в desktop-версии");
  return invoke<StoredRecord<T>>("restore_history_version", { module, id, historyId });
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

export async function importRecordsAtomic<T>(module: ModuleId, records: Array<{ id: string; title: string; payload: T }>): Promise<number> {
  if (isTauri()) return invoke<number>("import_records_atomic", { module, records });
  const existing = readFallback<T>(module);
  const now = new Date().toISOString();
  writeFallback(module, [...records.map((record) => ({ ...record, archived: false, createdAt: now, updatedAt: now })), ...existing]);
  return records.length;
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

export async function deleteRecord(module: ModuleId, id: string): Promise<void> {
  if (isTauri()) {
    await invoke("delete_record", { module, id });
    return;
  }
  writeFallback(module, readFallback(module).filter((record) => record.id !== id));
}

export async function copyAttachment(
  sourcePath: string,
  module: ModuleId,
  recordId: string,
): Promise<AttachmentInfo> {
  if (!isTauri()) throw new Error("Вложения доступны в desktop-версии");
  return invoke<AttachmentInfo>("copy_attachment", { sourcePath, module, recordId });
}

export async function deleteAttachment(relativePath: string): Promise<void> {
  if (!isTauri()) throw new Error("Вложения доступны в desktop-версии");
  await invoke("delete_attachment", { relativePath });
}

export async function discardStagedAttachments(module: ModuleId, recordId: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("discard_staged_attachments", { module, recordId });
}

export async function auditAttachments(remove = false): Promise<AttachmentAudit> {
  if (!isTauri()) return { referencedFiles: 0, storedFiles: 0, orphanedFiles: 0, orphanedBytes: 0, removedFiles: 0 };
  return invoke<AttachmentAudit>("audit_attachments", { remove });
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
export async function createEncryptedBackup(password: string, module?: ModuleId): Promise<BackupInfo> { if (!isTauri()) throw new Error("Зашифрованные копии доступны в desktop-версии"); return invoke("create_encrypted_backup", { module: module || null, password }); }
export async function verifyEncryptedBackup(path: string, password: string): Promise<BackupVerification> { if (!isTauri()) throw new Error("Проверка доступна в desktop-версии"); return invoke("verify_encrypted_backup", { path, password }); }
export async function restoreEncryptedBackup(path: string, password: string): Promise<void> { if (!isTauri()) throw new Error("Восстановление доступно в desktop-версии"); await invoke("restore_encrypted_backup", { path, password }); }

export async function restoreBackup(path: string): Promise<void> {
  if (!isTauri()) throw new Error("Восстановление доступно в desktop-версии");
  await invoke("restore_backup", { path });
}

export async function listBackups(): Promise<BackupListItem[]> { return isTauri() ? invoke("list_backups") : []; }
export async function setBackupPinned(fileName: string, pinned: boolean): Promise<void> { if (!isTauri()) return; await invoke("set_backup_pinned", { fileName, pinned }); }
export async function deleteBackup(fileName: string): Promise<void> { if (!isTauri()) return; await invoke("delete_backup", { fileName }); }
export async function rotateBackups(keep: number, maxAgeDays: number): Promise<number> { if (!isTauri()) return 0; return invoke<number>("rotate_backups", { keep, maxAgeDays }); }
export async function verifyBackup(path: string): Promise<BackupVerification> { if (!isTauri()) throw new Error("Проверка доступна в desktop-версии"); return invoke("verify_backup", { path }); }

export async function saveDraft<T>(key: ModuleId, value: T, draftKey = "current"): Promise<void> {
  if (isTauri()) {
    await invoke("save_draft", { module: key, key: draftKey, payload: value });
    return;
  }
  localStorage.setItem(`sbk-tools:draft:${key}:${draftKey}`, JSON.stringify({ value, savedAt: new Date().toISOString() }));
}

export async function readDraft<T>(key: ModuleId, draftKey = "current"): Promise<T | null> {
  if (isTauri()) return invoke<T | null>("read_draft", { module: key, key: draftKey });
  try {
    return JSON.parse(localStorage.getItem(`sbk-tools:draft:${key}:${draftKey}`) || "null")?.value ?? null;
  } catch {
    return null;
  }
}

export async function clearDraft(key: ModuleId, draftKey = "current"): Promise<void> {
  if (isTauri()) {
    await invoke("clear_draft", { module: key, key: draftKey });
    return;
  }
  localStorage.removeItem(`sbk-tools:draft:${key}:${draftKey}`);
}

export async function pruneHistory(limit: number): Promise<number> {
  if (!isTauri()) return 0;
  return invoke<number>("prune_history", { limit });
}
