import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceInfo } from "../lib/storage";
import { useAutomaticBackup } from "./useAutomaticBackup";

const mocks = vi.hoisted(() => ({
  cleanup: undefined as undefined | (() => void), tick: undefined as undefined | (() => void),
  current: vi.fn(), create: vi.fn(), rotate: vi.fn(), read: vi.fn(), save: vi.fn(), finish: vi.fn(), start: vi.fn(),
}));
vi.mock("react", () => ({ useEffect: (effect: () => undefined | (() => void)) => { mocks.cleanup = effect(); } }));
vi.mock("../lib/storage", () => ({ getWorkspaceInfo: mocks.current, createBackup: mocks.create, rotateBackups: mocks.rotate }));
vi.mock("../lib/activity", () => ({ startActivity: mocks.start }));
vi.mock("../lib/sharedWorkspace", async (original) => ({ ...await original<typeof import("../lib/sharedWorkspace")>(), readSharedBackupPolicy: mocks.read, saveSharedBackupPolicy: mocks.save }));

const workspace: WorkspaceInfo = { root: "/synthetic/shared", configured: true, portable: false, editor: true, editorBusy: true, writable: true, accessControlled: true, accessMessage: "Editor", schemaVersion: 3, freeSpaceBytes: 1000 };
const policy = { version: 1 as const, backupHours: 24, retentionCount: 10, retentionDays: 180, lastSuccessAt: 0, lastAttemptAt: 0, lastError: "", lastBackupPath: "" };
let stored = { source: "shared" as "shared" | "local-fallback", policy: { ...policy } };
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function flush() { for (let count = 0; count < 30; count++) await Promise.resolve(); }
beforeEach(() => {
  for (const mock of [mocks.current, mocks.create, mocks.rotate, mocks.read, mocks.save, mocks.finish, mocks.start]) mock.mockReset();
  mocks.cleanup = undefined; mocks.tick = undefined;
  stored = { source: "shared", policy: { ...policy } };
  mocks.current.mockResolvedValue(workspace); mocks.create.mockResolvedValue({ path: "/synthetic/copy.sbkbackup", fileName: "copy.sbkbackup", sizeBytes: 1 });
  mocks.rotate.mockResolvedValue(0); mocks.start.mockReturnValue(mocks.finish);
  mocks.read.mockImplementation(async () => ({ ...stored, policy: { ...stored.policy } }));
  mocks.save.mockImplementation(async (_root: string, patch: Partial<typeof policy>) => { stored = { source: "shared", policy: { ...stored.policy, ...patch } }; return stored; });
  const local = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => local.get(key) ?? null, setItem: vi.fn((key: string, value: string) => local.set(key, value)) });
  vi.stubGlobal("window", { setInterval: vi.fn((tick: () => void) => { mocks.tick = tick; return 1; }), clearInterval: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() });
});
afterEach(() => { mocks.cleanup?.(); vi.unstubAllGlobals(); });

describe("automatic backup effect", () => {
  it("performs no checks or writes for a viewer", async () => {
    useAutomaticBackup({ ...workspace, editor: false }, vi.fn()); await flush();
    expect(mocks.current).not.toHaveBeenCalled(); expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });
  it("stops on failed shared policy reads instead of using local defaults", async () => {
    const failure = new Error("SMB disconnected"); mocks.read.mockRejectedValue(failure);
    useAutomaticBackup(workspace, vi.fn()); await flush();
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.rotate).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.finish).toHaveBeenCalledWith(failure);
  });
  it("does not publish fallback settings automatically", async () => {
    stored.source = "local-fallback";
    useAutomaticBackup(workspace, vi.fn()); await flush();
    expect(mocks.create).toHaveBeenCalledOnce(); expect(mocks.save).not.toHaveBeenCalled();
    expect(localStorage.setItem).toHaveBeenCalledTimes(2);
  });
  it("serializes overlapping ticks and stores successful creation before a pruning failure", async () => {
    const pending = deferred<{ path: string }>(); mocks.create.mockReturnValue(pending.promise);
    const failure = new Error("pins unreadable"); mocks.rotate.mockRejectedValue(failure);
    useAutomaticBackup(workspace, vi.fn()); await flush();
    mocks.tick?.(); mocks.tick?.(); await flush();
    expect(mocks.create).toHaveBeenCalledOnce();
    pending.resolve({ path: "/synthetic/new.sbkbackup" }); await flush();
    expect(stored.policy.lastSuccessAt).toBeGreaterThan(0);
    expect(stored.policy.lastBackupPath).toBe("/synthetic/new.sbkbackup");
    expect(stored.policy.lastError).toContain("pins unreadable");
    expect(mocks.finish).toHaveBeenCalledWith(failure);
    const successSave = mocks.save.mock.calls.findIndex(([, patch]) => "lastSuccessAt" in patch);
    expect(mocks.save.mock.invocationCallOrder[successSave]).toBeLessThan(mocks.rotate.mock.invocationCallOrder[0]);
  });
  it("finishes a running activity even when a pending backup fails after effect cleanup", async () => {
    const pending = deferred<{ path: string }>(); mocks.create.mockReturnValue(pending.promise);
    useAutomaticBackup(workspace, vi.fn()); await flush();
    expect(mocks.start).toHaveBeenCalledOnce();
    mocks.cleanup?.(); mocks.cleanup = undefined;
    const failure = new Error("Editor was released"); pending.reject(failure); await flush();
    expect(mocks.finish).toHaveBeenCalledWith(failure);
    expect(mocks.save).toHaveBeenCalledTimes(1); // Only the pre-copy attempt, no late shared write.
    expect(mocks.rotate).not.toHaveBeenCalled();
  });
  it("uses freshly saved retention rather than the pre-copy snapshot for deletion", async () => {
    const pending = deferred<{ path: string }>(); mocks.create.mockReturnValue(pending.promise);
    useAutomaticBackup(workspace, vi.fn()); await flush();
    stored.policy.retentionCount = 80; stored.policy.retentionDays = 3650;
    pending.resolve({ path: "/synthetic/new.sbkbackup" }); await flush();
    expect(mocks.rotate).toHaveBeenCalledWith(80, 3650);
  });
});
