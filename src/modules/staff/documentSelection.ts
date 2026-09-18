import type { StoredRecord } from "../../lib/storage";
import type { StaffData, StaffDocument } from "./types";

/** Include the file identity: replacing a file requires a fresh explicit choice. */
export const staffDocumentSelectionKey = (recordId: string, document: StaffDocument) => JSON.stringify([recordId, document.id, document.relativePath || "", document.sha256 || ""]);

export function staffDocumentOptions(records: Array<Pick<StoredRecord<StaffData>, "id" | "payload">>) {
  return records.flatMap((record) => (record.payload.documents || []).map((document) => ({
    recordId: record.id,
    person: record.payload.fullName,
    document,
    key: staffDocumentSelectionKey(record.id, document),
    selectable: Boolean(document.relativePath?.trim()),
  })));
}

export function pruneStaffDocumentSelection(records: Array<Pick<StoredRecord<StaffData>, "id" | "payload">>, selected: ReadonlySet<string>) {
  const available = new Set(staffDocumentOptions(records).filter((option) => option.selectable).map((option) => option.key));
  return new Set([...selected].filter((key) => available.has(key)));
}

export function selectedStaffAttachmentPaths(records: Array<Pick<StoredRecord<StaffData>, "id" | "payload">>, selected: ReadonlySet<string>): string[] {
  return [...new Set(staffDocumentOptions(records).filter((option) => option.selectable && selected.has(option.key)).map((option) => option.document.relativePath!))];
}
