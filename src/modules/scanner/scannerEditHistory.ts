// Settings only: never serialize document rasters, OCR text or facsimile pixels.
export function scannerSettingsKey(value: unknown): string {
  return JSON.stringify(value, (key, item) => key === "imageUrl" ? undefined : item);
}
function historyImageBytes(values: unknown[]): number {
  const images = new Set<string>();
  for (const value of values) JSON.stringify(value, (key, item) => { if (key === "imageUrl" && typeof item === "string") images.add(item); return key === "imageUrl" ? undefined : item; });
  return [...images].reduce((sum, image) => sum + image.length * 2, 0);
}

export class ScannerEditHistory<T> {
  private past: T[] = [];
  private future: T[] = [];
  private value: T | null = null;
  private key = "";
  private savedKey = "";
  reset(value: T) { this.past = []; this.future = []; this.value = value; this.key = scannerSettingsKey(value); this.savedKey = this.key; }
  record(value: T) {
    const key = scannerSettingsKey(value);
    if (key === this.key) return;
    if (this.value !== null) this.past.push(this.value);
    this.value = value; this.key = key; this.future = [];
    // Structural snapshots share immutable image data URLs, rather than copying
    // them. Bound history by count AND metadata weight for 5,000-page documents.
    while (this.past.length > 30 || (this.past.length > 0 && (this.past.reduce((sum, entry) => sum + scannerSettingsKey(entry).length * 2, 0) > 4 * 1024 * 1024 || historyImageBytes([...this.past, this.value]) > 48 * 1024 * 1024))) this.past.shift();
  }
  get canUndo() { return this.past.length > 0; }
  get canRedo() { return this.future.length > 0; }
  hasPending(value: T) { return scannerSettingsKey(value) !== this.key; }
  dirty(value: T) { return scannerSettingsKey(value) !== this.savedKey; }
  markSaved(value: T) { this.savedKey = scannerSettingsKey(value); }
  navigate(value: T, redo = false): T | null {
    // Flush a debounced edit before BOTH directions. A fresh edit creates a new
    // branch, so an immediate Redo must not replay an obsolete future over it.
    this.record(value);
    return redo ? this.redo() : this.undo();
  }
  undo(): T | null { const previous = this.past.pop(); if (!previous || this.value === null) return null; this.future.push(this.value); this.value = previous; this.key = scannerSettingsKey(previous); return previous; }
  redo(): T | null { const next = this.future.pop(); if (!next || this.value === null) return null; this.past.push(this.value); this.value = next; this.key = scannerSettingsKey(next); return next; }
}

export const SCANNER_DRAFT_KEY = "sbk.scanner.session-draft.v1";
export const MAX_SCANNER_DRAFT_BYTES = 512 * 1024;
export interface ScannerLocalDraft<T> { version: 1; inputPath: string; revision: string; savedAt: number; settings: T }
export function encodeScannerDraft<T>(draft: ScannerLocalDraft<T>): string {
  const value = scannerSettingsKey(draft);
  if (value.length * 2 > MAX_SCANNER_DRAFT_BYTES) throw new Error("Настройки слишком велики для локального черновика. Сохраните PDF перед закрытием.");
  return value;
}
export function decodeScannerDraft<T>(value: string | null): ScannerLocalDraft<T> | null {
  if (!value || value.length * 2 > MAX_SCANNER_DRAFT_BYTES) return null;
  try {
    const draft = JSON.parse(value);
    if (draft.version !== 1 || typeof draft.inputPath !== "string" || !/^[a-f0-9]{64}$/.test(draft.revision)
      || !Number.isFinite(draft.savedAt) || Date.now() - draft.savedAt > 24 * 60 * 60 * 1000
      || !draft.settings || !Array.isArray(draft.settings.pageOrder) || draft.settings.pageOrder.length > 5000
      || draft.settings.pageOrder.some((page: unknown) => !Number.isInteger(page) || Number(page) < 0 || Number(page) >= 5000)) return null;
    return draft;
  } catch { return null; }
}

export function validScannerDraftSettings(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const settings = value as Record<string, unknown>;
  for (const key of ["preset", "outputPageRange", "editingFacsimileId", "ocrLanguages"]) if (typeof settings[key] !== "string") return false;
  if (!["all", "range", "blocks"].includes(String(settings.outputPageMode))
    || !["balanced", "strong", "maximum", "none"].includes(String(settings.compressionMode))) return false;
  if (!Number.isFinite(settings.dpi) || Number(settings.dpi) < 72 || Number(settings.dpi) > 600
    || !Number.isFinite(settings.quality) || Number(settings.quality) < 1 || Number(settings.quality) > 100) return false;
  if (typeof settings.ocrEnabled !== "boolean" || typeof settings.pdfaEnabled !== "boolean") return false;
  for (const key of ["pageOrder", "savedFacsimiles", "redactions", "annotations", "outputBlocks"]) if (!Array.isArray(settings[key]) || (settings[key] as unknown[]).length > 5000) return false;
  if (!settings.pageRotations || typeof settings.pageRotations !== "object" || Array.isArray(settings.pageRotations)
    || Object.values(settings.pageRotations).some((rotation) => ![0, 90, 180, 270].includes(Number(rotation)))) return false;
  const facsimiles = [...settings.savedFacsimiles as unknown[], ...(settings.facsimile ? [settings.facsimile] : [])];
  if (facsimiles.some((item) => {
    if (!item || typeof item !== "object") return true;
    const entry = item as Record<string, unknown>;
    return ["imagePath", "id", "fileName", "pageRange"].some((key) => typeof entry[key] !== "string")
      || ["x", "y", "width", "rotation", "opacity", "imageAspect"].some((key) => !Number.isFinite(entry[key]))
      || !entry.pageGeometries || typeof entry.pageGeometries !== "object" || !["current", "all", "range"].includes(String(entry.applyTo));
  })) return false;
  for (const key of ["redactions", "annotations"]) if ((settings[key] as unknown[]).some((item) => {
    if (!item || typeof item !== "object") return true;
    const entry = item as Record<string, unknown>;
    return typeof entry.id !== "string" || typeof entry.color !== "string" || !Number.isInteger(entry.page)
      || ["x", "y", "width", "height"].some((name) => !Number.isFinite(entry[name]))
      || (key === "annotations" && (!Number.isFinite(entry.intensity) || !["marker", "stroke", "blur", "print_blur"].includes(String(entry.kind))));
  })) return false;
  if ((settings.outputBlocks as unknown[]).some((item) => !item || typeof item !== "object" || ["id", "name", "pageRange"].some((key) => typeof (item as Record<string, unknown>)[key] !== "string"))) return false;
  return true;
}

export type ScannerRetryOperation = "preview" | "save" | "batch" | "final-preview";
export function scannerRetryLabel(operation: ScannerRetryOperation) {
  return { preview: "Повторить загрузку", save: "Повторить сохранение / выбрать папку", batch: "Повторить неготовые файлы", "final-preview": "Повторить итоговый просмотр" }[operation];
}

export function plannedBatchNames(paths: string[]): string[] {
  return paths.map((path, index) => `${(path.split(/[\\/]/).pop() || `документ-${index + 1}`).replace(/\.(pdf|docx)$/i, "")} — обработано.pdf`);
}
