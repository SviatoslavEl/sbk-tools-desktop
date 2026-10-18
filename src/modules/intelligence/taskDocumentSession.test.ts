import { describe, expect, it, vi } from "vitest";
import { createTaskDocumentOrigin, createTaskDocumentSession, isTaskDocumentOrigin, projectTaskDocumentSession, reduceTaskDocumentSession, sameTaskDocumentOrigin, taskDocumentDraftKey, taskDocumentOriginKey, TASK_DOCUMENT_SESSION_LIMITS, type TaskDocumentExportFormat, type TaskDocumentOrigin, type TaskDocumentSession } from "./taskDocumentSession";

const origin = (patch: Partial<TaskDocumentOrigin> = {}): TaskDocumentOrigin => ({ taskId: "task-1", resultId: "result-1", workspaceRoot: "/private/tmp/qa-workspace", sourceSnapshotKey: "snapshot-01", baseResultRevision: 3, ...patch });
const initial = (owner = origin(), fingerprint = '{"subject":"Проверка системы"}') => createTaskDocumentSession(owner, fingerprint);
const event = (state: TaskDocumentSession, type: string, attempt: number, patch: Record<string, unknown> = {}) => ({ type, origin: state.origin, workspaceRoot: state.origin.workspaceRoot, attempt, snapshot: state.current, ...patch });
const reduce = reduceTaskDocumentSession;
function accepted(state = initial(), attempt = state.latestAttempt + 1) {
  const queued = reduce(state, event(state, "queued", attempt, { operation: "open" }));
  return reduce(queued, event(queued, "accepted", attempt));
}
function saved(state: TaskDocumentSession, recordId = "record-1", attempt = state.latestAttempt + 1) {
  const queued = reduce(state, event(state, "queued", attempt, { operation: "save", recordId }));
  return reduce(queued, event(queued, "saved", attempt, { recordId }));
}
function exported(state: TaskDocumentSession, format: TaskDocumentExportFormat = "pdf", attempt = state.latestAttempt + 1) {
  const queued = reduce(state, event(state, "queued", attempt, { operation: "export", format }));
  return reduce(queued, event(queued, "exported", attempt, { format, outputPath: `/private/tmp/qa/${format}-document.${format}`, outputBytes: 128, sha256: "a".repeat(64) }));
}
function changed(state: TaskDocumentSession, fingerprint = '{"subject":"Изменённая проверка"}') {
  return reduce(state, { type: "changed", origin: state.origin, workspaceRoot: state.origin.workspaceRoot, previous: state.current, next: { revision: state.current.revision + 1, fingerprint } });
}

