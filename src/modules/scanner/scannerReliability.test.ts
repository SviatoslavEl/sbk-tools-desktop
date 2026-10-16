import { describe, expect, it } from "vitest";
// @ts-expect-error Node's built-in module is available in Vitest.
import { readFileSync } from "node:fs";
const source = readFileSync(new URL("./Scanner.tsx", import.meta.url), "utf8");

describe("scanner reliability wiring", () => {
  it("routes choose/drop through the same dirty guard and protects clear", () => {
    expect(source).toContain("await openDocumentPath(path)");
    expect(source).toContain("else if (documents.length === 1) void openDocumentPath(documents[0])");
    const open = source.slice(source.indexOf("const openDocumentPath ="), source.indexOf("const chooseBatch ="));
    const replacementGuard = "if (dirty && !replacementConfirmed && !window.confirm";
    expect(open).toContain(replacementGuard);
    expect(open).toContain("if (dirty && !window.confirm");
    expect(open.indexOf(replacementGuard)).toBeLessThan(open.indexOf('setInputPath(path)'));
    expect(source).toContain("replacementConfirmed = false");
    expect(source.match(/openDocumentPath\(request\.inputPath, false, true\)/g)).toHaveLength(1);
    expect(source).toContain("Загрузить документ из окна ИИ для OCR?");
  });
  it("retries the failed operation and never silently reruns completed batch rows", () => {
    expect(source).toContain('setRetryOperation("save")');
    expect(source).toContain('retryOperation === "save") void processDocument()');
    expect(source).toContain('entry.status === "done" || batchCancelled.current');
    expect(source).toContain('outputPolicy: "no-clobber"');
    expect(source).toContain('scanner_plan_outputs');
  });
  it("does not attempt a failure-journal write in document or split viewer mode", () => {
    const document = source.slice(source.indexOf("const processDocument ="), source.indexOf("const cancel ="));
    expect(document).toContain('if (workspaceAccess.editor) await templates.save(`Ошибка разделения');
    expect(document).toContain('if (workspaceAccess.editor) await templates.save(`Ошибка ${');
  });
  it("renders final preview separately without burning effects into the editable canvas", () => {
    expect(source).toContain('finalPreview: true, expectedSourceFingerprint: sourceSession.sourceFingerprint');
    expect(source).toContain('setFinalPreview({ url, key, page: pageIndex })');
    expect(source).toContain('documentReady && !showOriginal && annotations.filter');
    expect(source).toContain('Интерактивный вид — для размещения инструментов');
  });
  it("keeps a recovery draft on load failure and resets its undo baseline explicitly", () => {
    expect(source).toContain("return await makePreview(path, preset, 0, {})");
    expect(source).toContain("if (!preserveRecoveryDraft) discardDraft(); else setDraftEnabled(false)");
    const recover = source.slice(source.indexOf("const recoverDraft ="), source.indexOf("const chooseDocument ="));
    expect(recover).toContain("const loaded = await openDocumentPath(draft.inputPath, true)");
    expect(recover.indexOf("if (!loaded)")).toBeLessThan(recover.indexOf("editHistory.current.reset"));
    expect(recover.indexOf("editHistory.current.reset")).toBeLessThan(recover.indexOf("editHistory.current.record(snapshot)"));
    expect(recover).toContain("Черновик сохранён; исправьте ошибку");
  });
});
