import { isValidElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommercialProposalEditor } from './CommercialProposalEditor';
import { CommercialDocumentView } from './CommercialDocumentView';
import { CommercialQuestionEditor } from './CommercialQuestionEditor';
import { createProposal } from './defaults';
import type { ProposalData } from './types';
import type { CommercialAnswerValidation, CommercialApplyResult, CommercialReadiness } from './commercialDecisions';

const runtime = vi.hoisted(() => ({ index: 0, changed: false, slots: [] as Array<{ value?: unknown; deps?: readonly unknown[]; cleanup?: () => void }>, effects: [] as Array<() => void>, readiness: vi.fn(), validate: vi.fn(), apply: vi.fn() }));
vi.mock('./commercialDecisions', () => ({ projectReadiness: runtime.readiness, validateTermAnswer: runtime.validate, applyTermDecision: runtime.apply }));
vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(),
  useState: (initial: unknown) => { const index = runtime.index++; if (!runtime.slots[index]) runtime.slots[index] = { value: typeof initial === 'function' ? initial() : initial }; return [runtime.slots[index].value, (next: unknown) => { const value = typeof next === 'function' ? next(runtime.slots[index].value) : next; if (!Object.is(value, runtime.slots[index].value)) { runtime.slots[index].value = value; runtime.changed = true; } }]; },
  useRef: (initial: unknown) => { const index = runtime.index++; if (!runtime.slots[index]) runtime.slots[index] = { value: { current: initial } }; return runtime.slots[index].value; },
  useEffect: (effect: () => void | (() => void), deps: readonly unknown[]) => { const index = runtime.index++, old = runtime.slots[index]; if (old?.deps?.length === deps.length && old.deps.every((value, i) => Object.is(value, deps[i]))) return; runtime.slots[index] = { ...old, deps }; runtime.effects.push(() => { old?.cleanup?.(); const cleanup = effect(); runtime.slots[index].cleanup = typeof cleanup === 'function' ? cleanup : undefined; }); },
}));
type Props = Parameters<typeof CommercialProposalEditor>[0];
type NodeProps = { children?: ReactNode };
const fingerprint = `sha256:${'a'.repeat(64)}` as const;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((yes) => { resolve = yes; }); return { promise, resolve }; }
function fixture(): ProposalData {
  const data = createProposal(); data.contact.fullName = 'Исходный контакт';
  data.commercialDocument = { version: 1, revision: 1, body: { version: 1, sections: [{ id: 'payment', kind: 'payment', title: 'Оплата', blocks: [{ id: 'deadline', kind: 'paragraph', style: 'body', content: [{ kind: 'text', text: '5 дней' }] }] }] }, privateAppendix: { version: 1, sourceSnapshotKey: fingerprint, documentId: 'contract', extraction: { complete: true, requiresOcr: false, visualAssessment: 'unassessed' }, containers: [], clauses: [], references: [], coverage: [] }, questions: [{ id: 'days', kind: 'advance-days', sectionId: 'payment', targetBlockIds: ['deadline'], sourceClauseIds: [], sourceReferenceIds: [], message: 'Вид дней', material: true, dependencyFingerprint: fingerprint }], decisions: [] };
  return data;
}
let props: Props, tree: ReactNode;
function render(patch: Partial<Props> = {}) { props = { ...props, ...patch }; runtime.index = 0; runtime.changed = false; tree = CommercialProposalEditor(props); for (const effect of runtime.effects.splice(0)) effect(); }
async function flush() { for (let i = 0; i < 20; i++) { await Promise.resolve(); if (runtime.changed) render(); } }
function find<T>(node: ReactNode, type: unknown): T | undefined {
  if (Array.isArray(node)) { for (const child of node) { const result = find<T>(child, type); if (result) return result; } }
  else if (isValidElement<NodeProps>(node)) { if (node.type === type) return node.props as T; return find<T>(node.props.children, type); }
}
const view = () => find<Parameters<typeof CommercialDocumentView>[0]>(tree, CommercialDocumentView)!;
const question = () => { const rendered = view().renderQuestion!(props.value.commercialDocument!.questions[0]); return find<Parameters<typeof CommercialQuestionEditor>[0]>(rendered, CommercialQuestionEditor)!; };
const validation: CommercialAnswerValidation = { valid: true, issues: [], dependencyFingerprint: fingerprint, previewBlocks: [] };
beforeEach(async () => {
  runtime.slots.forEach((slot) => slot.cleanup?.()); runtime.index = 0; runtime.changed = false; runtime.slots = []; runtime.effects = [];
  runtime.readiness.mockReset(); runtime.validate.mockReset(); runtime.apply.mockReset();
  runtime.readiness.mockImplementation(async (doc) => ({ canSaveDraft: true, canFinalize: false, issues: [], questions: doc.questions.map((q: unknown) => ({ question: q, sourceCurrent: true, status: 'unresolved', dependencyFingerprint: fingerprint, issues: [] })), activeDecisionIds: [], staleDecisionIds: [] } satisfies CommercialReadiness));
  runtime.validate.mockResolvedValue(validation);
  runtime.apply.mockImplementation(async (doc) => ({ document: { ...structuredClone(doc), revision: doc.revision + 1 }, changedBlockIds: ['deadline'], invalidatedDecisionIds: [], issues: [] } as unknown as CommercialApplyResult));
  props = { sessionKey: 'A', value: fixture(), onChange: vi.fn(() => true), onPendingChange: vi.fn() }; render(); await flush();
});
const answer = { kind: 'advance-days' as const, dayKind: 'calendar' as const };

