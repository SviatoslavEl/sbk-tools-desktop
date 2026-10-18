/** In-memory receipts for ONE task result handled by the existing document
 * editor. This is not persistence, filesystem verification, semantic approval,
 * access control or permission to replace another editor's unsaved work. */
export interface TaskDocumentOrigin {
  readonly taskId: string;
  readonly resultId: string;
  readonly workspaceRoot: string;
  readonly sourceSnapshotKey: string;
  readonly baseResultRevision: number;
}
export interface TaskDocumentSnapshot { readonly revision: number; readonly fingerprint: string }
export type TaskDocumentOperation = "open" | "save" | "export";
export type TaskDocumentExportFormat = "docx" | "pdf" | "zip";
interface TaskDocumentEventOwner { readonly origin: TaskDocumentOrigin; readonly workspaceRoot: string }
interface TaskDocumentAttemptEvent extends TaskDocumentEventOwner { readonly attempt: number; readonly snapshot: TaskDocumentSnapshot }
export type TaskDocumentSessionEvent =
  | (TaskDocumentAttemptEvent & ({ readonly type: "queued"; readonly operation: "open" } | { readonly type: "queued"; readonly operation: "save"; readonly recordId: string } | { readonly type: "queued"; readonly operation: "export"; readonly format: TaskDocumentExportFormat }))
  | (TaskDocumentAttemptEvent & { readonly type: "accepted" })
  | (TaskDocumentAttemptEvent & { readonly type: "saved"; readonly recordId: string })
  | (TaskDocumentAttemptEvent & { readonly type: "exported"; readonly format: TaskDocumentExportFormat; readonly outputPath: string; readonly outputBytes: number; readonly sha256: string })
  | (TaskDocumentAttemptEvent & { readonly type: "cancelled"; readonly operation: TaskDocumentOperation; readonly reason?: string })
  | (TaskDocumentAttemptEvent & { readonly type: "failed"; readonly operation: TaskDocumentOperation; readonly message: string })
  | (TaskDocumentEventOwner & { readonly type: "changed"; readonly previous: TaskDocumentSnapshot; readonly next: TaskDocumentSnapshot })
  | (TaskDocumentEventOwner & { readonly type: "released"; readonly snapshot: TaskDocumentSnapshot });

export interface TaskDocumentAttempt { readonly operation: TaskDocumentOperation; readonly attempt: number; readonly snapshot: TaskDocumentSnapshot; readonly recordId?: string; readonly format?: TaskDocumentExportFormat }
export interface TaskDocumentAcceptance { readonly attempt: number; readonly snapshot: TaskDocumentSnapshot }
export interface TaskDocumentSaveReceipt extends TaskDocumentAcceptance { readonly recordId: string }
export interface TaskDocumentExportReceipt extends TaskDocumentAcceptance { readonly format: TaskDocumentExportFormat; readonly outputPath: string; readonly outputBytes: number; readonly sha256: string }
export interface TaskDocumentTransition { readonly phase: "idle" | "queued" | "accepted" | "changed" | "saved" | "exported" | "cancelled" | "failed" | "released"; readonly operation?: TaskDocumentOperation; readonly attempt?: number; readonly message?: string }
export interface TaskDocumentSession {
  readonly origin: TaskDocumentOrigin;
  readonly originKey: string;
  readonly current: TaskDocumentSnapshot;
  readonly latestAttempt: number;
  readonly editorAttached: boolean;
  readonly pending?: TaskDocumentAttempt;
  readonly accepted?: TaskDocumentAcceptance;
  readonly saved?: TaskDocumentSaveReceipt;
  readonly exports: Readonly<Partial<Record<TaskDocumentExportFormat, TaskDocumentExportReceipt>>>;
  readonly lastTransition: TaskDocumentTransition;
}
export interface TaskDocumentProjection {
  readonly originKey: string;
  readonly current: TaskDocumentSnapshot;
  readonly phase: TaskDocumentTransition["phase"];
  readonly pendingOperation?: TaskDocumentOperation;
  readonly editorAttached: boolean;
  /** Receiver acknowledgement for this origin, not for every later edit. */
  readonly acceptedForOrigin: boolean;
  readonly acceptedCurrent: boolean;
  readonly savedCurrent: boolean;
  readonly exportedCurrent: boolean;
  readonly changedSinceAcceptance: boolean;
  readonly hasUnsavedChanges: boolean;
  readonly hasStaleExports: boolean;
  readonly currentExports: readonly TaskDocumentExportReceipt[];
  readonly counters: Readonly<{ results: 1; queued: 0 | 1; accepted: 0 | 1; saved: 0 | 1; exported: 0 | 1 }>;
  /** Persisting a draft/card or producing a file must never approve content. */
  readonly semanticReadiness: "separate-gate";
}

