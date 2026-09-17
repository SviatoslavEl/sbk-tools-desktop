import { describe, expect, it } from "vitest";
// @ts-expect-error Node's built-in module is available in Vitest.
import { readFileSync } from "node:fs";
const source = readFileSync(new URL("./Scanner.tsx", import.meta.url), "utf8");

describe("scanner reliability wiring", () => {
  it("routes choose/drop through the same dirty guard and protects clear", () => {
    expect(source).toContain("await openDocumentPath(path)");
    expect(source).toContain("else if (documents.length === 1) void openDocumentPath(documents[0])");
    const open = source.slice(source.indexOf("const openDocumentPath ="), source.indexOf("const chooseBatch ="));
    expect(open.match(/if \(dirty && !window.confirm/g)).toHaveLength(2);
    expect(open.indexOf("if (dirty && !window.confirm")).toBeLessThan(open.indexOf('setInputPath(path)'));
  });
  it("retries the failed operation and never silently reruns completed batch rows", () => {
    expect(source).toContain('setRetryOperation("save")');
    expect(source).toContain('retryOperation === "save") void processDocument()');
    expect(source).toContain('entry.status === "done" || batchCancelled.current');
    expect(source).toContain('outputPolicy: "no-clobber"');
    expect(source).toContain('scanner_plan_outputs');
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