describe('commercial document sole-owner controller', () => {
  it('keeps text changes local until accepted and forwards pending edits without native metadata requests', () => {
    const child = view(), next = { ...structuredClone(props.value.commercialDocument!), revision: 2 };
    child.onPendingEditChange!(true); expect(props.onPendingChange).toHaveBeenLastCalledWith(true);
    expect(child.onChange(next)).toBe(true); expect(props.onChange).toHaveBeenCalledExactlyOnceWith({ ...props.value, commercialDocument: next });
  });
  it('uses current pricing for preview without installing or approving anything', async () => {
    expect(await question().onPreview!(answer)).toBe(validation); expect(runtime.validate).toHaveBeenCalledWith(props.value.commercialDocument, 'days', answer, { pricing: { lines: props.value.lines, currency: 'RUB' } });
    expect(runtime.apply).not.toHaveBeenCalled(); expect(props.onChange).not.toHaveBeenCalled();
  });
  it('merges an accepted decision into current metadata, not stale contacts captured before await', async () => {
    const held = deferred<CommercialAnswerValidation>(); runtime.validate.mockReturnValueOnce(held.promise); const pending = question().onApply(answer);
    render({ value: { ...props.value, contact: { ...props.value.contact, fullName: 'Новый контакт' } } }); held.resolve(validation);
    expect(await pending).toBe(true); expect(props.onChange).toHaveBeenCalledWith(expect.objectContaining({ contact: expect.objectContaining({ fullName: 'Новый контакт' }), commercialDocument: expect.objectContaining({ revision: 2 }) }));
  });
  it.each(['document', 'price', 'session', 'readonly', 'inplace'] as const)('rejects a stale pending decision after %s changes, retaining ownership of the new state', async (change) => {
    const held = deferred<CommercialAnswerValidation>(); runtime.validate.mockReturnValueOnce(held.promise); const pending = question().onApply(answer); const rejected = expect(pending).rejects.toThrow(/изменились/);
    if (change === 'document') render({ value: { ...props.value, commercialDocument: { ...structuredClone(props.value.commercialDocument!), revision: 2 } } });
    if (change === 'price') render({ value: { ...props.value, lines: structuredClone(props.value.lines) } });
    if (change === 'session') render({ sessionKey: 'B' });
    if (change === 'readonly') render({ disabled: true });
    if (change === 'inplace') { props.value.commercialDocument!.revision++; render(); }
    held.resolve(validation); await rejected; expect(props.onChange).not.toHaveBeenCalled(); expect(runtime.apply).not.toHaveBeenCalled();
  });
  it('checks ownership again after the actual Apply calculation, not just preview', async () => {
    const held = deferred<CommercialApplyResult>(); runtime.apply.mockReturnValueOnce(held.promise); const pending = question().onApply(answer); const rejected = expect(pending).rejects.toThrow(/изменились/); await flush();
    render({ disabled: true }); held.resolve({ document: props.value.commercialDocument!, changedBlockIds: [], invalidatedDecisionIds: [], issues: [] } as unknown as CommercialApplyResult);
    await rejected; expect(props.onChange).not.toHaveBeenCalled();
  });
  it('does not invent an acceptance when the parent rejects the decision', async () => {
    props.onChange = vi.fn(() => false); render(); expect(await question().onApply(answer)).toBe(false); expect(props.value.commercialDocument!.revision).toBe(1);
  });
  it('never lets a stale body callback replace another controlled document', () => {
    const old = view(), next = structuredClone(props.value.commercialDocument!); render({ value: { ...props.value, commercialDocument: next } });
    expect(old.onChange({ ...next, revision: 2 })).toBe(false); expect(props.onChange).not.toHaveBeenCalled();
  });
});
