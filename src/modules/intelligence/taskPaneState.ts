import { proposalTaskFingerprint, type ProposalTaskSessionChange } from "../proposals/proposalTaskBridge";
import { createTaskDocumentOrigin, isTaskDocumentOrigin, projectTaskDocumentSession, sameTaskDocumentOrigin, taskDocumentOriginKey, TASK_DOCUMENT_SESSION_LIMITS, type TaskDocumentAcceptance, type TaskDocumentOrigin, type TaskDocumentSession } from "./taskDocumentSession";

/** Routing/projection only. The single existing proposal editor owns document
 * data; a request never installs a seed or approves semantic completeness. */
export interface TaskPaneReceiverSnapshot extends ProposalTaskSessionChange {}
export interface TaskPaneState {
  readonly workspaceRoot: string | null;
  readonly visibility: "results" | "document";
  readonly requestedOrigin?: TaskDocumentOrigin;
  readonly pendingOrigin?: TaskDocumentOrigin;
  readonly openedOrigin?: TaskDocumentOrigin;
  readonly receivers: readonly TaskPaneReceiverSnapshot[];
}
export type TaskPaneEvent =
  | { readonly type: "request"; readonly origin: TaskDocumentOrigin }
  | { readonly type: "receiver-change"; readonly workspaceRoot: string; readonly change: ProposalTaskSessionChange }
  | { readonly type: "handoff-consumed"; readonly origin: TaskDocumentOrigin }
  | { readonly type: "return-results" }
  | { readonly type: "workspace-changed"; readonly workspaceRoot: string | null };
export interface TaskPaneProjection {
  readonly visibility: TaskPaneState["visibility"];
  readonly requestedOrigin?: TaskDocumentOrigin;
  readonly pendingOrigin?: TaskDocumentOrigin;
  readonly openedOrigin?: TaskDocumentOrigin;
  readonly requested?: TaskPaneReceiverSnapshot;
  readonly pending?: TaskPaneReceiverSnapshot;
  readonly opened?: TaskPaneReceiverSnapshot;
  readonly semanticReadiness: "separate-gate";
}

