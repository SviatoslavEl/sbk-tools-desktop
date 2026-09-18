import { describe, expect, it, vi } from "vitest";
import { readCurrentPreview, resumableSplitPlan, runSplitPlan, ScannerSingleFlight, subscribeScannerProgress, type SplitPlan } from "./scannerAsyncOperations";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("merge preview ordering and cleanup", () => {
  it("never lets a delayed image replace a newer selected page", async () => {
    let selection = "A";
    let shown = "";
    const slow = deferred<string>();
    const remove = vi.fn().mockResolvedValue(undefined);
    const first = readCurrentPreview({ outputPath: "A.png", originalPath: "A-original.png" }, () => slow.promise, remove, () => selection === "A").then((value) => { if (value !== undefined) shown = value; });
    selection = "B";
    const second = await readCurrentPreview({ outputPath: "B.png" }, async () => "image B", remove, () => selection === "B");
    if (second !== undefined) shown = second;
    slow.resolve("image A"); await first;
    expect(shown).toBe("image B");
    expect(remove.mock.calls.flat().sort()).toEqual(["A-original.png", "A.png", "B.png"]);
  });

  it("cleans outputs even when a stale worker response does not need reading", async () => {
    const read = vi.fn(); const remove = vi.fn().mockResolvedValue(undefined);
    expect(await readCurrentPreview({ outputPath: "old.png", originalPath: "old.png" }, read, remove, () => false)).toBeUndefined();
    expect(read).not.toHaveBeenCalled(); expect(remove).toHaveBeenCalledExactlyOnceWith("old.png");
  });

  it("reports read errors but tolerates best-effort cleanup errors", async () => {
    const remove = vi.fn().mockRejectedValue(new Error("cleanup unavailable"));
    await expect(readCurrentPreview({ outputPath: "a", originalPath: "b" }, async () => { throw new Error("read failed"); }, remove, () => true)).rejects.toThrow("read failed");
    expect(remove).toHaveBeenCalledTimes(2);
  });
});

const createPlan = (): SplitPlan => ({ key: "source+settings", directory: "/test/output", outcomes: [0, 1, 2].map((page) => ({ inputPath: "/test/source.pdf", outputPath: `/test/output/block-${page}.pdf`, pages: [page], status: "planned" })) });

describe("resumable split outputs", () => {
  it("retries only unfinished entries using the original names and preserves sizes/warnings", async () => {
    const plan = createPlan();
    const process = vi.fn().mockResolvedValueOnce({ outputBytes: 101, warnings: ["first warning"] }).mockRejectedValueOnce(new Error("network disconnected"));
    const changed = vi.fn();
    await expect(runSplitPlan(plan, process, changed, () => false)).rejects.toThrow("network disconnected");
    expect(plan.outcomes.map((entry) => entry.status)).toEqual(["done", "error", "planned"]);
    expect(resumableSplitPlan(plan, plan.key)).toBe(plan);
    const retry = vi.fn().mockResolvedValue({ outputBytes: 202 });
    await runSplitPlan(plan, retry, changed, () => false);
    expect(retry.mock.calls.map(([entry]) => entry.outputPath)).toEqual(["/test/output/block-1.pdf", "/test/output/block-2.pdf"]);
    expect(plan.outcomes[0]).toMatchObject({ status: "done", outputBytes: 101, warnings: ["first warning"] });
    expect(plan.outcomes.every((entry) => entry.status === "done")).toBe(true);
    expect(resumableSplitPlan(plan, plan.key)).toBeNull();
  });

  it("does not reuse a partial plan after document/settings change", () => {
    const plan = createPlan(); plan.outcomes[0].status = "done";
    expect(resumableSplitPlan(plan, "different-source-or-settings")).toBeNull();
    expect(resumableSplitPlan(null, plan.key)).toBeNull();
  });

  it("cancellation keeps completed work and permits continuation", async () => {
    const plan = createPlan(); let cancelled = false;
    await expect(runSplitPlan(plan, async () => { cancelled = true; return { outputBytes: 10 }; }, () => {}, () => cancelled)).rejects.toThrow("Разделение отменено");
    expect(plan.outcomes.map((entry) => entry.status)).toEqual(["done", "planned", "planned"]);
    const retry = vi.fn().mockResolvedValue({ outputBytes: 12 });
    await runSplitPlan(plan, retry, () => {}, () => false);
    expect(retry).toHaveBeenCalledTimes(2);
  });
});

describe("preset/save single-flight admission", () => {
  it("rejects an immediate second click and unlocks after a failed operation", async () => {
    const gate = new ScannerSingleFlight(); const first = deferred<void>();
    const operation = vi.fn(() => first.promise);
    const pending = gate.run(operation);
    expect(gate.busy).toBe(true);
    expect(await gate.run(operation)).toBeUndefined();
    expect(operation).toHaveBeenCalledTimes(1);
    first.reject(new Error("offline"));
    await expect(pending).rejects.toThrow("offline");
    expect(gate.busy).toBe(false);
    expect(await gate.run(async () => "saved")).toBe("saved");
  });
});

describe("native event subscription boundary", () => {
  it("does not touch the Tauri bridge in browser preview", () => {
    const subscribe = vi.fn(); const error = vi.fn();
    subscribeScannerProgress(false, subscribe, error)();
    expect(subscribe).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
  });

  it("cleans a subscription that finishes after component unmount", async () => {
    const subscription = deferred<() => void>(); const stop = vi.fn();
    const dispose = subscribeScannerProgress(true, () => subscription.promise, vi.fn());
    dispose(); subscription.resolve(stop); await subscription.promise; await Promise.resolve();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("handles subscription failure without an unhandled rejection", async () => {
    const subscription = deferred<() => void>(); const error = vi.fn();
    subscribeScannerProgress(true, () => subscription.promise, error);
    subscription.reject("bridge disconnected"); await Promise.resolve(); await Promise.resolve();
    expect(error).toHaveBeenCalledExactlyOnceWith("bridge disconnected");
  });
});
