import { useEffect, useMemo, useState } from "react";
import { ConfirmDialog, Dialog } from "../../components/Dialog";
import { useRecords } from "../../hooks/useRecords";
import { parseCsv, toCsv } from "../../lib/csv";
import { chooseOpenPath, chooseSavePath, exportText } from "../../lib/files";
import { readTextFile, readXlsx, recordHistory, restoreHistoryVersion, writeXlsx, type HistoryEntry, type StoredRecord } from "../../lib/storage";
import { actsStatuses, contractStages, emptyContract, paymentStatuses, type ContractData } from "./types";
import { contractBalance, contractChecks } from "./validation";

const money = (value: number) => new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(value) + " ₽";
const date = (value: string) => value ? new Date(`${value}T00:00:00`).toLocaleDateString("ru-RU") : "—";
const contractHeaders = ["Номер", "Дата", "Заказчик", "Предмет", "Сумма", "Начало", "Окончание", "Стадия", "Оплата", "Акты", "Оплачено", "Важная дата", "Ответственный", "Контакт", "Примечания"];
const importFields = [
  ["number", "Номер *", ["номер", "№", "договор"]], ["date", "Дата", ["дата"]], ["customer", "Заказчик *", ["заказчик"]],
  ["subject", "Предмет *", ["предмет"]], ["amount", "Сумма", ["сумма"]], ["start", "Начало", ["начало"]], ["end", "Окончание", ["окончание"]],
  ["stage", "Стадия", ["стадия"]], ["payment", "Оплата", ["оплата"]], ["acts", "Акты", ["акты"]], ["paid", "Оплачено", ["оплачено"]],
  ["important", "Важная дата", ["важная дата"]], ["responsible", "Ответственный", ["ответственный"]], ["contact", "Контакт", ["контакт"]], ["notes", "Примечания", ["примечания"]],
] as const;
type ImportField = typeof importFields[number][0];

function mapContracts(rows: string[][], mapping: Record<ImportField, number>): ContractData[] {
  const value = (row: string[], key: ImportField) => mapping[key] >= 0 ? row[mapping[key]] || "" : "";
  const number = (text: string) => Number(text.replace(/\s/g, "").replace(",", ".")) || 0;
  return rows.filter((row) => row.some(Boolean)).map((row) => ({ ...emptyContract(), number: value(row, "number"), date: value(row, "date"), customer: value(row, "customer"), subject: value(row, "subject"), amount: number(value(row, "amount")), startDate: value(row, "start"), endDate: value(row, "end"), stage: contractStages.includes(value(row, "stage") as never) ? value(row, "stage") as ContractData["stage"] : "Подготовка", paymentStatus: paymentStatuses.includes(value(row, "payment") as never) ? value(row, "payment") as ContractData["paymentStatus"] : "Не выставлено", actsStatus: actsStatuses.includes(value(row, "acts") as never) ? value(row, "acts") as ContractData["actsStatus"] : "Не подготовлены", paidAmount: number(value(row, "paid")), nextImportantDate: value(row, "important"), responsible: value(row, "responsible"), contact: value(row, "contact"), notes: value(row, "notes") }));
}

