import { useEffect, useId, useRef, useState } from 'react';
import {
  createWorkingProposalReviewIntent, editWorkingProposal, fingerprintWorkingProposal,
  fingerprintWorkingProposalPublic, inspectWorkingProposalHistory, parseWorkingProposalDocument, projectWorkingProposalPublic,
  serializeWorkingProposalDocument, type WorkingProposalDocument, type WorkingProposalPublicDocument,
} from './workingDocument';
import './working-proposal.css';

export interface ProposalWorkingContext {
  workspaceRoot: string;
  /** Current opaque session/lease generation; never persisted in the document. */
  leaseGeneration: string | null;
  taskKey: string;
  access: 'editor' | 'viewer';
  stale: boolean;
}
export interface ProposalWorkingBinding {
  operationId: string; sessionKey: string; workspaceRoot: string; leaseGeneration: string | null; taskKey: string;
  documentId: string; documentRevision: number; documentFingerprint: string;
}
export interface ProposalWorkingSummary { id: string; title: string; storageToken: string; updatedAt: string | null; }
/** Storage correlation only, never editor authorization or model approval. A
 * live unconsumed recovery must not be overwritten by opening a saved record. */
export type ProposalWorkingRecovery = { ownerId: string; storageToken: string } | 'protected';
export interface ProposalWorkingSaveRequest {
  binding: ProposalWorkingBinding; document: WorkingProposalDocument; expectedStorageToken: string | null;
}
export interface ProposalWorkingSaveReceipt {
  binding: ProposalWorkingBinding; storageToken: string; documentFingerprint: string;
  consumedAutosave?: { previousToken: string; nextToken: string };
}
export interface ProposalWorkingAutosaveRequest {
  binding: ProposalWorkingBinding; document: WorkingProposalDocument; autosaveOwnerId: string;
  expectedAutosaveToken: string | null; baseRecordStorageToken: string | null;
}
export interface ProposalWorkingAutosaveReceipt {
  binding: ProposalWorkingBinding; autosaveOwnerId: string; autosaveToken: string; documentFingerprint: string;
}
/** The bridge must enforce root/lease/CAS under its own storage boundary. UI
 * freshness checks do not undo an unauthorized backend write or file render. */
export interface ProposalWorkingServices {
  list(request: { binding: ProposalWorkingBinding }, signal: AbortSignal): Promise<{ binding: ProposalWorkingBinding; summaries: readonly ProposalWorkingSummary[] }>;
  open(request: { binding: ProposalWorkingBinding; id: string; storageToken: string }, signal: AbortSignal): Promise<{
    binding: ProposalWorkingBinding; document: unknown; storageToken: string; documentFingerprint: string; recovery?: ProposalWorkingRecovery;
  }>;
  save(request: ProposalWorkingSaveRequest, signal: AbortSignal): Promise<ProposalWorkingSaveReceipt>;
  /** Separate recovery namespace/token; never reported as an explicit Save. */
  autosave?(request: ProposalWorkingAutosaveRequest, signal: AbortSignal): Promise<ProposalWorkingAutosaveReceipt>;
  history?(request: { binding: ProposalWorkingBinding; reference: WorkingProposalDocument['historicalSource'] }, signal: AbortSignal): Promise<{ binding: ProposalWorkingBinding; text: string }>;
  export?(request: { binding: ProposalWorkingBinding; format: 'docx' | 'pdf'; publicDocument: WorkingProposalPublicDocument; clientProjectionFingerprint: string }, signal: AbortSignal): Promise<{
    binding: ProposalWorkingBinding; format: 'docx' | 'pdf'; clientProjectionFingerprint: string; fileName: string;
  }>;
}
export interface ProposalWorkingWorkspaceProps {
  initialDocument: WorkingProposalDocument;
  initialStorageToken?: string | null;
  initialRecovery?: ProposalWorkingRecovery;
  sessionKey: string;
  context: ProposalWorkingContext;
  services: ProposalWorkingServices;
  onChange?: (document: WorkingProposalDocument) => void;
  onClose?: () => void;
}

const contextKey = (context: ProposalWorkingContext) => JSON.stringify(context);
const errorText = (error: unknown) => error instanceof Error ? error.message : 'Операция не выполнена. Ваш текст сохранён в открытом окне.';
const freeze = <T,>(value: T): T => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const metadataLabels: Record<keyof WorkingProposalDocument['metadata'], string> = {
  number: 'Номер КП', documentDate: 'Дата КП', validUntil: 'Действует до', currency: 'Валюта', issuerName: 'Отправитель', recipientName: 'Получатель',
};
type ReviewIntent = Awaited<ReturnType<typeof createWorkingProposalReviewIntent>>;
type Preview = { document: WorkingProposalPublicDocument; serialized: string; projectionFingerprint: string };
type Scope = { key: string; sessionKey: string; services: ProposalWorkingServices; documentId: string; controller: AbortController };

