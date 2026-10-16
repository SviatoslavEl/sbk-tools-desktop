import { describe, expect, it } from "vitest";
import { IntelligenceOcrBridge, IntelligenceOcrRouter, type IntelligenceOcrCurrent, type IntelligenceOcrSaveFacts } from "./intelligenceOcrBridge";

const request = { id: "request-a", inputPath: "/synthetic/source.pdf" };
const source = { inputPath: request.inputPath, sourceGeneration: 3, sourceFingerprint: "a".repeat(64) };
const facts: IntelligenceOcrSaveFacts = { workspaceMode: "document", kind: "single", outputPageMode: "all", pageCount: 2, pageOrder: [0, 1], ocrEnabled: true, settingsKey: "settings-a", outputPath: "/synthetic/ocr.pdf", outputSha256: "c".repeat(64), outputRevision: "revision-a", ocrText: "Распознанный синтетический текст" };
const current: IntelligenceOcrCurrent = { workspaceMode: "document", resultKind: "single", resultPath: facts.outputPath, settingsKey: facts.settingsKey, ocrEnabled: true };
function prepared() { const bridge = new IntelligenceOcrBridge(); expect(bridge.bind(request, source)).toBe(true); const ticket = bridge.startSave(request, source)!; return { bridge, ticket }; }
function returned(id = request.id, outputPath = facts.outputPath) { return { id, outputPath, sha256: facts.outputSha256 }; }

describe("AI OCR result provenance gate", () => {
  it("allows a newly saved full OCR PDF once, without claiming content accuracy", () => {
    const { bridge, ticket } = prepared();
    expect(bridge.candidate(request, source, current)).toBeNull();
    expect(bridge.completeSave(ticket, request, source, facts)).toBe(true);
    expect(bridge.candidate(request, source, current)).toEqual({ ...returned(), outputRevision: facts.outputRevision });
    expect(bridge.consume(request, source, current)).toMatchObject(returned());
    expect(bridge.consume(request, source, current)).toBeNull();
  });
  it.each([
    { workspaceMode: "merge" }, { kind: "batch" }, { kind: "split" }, { outputPageMode: "range" }, { outputPageMode: "blocks" },
    { pageOrder: [1, 0] }, { pageOrder: [0] }, { pageOrder: [0, 0] }, { pageCount: 0, pageOrder: [] }, { pageCount: 5001 },
    { ocrEnabled: false }, { ocrText: " \n " }, { outputRevision: "" }, { outputPath: request.inputPath }, { outputPath: "/synthetic/not-pdf.txt" },
    { outputSha256: undefined }, { outputSha256: "" }, { outputSha256: "c".repeat(63) }, { outputSha256: "c".repeat(65) }, { outputSha256: "g".repeat(64) },
  ] as Partial<IntelligenceOcrSaveFacts>[])("rejects ineligible save facts %j", (patch) => {
    const { bridge, ticket } = prepared();
    expect(bridge.completeSave(ticket, request, source, { ...facts, ...patch })).toBe(false);
    expect(bridge.candidate(request, source, current)).toBeNull();
  });
  it("never binds a source lacking a fingerprint or a different path", () => {
    const bridge = new IntelligenceOcrBridge();
    expect(bridge.bind(request, { ...source, sourceFingerprint: undefined })).toBe(false);
    expect(bridge.bind(request, { ...source, inputPath: "/synthetic/other.pdf" })).toBe(false);
    expect(bridge.startSave(request, source)).toBeNull();
  });
  it("rejects a late completion after a newer save, replacement, clear or new same-path request", () => {
    const { bridge, ticket } = prepared();
    const newer = bridge.startSave(request, source)!;
    expect(bridge.completeSave(ticket, request, source, facts)).toBe(false);
    expect(bridge.completeSave(newer, request, source, facts)).toBe(true);
    bridge.clearResult();
    expect(bridge.completeSave(newer, request, source, facts)).toBe(false);
    bridge.bind({ ...request, id: "request-b" }, source);
    expect(bridge.completeSave(ticket, { ...request, id: "request-b" }, source, facts)).toBe(false);
    bridge.invalidate();
    expect(bridge.completeSave(newer, request, source, facts)).toBe(false);
  });
  it.each([{ sourceGeneration: 4 }, { sourceFingerprint: "b".repeat(64) }, { inputPath: "/synthetic/other.pdf" }])("does not return a result after source change %j", (patch) => {
    const { bridge, ticket } = prepared(); expect(bridge.completeSave(ticket, request, source, facts)).toBe(true);
    expect(bridge.candidate(request, { ...source, ...patch }, current)).toBeNull();
    expect(bridge.completeSave(ticket, request, { ...source, ...patch }, facts)).toBe(false);
  });
  it.each([{ workspaceMode: "merge" }, { resultKind: "split" }, { resultPath: "/synthetic/unrelated.pdf" }, { settingsKey: "settings-changed" }, { ocrEnabled: false }] as Partial<IntelligenceOcrCurrent>[])("rejects an unrelated current view %j", (patch) => {
    const { bridge, ticket } = prepared(); expect(bridge.completeSave(ticket, request, source, facts)).toBe(true);
    expect(bridge.candidate(request, source, { ...current, ...patch })).toBeNull();
  });
  it("does not accept an old result into a newer request or expose mutable gate state", () => {
    const { bridge, ticket } = prepared(); expect(bridge.completeSave(ticket, request, source, facts)).toBe(true);
    expect(bridge.candidate({ ...request, id: "request-b" }, source, current)).toBeNull();
    expect(bridge.candidate(undefined, source, current)).toBeNull();
    const result = bridge.candidate(request, source, current)!; result.outputPath = "/synthetic/fake.pdf";
    expect(bridge.candidate(request, source, current)?.outputPath).toBe(facts.outputPath);
  });
  it("keeps the process response's digest across a later metadata stamp and consume", () => {
    const { bridge, ticket } = prepared();
    expect(bridge.completeSave(ticket, request, source, { ...facts, outputSha256: "D".repeat(64), outputRevision: "later-metadata-revision" })).toBe(true);
    expect(bridge.consume(request, source, current)?.sha256).toBe("D".repeat(64));
  });
});

