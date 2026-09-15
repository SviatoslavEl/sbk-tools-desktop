import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error Node's built-in module is available in Vitest, not the browser tsconfig.
import { readFileSync } from "node:fs";
import { PreviewDebounce } from "./previewDebounce";

afterEach(() => vi.useRealTimers());

describe("scanner preview slider debounce", () => {
  it("cancels the slider timer before explicit requests and document replacement", () => {
    const source = readFileSync(new URL("./Scanner.tsx", import.meta.url), "utf8");
    const request = source.slice(source.indexOf("const makePreview = async"), source.indexOf("const makePreview = async") + 320);
    expect(request).toContain("previewDebounce.current!.cancel();\n    if (!path) return;");
    const replacement = source.slice(source.indexOf("const openDocumentPath = async"), source.indexOf("const clearDocument ="));
    expect(replacement).toContain("previewDebounce.current!.cancel();");
    expect(replacement.indexOf("previewDebounce.current!.cancel();")).toBeLessThan(replacement.indexOf("previewSession.current!.clear();"));
    expect(source).toContain("useEffect(() => () => previewDebounce.current?.cancel(), []);");
    expect(source).toContain("return previewDebounce.current!.schedule(() => { void makePreview(inputPath, preset, pageIndex, pageRotations); });");
    expect(source).not.toContain("const timer = window.setTimeout(() => { void makePreview(inputPath, preset, pageIndex, pageRotations);");
  });

  it.each(["page", "preset", "file", "rotation"])("a direct %s change supersedes a queued old-context preview", async () => {
    vi.useFakeTimers();
    const debounce = new PreviewDebounce();
    const start = vi.fn();
    debounce.schedule(() => start("old.pdf", "old-preset", 0));
    await vi.advanceTimersByTimeAsync(100);
    // makePreview cancels before sending any explicit request to the session.
    debounce.cancel();
    start("current.pdf", "selected-preset", 1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(start).toHaveBeenCalledExactlyOnceWith("current.pdf", "selected-preset", 1);
  });

  it("coalesces repeated slider changes and keeps the latest settings", async () => {
    vi.useFakeTimers();
    const debounce = new PreviewDebounce();
    const start = vi.fn();
    debounce.schedule(() => start({ quality: 84 }));
    await vi.advanceTimersByTimeAsync(100);
    debounce.schedule(() => start({ quality: 60 }));
    await vi.advanceTimersByTimeAsync(249);
    expect(start).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(start).toHaveBeenCalledExactlyOnceWith({ quality: 60 });
  });

  it("an obsolete effect cleanup cannot cancel the new context's pending request", async () => {
    vi.useFakeTimers();
    const debounce = new PreviewDebounce();
    const old = vi.fn();
    const current = vi.fn();
    const stopOld = debounce.schedule(old);
    debounce.schedule(current);
    stopOld();
    await vi.advanceTimersByTimeAsync(250);
    expect(old).not.toHaveBeenCalled();
    expect(current).toHaveBeenCalledOnce();
  });

  it("cleanup cancels an unmounted scanner's pending work", async () => {
    vi.useFakeTimers();
    const debounce = new PreviewDebounce();
    const start = vi.fn();
    debounce.schedule(start);
    debounce.cancel();
    await vi.advanceTimersByTimeAsync(250);
    expect(start).not.toHaveBeenCalled();
  });
});
