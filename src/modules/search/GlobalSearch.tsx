import { useEffect, useMemo, useRef, useState } from "react";
import { Dialog } from "../../components/Dialog";
import { loadSearchIndex, searchEntries, searchLabels, type SearchEntry, type SearchTool } from "./index";
import "./search.css";

export function GlobalSearch({ onClose, onNavigate }: { onClose: () => void; onNavigate: (tool: SearchTool | "archive", id?: string) => void }) {
  const [query, setQuery] = useState("");
  const [tool, setTool] = useState<SearchTool | "all">("all");
  const [archived, setArchived] = useState(false);
  const [entries, setEntries] = useState<SearchEntry[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [updated, setUpdated] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => {
    let stopped = false;
    setLoading(true);
    void loadSearchIndex().then((result) => {
      if (stopped) return;
      setEntries(result.entries); setErrors(result.errors); setUpdated(new Date().toLocaleTimeString("ru"));
    }).catch((error) => { if (!stopped) setErrors([String(error)]); }).finally(() => { if (!stopped) setLoading(false); });
    return () => { stopped = true; };
  }, [revision]);
  const results = useMemo(() => searchEntries(entries, query, tool, archived), [entries, query, tool, archived]);
  return <Dialog title="Поиск по рабочей папке" onClose={onClose} width="860px">
    <div className="dialog-body global-search" data-workspace-viewer-allowed>
      <label>Что найти?<input ref={input} data-autofocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Компания, ИНН, сотрудник, сертификат, номер договора, текст закупки…" /></label>
      <div className="global-search-filters"><label>Раздел<select value={tool} onChange={(event) => setTool(event.target.value as SearchTool | "all")}><option value="all">Все разделы</option>{Object.entries(searchLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><label className="checkbox-row"><input type="checkbox" checked={archived} onChange={(event) => setArchived(event.target.checked)} />Включая архив</label><button className="secondary" type="button" disabled={loading} onClick={() => setRevision((value) => value + 1)}>Обновить индекс</button></div>
      <p className="help-text">Поиск локальный: карточки, реквизиты, названия вложений и уже извлечённый текст документов закупок. Содержимое сканов без распознавания не индексируется. Файлы никуда не отправляются.</p>
      {errors.length > 0 && <div className="notice error" role="alert">Индекс неполный. Недоступные разделы: {errors.join(" · ")}</div>}
      <p role="status">{loading ? "Читаем данные рабочей папки…" : !query.trim() ? `В индексе ${entries.length} карточек. Введите запрос.` : `Найдено: ${results.length}. Индекс обновлён в ${updated}.`}</p>
      <div className="global-search-results">{results.slice(0, 100).map((hit) => <button key={`${hit.tool}:${hit.id}`} className="search-result" type="button" onClick={() => { onNavigate(hit.archived && hit.tool !== "counterparties" ? "archive" : hit.tool, hit.id); onClose(); }}><span className="search-result-kind">{searchLabels[hit.tool]}{hit.archived ? " · Архив — открыть архив" : ""}</span><strong>{hit.title}</strong><span>{hit.snippet}</span></button>)}</div>
      {!loading && query.trim() && results.length === 0 && <p>Совпадений нет. Попробуйте часть имени, номера или другое ключевое слово.</p>}
      {results.length > 100 && <p>Показаны первые 100 совпадений. Уточните запрос или выберите раздел.</p>}
    </div>
  </Dialog>;
}
