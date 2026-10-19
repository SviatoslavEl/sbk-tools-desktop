import { isValidElement, type ComponentProps, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProposalWholeWorkingRoute, ProposalWorkingHost, ProposalWorkingLibrary } from './ProposalWorkingRoute';
import { ProposalWorkingWorkspace, type ProposalWorkingBinding } from './ProposalWorkingWorkspace';
import { createWorkingProposal, fingerprintWorkingProposal, type WorkingProposalDocument } from './workingDocument';
import type { WorkingStorageContext, WorkingStorageRead, WorkingStorageSummary } from './workingStorage';
import { buildProposalAreaPlan, buildProposalAreaReviewPlan, parseProposalAreaBlockResponse, parseProposalAreaReviewResponse, PROPOSAL_AREAS } from '../intelligence/proposalAreaPlan';
import { buildProposalWholeDraft } from '../intelligence/proposalWholeDraft';
import { createProposalDraftEditorHandoff, type ProposalDraftEditorHandoff } from '../intelligence/proposalDraftEditorAdapter';
import type { IntelligenceSource } from '../intelligence/workbenchTypes';

// Source-only hook/callback/SSR composition. These are not DOM clicks, a real
// native bridge, a storage database, a model, file generation or visual QA.
type Slot = { value?: unknown; deps?: readonly unknown[]; cleanup?: () => void };
type Frame = { at: number; slots: Slot[]; effects: (() => void)[]; tree: ReactNode; render?: () => void };
const state = vi.hoisted(() => ({ frame: null as Frame | null, editor: true, phase: 'connected', root: 'root-A',
  invoke: vi.fn(), path: vi.fn(), workspace: vi.fn(), context: vi.fn(), list: vi.fn(), read: vi.fn(), services: vi.fn(), convert: vi.fn(), realConvert: null as typeof createWorkingProposal | null }));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(),
  useState: (initial: unknown) => { const frame = state.frame!, at = frame.at++; frame.slots[at] ??= { value: typeof initial === 'function' ? initial() : initial };
    return [frame.slots[at].value, (next: unknown) => { frame.slots[at].value = typeof next === 'function' ? next(frame.slots[at].value) : next; }]; },
  useRef: (initial: unknown) => { const frame = state.frame!, at = frame.at++; frame.slots[at] ??= { value: { current: initial } }; return frame.slots[at].value; },
  useMemo: (make: () => unknown, deps: readonly unknown[]) => { const frame = state.frame!, at = frame.at++, prior = frame.slots[at];
    if (!prior?.deps || deps.length !== prior.deps.length || deps.some((value, index) => !Object.is(value, prior.deps![index]))) frame.slots[at] = { deps, value: make() }; return frame.slots[at].value; },
  useEffect: (callback: () => (() => void) | void, deps: readonly unknown[]) => { const frame = state.frame!, at = frame.at++, prior = frame.slots[at];
    if (!prior?.deps || deps.length !== prior.deps.length || deps.some((value, index) => !Object.is(value, prior.deps![index]))) frame.effects.push(() => { prior?.cleanup?.(); const cleanup = callback(); frame.slots[at] = { deps, cleanup: typeof cleanup === 'function' ? cleanup : undefined }; }); },
  useId: () => 'source-only-working-route',
}));
vi.mock('../../lib/networkDiagnostics', () => ({ invoke: state.invoke, useNetworkAccess: () => ({ phase: state.phase }) }));
vi.mock('../../lib/files', () => ({ chooseSavePath: state.path }));
vi.mock('../../lib/storage', () => ({ getWorkspaceInfo: state.workspace }));
vi.mock('../../lib/workspaceAccess', () => ({ useWorkspaceAccess: () => ({ editor: state.editor }) }));
vi.mock('./workingStorage', async original => {
  const real = await original<typeof import('./workingStorage')>();
  state.services.mockImplementation(real.createWorkingStorageServices);
  return { ...real, createWorkingStorageServices: state.services, getWorkingStorageContext: state.context, listWorkingStorage: state.list, readWorkingStorage: state.read };
});
vi.mock('./workingDocument', async original => { const real = await original<typeof import('./workingDocument')>(); state.realConvert = real.createWorkingProposal; return { ...real, createWorkingProposal: state.convert }; });
vi.mock('../intelligence/ProposalWholeDraftWorkspace', () => ({ ProposalWholeDraftWorkspace: () => <div>Исходный выданный черновик ИИ — отдельный редактор</div> }));

