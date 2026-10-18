import { isValidElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProposalFinalReview } from "./ProposalFinalReview";
import { createProposal } from "./defaults";
import type { CommercialReadiness } from "./commercialDecisions";
import type { ProposalData } from "./types";

const runtime = vi.hoisted(() => ({ index: 0, changed: false, slots: [] as Array<{ value?: unknown; deps?: readonly unknown[]; cleanup?: () => void }>, effects: [] as Array<() => void>, readiness: vi.fn() }));
vi.mock("./commercialDecisions", () => ({ projectReadiness: runtime.readiness }));
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(),
  useState: (initial: unknown) => { const index = runtime.index++; if (!runtime.slots[index]) runtime.slots[index] = { value: typeof initial === "function" ? initial() : initial }; return [runtime.slots[index].value, (next: unknown) => { const value = typeof next === "function" ? next(runtime.slots[index].value) : next; if (!Object.is(value, runtime.slots[index].value)) { runtime.slots[index].value = value; runtime.changed = true; } }]; },
  useEffect: (effect: () => void | (() => void), deps: readonly unknown[]) => { const index = runtime.index++, old = runtime.slots[index]; if (old?.deps?.length === deps.length && old.deps.every((value, i) => Object.is(value, deps[i]))) return; runtime.slots[index] = { ...old, deps }; runtime.effects.push(() => { old?.cleanup?.(); const cleanup = effect(); runtime.slots[index].cleanup = typeof cleanup === "function" ? cleanup : undefined; }); },
}));
type Props = Parameters<typeof ProposalFinalReview>[0];
type NodeProps = { children?: ReactNode; onClick?: () => void; "data-commercial-review-question"?: string };
const nodes = (node: ReactNode): Array<{ type: unknown; props: NodeProps }> => Array.isArray(node) ? node.flatMap(nodes) : isValidElement<NodeProps>(node) ? [{ type: node.type, props: node.props }, ...nodes(node.props.children)] : [];
const text = (node: ReactNode): string => Array.isArray(node) ? node.map(text).join("") : isValidElement<NodeProps>(node) ? text(node.props.children) : typeof node === "string" || typeof node === "number" ? String(node) : "";
const fingerprint = `sha256:${"a".repeat(64)}` as const;
function fixture(count = 12): ProposalData {
  const value = createProposal();
  value.commercialDocument = { version: 1, revision: 1, body: { version: 1, sections: [{ id: "payment", kind: "payment", title: "Оплата", blocks: [{ id: "payment-block", kind: "paragraph", style: "body", content: [{ kind: "text", text: "5 дней" }] }] }] },
    privateAppendix: { version: 1, sourceSnapshotKey: fingerprint, documentId: "source-contract", extraction: { complete: true, requiresOcr: false, visualAssessment: "unassessed" }, containers: [], clauses: [], references: [], coverage: [] },
    questions: Array.from({ length: count }, (_, index) => ({ id: `question-${index}`, kind: "source-reference", sectionId: "payment", targetBlockIds: ["payment-block"], sourceClauseIds: [], sourceReferenceIds: [`reference-${index}`], message: "Одинаковый заголовок вопроса", material: true, dependencyFingerprint: fingerprint })), decisions: [] };
  return value;
}
function readiness(value: ProposalData): CommercialReadiness {
  return { canSaveDraft: true, canFinalize: false, issues: [], questions: value.commercialDocument!.questions.map(question => ({ question, sourceCurrent: true, dependencyFingerprint: fingerprint, status: "unresolved", issues: [] })), activeDecisionIds: [], staleDecisionIds: [] };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
let props: Props, tree: ReactNode;
function render(patch: Partial<Props> = {}) { props = { ...props, ...patch }; runtime.index = 0; runtime.changed = false; tree = ProposalFinalReview(props); for (const effect of runtime.effects.splice(0)) effect(); }
async function flush() { for (let i = 0; i < 20; i++) { await Promise.resolve(); if (runtime.changed) render(); } }
beforeEach(() => {
  runtime.slots.forEach(slot => slot.cleanup?.()); runtime.index = 0; runtime.changed = false; runtime.slots = []; runtime.effects = []; runtime.readiness.mockReset();
  runtime.readiness.mockImplementation(async (doc) => readiness({ ...fixture(), commercialDocument: doc }));
  props = { sessionKey: "A", value: fixture(), proposalIssueCount: 3, onOpenQuestion: vi.fn(), onOpenSection: vi.fn(), onOpenIssue: vi.fn() };
});

describe("final proposal question overview", () => {
  it("retains twelve same-caption question identities with individual destinations and separates warnings from zero decisions", async () => {
    const before = structuredClone(props.value); render(); await flush();
    const rows = nodes(tree).filter(node => node.props["data-commercial-review-question"]);
    expect(rows.map(row => row.props["data-commercial-review-question"])).toEqual(props.value.commercialDocument!.questions.map(question => question.id));
    expect(text(tree)).toContain("Замечаний к реквизитам и расчётам: 3. Открытых коммерческих вопросов: 12 из 12. Действующих применённых решений: 0.");
    for (const button of nodes(tree).filter(node => node.type === "button")) button.props.onClick!();
    expect(vi.mocked(props.onOpenQuestion).mock.calls.map(([id]) => id)).toEqual(props.value.commercialDocument!.questions.map(question => question.id));
    expect(text(tree)).not.toContain("question-"); expect(props.value).toEqual(before); expect(props.value.commercialDocument!.decisions).toEqual([]);
  });

  it("keeps an applied question with remaining issues visible without calling its warnings extra decisions", async () => {
    const value = fixture(2), state = readiness(value); state.activeDecisionIds = ["applied"];
    state.questions[0].activeDecision = { id: "applied" } as NonNullable<typeof state.questions[0]["activeDecision"]>;
    state.questions[0].status = "resolved";
    state.issues.push({ code: "commercial-review", message: "Проверьте условие оплаты", path: "questions.question-0", severity: "review" });
    runtime.readiness.mockResolvedValueOnce(state); render({ value }); await flush();
    expect(nodes(tree).filter(node => node.props["data-commercial-review-question"])).toHaveLength(2);
    expect(text(tree)).toContain("Действующих применённых решений: 1"); expect(text(tree)).toContain("Решение применено, но связанные замечания ещё требуют проверки.");
  });

  it.each(["document", "session", "pricing"] as const)("ignores late readiness after %s changes and never displays the prior questions", async change => {
    const old = deferred<CommercialReadiness>(), fresh = deferred<CommercialReadiness>();
    runtime.readiness.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const oldValue = props.value; oldValue.commercialDocument!.questions[0].message = "СТАРЫЙ вопрос"; render();
    const next = change === "document" ? fixture(1) : change === "pricing" ? { ...oldValue, lines: structuredClone(oldValue.lines) } : oldValue;
    if (change === "document") next.commercialDocument!.questions[0].message = "ТЕКУЩИЙ вопрос";
    render({ value: next, ...(change === "session" ? { sessionKey: "B" } : {}) });
    old.resolve(readiness(oldValue)); await flush(); expect(text(tree)).toContain("Проверяем актуальные вопросы"); expect(text(tree)).not.toContain("СТАРЫЙ вопрос");
    fresh.resolve(readiness(next)); await flush(); expect(nodes(tree).filter(node => node.props["data-commercial-review-question"])).toHaveLength(next.commercialDocument!.questions.length);
    if (change === "document") { expect(text(tree)).toContain("ТЕКУЩИЙ вопрос"); expect(text(tree)).not.toContain("СТАРЫЙ вопрос"); }
  });

  it("does not start readiness work on callback-only, metadata-only or stable repeated renders", async () => {
    render(); await flush();
    for (let i = 0; i < 20; i++) render({ onOpenQuestion: vi.fn(), value: { ...props.value, internalNote: `Заметка ${i}` } });
    await flush(); expect(runtime.readiness).toHaveBeenCalledTimes(1);
  });

  it("navigates external price/party checks to their fields and generic section checks to their actual section", async () => {
    const value = fixture(0); value.commercialDocument!.privateAppendix.coverage = [
      { sourceClauseId: "price", kind: "external-field", field: "pricing" }, { sourceClauseId: "parties", kind: "external-field", field: "parties" },
    ];
    const state = readiness(value); state.issues = [
      { code: "commercial-external-field-unverified", message: "Проверить цену", path: "privateAppendix.coverage.price", severity: "review" },
      { code: "commercial-external-field-unverified", message: "Проверить стороны", path: "privateAppendix.coverage.parties", severity: "review" },
      { code: "commercial-source-projection", message: "Проверить полный текст оплаты", path: "body", sectionId: "payment", severity: "review" },
    ];
    runtime.readiness.mockResolvedValueOnce(state); render({ value }); await flush();
    for (const button of nodes(tree).filter(node => node.type === "button")) button.props.onClick!();
    expect(props.onOpenIssue).toHaveBeenNthCalledWith(1, expect.objectContaining({ field: "sourceFinancials", step: 2 }));
    expect(props.onOpenIssue).toHaveBeenNthCalledWith(2, expect.objectContaining({ field: "issuer.name", step: 1 }));
    expect(props.onOpenSection).toHaveBeenCalledExactlyOnceWith("payment");
  });

  it("does not collapse equal generic messages from different actual sections into one destination", async () => {
    const value = fixture(0), doc = value.commercialDocument!;
    doc.body.sections.push({ id: "schedule", kind: "schedule", title: "Сроки", blocks: [] });
    const state = readiness(value);
    state.issues = ["payment", "schedule"].map(sectionId => ({ code: "commercial-source-projection", message: "Проверьте исходный текст", path: "body", sectionId, severity: "review" }));
    runtime.readiness.mockResolvedValueOnce(state); render({ value }); await flush();
    const buttons = nodes(tree).filter(node => node.type === "button");
    expect(buttons).toHaveLength(2); buttons.forEach(button => button.props.onClick!());
    expect(vi.mocked(props.onOpenSection).mock.calls).toEqual([["payment"], ["schedule"]]);
  });

  it("does not present a failed or unmounted evaluation as ready", async () => {
    runtime.readiness.mockRejectedValueOnce(new Error("PRIVATE-unshown-error")); render(); await flush();
    expect(text(tree)).toContain("готовность не подтверждена"); expect(text(tree)).not.toContain("PRIVATE");
    const held = deferred<CommercialReadiness>(); runtime.readiness.mockReturnValueOnce(held.promise); render({ sessionKey: "B" });
    runtime.slots.forEach(slot => slot.cleanup?.()); runtime.changed = false; held.resolve(readiness(props.value)); await Promise.resolve();
    expect(runtime.changed).toBe(false);
  });
});