describe("task document immutable origin and namespace", () => {
  it("clones, validates and freezes a complete exact origin with a stable insertion-order-independent key", () => {
    const mutable = origin(), owner = createTaskDocumentOrigin(mutable);
    const reverse = { baseResultRevision: mutable.baseResultRevision, sourceSnapshotKey: mutable.sourceSnapshotKey, workspaceRoot: mutable.workspaceRoot, resultId: mutable.resultId, taskId: mutable.taskId };
    expect(Object.isFrozen(owner)).toBe(true);
    expect(owner).not.toBe(mutable);
    expect(taskDocumentOriginKey(owner)).toBe(taskDocumentOriginKey(reverse));
    expect(sameTaskDocumentOrigin(owner, reverse)).toBe(true);
    (mutable as { taskId: string }).taskId = "changed-outside";
    expect(owner.taskId).toBe("task-1");
  });

  it.each(["taskId", "resultId", "workspaceRoot", "sourceSnapshotKey", "baseResultRevision"] as const)("separates the identity of a different %s", (field) => {
    const value = origin(), other = { ...value, [field]: field === "baseResultRevision" ? 4 : field === "workspaceRoot" ? "/private/tmp/other-workspace" : "different-key" };
    expect(sameTaskDocumentOrigin(value, other)).toBe(false);
    expect(taskDocumentOriginKey(value)).not.toBe(taskDocumentOriginKey(other));
  });

  it.each([undefined, null, [], {}, { ...origin(), extra: true }, { ...origin(), taskId: "../task" }, { ...origin(), resultId: "result:other" }, { ...origin(), taskId: "x".repeat(129) }, { ...origin(), sourceSnapshotKey: "bad/key" }, { ...origin(), sourceSnapshotKey: "" }, { ...origin(), baseResultRevision: -1 }, { ...origin(), baseResultRevision: 1.5 }, { ...origin(), baseResultRevision: Number.MAX_SAFE_INTEGER + 1 }])("rejects malformed or extended origin %#", (value) => {
    expect(isTaskDocumentOrigin(value)).toBe(false);
    expect(() => createTaskDocumentOrigin(value)).toThrow();
  });

  it.each(["/private/tmp/Проверка 🧪", "C:\\Users\\QA\\ProductData", "C:/Users/QA/ProductData", "\\\\server\\share\\ProductData", "//server/share/ProductData", "\\\\?\\C:\\Users\\QA\\ProductData", "\\\\?\\UNC\\server\\share\\ProductData"])("accepts explicit absolute workspace identity %s without normalizing it", (workspaceRoot) => {
    expect(createTaskDocumentOrigin(origin({ workspaceRoot })).workspaceRoot).toBe(workspaceRoot);
  });

  it.each(["relative/qa", "C:relative", "\\relative", "file:///private/tmp/qa", "https://server/share", "/private/tmp/../production", "/private/./qa", "/private//qa", "\\\\server", "\\\\.\\pipe\\db", "\\\\?\\GLOBALROOT\\Device", "/private/tmp/qa\u0000", "/private/tmp/\ud800"])("rejects relative, device, control or ambiguous workspace identity %#", (workspaceRoot) => {
    expect(isTaskDocumentOrigin(origin({ workspaceRoot }))).toBe(false);
  });

  it("uses a deterministic bounded SHA-256 draft namespace without raw paths or unsafe separators", async () => {
    const owner = origin({ taskId: "t".repeat(128), resultId: "r".repeat(128), workspaceRoot: `/private/tmp/${"Конфиденциально".repeat(100)}` });
    const first = await taskDocumentDraftKey(owner), second = await taskDocumentDraftKey({ ...owner });
    expect(first).toBe(second);
    expect(first).toMatch(/^task-document:v1:[a-f0-9]{64}$/u);
    expect(new TextEncoder().encode(first).byteLength).toBeLessThanOrEqual(TASK_DOCUMENT_SESSION_LIMITS.draftKeyBytes);
    expect(first).not.toContain("Конфиденциально"); expect(first).not.toMatch(/[\\/]/u);
    for (const other of [origin({ taskId: "other-task" }), origin({ resultId: "other-result" }), origin({ workspaceRoot: "\\\\server\\share\\Other" }), origin({ sourceSnapshotKey: "snapshot-02" }), origin({ baseResultRevision: 4 })]) expect(await taskDocumentDraftKey(other)).not.toBe(await taskDocumentDraftKey(origin()));
  });

  it("never substitutes a weak/truncated key when WebCrypto is unavailable", async () => {
    vi.stubGlobal("crypto", undefined);
    try { await expect(taskDocumentDraftKey(origin())).rejects.toThrow(/WebCrypto/u); }
    finally { vi.unstubAllGlobals(); }
  });
});

