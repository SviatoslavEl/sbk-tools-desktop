import type { StoredRecord } from "../../lib/storage";
import type { StaffData, StaffDocument } from "./types";
import { selectedStaffAttachmentPaths, staffDocumentOptions } from "./documentSelection";
import "./staff-selection-documents.css";

const categories: Record<StaffDocument["category"], string> = { certificate: "Сертификат", education: "Диплом / образование", contract: "Договор", permit: "Удостоверение / допуск", other: "Прочий документ" };
const date = (value: string) => value ? new Date(`${value}T00:00:00`).toLocaleDateString("ru-RU") : "не указан";

export function StaffSelectionDocuments({ records, selected, onChange }: {
  records: Array<Pick<StoredRecord<StaffData>, "id" | "payload">>;
  selected: ReadonlySet<string>;
  onChange: (selected: Set<string>) => void;
}) {
  const options = staffDocumentOptions(records);
  const toggle = (keys: string[], checked: boolean) => {
    const next = new Set(selected);
    for (const key of keys) { if (checked) next.add(key); else next.delete(key); }
    onChange(next);
  };
  return <section className="staff-selection-documents" aria-label="Конкретные документы кадров для ZIP">
    <div className="inline-heading"><div><h3>Документы для ZIP</h3><p role="status">Выбрано файлов: {selectedStaffAttachmentPaths(records, selected).length}</p></div><div className="button-row"><button className="secondary small" type="button" disabled={!options.some((option) => option.selectable)} onClick={() => toggle(options.filter((option) => option.selectable).map((option) => option.key), true)}>Выбрать все файлы</button><button className="secondary small" type="button" disabled={!selected.size} onClick={() => onChange(new Set())}>Снять выбор файлов</button></div></div>
    <p className="help-text">Отметьте конкретные документы каждого выбранного сотрудника. Категория не выбирает другие файлы автоматически. Записи без прикреплённого файла недоступны.</p>
    {!records.length && <p className="empty-inline">Сначала отметьте сотрудников в списке выше.</p>}
    {records.map((record) => {
      const group = options.filter((option) => option.recordId === record.id);
      const available = group.filter((option) => option.selectable).map((option) => option.key);
      return <section className="staff-document-selection-group" key={record.id} aria-label={`Документы: ${record.payload.fullName}`}>
        <div className="inline-heading"><strong>{record.payload.fullName}</strong><div className="button-row"><button className="link-button" type="button" disabled={!available.length} onClick={() => toggle(available, true)}>Выбрать все у сотрудника</button><button className="link-button" type="button" disabled={!available.some((key) => selected.has(key))} onClick={() => toggle(available, false)}>Снять у сотрудника</button></div></div>
        {!group.length && <p className="help-text">Документы не добавлены.</p>}
        {group.map(({ document, key, selectable }) => <label key={key} className={`staff-document-selection-row${selectable ? "" : " unavailable"}`}>
          <input type="checkbox" aria-label={`Включить: ${record.payload.fullName} — ${document.name || document.type || categories[document.category]}`} checked={selectable && selected.has(key)} disabled={!selectable} onChange={(event) => toggle([key], event.target.checked)} />
          <span><strong>{document.name || document.type || categories[document.category]}</strong><small>{categories[document.category]} · № {document.seriesNumber || "не указан"} · {document.unlimited ? "Бессрочный" : `Действует до: ${date(document.expiresDate)}`}</small><small>{selectable ? document.fileName || "Прикреплённый файл" : "Без файла — нельзя включить в ZIP"}</small></span>
        </label>)}
      </section>;
    })}
  </section>;
}
