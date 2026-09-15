import { describe, expect, it } from "vitest";
// @ts-expect-error Node's built-in module is available in Vitest, not the browser tsconfig.
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./Scanner.tsx", import.meta.url), "utf8");

describe("scanner save source context", () => {
  it("captures a single source fingerprint before either asynchronous path picker", () => {
    const save = source.slice(source.indexOf("const processDocument = async"), source.indexOf("const cancel = async"));
    const capture = save.indexOf("const expectedSourceFingerprint = sourceSession.sourceFingerprint;");
    expect(capture).toBeGreaterThan(0);
    expect(capture).toBeLessThan(save.indexOf("await chooseDirectory("));
    expect(capture).toBeLessThan(save.indexOf("await chooseSavePath("));
    expect(save).toContain("protocolVersion: 2, expectedSourceFingerprint, inputPath");
    expect(save).not.toContain("expectedSourceFingerprint: previewSession.current");
    expect(save).toContain("sourceSession.sourceGeneration === sourceGeneration && !activeJobRef.current");
    expect(save).toContain("if (!saveStillCurrent())");
    expect(save).toContain("if (!await sourceSession.verifySource() || !saveStillCurrent()) return;");
    expect(save).toContain('catch (reason) { if (saveStillCurrent()) { setReadyPreviewKey(""); setError(String(reason), "document"); } return; }');
  });

  it("guards replacement both before and after the asynchronous input chooser", () => {
    const choose = source.slice(source.indexOf("const chooseDocument = async"), source.indexOf("const openDocumentPath = async"));
    const replace = source.slice(source.indexOf("const openDocumentPath = async"), source.indexOf("const clearDocument ="));
    expect(choose).toContain("if (activeJobRef.current || mergeInspecting)");
    expect(replace).toContain("if (activeJobRef.current || mergeInspecting)");
    expect(choose).toContain("await openDocumentPath(path)");
    expect(source).toContain('disabled={!!activeJob || mergeInspecting} onClick={() => void chooseDocument()}');
  });

  it("clearing is disabled during processing and retires queued or late previews", () => {
    const clear = source.slice(source.indexOf("const clearDocument ="), source.indexOf("const chooseBatch = async"));
    expect(clear).toContain("if (activeJobRef.current || mergeInspecting) return;");
    expect(clear).toContain("previewDebounce.current!.cancel();");
    expect(clear).toContain('latestPreviewJob.current = "";');
    expect(clear).toContain("previewSession.current!.clear();");
    expect(source).toContain('disabled={!!activeJob || mergeInspecting} onClick={clearDocument}');
  });
});
