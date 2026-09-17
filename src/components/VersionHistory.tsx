import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { recordHistory, restoreHistoryVersion, type HistoryEntry, type ModuleId } from "../lib/storage";
import { useWorkspaceAccess } from "../lib/workspaceAccess";
import { historyChanges } from "../lib/historyDiff";
import { ConfirmDialog, Dialog } from "./Dialog";

export function VersionHistory({ module, id, title, payload, onRestore }: {
  module: ModuleId; id: string; title: string; payload: unknown;
  onRestore?: (snapshot: unknown) => Promise<unknown>;
}) {
  const access = useWorkspaceAccess();
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [pending, setPending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const restoreOperation = useRef(false);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setBusy(true); setError("");
    void recordHistory(module, id).then((value) => {
      if (!cancelled) { setEntries(value); setSelected(value.find((entry) => entry.snapshot)?.id ?? null); }
    }).catch((reason) => { if (!cancelled) setError(String(reason)); })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [open, module, id, revision]);
  const entry = entries.find((item) => item.id === selected);
  const changes = entry?.snapshot ? historyChanges(entry.snapshot, payload) : [];
  const restore = async () => {
    if (restoreOperation.current) return;
    if (!access.editor || !entry?.snapshot || busy) throw new Error("Восстановление недоступно. Дождитесь загрузки истории и проверьте режим редактора.");
    restoreOperation.current = true;
    setBusy(true); setError("");
    try {
      if (onRestore) await onRestore(entry.snapshot);
      else await restoreHistoryVersion(module, id, entry.id);
      window.dispatchEvent(new Event("sbk-workspace-refresh"));
      setPending(false);
      setRevision((value) => value + 1);
    } catch (reason) { setError(String(reason)); throw reason; }
    finally { restoreOperation.current = false; setBusy(false); }
  };
  return <><button className="secondary small" type="button" aria-label={`История изменений: ${title}`} onDoubleClick={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); setOpen(true); }}>История</button>{open && createPortal(<Dialog title={`История изменений: ${title}`} closeDisabled={busy} onClose={() => { if (!busy) setOpen(false); }}>
    <div className="version-history">
      <p>Снимок хранит состояние <strong>до указанного изменения</strong>. Сравнение показывает отличие от текущей сохранённой карточки. Возврат не удаляет последующие снимки.</p>
      {error && <div role="alert" className="notice error">{error}</div>}
      {busy && <p role="status">Загружаем историю…</p>}
      {!busy && !entries.length && <p>Сохранённых изменений пока нет. Для компаний история начинает накапливаться после обновления программы.</p>}
      <div className="history-entry-list">{entries.map((item) => <button type="button" key={item.id} disabled={!item.snapshot || busy} aria-pressed={selected === item.id} onClick={() => setSelected(item.id)}>{new Date(item.createdAt).toLocaleString("ru-RU")} · {({ created: "Создание", updated: "Изменение", archived: "Архив", restored: "Восстановление", "version-restored": "Возврат версии" })[item.action]}{!item.snapshot ? " · без снимка" : ""}</button>)}</div>
      {entry?.snapshot ? <><h3>Отличия от текущей карточки: {changes.length}</h3>{changes.length ? <div className="table-scroll"><table><thead><tr><th>Поле</th><th>Выбранное состояние</th><th>Сейчас</th></tr></thead><tbody>{changes.map((change) => <tr key={change.field}><th>{change.field}</th><td>{change.before}</td><td>{change.after}</td></tr>)}</tbody></table></div> : <p>Данные совпадают.</p>}<button className="primary" type="button" disabled={!access.editor || busy || !changes.length} onClick={() => setPending(true)}>Восстановить это состояние</button></> : null}
      {!access.editor && <p>Просмотр истории доступен. Возврат версии — только текущему редактору базы.</p>}
    </div>
    {pending && <ConfirmDialog title="Вернуть сохранённое состояние?" message="Будут восстановлены данные выбранной карточки. Текущее состояние останется в истории. Для компании связанные реквизиты договоров также обновятся; несохранённые изменения в других открытых редакторах сюда не входят." confirmLabel="Восстановить" onClose={() => { if (!restoreOperation.current) setPending(false); }} onConfirm={restore} />}
  </Dialog>, document.body)}</>;
}