describe("workspace-scoped OCR routing", () => {
  it("routes a request and explicitly returned result, then consumes once", () => {
    const router = new IntelligenceOcrRouter(); router.updateContext("workspace-a", false); router.begin(request);
    expect(router.request).toEqual(request); expect(router.result).toBeUndefined();
    router.finish(returned());
    expect(router.request).toBeUndefined(); expect(router.result).toEqual(returned());
    expect(() => router.finish(returned())).toThrow();
    router.consume(); expect(router.result).toBeUndefined();
  });
  it("invalidates a pending request on workspace switch, including switch-away-and-back", () => {
    const router = new IntelligenceOcrRouter(); router.updateContext("workspace-a", false); router.begin(request);
    router.updateContext("workspace-b", false); router.updateContext("workspace-a", false);
    expect(router.request).toBeUndefined(); expect(() => router.finish(returned())).toThrow();
  });
  it("invalidates pending and ready results on pause and does not restore them after reconnection", () => {
    const router = new IntelligenceOcrRouter(); router.updateContext("workspace-a", false); router.begin(request);
    router.updateContext("workspace-a", true); expect(router.request).toBeUndefined(); expect(() => router.begin(request)).toThrow();
    router.updateContext("workspace-a", false); expect(router.request).toBeUndefined();
    router.begin(request); router.finish(returned()); router.updateContext("workspace-a", true);
    router.updateContext("workspace-a", false); expect(router.result).toBeUndefined();
  });
  it("does not route a stale response after a newer request and never returns the input path", () => {
    const router = new IntelligenceOcrRouter(); router.updateContext("workspace-a", false); router.begin(request);
    router.begin({ ...request, id: "request-b" });
    expect(() => router.finish(returned())).toThrow();
    expect(() => router.finish(returned("request-b", request.inputPath))).toThrow();
    expect(router.request?.id).toBe("request-b");
  });
  it("does not expose mutable request objects or accept an invalid file request", () => {
    const router = new IntelligenceOcrRouter(); expect(() => router.begin(request)).toThrow();
    router.updateContext("workspace-a", false); expect(() => router.begin({ ...request, inputPath: "/synthetic/x.exe" })).toThrow();
    router.begin(request); router.request!.id = "wrong"; expect(router.request?.id).toBe(request.id);
  });
  it.each([undefined, "", "c".repeat(63), "c".repeat(65), "g".repeat(64), ` ${"c".repeat(64)}`])("rejects a missing or invalid OCR digest %s without consuming the pending request", (sha256) => {
    const router = new IntelligenceOcrRouter(); router.updateContext("workspace-a", false); router.begin(request);
    expect(() => router.finish({ ...returned(), sha256: sha256 as string })).toThrow();
    expect(router.result).toBeUndefined(); expect(router.request?.id).toBe(request.id);
  });
});
