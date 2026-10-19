import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROPOSAL_AREAS } from '../intelligence/proposalAreaPlan';
import type { ProposalWorkingBinding } from './ProposalWorkingWorkspace';
import { createWorkingStorageServices, getWorkingStorageContext, listWorkingStorage, readWorkingStorage,
  type WorkingStorageContext, type WorkingStorageIO } from './workingStorage';
import { createWorkingProposalReviewIntent, fingerprintWorkingProposal, fingerprintWorkingProposalPublic,
  inspectWorkingProposalHistory, parseWorkingProposalDocument, projectWorkingProposalPublic, serializeWorkingProposalDocument,
  type WorkingProposalDocument } from './workingDocument';

// Synthetic injected I/O ONLY: no native invocation, real dialog, filesystem,
// DB, renderer, provider, issued model proof or real human approval is exercised.
vi.mock('@tauri-apps/api/core', () => ({ invoke: () => { throw new Error('FORBIDDEN_REAL_NATIVE'); } }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: () => { throw new Error('FORBIDDEN_REAL_DIALOG'); } }));
const ROOT = '/SYNTHETIC_ONLY/no-files-created';
const id = (n: number) => `01234567-1234-4123-8123-${n.toString(16).padStart(12, '0')}`;
const DOC_ID = id(1), LEASE = id(2), OWNER = id(3), SAVED = id(4), NEXT = id(5), AUTO = id(6), TOMBSTONE = id(7);
const STAMP = '2026-10-19T00:00:00Z';
const context: WorkingStorageContext = { root: ROOT, canWrite: true, leaseGeneration: LEASE };
const hashText = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), b => b.toString(16).padStart(2, '0')).join('');
const historyJson = JSON.stringify({ version: 1, purpose: 'unapproved-model-whole-proposal-draft', planKey: `sha256:${'c'.repeat(64)}`,
  sourceSnapshotKey: `sha256:${'a'.repeat(64)}`, structureSnapshotKey: `sha256:${'b'.repeat(64)}`,
  sourceSnapshot: [{ text: 'SYNTHETIC_PRIVATE_HISTORY' }], owners: [], sections: PROPOSAL_AREAS.map(area => ({ area })),
  clarificationQuestions: [], unvalidatedDetails: [], audit: {}, runCoverage: {}, approvedContent: [], readyForClient: false,
  humanApproval: false, semanticTruth: 'not-proven', completeness: 'not-assessed', providerAuthenticity: 'not-attested' });
let historySHA: string, original: WorkingProposalDocument;
beforeAll(async () => {
  historySHA = await hashText(historyJson);
  original = parseWorkingProposalDocument({ kind: 'proposal-working-document', schemaVersion: 1, id: DOC_ID, revision: 0,
    title: '  SYNTHETIC saved КП 🧪  ', metadata: { number: null, documentDate: null, validUntil: null, currency: null, issuerName: null, recipientName: null },
    layout: { style: 'standard', accentColor: '#aBcD12' }, sections: PROPOSAL_AREAS.map(area => ({ area, title: area,
      blocks: [{ id: `${area}:block-1`, frameId: 'work-scope:block-1', frameIndex: 0, text: `  SYNTHETIC whole ${area}\r\n🧪  `,
        origin: 'historical-model-answer', included: true }], userText: '', userTextIncluded: false })),
    questions: [{ id: 'question-payment', area: 'payment', topic: 'SYNTHETIC', question: 'Synthetic question?', answer: 'SYNTHETIC_PRIVATE_ANSWER', state: 'answered' }],
    historicalSource: { kind: 'unvalidated-history', sha256: historySHA, bytes: new TextEncoder().encode(historyJson).byteLength,
      sourceSnapshotKey: `sha256:${'a'.repeat(64)}`, structureSnapshotKey: `sha256:${'b'.repeat(64)}`, planKey: `sha256:${'c'.repeat(64)}` } });
});
beforeEach(() => vi.stubGlobal('fetch', vi.fn(() => { throw new Error('FORBIDDEN_REAL_NETWORK'); })));
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const ordinary = () => parseWorkingProposalDocument(serializeWorkingProposalDocument(original));
const signal = () => new AbortController().signal;
const current = () => true;
const readScope = { expectedRoot: ROOT, expectedLeaseGeneration: LEASE };
const copy = <T,>(value: T): T => structuredClone(value);
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
async function binding(document = ordinary()): Promise<ProposalWorkingBinding> { return { operationId: crypto.randomUUID(), sessionKey: 'SYNTHETIC_SESSION', workspaceRoot: ROOT,
  leaseGeneration: LEASE, taskKey: 'SYNTHETIC_TASK', documentId: document.id, documentRevision: document.revision, documentFingerprint: await fingerprintWorkingProposal(document) }; }