export const TASK_DOCUMENT_SESSION_LIMITS = Object.freeze({ id: 128, sourceSnapshotKey: 256, path: 4096, fingerprint: 8 * 1024 * 1024, message: 2000, draftKeyBytes: 100 });
const originFields = ["taskId", "resultId", "workspaceRoot", "sourceSnapshotKey", "baseResultRevision"] as const;
const exportFormats: TaskDocumentExportFormat[] = ["docx", "pdf", "zip"];
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
const exactKeys = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) => required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const id = (value: unknown): value is string => typeof value === "string" && value.length <= TASK_DOCUMENT_SESSION_LIMITS.id && /^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(value);
const safeText = (value: unknown, limit: number): value is string => typeof value === "string" && Boolean(value.trim()) && value.length <= limit && !/[\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(value);
const sourceKey = (value: unknown): value is string => typeof value === "string" && value.length <= TASK_DOCUMENT_SESSION_LIMITS.sourceSnapshotKey && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value);

/** Exact workspace identity, not path canonicalization or authority to access
 * it. Callers must use the fresh backend workspace root without changing case
 * or resolving aliases themselves. POSIX, drive, UNC and verbatim UNC roots
 * remain distinct identities; relative/device/traversing paths are rejected. */
function absolutePath(value: unknown): value is string {
  if (!safeText(value, TASK_DOCUMENT_SESSION_LIMITS.path)) return false;
  let path = value;
  if (/^\\\\\?\\UNC\\/iu.test(path)) path = `\\\\${path.slice(8)}`;
  else if (/^\\\\\?\\[A-Za-z]:\\/u.test(path)) path = path.slice(4);
  else if (/^\\\\[?.]\\/u.test(path)) return false;
  let parts: string[];
  if (/^[A-Za-z]:[\\/]/u.test(path)) parts = path.slice(3).split(/[\\/]/u);
  else if (path.startsWith("\\\\") || path.startsWith("//")) {
    parts = path.slice(2).split(/[\\/]/u);
    if (parts.length < 2 || !parts[0] || !parts[1]) return false;
  } else if (path.startsWith("/")) parts = path.slice(1).split("/");
  else return false;
  if (parts[parts.length - 1] === "") parts.pop();
  return parts.every((part) => Boolean(part) && part !== "." && part !== "..");
}

export function isTaskDocumentOrigin(value: unknown): value is TaskDocumentOrigin {
  return object(value) && exactKeys(value, originFields) && id(value.taskId) && id(value.resultId) && absolutePath(value.workspaceRoot) && sourceKey(value.sourceSnapshotKey) && integer(value.baseResultRevision);
}
export function createTaskDocumentOrigin(value: unknown): TaskDocumentOrigin {
  if (!isTaskDocumentOrigin(value)) throw new Error("Некорректное происхождение документа задачи: нужны точные задача, результат, рабочая папка, снимок источников и базовая ревизия.");
  return Object.freeze({ taskId: value.taskId, resultId: value.resultId, workspaceRoot: value.workspaceRoot, sourceSnapshotKey: value.sourceSnapshotKey, baseResultRevision: value.baseResultRevision });
}
/** Lossless stable identity; never use an abbreviated display label for routing. */
export function taskDocumentOriginKey(value: TaskDocumentOrigin): string {
  const origin = createTaskDocumentOrigin(value);
  return JSON.stringify(["task-document-origin/1", origin.taskId, origin.resultId, origin.workspaceRoot, origin.sourceSnapshotKey, origin.baseResultRevision]);
}
export function sameTaskDocumentOrigin(first: unknown, second: unknown): boolean {
  return isTaskDocumentOrigin(first) && isTaskDocumentOrigin(second) && taskDocumentOriginKey(first) === taskDocumentOriginKey(second);
}
/** Fits the existing backend's 100-byte draft-key limit without embedding a
 * workspace path or truncating IDs. The stored envelope must still carry and
 * validate the full origin on restore. SHA-256 is a namespace, not permission. */
