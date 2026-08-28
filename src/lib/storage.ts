import { invoke } from "@tauri-apps/api/core";

export type ModuleId =
  | "settings"
  | "calculator"
  | "scanner"
  | "contract-experience"
  | "staff"
  | "procurement"
  | "tender-calendar";

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
  configured: boolean;
  warning?: string;
  writable: boolean;
  editor: boolean;
  accessMessage: string;
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

export interface BackupListItem extends BackupInfo {
  modifiedAt: string;
  pinned: boolean;
}
export interface BackupVerification {
  sha256: string;
  createdAt: string;
  modules: string[];
  files: number;
  unpackedBytes: number;
}

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
export const workspaceAccessInvalidatedEvent =
  "sbk-workspace-access-invalidated";

export function isWorkspaceAccessError(reason: unknown): boolean {
  const message = String(reason);
  return (
    message.includes("Блокировка общей папки потеряна") ||
    message.includes("Общая база открыта только для просмотра") ||
    message.includes("нужны права записи на папку")
  );
}

async function invokeMutation<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (reason) {
    if (isWorkspaceAccessError(reason))
      window.dispatchEvent(new Event(workspaceAccessInvalidatedEvent));
    throw reason;
  }
}

function readFallback<T>(module: ModuleId): StoredRecord<T>[] {
  try {
    return JSON.parse(
      localStorage.getItem(fallbackKey(module)) || "[]",
    ) as StoredRecord<T>[];
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
    configured: true,
    writable: true,
    editor: true,
    accessMessage: "Режим предпросмотра",
    schemaVersion: 1,
    freeSpaceBytes: 0,
  };
}

export async function setWorkspaceLocation(path: string): Promise<string> {
  if (!isTauri())
    throw new Error("Выбор рабочей папки доступен в desktop-версии");
  return invoke<string>("set_workspace_location", { path });
}

export async function quitApplication(): Promise<void> {
  if (isTauri()) await invoke("quit_application");
}

export async function readXlsx(path: string): Promise<SpreadsheetData> {
  if (!isTauri()) throw new Error("Импорт XLSX доступен в desktop-версии");
  return invoke<SpreadsheetData>("read_xlsx", { path });
}

export async function readDocxTable(path: string): Promise<SpreadsheetData> {
  if (!isTauri()) throw new Error("Импорт DOCX доступен в desktop-версии");
  return invoke<SpreadsheetData>("read_docx_table", { path });
}

export interface ContractReportData {
  title: string;
  criteria: string;
  rows: Array<{
    legalEntity: string;
    number: string;
    date: string;
    customer: string;
    subject: string;
    amount: string;
    amountValue: number | null;
    period: string;
  }>;
}
export async function writeContractReportDocx(
  path: string,
  data: ContractReportData,
): Promise<void> {
  if (!isTauri()) throw new Error("Экспорт DOCX доступен в desktop-версии");
  await invoke("write_contract_report_docx", { path, data });
}
export async function writeContractReportPdf(
  path: string,
  data: ContractReportData,
): Promise<void> {
  if (!isTauri()) throw new Error("Экспорт PDF доступен в desktop-версии");
  await invoke("write_contract_report_pdf", { path, data });
}

export async function writeXlsx(
  path: string,
  data: SpreadsheetData,
): Promise<void> {
  if (!isTauri()) throw new Error("Экспорт XLSX доступен в desktop-версии");
  await invoke("write_xlsx", { path, data });
}

export async function listRecords<T>(
  module: ModuleId,
  includeArchived = false,
): Promise<StoredRecord<T>[]> {
  if (isTauri())
    return invoke<StoredRecord<T>[]>("list_records", {
      module,
      includeArchived,
    });
  return readFallback<T>(module).filter(
    (record) => includeArchived || !record.archived,
  );
}

export async function recordHistory(
  module: ModuleId,
  id: string,
): Promise<HistoryEntry[]> {
  if (!isTauri()) return [];
  return invoke<HistoryEntry[]>("record_history", { module, id });
}

export async function restoreHistoryVersion<T>(
  module: ModuleId,
  id: string,
  historyId: number,
): Promise<StoredRecord<T>> {
  if (!isTauri()) throw new Error("История версий доступна в desktop-версии");
  return invokeMutation<StoredRecord<T>>("restore_history_version", {
    module,
    id,
    historyId,
  });
}