export function ContractsRegistry() {
  const store = useRecords<ContractData>("contract-experience");
  const [search, setSearch] = useState("");
  const [stageFilter, setStageFilter] = useState("");
  const [paymentFilter, setPaymentFilter] = useState("");
  const [editing, setEditing] = useState<StoredRecord<ContractData> | "new" | null>(null);
  const [archiving, setArchiving] = useState<StoredRecord<ContractData> | null>(null);
  const [importRows, setImportRows] = useState<ContractData[] | null>(null);
  const [importSource, setImportSource] = useState<{ headers: string[]; rows: string[][]; mapping: Record<ImportField, number> } | null>(null);
  const [importReport, setImportReport] = useState<string | null>(null);

  const filtered = useMemo(() => store.records.filter((record) => {
    const item = record.payload;
    const matchesText = [item.number, item.customer, item.subject, item.responsible].join(" ").toLowerCase().includes(search.toLowerCase());
    return matchesText && (!stageFilter || item.stage === stageFilter) && (!paymentFilter || item.paymentStatus === paymentFilter);
  }), [store.records, search, stageFilter, paymentFilter]);

  const stats = useMemo(() => ({
    total: store.records.length,
    active: store.records.filter((record) => record.payload.stage === "Исполняется").length,
    payment: store.records.filter((record) => ["Ожидается", "Частично оплачено", "Просрочено"].includes(record.payload.paymentStatus)).length,
  }), [store.records]);

  const exportSelection = async () => {
    const rows = filtered.map(({ payload: item }) => [item.number, item.date, item.customer, item.subject, item.amount, item.startDate, item.endDate, item.stage, item.paymentStatus, item.actsStatus, item.paidAmount, item.nextImportantDate, item.responsible, item.contact, item.notes]);
    await exportText("Экспорт договоров", "опыт-по-договорам.csv", ["csv"], toCsv(contractHeaders, rows));
  };
  const exportXlsx = async () => {
    const path = await chooseSavePath("Экспорт договоров в Excel", "опыт-по-договорам.xlsx", ["xlsx"]);
    if (!path) return;
    const rows = filtered.map(({ payload: item }) => [item.number, item.date, item.customer, item.subject, String(item.amount), item.startDate, item.endDate, item.stage, item.paymentStatus, item.actsStatus, String(item.paidAmount), item.nextImportantDate, item.responsible, item.contact, item.notes]);
    await writeXlsx(path, { sheetName: "Договоры", rows: [contractHeaders, ...rows] });
  };

  const openImport = async () => {
    const path = await chooseOpenPath("Импорт договоров", ["csv", "xlsx"]);
    if (!path) return;
    const table = path.toLowerCase().endsWith(".xlsx") ? (await readXlsx(path)).rows : parseCsv(await readTextFile(path));
    const [headers = [], ...rows] = table;
    const mapping = Object.fromEntries(importFields.map(([key, , aliases]) => [key, headers.findIndex((header) => aliases.includes(header.toLowerCase().trim() as never))])) as Record<ImportField, number>;
    const parsed = mapContracts(rows, mapping);
    setImportSource({ headers, rows, mapping });
    setImportRows(parsed);
    setImportReport(null);
  };

  const commitImport = async () => {
    if (!importRows || !importSource) return;
    const errors: string[] = [];
    const keys = new Set<string>();
    for (const [index, item] of importRows.entries()) {
      if (!item.number || !item.customer || !item.subject) {
        errors.push(`Строка ${index + 2}: нужны номер, заказчик и предмет`);
        continue;
      }
      const raw = importSource.rows[index] || [];
      const rawValue = (key: ImportField) => importSource.mapping[key] >= 0 ? (raw[importSource.mapping[key]] || "").trim() : "";
      if (rawValue("stage") && !contractStages.includes(rawValue("stage") as never)) errors.push(`Строка ${index + 2}: неизвестная стадия «${rawValue("stage")}»`);
      if (rawValue("payment") && !paymentStatuses.includes(rawValue("payment") as never)) errors.push(`Строка ${index + 2}: неизвестный статус оплаты «${rawValue("payment")}»`);
      if (rawValue("acts") && !actsStatuses.includes(rawValue("acts") as never)) errors.push(`Строка ${index + 2}: неизвестный статус актов «${rawValue("acts")}»`);
      const key = `${item.number.trim().toLowerCase()}|${item.customer.trim().toLowerCase()}|${item.date}`;
      if (keys.has(key)) errors.push(`Строка ${index + 2}: дубль внутри файла ${item.number}`);
      keys.add(key);
      const duplicate = store.records.some((record) => record.payload.number === item.number && record.payload.customer === item.customer && record.payload.date === item.date);
      if (duplicate) errors.push(`Строка ${index + 2}: дубль существующего договора ${item.number}`);
      for (const check of contractChecks(item).filter((check) => check.severity === "error")) errors.push(`Строка ${index + 2}: ${check.message}`);
    }
    if (errors.length) { setImportReport(`Импорт отменён: исправьте ${errors.length} ошибок. Данные не изменены.\n${errors.slice(0, 12).join("\n")}`); return; }
    try {
      for (const item of importRows) await store.save(`${item.number} — ${item.customer}`, item);
      setImportReport(`Пакет принят полностью: ${importRows.length} записей.`);
      setImportRows(null); setImportSource(null);
    } catch (reason) { setImportReport(`Не удалось завершить импорт: ${String(reason)}. Проверьте реестр перед повтором.`); }
  };

  return <div className="module-stack">
    <div className="stats-row"><div className="stat"><span>Всего договоров</span><strong>{stats.total}</strong></div><div className="stat"><span>В исполнении</span><strong>{stats.active}</strong></div><div className="stat"><span>Ожидают оплаты</span><strong>{stats.payment}</strong></div></div>
    <div className="registry-toolbar"><label className="search-box"><span>Поиск</span><input placeholder="Номер, заказчик, предмет" value={search} onChange={(event) => setSearch(event.target.value)} /></label><label><span>Стадия</span><select value={stageFilter} onChange={(event) => setStageFilter(event.target.value)}><option value="">Все</option>{contractStages.map((item) => <option key={item}>{item}</option>)}</select></label><label><span>Оплата</span><select value={paymentFilter} onChange={(event) => setPaymentFilter(event.target.value)}><option value="">Все</option>{paymentStatuses.map((item) => <option key={item}>{item}</option>)}</select></label><div className="toolbar-actions"><button className="secondary" type="button" onClick={() => void openImport()}>Импорт CSV / XLSX</button><button className="secondary" type="button" onClick={() => void exportSelection()}>CSV</button><button className="secondary" type="button" onClick={() => void exportXlsx()}>XLSX</button><button className="primary" type="button" onClick={() => setEditing("new")}>Добавить договор</button></div></div>
    {store.error && <div className="notice error"><strong>Не удалось открыть реестр.</strong><span>{store.error}</span></div>}
    <div className="surface table-surface"><div className="table-scroll"><table><thead><tr><th>Номер и дата</th><th>Заказчик</th><th>Предмет</th><th>Сумма</th><th>Период</th><th>Стадия</th><th>Оплата</th><th>Акты</th><th>Важная дата</th><th>Ответственный</th><th /></tr></thead><tbody>
      {filtered.map((record) => { const item = record.payload; const checks = contractChecks(item); return <tr key={record.id} onDoubleClick={() => setEditing(record)}><td className="sticky-cell"><button className="link-button" type="button" onClick={() => setEditing(record)}><strong>{item.number}</strong><small>{date(item.date)}</small></button></td><td>{item.customer}</td><td className="wide-cell">{item.subject}{checks.length > 0 && <small className="validation-summary" title={checks.map((check) => check.message).join("\n")}>⚠ {checks.length} замеч.</small>}</td><td>{money(item.amount)}{contractBalance(item).overpayment > 0 && <small className="field-error">Переплата {money(contractBalance(item).overpayment)}</small>}</td><td>{date(item.startDate)} — {date(item.endDate)}</td><td><span className="status neutral">{item.stage}</span></td><td><span className={`status ${item.paymentStatus === "Просрочено" ? "danger" : "neutral"}`}>{item.paymentStatus}</span></td><td><span className="status neutral">{item.actsStatus}</span></td><td>{date(item.nextImportantDate)}</td><td>{item.responsible || "—"}</td><td><button className="icon-button danger" type="button" aria-label={`Архивировать ${item.number}`} onClick={() => setArchiving(record)}>×</button></td></tr>; })}
    </tbody></table></div>{!store.loading && filtered.length === 0 && <div className="empty-state"><span className="empty-icon">✓</span><h2>{store.records.length ? "Ничего не найдено" : "Добавьте первый договор"}</h2><p>{store.records.length ? "Измените поиск или фильтры." : "Стадия, оплата и акты будут видны одновременно."}</p>{!store.records.length && <button className="primary" type="button" onClick={() => setEditing("new")}>Добавить договор</button>}</div>}</div>
    {editing && <ContractEditor record={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} onSave={async (item, id) => { await store.save(`${item.number} — ${item.customer}`, item, id); setEditing(null); }} />}
    {archiving && <ConfirmDialog title="Переместить договор в архив?" message={`${archiving.payload.number} останется в базе и сможет быть восстановлен.`} confirmLabel="В архив" onClose={() => setArchiving(null)} onConfirm={() => { void store.archive(archiving.id); setArchiving(null); }} />}
    {importRows && importSource && <Dialog title="Предпросмотр импорта" description="Сопоставьте колонки. Пакет проверяется и сохраняется только целиком." onClose={() => { setImportRows(null); setImportSource(null); }} width="980px"><div className="dialog-body"><div className="mapping-grid">{importFields.map(([key, label]) => <label key={key}>{label}<select value={importSource.mapping[key]} onChange={(event) => { const mapping = { ...importSource.mapping, [key]: Number(event.target.value) }; setImportSource({ ...importSource, mapping }); setImportRows(mapContracts(importSource.rows, mapping)); setImportReport(null); }}><option value={-1}>Не импортировать</option>{importSource.headers.map((header, index) => <option key={`${header}-${index}`} value={index}>{header || `Колонка ${index + 1}`}</option>)}</select></label>)}</div><div className="import-summary"><strong>Строк к импорту: {importRows.length}</strong><span>Показаны первые 10. При любой ошибке реестр не изменяется.</span></div><div className="table-scroll"><table><thead><tr><th>Номер</th><th>Дата</th><th>Заказчик</th><th>Предмет</th><th>Сумма</th><th>Стадия</th></tr></thead><tbody>{importRows.slice(0, 10).map((item, index) => <tr key={`${item.number}-${index}`}><td>{item.number || <span className="field-error">нет</span>}</td><td>{item.date}</td><td>{item.customer || <span className="field-error">нет</span>}</td><td>{item.subject || <span className="field-error">нет</span>}</td><td>{money(item.amount)}</td><td>{item.stage}</td></tr>)}</tbody></table></div>{importReport && <pre className="import-report">{importReport}</pre>}</div><footer className="dialog-actions"><button className="secondary" type="button" onClick={() => { setImportRows(null); setImportSource(null); }}>Отмена</button><button className="primary" type="button" onClick={() => void commitImport()}>Проверить и импортировать пакет</button></footer></Dialog>}
  </div>;
}

