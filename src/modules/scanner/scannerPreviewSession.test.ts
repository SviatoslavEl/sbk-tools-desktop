import { afterEach, describe, expect, it, vi } from "vitest";
import { BoundedPreviewCache } from "./facsimilePreview";
import { neighboringPages, previewSettingsKey, ScannerPreviewSession, type PreparedPreviews, type PreviewSettings, type PreviewTransport, type WorkerPreview } from "./scannerPreviewSession";

const settings: PreviewSettings = { inputPath: "/qa/source.pdf", preset: "Офисный скан", pageIndex: 0, dpi: 200, quality: 84, compressionMode: "balanced", compressionTargetRatio: .7, pageRotations: {} };
const response = (pageIndex = 0): WorkerPreview => ({ outputPath: `/qa/${pageIndex}.png`, originalPath: `/qa/${pageIndex}-original.png`, pageIndex, pageCount: 8, sourceFingerprint: "source-v1" });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
function harness() {
  const transport: PreviewTransport = {
    run: vi.fn(async (_id, operation, config) => operation === "preview" ? response(config.pageIndex as number) : { pageCount: 8, sourceFingerprint: "source-v1", previews: (config.pageIndices as number[]).map(response) }),
    cancel: vi.fn(async () => undefined), read: vi.fn(async (path) => `data:${path}`), remove: vi.fn(async () => undefined),
    revision: vi.fn(async () => "revision-1"),
  };
  const report = vi.fn();
  return { transport, report, session: new ScannerPreviewSession(transport, report) };
}
afterEach(() => vi.useRealTimers());

