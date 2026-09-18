import { readDraft, saveDraft } from "./storage";

export interface AccessTimers { refreshSeconds: number; backupHours: number; retentionCount: number; retentionDays: number }

export interface SharedBackupPolicy {
  version: 1;
  backupHours: number;
  retentionCount: number;
  retentionDays: number;
  /** Successful creation, NOT verification or proof of restorability. */
  lastSuccessAt: number;
  lastAttemptAt: number;
  lastError: string;
  lastBackupPath: string;
}
export interface SharedBackupPolicySnapshot {
  source: "shared" | "local-fallback";
  policy: SharedBackupPolicy;
}
export const sharedBackupPolicyKey = "backup-policy-v1";
export const sharedBackupPolicyEvent = "sbk-backup-policy-changed";
let policyWrites: Promise<unknown> = Promise.resolve();

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

function validSharedBackupPolicy(value: unknown): SharedBackupPolicy {
  if (!value || typeof value !== "object") throw new Error("Общая политика резервирования повреждена");
  const policy = value as SharedBackupPolicy;
  if (policy.version !== 1 || !allowedBackup.has(policy.backupHours)
    || !Number.isInteger(policy.retentionCount) || policy.retentionCount < 1 || policy.retentionCount > 100
    || !Number.isInteger(policy.retentionDays) || policy.retentionDays < 1 || policy.retentionDays > 3650
    || !Number.isFinite(policy.lastAttemptAt) || policy.lastAttemptAt < 0
    || !Number.isFinite(policy.lastSuccessAt) || policy.lastSuccessAt < 0
    || typeof policy.lastError !== "string" || typeof policy.lastBackupPath !== "string") {
    throw new Error("Общая политика резервирования имеет неподдерживаемую версию или некорректные поля. Настройки не заменены.");
  }
  return { version: 1, backupHours: policy.backupHours, retentionCount: policy.retentionCount, retentionDays: policy.retentionDays, lastAttemptAt: policy.lastAttemptAt, lastSuccessAt: policy.lastSuccessAt, lastError: policy.lastError.slice(0, 2000), lastBackupPath: policy.lastBackupPath };
}

function localBackupTimestamp(key: string, root: string): number {
  try {
    const value = Number(localStorage.getItem(workspaceLocalKey(key, root)) || 0);
    return Number.isFinite(value) && value >= 0 ? value : 0;
  } catch { return 0; }
}

export async function readSharedBackupPolicy(workspaceRoot: string): Promise<SharedBackupPolicySnapshot> {
  // A storage error is not an absent policy. Propagate it so automatic writes
  // and rotation stop until the shared settings can be read again.
  const stored = await readDraft<unknown>("settings", sharedBackupPolicyKey);
  if (stored !== null) return { source: "shared", policy: validSharedBackupPolicy(stored) };
  const local = readAccessTimers(workspaceRoot);
  return { source: "local-fallback", policy: {
    version: 1, backupHours: local.backupHours, retentionCount: local.retentionCount, retentionDays: local.retentionDays,
    lastAttemptAt: localBackupTimestamp(lastAutomaticBackupAttemptKey, workspaceRoot),
    lastSuccessAt: localBackupTimestamp(lastAutomaticBackupKey, workspaceRoot), lastError: "", lastBackupPath: "",
  } };
}

export async function saveSharedBackupPolicy(workspaceRoot: string, patch: Partial<Omit<SharedBackupPolicy, "version">>): Promise<SharedBackupPolicySnapshot> {
  // Only one editor can write the shared database. Serialize that editor's
  // settings/save-status operations inside this window to avoid stale merges.
  const work = policyWrites.catch(() => undefined).then(async () => {
    const current = await readSharedBackupPolicy(workspaceRoot);
    const policy = validSharedBackupPolicy({ ...current.policy, ...patch, version: 1 });
    await saveDraft("settings", policy, sharedBackupPolicyKey); // Native editor guard remains authoritative.
    window.dispatchEvent(new CustomEvent(sharedBackupPolicyEvent, { detail: { workspaceRoot, policy } }));
    return { source: "shared" as const, policy };
  });
  policyWrites = work;
  return work;
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
