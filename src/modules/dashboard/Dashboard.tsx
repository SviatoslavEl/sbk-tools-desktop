import { useEffect, useMemo, useState } from "react";
import { useRecords } from "../../hooks/useRecords";
import { getWorkspaceInfo, readDraft, type WorkspaceInfo } from "../../lib/storage";
import { calculate } from "../calculator/engine";
import type { CalculatorData } from "../calculator/types";
import type { ContractData } from "../contracts/types";
import { calendarDaysUntil, submissionPending } from "../procurement/deadlines";
import type { ProcurementData } from "../procurement/types";
import { documentExpiry } from "../staff/requirements";
import type { StaffData } from "../staff/types";
import { ToolIcon } from "../../components/ToolIcon";
import { buildTaskQueue, taskPeriods, type DashboardTool } from "./tasks";
import "./dashboard.css";

const date = (value: string) => value ? new Date(`${value}T00:00:00`).toLocaleDateString("ru-RU") : "—";

export function Dashboard({ onNavigate }: { onNavigate?: (tool: DashboardTool, recordId?: string) => void }) {
  const procurements = useRecords<ProcurementData>("procurement");
  const contracts = useRecords<ContractData>("contract-experience");
  const staff = useRecords<StaffData>("staff");
  const calculations = useRecords<CalculatorData>("calculator");
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [hasDraft, setHasDraft] = useState(false);
  const [workspaceError, setWorkspaceError] = useState("");
  useEffect(() => {
    let generation = 0;
    const refresh = () => {
      const current = ++generation;
      void getWorkspaceInfo().then((value) => { if (current === generation) { setWorkspace(value); setWorkspaceError(""); } }).catch(() => { if (current === generation) setWorkspaceError("Не удалось обновить сведения о рабочей папке."); });
      void readDraft<CalculatorData>("calculator", "new").then((draft) => { if (current === generation) setHasDraft(Boolean(draft)); }).catch(() => { if (current === generation) setWorkspaceError("Не удалось проверить локальный черновик расчёта."); });
    };
    refresh();
    window.addEventListener("sbk-workspace-refresh", refresh);
    return () => { generation += 1; window.removeEventListener("sbk-workspace-refresh", refresh); };
  }, []);
  const [today, setToday] = useState(() => new Date());
  useEffect(() => {
    const refreshDate = () => setToday(new Date());
    const timer = window.setInterval(refreshDate, 60_000);
    window.addEventListener("focus", refreshDate);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", refreshDate); };
  }, []);
  const tasks = buildTaskQueue(procurements.records, contracts.records, staff.records, today);
  const overdue = contracts.records.filter((record) => !["Полностью оплачено", "Не применяется"].includes(record.payload.paymentStatus) && (record.payload.paymentStatus === "Просрочено" || (calendarDaysUntil(record.payload.paymentPlannedDate, today) ?? 0) < 0));
  const unsignedActs = contracts.records.filter((record) => !["Не требуются", "Подписаны полностью"].includes(record.payload.actsStatus) && ["Выполнен", "Закрыт"].includes(record.payload.stage));
  const endingContracts = contracts.records.filter((record) => !["Закрыт", "Выполнен", "Расторгнут"].includes(record.payload.stage)).map((record) => ({ record, days: calendarDaysUntil(record.payload.endDate, today) })).filter((row) => row.days != null && row.days >= 0 && row.days <= 30);
  const expiringDocuments = staff.records.filter((record) => record.payload.status !== "Сотрудничество завершено").flatMap((record) => record.payload.documents.map((document) => ({ record, document, category: documentExpiry(document, 60, today) }))).filter((row) => ["expired", "expiring"].includes(row.category));
  const pendingProcurements = procurements.records.filter((record) => submissionPending(record.payload));
  const needsEvidence = (status: string) => !["Подтверждено", "Неприменимо"].includes(status);
  const openRequirements = pendingProcurements.reduce((sum, record) => sum + record.payload.requirements.filter((requirement) => needsEvidence(requirement.status)).length, 0);
  const lossCalculations = useMemo(() => calculations.records.filter((record) => { try { return calculate(record.payload).profit < 0; } catch { return false; } }), [calculations.records]);
  const cards: Array<{ title: string; count: number; tool: DashboardTool; rows: Array<{ title: string; recordId?: string }> }> = [
    { title: "Просроченные оплаты", count: overdue.length, tool: "contracts", rows: overdue.map((record) => ({ title: `${record.payload.number}: ${date(record.payload.paymentPlannedDate)}`, recordId: record.id })) },
    { title: "Неподписанные акты", count: unsignedActs.length, tool: "contracts", rows: unsignedActs.map((record) => ({ title: record.payload.number, recordId: record.id })) },
    { title: "Договоры завершаются ≤ 30 дней", count: endingContracts.length, tool: "contracts", rows: endingContracts.map(({ record, days }) => ({ title: `${record.payload.number}: ${days} дн.`, recordId: record.id })) },
    { title: "Истёкшие / истекающие документы", count: expiringDocuments.length, tool: "staff", rows: expiringDocuments.map(({ record, document }) => ({ title: `${record.payload.fullName}: ${document.name || document.type}`, recordId: record.id })) },
    { title: "Открытые требования", count: openRequirements, tool: "procurement", rows: pendingProcurements.filter((record) => record.payload.requirements.some((requirement) => needsEvidence(requirement.status))).map((record) => ({ title: record.payload.name, recordId: record.id })) },
    { title: "Убыточные расчёты", count: lossCalculations.length, tool: "calculator", rows: lossCalculations.map((record) => ({ title: record.title, recordId: record.id })) },
    { title: "Черновик расчёта", count: hasDraft ? 1 : 0, tool: "calculator", rows: hasDraft ? [{ title: "Продолжить локальный черновик калькулятора" }] : [] },
  ];
  const loading = [procurements, contracts, staff, calculations].some((store) => store.loading);
  const errors = [workspaceError, procurements.error, contracts.error, staff.error, calculations.error].filter(Boolean);
  const stats = [
    { tool: "procurement", label: "Закупки", store: procurements },
    { tool: "contracts", label: "Договоры", store: contracts },
    { tool: "staff", label: "Сотрудники", store: staff },
    { tool: "calculator", label: "Расчёты", store: calculations },
  ] as const;
  const shortcuts = [
    { tool: "scanner", label: "Подготовить документ", text: "Сканирование, эффекты и объединение PDF" },
    { tool: "contracts", label: "Подобрать опыт", text: "Договоры, исполнение и подтверждения" },
    { tool: "staff", label: "Подобрать команду", text: "Квалификация и документы сотрудников" },
  ] as const;
  return <div className="module-stack dashboard-module">
    <div className="dashboard-overview"><div><span className="nav-caption">ОБЗОР РАБОТЫ</span><h2>Всё важное — под рукой</h2><p className="help-text">Рабочие данные, ближайшие сроки и быстрый переход к задачам.</p></div><time dateTime={new Date().toLocaleDateString("sv-SE")}>{new Date().toLocaleDateString("ru-RU", { day: "numeric", month: "long", weekday: "long" })}</time></div>
    {errors.length > 0 && <div className="notice error" role="alert">{[...new Set(errors)].join(" ")} Показаны последние полученные сведения; отсутствие событий не подтверждено.</div>}
    <section className="surface dashboard-task-queue" aria-busy={loading} aria-label="Рабочая очередь">
      <div className="surface-title"><h2>Рабочая очередь</h2><span className="help-text">Сначала просроченное, затем ближайшие сроки</span></div>
      {loading && <p className="empty-inline" role="status">Обновляем данные…</p>}
      {!loading && errors.length > 0 && <p className="empty-inline">Проверьте доступ к данным</p>}
      {taskPeriods.map(([period, label]) => {
        const rows = tasks.filter((task) => task.period === period);
        return rows.length > 0 && <section className={`dashboard-task-group ${period}`} key={period} aria-label={label}><h3>{label} <span className="status neutral">{rows.length}</span></h3><ul>{rows.slice(0, 8).map((task) => <li key={task.id}><button type="button" className="dashboard-task" disabled={!onNavigate} onClick={() => onNavigate?.(task.tool, task.recordId)} aria-label={`${task.action} — ${task.title}`}><span><strong>{task.title}</strong><span>{task.action}</span><small>Ответственный: {task.responsible || "не указан"}</small></span><span className="dashboard-task-date">{date(task.date)}<small>{task.days < 0 ? `Просрочено на ${Math.abs(task.days)} дн.` : task.days === 0 ? "Сегодня" : `Через ${task.days} дн.`}</small></span><ToolIcon name="arrow-right" /></button></li>)}</ul>{rows.length > 8 && <details><summary>Ещё задач: {rows.length - 8}</summary><ul>{rows.slice(8).map((task) => <li key={task.id}><button type="button" className="dashboard-task" disabled={!onNavigate} onClick={() => onNavigate?.(task.tool, task.recordId)}><span><strong>{task.title}</strong><span>{task.action}</span><small>Ответственный: {task.responsible || "не указан"} · {date(task.date)}</small></span><ToolIcon name="arrow-right" /></button></li>)}</ul></details>}</section>;
      })}
      {!loading && !errors.length && !tasks.length && <p className="empty-inline">Нет событий с наступившим сроком или сроком в ближайшие 7 дней.</p>}
    </section>
    <section className="dashboard-stats" aria-label="Реестры рабочей папки">{stats.map(({ tool, label, store }) => <button type="button" className="dashboard-stat" key={tool} onClick={() => onNavigate?.(tool)} disabled={!onNavigate} aria-label={`Открыть: ${label}`}><span className="dashboard-stat-icon"><ToolIcon name={tool} /></span><span><small>{label}</small><strong>{store.loading || store.error ? "—" : store.records.length}</strong></span><ToolIcon name="arrow-right" /></button>)}</section>
    {onNavigate && <section className="dashboard-shortcuts" aria-label="Быстрые действия">{shortcuts.map(({ tool, label, text }) => <button type="button" key={tool} className="dashboard-shortcut" onClick={() => onNavigate(tool)}><span className="dashboard-shortcut-icon"><ToolIcon name={tool} /></span><span><strong>{label}</strong><small>{text}</small></span><ToolIcon name="arrow-right" /></button>)}</section>}
    <div className="dashboard-section-heading"><h2>Требует внимания</h2><span className="help-text">По данным реестров</span></div>
    <div className="dashboard-grid" aria-busy={loading}>{cards.filter((card) => card.count > 0).map(({ title, count, rows, tool }) => <section className="surface dashboard-card has-alert" key={title}><div className="surface-title"><h2>{title}</h2><span className={`status ${loading || errors.length ? "neutral" : "warning"}`}>{loading || errors.length ? "—" : count}</span></div><div className="surface-body"><ul className="dashboard-list">{rows.slice(0, 6).map((row, index) => <li key={`${index}-${row.recordId}`}><button type="button" className="link-button" disabled={!onNavigate} onClick={() => onNavigate?.(tool, row.recordId)}>{row.title}</button></li>)}</ul>{rows.length > 6 && <button type="button" className="link-button" disabled={!onNavigate} onClick={() => onNavigate?.(tool)}>Открыть раздел — ещё {rows.length - 6}</button>}</div></section>)}</div>
    {!loading && !errors.length && <p className="help-text dashboard-clear-summary">Без событий: {cards.filter((card) => card.count === 0).map((card) => card.title).join(" · ") || "нет пустых категорий"}.</p>}
    <details className="surface dashboard-storage"><summary>Хранилище и резервные копии</summary><div className="surface-body"><div className="metric-grid"><div><span>Свободное место</span><strong>{workspace && Number.isFinite(workspace.freeSpaceBytes) ? `${(workspace.freeSpaceBytes / 1024 / 1024 / 1024).toFixed(1)} ГБ` : "—"}</strong></div><div><span>Режим</span><strong>{workspace ? workspace.portable ? "Переносимый" : "Выбранная папка" : "—"}</strong></div></div><p className="help-text">Создание, проверка и восстановление резервной копии доступны в настройках.</p></div></details>
  </div>;
}
