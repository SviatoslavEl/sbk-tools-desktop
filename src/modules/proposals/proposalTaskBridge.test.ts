import { describe, expect, it } from "vitest";
import { createTaskDocumentOrigin, projectTaskDocumentSession } from "../intelligence/taskDocumentSession";
import { createProposal } from "./defaults";
import { ProposalTaskBridge, proposalTaskFingerprint, type ProposalTaskEditorBinding } from "./proposalTaskBridge";

const root = "/tmp/task-workspace";
const origin = (resultId = "proposal-1") => createTaskDocumentOrigin({ taskId: "task-1", resultId, workspaceRoot: root, sourceSnapshotKey: "sha256:abc", baseResultRevision: 2 });
const binding = (title = "Предмет"): ProposalTaskEditorBinding => ({ data: { ...createProposal(), title }, writeId: "stable-write-id", draftKey: "task-document:v1:synthetic-key", savedJson: "", local: false, persistedStatus: "draft" });
function attached() {
    const bridge = new ProposalTaskBridge(), owner = origin();
    bridge.ensure(owner, binding());
    const ticket = bridge.queue(owner, "open", root)!;
    bridge.finish(ticket, { type: "accepted" }, root);
    return { bridge, owner };
}
describe("proposal task receiver bridge", () => {
    it("fingerprints the entire proposal independently of object key ordering but preserves array ordering and values", () => {
        const data = binding().data;
        const sorted = JSON.parse(JSON.stringify(data, (_key, value) => value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort().reverse()) : value));
        expect(proposalTaskFingerprint(sorted)).toBe(proposalTaskFingerprint(data));
        for (const field of ["title", "paymentTerms", "internalNote", "deliveryTerms"] as const) expect(proposalTaskFingerprint({ ...data, [field]: `${data[field]} изменено` })).not.toBe(proposalTaskFingerprint(data));
        const two = { ...data, lines: [...data.lines, { ...data.lines[0], id: "second", title: "Другая позиция" }] };
        expect(proposalTaskFingerprint({ ...two, lines: [...two.lines].reverse() })).not.toBe(proposalTaskFingerprint(two));
    });
    it("queue is not acceptance and carries the right result's data", () => {
        const bridge = new ProposalTaskBridge(), a = origin("A"), b = origin("B");
        bridge.ensure(a, binding("Документ A")); bridge.ensure(b, { ...binding("Документ B"), writeId: "B-owner" });
        const ticket = bridge.queue(b, "open", root)!;
        const pending = bridge.get(b)!;
        expect(pending.data.title).toBe("Документ B"); expect(projectTaskDocumentSession(pending.session).acceptedForOrigin).toBe(false);
        bridge.finish(ticket, { type: "cancelled", reason: "Оставить A" }, root);
        expect(bridge.get(a)!.data.title).toBe("Документ A"); expect(bridge.get(b)!.session.lastTransition.phase).toBe("cancelled");
    });
    it("does not reseed a known result or allocate another write ID", () => {
        const { bridge, owner } = attached(), first = bridge.get(owner)!;
        bridge.ensure(owner, { ...binding("Подменяющий seed"), writeId: "new-owner" });
        expect(bridge.get(owner)).toBe(first);
        bridge.queue(owner, "open", root);
        expect(bridge.get(owner)!.writeId).toBe("stable-write-id");
        expect(bridge.get(owner)!.session.editorAttached).toBe(true);
    });
    it("save and export receipts follow real completions; edits stale old receipts including edit-and-revert", () => {
        const { bridge, owner } = attached();
        const save = bridge.queue(owner, "save", root)!;
        expect(projectTaskDocumentSession(bridge.get(owner)!.session).savedCurrent).toBe(false);
        bridge.finish(save, { type: "saved", recordId: "stable-write-id" }, root);
        const exportTicket = bridge.queue(owner, "export", root, "docx")!;
        bridge.finish(exportTicket, { type: "exported", format: "docx", outputPath: "/tmp/result.docx", outputBytes: 123, sha256: "a".repeat(64) }, root);
        const original = bridge.get(owner)!;
        expect(projectTaskDocumentSession(original.session)).toMatchObject({ savedCurrent: true, exportedCurrent: true, semanticReadiness: "separate-gate" });
        bridge.update(owner, { ...original, data: { ...original.data, title: "Изменено" } }, root);
        expect(projectTaskDocumentSession(bridge.get(owner)!.session)).toMatchObject({ savedCurrent: false, exportedCurrent: false, hasStaleExports: true });
        bridge.update(owner, original, root);
        expect(bridge.get(owner)!.session.current.fingerprint).toBe(original.session.current.fingerprint);
        expect(projectTaskDocumentSession(bridge.get(owner)!.session).savedCurrent).toBe(false);
    });
    it("rejects stale/wrong workspace/record/format completions and leaves receipts absent", () => {
        const { bridge, owner } = attached();
        const save = bridge.queue(owner, "save", root)!;
        expect(bridge.finish(save, { type: "saved", recordId: "foreign-record" }, root)).toBeUndefined();
        expect(bridge.finish(save, { type: "saved", recordId: "stable-write-id" }, "/tmp/other")).toBeUndefined();
        const entry = bridge.get(owner)!;
        bridge.update(owner, { ...entry, data: { ...entry.data, title: "Поздняя правка" } }, root);
        expect(bridge.finish(save, { type: "saved", recordId: "stable-write-id" }, root)).toBeUndefined();
        const exportTicket = bridge.queue(owner, "export", root, "pdf")!;
        expect(bridge.finish(exportTicket, { type: "exported", format: "docx", outputPath: "/tmp/x.docx", outputBytes: 1, sha256: "a".repeat(64) }, root)).toBeUndefined();
        expect(projectTaskDocumentSession(bridge.get(owner)!.session)).toMatchObject({ savedCurrent: false, exportedCurrent: false });
    });
    it("never treats cancellation, failure or malformed render receipts as a completed export", () => {
        const { bridge, owner } = attached();
        const first = bridge.queue(owner, "export", root, "pdf")!;
        bridge.finish(first, { type: "cancelled" }, root);
        const second = bridge.queue(owner, "export", root, "pdf")!;
        bridge.finish(second, { type: "failed", message: "Генератор недоступен" }, root);
        const third = bridge.queue(owner, "export", root, "pdf")!;
        expect(bridge.finish(third, { type: "exported", format: "pdf", outputPath: "relative.pdf", outputBytes: 0, sha256: "bad" }, root)).toBeUndefined();
        expect(projectTaskDocumentSession(bridge.get(owner)!.session).exportedCurrent).toBe(false);
    });
    it("release keeps the edited snapshot and saved binding for an explicit later reopen", () => {
        const { bridge, owner } = attached();
        const entry = bridge.get(owner)!;
        bridge.update(owner, { ...entry, recordId: "stable-write-id", data: { ...entry.data, title: "Правка" } }, root);
        bridge.release(owner, root);
        expect(bridge.get(owner)!).toMatchObject({ recordId: "stable-write-id", writeId: "stable-write-id", data: { title: "Правка" }, session: { editorAttached: false } });
        const reopen = bridge.queue(owner, "open", root)!;
        bridge.finish(reopen, { type: "accepted" }, root);
        expect(bridge.get(owner)!.session.editorAttached).toBe(true);
        expect(bridge.get(owner)!.session.current.revision).toBe(3);
    });
    it("clones caller data so later seed/consumer mutations cannot alter an origin's owned snapshot", () => {
        const bridge = new ProposalTaskBridge(), owner = origin(), data = binding();
        bridge.ensure(owner, data); data.data.title = "Мутация исходного seed";
        expect(bridge.get(owner)!.data.title).toBe("Предмет");
        const copy = structuredClone(bridge.get(owner)!.data); copy.title = "Мутация получателя";
        expect(bridge.get(owner)!.data.title).toBe("Предмет");
    });
});
