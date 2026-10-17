type DraftMutation = "write" | "cleanup";
interface DraftLane { tail: Promise<void>; cleanupRequired: boolean; sequence: number; cleanupVersion: number }
const lanes = new Map<string, DraftLane>();
const ownerKey = (workspaceRoot: string, draftKey: string) => JSON.stringify([workspaceRoot, draftKey]);

/** Only in-flight operations and failed cleanup intentions are shared across
 * editor remounts. No proposal fields, records or credentials are cached here. */
export function queueProposalDraftMutation(workspaceRoot: string, draftKey: string, kind: DraftMutation, operation: () => Promise<void>): Promise<void> {
  const key = ownerKey(workspaceRoot, draftKey);
  const lane = lanes.get(key) || { tail: Promise.resolve(), cleanupRequired: false, sequence: 0, cleanupVersion: 0 };
  const version = ++lane.sequence;
  if (kind === "cleanup") { lane.cleanupRequired = true; lane.cleanupVersion = version; }
  const task = lane.tail.catch(() => undefined).then(operation);
  lane.tail = task; lanes.set(key, lane);
  void task.then(() => {
    if (lanes.get(key) !== lane) return;
    // Enqueueing a replacement is not proof it reached storage. Retire an
    // earlier cleanup only after success, never an intent queued after us.
    if (version >= lane.cleanupVersion) lane.cleanupRequired = false;
    if (lane.tail === task && !lane.cleanupRequired) lanes.delete(key);
  }, () => {
    // A failed cleanup must not make a later editor silently restore the old
    // draft. It may retry through the new editor's current workspace/access.
    if (lanes.get(key) === lane && lane.tail === task && !lane.cleanupRequired) lanes.delete(key);
  });
  return task;
}

export async function settleProposalDraftPersistence(workspaceRoot: string, draftKey: string, cleanup: () => Promise<void>): Promise<void> {
  const key = ownerKey(workspaceRoot, draftKey);
  for (;;) {
    const lane = lanes.get(key); if (!lane) return;
    const tail = lane.tail; await tail.catch(() => undefined);
    const current = lanes.get(key);
    if (current && current.tail !== tail) continue;
    if (current?.cleanupRequired) {
      await queueProposalDraftMutation(workspaceRoot, draftKey, "cleanup", cleanup);
      // A newer write may have joined while the retry was in flight. A reader
      // must wait for that write too before inspecting persisted storage.
      continue;
    }
    return;
  }
}

export function hasPendingProposalDraftPersistence(workspaceRoot: string, draftKey: string): boolean {
  return lanes.has(ownerKey(workspaceRoot, draftKey));
}

export function resetProposalDraftPersistenceForTests() { lanes.clear(); }
