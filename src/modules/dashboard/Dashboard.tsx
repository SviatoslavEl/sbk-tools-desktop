import { useEffect, useMemo, useState } from "react";
import { useRecords } from "../../hooks/useRecords";
import { getWorkspaceInfo, readDraft, type WorkspaceInfo } from "../../lib/storage";
import { calculate } from "../calculator/engine";
import type { CalculatorData } from "../calculator/types";
import type { ContractData } from "../contracts/types";
import { daysUntil } from "../procurement/domain";
import type { ProcurementData } from "../procurement/types";
import { documentExpiry } from "../staff/requirements";
import type { StaffData } from "../staff/types";

const date = (value: string) => value ? new Date(`${value}T00:00:00`).toLocaleDateString("ru-RU") : "—";

export function Dashboard() {
  const procurements = useRecords<ProcurementData>("procurement");
  const contracts = useRecords<ContractData>("contract-experience");
  const staff = useRecords<StaffData>("staff");
  const calculations = useRecords<CalculatorData>("calculator");
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [hasDraft, setHasDraft] = useState(false);
  useEffect(() => { void getWorkspaceInfo().then(setWorkspace); void readDraft<CalculatorData>("calculator").then((draft) => setHasDraft(Boolean(draft))); }, []);
  const deadlines = procurements.records.map((record) => ({ title: record.payload.name, date: record.payload.submissionDeadline, days: daysUntil(record.payload.submissionDeadline), status: record.payload.status })).filter((row) => row.days != null && row.days >= 0 && row.days <= 7 && !["Подана", "Победа", "Проигрыш", "Отменена"].includes(row.status)).sort((a, b) => (a.days || 0) - (b.days || 0));
  const overdue = contracts.records.filter((record) => record.payload.paymentStatus === "Просрочено" || (record.payload.paymentPlannedDate && record.payload.paymentPlannedDate < new Date().toISOString().slice(0, 10) && !["Полностью оплачено", "Не применяется"].includes(record.payload.paymentStatus)));
  const unsignedActs = contracts.records.filter((record) => !["Не требуются", "Подписаны полностью"].includes(record.payload.actsStatus) && ["Выполнен", "Закрыт"].includes(record.payload.stage));
  const endingContracts = contracts.records.map((record) => ({ record, days: daysUntil(record.payload.endDate) })).filter((row) => row.days != null && row.days >= 0 && row.days <= 30);
  const expiringDocuments = staff.records.flatMap((record) => record.payload.documents.map((document) => ({ person: record.payload.fullName, document, category: documentExpiry(document, 60) }))).filter((row) => ["expired", "expiring"].includes(row.category));
  const openRequirements = procurements.records.reduce((sum, record) => sum + record.payload.requirements.filter((requirement) => requirement.status !== "Подтверждено").length, 0);
  const lossCalculations = useMemo(() => calculations.records.filter((record) => { try { return calculate(record.payload).profit < 0; } catch { return false; } }), [calculations.records]);
  const cards = [
    ["Сроки закупок ≤ 7 дней", deadlines.length, deadlines.map((row) => `${row.title}: ${row.days} дн.`)],
    ["Просроченные оплаты", overdue.length, overdue.map((record) => `${record.payload.number}: ${date(record.payload.paymentPlannedDate)}`)],
    ["Неподписанные акты", unsignedActs.length, unsignedActs.map((record) => record.payload.number)],
    ["Договоры завершаются ≤ 30 дней", endingContracts.length, endingContracts.map(({ record, days }) => `${record.payload.number}: ${days} дн.`)],
    ["Истёкшие / истекающие документы", expiringDocuments.length, expiringDocuments.map((row) => `${row.person}: ${row.document.name || row.document.type}`)],
    ["Открытые требования", openRequirements, procurements.records.filter((record) => record.payload.requirements.some((requirement) => requirement.status !== "Подтверждено")).map((record) => record.payload.name)],
    ["Убыточные расчёты", lossCalculations.length, lossCalculations.map((record) => record.title)],
    ["Несохранённый расчёт", hasDraft ? 1 : 0, hasDraft ? ["Есть локальный черновик калькулятора"] : []],
  ] as Array<[string, number, string[]]>;
  return <div className="dashboard-grid">{cards.map(([title, count, rows]) => <section className={`surface dashboard-card ${count ? "has-alert" : ""}`} key={title}><div className="surface-title"><h2>{title}</h2><span className={`status ${count ? "warning" : "success"}`}>{count}</span></div><div className="surface-body">{rows.length ? <ul className="dashboard-list">{rows.slice(0, 6).map((row) => <li key={row}>{row}</li>)}</ul> : <div className="empty-inline">Нет событий</div>}</div></section>)}<section className="surface dashboard-card"><div className="surface-title"><h2>Хранилище и резервные копии</h2></div><div className="surface-body"><div className="metric-grid"><div><span>Свободное место</span><strong>{workspace?.freeSpaceBytes ? `${(workspace.freeSpaceBytes / 1024 / 1024 / 1024).toFixed(1)} ГБ` : "—"}</strong></div><div><span>Режим</span><strong>{workspace?.portable ? "Переносимый" : "Выбранная папка"}</strong></div></div><p className="help-text">Создание, проверка и восстановление резервной копии доступны в настройках.</p></div></section></div>;
}