type Request = Record<string, any>;
function request(args: Record<string, unknown>): Request { expect(Object.keys(args)).toEqual(['request']); return args.request as Request; }
function mockIO(handler: (command: string, args: Record<string, unknown>) => unknown | Promise<unknown>) {
  return { invoke: vi.fn(async (command: string, args: Record<string, unknown>) => handler(command, args)),
    chooseSavePath: vi.fn(async (_format: 'docx' | 'pdf', _title: string): Promise<string | null> => '/SYNTHETIC_ONLY/not-written.docx') } satisfies WorkingStorageIO;
}
async function summary(document = ordinary(), storageToken: string | null = SAVED) { return { id: document.id, title: document.title, storageToken,
  documentRevision: document.revision, bodySha256: (await fingerprintWorkingProposal(document)).slice(7), historySha256: document.historicalSource.sha256,
  updatedAt: STAMP, autosaveAvailable: false, recordSaved: storageToken !== null }; }
async function savedRead(document = ordinary()) { return { root: ROOT, saved: { summary: await summary(document), documentJson: serializeWorkingProposalDocument(document) }, autosave: null as unknown }; }
function writeReceipt(r: Request, action: 'saved' | 'autosaved', storageToken = NEXT, consumedAutosave: unknown = null) {
  const document = parseWorkingProposalDocument(r.documentJson);
  return { operationId: r.scope.operationId, root: r.scope.expectedRoot, id: r.id, action, expectedStorageToken: r.expectedStorageToken,
    storageToken, submittedBodySha256: r.submittedBodySha256, documentRevision: document.revision,
    historySha256: document.historicalSource.sha256, updatedAt: STAMP, consumedAutosave };
}
function renderReceipt(r: Request) { return { operationId: r.operationId, root: r.scope.expectedRoot, publicSha256: r.publicSha256, format: r.format,
  requestedOutputPath: r.outputPath, outputPath: r.outputPath, outputSha256: 'd'.repeat(64) }; }
async function finalRequest(document = ordinary()) {
  const intent = await createWorkingProposalReviewIntent(document);
  return { binding: await binding(document), format: 'docx' as const, publicDocument: await projectWorkingProposalPublic(document, 'final', intent),
    clientProjectionFingerprint: await fingerprintWorkingProposalPublic(document) };
}