const frames: Frame[] = [], realTimeout = setTimeout;
function frame<P>(component: (props: P) => ReactNode, initial: P) {
  const value: Frame & { props: P } = { at: 0, slots: [], effects: [], tree: null, props: initial };
  value.render = () => { state.frame = value; value.at = 0; value.effects = []; value.tree = component(value.props); const effects = value.effects; value.effects = []; effects.forEach(run => run()); };
  frames.push(value); value.render(); return value;
}
function rerender<P>(value: Frame & { props: P }, next = value.props) { value.props = next; value.render!(); }
function cleanup(value: Frame) { value.slots.forEach(slot => slot.cleanup?.()); value.slots = []; }
interface Props { children?: ReactNode; disabled?: boolean; hidden?: boolean; 'aria-label'?: string; value?: string; onClick?: () => void; onChange?: (event: { target: { value: string; checked: boolean } }) => void }
function nodes(tree: ReactNode): ReactElement<Props>[] { return Array.isArray(tree) ? tree.flatMap(nodes) : isValidElement<Props>(tree) ? [tree, ...nodes(tree.props.children)] : []; }
function text(tree: ReactNode): string { return Array.isArray(tree) ? tree.map(text).join('') : isValidElement<Props>(tree) ? text(tree.props.children) : typeof tree === 'string' || typeof tree === 'number' ? String(tree) : ''; }
function button(value: Frame, label: string, index = 0) { const element = nodes(value.tree).filter(node => node.type === 'button' && text(node) === label)[index]; if (!element) throw new Error(`Missing ${label}: ${text(value.tree)}`); return element; }
function click(value: Frame, label: string, index = 0) { button(value, label, index).props.onClick!(); value.render!(); }
function child<P>(value: Frame, component: (props: P) => ReactNode): ReactElement<P> | undefined { return nodes(value.tree).find(node => node.type === component) as ReactElement<P> | undefined; }
const tick = () => new Promise<void>(resolve => realTimeout(resolve, 0));
async function settle(value: Frame, predicate: () => boolean) { for (let at = 0; at < 100; at++) { await tick(); value.render!(); if (predicate()) return; } throw new Error(`Did not settle: ${text(value.tree)}`); }
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const LEASE_A = '11234567-1234-4123-8123-0123456789ab', LEASE_B = '21234567-1234-4123-8123-0123456789ab';
const DOC_A = '31234567-1234-4123-8123-0123456789ab', DOC_B = '41234567-1234-4123-8123-0123456789ab';
const TOKEN = '51234567-1234-4123-8123-0123456789ab';
const owner = (root = 'root-A', lease: string | null = LEASE_A): WorkingStorageContext => ({ root, leaseGeneration: lease, canWrite: lease !== null });
function ordinary(id = DOC_A): WorkingProposalDocument { return { kind: 'proposal-working-document', schemaVersion: 1, id, revision: 2, title: `SYNTHETIC ${id}`,
  metadata: { number: null, documentDate: null, validUntil: null, currency: null, issuerName: null, recipientName: null }, layout: { style: 'standard', accentColor: '#247A64' },
  sections: PROPOSAL_AREAS.map(area => ({ area, title: area === 'payment' ? 'Оплата' : area, blocks: [{ id: `${area}:frame-1`, frameId: 'frame-1', frameIndex: 0, text: `WHOLE_${area}`, origin: 'historical-model-answer', included: true }], userText: '', userTextIncluded: false })),
  questions: [], historicalSource: { kind: 'unvalidated-history', sha256: 'a'.repeat(64), bytes: 128, sourceSnapshotKey: `sha256:${'b'.repeat(64)}`, structureSnapshotKey: `sha256:${'c'.repeat(64)}`, planKey: `sha256:${'d'.repeat(64)}` } }; }
