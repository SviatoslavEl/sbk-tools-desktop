import { useEffect, useMemo, useState } from "react";
import { ConfirmDialog, Dialog } from "../../components/Dialog";
import { useRecords } from "../../hooks/useRecords";
import { parseCsv, toCsv } from "../../lib/csv";
import { chooseOpenPath, chooseSavePath, exportText } from "../../lib/files";
import { createBackup, importRecordsAtomic, readDocxTable, readTextFile, readXlsx, recordHistory, restoreHistoryVersion, writeContractReportDocx, writeContractReportPdf, writeXlsx, type ContractReportData, type HistoryEntry, type StoredRecord } from "../../lib/storage";
import { actsStatuses, contractStages, emptyContract, paymentStatuses, type ContractData } from "./types";
import { contractBalance, contractChecks } from "./validation";
import { matchContract, type ContractSelectionCriteria } from "./selection";

const money = (value: number) => new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(value) + " ₽";
const date = (value: string) => value ? new Date(`${value}T00:00:00`).toLocaleDateString("ru-RU") : "—";
const contractHeaders = ["Юрлицо-исполнитель", "Номер", "Дата", "Заказчик", "Предмет", "Отрасль", "Вид услуги", "Стандарты", "Состав работ", "Роль в договоре", "Сумма", "Стоимость нашей части", "Начало", "Окончание", "Стадия", "Оплата", "Акты", "Оплачено", "Плановая дата оплаты", "Фактическая дата оплаты", "Важная дата", "Ответственный", "Контакт", "Отзыв", "Раскрытие разрешено", "Раскрывать заказчика", "Раскрывать номер", "Раскрывать предмет", "Раскрывать стоимость", "Примечания"];
const importFields = [
  ["performingLegalEntity", "Юрлицо-исполнитель *", ["юрлицо-исполнитель", "юрлицо", "юридическое лицо"]],
  ["number", "Номер *", ["номер", "№", "договор", "№ договора"]], ["date", "Дата", ["дата"]], ["customer", "Заказчик *", ["заказчик", "название организации"]],
  ["subject", "Предмет *", ["предмет", "описание договора"]], ["amount", "Сумма", ["сумма", "стоимость договора, руб"]], ["period", "Сроки выполнения", ["сроки выполнения", "период"]], ["start", "Начало", ["начало"]], ["end", "Окончание", ["окончание"]],
  ["industry", "Отрасль", ["отрасль"]], ["serviceType", "Вид услуги", ["вид услуги", "услуга"]], ["standards", "Стандарты", ["стандарты"]], ["workScope", "Состав работ", ["состав работ"]], ["contractRole", "Роль в договоре", ["роль в договоре"]], ["ourShare", "Стоимость нашей части", ["стоимость нашей части", "наша часть"]],
  ["stage", "Стадия", ["стадия"]], ["payment", "Оплата", ["оплата"]], ["acts", "Акты", ["акты"]], ["paid", "Оплачено", ["оплачено"]],
  ["paymentPlanned", "Плановая дата оплаты", ["плановая дата оплаты"]], ["paymentActual", "Фактическая дата оплаты", ["фактическая дата оплаты"]],
  ["important", "Важная дата", ["важная дата"]], ["responsible", "Ответственный", ["ответственный"]], ["contact", "Контакт", ["контакт"]], ["review", "Отзыв", ["отзыв"]], ["disclosure", "Раскрытие разрешено", ["раскрытие разрешено", "можно раскрывать"]],
  ["discloseCustomer", "Раскрывать заказчика", ["раскрывать заказчика"]], ["discloseNumber", "Раскрывать номер", ["раскрывать номер"]], ["discloseSubject", "Раскрывать предмет", ["раскрывать предмет"]], ["discloseAmount", "Раскрывать стоимость", ["раскрывать стоимость", "раскрывать сумму"]], ["notes", "Примечания", ["примечания"]],
] as const;
type ImportField = typeof importFields[number][0];

export function normalizeContractData(payload: ContractData): ContractData {
  const legacyPermission = Boolean(payload.disclosureAllowed);
  const partial = payload as Partial<ContractData>;
  return {
    ...emptyContract(), ...payload, standards: payload.standards || [],
    discloseCustomer: partial.discloseCustomer ?? legacyPermission,
    discloseNumber: partial.discloseNumber ?? legacyPermission,
    discloseSubject: partial.discloseSubject ?? legacyPermission,
    discloseAmount: partial.discloseAmount ?? legacyPermission,
  };
}

