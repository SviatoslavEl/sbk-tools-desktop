import { useCallback, useEffect, useState } from "react";
import { ConfirmDialog } from "../../components/Dialog";
import { archiveRecord, archiveRecords, deleteRecord, deleteRecords, listRecords, type ModuleId, type StoredRecord } from "../../lib/storage";
import { useWorkspaceAccess } from "../../lib/workspaceAccess";

const sections: Array<{ module: ModuleId; title: string }> = [
  { module: "calculator", title: "Расчёты" },
  { module: "contract-experience", title: "Договоры" },
  { module: "staff", title: "Кадры" },
  { module: "procurement", title: "Закупки" },
  { module: "tender-calendar", title: "Календарь тендеров" },
];

type ArchiveData = Partial<Record<ModuleId, StoredRecord[]>>;
type PendingArchiveAction = { module: ModuleId; action: "restore" | "delete"; ids: string[] } | null;

export function Archive() {
  const workspaceAccess = useWorkspaceAccess();
  const [data, setData] = useState<ArchiveData>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [selected, setSelected] = useState<Record<string, Set<string>>>({});
  const [pending, setPending] = useState<PendingArchiveAction>(null);

  const reload = useCallback(async () => {
    try {
      const rows = await Promise.all(sections.map(async ({ module }) => [module, (await listRecords(module, true)).filter((record) => record.archived)] as const));
      const nextData = Object.fromEntries(rows) as ArchiveData;
      setData(nextData);
      setSelected((current) => Object.fromEntries(sections.map(({ module }) => {
        const available = new Set((nextData[module] || []).map((record) => record.id));
        return [module, new Set([...(current[module] || [])].filter((id) => available.has(id)))];
      })));
      setError("");
    } catch (reason) { setError(String(reason)); }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const restore = async (module: ModuleId, record: StoredRecord) => {
    setBusy(record.id);
    try { await archiveRecord(module, record.id, false); await reload(); }
    catch (reason) { setError(String(reason)); }
    finally { setBusy(""); }
  };

  const remove = async (module: ModuleId, record: StoredRecord) => {
    if (!window.confirm(`Окончательно удалить «${record.title}»? Запись, её история и связанные файлы будут удалены без возможности восстановления.`)) return;
    setBusy(record.id);
    try { await deleteRecord(module, record.id); await reload(); }
    catch (reason) { setError(String(reason)); }
    finally { setBusy(""); }
  };

  const processSelected = async () => {
    if (!pending?.ids.length) return;
    const { module, action, ids } = pending;
    setBusy(`${module}-all`);
    try {
      if (action === "delete") await deleteRecords(module, ids);
      else await archiveRecords(module, ids, false);
      await reload();
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(""); setPending(null); }
  };

  const toggleSelected = (module: ModuleId, id: string, checked: boolean) => setSelected((current) => {
    const next = new Set(current[module] || []);
    if (checked) next.add(id); else next.delete(id);
    return { ...current, [module]: next };
  });

  return <div className="archive-grid">
    {!workspaceAccess.editor && <div className="notice warning"><strong>Режим просмотра</strong><span>{workspaceAccess.message}</span></div>}
    {error && <div className="notice error">{error}</div>}
    {sections.map(({ module, title }) => <section className="surface" key={module}>
      <div className="surface-title"><h2>{title}</h2><div className="button-row"><span>{data[module]?.length || 0}</span>{workspaceAccess.editor && Boolean(data[module]?.length) && <><label className="archive-select-all"><input type="checkbox" checked={(selected[module]?.size || 0) === (data[module]?.length || 0)} onChange={(event) => setSelected((current) => ({ ...current, [module]: event.target.checked ? new Set((data[module] || []).map((record) => record.id)) : new Set() }))} /> Выбрать все</label>{Boolean(selected[module]?.size) && <><button className="secondary small" type="button" disabled={busy === `${module}-all`} onClick={() => setPending({ module, action: "restore", ids: [...selected[module]] })}>Восстановить выбранные ({selected[module].size})</button><button className="secondary small danger" type="button" disabled={busy === `${module}-all`} onClick={() => setPending({ module, action: "delete", ids: [...selected[module]] })}>Удалить выбранные</button></>}</>}</div></div>
      <div className="surface-body archive-list">
        {!data[module]?.length && <div className="empty-inline">В архиве нет записей.</div>}
        {data[module]?.map((record) => <div className="archive-row" key={record.id}>
          {workspaceAccess.editor && <input className="archive-row-checkbox" type="checkbox" aria-label={`Выбрать ${record.title}`} checked={selected[module]?.has(record.id) || false} onChange={(event) => toggleSelected(module, record.id, event.target.checked)} />}
          <div><strong>{record.title}</strong><span>Архивировано или изменено: {new Date(record.updatedAt).toLocaleString("ru-RU")}</span></div>
          {workspaceAccess.editor && <button className="secondary small" disabled={busy === record.id} type="button" onClick={() => void restore(module, record)}>Восстановить</button>}
          {workspaceAccess.editor && <button className="secondary small danger" disabled={busy === record.id} type="button" onClick={() => void remove(module, record)}>Удалить навсегда</button>}
        </div>)}
      </div>
    </section>)}
    {pending && <ConfirmDialog title={pending.action === "delete" ? "Удалить выбранные записи навсегда?" : "Восстановить выбранные записи?"} message={pending.action === "delete" ? `Будет удалено записей: ${pending.ids.length}. История и связанные вложения будут удалены без возможности восстановления.` : `Будет восстановлено записей: ${pending.ids.length}.`} confirmLabel={pending.action === "delete" ? "Удалить" : "Восстановить"} onClose={() => setPending(null)} onConfirm={() => void processSelected()} />}
  </div>;
}
