import { describe, expect, it } from "vitest";
import { createProposal } from "../proposals/defaults";
import { ProposalTaskBridge, type ProposalTaskSessionChange } from "../proposals/proposalTaskBridge";
import { createTaskDocumentOrigin, type TaskDocumentOrigin } from "./taskDocumentSession";
import { createTaskPaneState, projectTaskPaneState, reduceTaskPaneState, taskPaneDocumentProgress, type TaskPaneState } from "./taskPaneState";

const root = "/private/tmp/task-pane-qa";
const origin = (resultId = "A", patch: Partial<TaskDocumentOrigin> = {}) => createTaskDocumentOrigin({ taskId: "task-1", resultId, workspaceRoot: root, sourceSnapshotKey: "sha256:sources-1", baseResultRevision: 2, ...patch });
const request = (state: TaskPaneState, owner = origin()) => reduceTaskPaneState(state, { type: "request", origin: owner });
function fixture(owner = origin()) {
  const bridge = new ProposalTaskBridge(), data = { ...createProposal(new Date(2035, 0, 1)), title: `Документ ${owner.resultId}` };
  bridge.ensure(owner, { data, writeId: `write-${owner.resultId}`, draftKey: "task-document:v1:fixture", savedJson: "", local: false, persistedStatus: "draft" });
  const change = (): ProposalTaskSessionChange => { const entry = bridge.get(owner)!; return { session: entry.session, data: entry.data, writeId: entry.writeId, ...(entry.recordId ? { recordId: entry.recordId } : {}) }; };
  const apply = (state: TaskPaneState, value = change(), currentRoot = root) => reduceTaskPaneState(state, { type: "receiver-change", workspaceRoot: currentRoot, change: value });
  const queue = () => bridge.queue(owner, "open", owner.workspaceRoot)!;
  const accept = () => { const ticket = queue(); bridge.finish(ticket, { type: "accepted" }, owner.workspaceRoot); return change(); };
  const edit = (title: string) => { const entry = bridge.get(owner)!; bridge.update(owner, { ...entry, data: { ...entry.data, title } }, owner.workspaceRoot); return change(); };
  return { bridge, owner, change, apply, queue, accept, edit };
}
function opened() {
  const a = fixture(), state = a.apply(request(createTaskPaneState(root)), a.accept());
  return { a, state };
}