const hiddenDisclosure = "Скрыто условиями конфиденциальности";
export function contractReportRow(payload: ContractData): ContractReportData["rows"][number] {
  const item = normalizeContractData(payload);
  return {
    legalEntity: item.performingLegalEntity,
    number: item.disclosureAllowed && item.discloseNumber ? item.number : hiddenDisclosure,
    date: date(item.date),
    customer: item.disclosureAllowed && item.discloseCustomer ? item.customer : hiddenDisclosure,
    subject: item.disclosureAllowed && item.discloseSubject ? item.subject : hiddenDisclosure,
    amount: item.disclosureAllowed && item.discloseAmount ? money(item.amount) : hiddenDisclosure,
    amountValue: item.disclosureAllowed && item.discloseAmount ? item.amount : null,
    period: `${date(item.startDate)} — ${date(item.endDate)}`,
  };
}

export function mapContracts(rows: string[][], mapping: Record<ImportField, number>, defaultLegalEntity = ""): ContractData[] {
  const value = (row: string[], key: ImportField) => mapping[key] >= 0 ? row[mapping[key]] || "" : "";
  const number = (text: string) => { const match = text.match(/\d[\d\s\u00a0]*(?:[,.]\d+)?/); return match ? Number(match[0].replace(/[\s\u00a0]/g, "").replace(",", ".")) || 0 : 0; };
  const isoDate = (direct: string, source: string) => { if (/^\d{4}-\d{2}-\d{2}$/.test(direct)) return direct; const match = (direct || source).match(/(\d{2})\.(\d{2})\.(\d{4})/); return match ? `${match[3]}-${match[2]}-${match[1]}` : ""; };
  const periodDate = (text: string) => { const months: Record<string, string> = { январь: "01", февраль: "02", март: "03", апрель: "04", май: "05", июнь: "06", июль: "07", август: "08", сентябрь: "09", октябрь: "10", ноябрь: "11", декабрь: "12" }; const match = text.toLowerCase().match(/(январь|февраль|март|апрель|май|июнь|июль|август|сентябрь|октябрь|ноябрь|декабрь)\s+(\d{4})/); return match ? `${match[2]}-${months[match[1]]}-01` : ""; };
  let previousCustomer = "";
  let previousContractNumber = "";
  return rows.filter((row) => row.some(Boolean)).map((row) => {
    const period = value(row, "period"); const [periodStart = "", periodEnd = ""] = period.split("/").map((part) => part.trim()); const rawAmount = value(row, "amount");
    const directCustomer = value(row, "customer");
    const directNumber = value(row, "number");
    if (directCustomer) {
      previousCustomer = directCustomer;
      previousContractNumber = directNumber;
    }
    const customer = directCustomer || previousCustomer;
    const contractNumber = directNumber || previousContractNumber;
    const disclosureAllowed = /^(да|yes|true|1)$/i.test(value(row, "disclosure"));
    const disclose = (key: "discloseCustomer" | "discloseNumber" | "discloseSubject" | "discloseAmount") => mapping[key] >= 0 ? /^(да|yes|true|1)$/i.test(value(row, key)) : disclosureAllowed;
    return { ...emptyContract(), performingLegalEntity: value(row, "performingLegalEntity") || defaultLegalEntity, number: contractNumber, date: isoDate(value(row, "date"), contractNumber), customer, subject: value(row, "subject"), industry: value(row, "industry"), serviceType: value(row, "serviceType"), standards: value(row, "standards").split(/[,;]+/).map((entry) => entry.trim()).filter(Boolean), workScope: value(row, "workScope") || value(row, "subject"), contractRole: value(row, "contractRole"), amount: number(rawAmount), ourShareAmount: number(value(row, "ourShare")), startDate: value(row, "start") || periodDate(periodStart), endDate: value(row, "end") || (/н\.?\s*в\.?/i.test(periodEnd) ? "" : periodDate(periodEnd)), stage: /н\.?\s*в\.?/i.test(periodEnd) ? "Исполняется" : contractStages.includes(value(row, "stage") as never) ? value(row, "stage") as ContractData["stage"] : "Выполнен", paymentStatus: paymentStatuses.includes(value(row, "payment") as never) ? value(row, "payment") as ContractData["paymentStatus"] : "Не указано", actsStatus: actsStatuses.includes(value(row, "acts") as never) ? value(row, "acts") as ContractData["actsStatus"] : "Не указано", paidAmount: number(value(row, "paid")), paymentPlannedDate: value(row, "paymentPlanned"), paymentActualDate: value(row, "paymentActual"), nextImportantDate: value(row, "important"), responsible: value(row, "responsible"), contact: value(row, "contact"), reviewAvailable: /^(да|yes|true|1)$/i.test(value(row, "review")), disclosureAllowed, discloseCustomer: disclose("discloseCustomer"), discloseNumber: disclose("discloseNumber"), discloseSubject: disclose("discloseSubject"), discloseAmount: disclose("discloseAmount"), notes: [period ? `Сроки выполнения (исходный текст): ${period}` : "", value(row, "notes"), rawAmount.includes("\n") ? `Стоимость и пометки (исходный текст): ${rawAmount}` : ""].filter(Boolean).join("\n") };
  });
}