function ContractEditor({ record, onSave, onClose }: { record?: StoredRecord<ContractData>; onSave: (item: ContractData, id?: string) => Promise<void>; onClose: () => void }) {
  const [item, setItem] = useState<ContractData>(record ? structuredClone(record.payload) : emptyContract());
  const [error, setError] = useState("");
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  useEffect(() => { if (record) void recordHistory("contract-experience", record.id).then(setHistory); }, [record]);
  const update = <K extends keyof ContractData>(key: K, value: ContractData[K]) => setItem((current) => ({ ...current, [key]: value }));
  const submit = async () => {
    if (!item.number.trim() || !item.customer.trim() || !item.subject.trim()) { setError("Заполните номер, заказчика и предмет договора."); return; }
    const blocking = contractChecks(item).filter((check) => check.severity === "error");
    if (blocking.length) { setError(blocking.map((check) => check.message).join(" ")); return; }
    await onSave(item, record?.id);
  };
  const checks = contractChecks(item);
  const balance = contractBalance(item);
  return <aside className="detail-drawer" role="dialog" aria-modal="true" aria-label="Карточка договора"><header><div><h2>{record ? item.number : "Новый договор"}</h2><p>Статусы хранятся независимо</p></div><button className="icon-button" type="button" onClick={onClose}>×</button></header><div className="drawer-body">
    {error && <div className="notice error">{error}</div>}{checks.length > 0 && <div className="notice warning"><strong>Проверка согласованности</strong>{checks.map((check) => <span key={check.code}>{check.message}</span>)}</div>}
    <h3>Основное</h3><div className="form-grid"><label>Номер *<input value={item.number} onChange={(event) => update("number", event.target.value)} /></label><label>Дата<input type="date" value={item.date} onChange={(event) => update("date", event.target.value)} /></label><label className="wide">Заказчик *<input value={item.customer} onChange={(event) => update("customer", event.target.value)} /></label><label className="wide">Предмет *<textarea rows={3} value={item.subject} onChange={(event) => update("subject", event.target.value)} /></label><label>Сумма<input type="number" min="0" value={item.amount} onChange={(event) => update("amount", Number(event.target.value))} /></label><label>Ответственный<input value={item.responsible} onChange={(event) => update("responsible", event.target.value)} /></label></div>
    <h3>Исполнение</h3><div className="form-grid"><label>Начало<input type="date" value={item.startDate} onChange={(event) => update("startDate", event.target.value)} /></label><label>Окончание<input type="date" value={item.endDate} onChange={(event) => update("endDate", event.target.value)} /></label><label>Стадия<select value={item.stage} onChange={(event) => update("stage", event.target.value as ContractData["stage"])}>{contractStages.map((value) => <option key={value}>{value}</option>)}</select></label><label>Ближайшая важная дата<input type="date" value={item.nextImportantDate} onChange={(event) => update("nextImportantDate", event.target.value)} /></label></div>
    <h3>Оплата и акты</h3><div className="form-grid"><label>Статус оплаты<select value={item.paymentStatus} onChange={(event) => update("paymentStatus", event.target.value as ContractData["paymentStatus"])}>{paymentStatuses.map((value) => <option key={value}>{value}</option>)}</select></label><label>Статус актов<select value={item.actsStatus} onChange={(event) => update("actsStatus", event.target.value as ContractData["actsStatus"])}>{actsStatuses.map((value) => <option key={value}>{value}</option>)}</select></label><label>Оплачено<input type="number" min="0" value={item.paidAmount} onChange={(event) => update("paidAmount", Number(event.target.value))} /></label><label>Остаток<input readOnly value={balance.outstanding} /></label><label>Переплата<input readOnly value={balance.overpayment} /></label><label>Плановая дата оплаты<input type="date" value={item.paymentPlannedDate} onChange={(event) => update("paymentPlannedDate", event.target.value)} /></label><label>Фактическая дата оплаты<input type="date" value={item.paymentActualDate} onChange={(event) => update("paymentActualDate", event.target.value)} /></label></div>
    <h3>Контакты и примечания</h3><label>Контакт<input value={item.contact} onChange={(event) => update("contact", event.target.value)} /></label><label>Примечания<textarea rows={5} value={item.notes} onChange={(event) => update("notes", event.target.value)} /></label>
    {record && <div className="history-note"><strong>История</strong><span>Создано: {new Date(record.createdAt).toLocaleString("ru-RU")}</span>{history.map((entry) => <span key={entry.id}>{entry.action === "created" ? "Создано" : entry.action === "updated" ? "Изменено" : entry.action === "archived" ? "Архивировано" : entry.action === "version-restored" ? "Возвращена версия" : "Восстановлено"}: {new Date(entry.createdAt).toLocaleString("ru-RU")} {entry.snapshot && <button className="link-button" type="button" onClick={async () => { if (!window.confirm("Вернуть договор к этой версии? Текущее состояние останется в истории.")) return; const restored = await restoreHistoryVersion<ContractData>("contract-experience", record.id, entry.id); setItem(restored.payload); setHistory(await recordHistory("contract-experience", record.id)); }}>Вернуть эту версию</button>}</span>)}</div>}
  </div><footer><button className="secondary" type="button" onClick={onClose}>Отмена</button><button className="primary" type="button" onClick={() => void submit()}>Сохранить договор</button></footer></aside>;
}