const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const identifier = (value: unknown): value is string => typeof value === "string" && value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(value);
const fingerprint = (value: unknown): value is string => typeof value === "string" && Boolean(value.trim()) && value.length <= TASK_DOCUMENT_SESSION_LIMITS.fingerprint;
const sameSnapshot = (left: TaskDocumentAcceptance["snapshot"], right: TaskDocumentAcceptance["snapshot"]) => left.revision === right.revision && left.fingerprint === right.fingerprint;
const formats = ["docx", "pdf", "zip"] as const;
const phases = ["idle", "queued", "accepted", "changed", "saved", "exported", "cancelled", "failed", "released"];
function validRoot(root: unknown): root is string {
  return isTaskDocumentOrigin({ taskId: "pane", resultId: "pane", workspaceRoot: root, sourceSnapshotKey: "pane-v1", baseResultRevision: 0 });
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
const receiver = (state: TaskPaneState, origin?: TaskDocumentOrigin) => origin ? state.receivers.find((entry) => sameTaskDocumentOrigin(entry.session.origin, origin)) : undefined;
function seal(value: TaskPaneState): TaskPaneState { return Object.freeze({ ...value, receivers: Object.freeze([...value.receivers]) }); }
export function createTaskPaneState(workspaceRoot: string | null): TaskPaneState {
  if (workspaceRoot === "") workspaceRoot = null;
  if (workspaceRoot !== null && !validRoot(workspaceRoot)) throw new Error("Некорректная рабочая папка панели задачи.");
  return seal({ workspaceRoot, visibility: "results", receivers: [] });
}

function validReceipt(value: unknown, session: TaskDocumentSession): value is TaskDocumentAcceptance {
  if (!object(value) || !integer(value.attempt) || value.attempt === 0 || value.attempt > session.latestAttempt || !object(value.snapshot)) return false;
  const snap = value.snapshot;
  return integer(snap.revision) && snap.revision >= session.origin.baseResultRevision && snap.revision <= session.current.revision && fingerprint(snap.fingerprint)
    && (snap.revision !== session.current.revision || snap.fingerprint === session.current.fingerprint);
}
/** Callback data must describe exactly the receiver's current proposal, not a
 * seed copied by App. This is an integrity check, not an authorization check. */
function validChange(value: unknown, root: string): value is ProposalTaskSessionChange {
  try {
    if (!object(value) || !identifier(value.writeId) || value.recordId !== undefined && value.recordId !== value.writeId || !object(value.data) || !object(value.session)) return false;
    const session = value.session as unknown as TaskDocumentSession;
    if (!isTaskDocumentOrigin(session.origin) || session.origin.workspaceRoot !== root || session.originKey !== taskDocumentOriginKey(session.origin)
      || !integer(session.latestAttempt) || typeof session.editorAttached !== "boolean" || !object(session.current) || !integer(session.current.revision) || session.current.revision < session.origin.baseResultRevision
      || !fingerprint(session.current.fingerprint) || session.current.fingerprint !== proposalTaskFingerprint(value.data as unknown as ProposalTaskSessionChange["data"])
      || !object(session.exports) || Object.keys(session.exports).some((format) => !formats.includes(format as typeof formats[number]))
      || !object(session.lastTransition) || !phases.includes(session.lastTransition.phase)) return false;
    if (session.accepted && !validReceipt(session.accepted, session) || session.editorAttached && !session.accepted) return false;
    if (session.saved && (!validReceipt(session.saved, session) || session.saved.recordId !== value.writeId || value.recordId !== value.writeId)) return false;
    if (session.pending && (!validReceipt(session.pending, session) || !sameSnapshot(session.pending.snapshot, session.current) || !["open", "save", "export"].includes(session.pending.operation))) return false;
    for (const format of formats) {
      const receipt = session.exports[format];
      if (receipt && (!validReceipt(receipt, session) || receipt.format !== format || !validRoot(receipt.outputPath) || !integer(receipt.outputBytes) || !receipt.outputBytes || !/^[a-f0-9]{64}$/u.test(receipt.sha256))) return false;
    }
    return true;
  } catch { return false; }
}
function receiptContinues(previous: TaskDocumentAcceptance | undefined, next: TaskDocumentAcceptance | undefined): boolean {
  return !previous || Boolean(next && (next.attempt > previous.attempt || next.attempt === previous.attempt && sameSnapshot(previous.snapshot, next.snapshot)));
}
function newer(previous: TaskPaneReceiverSnapshot, next: ProposalTaskSessionChange): boolean {
  const before = previous.session, after = next.session;
  if (previous.writeId !== next.writeId || previous.recordId && next.recordId !== previous.recordId || after.latestAttempt < before.latestAttempt || after.current.revision < before.current.revision
    || after.current.revision === before.current.revision && after.current.fingerprint !== before.current.fingerprint) return false;
  if (!receiptContinues(before.accepted, after.accepted) || !receiptContinues(before.saved, after.saved) || formats.some((format) => !receiptContinues(before.exports[format], after.exports[format]))) return false;
  if (after.accepted && (!before.accepted || after.accepted.attempt > before.accepted.attempt) && after.accepted.attempt <= before.latestAttempt
    && (before.pending?.operation !== "open" || before.pending.attempt !== after.accepted.attempt)) return false;
  // A completion/release cannot be undone by an older queued callback with the
  // same attempt; a released editor needs a fresh open attempt to reattach.
  if (!before.pending && after.pending && after.pending.attempt <= before.latestAttempt) return false;
  if (!before.editorAttached && after.editorAttached && after.latestAttempt <= before.latestAttempt && before.pending?.operation !== "open") return false;
  if (before.lastTransition.phase === "released" && after.latestAttempt === before.latestAttempt && after.current.revision === before.current.revision && after.lastTransition.phase !== "released") return false;
  return true;
}

/** Wrong-root/older callbacks are no-ops. A consumed handoff is transport only.
 * Leaving the tool is deliberately NOT a release/unload operation here. */
export function reduceTaskPaneState(state: TaskPaneState, event: TaskPaneEvent): TaskPaneState {
  if (event.type === "workspace-changed") {
    const root = event.workspaceRoot === "" ? null : event.workspaceRoot;
    if (root === state.workspaceRoot || root !== null && !validRoot(root)) return state;
    return createTaskPaneState(root);
  }
  if (event.type === "return-results") return state.visibility === "results" ? state : seal({ ...state, visibility: "results" });
  if (event.type === "handoff-consumed") return state;
  if (event.type === "request") {
    if (!isTaskDocumentOrigin(event.origin) || event.origin.workspaceRoot !== state.workspaceRoot) return state;
    const origin = createTaskDocumentOrigin(event.origin), existing = receiver(state, origin);
    const reuse = sameTaskDocumentOrigin(state.openedOrigin, origin) && existing?.session.editorAttached && existing.session.accepted && existing.session.pending?.operation !== "open";
    return seal({ ...state, visibility: "document", requestedOrigin: origin, pendingOrigin: reuse ? undefined : origin });
  }
  if (!state.workspaceRoot || event.workspaceRoot !== state.workspaceRoot || !validChange(event.change, state.workspaceRoot)) return state;
  const change = event.change, previous = receiver(state, change.session.origin);
  if (!previous && !sameTaskDocumentOrigin(state.requestedOrigin, change.session.origin) && !sameTaskDocumentOrigin(state.openedOrigin, change.session.origin)) return state;
  if (previous && !newer(previous, change)) return state;
  if (previous && JSON.stringify(previous) === JSON.stringify(change)) return state;
  const captured = freeze(structuredClone(change)), matchesPending = sameTaskDocumentOrigin(state.pendingOrigin, captured.session.origin);
  // A historical acknowledgement carried by a queued/focus notification is
  // not admission of this requested replacement. Only the fresh accepted
  // transition can replace opened A with pending B.
  const accepted = matchesPending && captured.session.editorAttached && captured.session.lastTransition.phase === "accepted"
    && captured.session.accepted?.attempt === captured.session.latestAttempt
    && captured.session.lastTransition.attempt === captured.session.accepted?.attempt && !captured.session.pending;
  const endedOpen = matchesPending && ["cancelled", "failed"].includes(captured.session.lastTransition.phase) && captured.session.lastTransition.operation === "open" && !captured.session.pending;
  return seal({ ...state, receivers: [...state.receivers.filter((entry) => !sameTaskDocumentOrigin(entry.session.origin, captured.session.origin)), captured],
    ...(accepted ? { openedOrigin: captured.session.origin, pendingOrigin: undefined } : {}),
    ...(endedOpen ? { pendingOrigin: undefined, visibility: "results" } : {}),
  });
}

export function projectTaskPaneState(state: TaskPaneState): TaskPaneProjection {
  return Object.freeze({ visibility: state.visibility, requestedOrigin: state.requestedOrigin, pendingOrigin: state.pendingOrigin, openedOrigin: state.openedOrigin,
    requested: receiver(state, state.requestedOrigin), pending: receiver(state, state.pendingOrigin), opened: receiver(state, state.openedOrigin), semanticReadiness: "separate-gate" });
}

/** Convenience projection for an individual receiver; never package readiness. */
export const taskPaneDocumentProgress = (entry: TaskPaneReceiverSnapshot) => projectTaskDocumentSession(entry.session);
