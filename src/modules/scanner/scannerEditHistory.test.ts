import { describe, expect, it } from "vitest";
import { ScannerEditHistory, encodeScannerDraft, decodeScannerDraft, validScannerDraftSettings, plannedBatchNames, scannerRetryLabel, MAX_SCANNER_DRAFT_BYTES } from "./scannerEditHistory";

describe("scanner settings history", () => {
  it("restores pages, effects and facsimile edits; branches discard redo and saved state stays honest", () => {
    const first = { pageOrder: [0, 1, 2], annotations: [], facsimile: null };
    const history = new ScannerEditHistory<unknown>(); history.reset(first);
    const edited = { pageOrder: [2, 0], annotations: [{ color: "#202020" }], facsimile: { width: .22, imageUrl: "data:image/png;base64,pixels" } };
    history.record(edited); expect(history.dirty(edited)).toBe(true);
    expect(history.undo()).toEqual(first); expect(history.dirty(first)).toBe(false);
    expect(history.redo()).toEqual(edited); history.markSaved(edited); expect(history.dirty(edited)).toBe(false);
    history.undo(); expect(history.dirty(first)).toBe(true);
    history.record({ ...first, pageOrder: [0] }); expect(history.canRedo).toBe(false);
  });
  it("bounds history and treats image decoding as the same edit", () => {
    const history = new ScannerEditHistory<{ x: number; imageUrl?: string }>(); history.reset({ x: 0 });
    for (let x = 1; x <= 100; x++) history.record({ x });
    let count = 0; while (history.undo()) count++;
    expect(count).toBe(30);
    history.reset({ x: 1 }); history.record({ x: 1, imageUrl: "huge pixels" }); expect(history.canUndo).toBe(false);
  });
  it("immediate Redo after a pending edit preserves the new branch", () => {
    const history = new ScannerEditHistory<{ opacity: number }>();
    history.reset({ opacity: .5 }); history.record({ opacity: 1 });
    expect(history.undo()).toEqual({ opacity: .5 });
    expect(history.canRedo).toBe(true);
    // UI changed opacity but the 350ms recording debounce has not fired.
    expect(history.navigate({ opacity: .7 }, true)).toBeNull();
    expect(history.canRedo).toBe(false);
    expect(history.navigate({ opacity: .7 })).toEqual({ opacity: .5 });
  });
});

describe("private session draft", () => {
  const draft = { version: 1 as const, inputPath: "/tmp/qa.pdf", revision: "a".repeat(64), savedAt: Date.now(), settings: { pageOrder: [0], facsimile: { imagePath: "/tmp/qa.png", imageUrl: "SENSITIVE_PIXELS" } } };
  it("stores no image bytes and supports settings-only recovery", () => {
    const value = encodeScannerDraft(draft); expect(value).not.toContain("SENSITIVE_PIXELS");
    expect(decodeScannerDraft(value)?.inputPath).toBe(draft.inputPath);
  });
  it("rejects expired, oversized, malformed and out-of-range drafts", () => {
    expect(decodeScannerDraft(encodeScannerDraft({ ...draft, savedAt: Date.now() - 25 * 60 * 60 * 1000 }))).toBeNull();
    expect(decodeScannerDraft("{" )).toBeNull();
    expect(decodeScannerDraft(encodeScannerDraft({ ...draft, settings: { pageOrder: [-1] } }))).toBeNull();
    expect(() => encodeScannerDraft({ ...draft, settings: { huge: "x".repeat(MAX_SCANNER_DRAFT_BYTES) } })).toThrow();
  });
  it("validates the complete settings shape before replacing the current document", () => {
    const settings = { preset: "Оригинал", pageOrder: [0], pageRotations: {}, outputPageMode: "all", outputPageRange: "", outputBlocks: [], facsimile: null, savedFacsimiles: [], editingFacsimileId: "", annotations: [], redactions: [], dpi: 96, quality: 35, compressionMode: "maximum", ocrEnabled: false, ocrLanguages: "rus+eng", pdfaEnabled: false };
    expect(validScannerDraftSettings(settings)).toBe(true);
    expect(validScannerDraftSettings({ ...settings, savedFacsimiles: [null] })).toBe(false);
    expect(validScannerDraftSettings({ ...settings, compressionMode: "unknown" })).toBe(false);
    expect(validScannerDraftSettings({ ...settings, annotations: [null] })).toBe(false);
    expect(validScannerDraftSettings({ pageOrder: [0] })).toBe(false);
  });
});

it("retains both same-stem inputs for backend planning and labels retry by operation", () => {
  expect(plannedBatchNames(["C:\\one\\договор.pdf", "C:\\two\\договор.docx"])).toEqual(["договор — обработано.pdf", "договор — обработано.pdf"]);
  expect(scannerRetryLabel("save")).toContain("сохранение");
  expect(scannerRetryLabel("preview")).toContain("загрузку");
  expect(scannerRetryLabel("batch")).toContain("неготовые");
});