export function ContractsRegistry() {
  const store = useRecords<ContractData>("contract-experience");
  const [search, setSearch] = useState("");
  const [stageFilter, setStageFilter] = useState("");
  const [paymentFilter, setPaymentFilter] = useState("");
  const [legalEntityFilter, setLegalEntityFilter] = useState("");
  const [editing, setEditing] = useState<StoredRecord<ContractData> | "new" | null>(null);
  const [archiving, setArchiving] = useState<StoredRecord<ContractData> | null>(null);
  const [importRows, setImportRows] = useState<ContractData[] | null>(null);
  const [importSource, setImportSource] = useState<{ headers: string[]; rows: string[][]; mapping: Record<ImportField, number> } | null>(null);
  const [importReport, setImportReport] = useState<string | null>(null);
  const [importLegalEntity, setImportLegalEntity] = useState("");
  const [selectionOpen, setSelectionOpen] = useState(false);
  const [selectionCriteria, setSelectionCriteria] = useState<ContractSelectionCriteria>({ procurementTitle: "", legalEntity: "", keywords: "", minAmount: 0, completedOnly: true, disclosureOnly: true });
  const [selectedContracts, setSelectedContracts] = useState<Set<string>>(new Set());

  const filtered = useMemo(() => store.records.filter((record) => {
    const item = record.payload;
    const matchesText = [item.performingLegalEntity, item.number, item.customer, item.subject, item.responsible].join(" ").toLowerCase().includes(search.toLowerCase());
    return matchesText && (!legalEntityFilter || item.performingLegalEntity === legalEntityFilter) && (!stageFilter || item.stage === stageFilter) && (!paymentFilter || item.paymentStatus === paymentFilter);
  }), [store.records, search, legalEntityFilter, stageFilter, paymentFilter]);
  const legalEntities = [...new Set(store.records.map((record) => record.payload.performingLegalEntity).filter(Boolean))].sort();
  const matches = useMemo(() => store.records.map((record) => ({ record, match: matchContract(record.payload, selectionCriteria) })).filter((entry) => entry.match.score > 0).sort((a, b) => b.match.score - a.match.score), [store.records, selectionCriteria]);

  const stats = useMemo(() => ({
    total: store.records.length,
    active: store.records.filter((record) => record.payload.stage === "Исполняется").length,
    payment: store.records.filter((record) => ["Ожидается", "Частично оплачено", "Просрочено"].includes(record.payload.paymentStatus)).length,
  }), [store.records]);

  const exportSelection = async () => {
    const rows = filtered.map(({ payload }) => { const item = normalizeContractData(payload); return [item.performingLegalEntity || "", item.number, item.date, item.customer, item.subject, item.industry, item.serviceType, (item.standards || []).join(", "), item.workScope, item.contractRole, item.amount, item.ourShareAmount, item.startDate, item.endDate, item.stage, item.paymentStatus, item.actsStatus, item.paidAmount, item.paymentPlannedDate, item.paymentActualDate, item.nextImportantDate, item.responsible, item.contact, item.reviewAvailable ? "Да" : "Нет", item.disclosureAllowed ? "Да" : "Нет", item.discloseCustomer ? "Да" : "Нет", item.discloseNumber ? "Да" : "Нет", item.discloseSubject ? "Да" : "Нет", item.discloseAmount ? "Да" : "Нет", item.notes]; });
    await exportText("Экспорт договоров", "опыт-по-договорам.csv", ["csv"], toCsv(contractHeaders, rows));
  };
  const exportXlsx = async () => {
    const path = await chooseSavePath("Экспорт договоров в Excel", "опыт-по-договорам.xlsx", ["xlsx"]);
    if (!path) return;
    const rows = filtered.map(({ payload }) => { const item = normalizeContractData(payload); return [item.performingLegalEntity || "", item.number, item.date, item.customer, item.subject, item.industry || "", item.serviceType || "", (item.standards || []).join(", "), item.workScope || "", item.contractRole || "", String(item.amount), String(item.ourShareAmount || 0), item.startDate, item.endDate, item.stage, item.paymentStatus, item.actsStatus, String(item.paidAmount), item.paymentPlannedDate, item.paymentActualDate, item.nextImportantDate, item.responsible, item.contact, item.reviewAvailable ? "Да" : "Нет", item.disclosureAllowed ? "Да" : "Нет", item.discloseCustomer ? "Да" : "Нет", item.discloseNumber ? "Да" : "Нет", item.discloseSubject ? "Да" : "Нет", item.discloseAmount ? "Да" : "Нет", item.notes]; });
    await writeXlsx(path, { sheetName: "Договоры", rows: [contractHeaders, ...rows] });
  };
  const reportData = (): ContractReportData => {
    const selected = matches.filter(({ record }) => selectedContracts.has(record.id));
    return { title: selectionCriteria.procurementTitle.trim() ? `Подбор опыта для закупки «${selectionCriteria.procurementTitle.trim()}»` : "Подбор договоров", criteria: [selectionCriteria.legalEntity ? `юрлицо: ${selectionCriteria.legalEntity}` : "", selectionCriteria.keywords ? `ключевые слова: ${selectionCriteria.keywords}` : "", selectionCriteria.minAmount ? `стоимость от ${money(selectionCriteria.minAmount)}` : "", selectionCriteria.completedOnly ? "только выполненные" : "", selectionCriteria.disclosureOnly ? "разрешённые к раскрытию" : ""].filter(Boolean).join("; "), rows: selected.map(({ record }) => contractReportRow(record.payload)) };
  };
  const exportReport = async (format: "xlsx" | "docx" | "pdf") => {
    const data = reportData();
    if (!data.rows.length) return window.alert("Отметьте хотя бы один договор.");
    const restricted = matches.filter(({ record }) => selectedContracts.has(record.id) && !record.payload.disclosureAllowed).length;
    if (restricted && !window.confirm(`В подборке ${restricted} договоров без разрешения на раскрытие. Вы уверены, что их можно включить в заявку и выгрузить?`)) return;
    const path = await chooseSavePath(`Выгрузить подборку в ${format.toUpperCase()}`, `подбор-договоров.${format}`, [format]); if (!path) return;
    if (format === "xlsx") await writeXlsx(path, { sheetName: "Подбор договоров", rows: [["Закупка", "Критерии", "Юрлицо-исполнитель", "Номер", "Дата", "Заказчик", "Предмет", "Стоимость", "Период"], ...data.rows.map((row) => [data.title, data.criteria, row.legalEntity, row.number, row.date, row.customer, row.subject, row.amountValue === null ? "" : String(row.amountValue), row.period])] });
    else if (format === "docx") await writeContractReportDocx(path, data);
    else await writeContractReportPdf(path, data);
    window.alert(`Подборка сохранена: ${path}`);
  };

  const openImport = async () => {
    const path = await chooseOpenPath("Импорт договоров", ["csv", "xlsx", "docx"]);
    if (!path) return;
    const table = path.toLowerCase().endsWith(".docx") ? (await readDocxTable(path)).rows : path.toLowerCase().endsWith(".xlsx") ? (await readXlsx(path)).rows : parseCsv(await readTextFile(path));
    const [headers = [], ...rows] = table;
    const mapping = Object.fromEntries(importFields.map(([key, , aliases]) => [key, headers.findIndex((header) => aliases.includes(header.toLowerCase().trim() as never))])) as Record<ImportField, number>;
    const parsed = mapContracts(rows, mapping, importLegalEntity);
    setImportSource({ headers, rows, mapping });
    setImportRows(parsed);
    setImportReport(null);
  };

  const commitImport = async () => {
    if (!importRows || !importSource) return;
    const errors: string[] = [];
    const keys = new Set<string>();
    for (const [index, item] of importRows.entries()) {
      if (!item.performingLegalEntity || !item.number || !item.customer || !item.subject) {
        errors.push(`Строка ${index + 2}: нужны юрлицо-исполнитель, номер, заказчик и предмет`);
        continue;
      }
      const raw = importSource.rows[index] || [];
      const rawValue = (key: ImportField) => importSource.mapping[key] >= 0 ? (raw[importSource.mapping[key]] || "").trim() : "";
      if (rawValue("stage") && !contractStages.includes(rawValue("stage") as never)) errors.push(`Строка ${index + 2}: неизвестная стадия «${rawValue("stage")}»`);
      if (rawValue("payment") && !paymentStatuses.includes(rawValue("payment") as never)) errors.push(`Строка ${index + 2}: неизвестный статус оплаты «${rawValue("payment")}»`);
      if (rawValue("acts") && !actsStatuses.includes(rawValue("acts") as never)) errors.push(`Строка ${index + 2}: неизвестный статус актов «${rawValue("acts")}»`);
      const key = `${item.number.trim().toLowerCase()}|${item.customer.trim().toLowerCase()}|${item.date}|${item.subject.trim().toLowerCase()}`;
      if (keys.has(key)) errors.push(`Строка ${index + 2}: дубль внутри файла ${item.number}`);
      keys.add(key);
      const duplicate = store.records.some((record) => record.payload.number === item.number && record.payload.customer === item.customer && record.payload.date === item.date && record.payload.subject === item.subject);
      if (duplicate) errors.push(`Строка ${index + 2}: дубль существующего договора ${item.number}`);
      for (const check of contractChecks(item).filter((check) => check.severity === "error")) errors.push(`Строка ${index + 2}: ${check.message}`);
    }
    if (errors.length) { setImportReport(`Импорт отменён: исправьте ${errors.length} ошибок. Данные не изменены.\n${errors.slice(0, 12).join("\n")}`); return; }
    try {
      await importRecordsAtomic("contract-experience", importRows.map((item) => ({ id: crypto.randomUUID(), title: `${item.number} — ${item.customer}`, payload: item })));
      await store.reload();
      setImportReport(`Пакет принят полностью: ${importRows.length} записей.`);
      setImportRows(null); setImportSource(null);
    } catch (reason) { setImportReport(`Не удалось завершить импорт: ${String(reason)}. Проверьте реестр перед повтором.`); }
  };

  return <div className="module-stack">
    <div className="stats-row"><div className="stat"><span>Всего договоров</span><strong>{stats.total}</strong></div><div className="stat"><span>В исполнении</span><strong>{stats.active}</strong></div><div className="stat"><span>Ожидают оплаты</span><strong>{stats.payment}</strong></div></div>
    <div className="portable-export-row"><span>Полный переносимый пакет включает базу, историю и вложения раздела.</span><button className="secondary small" type="button" onClick={() => void createBackup("contract-experience").then((result) => window.alert(`Полный пакет создан: ${result.fileName}`))}>Создать полный пакет</button></div>
    <div className="registry-toolbar"><label className="search-box"><span>Поиск</span><input placeholder="Юрлицо, номер, заказчик, предмет" value={search} onChange={(event) => setSearch(event.target.value)} /></label><label><span>Юрлицо</span><select value={legalEntityFilter} onChange={(event) => setLegalEntityFilter(event.target.value)}><option value="">Все</option>{legalEntities.map((item) => <option key={item}>{item}</option>)}</select></label><label><span>Стадия</span><select value={stageFilter} onChange={(event) => setStageFilter(event.target.value)}><option value="">Все</option>{contractStages.map((item) => <option key={item}>{item}</option>)}</select></label><label><span>Оплата</span><select value={paymentFilter} onChange={(event) => setPaymentFilter(event.target.value)}><option value="">Все</option>{paymentStatuses.map((item) => <option key={item}>{item}</option>)}</select></label><div className="toolbar-actions"><button className="secondary" type="button" onClick={() => void openImport()}>Импорт CSV / XLSX / DOCX</button><button className="secondary" type="button" onClick={() => { setSelectedContracts(new Set()); setSelectionOpen(true); }}>Подбор под закупку</button><button className="secondary" type="button" onClick={() => void exportSelection()}>CSV</button><button className="secondary" type="button" onClick={() => void exportXlsx()}>XLSX</button><button className="primary" type="button" onClick={() => setEditing("new")}>Добавить договор</button></div></div>
    {store.error && <div className="notice error"><strong>Не удалось открыть реестр.</strong><span>{store.error}</span></div>}
    <div className="surface table-surface"><div className="table-scroll"><table><thead><tr><th>Номер и дата</th><th>Юрлицо-исполнитель</th><th>Заказчик</th><th>Предмет</th><th>Сумма</th><th>Период</th><th>Стадия</th><th>Оплата</th><th>Акты</th><th>Важная дата</th><th>Ответственный</th><th /></tr></thead><tbody>
      {filtered.map((record) => { const item = record.payload; const checks = contractChecks(item); return <tr key={record.id} onDoubleClick={() => setEditing(record)}><td className="sticky-cell"><button className="link-button" type="button" onClick={() => setEditing(record)}><strong>{item.number}</strong><small>{date(item.date)}</small></button></td><td>{item.performingLegalEntity || <span className="field-error">Не указано</span>}</td><td>{item.customer}</td><td className="wide-cell">{item.subject}{checks.length > 0 && <small className="validation-summary" title={checks.map((check) => check.message).join("\n")}>⚠ {checks.length} замеч.</small>}</td><td>{money(item.amount)}{contractBalance(item).overpayment > 0 && <small className="field-error">Переплата {money(contractBalance(item).overpayment)}</small>}</td><td>{date(item.startDate)} — {date(item.endDate)}</td><td><span className="status neutral">{item.stage}</span></td><td><span className={`status ${item.paymentStatus === "Просрочено" ? "danger" : "neutral"}`}>{item.paymentStatus}</span></td><td><span className="status neutral">{item.actsStatus}</span></td><td>{date(item.nextImportantDate)}</td><td>{item.responsible || "—"}</td><td><button className="icon-button danger" type="button" aria-label={`Архивировать ${item.number}`} onClick={() => setArchiving(record)}>×</button></td></tr>; })}
    </tbody></table></div>{!store.loading && filtered.length === 0 && <div className="empty-state"><span className="empty-icon">✓</span><h2>{store.records.length ? "Ничего не найдено" : "Добавьте первый договор"}</h2><p>{store.records.length ? "Измените поиск или фильтры." : "Стадия, оплата и акты будут видны одновременно."}</p>{!store.records.length && <button className="primary" type="button" onClick={() => setEditing("new")}>Добавить договор</button>}</div>}</div>
    {editing && <ContractEditor record={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} onSave={async (item, id) => { await store.save(`${item.number} — ${item.customer}`, item, id); setEditing(null); }} />}
    {archiving && <ConfirmDialog title="Переместить договор в архив?" message={`${archiving.payload.number} останется в базе и сможет быть восстановлен.`} confirmLabel="В архив" onClose={() => setArchiving(null)} onConfirm={() => { void store.archive(archiving.id); setArchiving(null); }} />}
    {selectionOpen && <Dialog title="Подбор договоров под закупку" description="Задайте критерии, отметьте подходящий опыт и выгрузите готовую подборку." onClose={() => setSelectionOpen(false)} width="1080px"><div className="dialog-body"><div className="form-grid"><label className="wide">Название закупки<input value={selectionCriteria.procurementTitle} onChange={(event) => setSelectionCriteria({ ...selectionCriteria, procurementTitle: event.target.value })} /></label><label>Юрлицо-исполнитель<select value={selectionCriteria.legalEntity} onChange={(event) => setSelectionCriteria({ ...selectionCriteria, legalEntity: event.target.value })}><option value="">Любое</option>{legalEntities.map((value) => <option key={value}>{value}</option>)}</select></label><label>Минимальная стоимость<input type="number" min="0" value={selectionCriteria.minAmount} onChange={(event) => setSelectionCriteria({ ...selectionCriteria, minAmount: Number(event.target.value) })} /></label><label className="wide">Ключевые слова и требования<input value={selectionCriteria.keywords} onChange={(event) => setSelectionCriteria({ ...selectionCriteria, keywords: event.target.value })} placeholder="информационная безопасность, аудит, ГОСТ…" /></label><label className="checkbox-row"><input type="checkbox" checked={selectionCriteria.completedOnly} onChange={(event) => setSelectionCriteria({ ...selectionCriteria, completedOnly: event.target.checked })} /> Только выполненные</label><label className="checkbox-row"><input type="checkbox" checked={selectionCriteria.disclosureOnly} onChange={(event) => setSelectionCriteria({ ...selectionCriteria, disclosureOnly: event.target.checked })} /> Только разрешённые к раскрытию</label></div><div className="import-summary"><strong>Найдено: {matches.length}; выбрано: {selectedContracts.size}</strong><button className="secondary small" type="button" disabled={!matches.length} onClick={() => setSelectedContracts(new Set(matches.map(({ record }) => record.id)))}>Выбрать все найденные</button></div><div className="table-scroll"><table><thead><tr><th /><th>Балл</th><th>Юрлицо</th><th>Договор</th><th>Заказчик</th><th>Предмет</th><th>Почему подходит</th></tr></thead><tbody>{matches.map(({ record, match }) => <tr key={record.id}><td><input aria-label={`Выбрать ${record.payload.number}`} type="checkbox" checked={selectedContracts.has(record.id)} onChange={(event) => setSelectedContracts((current) => { const next = new Set(current); if (event.target.checked) next.add(record.id); else next.delete(record.id); return next; })} /></td><td><strong>{match.score}</strong></td><td>{record.payload.performingLegalEntity}</td><td>{record.payload.number}</td><td>{record.payload.customer}</td><td>{record.payload.subject}</td><td><small>{match.reasons.join(" · ")}</small></td></tr>)}</tbody></table></div>{!matches.length && <div className="empty-inline">По текущим критериям договоры не найдены. Снимите ограничения или уточните ключевые слова.</div>}</div><footer className="dialog-actions"><button className="secondary" type="button" onClick={() => setSelectionOpen(false)}>Закрыть</button><button className="secondary" type="button" disabled={!selectedContracts.size} onClick={() => void exportReport("xlsx")}>Excel</button><button className="secondary" type="button" disabled={!selectedContracts.size} onClick={() => void exportReport("docx")}>Word</button><button className="primary" type="button" disabled={!selectedContracts.size} onClick={() => void exportReport("pdf")}>PDF</button></footer></Dialog>}
    {importRows && importSource && <Dialog title="Предпросмотр импорта" description="Сопоставьте колонки. Пакет проверяется и сохраняется только целиком." onClose={() => { setImportRows(null); setImportSource(null); }} width="980px"><div className="dialog-body"><label>Общее юрлицо-исполнитель для строк без этой колонки<input value={importLegalEntity} onChange={(event) => { const legalEntity = event.target.value; setImportLegalEntity(legalEntity); setImportRows(mapContracts(importSource.rows, importSource.mapping, legalEntity)); setImportReport(null); }} placeholder="Например, ООО «СБК»" /></label><div className="mapping-grid">{importFields.map(([key, label]) => <label key={key}>{label}<select value={importSource.mapping[key]} onChange={(event) => { const mapping = { ...importSource.mapping, [key]: Number(event.target.value) }; setImportSource({ ...importSource, mapping }); setImportRows(mapContracts(importSource.rows, mapping, importLegalEntity)); setImportReport(null); }}><option value={-1}>Не импортировать</option>{importSource.headers.map((header, index) => <option key={`${header}-${index}`} value={index}>{header || `Колонка ${index + 1}`}</option>)}</select></label>)}</div><div className="import-summary"><strong>Строк к импорту: {importRows.length}</strong><span>Показаны первые 10. При любой ошибке реестр не изменяется.</span></div><div className="table-scroll"><table><thead><tr><th>Юрлицо</th><th>Номер</th><th>Дата</th><th>Заказчик</th><th>Предмет</th><th>Сумма</th></tr></thead><tbody>{importRows.slice(0, 10).map((item, index) => <tr key={`${item.number}-${index}`}><td>{item.performingLegalEntity || <span className="field-error">нет</span>}</td><td>{item.number || <span className="field-error">нет</span>}</td><td>{item.date}</td><td>{item.customer || <span className="field-error">нет</span>}</td><td>{item.subject || <span className="field-error">нет</span>}</td><td>{money(item.amount)}</td></tr>)}</tbody></table></div>{importReport && <pre className="import-report">{importReport}</pre>}</div><footer className="dialog-actions"><button className="secondary" type="button" onClick={() => { setImportRows(null); setImportSource(null); }}>Отмена</button><button className="primary" type="button" onClick={() => void commitImport()}>Проверить и импортировать пакет</button></footer></Dialog>}
  </div>;
}