describe("task pane routing, not editor admission or semantic approval", () => {
  it("starts closed without a workspace and rejects requests until a valid workspace is bound", () => {
    for (const closed of [createTaskPaneState(null), createTaskPaneState("")]) {
      expect(request(closed)).toBe(closed); expect(projectTaskPaneState(closed)).toMatchObject({ visibility: "results", semanticReadiness: "separate-gate" });
      const bound = reduceTaskPaneState(closed, { type: "workspace-changed", workspaceRoot: root });
      expect(request(bound).pendingOrigin).toEqual(origin());
    }
    expect(() => createTaskPaneState("relative")).toThrow();
  });
  it("shows the one editor immediately while B is requested/queued, but retains accepted A as opened", () => {
    const { a, state } = opened(), b = fixture(origin("B")), requested = request(state, b.owner);
    expect(projectTaskPaneState(requested)).toMatchObject({ visibility: "document", requestedOrigin: b.owner, pendingOrigin: b.owner, openedOrigin: a.owner });
    b.queue(); const queued = b.apply(requested);
    expect(projectTaskPaneState(queued).opened?.data.title).toBe("Документ A");
    expect(projectTaskPaneState(queued).pending?.data.title).toBe("Документ B");
    expect(taskPaneDocumentProgress(projectTaskPaneState(queued).pending!).acceptedForOrigin).toBe(false);
    const consumed = reduceTaskPaneState(queued, { type: "handoff-consumed", origin: b.owner });
    expect(consumed).toBe(queued); expect(consumed.openedOrigin).toEqual(a.owner);
  });
  it("only receiver acceptance of the exact pending origin opens B", () => {
    const { state } = opened(), b = fixture(origin("B"));
    const queued = b.queue(); let next = b.apply(request(state, b.owner));
    b.bridge.finish(queued, { type: "accepted" }, root); next = b.apply(next);
    expect(projectTaskPaneState(next)).toMatchObject({ openedOrigin: b.owner, pendingOrigin: undefined, visibility: "document" });
    expect(projectTaskPaneState(next).opened?.writeId).toBe("write-B");
  });
  it.each(["cancelled", "failed"] as const)("%s queued B returns to results, retains A and never accepts B", (type) => {
    const { a, state } = opened(), b = fixture(origin("B")), ticket = b.queue();
    let next = b.apply(request(state, b.owner));
    b.bridge.finish(ticket, type === "failed" ? { type, message: "Открытие не завершено" } : { type }, root); next = b.apply(next);
    expect(projectTaskPaneState(next)).toMatchObject({ visibility: "results", openedOrigin: a.owner, requestedOrigin: b.owner, pendingOrigin: undefined });
    expect(projectTaskPaneState(next).opened?.data.title).toBe("Документ A");
    expect(taskPaneDocumentProgress(next.receivers.find((entry) => entry.session.origin.resultId === "B")!).acceptedForOrigin).toBe(false);
  });
  it("return-results changes visibility only, and reopening the same attached origin is nondestructive", () => {
    const { a, state } = opened(), hidden = reduceTaskPaneState(state, { type: "return-results" });
    expect(hidden.receivers).toEqual(state.receivers); expect(hidden.openedOrigin).toBe(state.openedOrigin);
    const returned = request(hidden, a.owner);
    expect(returned.visibility).toBe("document"); expect(returned.pendingOrigin).toBeUndefined();
    expect(returned.receivers).toEqual(state.receivers); expect(projectTaskPaneState(returned).opened?.writeId).toBe("write-A");
    // Tool navigation needs no reducer event: retaining this state does not
    // detach or unmount the receiver. No synthetic tool-leave release exists.
    expect(state.receivers[0].session.editorAttached).toBe(true);
  });
  it("a late valid callback never changes visibility back after return-results", () => {
    const a = fixture(), ticket = a.queue(); let state = a.apply(request(createTaskPaneState(root)));
    state = reduceTaskPaneState(state, { type: "return-results" });
    a.bridge.finish(ticket, { type: "accepted" }, root); state = a.apply(state);
    expect(state.openedOrigin).toEqual(a.owner); expect(state.visibility).toBe("results");
  });
  it("workspace changes clear intent, opened origin and projections, and late callbacks cannot repopulate them", () => {
    const { a, state } = opened(), changed = reduceTaskPaneState(state, { type: "workspace-changed", workspaceRoot: "/private/tmp/other-qa" });
    expect(changed).toMatchObject({ visibility: "results", receivers: [] }); expect(changed.openedOrigin).toBeUndefined();
    expect(a.apply(changed)).toBe(changed); expect(a.apply(state, a.change(), "/private/tmp/other-qa")).toBe(state);
    expect(reduceTaskPaneState(state, { type: "workspace-changed", workspaceRoot: "" }).workspaceRoot).toBeNull();
  });
  it("does not display an unrequested other result and never confuses any component of a full origin", () => {
    const a = fixture(), waiting = request(createTaskPaneState(root));
    for (const patch of [{ taskId: "task-2" }, { resultId: "B" }, { workspaceRoot: "/private/tmp/other-qa" }, { sourceSnapshotKey: "sha256:other" }, { baseResultRevision: 3 }]) {
      const foreign = fixture(origin("A", patch)); expect(foreign.apply(waiting, foreign.accept())).toBe(waiting);
    }
    const requestedB = request(waiting, origin("B")); expect(a.apply(requestedB, a.accept())).toBe(requestedB);
  });
});