export async function taskDocumentDraftKey(origin: TaskDocumentOrigin): Promise<string> {
  const key = taskDocumentOriginKey(origin);
  if (typeof globalThis.crypto?.subtle?.digest !== "function") throw new Error("Без WebCrypto нельзя безопасно сформировать ключ черновика задачи.");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return `task-document:v1:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function validSnapshot(value: unknown, base: number): value is TaskDocumentSnapshot {
  return object(value) && exactKeys(value, ["revision", "fingerprint"]) && integer(value.revision) && value.revision >= base && safeText(value.fingerprint, TASK_DOCUMENT_SESSION_LIMITS.fingerprint);
}
const snapshot = (value: TaskDocumentSnapshot): TaskDocumentSnapshot => Object.freeze({ revision: value.revision, fingerprint: value.fingerprint });
const sameSnapshot = (first: TaskDocumentSnapshot, second: TaskDocumentSnapshot) => first.revision === second.revision && first.fingerprint === second.fingerprint;
function seal(value: TaskDocumentSession): TaskDocumentSession {
  return Object.freeze({ ...value, current: snapshot(value.current), ...(value.pending ? { pending: Object.freeze({ ...value.pending, snapshot: snapshot(value.pending.snapshot) }) } : {}), ...(value.accepted ? { accepted: Object.freeze({ ...value.accepted, snapshot: snapshot(value.accepted.snapshot) }) } : {}), ...(value.saved ? { saved: Object.freeze({ ...value.saved, snapshot: snapshot(value.saved.snapshot) }) } : {}), exports: Object.freeze(Object.fromEntries(Object.entries(value.exports).map(([format, receipt]) => [format, Object.freeze({ ...receipt, snapshot: snapshot(receipt.snapshot) })]))), lastTransition: Object.freeze({ ...value.lastTransition }) });
}
export function createTaskDocumentSession(origin: TaskDocumentOrigin, fingerprint: string): TaskDocumentSession {
  const immutable = createTaskDocumentOrigin(origin), initial = { revision: immutable.baseResultRevision, fingerprint };
  if (!validSnapshot(initial, immutable.baseResultRevision)) throw new Error("Некорректный отпечаток исходного результата задачи.");
  return seal({ origin: immutable, originKey: taskDocumentOriginKey(immutable), current: initial, latestAttempt: 0, editorAttached: false, exports: {}, lastTransition: { phase: "idle" } });
}

/** Wrong/stale events are no-ops. A queued handoff is not receiver acceptance,
 * a cancelled save dialog is not an export, and no event grants editor access.
 * `workspaceRoot` must be observed at callback time, not copied blindly from
 * the request. Attempt numbers are strictly increasing per origin/session. */
export function reduceTaskDocumentSession(state: TaskDocumentSession, event: unknown): TaskDocumentSession {
  if (!object(event) || !sameTaskDocumentOrigin(event.origin, state.origin) || event.workspaceRoot !== state.origin.workspaceRoot || typeof event.type !== "string") return state;
  const owner = ["type", "origin", "workspaceRoot"];
  if (event.type === "changed") {
    if (!exactKeys(event, [...owner, "previous", "next"]) || !validSnapshot(event.previous, state.origin.baseResultRevision) || !validSnapshot(event.next, state.origin.baseResultRevision) || !sameSnapshot(event.previous, state.current) || event.next.revision <= state.current.revision) return state;
    return seal({ ...state, current: event.next, pending: undefined, lastTransition: { phase: "changed" } });
  }
  if (event.type === "released") {
    if (!exactKeys(event, [...owner, "snapshot"]) || !validSnapshot(event.snapshot, state.origin.baseResultRevision) || !sameSnapshot(event.snapshot, state.current)) return state;
    return seal({ ...state, editorAttached: false, pending: undefined, lastTransition: { phase: "released" } });
  }
  if (!integer(event.attempt) || event.attempt === 0 || !validSnapshot(event.snapshot, state.origin.baseResultRevision) || !sameSnapshot(event.snapshot, state.current)) return state;
  const context = [...owner, "attempt", "snapshot"];
  if (event.type === "queued") {
    if (event.attempt <= state.latestAttempt || !["open", "save", "export"].includes(String(event.operation))) return state;
    const operation = event.operation as TaskDocumentOperation;
    const extra = operation === "save" ? ["recordId"] : operation === "export" ? ["format"] : [];
    if (!exactKeys(event, [...context, "operation", ...extra]) || operation === "save" && !id(event.recordId) || operation === "export" && !exportFormats.includes(event.format as TaskDocumentExportFormat)) return state;
    if (operation !== "open" && (!state.editorAttached || !state.accepted)) return state;
    // An already attached result is focused/reused by its controller, not
    // installed again. Consume the attempt floor to reject a later replay.
    if (operation === "open" && state.editorAttached && state.accepted) return seal({ ...state, latestAttempt: event.attempt });
    const pending: TaskDocumentAttempt = { operation, attempt: event.attempt, snapshot: event.snapshot, ...(operation === "save" ? { recordId: event.recordId as string } : {}), ...(operation === "export" ? { format: event.format as TaskDocumentExportFormat } : {}) };
    return seal({ ...state, latestAttempt: event.attempt, pending, lastTransition: { phase: "queued", operation, attempt: event.attempt } });
  }
  const pending = state.pending;
  if (!pending || event.attempt !== pending.attempt || !sameSnapshot(event.snapshot, pending.snapshot)) return state;
  if (event.type === "accepted") {
    if (!exactKeys(event, context) || pending.operation !== "open") return state;
    return seal({ ...state, pending: undefined, editorAttached: true, accepted: { attempt: event.attempt, snapshot: event.snapshot }, lastTransition: { phase: "accepted", operation: "open", attempt: event.attempt } });
  }
  if (event.type === "saved") {
    if (!exactKeys(event, [...context, "recordId"]) || pending.operation !== "save" || !id(event.recordId) || event.recordId !== pending.recordId || !state.editorAttached) return state;
    return seal({ ...state, pending: undefined, saved: { attempt: event.attempt, snapshot: event.snapshot, recordId: event.recordId }, lastTransition: { phase: "saved", operation: "save", attempt: event.attempt } });
  }
  if (event.type === "exported") {
    if (!exactKeys(event, [...context, "format", "outputPath", "outputBytes", "sha256"]) || pending.operation !== "export" || event.format !== pending.format || !absolutePath(event.outputPath) || !integer(event.outputBytes) || event.outputBytes === 0 || typeof event.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(event.sha256) || !state.editorAttached) return state;
    const format = event.format as TaskDocumentExportFormat;
    const receipt: TaskDocumentExportReceipt = { attempt: event.attempt, snapshot: event.snapshot, format, outputPath: event.outputPath, outputBytes: event.outputBytes, sha256: event.sha256 };
    return seal({ ...state, pending: undefined, exports: { ...state.exports, [format]: receipt }, lastTransition: { phase: "exported", operation: "export", attempt: event.attempt } });
  }
  if (event.type === "cancelled" || event.type === "failed") {
    const failed = event.type === "failed";
    if (!exactKeys(event, [...context, "operation", ...(failed ? ["message"] : [])], failed ? [] : ["reason"]) || event.operation !== pending.operation || failed && !safeText(event.message, TASK_DOCUMENT_SESSION_LIMITS.message) || !failed && event.reason !== undefined && !safeText(event.reason, TASK_DOCUMENT_SESSION_LIMITS.message)) return state;
    return seal({ ...state, pending: undefined, lastTransition: { phase: event.type, operation: pending.operation, attempt: event.attempt, ...(failed ? { message: event.message as string } : event.reason ? { message: event.reason as string } : {}) } });
  }
  return state;
}

/** Receipts describe observed operations for this one result. They do not
 * establish that a file still exists/unmodified or that the whole task/package
 * is complete. Edit-and-revert still needs a fresh save/export revision. */
export function projectTaskDocumentSession(state: TaskDocumentSession): TaskDocumentProjection {
  const acceptedForOrigin = Boolean(state.accepted), acceptedCurrent = Boolean(state.accepted && sameSnapshot(state.accepted.snapshot, state.current));
  const savedCurrent = Boolean(state.saved && sameSnapshot(state.saved.snapshot, state.current));
  const receipts = exportFormats.flatMap((format) => state.exports[format] ? [state.exports[format]!] : []);
  const currentExports = receipts.filter((receipt) => sameSnapshot(receipt.snapshot, state.current));
  return Object.freeze({ originKey: state.originKey, current: state.current, phase: state.lastTransition.phase, ...(state.pending ? { pendingOperation: state.pending.operation } : {}), editorAttached: state.editorAttached, acceptedForOrigin, acceptedCurrent, savedCurrent, exportedCurrent: currentExports.length > 0, changedSinceAcceptance: acceptedForOrigin && !acceptedCurrent, hasUnsavedChanges: acceptedForOrigin && !savedCurrent, hasStaleExports: receipts.some((receipt) => !sameSnapshot(receipt.snapshot, state.current)), currentExports: Object.freeze(currentExports), counters: Object.freeze({ results: 1, queued: state.pending ? 1 : 0, accepted: acceptedForOrigin ? 1 : 0, saved: savedCurrent ? 1 : 0, exported: currentExports.length ? 1 : 0 }), semanticReadiness: "separate-gate" });
}
