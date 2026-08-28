export interface AccessTimers { refreshSeconds: number; backupHours: number; retentionCount: number; retentionDays: number }

export const accessTimerKey = "sbk-tools:shared-folder-timers";
export const accessTimerEvent = "sbk-workspace-timers-changed";
export const lastAutomaticBackupKey = "sbk-tools:last-automatic-backup";
export const lastAutomaticBackupAttemptKey = "sbk-tools:last-automatic-backup-attempt";
export const defaultAccessTimers: AccessTimers = { refreshSeconds: 30, backupHours: 0, retentionCount: 10, retentionDays: 180 };

const allowedRefresh = new Set([0, 15, 30, 60, 300]);
const allowedBackup = new Set([0, 6, 12, 24, 168]);

export function normalizeAccessTimers(value: Partial<AccessTimers> | null | undefined): AccessTimers {
  const refreshSeconds = Number(value?.refreshSeconds);
  const backupHours = Number(value?.backupHours);
  const retentionCount = Number(value?.retentionCount);
  const retentionDays = Number(value?.retentionDays);
  return {
    refreshSeconds: allowedRefresh.has(refreshSeconds) ? refreshSeconds : defaultAccessTimers.refreshSeconds,
    backupHours: allowedBackup.has(backupHours) ? backupHours : defaultAccessTimers.backupHours,
    retentionCount: Number.isInteger(retentionCount) && retentionCount >= 1 && retentionCount <= 100 ? retentionCount : defaultAccessTimers.retentionCount,
    retentionDays: Number.isInteger(retentionDays) && retentionDays >= 1 && retentionDays <= 3650 ? retentionDays : defaultAccessTimers.retentionDays,
  };
}

export function workspaceLocalKey(base: string, workspaceRoot = "default"): string {
  let hash = 2166136261;
  for (const character of workspaceRoot) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return `${base}:${(hash >>> 0).toString(16)}`;
}

export function readAccessTimers(workspaceRoot = "default"): AccessTimers {
  try { return normalizeAccessTimers(JSON.parse(localStorage.getItem(workspaceLocalKey(accessTimerKey, workspaceRoot)) || "{}")); }
  catch { return defaultAccessTimers; }
}

export function saveAccessTimers(value: AccessTimers, workspaceRoot = "default"): AccessTimers {
  const normalized = normalizeAccessTimers(value);
  localStorage.setItem(workspaceLocalKey(accessTimerKey, workspaceRoot), JSON.stringify(normalized));
  window.dispatchEvent(new CustomEvent<AccessTimers>(accessTimerEvent, { detail: normalized }));
  return normalized;
}

export function automaticBackupIsDue(lastTimestamp: number, now: number, backupHours: number): boolean {
  return backupHours > 0 && Number.isFinite(lastTimestamp) && now - lastTimestamp >= backupHours * 3_600_000;
}

export class AutomaticBackupGate {
  private running = false;

  beginIfDue(lastTimestamp: number, lastAttemptTimestamp: number, now: number, backupHours: number): boolean {
    const retryCooldownMs = 10 * 60_000;
    if (this.running
      || !automaticBackupIsDue(lastTimestamp, now, backupHours)
      || (lastAttemptTimestamp > lastTimestamp && now - lastAttemptTimestamp < retryCooldownMs)) return false;
    this.running = true;
    return true;
  }

  finish(): void {
    this.running = false;
  }
}