describe("task document admission and operation receipts", () => {
  it("keeps a queued receiver/dialog handoff separate from actual acceptance", () => {
    const state = initial(), queued = reduce(state, event(state, "queued", 1, { operation: "open" }));
    expect(projectTaskDocumentSession(queued)).toMatchObject({ phase: "queued", acceptedForOrigin: false, acceptedCurrent: false, savedCurrent: false, exportedCurrent: false, editorAttached: false, counters: { results: 1, queued: 1, accepted: 0, saved: 0, exported: 0 } });
    const installed = reduce(queued, event(queued, "accepted", 1));
    expect(projectTaskDocumentSession(installed)).toMatchObject({ phase: "accepted", acceptedForOrigin: true, acceptedCurrent: true, editorAttached: true, hasUnsavedChanges: true });
    expect(state.latestAttempt).toBe(0); expect(state.pending).toBeUndefined();
  });

  it("requires an active pending operation and never accepts a merely successful-looking callback", () => {
    const state = initial();
    for (const callback of [event(state, "accepted", 1), event(state, "saved", 1, { recordId: "record-1" }), event(state, "exported", 1, { format: "pdf", outputPath: "/private/tmp/offer.pdf", outputBytes: 32, sha256: "a".repeat(64) })]) expect(reduce(state, callback)).toBe(state);
    for (const operation of ["save", "export"]) expect(reduce(state, event(state, "queued", 1, { operation, ...(operation === "save" ? { recordId: "record-1" } : { format: "pdf" }) }))).toBe(state);
  });

  it("cancels replacement/opening without acknowledging a late accepted callback", () => {
    const state = initial(), queued = reduce(state, event(state, "queued", 1, { operation: "open" }));
    const cancelled = reduce(queued, event(queued, "cancelled", 1, { operation: "open", reason: "replacement-dialog" }));
    expect(projectTaskDocumentSession(cancelled)).toMatchObject({ phase: "cancelled", acceptedForOrigin: false, counters: { accepted: 0, saved: 0, exported: 0 } });
    expect(reduce(cancelled, event(cancelled, "accepted", 1))).toBe(cancelled);
  });

  it("does not count a cancelled save-file dialog as saved or exported", () => {
    const state = accepted(), queued = reduce(state, event(state, "queued", 2, { operation: "export", format: "pdf" }));
    const cancelled = reduce(queued, event(queued, "cancelled", 2, { operation: "export", reason: "save-dialog" }));
    expect(projectTaskDocumentSession(cancelled)).toMatchObject({ phase: "cancelled", savedCurrent: false, exportedCurrent: false, counters: { accepted: 1, saved: 0, exported: 0 } });
    expect(cancelled.lastTransition.message).toBe("save-dialog");
    expect(reduce(cancelled, event(cancelled, "exported", 2, { format: "pdf", outputPath: "/private/tmp/offer.pdf", outputBytes: 32, sha256: "a".repeat(64) }))).toBe(cancelled);
  });

  it("does not erase an earlier genuine receipt when a later save or export is cancelled", () => {
    const state = exported(saved(accepted()));
    const queued = reduce(state, event(state, "queued", 4, { operation: "export", format: "docx" }));
    const cancelled = reduce(queued, event(queued, "cancelled", 4, { operation: "export", reason: "save-dialog" }));
    expect(projectTaskDocumentSession(cancelled)).toMatchObject({ phase: "cancelled", savedCurrent: true, exportedCurrent: true });
    expect(cancelled.exports.docx).toBeUndefined(); expect(cancelled.exports.pdf).toEqual(state.exports.pdf);
  });

  it("records a real card save independently from semantic readiness or file creation", () => {
    const state = saved(accepted()), projection = projectTaskDocumentSession(state);
    expect(projection).toMatchObject({ phase: "saved", savedCurrent: true, exportedCurrent: false, hasUnsavedChanges: false, semanticReadiness: "separate-gate", counters: { results: 1, saved: 1, exported: 0 } });
    expect(state.saved?.recordId).toBe("record-1");
    expect("semanticReady" in state).toBe(false);
  });

  it("binds a save receipt to the queued record ID, not another card", () => {
    const state = accepted(), queued = reduce(state, event(state, "queued", 2, { operation: "save", recordId: "record-a" }));
    expect(reduce(queued, event(queued, "saved", 2, { recordId: "record-b" }))).toBe(queued);
    expect(projectTaskDocumentSession(queued).savedCurrent).toBe(false);
    expect(reduce(queued, event(queued, "saved", 2, { recordId: "record-a" })).saved?.recordId).toBe("record-a");
  });

  it("records successful formats once per result rather than counting files as whole task results", () => {
    const state = exported(exported(exported(accepted(), "pdf"), "docx"), "zip"), projection = projectTaskDocumentSession(state);
    expect(projection.currentExports).toHaveLength(3);
    expect(projection.counters).toEqual({ results: 1, queued: 0, accepted: 1, saved: 0, exported: 1 });
    expect(projection.semanticReadiness).toBe("separate-gate");
    expect(projectTaskDocumentSession(exported(state, "pdf")).currentExports).toHaveLength(3);
  });

  it.each([
    { format: "preview" }, { format: "docx" }, { outputPath: "relative/offer.pdf" }, { outputPath: "/private/tmp/../offer.pdf" }, { outputBytes: 0 }, { outputBytes: -1 }, { outputBytes: 1.2 }, { sha256: "short" }, { sha256: "A".repeat(64) }, { extra: "not-allowed" },
  ])("rejects a mismatched or invalid export receipt %#", (patch) => {
    const state = accepted(), queued = reduce(state, event(state, "queued", 2, { operation: "export", format: "pdf" }));
    expect(reduce(queued, event(queued, "exported", 2, { format: "pdf", outputPath: "/private/tmp/offer.pdf", outputBytes: 128, sha256: "a".repeat(64), ...patch }))).toBe(queued);
  });
});

