import { invoke } from "@tauri-apps/api/core";
import { chooseOpenPath } from "../../lib/files";
import { copyAttachment } from "../../lib/storage";
import type { DocumentTextFragment, ProcurementDocumentVersion } from "./types";

interface ExtractionResult { type: "extraction"; fileName: string; mimeType: string; sizeBytes: number; sha256: string; extractedText: string; fragments: DocumentTextFragment[]; warnings: string[]; extractionEngineVersion: string; protocolVersion: 2; }
const isTauri = () => "__TAURI_INTERNALS__" in window;

export async function chooseAndIngestDocument(procurementId: string, source: string, documentId?: string): Promise<ProcurementDocumentVersion | null> {
  if (!isTauri()) throw new Error("Добавление документов доступно в desktop-версии.");
  const path = await chooseOpenPath("Документ закупки", ["pdf", "docx", "xlsx"]);
  if (!path) return null;
  const result = await invoke<ExtractionResult>("scanner_run", { jobId: crypto.randomUUID(), operation: "extract", config: { protocolVersion: 2, inputPath: path } });
  const attachment = await copyAttachment(path, "procurement", procurementId);
  if (attachment.sha256 !== result.sha256) throw new Error("Документ изменился во время добавления. Повторите операцию.");
  return { documentId: documentId || crypto.randomUUID(), versionId: crypto.randomUUID(), fileName: result.fileName, mimeType: result.mimeType, sizeBytes: result.sizeBytes, sha256: result.sha256, source: source.trim() || "Добавлен пользователем", relativePath: attachment.relativePath, addedAt: new Date().toISOString(), extractionEngineVersion: result.extractionEngineVersion, processingStatus: result.warnings.length ? "С предупреждениями" : "Обработан", warnings: result.warnings, extractedText: result.extractedText, fragments: result.fragments };
}
