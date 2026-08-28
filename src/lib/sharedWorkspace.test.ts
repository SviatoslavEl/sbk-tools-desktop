import { describe, expect, it } from "vitest";
import { AutomaticBackupGate, automaticBackupIsDue, normalizeAccessTimers, workspaceLocalKey } from "./sharedWorkspace";

describe("shared workspace timers", () => {
  it("accepts only bounded timer choices", () => {
    expect(normalizeAccessTimers({ refreshSeconds: 15, backupHours: 168, retentionCount: 20, retentionDays: 365 })).toEqual({ refreshSeconds: 15, backupHours: 168, retentionCount: 20, retentionDays: 365 });
    expect(normalizeAccessTimers({ refreshSeconds: -1, backupHours: 1, retentionCount: 0, retentionDays: 99999 })).toEqual({ refreshSeconds: 30, backupHours: 0, retentionCount: 10, retentionDays: 180 });
  });

  it("does not archive early or when disabled", () => {
    const hour = 3_600_000;
    expect(automaticBackupIsDue(10 * hour, 33 * hour, 24)).toBe(false);
    expect(automaticBackupIsDue(10 * hour, 34 * hour, 24)).toBe(true);
    expect(automaticBackupIsDue(0, 100 * hour, 0)).toBe(false);
  });

  it("prevents overlapping automatic backups", () => {
    const gate = new AutomaticBackupGate();
    expect(gate.beginIfDue(0, 0, 24 * 3_600_000, 24)).toBe(true);
    expect(gate.beginIfDue(0, 0, 25 * 3_600_000, 24)).toBe(false);
    gate.finish();
    expect(gate.beginIfDue(25 * 3_600_000, 25 * 3_600_000, 25 * 3_600_000, 24)).toBe(false);
    expect(gate.beginIfDue(0, 25 * 3_600_000, 25 * 3_600_000 + 60_000, 24)).toBe(false);
  });

  it("isolates schedules and timestamps by workspace", () => {
    expect(workspaceLocalKey("timer", "//server/share-a")).not.toBe(workspaceLocalKey("timer", "//server/share-b"));
    expect(workspaceLocalKey("timer", "//server/share-a")).toBe(workspaceLocalKey("timer", "//server/share-a"));
  });
});