describe("stale callbacks, revisions and a single editor admission", () => {
  it.each(["taskId", "resultId", "workspaceRoot", "sourceSnapshotKey", "baseResultRevision"] as const)("rejects another origin's %s even with the same fingerprint and attempt", (field) => {
    const state = initial(), queued = reduce(state, event(state, "queued", 1, { operation: "open" }));
    const other = origin({ [field]: field === "baseResultRevision" ? 4 : field === "workspaceRoot" ? "/private/tmp/other-workspace" : "different-id" });
    expect(reduce(queued, event(queued, "accepted", 1, { origin: other }))).toBe(queued);
    expect(projectTaskDocumentSession(queued).acceptedForOrigin).toBe(false);
  });

  it.each(["accepted", "saved", "exported"])("rejects a wrong current workspace for %s", (type) => {
    const state = type === "accepted" ? initial() : accepted(), operation = type === "accepted" ? "open" : type === "saved" ? "save" : "export";
    const queued = reduce(state, event(state, "queued", state.latestAttempt + 1, { operation, ...(type === "saved" ? { recordId: "record-1" } : type === "exported" ? { format: "pdf" } : {}) }));
    const callback = event(queued, type, queued.latestAttempt, { workspaceRoot: "/private/tmp/another-workspace", ...(type === "saved" ? { recordId: "record-1" } : type === "exported" ? { format: "pdf", outputPath: "/private/tmp/offer.pdf", outputBytes: 128, sha256: "a".repeat(64) } : {}) });
    expect(reduce(queued, callback)).toBe(queued);
  });

  it("keeps origins independent even when their revisions, fingerprints and attempt numbers coincide", () => {
    const first = accepted(initial(origin({ taskId: "task-a" }))), second = accepted(initial(origin({ taskId: "task-b" })));
    const pendingA = reduce(first, event(first, "queued", 2, { operation: "save", recordId: "record-1" }));
    const pendingB = reduce(second, event(second, "queued", 2, { operation: "save", recordId: "record-1" }));
    expect(reduce(pendingB, event(pendingA, "saved", 2, { recordId: "record-1" }))).toBe(pendingB);
    expect(projectTaskDocumentSession(pendingA).savedCurrent).toBe(false);
    expect(projectTaskDocumentSession(pendingB).savedCurrent).toBe(false);
  });

  it("rejects an earlier open attempt after a newer attempt superseded it", () => {
    const state = initial(), first = reduce(state, event(state, "queued", 1, { operation: "open" }));
    const newer = reduce(first, event(first, "queued", 2, { operation: "open" }));
    expect(reduce(newer, event(first, "accepted", 1))).toBe(newer);
    expect(reduce(newer, event(first, "failed", 1, { operation: "open", message: "Старая ошибка" }))).toBe(newer);
    expect(reduce(newer, event(first, "cancelled", 1, { operation: "open" }))).toBe(newer);
    expect(reduce(newer, event(newer, "accepted", 2)).accepted?.attempt).toBe(2);
  });

  it("does not reinstall an attached result on duplicate opening or replay its ignored attempt later", () => {
    const state = exported(saved(accepted())), duplicate = reduce(state, event(state, "queued", 4, { operation: "open" }));
    expect(duplicate.pending).toBeUndefined(); expect(duplicate.accepted).toEqual(state.accepted);
    expect(duplicate.saved).toEqual(state.saved); expect(duplicate.exports).toEqual(state.exports);
    expect(duplicate.latestAttempt).toBe(4);
    expect(projectTaskDocumentSession(duplicate).counters).toEqual(projectTaskDocumentSession(state).counters);
    const released = reduce(duplicate, { type: "released", origin: duplicate.origin, workspaceRoot: duplicate.origin.workspaceRoot, snapshot: duplicate.current });
    expect(reduce(released, event(released, "queued", 4, { operation: "open" }))).toBe(released);
    expect(reduce(released, event(released, "accepted", 4))).toBe(released);
    expect(accepted(released, 5).editorAttached).toBe(true);
  });

  it("invalidates prior saves/files and pending callbacks after editing, even if content is later reverted", () => {
    const state = exported(saved(accepted())), queued = reduce(state, event(state, "queued", 4, { operation: "export", format: "docx" }));
    const edited = changed(queued), projection = projectTaskDocumentSession(edited);
    expect(projection).toMatchObject({ phase: "changed", acceptedForOrigin: true, acceptedCurrent: false, savedCurrent: false, exportedCurrent: false, changedSinceAcceptance: true, hasUnsavedChanges: true, hasStaleExports: true });
    expect(edited.pending).toBeUndefined();
    expect(reduce(edited, event(queued, "exported", 4, { format: "docx", outputPath: "/private/tmp/offer.docx", outputBytes: 128, sha256: "a".repeat(64) }))).toBe(edited);
    const reverted = changed(edited, state.current.fingerprint);
    expect(projectTaskDocumentSession(reverted)).toMatchObject({ savedCurrent: false, exportedCurrent: false, hasStaleExports: true });
    expect(projectTaskDocumentSession(exported(saved(reverted)))).toMatchObject({ savedCurrent: true, exportedCurrent: true, semanticReadiness: "separate-gate" });
  });

  it("does not accept old fingerprints, nonincreasing revisions, wrong operations or extended event shapes", () => {
    const state = accepted(), queued = reduce(state, event(state, "queued", 2, { operation: "save", recordId: "record-1" }));
    const bad = [event(queued, "saved", 2, { recordId: "record-1", snapshot: { ...queued.current, fingerprint: "other" } }), event(queued, "saved", 2, { recordId: "record-1", snapshot: { ...queued.current, revision: queued.current.revision + 1 } }), event(queued, "accepted", 2), event(queued, "cancelled", 2, { operation: "export" }), event(queued, "saved", 2, { recordId: "record-1", semanticReady: true })];
    for (const callback of bad) expect(reduce(queued, callback)).toBe(queued);
    for (const next of [{ ...queued.current }, { revision: queued.current.revision - 1, fingerprint: "other" }]) expect(reduce(queued, { type: "changed", origin: queued.origin, workspaceRoot: queued.origin.workspaceRoot, previous: queued.current, next })).toBe(queued);
  });

  it("ignores successful-looking late callbacks after the editor released the origin", () => {
    const state = accepted(), queued = reduce(state, event(state, "queued", 2, { operation: "save", recordId: "record-1" }));
    const released = reduce(queued, { type: "released", origin: queued.origin, workspaceRoot: queued.origin.workspaceRoot, snapshot: queued.current });
    expect(released.editorAttached).toBe(false); expect(released.pending).toBeUndefined();
    expect(reduce(released, event(queued, "saved", 2, { recordId: "record-1" }))).toBe(released);
    expect(projectTaskDocumentSession(released).savedCurrent).toBe(false);
  });

  it("preserves a failed operation as failure, not acceptance or successful persistence", () => {
    const state = accepted(), queued = reduce(state, event(state, "queued", 2, { operation: "save", recordId: "record-1" }));
    const failed = reduce(queued, event(queued, "failed", 2, { operation: "save", message: "Нет доступа к рабочей папке" }));
    expect(projectTaskDocumentSession(failed)).toMatchObject({ phase: "failed", savedCurrent: false, exportedCurrent: false });
    expect(failed.lastTransition.message).toContain("Нет доступа");
    expect(reduce(failed, event(failed, "saved", 2, { recordId: "record-1" }))).toBe(failed);
  });

  it("keeps state, nested receipts, snapshots and projections immutable without changing proposal data", () => {
    const state = exported(saved(accepted())), before = structuredClone(state), projection = projectTaskDocumentSession(state);
    for (const value of [state, state.origin, state.current, state.accepted, state.accepted?.snapshot, state.saved, state.exports, state.exports.pdf, projection, projection.currentExports, projection.counters]) expect(Object.isFrozen(value)).toBe(true);
    expect(reduce(state, { unrelated: true })).toBe(state);
    expect(state).toEqual(before);
    expect(Object.keys(state)).not.toContain("data");
  });
});