describe("bounded page preparation", () => {
  it("prepares only two following pages and one preceding in the arranged order", () => {
    expect(neighboringPages([5, 2, 7, 1, 4], 2)).toEqual([7, 1, 5]);
    expect(neighboringPages([5, 2, 7, 1, 4], 5)).toEqual([2, 7]);
    expect(neighboringPages([5], 5)).toEqual([]);
    expect(neighboringPages([1, 2], 7)).toEqual([]);
    expect(neighboringPages([0, 1, 1, 2], 1)).toEqual([2, 0]);
  });

  it("opens a prepared page without starting another worker and cleans both output copies", async () => {
    vi.useFakeTimers();
    const { session, transport, report } = harness();
    await session.request(settings, "first");
    session.schedule(settings, [0, 1, 2, 3]);
    await vi.advanceTimersByTimeAsync(500);
    expect(report).toHaveBeenLastCalledWith({ state: "ready", prepared: 2, total: 2 });
    const result = await session.request({ ...settings, pageIndex: 1 }, "next");
    expect(result?.previewUrl).toBe("data:/qa/1.png");
    expect(transport.run).toHaveBeenCalledTimes(2);
    for (const page of [0, 1, 2]) {
      expect(transport.remove).toHaveBeenCalledWith(`/qa/${page}.png`);
      expect(transport.remove).toHaveBeenCalledWith(`/qa/${page}-original.png`);
    }
  });

  it("clicking another page cancels background work and ignores its late response", async () => {
    vi.useFakeTimers();
    const { session, transport } = harness();
    await session.request(settings, "first");
    const pending = deferred<PreparedPreviews>();
    vi.mocked(transport.run).mockImplementationOnce(() => pending.promise);
    session.schedule(settings, [0, 1, 2, 3]);
    await vi.advanceTimersByTimeAsync(500);
    await session.request({ ...settings, pageIndex: 7 }, "selected");
    const preparationCall = vi.mocked(transport.run).mock.calls.find((call) => call[1] === "preparePreview")!;
    expect(preparationCall[0]).toMatch(/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i);
    expect(transport.cancel).toHaveBeenCalledWith(preparationCall[0]);
    pending.resolve({ pageCount: 8, sourceFingerprint: "source-v1", previews: [response(1)] });
    await vi.advanceTimersByTimeAsync(0);
    expect(session.isCached({ ...settings, pageIndex: 1 })).toBe(false);
    expect(transport.remove).toHaveBeenCalledWith("/qa/1-original.png");
  });

  it("clears pending foreground requests and original files when changing documents", async () => {
    const { session, transport } = harness();
    const pending = deferred<WorkerPreview>();
    vi.mocked(transport.run).mockReturnValueOnce(pending.promise);
    const requested = session.request(settings, "old-document");
    await vi.waitFor(() => expect(transport.run).toHaveBeenCalledOnce());
    session.clear();
    pending.resolve(response());
    expect(await requested).toBeUndefined();
    expect(transport.cancel).toHaveBeenCalledWith("old-document");
    expect(transport.read).not.toHaveBeenCalled();
    expect(transport.remove).toHaveBeenCalledTimes(2);
  });

  it("pauses scheduled work while saving or leaving scanner", async () => {
    vi.useFakeTimers();
    const { session, transport } = harness();
    await session.request(settings, "first");
    session.schedule(settings, [0, 1, 2]);
    session.pause();
    await vi.advanceTimersByTimeAsync(1000);
    expect(transport.run).toHaveBeenCalledTimes(1);
  });

  it("does not accept preparation for a changed source and keeps normal navigation available", async () => {
    vi.useFakeTimers();
    const { session, transport, report } = harness();
    await session.request(settings, "first");
    vi.mocked(transport.run).mockResolvedValueOnce({ pageCount: 8, sourceFingerprint: "changed", previews: [response(1)] });
    session.schedule(settings, [0, 1]);
    await vi.advanceTimersByTimeAsync(500);
    expect(session.isCached({ ...settings, pageIndex: 1 })).toBe(false);
    expect(report).toHaveBeenLastCalledWith({ state: "changed", prepared: 0, total: 0 });
    await expect(session.request({ ...settings, pageIndex: 1 }, "next")).rejects.toThrow("Исходный документ изменился");
    session.clear();
    expect(await session.request({ ...settings, pageIndex: 1 }, "reopened")).toBeDefined();
  });

  it("a background failure never becomes a blocking document error", async () => {
    vi.useFakeTimers();
    const { session, transport, report } = harness();
    await session.request(settings, "first");
    vi.mocked(transport.run).mockRejectedValueOnce(new Error("disk full"));
    session.schedule(settings, [0, 1]);
    await vi.advanceTimersByTimeAsync(500);
    expect(report).toHaveBeenLastCalledWith({ state: "unavailable", prepared: 0, total: 1 });
    expect(session.isCached(settings)).toBe(true);
  });

  it("always cleans originals when reading a result fails", async () => {
    const { session, transport } = harness();
    vi.mocked(transport.read).mockRejectedValueOnce(new Error("unreadable PNG"));
    await expect(session.request(settings, "first")).rejects.toThrow("unreadable PNG");
    expect(transport.remove).toHaveBeenCalledTimes(2);
  });

  it("invalidates the preview key for source, page, preset, resolution, quality, rotation, compression", () => {
    const key = previewSettingsKey(settings);
    for (const patch of [{ inputPath: "/qa/other.docx" }, { pageIndex: 1 }, { preset: "Оригинал" }, { dpi: 120 }, { quality: 50 }, { pageRotations: { 0: 90 } }, { compressionMode: "strong" }]) {
      expect(previewSettingsKey({ ...settings, ...patch })).not.toBe(key);
    }
  });

  it("bounds both retained pages and bytes, evicting least-recently-used data", () => {
    const cache = new BoundedPreviewCache<string>(3, 10, (value) => value.length);
    cache.set("a", "aaaa"); cache.set("b", "bbbb"); cache.get("a"); cache.set("c", "cccc");
    expect(cache.has("b")).toBe(false);
    expect(cache.has("a")).toBe(true);
    expect(cache.totalWeight).toBe(8);
    cache.set("huge", "x".repeat(11));
    expect(cache.size).toBe(0);
    expect(cache.totalWeight).toBe(0);
  });

  it("checks file revision before a memory cache hit, without launching the worker", async () => {
    const { session, transport } = harness();
    await session.request(settings, "first");
    vi.mocked(transport.revision).mockResolvedValue("revision-2");
    await expect(session.request(settings, "changed-source")).rejects.toThrow("Исходный документ изменился");
    expect(session.isCached(settings)).toBe(false);
    expect(transport.run).toHaveBeenCalledOnce();
  });

  it("verifies the source again before saving and after returning from another module", async () => {
    vi.useFakeTimers();
    const { session, transport, report } = harness();
    await session.request(settings, "first");
    expect(await session.verifySource()).toBe(true);
    vi.mocked(transport.revision).mockResolvedValue("revision-2");
    session.schedule(settings, [0]);
    await vi.advanceTimersByTimeAsync(500);
    expect(report).toHaveBeenLastCalledWith({ state: "changed", prepared: 0, total: 0 });
    await expect(session.verifySource()).rejects.toThrow("Исходный документ изменился");
  });

  it("background pauses do not invalidate an active foreground load", async () => {
    const { session, transport } = harness();
    const pending = deferred<string>();
    vi.mocked(transport.revision).mockReturnValueOnce(pending.promise);
    const requested = session.request(settings, "foreground");
    session.pause();
    pending.resolve("revision-1");
    expect((await requested)?.previewUrl).toBe("data:/qa/0.png");
  });

  it("does not adopt a stale file revision after clearing the document", async () => {
    const { session, transport } = harness();
    const pending = deferred<string>();
    vi.mocked(transport.revision).mockReturnValueOnce(pending.promise);
    const requested = session.request(settings, "old");
    session.clear();
    pending.resolve("old-revision");
    expect(await requested).toBeUndefined();
    expect(await session.request({ ...settings, inputPath: "/qa/new.pdf" }, "new")).toBeDefined();
  });

  it("counts retained neighbours rather than evicted large images", async () => {
    vi.useFakeTimers();
    const { session, transport, report } = harness();
    vi.mocked(transport.read).mockImplementation(async () => "x".repeat(5 * 1024 * 1024));
    await session.request({ ...settings, pageIndex: 1 }, "first");
    session.schedule({ ...settings, pageIndex: 1 }, [0, 1, 2, 3]);
    await vi.advanceTimersByTimeAsync(500);
    const retained = [2, 3, 0].filter((pageIndex) => session.isCached({ ...settings, pageIndex })).length;
    expect(retained).toBe(2);
    expect(report).toHaveBeenLastCalledWith({ state: "unavailable", prepared: retained, total: 3 });
  });

  it("invalidates a save chooser's document generation only when the source is cleared/replaced", async () => {
    const { session } = harness();
    await session.request(settings, "first");
    const capturedGeneration = session.sourceGeneration;
    const capturedFingerprint = session.sourceFingerprint;
    session.pause();
    await session.request({ ...settings, pageIndex: 1 }, "page-two");
    expect(session.sourceGeneration).toBe(capturedGeneration);
    session.clear();
    await session.request({ ...settings, inputPath: "/qa/replacement.pdf" }, "replacement");
    expect(session.sourceGeneration).not.toBe(capturedGeneration);
    // A save retains its original fingerprint even when the session is replaced.
    expect(capturedFingerprint).toBe("source-v1");
  });

  it("cannot finish pre-save verification after a different document was selected", async () => {
    const { session, transport } = harness();
    await session.request(settings, "first");
    const pending = deferred<string>();
    vi.mocked(transport.revision).mockReturnValueOnce(pending.promise);
    const verified = session.verifySource();
    session.clear();
    pending.resolve("revision-1");
    expect(await verified).toBe(false);
  });
});
