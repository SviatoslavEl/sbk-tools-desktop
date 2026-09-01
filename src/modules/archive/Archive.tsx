import { useCallback, useEffect, useState } from "react";
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

export function Archive() {
  const workspaceAccess = useWorkspaceAccess();
  const [data, setData] = useState<ArchiveData>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  const reload = useCallback(async () => {
    try {
      const rows = await Promise.all(sections.map(async ({ module }) => [module, (await listRecords(module, true)).filter((record) => record.archived)] as const));
      setData(Object.fromEntries(rows)); setError("");
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

  const processAll = async (module: ModuleId, action: "restore" | "delete") => {
    const records = data[module] || [];
    if (!records.length) return;
    const question = action === "delete" ? `Окончательно удалить все записи раздела (${records.length})? История и вложения будут удалены.` : `Восстановить все записи раздела (${records.length})?`;
    if (!window.confirm(question)) return;
    setBusy(`${module}-all`);
    try {
      if (action === "delete") await deleteRecords(module, records.map((record) => record.id));
      else await archiveRecords(module, records.map((record) => record.id), false);
      await reload();
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(""); }
  };

  return <div className="archive-grid">
    {!workspaceAccess.editor && <div className="notice warning"><strong>Режим просмотра</strong><span>{workspaceAccess.message}</span></div>}
    {error && <div className="notice error">{error}</div>}
    {sections.map(({ module, title }) => <section className="surface" key={module}>
      <div className="surface-title"><h2>{title}</h2><div className="button-row"><span>{data[module]?.length || 0}</span>{workspaceAccess.editor && Boolean(data[module]?.length) && <><button className="secondary small" type="button" disabled={busy === `${module}-all`} onClick={() => void processAll(module, "restore")}>Восстановить все</button><button className="secondary small danger" type="button" disabled={busy === `${module}-all`} onClick={() => void processAll(module, "delete")}>Удалить все</button></>}</div></div>
      <div className="surface-body archive-list">
        {!data[module]?.length && <div className="empty-inline">В архиве нет записей.</div>}
        {data[module]?.map((record) => <div className="archive-row" key={record.id}>
          <div><strong>{record.title}</strong><span>Архивировано или изменено: {new Date(record.updatedAt).toLocaleString("ru-RU")}</span></div>
          {workspaceAccess.editor && <button className="secondary small" disabled={busy === record.id} type="button" onClick={() => void restore(module, record)}>Восстановить</button>}
          {workspaceAccess.editor && <button className="secondary small danger" disabled={busy === record.id} type="button" onClick={() => void remove(module, record)}>Удалить навсегда</button>}
        </div>)}
      </div>
    </section>)}
  </div>;
}
