import { useEffect, useMemo, useState } from "react";
import { ConfirmDialog, Dialog } from "../../components/Dialog";
import { useRecords } from "../../hooks/useRecords";
import { parseCsv, toCsv } from "../../lib/csv";
import { chooseOpenPath, exportText, importText } from "../../lib/files";
import { copyAttachment, recordHistory, type HistoryEntry, type StoredRecord } from "../../lib/storage";
import { cooperationBases, emptyStaff, emptyStaffDocument, workStatuses, type StaffData, type StaffDocument } from "./types";
import { documentExpiry, staffRequirements, urgentDocument, type ExpiryCategory } from "./requirements";

const date = (value: string) => value ? new Date(`${value}T00:00:00`).toLocaleDateString("ru-RU") : "—";
const categoryLabels: Record<StaffDocument["category"], string> = { education: "Образование и дипломы", certificate: "Сертификаты", contract: "Договоры", permit: "Удостоверения и допуски", other: "Прочие документы" };

const expiryLabels: Record<ExpiryCategory, string> = { expired: "Истёк", expiring: "Истекает", valid: "Действует", unlimited: "Бессрочный", missing: "Нет срока" };

export function StaffRegistry() {
  const store = useRecords<StaffData>("staff");
  const settings = useRecords<{ expiryDays?: 30 | 60 | 90 }>("settings");
  const expiryDays = settings.records.find((record) => record.title === "application")?.payload.expiryDays || 60;
  const [search, setSearch] = useState("");
  const [basisFilter, setBasisFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [expiryFilter, setExpiryFilter] = useState<"" | ExpiryCategory | "no-document">("");
  const [editing, setEditing] = useState<StoredRecord<StaffData> | "new" | null>(null);
  const [archiving, setArchiving] = useState<StoredRecord<StaffData> | null>(null);
  const [importRows, setImportRows] = useState<StaffData[] | null>(null);
  const [importReport, setImportReport] = useState<string | null>(null);

  const filtered = useMemo(() => store.records.filter((record) => {
    const item = record.payload;
    const matches = [item.fullName, item.role, item.qualification, item.basis].join(" ").toLowerCase().includes(search.toLowerCase());
    const categories = item.documents.map((document) => documentExpiry(document, expiryDays));
    const expiryMatches = !expiryFilter || (expiryFilter === "no-document" ? item.documents.length === 0 : categories.includes(expiryFilter));
    return matches && (!basisFilter || item.basis === basisFilter) && (!statusFilter || item.status === statusFilter) && expiryMatches;
  }), [store.records, search, basisFilter, statusFilter, expiryFilter, expiryDays]);
  const documentCount = store.records.reduce((sum, record) => sum + record.payload.documents.length, 0);
  const expiringCount = store.records.filter((record) => Boolean(urgentDocument(record.payload.documents, expiryDays))).length;

  const exportSelection = async () => {
    await exportText("Экспорт кадров", "кадры.csv", ["csv"], toCsv(["ФИО", "Дата рождения", "Должность", "Квалификация", "Основание", "Пояснение основания", "Реквизиты основания", "Начало", "Окончание", "Статус", "Телефон", "Email", "Стаж", "Документов", "Примечания"], filtered.map(({ payload: item }) => [item.fullName, item.birthDate, item.role, item.qualification, item.basis, item.basisOther, item.basisNumber, item.startDate, item.endDate, item.status, item.phone, item.email, item.experienceYears, item.documents.length, item.notes])));
  };

  const openImport = async () => {
    const imported = await importText("Импорт кадров", ["csv"]);
    if (!imported) return;
    const [headers, ...rows] = parseCsv(imported.content);
    const index = (name: string) => headers.findIndex((header) => header.toLowerCase().trim() === name.toLowerCase());
    const parsed = rows.map((row) => ({ ...emptyStaff(), fullName: row[index("ФИО")] || "", birthDate: row[index("Дата рождения")] || "", role: row[index("Должность")] || "", qualification: row[index("Квалификация")] || "", basis: cooperationBases.includes(row[index("Основание")] as never) ? row[index("Основание")] as StaffData["basis"] : "Иное", basisOther: row[index("Пояснение основания")] || "", basisNumber: row[index("Реквизиты основания")] || "", startDate: row[index("Начало")] || "", endDate: row[index("Окончание")] || "", status: workStatuses.includes(row[index("Статус")] as never) ? row[index("Статус")] as StaffData["status"] : "Работает", phone: row[index("Телефон")] || "", email: row[index("Email")] || "", experienceYears: Number(row[index("Стаж")]) || 0, notes: row[index("Примечания")] || "" }));
    setImportRows(parsed); setImportReport(null);
  };

  const commitImport = async () => {
    if (!importRows) return;
    let success = 0; const errors: string[] = [];
    for (const [index, item] of importRows.entries()) {
      if (!item.fullName || !item.role || (item.basis === "Иное" && !item.basisOther)) { errors.push(`Строка ${index + 2}: нужны ФИО, должность и пояснение для «Иное»`); continue; }
      const duplicate = store.records.some((record) => record.payload.fullName.toLowerCase() === item.fullName.toLowerCase() && record.payload.birthDate === item.birthDate);
      if (duplicate) { errors.push(`Строка ${index + 2}: возможный дубль ${item.fullName}`); continue; }
      try { await store.save(item.fullName, item); success += 1; } catch (reason) { errors.push(`Строка ${index + 2}: ${String(reason)}`); }
    }
    setImportReport(`Добавлено: ${success}. Ошибок и пропусков: ${errors.length}.${errors.length ? `\n${errors.slice(0, 8).join("\n")}` : ""}`);
    if (!errors.length) setImportRows(null);
  };

  return <div className="module-stack">
    <div className="stats-row"><div className="stat"><span>Людей в реестре</span><strong>{store.records.length}</strong></div><div className="stat"><span>Документов</span><strong>{documentCount}</strong></div><div className="stat"><span>Скоро истекают</span><strong>{expiringCount}</strong></div></div>
    <div className="registry-toolbar"><label className="search-box"><span>Поиск</span><input placeholder="ФИО, должность, квалификация" value={search} onChange={(event) => setSearch(event.target.value)} /></label><label><span>Основание</span><select value={basisFilter} onChange={(event) => setBasisFilter(event.target.value)}><option value="">Все</option>{cooperationBases.map((item) => <option key={item}>{item}</option>)}</select></label><label><span>Статус</span><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="">Все</option>{workStatuses.map((item) => <option key={item}>{item}</option>)}</select></label><label><span>Документы</span><select value={expiryFilter} onChange={(event) => setExpiryFilter(event.target.value as typeof expiryFilter)}><option value="">Все</option><option value="expired">Истёкшие</option><option value="expiring">Истекают ≤{expiryDays} дней</option><option value="unlimited">Бессрочные</option><option value="no-document">Нет документов</option></select></label><div className="toolbar-actions"><button className="secondary" type="button" onClick={() => void openImport()}>Импорт CSV</button><button className="secondary" type="button" onClick={() => void exportSelection()}>Экспорт выборки</button><button className="primary" type="button" onClick={() => setEditing("new")}>Добавить человека</button></div></div>
    {store.error && <div className="notice error"><strong>Не удалось открыть кадровый реестр.</strong><span>{store.error}</span></div>}
    <div className="surface table-surface"><div className="table-scroll"><table><thead><tr><th>ФИО</th><th>Должность / роль</th><th>Основание</th><th>Статус</th><th>Квалификация</th><th>Самый срочный документ</th><th>Готовность к закупке</th><th /></tr></thead><tbody>{filtered.map((record) => { const item = record.payload; const urgent = urgentDocument(item.documents, expiryDays); const requirements = staffRequirements(item, expiryDays); return <tr key={record.id} onDoubleClick={() => setEditing(record)}><td className="sticky-cell"><button className="link-button" type="button" onClick={() => setEditing(record)}><strong>{item.fullName}</strong><small>{item.birthDate ? `р. ${date(item.birthDate)}` : ""}</small></button></td><td>{item.role}</td><td><span className="status neutral">{item.basis}{item.basis === "Иное" && item.basisOther ? `: ${item.basisOther}` : ""}</span></td><td>{item.status}</td><td>{item.qualification || "—"}</td><td>{urgent ? <span className={`status ${urgent.category === "expired" ? "danger" : "warning"}`}>{expiryLabels[urgent.category]}: {urgent.document.name || urgent.document.type} · {date(urgent.document.expiresDate)}</span> : "—"}</td><td><span className={`status ${requirements.ready ? "success" : "warning"}`} title={requirements.missing.length ? `Не хватает: ${requirements.missing.join(", ")}` : "Комплект готов"}>{requirements.met} из {requirements.total} · {requirements.ready ? "готов" : "не готов"}</span></td><td><button className="icon-button danger" type="button" aria-label={`Архивировать ${item.fullName}`} onClick={() => setArchiving(record)}>×</button></td></tr>; })}</tbody></table></div>{!store.loading && filtered.length === 0 && <div className="empty-state"><span className="empty-icon">●</span><h2>{store.records.length ? "Ничего не найдено" : "Добавьте первого человека"}</h2><p>{store.records.length ? "Измените поиск или фильтры." : "Здесь будут основания сотрудничества, дипломы, сертификаты и договоры."}</p>{!store.records.length && <button className="primary" type="button" onClick={() => setEditing("new")}>Добавить человека</button>}</div>}</div>
    {editing && <StaffEditor record={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} onSave={async (item, id) => { await store.save(item.fullName, item, id); setEditing(null); }} />}
    {archiving && <ConfirmDialog title="Переместить карточку в архив?" message={`${archiving.payload.fullName} и сведения о документах останутся в базе.`} confirmLabel="В архив" onClose={() => setArchiving(null)} onConfirm={() => { void store.archive(archiving.id); setArchiving(null); }} />}
    {importRows && <Dialog title="Предпросмотр импорта кадров" description="Документы добавляются в карточках после импорта." onClose={() => setImportRows(null)} width="960px"><div className="dialog-body"><div className="import-summary"><strong>Строк к импорту: {importRows.length}</strong><span>Показаны первые 10.</span></div><div className="table-scroll"><table><thead><tr><th>ФИО</th><th>Дата рождения</th><th>Должность</th><th>Основание</th><th>Статус</th></tr></thead><tbody>{importRows.slice(0, 10).map((item, index) => <tr key={`${item.fullName}-${index}`}><td>{item.fullName || <span className="field-error">нет</span>}</td><td>{item.birthDate}</td><td>{item.role || <span className="field-error">нет</span>}</td><td>{item.basis}{item.basis === "Иное" && !item.basisOther ? <span className="field-error"> · нужно пояснение</span> : ""}</td><td>{item.status}</td></tr>)}</tbody></table></div>{importReport && <pre className="import-report">{importReport}</pre>}</div><footer className="dialog-actions"><button className="secondary" type="button" onClick={() => setImportRows(null)}>Отмена</button><button className="primary" type="button" onClick={() => void commitImport()}>Импортировать корректные строки</button></footer></Dialog>}
  </div>;
}

type StaffTab = "general" | "work" | "education" | "certificates" | "contracts" | "experience" | "files" | "notes";

function StaffEditor({ record, onSave, onClose }: { record?: StoredRecord<StaffData>; onSave: (item: StaffData, id: string) => Promise<void>; onClose: () => void }) {
  const recordId = record?.id || crypto.randomUUID();
  const [item, setItem] = useState<StaffData>(record ? structuredClone(record.payload) : emptyStaff());
  const [tab, setTab] = useState<StaffTab>("general");
  const [error, setError] = useState("");
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  useEffect(() => { if (record) void recordHistory("staff", record.id).then(setHistory); }, [record]);
  const update = <K extends keyof StaffData>(key: K, value: StaffData[K]) => setItem((current) => ({ ...current, [key]: value }));
  const save = async () => {
    if (!item.fullName.trim() || !item.role.trim()) { setError("Заполните ФИО и должность/роль."); setTab("general"); return; }
    if (item.basis === "Иное" && !item.basisOther.trim()) { setError("Для основания «Иное» добавьте пояснение."); setTab("work"); return; }
    await onSave(item, recordId);
  };
  const tabs: Array<[StaffTab, string]> = [["general", "Общие"], ["work", "Работа"], ["education", "Дипломы"], ["certificates", "Сертификаты"], ["contracts", "Договоры"], ["experience", "Стаж"], ["files", "Все файлы"], ["notes", "Примечания"]];
  const requirements = staffRequirements(item);
  return <aside className="detail-drawer wide-drawer" role="dialog" aria-modal="true" aria-label="Карточка человека"><header><div><h2>{record ? item.fullName : "Новый человек"}</h2><p>Карточка и подтверждающие документы</p></div><button className="icon-button" type="button" onClick={onClose}>×</button></header><nav className="drawer-tabs">{tabs.map(([id, label]) => <button key={id} className={tab === id ? "active" : ""} type="button" onClick={() => setTab(id)}>{label}</button>)}</nav><div className="drawer-body">
    {error && <div className="notice error">{error}</div>}
    {tab === "general" && <><h3>Общие сведения</h3><div className="form-grid"><label className="wide">ФИО *<input value={item.fullName} onChange={(event) => update("fullName", event.target.value)} /></label><label>Дата рождения<input type="date" value={item.birthDate} onChange={(event) => update("birthDate", event.target.value)} /></label><label>Должность / роль *<input value={item.role} onChange={(event) => update("role", event.target.value)} /></label><label className="wide">Ключевая квалификация<input value={item.qualification} onChange={(event) => update("qualification", event.target.value)} /></label><label>Телефон<input value={item.phone} onChange={(event) => update("phone", event.target.value)} /></label><label>Email<input type="email" value={item.email} onChange={(event) => update("email", event.target.value)} /></label></div></>}
    {tab === "work" && <><h3>Работа и основание</h3><div className="form-grid"><label>Основание<select value={item.basis} onChange={(event) => update("basis", event.target.value as StaffData["basis"])}>{cooperationBases.map((value) => <option key={value}>{value}</option>)}</select></label><label>Рабочий статус<select value={item.status} onChange={(event) => update("status", event.target.value as StaffData["status"])}>{workStatuses.map((value) => <option key={value}>{value}</option>)}</select></label>{item.basis === "Иное" && <label className="wide">Пояснение основания *<input value={item.basisOther} onChange={(event) => update("basisOther", event.target.value)} /></label>}<label className="wide">Реквизиты основания<input value={item.basisNumber} onChange={(event) => update("basisNumber", event.target.value)} placeholder="Номер трудового договора, ГПХ или соглашения" /></label><label>Дата начала<input type="date" value={item.startDate} onChange={(event) => update("startDate", event.target.value)} /></label><label>Дата окончания<input type="date" value={item.endDate} onChange={(event) => update("endDate", event.target.value)} /></label></div></>}
    {tab === "education" && <DocumentsEditor title="Образование и дипломы" categories={["education"]} recordId={recordId} documents={item.documents} onChange={(documents) => update("documents", documents)} />}
    {tab === "certificates" && <DocumentsEditor title="Сертификаты, удостоверения и допуски" categories={["certificate", "permit"]} recordId={recordId} documents={item.documents} onChange={(documents) => update("documents", documents)} />}
    {tab === "contracts" && <DocumentsEditor title="Договоры — основания сотрудничества" categories={["contract"]} recordId={recordId} documents={item.documents} onChange={(documents) => update("documents", documents)} />}
    {tab === "experience" && <><h3>Стаж и опыт</h3><div className="form-grid"><label>Стаж, лет<input type="number" min="0" step="0.5" value={item.experienceYears} onChange={(event) => update("experienceYears", Number(event.target.value))} /></label><label className="wide">Описание опыта<textarea rows={8} value={item.experienceNotes} onChange={(event) => update("experienceNotes", event.target.value)} /></label></div></>}
    {tab === "files" && <><h3>Все сохранённые файлы</h3>{item.documents.filter((doc) => doc.relativePath).length ? <div className="file-list">{item.documents.filter((doc) => doc.relativePath).map((doc) => <div key={doc.id}><span>▧</span><div><strong>{doc.fileName}</strong><small>{categoryLabels[doc.category]} · {doc.name || doc.type}</small></div></div>)}</div> : <div className="empty-inline">Файлы не прикреплены. Их можно добавить внутри диплома, сертификата или договора.</div>}</>}
    {tab === "notes" && <><h3>Примечания и история</h3><label>Примечания<textarea rows={10} value={item.notes} onChange={(event) => update("notes", event.target.value)} /></label>{record && <div className="history-note"><span>Создано: {new Date(record.createdAt).toLocaleString("ru-RU")}</span>{history.map((entry, index) => <span key={`${entry.createdAt}-${index}`}>{entry.action === "created" ? "Создано" : entry.action === "updated" ? "Изменено" : entry.action === "archived" ? "Архивировано" : "Восстановлено"}: {new Date(entry.createdAt).toLocaleString("ru-RU")}</span>)}</div>}</>}
  </div><footer><span className="drawer-completeness" title={requirements.missing.length ? `Не хватает: ${requirements.missing.join(", ")}` : "Комплект готов"}>Готовность: {requirements.met} из {requirements.total}{requirements.missing.length ? ` · нет: ${requirements.missing.join(", ")}` : " · готово"}</span><button className="secondary" type="button" onClick={onClose}>Отмена</button><button className="primary" type="button" onClick={() => void save()}>Сохранить карточку</button></footer></aside>;
}

function DocumentsEditor({ title, categories, recordId, documents, onChange }: { title: string; categories: StaffDocument["category"][]; recordId: string; documents: StaffDocument[]; onChange: (items: StaffDocument[]) => void }) {
  const visible = documents.filter((item) => categories.includes(item.category));
  const update = (id: string, patch: Partial<StaffDocument>) => onChange(documents.map((item) => item.id === id ? { ...item, ...patch } : item));
  const addFile = async (doc: StaffDocument) => {
    const path = await chooseOpenPath("Выберите подтверждающий документ", ["pdf", "png", "jpg", "jpeg", "doc", "docx"]);
    if (!path) return;
    const attachment = await copyAttachment(path, "staff", recordId);
    update(doc.id, { relativePath: attachment.relativePath, fileName: attachment.fileName });
  };
  return <><div className="inline-heading"><div><h3>{title}</h3><p>Каждый документ хранится отдельной записью.</p></div><button className="primary" type="button" onClick={() => onChange([...documents, emptyStaffDocument(categories[0])])}>Добавить документ</button></div>{visible.length === 0 && <div className="empty-inline">Документов пока нет.</div>}{visible.map((doc) => <section className="document-card" key={doc.id}><div className="document-card-header"><select aria-label="Категория документа" value={doc.category} onChange={(event) => update(doc.id, { category: event.target.value as StaffDocument["category"] })}><option value="education">Диплом / образование</option><option value="certificate">Сертификат</option><option value="permit">Удостоверение / допуск</option><option value="contract">Договор</option><option value="other">Другое</option></select><button className="icon-button danger" type="button" onClick={() => onChange(documents.filter((item) => item.id !== doc.id))}>×</button></div><div className="form-grid"><label>Тип<input value={doc.type} onChange={(event) => update(doc.id, { type: event.target.value })} placeholder="Диплом, удостоверение…" /></label><label>Название<input value={doc.name} onChange={(event) => update(doc.id, { name: event.target.value })} /></label><label>Серия / номер<input value={doc.seriesNumber} onChange={(event) => update(doc.id, { seriesNumber: event.target.value })} /></label><label>Кем выдан<input value={doc.issuer} onChange={(event) => update(doc.id, { issuer: event.target.value })} /></label><label>Дата выдачи<input type="date" value={doc.issuedDate} onChange={(event) => update(doc.id, { issuedDate: event.target.value })} /></label><label>Срок действия<input type="date" disabled={doc.unlimited} value={doc.expiresDate} onChange={(event) => update(doc.id, { expiresDate: event.target.value })} /></label><label className="checkbox-row"><input type="checkbox" checked={doc.unlimited} onChange={(event) => update(doc.id, { unlimited: event.target.checked, expiresDate: event.target.checked ? "" : doc.expiresDate })} /> Бессрочный</label><label className="wide">Комментарий<textarea rows={2} value={doc.comment} onChange={(event) => update(doc.id, { comment: event.target.value })} /></label></div><div className="document-file">{doc.fileName ? <span>▧ {doc.fileName}</span> : <span className="muted">Файл не сохранён</span>}<button className="secondary small" type="button" onClick={() => void addFile(doc)}>{doc.fileName ? "Заменить файл" : "Добавить файл"}</button></div></section>)}</>;
}
