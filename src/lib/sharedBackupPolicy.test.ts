import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readDraft, saveDraft } from "./storage";
import { accessTimerKey, readSharedBackupPolicy, saveSharedBackupPolicy, sharedBackupPolicyKey, workspaceLocalKey, type SharedBackupPolicy } from "./sharedWorkspace";

vi.mock("./storage", () => ({ readDraft: vi.fn(), saveDraft: vi.fn() }));
const shared: SharedBackupPolicy = { version: 1, backupHours: 24, retentionCount: 17, retentionDays: 91, lastSuccessAt: 1234, lastAttemptAt: 1234, lastError: "", lastBackupPath: "/share/backups/test.sbkbackup" };
let stored: unknown;
let local: Map<string, string>;
beforeEach(() => {
  stored = { ...shared }; local = new Map();
  vi.stubGlobal("localStorage", { getItem: (key: string) => local.get(key) ?? null, setItem: (key: string, value: string) => local.set(key, value) });
  vi.stubGlobal("window", { dispatchEvent: vi.fn() });
  vi.mocked(readDraft).mockReset().mockImplementation(async () => stored);
  vi.mocked(saveDraft).mockReset().mockImplementation(async (_module, value) => { stored = value; });
});
afterEach(() => vi.unstubAllGlobals());

describe("shared backup policy", () => {
  it("reads one shared schedule regardless of device-local settings without writing", async () => {
    local.set(workspaceLocalKey(accessTimerKey, "Z:/ProductData"), JSON.stringify({ backupHours: 6, retentionCount: 2 }));
    local.set(workspaceLocalKey(accessTimerKey, "/Volumes/ProductData"), JSON.stringify({ backupHours: 168, retentionCount: 99 }));
    expect(await readSharedBackupPolicy("Z:/ProductData")).toEqual({ source: "shared", policy: shared });
    expect(await readSharedBackupPolicy("/Volumes/ProductData")).toEqual({ source: "shared", policy: shared });
    expect(readDraft).toHaveBeenCalledWith("settings", sharedBackupPolicyKey);
    expect(saveDraft).not.toHaveBeenCalled();
  });

  it("uses labelled legacy values only when policy is absent, never publishing them automatically", async () => {
    stored = null;
    local.set(workspaceLocalKey(accessTimerKey, "root"), JSON.stringify({ backupHours: 12, retentionCount: 5, retentionDays: 42 }));
    const result = await readSharedBackupPolicy("root");
    expect(result.source).toBe("local-fallback");
    expect(result.policy).toMatchObject({ backupHours: 12, retentionCount: 5, retentionDays: 42 });
    expect(saveDraft).not.toHaveBeenCalled();
  });

  it("fails closed on unreadable or invalid shared policy, preserving it", async () => {
    vi.mocked(readDraft).mockRejectedValueOnce(new Error("SMB disconnected"));
    await expect(readSharedBackupPolicy("root")).rejects.toThrow("SMB disconnected");
    for (const value of [{ ...shared, version: 2 }, { ...shared, retentionCount: 0 }, {}, "invalid"]) {
      stored = value;
      await expect(saveSharedBackupPolicy("root", { backupHours: 6 })).rejects.toThrow();
      expect(stored).toEqual(value);
    }
    expect(saveDraft).not.toHaveBeenCalled();
  });

  it("serializes settings and status updates, merges fresh shared state and writes the correct draft key", async () => {
    await Promise.all([
      saveSharedBackupPolicy("root", { backupHours: 6, retentionCount: 3 }),
      saveSharedBackupPolicy("root", { lastAttemptAt: 2000, lastError: "Retry needed" }),
    ]);
    expect(stored).toEqual({ ...shared, backupHours: 6, retentionCount: 3, lastAttemptAt: 2000, lastError: "Retry needed" });
    expect(saveDraft).toHaveBeenLastCalledWith("settings", stored, sharedBackupPolicyKey);
    expect((stored as SharedBackupPolicy).lastSuccessAt).toBe(1234);
  });

  it("does not mask the backend editor guard or report a rejected save as success", async () => {
    vi.mocked(saveDraft).mockRejectedValueOnce(new Error("Only editor may write"));
    await expect(saveSharedBackupPolicy("root", { backupHours: 6 })).rejects.toThrow("Only editor may write");
    expect(stored).toEqual(shared);
    expect(window.dispatchEvent).not.toHaveBeenCalled();
  });
});
