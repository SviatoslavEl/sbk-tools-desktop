import { createTaskDocumentOrigin, createTaskDocumentSession, reduceTaskDocumentSession, taskDocumentOriginKey, type TaskDocumentOrigin, type TaskDocumentOperation, type TaskDocumentExportFormat, type TaskDocumentSession, type TaskDocumentSnapshot, type TaskDocumentSessionEvent } from "../intelligence/taskDocumentSession";
import type { ProposalData, ProposalStatus } from "./types";

/** Same semantic JSON after a Rust/serde save has the same fingerprint. Array
 * order and every persisted value still participate; this is not a price hash. */
export function proposalTaskFingerprint(data: ProposalData): string {
    return JSON.stringify(data, (_key, value: unknown) => value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : value);
}
export interface ProposalTaskEditorBinding {
    readonly data: ProposalData;
    readonly writeId: string;
    readonly recordId?: string;
    readonly draftKey: string;
    readonly savedJson: string;
    readonly local: boolean;
    readonly persistedStatus: ProposalStatus;
}
export interface ProposalTaskSessionChange {
    readonly session: TaskDocumentSession;
    readonly data: Readonly<ProposalData>;
    readonly writeId: string;
    readonly recordId?: string;
}
export interface ProposalTaskEntry extends ProposalTaskEditorBinding { readonly session: TaskDocumentSession }
export interface ProposalTaskAttempt {
    readonly origin: TaskDocumentOrigin;
    readonly operation: TaskDocumentOperation;
    readonly attempt: number;
    readonly snapshot: TaskDocumentSnapshot;
    readonly recordId?: string;
    readonly format?: TaskDocumentExportFormat;
}
type Completion = { type: "accepted" } | { type: "saved"; recordId: string }
    | { type: "exported"; format: TaskDocumentExportFormat; outputPath: string; outputBytes: number; sha256: string }
    | { type: "cancelled"; reason?: string } | { type: "failed"; message: string };

/** One receiver-owned in-memory entry per full origin. This does not persist an
 * AI task, grant workspace access, or approve the document's semantics. */
export class ProposalTaskBridge {
    private readonly entries = new Map<string, ProposalTaskEntry>();
    get(origin: TaskDocumentOrigin): ProposalTaskEntry | undefined { return this.entries.get(taskDocumentOriginKey(origin)); }
    ensure(origin: TaskDocumentOrigin, binding: ProposalTaskEditorBinding): ProposalTaskEntry {
        const immutable = createTaskDocumentOrigin(origin), key = taskDocumentOriginKey(immutable);
        const previous = this.entries.get(key);
        if (previous) return previous;
        const entry = { ...binding, data: structuredClone(binding.data), session: createTaskDocumentSession(immutable, proposalTaskFingerprint(binding.data)) };
        this.entries.set(key, entry); return entry;
    }
    update(origin: TaskDocumentOrigin, binding: ProposalTaskEditorBinding, workspaceRoot: string): ProposalTaskEntry | undefined {
        const previous = this.get(origin);
        if (!previous || workspaceRoot !== previous.session.origin.workspaceRoot) return previous;
        const fingerprint = proposalTaskFingerprint(binding.data);
        const session = fingerprint === previous.session.current.fingerprint ? previous.session : reduceTaskDocumentSession(previous.session, {
            type: "changed", origin, workspaceRoot, previous: previous.session.current,
            next: { revision: previous.session.current.revision + 1, fingerprint },
        });
        const next = { ...binding, data: structuredClone(binding.data), session };
        this.entries.set(session.originKey, next); return next;
    }
    queue(origin: TaskDocumentOrigin, operation: TaskDocumentOperation, workspaceRoot: string, format?: TaskDocumentExportFormat): ProposalTaskAttempt | undefined {
        const entry = this.get(origin);
        if (!entry || workspaceRoot !== entry.session.origin.workspaceRoot) return undefined;
        const ticket: ProposalTaskAttempt = { origin: entry.session.origin, operation, attempt: entry.session.latestAttempt + 1, snapshot: entry.session.current,
            ...(operation === "save" ? { recordId: entry.recordId || entry.writeId } : {}), ...(operation === "export" ? { format } : {}) };
        const session = reduceTaskDocumentSession(entry.session, { type: "queued", ...ticket, workspaceRoot });
        if (session === entry.session) return undefined;
        this.entries.set(session.originKey, { ...entry, session }); return ticket;
    }
    finish(ticket: ProposalTaskAttempt, completion: Completion, workspaceRoot: string): ProposalTaskEntry | undefined {
        const entry = this.get(ticket.origin);
        if (!entry) return undefined;
        const { operation, recordId: _recordId, format: _format, ...owner } = ticket;
        const event = { ...owner, workspaceRoot, ...completion,
            ...(completion.type === "cancelled" || completion.type === "failed" ? { operation } : {}) } as TaskDocumentSessionEvent;
        const session = reduceTaskDocumentSession(entry.session, event);
        if (session === entry.session) return undefined;
        const next = { ...entry, session }; this.entries.set(session.originKey, next); return next;
    }
    release(origin: TaskDocumentOrigin, workspaceRoot: string): ProposalTaskEntry | undefined {
        const entry = this.get(origin); if (!entry) return undefined;
        const session = reduceTaskDocumentSession(entry.session, { type: "released", origin, workspaceRoot, snapshot: entry.session.current });
        if (session === entry.session) return undefined;
        const next = { ...entry, session }; this.entries.set(session.originKey, next); return next;
    }
}