export async function saveRecord<T>(
  module: ModuleId,
  title: string,
  payload: T,
  id?: string,
): Promise<StoredRecord<T>> {
  if (isTauri())
    return invokeMutation<StoredRecord<T>>("upsert_record", {
      module,
      id: id || null,
      title,
      payload,
    });
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

export async function importRecordsAtomic<T>(
  module: ModuleId,
  records: Array<{ id: string; title: string; payload: T }>,
): Promise<number> {
  if (isTauri())
    return invokeMutation<number>("import_records_atomic", { module, records });
  const existing = readFallback<T>(module);
  const now = new Date().toISOString();
  writeFallback(module, [
    ...records.map((record) => ({
      ...record,
      archived: false,
      createdAt: now,
      updatedAt: now,
    })),
    ...existing,
  ]);
  return records.length;
}

export interface RecordMutation<T> {
  id: string;
  title: string;
  payload: T;
}

export async function importContractsWithCompanyDirectoryAtomic<T, D>(
  records: RecordMutation<T>[],
  directory: D,
): Promise<number> {
  if (isTauri())
    return invokeMutation<number>(
      "import_contracts_with_company_directory_atomic",
      { records, directory },
    );
  const recordsKey = fallbackKey("contract-experience");
  const draftKey = "sbk-tools:draft:contract-experience:company-directory-v1";
  const previousRecords = localStorage.getItem(recordsKey);
  const previousDirectory = localStorage.getItem(draftKey);
  try {
    const existing = readFallback<T>("contract-experience");
    const existingIds = new Set(existing.map((record) => record.id));
    if (records.some((record) => existingIds.has(record.id)))
      throw new Error("Договор с таким идентификатором уже существует");
    const now = new Date().toISOString();
    writeFallback("contract-experience", [
      ...records.map((record) => ({
        ...record,
        archived: false,
        createdAt: now,
        updatedAt: now,
      })),
      ...existing,
    ]);
    localStorage.setItem(
      draftKey,
      JSON.stringify({ value: directory, savedAt: now }),
    );
    return records.length;
  } catch (reason) {
    if (previousRecords === null) localStorage.removeItem(recordsKey);
    else localStorage.setItem(recordsKey, previousRecords);
    if (previousDirectory === null) localStorage.removeItem(draftKey);
    else localStorage.setItem(draftKey, previousDirectory);
    throw reason;
  }
}

export async function updateContractsAndCompanyDirectoryAtomic<T, D>(
  records: RecordMutation<T>[],
  directory: D,
): Promise<number> {
  if (isTauri())
    return invokeMutation<number>(
      "update_contracts_and_company_directory_atomic",
      { records, directory },
    );
  const recordsKey = fallbackKey("contract-experience");
  const draftKey = "sbk-tools:draft:contract-experience:company-directory-v1";
  const previousRecords = localStorage.getItem(recordsKey);
  const previousDirectory = localStorage.getItem(draftKey);
  try {
    const existing = readFallback<T>("contract-experience");
    const byId = new Map(records.map((record) => [record.id, record]));
    if (
      records.some(
        (record) =>
          !existing.some((item) => item.id === record.id && !item.archived),
      )
    )
      throw new Error("Связанный договор не найден");
    const now = new Date().toISOString();
    writeFallback(
      "contract-experience",
      existing.map((record) => {
        const update = byId.get(record.id);
        return update
          ? {
              ...record,
              title: update.title,
              payload: update.payload,
              updatedAt: now,
            }
          : record;
      }),
    );
    localStorage.setItem(
      draftKey,
      JSON.stringify({ value: directory, savedAt: now }),
    );
    return records.length;
  } catch (reason) {
    if (previousRecords === null) localStorage.removeItem(recordsKey);
    else localStorage.setItem(recordsKey, previousRecords);
    if (previousDirectory === null) localStorage.removeItem(draftKey);
    else localStorage.setItem(draftKey, previousDirectory);
    throw reason;
  }
}

export async function saveContractWithCompanyDirectoryAtomic<T, D>(
  title: string,
  payload: T,
  directory: D,
  id?: string,
): Promise<StoredRecord<T>> {
  if (isTauri())
    return invokeMutation<StoredRecord<T>>(
      "save_contract_with_company_directory_atomic",
      { id: id || null, title, payload, directory },
    );
  const recordsKey = fallbackKey("contract-experience");
  const draftKey = "sbk-tools:draft:contract-experience:company-directory-v1";
  const previousRecords = localStorage.getItem(recordsKey);
  const previousDirectory = localStorage.getItem(draftKey);
  try {
    const records = readFallback<T>("contract-experience");
    const now = new Date().toISOString();
    const recordId = id || crypto.randomUUID();
    const existing = records.find((record) => record.id === recordId);
    const saved: StoredRecord<T> = {
      id: recordId,
      title,
      payload,
      archived: false,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    writeFallback("contract-experience", [
      saved,
      ...records.filter((record) => record.id !== recordId),
    ]);
    localStorage.setItem(
      draftKey,
      JSON.stringify({ value: directory, savedAt: now }),
    );
    return saved;
  } catch (reason) {
    if (previousRecords === null) localStorage.removeItem(recordsKey);
    else localStorage.setItem(recordsKey, previousRecords);
    if (previousDirectory === null) localStorage.removeItem(draftKey);
    else localStorage.setItem(draftKey, previousDirectory);
    throw reason;
  }
}

export async function archiveRecord(
  module: ModuleId,
  id: string,
  archived = true,
): Promise<void> {
  if (isTauri()) {
    await invokeMutation("archive_record", { module, id, archived });
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

export async function deleteRecord(
  module: ModuleId,
  id: string,
): Promise<void> {
  if (isTauri()) {
    await invokeMutation("delete_record", { module, id });
    return;
  }
  writeFallback(
    module,
    readFallback(module).filter((record) => record.id !== id),
  );
}

export async function copyAttachment(
  sourcePath: string,
  module: ModuleId,
  recordId: string,
): Promise<AttachmentInfo> {
  if (!isTauri()) throw new Error("Вложения доступны в desktop-версии");
  return invokeMutation<AttachmentInfo>("copy_attachment", {
    sourcePath,
    module,
    recordId,
  });
}

export async function deleteAttachment(relativePath: string): Promise<void> {
  if (!isTauri()) throw new Error("Вложения доступны в desktop-версии");
  await invokeMutation("delete_attachment", { relativePath });
}

export async function discardStagedAttachments(
  module: ModuleId,
  recordId: string,
): Promise<void> {
  if (!isTauri()) return;
  await invokeMutation("discard_staged_attachments", { module, recordId });
}

export async function auditAttachments(
  remove = false,
): Promise<AttachmentAudit> {
  if (!isTauri())
    return {
      referencedFiles: 0,
      storedFiles: 0,
      orphanedFiles: 0,
      orphanedBytes: 0,
      removedFiles: 0,
    };
  return remove
    ? invokeMutation<AttachmentAudit>("audit_attachments", { remove })
    : invoke<AttachmentAudit>("audit_attachments", { remove });
}

export async function writeTextFile(
  path: string,
  content: string,
): Promise<void> {
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
  return invokeMutation<BackupInfo>("create_backup", {
    module: module || null,
  });
}
export async function createRegistryArchive(
  module: ModuleId,
  path: string,
  recordIds?: string[],
): Promise<BackupInfo> {
  if (!isTauri())
    throw new Error("Архив со вложениями доступен в desktop-версии");
  return invoke<BackupInfo>("create_registry_archive", {
    module,
    path,
    recordIds: recordIds || null,
  });
}
export async function createEncryptedBackup(
  password: string,
  module?: ModuleId,
): Promise<BackupInfo> {
  if (!isTauri())
    throw new Error("Зашифрованные копии доступны в desktop-версии");
  return invokeMutation("create_encrypted_backup", {
    module: module || null,
    password,
  });
}
export async function verifyEncryptedBackup(
  path: string,
  password: string,
): Promise<BackupVerification> {
  if (!isTauri()) throw new Error("Проверка доступна в desktop-версии");
  return invoke("verify_encrypted_backup", { path, password });
}
export async function restoreEncryptedBackup(
  path: string,
  password: string,
): Promise<void> {
  if (!isTauri()) throw new Error("Восстановление доступно в desktop-версии");
  await invokeMutation("restore_encrypted_backup", { path, password });
}

export async function restoreBackup(path: string): Promise<void> {
  if (!isTauri()) throw new Error("Восстановление доступно в desktop-версии");
  await invokeMutation("restore_backup", { path });
}

export async function listBackups(): Promise<BackupListItem[]> {
  return isTauri() ? invoke("list_backups") : [];
}
export async function setBackupPinned(
  fileName: string,
  pinned: boolean,
): Promise<void> {
  if (!isTauri()) return;
  await invokeMutation("set_backup_pinned", { fileName, pinned });
}
export async function deleteBackup(fileName: string): Promise<void> {
  if (!isTauri()) return;
  await invokeMutation("delete_backup", { fileName });
}
export async function rotateBackups(
  keep: number,
  maxAgeDays: number,
): Promise<number> {
  if (!isTauri()) return 0;
  return invokeMutation<number>("rotate_backups", { keep, maxAgeDays });
}
export async function verifyBackup(path: string): Promise<BackupVerification> {
  if (!isTauri()) throw new Error("Проверка доступна в desktop-версии");
  return invoke("verify_backup", { path });
}

export async function saveDraft<T>(
  key: ModuleId,
  value: T,
  draftKey = "current",
): Promise<void> {
  if (isTauri()) {
    await invokeMutation("save_draft", {
      module: key,
      key: draftKey,
      payload: value,
    });
    return;
  }
  localStorage.setItem(
    `sbk-tools:draft:${key}:${draftKey}`,
    JSON.stringify({ value, savedAt: new Date().toISOString() }),
  );
}

export async function readDraft<T>(
  key: ModuleId,
  draftKey = "current",
): Promise<T | null> {
  if (isTauri())
    return invoke<T | null>("read_draft", { module: key, key: draftKey });
  try {
    return (
      JSON.parse(
        localStorage.getItem(`sbk-tools:draft:${key}:${draftKey}`) || "null",
      )?.value ?? null
    );
  } catch {
    return null;
  }
}

export async function clearDraft(
  key: ModuleId,
  draftKey = "current",
): Promise<void> {
  if (isTauri()) {
    await invokeMutation("clear_draft", { module: key, key: draftKey });
    return;
  }
  localStorage.removeItem(`sbk-tools:draft:${key}:${draftKey}`);
}

export async function pruneHistory(limit: number): Promise<number> {
  if (!isTauri()) return 0;
  return invokeMutation<number>("prune_history", { limit });
}
