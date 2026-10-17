import { beforeEach, describe, expect, it, vi } from "vitest";
import { queueProposalDraftMutation, resetProposalDraftPersistenceForTests, settleProposalDraftPersistence } from "./proposalDraftPersistence";

function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }
beforeEach(resetProposalDraftPersistenceForTests);

describe("proposal draft mutation lanes", () => {
  it("cleans only after a previous in-flight write finishes", async () => {
    const writing = deferred(), events: string[] = [];
    const write = queueProposalDraftMutation("root-a", "proposal:a", "write", async () => { events.push("write-start"); await writing.promise; events.push("write-end"); });
    const clean = queueProposalDraftMutation("root-a", "proposal:a", "cleanup", async () => { events.push("cleanup"); });
    await Promise.resolve(); await Promise.resolve(); expect(events).toEqual(["write-start"]);
    writing.resolve(); await Promise.all([write, clean]); expect(events).toEqual(["write-start", "write-end", "cleanup"]);
  });

  it("keeps a new reader behind a pending cleanup without running another cleanup", async () => {
    const clearing = deferred(), retry = vi.fn(async () => undefined);
    const cleanup = queueProposalDraftMutation("root-a", "proposal:a", "cleanup", () => clearing.promise);
    let ready = false; const reader = settleProposalDraftPersistence("root-a", "proposal:a", retry).then(() => { ready = true; });
    await Promise.resolve(); await Promise.resolve(); expect(ready).toBe(false);
    clearing.resolve(); await Promise.all([cleanup, reader]); expect(ready).toBe(true); expect(retry).not.toHaveBeenCalled();
  });

  it("retains failed cleanup intent and retries using the new reader's own access guard", async () => {
    const oldGuard = vi.fn(async () => { throw new Error("Old editor no longer owns the workspace"); });
    await expect(queueProposalDraftMutation("root-a", "proposal:a", "cleanup", oldGuard)).rejects.toThrow("Old editor");
    const currentGuard = vi.fn(async () => undefined);
    await settleProposalDraftPersistence("root-a", "proposal:a", currentGuard);
    expect(oldGuard).toHaveBeenCalledOnce(); expect(currentGuard).toHaveBeenCalledOnce();
    await settleProposalDraftPersistence("root-a", "proposal:a", currentGuard); expect(currentGuard).toHaveBeenCalledOnce();
  });

  it("does not hide a failed retry and keeps the intent for a subsequent explicit retry", async () => {
    await expect(queueProposalDraftMutation("root-a", "proposal:a", "cleanup", async () => { throw new Error("Offline"); })).rejects.toThrow("Offline");
    await expect(settleProposalDraftPersistence("root-a", "proposal:a", async () => { throw new Error("Still offline"); })).rejects.toThrow("Still offline");
    const recovered = vi.fn(async () => undefined); await settleProposalDraftPersistence("root-a", "proposal:a", recovered); expect(recovered).toHaveBeenCalledOnce();
  });

  it("isolates different workspaces and draft keys", async () => {
    const writing = deferred(), operation = queueProposalDraftMutation("root-a", "proposal:a", "write", () => writing.promise);
    const unused = vi.fn(async () => undefined);
    await settleProposalDraftPersistence("root-b", "proposal:a", unused);
    await settleProposalDraftPersistence("root-a", "proposal:b", unused); expect(unused).not.toHaveBeenCalled();
    writing.resolve(); await operation;
  });

  it("lets explicit cleanup recover after a failed autosave", async () => {
    await expect(queueProposalDraftMutation("root-a", "proposal:a", "write", async () => { throw new Error("Write failed"); })).rejects.toThrow("Write failed");
    const cleanup = vi.fn(async () => undefined); await queueProposalDraftMutation("root-a", "proposal:a", "cleanup", cleanup); expect(cleanup).toHaveBeenCalledOnce();
  });

  it("does not release a later write when an earlier cleanup settles", async () => {
    const clearing = deferred(), writing = deferred();
    const first = queueProposalDraftMutation("root-a", "proposal:a", "cleanup", () => clearing.promise);
    const second = queueProposalDraftMutation("root-a", "proposal:a", "write", () => writing.promise);
    let read = false; const reader = settleProposalDraftPersistence("root-a", "proposal:a", async () => { throw new Error("Must not clean a newer edit"); }).then(() => { read = true; });
    clearing.resolve(); await first; expect(read).toBe(false); writing.resolve(); await Promise.all([second, reader]); expect(read).toBe(true);
  });

  it("retains cleanup debt when a subsequent replacement autosave also fails", async () => {
    await expect(queueProposalDraftMutation("root-a", "proposal:a", "cleanup", async () => { throw new Error("Cleanup offline"); })).rejects.toThrow("Cleanup offline");
    await expect(queueProposalDraftMutation("root-a", "proposal:a", "write", async () => { throw new Error("Write offline"); })).rejects.toThrow("Write offline");
    const retry = vi.fn(async () => undefined);
    await settleProposalDraftPersistence("root-a", "proposal:a", retry);
    expect(retry).toHaveBeenCalledOnce();
  });

  it("retires old cleanup debt after a successful replacement even if the next write fails", async () => {
    await expect(queueProposalDraftMutation("root-a", "proposal:a", "cleanup", async () => { throw new Error("Cleanup offline"); })).rejects.toThrow("Cleanup offline");
    const replacement = deferred();
    const first = queueProposalDraftMutation("root-a", "proposal:a", "write", () => replacement.promise);
    const second = queueProposalDraftMutation("root-a", "proposal:a", "write", async () => { throw new Error("Next write offline"); });
    const failed = expect(second).rejects.toThrow("Next write offline");
    replacement.resolve(); await first; await failed;
    const cleanup = vi.fn(async () => undefined);
    await settleProposalDraftPersistence("root-a", "proposal:a", cleanup);
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("never retires a newer cleanup intent when an older queued write succeeds", async () => {
    await expect(queueProposalDraftMutation("root-a", "proposal:a", "cleanup", async () => { throw new Error("Old cleanup offline"); })).rejects.toThrow("Old cleanup offline");
    const replacement = deferred();
    const write = queueProposalDraftMutation("root-a", "proposal:a", "write", () => replacement.promise);
    const clean = queueProposalDraftMutation("root-a", "proposal:a", "cleanup", async () => { throw new Error("New cleanup offline"); });
    const failed = expect(clean).rejects.toThrow("New cleanup offline");
    replacement.resolve(); await write; await failed;
    const retry = vi.fn(async () => undefined);
    await settleProposalDraftPersistence("root-a", "proposal:a", retry);
    expect(retry).toHaveBeenCalledOnce();
  });

  it("does not release a reader while a newer write follows its retry cleanup", async () => {
    await expect(queueProposalDraftMutation("root-a", "proposal:a", "cleanup", async () => { throw new Error("Cleanup offline"); })).rejects.toThrow("Cleanup offline");
    const retry = deferred(), writing = deferred(); let retryStarted = false, ready = false;
    const reader = settleProposalDraftPersistence("root-a", "proposal:a", () => { retryStarted = true; return retry.promise; }).then(() => { ready = true; });
    for (let turn = 0; turn < 10 && !retryStarted; turn += 1) await Promise.resolve();
    expect(retryStarted).toBe(true);
    const write = queueProposalDraftMutation("root-a", "proposal:a", "write", () => writing.promise);
    retry.resolve(); for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
    expect(ready).toBe(false);
    writing.resolve(); await Promise.all([reader, write]); expect(ready).toBe(true);
  });
});
