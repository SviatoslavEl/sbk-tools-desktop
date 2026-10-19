import type { ProposalWorkingBinding, ProposalWorkingServices } from './ProposalWorkingWorkspace';
import { fingerprintWorkingProposal, inspectWorkingProposalHistory, parseWorkingProposalDocument, serializeWorkingProposalDocument,
  type WorkingProposalDocument } from './workingDocument';

/** All I/O is injected. No browser fallback, generic record write, provider call,
 * restored model capability, or whole-history read is hidden in a summary. */
export interface WorkingStorageIO {
  invoke(command: string, args: Record<string, unknown>): Promise<unknown>;
  chooseSavePath(format: 'docx' | 'pdf', title: string): Promise<string | null>;
}
export interface WorkingStorageContext { root: string; canWrite: boolean; leaseGeneration: string | null }
export interface WorkingStorageSummary {
  id: string; title: string; storageToken: string | null; documentRevision: number; bodySha256: string;
  historySha256: string; updatedAt: string; autosaveAvailable: boolean; recordSaved: boolean;
}
export interface WorkingStorageRead {
  saved: { document: WorkingProposalDocument; summary: WorkingStorageSummary } | null;
  recovery: { document: WorkingProposalDocument; token: string; ownerId: string; baseRecordStorageToken: string | null } | null;
  consumedRecovery: { ownerId: string; storageToken: string } | null;
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const sha = /^[a-f0-9]{64}$/u;
const error = (): never => { throw new Error('Не удалось подтвердить папку, права или точную редакцию КП. Открытый текст не заменён.'); };
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).length !== keys.length || keys.some(key => !Object.prototype.hasOwnProperty.call(value, key))) return error();
  return value as Record<string, unknown>;
}
function token(value: unknown): asserts value is string { if (typeof value !== 'string' || !uuid.test(value)) error(); }
function nullableToken(value: unknown): asserts value is string | null { if (value !== null) token(value); }
function hash(value: unknown): asserts value is string { if (typeof value !== 'string' || !sha.test(value)) error(); }
function revision(value: unknown): asserts value is number { if (!Number.isSafeInteger(value) || (value as number) < 0) error(); }
function date(value: unknown): asserts value is string { if (typeof value !== 'string' || value.length > 100 || !Number.isFinite(Date.parse(value))) error(); }
async function digest(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), n => n.toString(16).padStart(2, '0')).join('');
}
function live(signal: AbortSignal, current: () => boolean) { if (signal.aborted || !current()) throw new Error('Операция устарела или ожидание остановлено. Уже отправленная запись могла завершиться; откройте список заново, не повторяя её автоматически.'); }
const readScope = (context: WorkingStorageContext) => ({ expectedRoot: context.root, expectedLeaseGeneration: context.leaseGeneration });
export async function getWorkingStorageContext(io: WorkingStorageIO, root: string, signal: AbortSignal, current: () => boolean): Promise<WorkingStorageContext> {
  live(signal, current); const raw = await io.invoke('proposal_working_context', { request: { expectedRoot: root } }); live(signal, current);
  const value = object(raw, ['root', 'canWrite', 'leaseGeneration']); nullableToken(value.leaseGeneration);
  if (value.root !== root || typeof value.canWrite !== 'boolean' || value.canWrite !== (value.leaseGeneration !== null)) error();
  return { root, canWrite: value.canWrite as boolean, leaseGeneration: value.leaseGeneration };
}
function summary(raw: unknown): WorkingStorageSummary {
  const value = object(raw, ['id', 'title', 'storageToken', 'documentRevision', 'bodySha256', 'historySha256', 'updatedAt', 'autosaveAvailable', 'recordSaved']);
  token(value.id); nullableToken(value.storageToken); hash(value.bodySha256); hash(value.historySha256); revision(value.documentRevision); date(value.updatedAt);
  if (typeof value.title !== 'string' || Array.from(value.title).length > 500 || typeof value.autosaveAvailable !== 'boolean'
    || typeof value.recordSaved !== 'boolean' || value.recordSaved !== (value.storageToken !== null)) error();
  return value as unknown as WorkingStorageSummary;
}
export async function listWorkingStorage(io: WorkingStorageIO, context: WorkingStorageContext, signal: AbortSignal, current: () => boolean, afterId: string | null = null): Promise<{ items: WorkingStorageSummary[]; nextCursor: string | null }> {
  nullableToken(afterId); live(signal, current);
  const raw = await io.invoke('proposal_working_list', { request: { scope: readScope(context), afterId, limit: 50 } }); live(signal, current);
  const value = object(raw, ['root', 'items', 'nextCursor']); nullableToken(value.nextCursor);
  if (value.root !== context.root || !Array.isArray(value.items) || value.items.length > 50) error();
  const items = (value.items as unknown[]).map(summary);
  if (items.some((item, index) => item.id <= (index ? items[index - 1].id : afterId ?? ''))
    || value.nextCursor !== null && value.nextCursor !== items[items.length - 1]?.id) error();
  return { items, nextCursor: value.nextCursor };
}
async function checkedBody(raw: unknown, id: string, bodySha: unknown, documentRevision: unknown, historySha: unknown) {
  hash(bodySha); hash(historySha); revision(documentRevision);
  const document = parseWorkingProposalDocument(raw);
  if (document.id !== id || document.revision !== documentRevision || document.historicalSource.sha256 !== historySha
    || typeof raw !== 'string' || await digest(raw) !== bodySha || await fingerprintWorkingProposal(document) !== `sha256:${bodySha}`) error();
  return document;
}
export async function readWorkingStorage(io: WorkingStorageIO, context: WorkingStorageContext, id: string, expectedStorageToken: string | null,
  signal: AbortSignal, current: () => boolean): Promise<WorkingStorageRead> {
  token(id); nullableToken(expectedStorageToken); live(signal, current);
  const raw = await io.invoke('proposal_working_read', { request: { scope: readScope(context), id, expectedStorageToken } }); live(signal, current);
  const value = object(raw, ['root', 'saved', 'autosave']); if (value.root !== context.root) error();
  let saved: WorkingStorageRead['saved'] = null, recovery: WorkingStorageRead['recovery'] = null, consumedRecovery: WorkingStorageRead['consumedRecovery'] = null;
  if (value.saved !== null) {
    const stored = object(value.saved, ['summary', 'documentJson']), meta = summary(stored.summary);
    const document = await checkedBody(stored.documentJson, id, meta.bodySha256, meta.documentRevision, meta.historySha256); live(signal, current);
    if (!meta.recordSaved || meta.id !== id || document.title !== meta.title || expectedStorageToken !== null && meta.storageToken !== expectedStorageToken) error();
    saved = { document, summary: meta };
  } else if (expectedStorageToken !== null) error();
  if (value.autosave !== null) {
    const stored = object(value.autosave, ['id', 'ownerId', 'storageToken', 'baseRecordStorageToken', 'bodySha256', 'documentRevision', 'historySha256', 'consumed', 'documentJson', 'updatedAt']);
    token(stored.ownerId); token(stored.storageToken); nullableToken(stored.baseRecordStorageToken); hash(stored.bodySha256); hash(stored.historySha256); revision(stored.documentRevision); date(stored.updatedAt);
    if (stored.id !== id || typeof stored.consumed !== 'boolean') error();
    if (stored.consumed) consumedRecovery = { ownerId: stored.ownerId, storageToken: stored.storageToken };
    if (stored.documentJson !== null) {
      const document = await checkedBody(stored.documentJson, id, stored.bodySha256, stored.documentRevision, stored.historySha256); live(signal, current);
      if (!stored.consumed) recovery = { document, token: stored.storageToken, ownerId: stored.ownerId, baseRecordStorageToken: stored.baseRecordStorageToken };
    } else if (!stored.consumed) error();
  }
  return { saved, recovery, consumedRecovery };
}