/** Ordinary editable document UI. Historical data is not an issued AI proof.
 * All storage/rendering is injected; no native invocation or provider lives here. */
export function ProposalWorkingWorkspace(props: ProposalWorkingWorkspaceProps) {
  const prefix = useId();
  const [document, setDocument] = useState(() => freeze(parseWorkingProposalDocument(props.initialDocument)));
  const documentRef = useRef(document); documentRef.current = document;
  const current = useRef(props); current.current = props;
  const formOrigin = useRef({ sessionKey: props.sessionKey, workspaceRoot: props.context.workspaceRoot, taskKey: props.context.taskKey });
  const [savedSerialized, setSavedSerialized] = useState<string | null>(() => props.initialStorageToken ? serializeWorkingProposalDocument(document) : null);
  const storage = useRef<string | null>(props.initialStorageToken ?? null), recovery = useRef<string | null>(typeof props.initialRecovery === 'object' ? props.initialRecovery.storageToken : null);
  const recoverySerialized = useRef<string | null>(null);
  const recoveryAttemptSerialized = useRef<string | null>(null);
  const autosaveOwner = useRef(typeof props.initialRecovery === 'object' ? props.initialRecovery.ownerId : crypto.randomUUID());
  const [protectedRecovery, setProtectedRecovery] = useState(props.initialRecovery === 'protected');
  const active = useRef(new Set<AbortController>()), mounted = useRef(true);
  const [busy, setBusy] = useState<string | null>(null), [message, setMessage] = useState<string | null>(null), [failure, setFailure] = useState<string | null>(null);
  const [summaries, setSummaries] = useState<readonly ProposalWorkingSummary[] | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null), [approval, setApproval] = useState<{ intent: ReviewIntent; serialized: string; snapshot: WorkingProposalDocument } | null>(null);
  const [reviewChecked, setReviewChecked] = useState(false), [history, setHistory] = useState<string | null>(null);
  const [recoveryStatus, setRecoveryStatus] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<{ kind: 'close' } | { kind: 'open'; summary: ProposalWorkingSummary } | null>(null);
  const view = useRef({ preview, approval, reviewChecked, confirmation, savedSerialized });
  view.current = { preview, approval, reviewChecked, confirmation, savedSerialized };
  const pendingAtRender = Array.from(active.current);
  const serialized = serializeWorkingProposalDocument(document), dirty = serialized !== savedSerialized;
  const detached = props.sessionKey !== formOrigin.current.sessionKey || props.context.workspaceRoot !== formOrigin.current.workspaceRoot || props.context.taskKey !== formOrigin.current.taskKey;
  const unavailable = props.context.stale || detached, localEditable = !unavailable;
  const scope = (): Scope => {
    const controller = new AbortController(); active.current.add(controller);
    return { key: contextKey(props.context), sessionKey: props.sessionKey, services: props.services, documentId: documentRef.current.id, controller };
  };
  const live = (operation: Scope, editor = false) => mounted.current && !operation.controller.signal.aborted
    && current.current.sessionKey === operation.sessionKey && current.current.services === operation.services
    && contextKey(current.current.context) === operation.key && !current.current.context.stale
    && current.current.sessionKey === formOrigin.current.sessionKey && current.current.context.workspaceRoot === formOrigin.current.workspaceRoot && current.current.context.taskKey === formOrigin.current.taskKey
    && documentRef.current.id === operation.documentId && (!editor || current.current.context.access === 'editor' && Boolean(current.current.context.leaseGeneration));
  const gate = (operation: Scope, editor = false) => { if (!live(operation, editor)) throw new Error('Окно, папка базы или права изменились. Результат старой операции не применён.'); };
  const bound = async (operation: Scope): Promise<{ binding: ProposalWorkingBinding; snapshot: WorkingProposalDocument; serialized: string }> => {
    gate(operation); const snapshot = freeze(parseWorkingProposalDocument(documentRef.current)), body = serializeWorkingProposalDocument(snapshot);
    const documentFingerprint = await fingerprintWorkingProposal(snapshot); gate(operation);
    return { snapshot, serialized: body, binding: Object.freeze({ operationId: crypto.randomUUID(), sessionKey: operation.sessionKey,
      workspaceRoot: props.context.workspaceRoot, leaseGeneration: props.context.leaseGeneration, taskKey: props.context.taskKey,
      documentId: snapshot.id, documentRevision: snapshot.revision, documentFingerprint }) };
  };
  const checkReceipt = (actual: ProposalWorkingBinding, expected: ProposalWorkingBinding) => {
    const keys = Object.keys(expected) as (keyof ProposalWorkingBinding)[];
    if (!actual || Object.keys(actual).length !== keys.length || keys.some(key => actual[key] !== expected[key])) throw new Error('Ответ относится к другому документу или папке. Изменения в открытом окне не заменены.');
  };
  const finish = (operation: Scope) => {
    const owned = active.current.delete(operation.controller);
    if (owned && active.current.size === 0 && mounted.current && current.current.sessionKey === operation.sessionKey
      && current.current.services === operation.services && contextKey(current.current.context) === operation.key) setBusy(null);
  };
  const report = (operation: Scope, error: unknown) => { if (live(operation)) setFailure(errorText(error)); };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; active.current.forEach(controller => controller.abort()); }; }, []);
  useEffect(() => {
    active.current.forEach(controller => controller.abort()); active.current.clear(); setBusy(null); setApproval(null); setReviewChecked(false);
  }, [props.sessionKey, props.context.workspaceRoot, props.context.leaseGeneration, props.context.taskKey, props.context.access, props.context.stale, props.services]);

  const change = (edit: (draft: WorkingProposalDocument) => void) => {
    if (current.current.sessionKey !== props.sessionKey || contextKey(current.current.context) !== contextKey(props.context) || unavailable || documentRef.current !== document) return;
    let next: WorkingProposalDocument;
    try { next = freeze(editWorkingProposal(document, edit)); }
    catch (error) { setFailure(`${errorText(error)} Предыдущее значение сохранено.`); return; }
    documentRef.current = next; setDocument(next);
    view.current.preview = null; view.current.approval = null; view.current.reviewChecked = false;
    setPreview(null); setApproval(null); setReviewChecked(false); setMessage(null); setFailure(null);
    try { props.onChange?.(next); } catch { setFailure('Правки оставлены в этом окне, но не удалось передать их родительскому окну. Сохраните черновик перед закрытием.'); }
  };
  const save = async (automatic = false) => {
    if (current.current !== props || props.context.access !== 'editor' || !props.context.leaseGeneration || unavailable || busy || active.current.size) return;
    if (automatic && (!props.services.autosave || protectedRecovery)) return;
    const operation = scope(); setBusy(automatic ? 'Обновляем восстановительную копию…' : 'Сохраняем черновик…'); setFailure(null);
    try {
      const captured = await bound(operation); gate(operation, true);
      if (automatic) {
        recoveryAttemptSerialized.current = captured.serialized;
        const autosaveOwnerId = autosaveOwner.current;
        const receipt = await props.services.autosave!({ binding: captured.binding, document: captured.snapshot, autosaveOwnerId,
          expectedAutosaveToken: recovery.current, baseRecordStorageToken: storage.current }, operation.controller.signal);
        gate(operation, true); checkReceipt(receipt.binding, captured.binding);
        if (receipt.autosaveOwnerId !== autosaveOwnerId || !receipt.autosaveToken || receipt.documentFingerprint !== captured.binding.documentFingerprint) throw new Error('Восстановительная копия не подтверждена. Явное сохранение не выполнено.');
        recovery.current = receipt.autosaveToken; recoverySerialized.current = captured.serialized;
        setRecoveryStatus(serializeWorkingProposalDocument(documentRef.current) === captured.serialized ? 'Восстановительная копия обновлена. Для сохранения в списке нажмите «Сохранить черновик».' : 'Обновлена восстановительная копия предыдущей редакции. Последние правки ещё не записаны.');
        return;
      }
      const receipt = await props.services.save({ binding: captured.binding, document: captured.snapshot, expectedStorageToken: storage.current }, operation.controller.signal);
      gate(operation, true); checkReceipt(receipt.binding, captured.binding);
      if (!receipt.storageToken || receipt.documentFingerprint !== captured.binding.documentFingerprint) throw new Error('Сохранение не подтверждено для отправленной редакции. Ваш текст не изменён.');
      if (receipt.consumedAutosave) {
        if (receipt.consumedAutosave.previousToken !== recovery.current || !receipt.consumedAutosave.nextToken
          || receipt.consumedAutosave.nextToken === recovery.current) throw new Error('Черновик записан, но восстановительная копия не подтверждена. Повторно откройте сохранённую версию; ввод оставлен в окне.');
        recovery.current = receipt.consumedAutosave.nextToken;
      }
      storage.current = receipt.storageToken; setSavedSerialized(captured.serialized);
      setMessage(serializeWorkingProposalDocument(documentRef.current) === captured.serialized ? 'Черновик сохранён.' : 'Сохранена предыдущая редакция. Последние изменения ещё не сохранены.');
    } catch (error) { report(operation, error); } finally { finish(operation); }
  };
  useEffect(() => {
    if (!dirty || busy || protectedRecovery || recoverySerialized.current === serialized || recoveryAttemptSerialized.current === serialized || !props.services.autosave || props.context.access !== 'editor' || !props.context.leaseGeneration || unavailable) return;
    const timer = setTimeout(() => { void save(true); }, 1500); return () => clearTimeout(timer);
  }, [document, busy, dirty, protectedRecovery, props.services, props.context, props.sessionKey]);

  const list = async () => {
    if (current.current !== props || unavailable || busy || active.current.size) return;
    const operation = scope(); setBusy('Загружаем список…'); setFailure(null);
    try {
      const captured = await bound(operation); gate(operation);
      const result = await props.services.list({ binding: captured.binding }, operation.controller.signal); gate(operation); checkReceipt(result.binding, captured.binding);
      const ids = new Set<string>();
      if (!Array.isArray(result.summaries) || result.summaries.length > 500 || result.summaries.some(item => !item || typeof item.id !== 'string' || !item.id || item.id.length > 256
        || typeof item.storageToken !== 'string' || !item.storageToken || item.storageToken.length > 512 || typeof item.title !== 'string' || item.title.length > 1000
        || item.updatedAt !== null && (typeof item.updatedAt !== 'string' || item.updatedAt.length > 100) || ids.has(item.id) || !ids.add(item.id))) throw new Error('Список черновиков повреждён или слишком велик. Открытый текст сохранён.');
      setSummaries(result.summaries.map(item => ({ id: item.id, title: item.title, storageToken: item.storageToken, updatedAt: item.updatedAt })));
    } catch (error) { report(operation, error); } finally { finish(operation); }
  };
  const open = async (summary: ProposalWorkingSummary) => {
    if (current.current !== props || unavailable || busy || active.current.size) return;
    const operation = scope(); setBusy('Открываем черновик…'); setFailure(null);
    try {
      const captured = await bound(operation); gate(operation);
      const result = await props.services.open({ binding: captured.binding, id: summary.id, storageToken: summary.storageToken }, operation.controller.signal);
      gate(operation); checkReceipt(result.binding, captured.binding);
      const loaded = freeze(parseWorkingProposalDocument(result.document)), loadedFingerprint = await fingerprintWorkingProposal(loaded); gate(operation);
      if (loaded.id !== summary.id || result.storageToken !== summary.storageToken || result.documentFingerprint !== loadedFingerprint) throw new Error('Получена другая или повреждённая редакция. Открытый текст не заменён.');
      if (serializeWorkingProposalDocument(documentRef.current) !== captured.serialized) throw new Error('Пока черновик открывался, вы изменили текст. Новая версия не заменяет ваши правки; откройте её ещё раз.');
      storage.current = result.storageToken;
      recovery.current = typeof result.recovery === 'object' ? result.recovery.storageToken : null;
      autosaveOwner.current = typeof result.recovery === 'object' ? result.recovery.ownerId : crypto.randomUUID();
      setProtectedRecovery(result.recovery === 'protected'); recoverySerialized.current = null; recoveryAttemptSerialized.current = null; documentRef.current = loaded; setDocument(loaded);
      setSavedSerialized(serializeWorkingProposalDocument(loaded)); setPreview(null); setApproval(null); setReviewChecked(false); setHistory(null); setRecoveryStatus(null); setMessage('Открыт сохранённый рабочий черновик. Исторические данные не являются новой проверкой ИИ.'); props.onChange?.(loaded);
    } catch (error) { report(operation, error); } finally { finish(operation); }
  };
  const loadHistory = async () => {
    if (current.current !== props || !props.services.history || unavailable || busy || active.current.size) return;
    const operation = scope(); setBusy('Загружаем исходный контекст…'); setFailure(null);
    try {
      const captured = await bound(operation); gate(operation);
      const result = await props.services.history({ binding: captured.binding, reference: captured.snapshot.historicalSource }, operation.controller.signal);
      gate(operation); checkReceipt(result.binding, captured.binding);
      const status = await inspectWorkingProposalHistory(captured.snapshot, result.text); gate(operation);
      if (status.state !== 'available-unvalidated') throw new Error(status.warning ?? 'Исходный контекст недоступен. Текст КП сохранён.');
      setHistory(result.text);
    } catch (error) { report(operation, error); } finally { finish(operation); }
  };
  const makePreview = async () => {
    if (current.current !== props || unavailable || busy || active.current.size) return;
    const operation = scope(); setBusy('Готовим просмотр…'); setFailure(null);
    try {
      const captured = await bound(operation), value = await projectWorkingProposalPublic(captured.snapshot, 'review-draft'); gate(operation);
      const projectionFingerprint = await fingerprintWorkingProposalPublic(captured.snapshot, 'review-draft'); gate(operation);
      if (serializeWorkingProposalDocument(documentRef.current) !== captured.serialized) throw new Error('Текст изменился. Откройте просмотр для новой редакции.');
      setPreview({ document: value, serialized: captured.serialized, projectionFingerprint }); setReviewChecked(false); setApproval(null);
    } catch (error) { report(operation, error); } finally { finish(operation); }
  };
  const approve = async () => {
    if (current.current !== props || !preview || view.current.preview !== preview || !view.current.reviewChecked
      || preview.serialized !== serializeWorkingProposalDocument(documentRef.current) || busy || unavailable || active.current.size) return;
    const operation = scope(); setBusy('Фиксируем вашу проверку…'); setFailure(null);
    try {
      const captured = await bound(operation), intent = await createWorkingProposalReviewIntent(captured.snapshot); gate(operation);
      if (serializeWorkingProposalDocument(documentRef.current) !== captured.serialized) throw new Error('Текст изменился. Просмотрите новую редакцию перед подтверждением.');
      setApproval({ intent, serialized: captured.serialized, snapshot: captured.snapshot }); setMessage('Ваша проверка относится только к показанной редакции. Изменения потребуют повторного просмотра.');
    } catch (error) { report(operation, error); } finally { finish(operation); }
  };
  const exportFile = async (format: 'docx' | 'pdf') => {
    if (current.current !== props || !props.services.export || !approval || view.current.approval !== approval
      || approval.serialized !== serializeWorkingProposalDocument(documentRef.current) || unavailable || busy || active.current.size) return;
    const operation = scope(); setBusy(`Готовим ${format.toUpperCase()}…`); setFailure(null);
    try {
      const captured = await bound(operation); gate(operation);
      if (serializeWorkingProposalDocument(approval.snapshot) !== captured.serialized) throw new Error('Проверка относится к другой редакции. Откройте просмотр заново.');
      const publicDocument = await projectWorkingProposalPublic(approval.snapshot, 'final', approval.intent); gate(operation);
      const clientProjectionFingerprint = await fingerprintWorkingProposalPublic(captured.snapshot); gate(operation);
      if (serializeWorkingProposalDocument(documentRef.current) !== captured.serialized) throw new Error('Текст изменился до выгрузки. Проверьте новую редакцию.');
      const receipt = await props.services.export({ binding: captured.binding, format, publicDocument, clientProjectionFingerprint }, operation.controller.signal);
      gate(operation); checkReceipt(receipt.binding, captured.binding);
      if (receipt.format !== format || receipt.clientProjectionFingerprint !== clientProjectionFingerprint || !receipt.fileName) throw new Error('Не удалось подтвердить файл для выбранной редакции.');
      setMessage(serializeWorkingProposalDocument(documentRef.current) === captured.serialized ? `Файл подготовлен: ${receipt.fileName}` : `Подготовлен файл предыдущей редакции: ${receipt.fileName}. Последние правки в него не вошли.`);
    } catch (error) { report(operation, error); } finally { finish(operation); }
  };
  const close = () => {
    if (current.current !== props) return;
    if (serializeWorkingProposalDocument(documentRef.current) !== view.current.savedSerialized) setConfirmation({ kind: 'close' });
    else { active.current.forEach(controller => controller.abort()); props.onClose?.(); }
  };
  const requestOpen = (summary: ProposalWorkingSummary) => { if (current.current !== props || unavailable) return; if (serializeWorkingProposalDocument(documentRef.current) !== view.current.savedSerialized) setConfirmation({ kind: 'open', summary }); else void open(summary); };
  const proceed = () => {
    if (current.current !== props || !confirmation || view.current.confirmation !== confirmation) return;
    const action = confirmation; setConfirmation(null);
    if (action.kind === 'close') { active.current.forEach(controller => controller.abort()); props.onClose?.(); }
    else void open(action.summary);
  };

  return <section className="working-proposal" aria-label="Редактор рабочего КП">
    <header className="working-proposal-heading"><div><h2>Коммерческое предложение</h2><p className="help-text">Рабочий документ · {dirty ? 'есть несохранённые изменения' : 'сохранённая редакция'}</p></div>
      {props.onClose && <button type="button" onClick={close}>Закрыть КП</button>}</header>
    <p className="notice warning">Это редактируемый рабочий черновик. Исторические ответы ИИ могут содержать ошибки; повторное открытие не подтверждает их полноту или достоверность. Проверьте условия и состав перед отправкой.</p>
    {props.context.access === 'viewer' && <p className="notice">Можно изменять локальную копию. Сохранение в общую базу недоступно в режиме просмотра.</p>}
    {unavailable && <p className="notice warning" role="alert">Папка базы, задача или доступ изменились. Текст оставлен в окне; операции старого сеанса отключены.</p>}
    {failure && <p className="notice error" role="alert">{failure}</p>}{message && <p className="notice" role="status">{message}</p>}
    <div className="working-proposal-actions">
      <button type="button" disabled={Boolean(busy) || props.context.access !== 'editor' || !props.context.leaseGeneration || unavailable} onClick={() => void save()}>Сохранить черновик</button>
      <button type="button" disabled={Boolean(busy) || unavailable} onClick={() => void list()}>Сохранённые черновики</button>
      <button type="button" disabled={Boolean(busy) || unavailable} onClick={() => void makePreview()}>Просмотреть документ</button>
      {busy && <><span role="status" aria-live="polite">{busy}</span><button type="button" onClick={() => {
        if (current.current !== props || pendingAtRender.length === 0 || pendingAtRender.some(controller => !active.current.has(controller))) return;
        pendingAtRender.forEach(controller => { controller.abort(); active.current.delete(controller); }); setBusy(null); setMessage('Ожидание остановлено. Уже отправленная операция могла завершиться; её результат не заменит открытый текст.');
      }}>Остановить ожидание</button></>}
    </div>
    {recoveryStatus && <p className="help-text" role="status">{recoveryStatus}</p>}
    {protectedRecovery && <p className="notice warning">Для этого документа уже есть отдельная несохранённая восстановительная копия. Она не перезаписывается автоматически. Текущий документ можно явно сохранить; открыть восстановительную копию как новое КП можно в списке рабочих КП.</p>}
    {confirmation && <div className="notice warning working-proposal-confirm" role="alertdialog" aria-label="Несохранённые изменения"><strong>Есть несохранённые изменения</strong><p>Текущие правки блоков, дополнения и ответы на вопросы будут потеряны при {confirmation.kind === 'close' ? 'закрытии' : 'открытии другого черновика'}. Сначала сохраните их, если они нужны.</p><button type="button" onClick={() => setConfirmation(null)}>Остаться в черновике</button><button type="button" onClick={proceed}>{confirmation.kind === 'close' ? 'Закрыть без сохранения' : 'Открыть без сохранения'}</button></div>}
    {summaries && <details className="surface" open><summary>Сохранённые рабочие черновики ({summaries.length})</summary><p className="help-text">Список содержит только названия. Исходный контекст загружается отдельно при необходимости.</p>{summaries.length === 0 ? <p>Сохранённых черновиков пока нет.</p> : <ul className="working-proposal-list">{summaries.map(item => <li key={`${item.id}:${item.storageToken}`}><span>{item.title}{item.updatedAt && <small>{item.updatedAt}</small>}</span><button type="button" disabled={Boolean(busy) || unavailable} onClick={() => requestOpen(item)}>Открыть</button></li>)}</ul>}</details>}
    <section className="surface"><h3>Реквизиты и оформление</h3><div className="working-proposal-grid"><label>Название<input aria-label="Название КП" value={document.title} disabled={!localEditable} onChange={event => change(draft => { draft.title = event.target.value; })} /></label>
      {(Object.keys(metadataLabels) as (keyof WorkingProposalDocument['metadata'])[]).map(key => <label key={key}>{metadataLabels[key]}<input aria-label={metadataLabels[key]} value={document.metadata[key] ?? ''} placeholder="Не указано" disabled={!localEditable} type={key === 'documentDate' || key === 'validUntil' ? 'date' : 'text'} onChange={event => change(draft => { draft.metadata[key] = event.target.value === '' ? null : event.target.value; })} /></label>)}
      <label>Стиль<select aria-label="Стиль документа" value={document.layout.style} disabled={!localEditable} onChange={event => change(draft => { draft.layout.style = event.target.value as WorkingProposalDocument['layout']['style']; })}><option value="standard">Стандартный</option><option value="compact">Компактный</option></select></label>
      <label>Цвет оформления<input aria-label="Цвет оформления" type="color" value={document.layout.accentColor} disabled={!localEditable} onChange={event => change(draft => { draft.layout.accentColor = event.target.value; })} /></label></div><p className="help-text">Пустые реквизиты остаются неизвестными. Валюта, даты, суммы и стороны не заполняются автоматически.</p></section>
    <nav className="working-proposal-sections" aria-label="Разделы КП">{document.sections.map(section => <a key={section.area} href={`#${prefix}-${section.area}`}>{section.title}</a>)}</nav>
    {document.sections.map(section => <section className="surface" key={section.area} id={`${prefix}-${section.area}`}><h3>{section.title}</h3>
      {section.blocks.length === 0 && <p className="help-text">Готового текста пока нет. Используйте дополнение и уточнения ниже; отсутствие ответа ИИ не доказывает отсутствие условий в источнике.</p>}
      {section.blocks.map((block, index) => <details className="working-proposal-block" key={block.id} data-block-id={block.id} open={section.blocks.length === 1}><summary>Блок {index + 1} · {block.included ? 'в документе' : 'не включён'} · {block.origin === 'historical-model-answer' ? 'исходный ответ ИИ' : 'ваша правка'}</summary>
        <div className="working-proposal-actions">{([-1, 1] as const).map(direction => <button type="button" key={direction} aria-label={`Переместить блок ${index + 1} ${direction === -1 ? 'выше' : 'ниже'} — ${section.title}`}
          disabled={!localEditable || index + direction < 0 || index + direction >= section.blocks.length} onClick={() => change(draft => {
            const blocks = draft.sections.find(item => item.area === section.area)!.blocks, at = blocks.findIndex(item => item.id === block.id), next = at + direction;
            if (at < 0 || next < 0 || next >= blocks.length) return;
            [blocks[at], blocks[next]] = [blocks[next], blocks[at]];
          })}>{direction === -1 ? 'Выше' : 'Ниже'}</button>)}</div>
        <label className="working-proposal-check"><input type="checkbox" aria-label={`Включить блок ${index + 1} — ${section.title}`} checked={block.included} disabled={!localEditable} onChange={event => change(draft => { draft.sections.find(item => item.area === section.area)!.blocks.find(item => item.id === block.id)!.included = event.target.checked; })} />Включить полный блок в документ</label>
        <label>Текст блока<textarea aria-label={`Текст блока ${index + 1} — ${section.title}`} rows={6} value={block.text} disabled={!localEditable} onChange={event => change(draft => { const edited = draft.sections.find(item => item.area === section.area)!.blocks.find(item => item.id === block.id)!; edited.text = event.target.value; edited.origin = 'user-edit-unreviewed'; })} /></label><p className="help-text">Правки не наследуют проверку исходного ответа. Полный текст блока остаётся доступен и при снятом флажке.</p></details>)}
      <details className="working-proposal-block"><summary>Ваше дополнение к разделу{section.userText ? ' · заполнено' : ''}</summary><label className="working-proposal-check"><input type="checkbox" aria-label={`Включить дополнение — ${section.title}`} checked={section.userTextIncluded} disabled={!localEditable} onChange={event => change(draft => { draft.sections.find(item => item.area === section.area)!.userTextIncluded = event.target.checked; })} />Включить дополнение в документ</label><textarea aria-label={`Дополнение — ${section.title}`} rows={4} value={section.userText} disabled={!localEditable} onChange={event => change(draft => { draft.sections.find(item => item.area === section.area)!.userText = event.target.value; })} /></details>
      {document.questions.filter(question => question.area === section.area).map(question => <details className="working-proposal-question" key={question.id} data-question-id={question.id}><summary>Уточнение · {question.state === 'resolved' ? 'отмечено решённым' : question.state === 'answered' ? 'есть ответ' : 'требует решения'}</summary><p>{question.question}</p><label>Ваш ответ<textarea aria-label={`Ответ на вопрос — ${question.id}`} rows={3} value={question.answer} disabled={!localEditable} onChange={event => change(draft => { const edited = draft.questions.find(item => item.id === question.id)!; edited.answer = event.target.value; edited.state = event.target.value ? 'answered' : 'open'; })} /></label><label className="working-proposal-check"><input type="checkbox" aria-label={`Вопрос решён — ${question.id}`} checked={question.state === 'resolved'} disabled={!localEditable} onChange={event => change(draft => { const edited = draft.questions.find(item => item.id === question.id)!; edited.state = event.target.checked ? 'resolved' : edited.answer ? 'answered' : 'open'; })} />Отметить решённым</label><p className="help-text">Ответ хранится отдельно. Отметка «решено» не вставляет его в текст КП; необходимые условия добавьте в блок или дополнение самостоятельно.</p></details>)}
    </section>)}
    <details className="surface"><summary>Исходный контекст · только для вас</summary><p className="help-text">Исторические материалы не являются новой проверкой и не включаются в документ. Отсутствие или ошибка контекста не удаляет ваши правки.</p>{history !== null ? <pre className="working-proposal-history">{history}</pre> : <button type="button" disabled={!props.services.history || Boolean(busy) || unavailable} onClick={() => void loadHistory()}>Загрузить исходный контекст</button>}</details>
    {preview && preview.serialized === serialized && <section className="surface working-proposal-preview" aria-label="Предпросмотр документа"><h3>Что будет отправлено заказчику</h3><p className="help-text">В документ попадут только выбранные блоки, дополнения и явные реквизиты. Частный контекст и ответы на уточнения исключены. Проверьте также конфиденциальность самого выбранного текста.</p>
      <div aria-label="Текст будущего файла"><h4 style={{ color: preview.document.layout.accentColor }}>{preview.document.title}</h4><p className="help-text">Оформление: {preview.document.layout.style === 'compact' ? 'компактное' : 'стандартное'}. Ниже — состав и текст будущего документа.</p><dl>{(Object.keys(metadataLabels) as (keyof WorkingProposalDocument['metadata'])[]).map(key => preview.document.metadata[key] === null ? null : <div key={key}><dt>{metadataLabels[key]}</dt><dd>{preview.document.metadata[key]}</dd></div>)}</dl>
      {preview.document.sections.map(section => <section key={section.area}><h4>{section.title}</h4>{section.blocks.map((text, index) => <p className="working-proposal-text" key={index}>{text}</p>)}{section.blocks.length === 0 && <p className="help-text">Текст не выбран.</p>}</section>)}</div>
      <details open><summary>Что требует внимания перед отправкой</summary>{document.questions.filter(question => question.state !== 'resolved').length > 0 ? <ul>{document.questions.filter(question => question.state !== 'resolved').map(question => <li key={question.id}><a href={`#${prefix}-${question.area}`}>{question.question}</a> · {question.answer ? 'ответ записан отдельно' : 'ответа пока нет'}</li>)}</ul> : <p>Открытых уточнений не отмечено. Это не подтверждение полноты или правильности КП.</p>}{document.sections.some(section => section.blocks.some(block => !block.included) || section.userText && !section.userTextIncluded) && <p>Некоторые блоки или дополнения исключены. Вернитесь к разделам, чтобы проверить их содержание и выбор.</p>}</details>
      {document.sections.map(section => <div key={section.area}>{section.blocks.filter(block => !block.included).map(block => <details key={block.id}><summary>Не войдёт в файл · {section.title} · блок {section.blocks.indexOf(block) + 1}</summary><p className="working-proposal-text">{block.text}</p><a href={`#${prefix}-${section.area}`}>Изменить выбор в разделе</a></details>)}{section.userText && !section.userTextIncluded && <details><summary>Не войдёт в файл · {section.title} · ваше дополнение</summary><p className="working-proposal-text">{section.userText}</p><a href={`#${prefix}-${section.area}`}>Изменить выбор в разделе</a></details>}</div>)}
      <label className="working-proposal-check"><input type="checkbox" aria-label="Я проверил текущий документ и нерешённые вопросы" checked={reviewChecked} disabled={Boolean(busy) || unavailable} onChange={event => { if (current.current !== props || unavailable) return; setReviewChecked(event.target.checked); setApproval(null); }} />Я проверил текущий текст, выбор блоков, реквизиты, конфиденциальность и нерешённые вопросы</label>
      <div className="working-proposal-actions"><button type="button" disabled={!reviewChecked || Boolean(busy) || unavailable} onClick={() => void approve()}>Подтвердить мою проверку</button><button type="button" disabled={!approval || !props.services.export || Boolean(busy) || unavailable} onClick={() => void exportFile('docx')}>Скачать DOCX</button><button type="button" disabled={!approval || !props.services.export || Boolean(busy) || unavailable} onClick={() => void exportFile('pdf')}>Скачать PDF</button></div>{!props.services.export && <p className="help-text">Выгрузка ещё не подключена в этом окне. Ваш черновик можно продолжать редактировать и сохранять.</p>}
    </section>}
  </section>;
}
