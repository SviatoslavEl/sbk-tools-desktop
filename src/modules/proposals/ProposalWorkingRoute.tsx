import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke, useNetworkAccess } from '../../lib/networkDiagnostics';
import { chooseSavePath } from '../../lib/files';
import { getWorkspaceInfo } from '../../lib/storage';
import { useWorkspaceAccess } from '../../lib/workspaceAccess';
import { ProposalWholeDraftWorkspace } from '../intelligence/ProposalWholeDraftWorkspace';
import type { ProposalDraftEditorHandoff } from '../intelligence/proposalDraftEditorAdapter';
import { ProposalWorkingWorkspace, type ProposalWorkingContext, type ProposalWorkingRecovery } from './ProposalWorkingWorkspace';
import { createWorkingStorageServices, getWorkingStorageContext, listWorkingStorage, readWorkingStorage,
  type WorkingStorageContext, type WorkingStorageIO, type WorkingStorageRead, type WorkingStorageSummary } from './workingStorage';
import { createWorkingProposal, parseWorkingProposalDocument, type WorkingProposalDocument } from './workingDocument';

const io: WorkingStorageIO = {
  invoke: (command, args) => invoke(command, args),
  chooseSavePath: (format, title) => chooseSavePath('Сохранить коммерческое предложение', `КП ${Array.from(title.replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '_')).slice(0, 45).join('') || 'Документ'}.${format}`, [format]),
};
const reason = (error: unknown) => error instanceof Error ? error.message : String(error);
interface Seed { document: WorkingProposalDocument; historyJson?: string; storageToken?: string | null; sessionKey: string; recovery?: ProposalWorkingRecovery }

/** Fetch the ephemeral native generation only when an editor actually opens.
 * No startup registry polling and no generation in persisted ordinary data. */
export function ProposalWorkingHost({ seed, root, taskKey, stale = false, onClose }: {
  seed: Seed; root: string; taskKey: string; stale?: boolean; onClose?: () => void;
}) {
  const access = useWorkspaceAccess(), network = useNetworkAccess();
  const [native, setNative] = useState<WorkingStorageContext | null>(null), [failure, setFailure] = useState(''), [refresh, setRefresh] = useState(0);
  const context: ProposalWorkingContext = { workspaceRoot: root, taskKey, leaseGeneration: native?.root === root ? native.leaseGeneration : null,
    access: access.editor && native?.root === root && native.canWrite ? 'editor' : 'viewer', stale: stale || network.phase !== 'connected' || native?.root !== root };
  const current = useRef({ context, sessionKey: seed.sessionKey }); current.current = { context, sessionKey: seed.sessionKey };
  useEffect(() => {
    const controller = new AbortController(); let alive = true; setNative(null); setFailure('');
    if (network.phase === 'connected') void getWorkingStorageContext(io, root, controller.signal, () => alive).then(value => {
      if (alive && !controller.signal.aborted) setNative(value);
    }).catch(error => { if (alive && !controller.signal.aborted) setFailure(reason(error)); });
    return () => { alive = false; controller.abort(); };
  }, [root, access.editor, network.phase, refresh]);
  useEffect(() => {
    const update = () => setRefresh(value => value + 1); window.addEventListener('sbk-workspace-refresh', update);
    return () => window.removeEventListener('sbk-workspace-refresh', update);
  }, []);
  const services = useMemo(() => createWorkingStorageServices(io, {
    current: binding => {
      const value = current.current;
      return !value.context.stale && binding.workspaceRoot === value.context.workspaceRoot && binding.sessionKey === value.sessionKey
        && binding.taskKey === value.context.taskKey && binding.leaseGeneration === value.context.leaseGeneration;
    }, initialHistory: seed.historyJson === undefined ? undefined : { document: seed.document, historyJson: seed.historyJson },
  }), [root, seed.sessionKey]);
  return <div data-workspace-viewer-allowed data-workspace-managed-disabled="true">
    {failure && <p className="notice warning" role="alert">Не удалось проверить доступ: {failure} Текст оставлен в окне. <button type="button" onClick={() => setRefresh(value => value + 1)}>Проверить доступ снова</button></p>}
    {!native && !failure && <p role="status">Проверяем папку и текущий доступ…</p>}
    <ProposalWorkingWorkspace key={seed.sessionKey} initialDocument={seed.document} initialStorageToken={seed.storageToken} initialRecovery={seed.recovery}
      sessionKey={seed.sessionKey} context={context} services={services} onClose={onClose} />
  </div>;
}