describe('working native bridge — synthetic I/O contract, not native/GUI/quality acceptance', () => {
  it('uses closed context and exact nested editor/viewer read scopes', async () => {
    const io = mockIO((command, args) => { expect(command).toBe('proposal_working_context'); expect(args).toEqual({ request: { expectedRoot: ROOT } }); return context; });
    expect(await getWorkingStorageContext(io, ROOT, signal(), current)).toEqual(context);
    io.invoke.mockImplementation(async (command, args) => { expect(command).toBe('proposal_working_list'); expect(args).toEqual({ request: { scope: { expectedRoot: ROOT, expectedLeaseGeneration: null }, afterId: null, limit: 50 } }); return { root: ROOT, items: [], nextCursor: null }; });
    expect(await listWorkingStorage(io, { root: ROOT, canWrite: false, leaseGeneration: null }, signal(), current)).toEqual({ items: [], nextCursor: null });
  });
  it.each([
    ['root', (v: Request) => { v.root = 'FOREIGN_ROOT'; }], ['generation', (v: Request) => { v.leaseGeneration = 'not-uuid'; }],
    ['access', (v: Request) => { v.canWrite = false; }], ['extra', (v: Request) => { v.admin = true; }],
  ] as const)('rejects context %s mismatch', async (_label, change) => {
    const value = copy(context); change(value); const io = mockIO(() => value);
    await expect(getWorkingStorageContext(io, ROOT, signal(), current)).rejects.toThrow();
  });
  it('refuses stale/aborted context before call and refuses a late acknowledgement without retry', async () => {
    const pending = deferred<unknown>(), io = mockIO(() => pending.promise), controller = new AbortController(); controller.abort();
    await expect(getWorkingStorageContext(io, ROOT, controller.signal, current)).rejects.toThrow();
    await expect(getWorkingStorageContext(io, ROOT, signal(), () => false)).rejects.toThrow(); expect(io.invoke).not.toHaveBeenCalled();
    const later = new AbortController(), result = getWorkingStorageContext(io, ROOT, later.signal, current); expect(io.invoke).toHaveBeenCalledTimes(1);
    later.abort(); pending.resolve(context); await expect(result).rejects.toThrow(); expect(io.invoke).toHaveBeenCalledTimes(1);
  });
  it('pages small summaries only, retaining cursor/order without loading any body or history', async () => {
    const document = ordinary(), first = await summary(document), second = { ...first, id: id(10), storageToken: id(11) };
    const io = mockIO((command, args) => { expect(command).toBe('proposal_working_list'); const r = request(args); expect(r.scope).toEqual(readScope); expect(r.limit).toBe(50);
      expect(Object.keys(r)).toEqual(['scope', 'afterId', 'limit']); return r.afterId === null ? { root: ROOT, items: [first], nextCursor: first.id } : { root: ROOT, items: [second], nextCursor: null }; });
    const page = await listWorkingStorage(io, context, signal(), current); expect(page.items).toEqual([first]);
    expect((await listWorkingStorage(io, context, signal(), current, page.nextCursor)).items).toEqual([second]);
    expect(io.invoke.mock.calls.map(([command]) => command)).toEqual(['proposal_working_list', 'proposal_working_list']);
  });
  it.each(['root', 'duplicate', 'over-limit', 'cursor', 'foreign-field'] as const)('rejects corrupt summary page: %s', async mode => {
    const first = await summary(), value: Request = { root: ROOT, items: [first], nextCursor: null };
    if (mode === 'root') value.root = 'FOREIGN';
    if (mode === 'duplicate') value.items = [first, first];
    if (mode === 'over-limit') value.items = Array.from({ length: 51 }, (_, index) => ({ ...first, id: id(index + 100) }));
    if (mode === 'cursor') value.nextCursor = id(999);
    if (mode === 'foreign-field') value.items[0].documentJson = 'MUST_NOT_BE_LISTED';
    await expect(listWorkingStorage(mockIO(() => value), context, signal(), current)).rejects.toThrow();
  });
  it('refuses an incomplete >500 summary list rather than quietly returning a truncated list', async () => {
    const meta = await summary(); let at = 100;
    const io = mockIO(command => { expect(command).toBe('proposal_working_list'); const items = Array.from({ length: 50 }, () => ({ ...meta, id: id(at++) })); return { root: ROOT, items, nextCursor: items[items.length - 1].id }; });
    const services = createWorkingStorageServices(io, { current });
    await expect(services.list({ binding: await binding() }, signal())).rejects.toThrow(/500/); expect(io.invoke).toHaveBeenCalledTimes(10);
  });
  it('reads saved text and recovery separately without replacing saved text or eagerly loading history', async () => {
    const document = ordinary(), recovered = parseWorkingProposalDocument({ ...document, title: 'SYNTHETIC recovery ONLY', revision: 1 });
    const raw = await savedRead(document); raw.saved.summary.autosaveAvailable = true;
    raw.autosave = { id: document.id, ownerId: OWNER, storageToken: AUTO, baseRecordStorageToken: SAVED, bodySha256: (await fingerprintWorkingProposal(recovered)).slice(7),
      documentRevision: recovered.revision, historySha256: historySHA, consumed: false, documentJson: serializeWorkingProposalDocument(recovered), updatedAt: STAMP };
    const io = mockIO((command, args) => { expect(command).toBe('proposal_working_read'); expect(args).toEqual({ request: { scope: readScope, id: DOC_ID, expectedStorageToken: SAVED } }); return raw; });
    const result = await readWorkingStorage(io, context, DOC_ID, SAVED, signal(), current);
    expect(result.saved!.document).toEqual(document); expect(result.recovery!.document).toEqual(recovered); expect(result.recovery!.ownerId).toBe(OWNER); expect(io.invoke).toHaveBeenCalledTimes(1);
    (raw.autosave as Request).consumed = true; expect((await readWorkingStorage(io, context, DOC_ID, SAVED, signal(), current)).recovery).toBeNull();
  });
  it.each(['root', 'id', 'token', 'body-hash', 'history-hash', 'revision', 'title', 'body', 'extra'] as const)('rejects mismatched saved read: %s', async mode => {
    const value = await savedRead();
    if (mode === 'root') value.root = 'FOREIGN'; if (mode === 'id') value.saved.summary.id = id(999);
    if (mode === 'token') value.saved.summary.storageToken = NEXT; if (mode === 'body-hash') value.saved.summary.bodySha256 = 'e'.repeat(64);
    if (mode === 'history-hash') value.saved.summary.historySha256 = 'e'.repeat(64); if (mode === 'revision') value.saved.summary.documentRevision++;
    if (mode === 'title') value.saved.summary.title += '!'; if (mode === 'body') value.saved.documentJson = '{}';
    if (mode === 'extra') (value.saved as Request).audit = 'PRIVATE';
    await expect(readWorkingStorage(mockIO(() => value), context, DOC_ID, SAVED, signal(), current)).rejects.toThrow();
  });
  it('sends exact canonical bytes/hash/history and a nested fresh mutation scope, not a generic upsert', async () => {
    const document = ordinary(), bound = await binding(document);
    const io = mockIO((command, args) => { expect(command).toBe('proposal_working_save'); const r = request(args);
      expect(r).toEqual({ scope: { expectedRoot: ROOT, leaseGeneration: LEASE, operationId: bound.operationId }, id: DOC_ID, expectedStorageToken: null,
        submittedBodySha256: bound.documentFingerprint.slice(7), documentJson: serializeWorkingProposalDocument(document), historyJson, consumeAutosave: null });
      return writeReceipt(r, 'saved'); });
    const services = createWorkingStorageServices(io, { current, initialHistory: { document, historyJson } });
    expect(await services.save({ binding: bound, document, expectedStorageToken: null }, signal())).toMatchObject({ binding: bound, storageToken: NEXT, documentFingerprint: bound.documentFingerprint });
  });
  it.each(['operation', 'document-id', 'fingerprint', 'viewer', 'aborted', 'stale'] as const)('rejects invalid write context before native call: %s', async mode => {
    const document = ordinary(), bound = await binding(document), controller = new AbortController(), io = mockIO(() => { throw new Error('UNEXPECTED_CALL'); });
    if (mode === 'operation') bound.operationId = 'not-uuid'; if (mode === 'document-id') bound.documentId = id(99);
    if (mode === 'fingerprint') bound.documentFingerprint = `sha256:${'e'.repeat(64)}`; if (mode === 'viewer') bound.leaseGeneration = null;
    if (mode === 'aborted') controller.abort(); const services = createWorkingStorageServices(io, { current: () => mode !== 'stale' });
    await expect(services.save({ binding: bound, document, expectedStorageToken: null }, controller.signal)).rejects.toThrow(); expect(io.invoke).not.toHaveBeenCalled();
  });
  it.each([
    ['op', (v: Request) => { v.operationId = id(100); }], ['root', (v: Request) => { v.root = 'FOREIGN'; }], ['id', (v: Request) => { v.id = id(100); }],
    ['action', (v: Request) => { v.action = 'autosaved'; }], ['expected-CAS', (v: Request) => { v.expectedStorageToken = null; }],
    ['invalid-CAS', (v: Request) => { v.storageToken = 'not-uuid'; }], ['unchanged-CAS', (v: Request) => { v.storageToken = SAVED; }],
    ['body-hash', (v: Request) => { v.submittedBodySha256 = 'e'.repeat(64); }], ['revision', (v: Request) => { v.documentRevision = 1; }],
    ['history-hash', (v: Request) => { v.historySha256 = 'e'.repeat(64); }], ['extra', (v: Request) => { v.approval = true; }],
    ['missing', (v: Request) => { delete v.consumedAutosave; }], ['unowned-consume', (v: Request) => { v.consumedAutosave = { previousStorageToken: AUTO, storageToken: TOMBSTONE }; }],
  ] as const)('rejects uncorrelated save receipt: %s', async (_label, change) => {
    const document = ordinary(), bound = await binding(document), io = mockIO((_command, args) => { const value = writeReceipt(request(args), 'saved'); change(value); return value; });
    await expect(createWorkingStorageServices(io, { current }).save({ binding: bound, document, expectedStorageToken: SAVED }, signal())).rejects.toThrow(); expect(io.invoke).toHaveBeenCalledTimes(1);
  });
  it('does not call native if context changes during hashing; a late save ack cannot announce success or trigger retry', async () => {
    const document = ordinary(), bound = await binding(document); let fresh = true;
    const io = mockIO(() => { throw new Error('UNEXPECTED_CALL'); }), nativeDigest = crypto.subtle.digest.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(async (...args) => { const value = await nativeDigest(...args); fresh = false; return value; });
    await expect(createWorkingStorageServices(io, { current: () => fresh }).save({ binding: bound, document, expectedStorageToken: null }, signal())).rejects.toThrow(); expect(io.invoke).not.toHaveBeenCalled();
    vi.restoreAllMocks(); fresh = true; const pending = deferred<unknown>(), started = deferred<void>();
    const lateIO = mockIO((_command, args) => { started.resolve(); return pending.promise.then(() => writeReceipt(request(args), 'saved')); });
    const services = createWorkingStorageServices(lateIO, { current: () => fresh }), result = services.save({ binding: bound, document, expectedStorageToken: null }, signal());
    await started.promise; fresh = false; pending.resolve(null); await expect(result).rejects.toThrow(/устарела/); expect(lateIO.invoke).toHaveBeenCalledTimes(1);
  });
  it.each([
    { method: 'save', invalidate: 'abort' }, { method: 'save', invalidate: 'current' },
    { method: 'autosave', invalidate: 'abort' }, { method: 'autosave', invalidate: 'current' },
  ] as const)('rechecks $method before native write when $invalidate changes in the outer await continuation gap', async ({ method, invalidate }) => {
    const document = ordinary(), bound = await binding(document), controller = new AbortController();
    const events: string[] = []; let fresh = true, checks = 0, lastInnerAccepted = false, invalidationRan = false, writes = 0;
    const io = mockIO((command, args) => {
      writes++; events.push('native-write');
      expect(command).toBe(method === 'save' ? 'proposal_working_save' : 'proposal_working_autosave');
      return writeReceipt(request(args), method === 'save' ? 'saved' : 'autosaved');
    });
    const services = createWorkingStorageServices(io, { current: () => {
      const accepted = fresh; checks++; events.push(`current:${checks}:${accepted}`);
      // No initialHistory: check #2 is body's LAST post-digest gate. It
      // accepts TRUE; only its queued microtask invalidates the outer caller.
      // An old implementation would WRITE once and fail only after that I/O.
      if (checks === 2) {
        lastInnerAccepted = accepted;
        queueMicrotask(() => {
          invalidationRan = true; events.push(`invalidate:${invalidate}`);
          if (invalidate === 'abort') controller.abort(); else fresh = false;
        });
      }
      return accepted;
    } });
    const pending = method === 'save'
      ? services.save({ binding: bound, document, expectedStorageToken: null }, controller.signal)
      : services.autosave!({ binding: bound, document, autosaveOwnerId: OWNER, expectedAutosaveToken: null, baseRecordStorageToken: null }, controller.signal);
    await expect(pending).rejects.toThrow(/устарела/); events.push('rejected');
    expect(lastInnerAccepted).toBe(true); expect(invalidationRan).toBe(true);
    expect(writes).toBe(0); expect(io.invoke).not.toHaveBeenCalled(); expect(io.chooseSavePath).not.toHaveBeenCalled();
    expect(events).toEqual(invalidate === 'abort'
      ? ['current:1:true', 'current:2:true', 'invalidate:abort', 'rejected']
      : ['current:1:true', 'current:2:true', 'invalidate:current', 'current:3:false', 'rejected']);
  });
  it('autosave→Save consumes once, second Save omits consume, and next autosave uses the rotated tombstone/base record CAS', async () => {
    const document = ordinary(); let autosaves = 0, saves = 0;
    const io = mockIO((command, args) => { const r = request(args);
      if (command === 'proposal_working_autosave') {
        expect(r.scope).toEqual({ expectedRoot: ROOT, leaseGeneration: LEASE, operationId: r.scope.operationId });
        expect(r.ownerId).toBe(OWNER); expect(r.expectedStorageToken).toBe(autosaves ? TOMBSTONE : null); expect(r.baseRecordStorageToken).toBe(autosaves ? NEXT : null);
        return writeReceipt(r, 'autosaved', autosaves++ ? id(20) : AUTO);
      }
      expect(command).toBe('proposal_working_save'); expect(r.expectedStorageToken).toBe(saves ? SAVED : null);
      expect(r.consumeAutosave).toEqual(saves ? null : { ownerId: OWNER, storageToken: AUTO, bodySha256: r.submittedBodySha256 });
      return writeReceipt(r, 'saved', saves++ ? NEXT : SAVED, saves === 1 ? { previousStorageToken: AUTO, storageToken: TOMBSTONE } : null);
    });
    const services = createWorkingStorageServices(io, { current });
    const first = await services.autosave!({ binding: await binding(document), document, autosaveOwnerId: OWNER, expectedAutosaveToken: null, baseRecordStorageToken: null }, signal());
    expect(first.autosaveToken).toBe(AUTO);
    const saved = await services.save({ binding: await binding(document), document, expectedStorageToken: null }, signal());
    expect(saved.consumedAutosave).toEqual({ previousToken: AUTO, nextToken: TOMBSTONE });
    const second = await services.save({ binding: await binding(document), document, expectedStorageToken: saved.storageToken }, signal()); expect(second.consumedAutosave).toBeUndefined();
    await services.autosave!({ binding: await binding(document), document, autosaveOwnerId: OWNER, expectedAutosaveToken: saved.consumedAutosave!.nextToken, baseRecordStorageToken: second.storageToken }, signal());
    expect(autosaves).toBe(2); expect(saves).toBe(2);
  });
  it('clears old bridge recovery consumption when explicitly reopening the saved version of the same ID', async () => {
    const document = ordinary(), opened = await savedRead(document);
    const io = mockIO((command, args) => {
      if (command === 'proposal_working_read') return opened;
      const r = request(args); if (command === 'proposal_working_autosave') return writeReceipt(r, 'autosaved', AUTO);
      expect(command).toBe('proposal_working_save'); expect(r.consumeAutosave).toBeNull(); return writeReceipt(r, 'saved', NEXT);
    });
    const services = createWorkingStorageServices(io, { current });
    await services.autosave!({ binding: await binding(document), document, autosaveOwnerId: OWNER, expectedAutosaveToken: null, baseRecordStorageToken: SAVED }, signal());
    await services.open({ binding: await binding(document), id: document.id, storageToken: SAVED }, signal());
    await expect(services.save({ binding: await binding(document), document, expectedStorageToken: SAVED }, signal())).resolves.toMatchObject({ storageToken: NEXT });
  });
  it.each([false, true])('retains only storage owner/CAS from a consumed historical recovery (cleared=%s) for safe next autosave', async cleared => {
    const document = ordinary(), opened = await savedRead(document);
    opened.autosave = { id: document.id, ownerId: OWNER, storageToken: TOMBSTONE, baseRecordStorageToken: null,
      bodySha256: (await fingerprintWorkingProposal(document)).slice(7), documentRevision: document.revision, historySha256: historySHA,
      consumed: true, documentJson: cleared ? null : serializeWorkingProposalDocument(document), updatedAt: STAMP };
    const io = mockIO((command, args) => {
      if (command === 'proposal_working_read') { expect(request(args).scope).toEqual(readScope); return opened; }
      expect(command).toBe('proposal_working_autosave'); const r = request(args);
      expect(r.ownerId).toBe(OWNER); expect(r.expectedStorageToken).toBe(TOMBSTONE); expect(r.baseRecordStorageToken).toBe(SAVED);
      return writeReceipt(r, 'autosaved', AUTO);
    });
    const stored = await readWorkingStorage(io, context, DOC_ID, SAVED, signal(), current);
    expect(stored.recovery).toBeNull(); expect(stored.consumedRecovery).toEqual({ ownerId: OWNER, storageToken: TOMBSTONE });
    const services = createWorkingStorageServices(io, { current }), result = await services.open({ binding: await binding(document), id: DOC_ID, storageToken: SAVED }, signal());
    expect(result.recovery).toEqual({ ownerId: OWNER, storageToken: TOMBSTONE });
    if (!result.recovery || result.recovery === 'protected') throw new Error('Expected exact storage-only tombstone, never authentication');
    const next = await services.autosave!({ binding: await binding(document), document, autosaveOwnerId: result.recovery.ownerId,
      expectedAutosaveToken: result.recovery.storageToken, baseRecordStorageToken: result.storageToken }, signal());
    expect(next.autosaveToken).toBe(AUTO); expect(io.invoke.mock.calls.map(([command]) => command)).toEqual(['proposal_working_read', 'proposal_working_read', 'proposal_working_autosave']);
  });
  it('reports an unconsumed recovery as protected instead of adopting its owner/CAS or consuming it during explicit Save', async () => {
    const document = ordinary(), opened = await savedRead(document);
    opened.autosave = { id: document.id, ownerId: id(99), storageToken: AUTO, baseRecordStorageToken: SAVED,
      bodySha256: (await fingerprintWorkingProposal(document)).slice(7), documentRevision: document.revision, historySha256: historySHA,
      consumed: false, documentJson: serializeWorkingProposalDocument(document), updatedAt: STAMP };
    const io = mockIO((command, args) => {
      if (command === 'proposal_working_read') return opened;
      expect(command).toBe('proposal_working_save'); const r = request(args); expect(r.consumeAutosave).toBeNull(); return writeReceipt(r, 'saved', NEXT);
    });
    const stored = await readWorkingStorage(io, context, DOC_ID, SAVED, signal(), current);
    expect(stored.consumedRecovery).toBeNull(); expect(stored.recovery!.ownerId).toBe(id(99));
    const services = createWorkingStorageServices(io, { current }), result = await services.open({ binding: await binding(document), id: DOC_ID, storageToken: SAVED }, signal());
    expect(result.recovery).toBe('protected'); expect(result.document).toEqual(document);
    await expect(services.save({ binding: await binding(document), document, expectedStorageToken: SAVED }, signal())).resolves.toMatchObject({ storageToken: NEXT });
    expect(io.invoke.mock.calls.map(([command]) => command)).toEqual(['proposal_working_read', 'proposal_working_read', 'proposal_working_save']);
    expect((opened.autosave as Request).consumed).toBe(false);
  });
  it('keeps history lazy, reports missing/corrupt history and leaves ordinary text unchanged', async () => {
    const document = ordinary(), before = serializeWorkingProposalDocument(document); let raw: unknown = null;
    const io = mockIO((command, args) => { expect(command).toBe('proposal_working_read_history'); expect(args).toEqual({ request: { scope: readScope, historySha256: historySHA } }); return raw; });
    const services = createWorkingStorageServices(io, { current }), bound = await binding(document); expect(io.invoke).not.toHaveBeenCalled();
    await expect(services.history!({ binding: bound, reference: document.historicalSource }, signal())).rejects.toThrow(/недоступен/);
    raw = { root: ROOT, kind: 'unvalidated-history', sha256: historySHA, bytes: document.historicalSource.bytes, historyJson: historyJson.replace('SYNTHETIC_PRIVATE_HISTORY', 'SYNTHETIC_CHANGED_HISTORY') };
    await expect(services.history!({ binding: bound, reference: document.historicalSource }, signal())).rejects.toThrow();
    raw = { root: ROOT, kind: 'unvalidated-history', sha256: historySHA, bytes: document.historicalSource.bytes, historyJson };
    const result = await services.history!({ binding: bound, reference: document.historicalSource }, signal());
    expect(await inspectWorkingProposalHistory(document, result.text)).toEqual({ state: 'available-unvalidated', warning: null }); expect(serializeWorkingProposalDocument(document)).toBe(before);
    expect(document).not.toHaveProperty('humanApproval'); expect(document).not.toHaveProperty('audit');
  });
  it('rejects a corrupt initial history before any persistence call', async () => {
    const document = ordinary(), io = mockIO(() => { throw new Error('UNEXPECTED_CALL'); });
    const services = createWorkingStorageServices(io, { current, initialHistory: { document, historyJson: `${historyJson} ` } });
    await expect(services.save({ binding: await binding(document), document, expectedStorageToken: null }, signal())).rejects.toThrow(); expect(io.invoke).not.toHaveBeenCalled();
  });
  it('exports only exact final public bytes/hash to an explicit chosen path and correlates requested versus canonical output paths', async () => {
    const value = await finalRequest();
    const io = mockIO((command, args) => { expect(command).toBe('proposal_working_render'); const r = request(args);
      expect(r).toEqual({ scope: readScope, operationId: value.binding.operationId, jobId: value.binding.operationId, publicJson: JSON.stringify(value.publicDocument),
        publicSha256: value.clientProjectionFingerprint.slice(7), format: 'docx', outputPath: '/SYNTHETIC_ONLY/not-written.docx' });
      for (const privateField of ['SYNTHETIC_PRIVATE_ANSWER', 'SYNTHETIC_PRIVATE_HISTORY', 'historicalSource', 'frameId', 'questions', 'humanApproval', 'audit']) expect(r.publicJson).not.toContain(privateField);
      return { ...renderReceipt(r), outputPath: '/SYNTHETIC_CANONICAL/not-written.docx' };
    });
    expect(await createWorkingStorageServices(io, { current }).export!(value, signal())).toMatchObject({ binding: value.binding, fileName: '/SYNTHETIC_CANONICAL/not-written.docx' });
    expect(io.chooseSavePath).toHaveBeenCalledExactlyOnceWith('docx', value.publicDocument.title);
  });
  it.each(['fingerprint', 'review-draft'] as const)('refuses export %s before dialog or renderer', async mode => {
    const value = await finalRequest(); if (mode === 'fingerprint') value.clientProjectionFingerprint = `sha256:${'e'.repeat(64)}`;
    else value.publicDocument = { ...value.publicDocument, mode: 'review-draft' };
    const io = mockIO(() => { throw new Error('UNEXPECTED_CALL'); }); await expect(createWorkingStorageServices(io, { current }).export!(value, signal())).rejects.toThrow();
    expect(io.invoke).not.toHaveBeenCalled(); expect(io.chooseSavePath).not.toHaveBeenCalled();
  });
  it('cancelled path selection or abort while choosing never starts a renderer', async () => {
    const value = await finalRequest(), io = mockIO(() => { throw new Error('UNEXPECTED_CALL'); }); io.chooseSavePath.mockResolvedValueOnce(null);
    const services = createWorkingStorageServices(io, { current }); await expect(services.export!(value, signal())).rejects.toThrow(/отменено/); expect(io.invoke).not.toHaveBeenCalled();
    const controller = new AbortController(); io.chooseSavePath.mockImplementationOnce(async () => { controller.abort(); return '/SYNTHETIC_ONLY/not-written.docx'; });
    await expect(services.export!(value, controller.signal)).rejects.toThrow(); expect(io.invoke).not.toHaveBeenCalled();
  });
  it.each([
    ['op', (v: Request) => { v.operationId = id(999); }], ['root', (v: Request) => { v.root = 'FOREIGN'; }],
    ['public-hash', (v: Request) => { v.publicSha256 = 'e'.repeat(64); }], ['format', (v: Request) => { v.format = 'pdf'; }],
    ['requested-path', (v: Request) => { v.requestedOutputPath = '/FOREIGN/not-chosen.docx'; }], ['empty-output', (v: Request) => { v.outputPath = ''; }],
    ['output-hash', (v: Request) => { v.outputSha256 = 'not-a-hash'; }], ['extra', (v: Request) => { v.approval = true; }],
  ] as const)('rejects mismatched render acknowledgement: %s', async (_label, change) => {
    const value = await finalRequest(), io = mockIO((_command, args) => { const receipt = renderReceipt(request(args)); change(receipt); return receipt; });
    await expect(createWorkingStorageServices(io, { current }).export!(value, signal())).rejects.toThrow(); expect(io.invoke).toHaveBeenCalledTimes(1);
  });
  it('aborting an already-started synthetic render requests cancellation once and refuses late success without retry', async () => {
    const value = await finalRequest(), pending = deferred<unknown>(), started = deferred<void>(), controller = new AbortController(); let rendered: Request | undefined;
    const io = mockIO((command, args) => { if (command === 'scanner_cancel') { expect(args).toEqual({ jobId: value.binding.operationId }); return null; }
      expect(command).toBe('proposal_working_render'); rendered = request(args); started.resolve(); return pending.promise; });
    const result = createWorkingStorageServices(io, { current }).export!(value, controller.signal); await started.promise; controller.abort(); pending.resolve(renderReceipt(rendered!));
    await expect(result).rejects.toThrow(/устарела/); expect(io.invoke.mock.calls.map(([command]) => command)).toEqual(['proposal_working_render', 'scanner_cancel']);
  });
});
