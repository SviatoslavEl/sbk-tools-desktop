import { useEffect } from "react";
import { startActivity } from "../lib/activity";
import { createBackup, getWorkspaceInfo, rotateBackups, type WorkspaceInfo } from "../lib/storage";
import { AutomaticBackupGate, lastAutomaticBackupAttemptKey, lastAutomaticBackupKey, readSharedBackupPolicy, saveSharedBackupPolicy, sharedBackupPolicyEvent, workspaceLocalKey, type SharedBackupPolicySnapshot } from "../lib/sharedWorkspace";

export function useAutomaticBackup(workspace: WorkspaceInfo | null, onWorkspace: (next: WorkspaceInfo) => void) {
  useEffect(() => {
    if (!workspace?.editor) return;
    let stopped = false;
    let checking = false;
    const gate = new AutomaticBackupGate();
    const root = workspace.root;
    const run = async () => {
      if (checking || stopped) return;
      checking = true;
      let finish: ReturnType<typeof startActivity> | undefined;
      let snapshot: SharedBackupPolicySnapshot | undefined;
      try {
        const current = await getWorkspaceInfo();
        if (stopped || current.root !== root) return;
        onWorkspace(current);
        if (!current.editor) return;
        snapshot = await readSharedBackupPolicy(root);
        if (stopped) return;
        const { policy } = snapshot;
        const now = Date.now();
        if (!gate.beginIfDue(policy.lastSuccessAt, policy.lastAttemptAt, now, policy.backupHours)) return;
        finish = startActivity("Автоматическая резервная копия");
        if (snapshot.source === "shared") await saveSharedBackupPolicy(root, { lastAttemptAt: now, lastError: "" });
        else localStorage.setItem(workspaceLocalKey(lastAutomaticBackupAttemptKey, root), String(now));
        const backup = await createBackup();
        if (stopped) { finish(); return; }
        // Creation and retention are separate: a pruning failure must not erase the successful copy status.
        if (snapshot.source === "shared") await saveSharedBackupPolicy(root, { lastSuccessAt: Date.now(), lastBackupPath: backup.path, lastError: "" });
        else localStorage.setItem(workspaceLocalKey(lastAutomaticBackupKey, root), String(Date.now()));
        const [latestPolicy, latestWorkspace] = await Promise.all([readSharedBackupPolicy(root), getWorkspaceInfo()]);
        if (!stopped && latestWorkspace.root === root && latestWorkspace.editor) await rotateBackups(latestPolicy.policy.retentionCount, latestPolicy.policy.retentionDays);
        finish();
      } catch (error) {
        if (finish) finish(error);
        if (!stopped) {
          if (!finish) startActivity("Проверка автоматического резервирования")(error);
          if (snapshot?.source === "shared") {
            try { await saveSharedBackupPolicy(root, { lastError: String(error) }); }
            catch { /* The activity retains the failure even when the network cannot accept the status. */ }
          }
        }
      } finally { gate.finish(); checking = false; }
    };
    void run();
    const timer = window.setInterval(() => void run(), 60_000);
    const changed = () => void run();
    window.addEventListener(sharedBackupPolicyEvent, changed);
    return () => { stopped = true; window.clearInterval(timer); window.removeEventListener(sharedBackupPolicyEvent, changed); };
  }, [workspace?.root, workspace?.editor, onWorkspace]);
}