function ContractEditor({ record, onSave, onClose }: { record?: StoredRecord<ContractData>; onSave: (item: ContractData, id?: string) => Promise<void>; onClose: () => void }) {
  const [item, setItem] = useState<ContractData>(record ? normalizeContractData(structuredClone(record.payload)) : emptyContract());
  const [error, setError] = useState("");
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  useEffect(() => { if (record) void recordHistory("contract-experience", record.id).then(setHistory); }, [record]);
  const update = <K extends keyof ContractData>(key: K, value: ContractData[K]) => setItem((current) => ({ ...current, [key]: value }));
  const submit = async () => {
    if (!item.performingLegalEntity.trim() || !item.number.trim() || !item.customer.trim() || !item.subject.trim()) { setError("Заполните юрлицо-исполнителя, номер, заказчика и предмет договора."); return; }
    const blocking = contractChecks(item).filter((check) => check.severity === "error");
    if (blocking.length) { setError(blocking.map((check) => check.message).join(" ")); return; }
    await onSave(item, record?.id);
  };
  const checks = contractChecks(item);
  const balance = contractBalance(item);
  return <aside className="detail-drawer" role="dialog" aria-modal="true" aria-label="Карточка договора"><header><div><h2>{record ? item.number : "Новый договор"}</h2><p>Статусы хранятся независимо</p></div><button className="icon-button" type="button" onClick={onClose}>×</button></header><div className="drawer-body">
    {error && <div className="notice error">{error}</div>}{checks.length > 0 && <div className="notice warning"><strong>Проверка согласованности</strong>{checks.map((check) => <span key={check.code}>{check.message}</span>)}</div>}
    <h3>Основное</h3><div className="form-grid"><label className="wide">Юрлицо-исполнитель *<input value={item.performingLegalEntity} onChange={(event) => update("performingLegalEntity", event.target.value)} /></label><label>Номер *<input value={item.number} onChange={(event) => update("number", event.target.value)} /></label><label>Дата<input type="date" value={item.date} onChange={(event) => update("date", event.target.value)} /></label><label className="wide">Заказчик *<input value={item.customer} onChange={(event) => update("customer", event.target.value)} /></label><label className="wide">Предмет *<textarea rows={3} value={item.subject} onChange={(event) => update("subject", event.target.value)} /></label><label>Отрасль<input value={item.industry} onChange={(event) => update("industry", event.target.value)} /></label><label>Вид услуги<input value={item.serviceType} onChange={(event) => update("serviceType", event.target.value)} /></label><label className="wide">Стандарты, через запятую<input value={item.standards.join(", ")} onChange={(event) => update("standards", event.target.value.split(",").map((value) => value.trim()).filter(Boolean))} /></label><label className="wide">Состав работ<textarea rows={3} value={item.workScope} onChange={(event) => update("workScope", event.target.value)} /></label><label>Роль в договоре<input value={item.contractRole} onChange={(event) => update("contractRole", event.target.value)} /></label><label>Сумма<input type="number" min="0" value={item.amount} onChange={(event) => update("amount", Number(event.target.value))} /></label><label>Стоимость нашей части<input type="number" min="0" value={item.ourShareAmount} onChange={(event) => update("ourShareAmount", Number(event.target.value))} /></label><label>Ответственный<input value={item.responsible} onChange={(event) => update("responsible", event.target.value)} /></label></div>
    <h3>Исполнение</h3><div className="form-grid"><label>Начало<input type="date" value={item.startDate} onChange={(event) => update("startDate", event.target.value)} /></label><label>Окончание<input type="date" value={item.endDate} onChange={(event) => update("endDate", event.target.value)} /></label><label>Стадия<select value={item.stage} onChange={(event) => update("stage", event.target.value as ContractData["stage"])}>{contractStages.map((value) => <option key={value}>{value}</option>)}</select></label><label>Ближайшая важная дата<input type="date" value={item.nextImportantDate} onChange={(event) => update("nextImportantDate", event.target.value)} /></label></div>
    <h3>Оплата и акты</h3><div className="form-grid"><label>Статус оплаты<select value={item.paymentStatus} onChange={(event) => update("paymentStatus", event.target.value as ContractData["paymentStatus"])}>{paymentStatuses.map((value) => <option key={value}>{value}</option>)}</select></label><label>Статус актов<select value={item.actsStatus} onChange={(event) => update("actsStatus", event.target.value as ContractData["actsStatus"])}>{actsStatuses.map((value) => <option key={value}>{value}</option>)}</select></label><label>Оплачено<input type="number" min="0" value={item.paidAmount} onChange={(event) => update("paidAmount", Number(event.target.value))} /></label><label>Остаток<input readOnly value={balance.outstanding} /></label><label>Переплата<input readOnly value={balance.overpayment} /></label><label>Плановая дата оплаты<input type="date" value={item.paymentPlannedDate} onChange={(event) => update("paymentPlannedDate", event.target.value)} /></label><label>Фактическая дата оплаты<input type="date" value={item.paymentActualDate} onChange={(event) => update("paymentActualDate", event.target.value)} /></label></div>
    <h3>Контакты и раскрытие</h3><label>Контакт<input value={item.contact} onChange={(event) => update("contact", event.target.value)} /></label><label className="checkbox-row"><input type="checkbox" checked={item.reviewAvailable} onChange={(event) => update("reviewAvailable", event.target.checked)} /> Есть отзыв / рекомендация</label><label className="checkbox-row"><input type="checkbox" checked={item.disclosureAllowed} onChange={(event) => { const allowed = event.target.checked; setItem((current) => { const hasGranularPermission = current.discloseCustomer || current.discloseNumber || current.discloseSubject || current.discloseAmount; return { ...current, disclosureAllowed: allowed, discloseCustomer: allowed && !hasGranularPermission ? true : current.discloseCustomer, discloseNumber: allowed && !hasGranularPermission ? true : current.discloseNumber, discloseSubject: allowed && !hasGranularPermission ? true : current.discloseSubject, discloseAmount: allowed && !hasGranularPermission ? true : current.discloseAmount }; }); }} /> Разрешено включать договор в подборку</label>{item.disclosureAllowed && <div className="surface compact-card"><strong>Что разрешено раскрывать при выгрузке</strong><label className="checkbox-row"><input type="checkbox" checked={item.discloseCustomer} onChange={(event) => update("discloseCustomer", event.target.checked)} /> Заказчика</label><label className="checkbox-row"><input type="checkbox" checked={item.discloseNumber} onChange={(event) => update("discloseNumber", event.target.checked)} /> Номер договора</label><label className="checkbox-row"><input type="checkbox" checked={item.discloseSubject} onChange={(event) => update("discloseSubject", event.target.checked)} /> Предмет договора</label><label className="checkbox-row"><input type="checkbox" checked={item.discloseAmount} onChange={(event) => update("discloseAmount", event.target.checked)} /> Стоимость</label><small>Запрещённые поля в Word и PDF заменяются отметкой о конфиденциальности, а в Excel стоимость остаётся пустой.</small></div>}<label>Примечания<textarea rows={5} value={item.notes} onChange={(event) => update("notes", event.target.value)} /></label>
    {record && <div className="history-note"><strong>История</strong><span>Создано: {new Date(record.createdAt).toLocaleString("ru-RU")}</span>{history.map((entry) => <span key={entry.id}>{entry.action === "created" ? "Создано" : entry.action === "updated" ? "Изменено" : entry.action === "archived" ? "Архивировано" : entry.action === "version-restored" ? "Возвращена версия" : "Восстановлено"}: {new Date(entry.createdAt).toLocaleString("ru-RU")} {entry.snapshot && <button className="link-button" type="button" onClick={async () => { if (!window.confirm("Вернуть договор к этой версии? Текущее состояние останется в истории.")) return; const restored = await restoreHistoryVersion<ContractData>("contract-experience", record.id, entry.id); setItem(normalizeContractData(restored.payload)); setHistory(await recordHistory("contract-experience", record.id)); }}>Вернуть эту версию</button>}</span>)}</div>}
  </div><footer><button className="secondary" type="button" onClick={onClose}>Отмена</button><button className="primary" type="button" onClick={() => void submit()}>Сохранить договор</button></footer></aside>;
}