describe("task pane callback races and integrity", () => {
  it("ignores an older open attempt, queued-after-accepted and accepted-after-cancelled callback", () => {
    const a = fixture(), first = a.queue(), oldQueued = a.change();
    let state = a.apply(request(createTaskPaneState(root))), second = a.queue(); state = a.apply(state);
    expect(a.apply(state, oldQueued)).toBe(state);
    a.bridge.finish(second, { type: "accepted" }, root); const accepted = a.change(); state = a.apply(state);
    expect(a.apply(state, oldQueued)).toBe(state);
    expect(first.attempt).toBeLessThan(second.attempt);
    const b = fixture(origin("B")), attempt = b.queue(); let pending = b.apply(request(state, b.owner));
    const simulatedAccepted = structuredClone(b.change());
    b.bridge.finish(attempt, { type: "accepted" }, root); Object.assign(simulatedAccepted, b.change());
    const cancelledSession = { ...simulatedAccepted.session, accepted: undefined, editorAttached: false, lastTransition: { phase: "cancelled" as const, operation: "open" as const, attempt: attempt.attempt } };
    pending = b.apply(pending, { ...simulatedAccepted, session: cancelledSession });
    expect(b.apply(pending, simulatedAccepted)).toBe(pending); expect(pending.openedOrigin).toEqual(a.owner);
    expect(accepted.session.accepted).toBeDefined();
  });
  it("rejects a stale pre-release attachment until a newer open is actually acknowledged", () => {
    const { a, state } = opened(), attached = a.change();
    a.bridge.release(a.owner, root); const released = a.apply(state);
    expect(a.apply(released, attached)).toBe(released);
    const requested = request(released, a.owner); expect(requested.pendingOrigin).toEqual(a.owner);
    expect(projectTaskPaneState(a.apply(requested, a.accept())).pendingOrigin).toBeUndefined();
  });
  it("never treats a historical accepted receipt inside a duplicate focus notification as a fresh replacement", () => {
    const { a, state } = opened(), b = fixture(origin("B"));
    let next = b.apply(request(state, b.owner), b.accept());
    next = request(next, a.owner);
    // Receiver detach of A is deliberately delayed: open only consumes the
    // attempt floor while carrying A's historical accepted receipt.
    a.queue(); next = a.apply(next);
    expect(next.pendingOrigin).toEqual(a.owner); expect(next.openedOrigin).toEqual(b.owner);
    a.bridge.release(a.owner, root); next = a.apply(next);
    next = a.apply(next, a.accept());
    expect(next.pendingOrigin).toBeUndefined(); expect(next.openedOrigin).toEqual(a.owner);
  });
  it("accepts edits and edit-and-revert revisions, never regressing to old data or stale successful receipts", () => {
    const { a, state } = opened(), baseline = a.change();
    let next = a.apply(state, a.edit("Изменено"));
    next = a.apply(next, a.edit("Документ A"));
    expect(next.receivers[0].session.current.revision).toBe(baseline.session.current.revision + 2);
    expect(a.apply(next, baseline)).toBe(next); expect(next.receivers[0].data.title).toBe("Документ A");
  });
  it("cannot bind another record/write ID or proposal data to a receiver's snapshot", () => {
    const { a, state } = opened(), changed = structuredClone(a.change());
    expect(a.apply(state, { ...changed, writeId: "foreign-write" })).toBe(state);
    expect(a.apply(state, { ...changed, recordId: "foreign-record" })).toBe(state);
    expect(a.apply(state, { ...changed, data: { ...changed.data, title: "Подменённый seed" } })).toBe(state);
    expect(a.apply(state, { ...changed, session: { ...changed.session, originKey: "wrong" } })).toBe(state);
  });
  it("keeps per-result save/export progress separate from semantic readiness and cannot drop genuine receipts", () => {
    const { a, state } = opened(), old = a.change(), entry = a.bridge.get(a.owner)!;
    a.bridge.update(a.owner, { ...entry, recordId: entry.writeId }, root);
    const save = a.bridge.queue(a.owner, "save", root)!; a.bridge.finish(save, { type: "saved", recordId: entry.writeId }, root);
    let next = a.apply(state); const exported = a.bridge.queue(a.owner, "export", root, "pdf")!;
    a.bridge.finish(exported, { type: "exported", format: "pdf", outputPath: "/private/tmp/task-pane-qa/offer.pdf", outputBytes: 40, sha256: "a".repeat(64) }, root); next = a.apply(next);
    expect(taskPaneDocumentProgress(projectTaskPaneState(next).opened!)).toMatchObject({ savedCurrent: true, exportedCurrent: true, semanticReadiness: "separate-gate" });
    expect(projectTaskPaneState(next).semanticReadiness).toBe("separate-gate"); expect(a.apply(next, old)).toBe(next);
    const modified = a.apply(next, a.edit("Новая редакция")); expect(taskPaneDocumentProgress(projectTaskPaneState(modified).opened!)).toMatchObject({ savedCurrent: false, exportedCurrent: false, hasStaleExports: true });
  });
  it("captures immutable independent snapshots and does not reseed data on repeated request or duplicate callback", () => {
    const a = fixture(), callback = structuredClone(a.accept()), state = a.apply(request(createTaskPaneState(root)), callback), before = structuredClone(state);
    (callback.data as { title: string }).title = "Внешняя мутация";
    expect(state).toEqual(before);
    for (const value of [state, state.receivers, state.receivers[0], state.receivers[0].data, state.receivers[0].data.lines, state.receivers[0].session]) expect(Object.isFrozen(value)).toBe(true);
    expect(a.apply(state)).toBe(state); expect(request(state).receivers).toEqual(state.receivers);
  });
});