/** Existing issued handoff remains separate. Conversion only follows a human
 * action on the ORIGINAL issued object; JSON reopen never uses this adapter. */
export function ProposalWholeWorkingRoute({ handoff, root, taskKey, stale, open, onClose }: {
  handoff: ProposalDraftEditorHandoff; root: string; taskKey: string; stale: boolean; open: boolean; onClose: () => void;
}) {
  const [seed, setSeed] = useState<Seed | null>(null), [busy, setBusy] = useState(false), [failure, setFailure] = useState('');
  const current = useRef({ handoff, root, taskKey, stale }); current.current = { handoff, root, taskKey, stale };
  const pending = useRef(false), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const convert = async () => {
    if (pending.current || current.current.handoff !== handoff || current.current.stale) return;
    pending.current = true; setBusy(true); setFailure('');
    try {
      const created = await createWorkingProposal(handoff);
      if (!alive.current || current.current.handoff !== handoff || current.current.root !== root || current.current.taskKey !== taskKey || current.current.stale) return;
      setSeed({ ...created, sessionKey: crypto.randomUUID() });
    } catch (error) { if (alive.current && current.current.handoff === handoff) setFailure(reason(error)); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  return <section hidden={!open} aria-label="Работа с полным КП" data-workspace-viewer-allowed data-workspace-managed-disabled="true">
    {seed ? <ProposalWorkingHost seed={seed} root={root} taskKey={taskKey} stale={stale} onClose={onClose} /> : <>
      <p className="notice">Перенесите результат в рабочий документ, чтобы выбирать блоки, сохранять КП, повторно открывать его и готовить файл. Это не подтверждает правильность ответа ИИ.</p>
      <button type="button" disabled={busy || stale} onClick={() => void convert()}>{busy ? 'Подготавливаем рабочий документ…' : 'Продолжить в редакторе с сохранением'}</button>
      {failure && <p className="notice error" role="alert">{failure}</p>}
      <ProposalWholeDraftWorkspace handoff={handoff} stale={stale || busy} onClose={onClose} />
    </>}
  </section>;
}

/** Separate additive working-document shelf. Only summaries are paged; bodies
 * and immutable history are lazy. Recovery requires an explicit new-copy action. */
export function ProposalWorkingLibrary({ active = true }: { active?: boolean }) {
  const access = useWorkspaceAccess(), network = useNetworkAccess();
  const [owner, setOwner] = useState<WorkingStorageContext | null>(null), [items, setItems] = useState<WorkingStorageSummary[] | null>(null), [cursor, setCursor] = useState<string | null>(null);
  const [seed, setSeed] = useState<Seed | null>(null), [seedRoot, setSeedRoot] = useState<string | null>(null), [selection, setSelection] = useState<WorkingStorageRead | null>(null);
  const [busy, setBusy] = useState(false), [failure, setFailure] = useState('');
  const pending = useRef<AbortController | null>(null), alive = useRef(true), epoch = useRef(0);
  const current = useRef({ active, access: access.editor, phase: network.phase }); current.current = { active, access: access.editor, phase: network.phase };
  const chosen = useRef({ owner, selection, seed }); chosen.current = { owner, selection, seed };
  useEffect(() => { alive.current = true; return () => { alive.current = false; pending.current?.abort(); }; }, []);
  useEffect(() => { epoch.current++; pending.current?.abort(); pending.current = null; setBusy(false); setOwner(null); setItems(null); setSelection(null); }, [access.editor, network.phase]);
  useEffect(() => {
    const refresh = () => { epoch.current++; pending.current?.abort(); pending.current = null; setBusy(false); setOwner(null); setItems(null); setSelection(null); };
    window.addEventListener('sbk-workspace-refresh', refresh); return () => window.removeEventListener('sbk-workspace-refresh', refresh);
  }, []);
  async function load(more = false) {
    if (!current.current.active || current.current.phase !== 'connected' || pending.current || seed) return;
    const controller = new AbortController(), generation = epoch.current; pending.current = controller; setBusy(true); setFailure('');
    const valid = () => alive.current && current.current.active && pending.current === controller && generation === epoch.current && current.current.phase === 'connected';
    try {
      const workspace = await getWorkspaceInfo(); if (!valid()) return;
      const context = await getWorkingStorageContext(io, workspace.root, controller.signal, valid);
      if (more && (!owner || owner.root !== context.root || owner.leaseGeneration !== context.leaseGeneration)) throw new Error('Папка или доступ изменились. Загрузите список с начала.');
      const page = await listWorkingStorage(io, context, controller.signal, valid, more ? cursor : null); if (!valid()) return;
      setOwner(context); setItems(previous => more ? [...previous ?? [], ...page.items] : page.items); setCursor(page.nextCursor); setSelection(null);
    } catch (error) { if (valid()) setFailure(reason(error)); }
    finally { if (pending.current === controller) { pending.current = null; if (alive.current) setBusy(false); } }
  }
  async function select(item: WorkingStorageSummary) {
    if (!owner || !current.current.active || pending.current || seed || current.current.phase !== 'connected') return;
    const controller = new AbortController(), generation = epoch.current; pending.current = controller; setBusy(true); setFailure('');
    const valid = () => alive.current && current.current.active && pending.current === controller && generation === epoch.current && current.current.phase === 'connected';
    try { const value = await readWorkingStorage(io, owner, item.id, item.storageToken, controller.signal, valid); if (valid()) setSelection(value); }
    catch (error) { if (valid()) setFailure(reason(error)); } finally { if (pending.current === controller) { pending.current = null; if (alive.current) setBusy(false); } }
  }
  return <section className="surface" aria-label="Сохранённые рабочие КП" data-workspace-viewer-allowed data-workspace-managed-disabled="true" hidden={!active}>
    <div className="inline-heading"><h3>Рабочие КП по семи разделам</h3><button type="button" disabled={busy || Boolean(seed) || network.phase !== 'connected'} onClick={() => void load()}>Открыть список рабочих КП</button></div>
    <p className="help-text">Сохранённые документы из полного прохода ИИ. Восстановительная копия показывается отдельно и не подменяет сохранённый текст.</p>
    {busy && <p role="status">Загружаем рабочие КП…</p>}{failure && <p className="notice error" role="alert">{failure}</p>}
    {items && <><ul className="working-proposal-list">{items.map(item => <li key={item.id}><span>{item.title || 'Без названия'}<small>{item.recordSaved ? 'Сохранённый документ' : 'Только восстановительная копия'}{item.autosaveAvailable ? ' · есть восстановительная копия' : ''}</small></span><button type="button" disabled={busy || Boolean(seed)} onClick={() => void select(item)}>Выбрать</button></li>)}</ul>{items.length === 0 && <p>Рабочих КП пока нет.</p>}{cursor && <button type="button" disabled={busy || Boolean(seed)} onClick={() => void load(true)}>Следующие 50</button>}</>}
    {selection && !seed && owner && <div className="notice"><h4>Выберите версию для открытия</h4>
      {selection.saved && <button type="button" onClick={() => {
        if (!current.current.active || chosen.current.selection !== selection || chosen.current.owner !== owner || chosen.current.seed || current.current.phase !== 'connected') return;
        setSeedRoot(owner.root); setSeed({ document: selection.saved!.document, storageToken: selection.saved!.summary.storageToken, sessionKey: crypto.randomUUID(),
          recovery: selection.recovery ? 'protected' : selection.consumedRecovery ?? undefined });
      }}>Открыть сохранённый документ</button>}
      {selection.recovery && <><p>Восстановительная копия может содержать более ранние или несохранённые правки. Она откроется отдельным новым КП, не перезаписывая исходный документ.</p><button type="button" onClick={() => {
        if (!current.current.active || chosen.current.selection !== selection || chosen.current.owner !== owner || chosen.current.seed || current.current.phase !== 'connected') return;
        const document = parseWorkingProposalDocument({ ...selection.recovery!.document, id: crypto.randomUUID(), revision: 0 });
        setSeedRoot(owner.root); setSeed({ document, storageToken: null, sessionKey: crypto.randomUUID() });
      }}>Открыть восстановительную копию как новое КП</button></>}
      {!selection.saved && !selection.recovery && <p>Выбранная версия больше недоступна. Обновите список.</p>}
    </div>}
    {seed && seedRoot && <ProposalWorkingHost seed={seed} root={seedRoot} taskKey={`stored:${seed.document.id}`} stale={network.phase !== 'connected'} onClose={() => { setSeed(null); setSeedRoot(null); setSelection(null); }} />}
  </section>;
}
