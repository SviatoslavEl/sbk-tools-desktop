import type { StoredRecord } from "../../lib/storage";
import type { ContractData, ContractDocument } from "./types";

export interface ContractSelectionDocument {
  key: string;
  name: string;
  type: ContractDocument["type"];
  fileName: string;
  relativePath: string | null;
}

export interface ContractSelectionDocumentGroup {
  recordId: string;
  title: string;
  documents: ContractSelectionDocument[];
}

/** Always build from the current matches, not the entire registry. */
export function contractSelectionDocumentGroups(
  matches: readonly StoredRecord<ContractData>[],
  selectedContracts: ReadonlySet<string>,
): ContractSelectionDocumentGroup[] {
  return matches.filter((record) => selectedContracts.has(record.id)).map((record) => ({
    recordId: record.id,
    title: [record.payload.number || "Без номера", record.payload.customer].filter(Boolean).join(" · "),
    documents: (record.payload.documents || []).map((document, index) => {
      const path = document.relativePath?.trim() ? document.relativePath : null;
      const fileName = document.fileName || path?.split(/[\\/]/).pop() || "";
      return {
        // A replacement file must be selected again, even when the document ID is retained.
        key: JSON.stringify([record.id, document.id || index, path, document.sha256 || null]),
        name: document.name?.trim() || fileName || `${document.type} без названия`,
        type: document.type,
        fileName,
        relativePath: path,
      };
    }),
  }));
}

export function pruneContractDocumentSelection(
  groups: readonly ContractSelectionDocumentGroup[],
  selected: ReadonlySet<string>,
): Set<string> {
  const available = new Set(groups.flatMap((group) => group.documents.filter((document) => document.relativePath).map((document) => document.key)));
  return new Set([...selected].filter((key) => available.has(key)));
}

export function selectContractDocumentGroup(
  group: ContractSelectionDocumentGroup,
  selected: ReadonlySet<string>,
  checked: boolean,
): Set<string> {
  const next = new Set(selected);
  group.documents.forEach((document) => {
    if (checked && document.relativePath) next.add(document.key);
    else next.delete(document.key);
  });
  return next;
}

/** An explicit allowlist; an empty selection stays empty, never means "all". */
export function contractSelectionArchivePlan(
  groups: readonly ContractSelectionDocumentGroup[],
  selected: ReadonlySet<string>,
): { recordIds: string[]; attachmentPaths: string[] } {
  return {
    recordIds: groups.map((group) => group.recordId),
    attachmentPaths: [...new Set(groups.flatMap((group) => group.documents
      .filter((document) => selected.has(document.key) && document.relativePath)
      .map((document) => document.relativePath!)))],
  };
}
