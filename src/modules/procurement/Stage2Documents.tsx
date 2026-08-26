import { useState } from "react";
import { replaceDocumentVersion } from "./domain";
import { chooseAndIngestDocument } from "./documentIngest";
import type { ProcurementData } from "./types";

export function Stage2Documents({ item, procurementId, onChange }: { item: ProcurementData; procurementId?: string; onChange: (item: ProcurementData) => void }) {
  const [source, setSource] = useState("Документация заказчика");
  const [replacementDocumentId, setReplacementDocumentId] = useState("");
  const [message, setMessage] = useState("");
  const [search, setSearch] = useState("");
  const documents = [...new Map(item.documentVersions.map((entry) => [entry.documentId, entry])).values()];
  const query = search.trim().toLocaleLowerCase("ru-RU");
  const matches = query ? item.documentVersions.flatMap((version) => version.fragments.filter((fragment) => `${version.fileName} ${fragment.locator} ${fragment.text}`.toLocaleLowerCase("ru-RU").includes(query)).map((fragment) => ({ version, fragment }))).slice(0, 200) : [];
  const add = async () => {
    if (!procurementId) return;
    setMessage("Извлекаем текст локально…");
    try {
      const version = await chooseAndIngestDocument(procurementId, source, replacementDocumentId || undefined);
      if (!version) { setMessage(""); return; }
      onChange(replaceDocumentVersion(item, version));
      setMessage(`Добавлена версия ${version.fileName}, SHA-256 ${version.sha256}.`);
    } catch (reason) { setMessage(`Ошибка: ${String(reason)}`); }
  };
  return <><div className="notice warning"><strong>Каждое добавление создаёт неизменяемую версию с SHA-256.</strong><span>При замене подтверждения старой версии автоматически становятся устаревшими.</span></div><div className="form-grid"><label>Источник документа<input value={source} onChange={(event) => setSource(event.target.value)} /></label><label>Новая версия существующего документа<select value={replacementDocumentId} onChange={(event) => setReplacementDocumentId(event.target.value)}><option value="">Новый документ</option>{documents.map((entry) => <option key={entry.documentId} value={entry.documentId}>{entry.fileName}</option>)}</select></label></div><button className="primary" disabled={!procurementId} type="button" onClick={() => void add()}>Добавить PDF, DOCX или XLSX</button>{!procurementId && <p className="help-text">Сначала сохраните новую карточку, затем добавляйте версии документов.</p>}{message && <div className={`notice ${message.startsWith("Ошибка") ? "error" : "success"}`}>{message}</div>}<label className="search-box">Поиск по документам, страницам и листам<input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Текст, имя файла, страница, лист или ячейка" /></label>{query && <div className="snapshot-list">{matches.map(({ version, fragment }) => <div key={`${version.versionId}-${fragment.id}`}><span><strong>{version.fileName} · {fragment.locator}</strong><small>{fragment.text.slice(0, 600)}</small></span></div>)}{matches.length === 0 && <p className="muted">Совпадений нет.</p>}</div>}<div className="snapshot-list">{item.documentVersions.map((version) => <div key={version.versionId}><span><strong>{version.fileName}</strong><small>{version.mimeType} · {(version.sizeBytes / 1024).toFixed(1)} КБ · {version.processingStatus}<br />SHA-256 {version.sha256} · фрагментов {version.fragments.length}{version.supersedesVersionId ? ` · заменяет ${version.supersedesVersionId}` : ""}</small></span></div>)}</div></>;
}