const summary = (id = DOC_A): WorkingStorageSummary => ({ id, title: `SUMMARY ${id}`, storageToken: TOKEN, documentRevision: 2, bodySha256: 'e'.repeat(64), historySha256: 'a'.repeat(64), updatedAt: '2030-01-01T00:00:00.000Z', autosaveAvailable: true, recordSaved: true });
const loaded = (): WorkingStorageRead => { const result = { saved: { document: ordinary(), summary: summary() }, recovery: { document: { ...ordinary(), revision: 7, title: 'RECOVERY_ONLY' }, token: LEASE_B, ownerId: LEASE_A, baseRecordStorageToken: TOKEN }, consumedRecovery: null }; return result; };
let issued: ProposalDraftEditorHandoff;
beforeAll(async () => {
  const sources: IntelligenceSource[] = [{ id: 'source', name: 'SYNTHETIC', sha256: 'a'.repeat(64), text: 'PRIVATE_SOURCE', coverage: { complete: true, requiresOcr: false },
    fragments: [{ id: 'owner', text: 'WHOLE SYNTHETIC SOURCE', locator: 'Synthetic position', structure: { version: 1, format: 'docx', method: 'ooxml', part: 'word/document.xml', kind: 'paragraph', containerId: 'body', order: 0, physicalSection: 0 } }] }];
  const plan = await buildProposalAreaPlan(sources), records = [];
  for (const block of plan.blocks) {
    const response = await parseProposalAreaBlockResponse(JSON.stringify({ planKey: plan.planKey, sourceSnapshotKey: plan.sourceSnapshotKey, structureSnapshotKey: plan.structureSnapshotKey, blockId: block.id,
      areas: Object.fromEntries(PROPOSAL_AREAS.map(area => [area, { status: 'answered', answer: `WHOLE_${area}`, evidenceRefs: [{ ownerId: 'owner', cellIndex: null }] }])) }), plan, block.id, sources);
    const reviewPlan = await buildProposalAreaReviewPlan(response, plan, sources), reviewResponse = await parseProposalAreaReviewResponse(JSON.stringify({ reviewPlanKey: reviewPlan.reviewPlanKey, planKey: plan.planKey, sourceSnapshotKey: plan.sourceSnapshotKey,
      structureSnapshotKey: plan.structureSnapshotKey, blockId: block.id, areas: Object.fromEntries(PROPOSAL_AREAS.map(area => [area, { verdict: 'supported', reason: 'SYNTHETIC only, not model accuracy' }])) }), reviewPlan, plan, sources);
    records.push({ response, reviewPlan, reviewResponse });
  }
  issued = await createProposalDraftEditorHandoff(await buildProposalWholeDraft(plan, records, sources), plan, records, sources);
});
beforeEach(() => {
  state.editor = true; state.phase = 'connected'; state.root = 'root-A'; state.invoke.mockReset().mockRejectedValue(new Error('REAL_NATIVE_FORBIDDEN')); state.path.mockReset().mockRejectedValue(new Error('REAL_FILES_FORBIDDEN'));
  state.workspace.mockReset().mockImplementation(async () => ({ root: state.root })); state.context.mockReset().mockImplementation(async (_io, root) => owner(root));
  state.list.mockReset().mockResolvedValue({ items: [summary()], nextCursor: null }); state.read.mockReset().mockResolvedValue(loaded()); state.services.mockClear(); state.convert.mockReset().mockResolvedValue({ document: ordinary(), historyJson: 'SYNTHETIC_PRIVATE_HISTORY' });
  vi.stubGlobal('window', new EventTarget());
});
afterEach(() => { frames.splice(0).forEach(cleanup); vi.useRealTimers(); vi.unstubAllGlobals(); expect(state.invoke).not.toHaveBeenCalled(); expect(state.path).not.toHaveBeenCalled(); });
const wholeProps = (): ComponentProps<typeof ProposalWholeWorkingRoute> => ({ handoff: issued, root: 'root-A', taskKey: 'task-1', stale: false, open: true, onClose: vi.fn() });
const hostProps = (): ComponentProps<typeof ProposalWorkingHost> => ({ seed: { document: ordinary(), sessionKey: 'session-A', storageToken: TOKEN }, root: 'root-A', taskKey: 'task-A' });
const library = () => frame(ProposalWorkingLibrary, { active: true });
async function choose(value: Frame) { click(value, 'Открыть список рабочих КП'); await settle(value, () => text(value.tree).includes('SUMMARY')); click(value, 'Выбрать'); await settle(value, () => text(value.tree).includes('Выберите версию')); }
function editWorkspace(value: Frame, label: string, content: string) { const control = nodes(value.tree).find(node => node.props['aria-label'] === label); if (!control) throw new Error(`Missing ${label}`); control.props.onChange!({ target: { value: content, checked: false } }); value.render!(); }