/** UI bindings are only freshness correlation. Native commands independently
 * enforce exact root/fresh editor generation/CAS before committing a write. */
export function createWorkingStorageServices(io: WorkingStorageIO, options: {
  current(binding: ProposalWorkingBinding): boolean;
  initialHistory?: { document: WorkingProposalDocument; historyJson: string };
}): ProposalWorkingServices {
  let pendingHistory = options.initialHistory;
  const recoveries = new Map<string, { ownerId: string; token: string; bodySha: string }>();
  function gate(binding: ProposalWorkingBinding, signal: AbortSignal, write = false) {
    token(binding.operationId); token(binding.documentId); nullableToken(binding.leaseGeneration); revision(binding.documentRevision);
    if (!/^sha256:[a-f0-9]{64}$/u.test(binding.documentFingerprint)) error();
    live(signal, () => options.current(binding)); if (write && binding.leaseGeneration === null) throw new Error('Сохранение общей базы доступно только текущему редактору.');
  }
  const context = (binding: ProposalWorkingBinding): WorkingStorageContext => ({ root: binding.workspaceRoot, leaseGeneration: binding.leaseGeneration, canWrite: binding.leaseGeneration !== null });
  const mutationScope = (binding: ProposalWorkingBinding) => ({ expectedRoot: binding.workspaceRoot, leaseGeneration: binding.leaseGeneration, operationId: binding.operationId });
  async function body(binding: ProposalWorkingBinding, document: WorkingProposalDocument, signal: AbortSignal) {
    gate(binding, signal, true); const documentJson = serializeWorkingProposalDocument(document), bodySha = await digest(documentJson); gate(binding, signal, true);
    if (document.id !== binding.documentId || document.revision !== binding.documentRevision || binding.documentFingerprint !== `sha256:${bodySha}`) error();
    let historyJson: string | null = null;
    if (pendingHistory?.document.historicalSource.sha256 === document.historicalSource.sha256) {
      historyJson = pendingHistory.historyJson;
      if ((await inspectWorkingProposalHistory(document, historyJson)).state !== 'available-unvalidated') error(); gate(binding, signal, true);
    }
    return { documentJson, bodySha, historyJson };
  }
  function receipt(raw: unknown, binding: ProposalWorkingBinding, action: string, expected: string | null, bodySha: string, document: WorkingProposalDocument) {
    const value = object(raw, ['operationId', 'root', 'id', 'action', 'expectedStorageToken', 'storageToken', 'submittedBodySha256', 'documentRevision', 'historySha256', 'updatedAt', 'consumedAutosave']);
    token(value.storageToken); date(value.updatedAt);
    if (value.operationId !== binding.operationId || value.root !== binding.workspaceRoot || value.id !== binding.documentId || value.action !== action
      || value.expectedStorageToken !== expected || value.storageToken === expected || value.submittedBodySha256 !== bodySha
      || value.documentRevision !== document.revision || value.historySha256 !== document.historicalSource.sha256) error();
    return value;
  }
  return {
    async list({ binding }, signal) {
      gate(binding, signal); const summaries: Array<{ id: string; title: string; storageToken: string; updatedAt: string }> = []; let after: string | null = null;
      for (let page = 0; page < 10; page++) {
        const listed = await listWorkingStorage(io, context(binding), signal, () => options.current(binding), after); gate(binding, signal);
        summaries.push(...listed.items.filter(item => item.recordSaved).map(item => ({ id: item.id, title: item.title, storageToken: item.storageToken!, updatedAt: item.updatedAt })));
        if (listed.nextCursor === null) return { binding, summaries }; after = listed.nextCursor;
      }
      throw new Error('Список превышает 500 записей. Используйте постраничный список рабочих КП в инструменте КП. Неполный список не подставлен.');
    },
    async open({ binding, id, storageToken }, signal) {
      gate(binding, signal); token(storageToken);
      const loaded = await readWorkingStorage(io, context(binding), id, storageToken, signal, () => options.current(binding)); gate(binding, signal);
      if (!loaded.saved || loaded.saved.summary.storageToken !== storageToken) return error();
      // Recovery is deliberately NOT merged into the saved document.
      recoveries.delete(id);
      return { binding, document: loaded.saved.document, storageToken, documentFingerprint: `sha256:${loaded.saved.summary.bodySha256}`,
        recovery: loaded.recovery ? 'protected' : loaded.consumedRecovery ?? undefined };
    },
    async save({ binding, document, expectedStorageToken }, signal) {
      nullableToken(expectedStorageToken); const submitted = await body(binding, document, signal), recovery = recoveries.get(document.id);
      const consumeAutosave = recovery ? { ownerId: recovery.ownerId, storageToken: recovery.token, bodySha256: recovery.bodySha } : null;
      const raw = await io.invoke('proposal_working_save', { request: { scope: mutationScope(binding), id: document.id, expectedStorageToken,
        submittedBodySha256: submitted.bodySha, documentJson: submitted.documentJson, historyJson: submitted.historyJson, consumeAutosave } }); gate(binding, signal, true);
      const saved = receipt(raw, binding, 'saved', expectedStorageToken, submitted.bodySha, document);
      let consumedAutosave: { previousToken: string; nextToken: string } | undefined;
      if (recovery) {
        const consumed = object(saved.consumedAutosave, ['previousStorageToken', 'storageToken']); token(consumed.storageToken);
        if (consumed.previousStorageToken !== recovery.token || consumed.storageToken === recovery.token) error();
        consumedAutosave = { previousToken: recovery.token, nextToken: consumed.storageToken };
        // Keep the next CAS in the UI, but never consume this tombstone twice.
        recoveries.delete(document.id);
      } else if (saved.consumedAutosave !== null) error();
      pendingHistory = undefined;
      return { binding, storageToken: saved.storageToken as string, documentFingerprint: binding.documentFingerprint, consumedAutosave };
    },
    async autosave({ binding, document, autosaveOwnerId, expectedAutosaveToken, baseRecordStorageToken }, signal) {
      token(autosaveOwnerId); nullableToken(expectedAutosaveToken); nullableToken(baseRecordStorageToken);
      const submitted = await body(binding, document, signal);
      const raw = await io.invoke('proposal_working_autosave', { request: { scope: mutationScope(binding), id: document.id, ownerId: autosaveOwnerId,
        expectedStorageToken: expectedAutosaveToken, baseRecordStorageToken, submittedBodySha256: submitted.bodySha, documentJson: submitted.documentJson, historyJson: submitted.historyJson } }); gate(binding, signal, true);
      const saved = receipt(raw, binding, 'autosaved', expectedAutosaveToken, submitted.bodySha, document); if (saved.consumedAutosave !== null) error();
      recoveries.set(document.id, { ownerId: autosaveOwnerId, token: saved.storageToken as string, bodySha: submitted.bodySha });
      return { binding, autosaveOwnerId, autosaveToken: saved.storageToken as string, documentFingerprint: binding.documentFingerprint };
    },
    async history({ binding, reference }, signal) {
      gate(binding, signal); hash(reference.sha256);
      if (pendingHistory?.document.historicalSource.sha256 === reference.sha256) return { binding, text: pendingHistory.historyJson };
      const raw = await io.invoke('proposal_working_read_history', { request: { scope: readScope(context(binding)), historySha256: reference.sha256 } }); gate(binding, signal);
      if (raw === null) throw new Error('Исходный контекст недоступен. Текст рабочего КП не изменён.');
      const value = object(raw, ['root', 'kind', 'sha256', 'bytes', 'historyJson']);
      if (value.root !== binding.workspaceRoot || value.kind !== 'unvalidated-history' || value.sha256 !== reference.sha256 || value.bytes !== reference.bytes
        || typeof value.historyJson !== 'string' || new TextEncoder().encode(value.historyJson).byteLength !== reference.bytes || await digest(value.historyJson) !== reference.sha256) error();
      gate(binding, signal); return { binding, text: value.historyJson as string };
    },
    async export({ binding, format, publicDocument, clientProjectionFingerprint }, signal) {
      gate(binding, signal); if (!['docx', 'pdf'].includes(format) || publicDocument.schemaVersion !== 3 || publicDocument.mode !== 'final') error();
      const publicJson = JSON.stringify(publicDocument), publicSha256 = await digest(publicJson); gate(binding, signal);
      if (clientProjectionFingerprint !== `sha256:${publicSha256}`) error();
      const outputPath = await io.chooseSavePath(format, publicDocument.title); gate(binding, signal);
      if (!outputPath) throw new Error('Создание файла отменено. Черновик оставлен в окне.');
      const cancel = () => { void io.invoke('scanner_cancel', { jobId: binding.operationId }).catch(() => undefined); };
      signal.addEventListener('abort', cancel, { once: true });
      try {
        gate(binding, signal);
        const raw = await io.invoke('proposal_working_render', { request: { scope: readScope(context(binding)), operationId: binding.operationId, jobId: binding.operationId,
          publicJson, publicSha256, format, outputPath } }); gate(binding, signal);
        const value = object(raw, ['operationId', 'root', 'publicSha256', 'format', 'requestedOutputPath', 'outputPath', 'outputSha256']); hash(value.outputSha256);
        if (value.operationId !== binding.operationId || value.root !== binding.workspaceRoot || value.publicSha256 !== publicSha256 || value.format !== format
          || value.requestedOutputPath !== outputPath || typeof value.outputPath !== 'string' || !value.outputPath) error();
        return { binding, format, clientProjectionFingerprint, fileName: value.outputPath as string };
      } finally { signal.removeEventListener('abort', cancel); }
    },
  };
}