describe('working route source-only lifecycle/callback/SSR integration', () => {
  it('does not convert, poll storage or invoke native on mount; collapse hides but retains the issued editor element', () => {
    const value = frame(ProposalWholeWorkingRoute, wholeProps()), element = nodes(value.tree).find(node => typeof node.type === 'function');
    expect(renderToStaticMarkup(<>{value.tree}</>)).toContain('Продолжить в редакторе с сохранением'); expect(state.convert).not.toHaveBeenCalled(); expect(state.context).not.toHaveBeenCalled(); expect(state.list).not.toHaveBeenCalled();
    rerender(value, { ...value.props, open: false }); expect(nodes(value.tree)[0].props.hidden).toBe(true); expect(nodes(value.tree).some(node => node.type === element!.type)).toBe(true);
    rerender(value, { ...value.props, open: true }); expect(nodes(value.tree)[0].props.hidden).toBe(false); expect(state.convert).not.toHaveBeenCalled();
  });

  it('explicitly converts the SAME issued handoff and preserves ordinary document/history seed across folding', async () => {
    state.convert.mockImplementation(state.realConvert!); const value = frame(ProposalWholeWorkingRoute, wholeProps());
    const callback = button(value, 'Продолжить в редакторе с сохранением').props.onClick!; callback(); callback(); value.render!();
    await settle(value, () => Boolean(child(value, ProposalWorkingHost))); const hosted = child(value, ProposalWorkingHost)!;
    expect(state.convert).toHaveBeenCalledOnce(); expect(state.convert.mock.calls[0][0]).toBe(issued); expect(hosted.props.seed.document.kind).toBe('proposal-working-document');
    expect(hosted.props.seed.historyJson).toBe(JSON.stringify(issued.privateContext.originalDraft)); expect(state.context).not.toHaveBeenCalled();
    rerender(value, { ...value.props, open: false }); const hidden = child(value, ProposalWorkingHost)!; expect(hidden.props.seed).toBe(hosted.props.seed); expect(hidden.key).toBe(hosted.key);
    rerender(value, { ...value.props, open: true }); expect(child(value, ProposalWorkingHost)!.props.seed.sessionKey).toBe(hosted.props.seed.sessionKey);
  });

  it.each(['handoff', 'root', 'taskKey', 'stale', 'unmount'] as const)('ignores pending explicit conversion after %s changes', async change => {
    const pending = deferred<Awaited<ReturnType<typeof createWorkingProposal>>>(); state.convert.mockReturnValue(pending.promise); const value = frame(ProposalWholeWorkingRoute, wholeProps());
    click(value, 'Продолжить в редакторе с сохранением');
    if (change === 'unmount') cleanup(value); else rerender(value, { ...value.props, ...(change === 'handoff' ? { handoff: structuredClone(issued) } : change === 'stale' ? { stale: true } : { [change]: 'CHANGED' }) });
    pending.resolve({ document: ordinary(), historyJson: 'PRIVATE_RETURN' }); await tick(); await tick(); if (change !== 'unmount') value.render!();
    expect(child(value, ProposalWorkingHost)).toBeUndefined(); expect(state.context).not.toHaveBeenCalled(); expect(state.list).not.toHaveBeenCalled();
  });

  it('library is explicit and pages summaries only; bodies remain lazy until selecting one item', async () => {
    state.list.mockResolvedValueOnce({ items: [summary()], nextCursor: DOC_A }).mockResolvedValueOnce({ items: [summary(DOC_B)], nextCursor: null });
    const value = library(); expect(state.workspace).not.toHaveBeenCalled(); expect(state.context).not.toHaveBeenCalled(); expect(state.read).not.toHaveBeenCalled();
    expect(renderToStaticMarkup(<>{value.tree}</>)).toContain('Рабочие КП по семи разделам'); click(value, 'Открыть список рабочих КП'); await settle(value, () => text(value.tree).includes('Следующие 50'));
    expect(state.read).not.toHaveBeenCalled(); click(value, 'Следующие 50'); await settle(value, () => nodes(value.tree).filter(node => node.type === 'button' && text(node) === 'Выбрать').length === 2);
    expect(state.list.mock.calls[1][4]).toBe(DOC_A); expect(state.read).not.toHaveBeenCalled(); click(value, 'Выбрать', 1); await settle(value, () => text(value.tree).includes('Выберите версию'));
    expect(state.read.mock.calls[0][2]).toBe(DOC_B); expect(state.read.mock.calls[0][3]).toBe(TOKEN); expect(child(value, ProposalWorkingHost)).toBeUndefined();
  });

  it('refuses loading a later page under a different root or generation without replacing existing summaries', async () => {
    state.list.mockResolvedValue({ items: [summary()], nextCursor: DOC_A }); const value = library(); click(value, 'Открыть список рабочих КП'); await settle(value, () => text(value.tree).includes('Следующие 50'));
    state.root = 'root-B'; click(value, 'Следующие 50'); await settle(value, () => text(value.tree).includes('Загрузите список с начала'));
    expect(state.list).toHaveBeenCalledOnce(); expect(text(value.tree)).toContain(summary().title); expect(state.read).not.toHaveBeenCalled();
  });

  it('keeps saved and recovery versions separate and opens recovery only as an explicit new ID/revision/token', async () => {
    const response = loaded(); state.read.mockResolvedValue(response); const value = library(); await choose(value);
    expect(child(value, ProposalWorkingHost)).toBeUndefined(); const oldSavedCallback = button(value, 'Открыть сохранённый документ').props.onClick!;
    click(value, 'Открыть восстановительную копию как новое КП'); const host = child(value, ProposalWorkingHost)!;
    expect(host.props.seed.document.title).toBe('RECOVERY_ONLY'); expect(host.props.seed.document.id).not.toBe(DOC_A); expect(host.props.seed.document.revision).toBe(0); expect(host.props.seed.storageToken).toBeNull();
    expect(host.props.seed.recovery).toBeUndefined(); // A new copy does not adopt/consume the old recovery owner's CAS.
    expect(response.recovery!.document.id).toBe(DOC_A); expect(response.recovery!.document.revision).toBe(7); oldSavedCallback(); value.render!(); expect(child(value, ProposalWorkingHost)!.props.seed).toBe(host.props.seed);
    host.props.onClose!(); value.render!(); expect(child(value, ProposalWorkingHost)).toBeUndefined(); expect(text(value.tree)).not.toContain('Выберите версию для открытия');
  });

  it.each(['access', 'network', 'refresh'] as const)('an old selection callback cannot reopen after %s invalidates the shelf', async change => {
    const value = library(); await choose(value); const staleOpen = button(value, 'Открыть сохранённый документ').props.onClick!;
    if (change === 'access') state.editor = false; else if (change === 'network') state.phase = 'paused'; else window.dispatchEvent(new Event('sbk-workspace-refresh'));
    value.render!(); value.render!(); staleOpen(); value.render!(); expect(child(value, ProposalWorkingHost)).toBeUndefined();
  });

  it.each(['Открыть сохранённый документ', 'Открыть восстановительную копию как новое КП'])('an old %s callback cannot open a shelf that has become inactive', async action => {
    const value = library(); await choose(value); const staleOpen = button(value, action).props.onClick!;
    rerender(value, { active: false }); staleOpen(); value.render!(); expect(child(value, ProposalWorkingHost)).toBeUndefined();
  });

  it('ignores a body read that returns only after the shelf becomes hidden', async () => {
    const pending = deferred<WorkingStorageRead>(); state.read.mockReturnValue(pending.promise); const value = library();
    click(value, 'Открыть список рабочих КП'); await settle(value, () => text(value.tree).includes('SUMMARY')); click(value, 'Выбрать');
    expect(state.read).toHaveBeenCalledOnce(); rerender(value, { active: false }); pending.resolve(loaded()); await tick(); await tick(); value.render!();
    expect(text(value.tree)).not.toContain('Выберите версию для открытия'); expect(child(value, ProposalWorkingHost)).toBeUndefined();
  });

  it('marks an existing unconsumed recovery protected instead of merging/adopting it on saved reopen', async () => {
    const response = loaded(); state.read.mockResolvedValue(response); const value = library(); await choose(value); click(value, 'Открыть сохранённый документ');
    const host = child(value, ProposalWorkingHost)!; expect(host.props.seed.document).toBe(response.saved!.document); expect(host.props.seed.document.title).not.toBe('RECOVERY_ONLY'); expect(host.props.seed.recovery).toBe('protected');
    const hosted = frame(ProposalWorkingHost, host.props); await settle(hosted, () => child(hosted, ProposalWorkingWorkspace)!.props.context.access === 'editor');
    expect(child(hosted, ProposalWorkingWorkspace)!.props.initialRecovery).toBe('protected');
  });

  it('passes a consumed tombstone owner/token through reopening as storage CAS only, not as a new record identity', async () => {
    const response = loaded(), tombstone = { ownerId: LEASE_A, storageToken: LEASE_B }; response.recovery = null; response.consumedRecovery = tombstone; state.read.mockResolvedValue(response);
    const value = library(); await choose(value); click(value, 'Открыть сохранённый документ'); const host = child(value, ProposalWorkingHost)!;
    expect(host.props.seed.document.id).toBe(DOC_A); expect(host.props.seed.storageToken).toBe(TOKEN); expect(host.props.seed.recovery).toBe(tombstone);
    const hosted = frame(ProposalWorkingHost, host.props); await settle(hosted, () => child(hosted, ProposalWorkingWorkspace)!.props.context.access === 'editor');
    expect(child(hosted, ProposalWorkingWorkspace)!.props.initialRecovery).toBe(tombstone);
  });

  it.each(['access', 'network', 'refresh'] as const)('retains an open seed root/document/session while %s resets owner/list state', async change => {
    const value = library(); await choose(value); click(value, 'Открыть сохранённый документ'); const before = child(value, ProposalWorkingHost)!;
    if (change === 'access') state.editor = false; else if (change === 'network') state.phase = 'paused'; else { state.root = 'root-B'; window.dispatchEvent(new Event('sbk-workspace-refresh')); }
    value.render!(); value.render!(); const after = child(value, ProposalWorkingHost)!;
    expect(after).toBeTruthy(); expect(after.type).toBe(before.type); expect(after.key).toBe(before.key); expect(after.props.seed).toBe(before.props.seed); expect(after.props.seed.document).toBe(before.props.seed.document); expect(after.props.root).toBe('root-A');
    expect(after.props.taskKey).toBe(`stored:${DOC_A}`); expect(state.read).toHaveBeenCalledOnce();
  });

  it('keeps services stable through lease/access refresh and rejects old lease-bound Save before native I/O', async () => {
    const value = frame(ProposalWorkingHost, hostProps()); await settle(value, () => child(value, ProposalWorkingWorkspace)!.props.context.access === 'editor');
    const before = child(value, ProposalWorkingWorkspace)!, service = before.props.services;
    const binding: ProposalWorkingBinding = { operationId: crypto.randomUUID(), sessionKey: 'session-A', workspaceRoot: 'root-A', leaseGeneration: LEASE_A, taskKey: 'task-A', documentId: DOC_A, documentRevision: 2, documentFingerprint: await fingerprintWorkingProposal(before.props.initialDocument) };
    state.context.mockResolvedValue(owner('root-A', LEASE_B)); window.dispatchEvent(new Event('sbk-workspace-refresh')); value.render!(); value.render!();
    expect(child(value, ProposalWorkingWorkspace)!.props.services).toBe(service); await expect(service.save({ binding, document: before.props.initialDocument, expectedStorageToken: TOKEN }, new AbortController().signal)).rejects.toThrow();
    await settle(value, () => child(value, ProposalWorkingWorkspace)!.props.context.leaseGeneration === LEASE_B); expect(child(value, ProposalWorkingWorkspace)!.props.services).toBe(service); expect(state.services).toHaveBeenCalledOnce();
    state.editor = false; value.render!(); value.render!(); await settle(value, () => child(value, ProposalWorkingWorkspace)!.props.context.access === 'viewer'); expect(child(value, ProposalWorkingWorkspace)!.props.services).toBe(service);
  });

  it.each(['root', 'access'] as const)('ignores the old context arriving AFTER a newer valid context following %s change', async change => {
    const old = deferred<WorkingStorageContext>(), fresh = deferred<WorkingStorageContext>(); state.context.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const value = frame(ProposalWorkingHost, hostProps()); const oldSignal = state.context.mock.calls[0][2] as AbortSignal;
    if (change === 'access') state.editor = false;
    const root = change === 'root' ? 'root-B' : 'root-A', lease = change === 'access' ? null : LEASE_B;
    rerender(value, { ...value.props, root }); value.render!(); expect(oldSignal.aborted).toBe(true);
    fresh.resolve(owner(root, lease)); await settle(value, () => !child(value, ProposalWorkingWorkspace)!.props.context.stale);
    old.resolve(owner('root-A', LEASE_A)); await tick(); await tick(); value.render!();
    expect(child(value, ProposalWorkingWorkspace)!.props.context).toMatchObject({ workspaceRoot: root, access: change === 'access' ? 'viewer' : 'editor', leaseGeneration: lease, stale: false });
  });

  it('composes the real ordinary workspace, retaining local text but blocking implicit Save to a changed root', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); const host = frame(ProposalWorkingHost, hostProps()); await settle(host, () => child(host, ProposalWorkingWorkspace)!.props.context.access === 'editor');
    const workspace = frame(ProposalWorkingWorkspace, child(host, ProposalWorkingWorkspace)!.props); editWorkspace(workspace, 'Дополнение — Оплата', '  LOCAL_TEXT\nне терять  ');
    const oldSave = button(workspace, 'Сохранить черновик').props.onClick!; rerender(host, { ...host.props, root: 'root-B' }); host.render!();
    rerender(workspace, child(host, ProposalWorkingWorkspace)!.props); oldSave(); workspace.render!();
    expect(button(workspace, 'Сохранить черновик').props.disabled).toBe(true); expect(text(workspace.tree)).toContain('операции старого сеанса отключены');
    expect(nodes(workspace.tree).find(node => node.props['aria-label'] === 'Дополнение — Оплата')!.props.value).toBe('  LOCAL_TEXT\nне терять  ');
    expect(workspace.props.initialDocument).toBe(host.props.seed.document); expect(workspace.props.sessionKey).toBe('session-A');
  });

  it('keeps the actual ordinary child local text/session while library owner/list resets under access/network/refresh', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); const shelf = library(); await choose(shelf); click(shelf, 'Открыть сохранённый документ');
    const first = child(shelf, ProposalWorkingHost)!, hosted = frame(ProposalWorkingHost, first.props); await settle(hosted, () => child(hosted, ProposalWorkingWorkspace)!.props.context.access === 'editor');
    const workspace = frame(ProposalWorkingWorkspace, child(hosted, ProposalWorkingWorkspace)!.props); editWorkspace(workspace, 'Дополнение — Оплата', '  REMAIN_LOCAL\r\n🧪  ');
    const expectedSession = workspace.props.sessionKey;
    for (const change of ['access', 'network', 'refresh']) {
      if (change === 'access') state.editor = false; else if (change === 'network') state.phase = 'paused'; else { state.root = 'root-B'; window.dispatchEvent(new Event('sbk-workspace-refresh')); }
      shelf.render!(); shelf.render!(); const kept = child(shelf, ProposalWorkingHost)!;
      expect(kept.props.root).toBe('root-A'); expect(kept.props.seed).toBe(first.props.seed); rerender(hosted, kept.props); hosted.render!(); rerender(workspace, child(hosted, ProposalWorkingWorkspace)!.props);
      expect(workspace.props.sessionKey).toBe(expectedSession); expect(nodes(workspace.tree).find(node => node.props['aria-label'] === 'Дополнение — Оплата')!.props.value).toBe('  REMAIN_LOCAL\r\n🧪  ');
    }
  });
});
