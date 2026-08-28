import { useMemo, useState } from "react";
import { ConfirmDialog } from "../../components/Dialog";
import { useRecords } from "../../hooks/useRecords";
import type { StoredRecord } from "../../lib/storage";
import { useWorkspaceAccess } from "../../lib/workspaceAccess";
import type { ProcurementData } from "../procurement/types";
import type { StaffData } from "../staff/types";
import {
  complexityHours,
  daysTo,
  recommendStaff,
  scheduleRisks,
  staffLoad,
} from "./domain";
import {
  assignmentRoles,
  emptyAssignment,
  emptyMilestone,
  emptyTenderSchedule,
  preparationStatuses,
  tenderComplexities,
  type TenderScheduleData,
} from "./types";

type View = "calendar" | "distribution" | "load";

const monthLabel = (value: Date) =>
  value.toLocaleDateString("ru-RU", { month: "long", year: "numeric" });
const dateKey = (value: Date) =>
  `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
const plusDays = (date: string, days: number) => {
  const value = new Date(`${date}T12:00:00`);
  value.setDate(value.getDate() + days);
  return dateKey(value);
};
export const suggestedInternalDeadline = (start: string, deadline: string) => {
  const effectiveStart = start || dateKey(new Date());
  const proposed = plusDays(deadline, -2);
  return proposed < effectiveStart ? effectiveStart : proposed;
};

function monthCells(month: Date): Array<{ date: string; current: boolean }> {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const mondayOffset = (first.getDay() + 6) % 7;
  const start = new Date(first);
  start.setDate(1 - mondayOffset);
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    return {
      date: dateKey(date),
      current: date.getMonth() === month.getMonth(),
    };
  });
}

export function TenderCalendar() {
  const workspaceAccess = useWorkspaceAccess();
  const readOnly = !workspaceAccess.editor;
  const schedules = useRecords<TenderScheduleData>("tender-calendar");
  const procurements = useRecords<ProcurementData>("procurement");
  const staff = useRecords<StaffData>("staff");
  const [view, setView] = useState<View>("calendar");
  const [month, setMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const [editing, setEditing] = useState<
    StoredRecord<TenderScheduleData> | "new" | null
  >(null);
  const [archiving, setArchiving] =
    useState<StoredRecord<TenderScheduleData> | null>(null);
  const values = schedules.records.map((record) => record.payload);
  const staffName = (id: string) =>
    staff.records.find((record) => record.id === id)?.payload.fullName ||
    "Не назначен";
  const active = values.filter(
    (item) => !["Подана", "Приостановлена"].includes(item.status),
  );
  const urgent = active.filter((item) => {
    const days = daysTo(item.internalDeadline || item.submissionDeadline);
    return days != null && days <= 5;
  });
  const rangeStart = dateKey(
    new Date(month.getFullYear(), month.getMonth(), 1),
  );
  const rangeEnd = dateKey(
    new Date(month.getFullYear(), month.getMonth() + 1, 0),
  );
  const loads = staff.records
    .map((record) => ({
      record,
      load: staffLoad(record.id, values, rangeStart, rangeEnd),
    }))
    .filter((row) => row.load.plannedHours > 0)
    .sort((a, b) => b.load.loadPercent - a.load.loadPercent);
  const overloaded = loads.filter(
    (row) => row.load.loadPercent > 100 || row.load.conflicts.length,
  ).length;
  const cells = useMemo(() => monthCells(month), [month]);

  return (
    <div className="module-stack tender-calendar-module">
      <div className="stats-row calendar-stats">
        <div className="stat">
          <span>Активных заявок</span>
          <strong>{active.length}</strong>
        </div>
        <div className="stat">
          <span>Срок ≤ 5 дней</span>
          <strong>{urgent.length}</strong>
        </div>
        <div className="stat">
          <span>Перегружено сотрудников</span>
          <strong>{overloaded}</strong>
        </div>
        <div className="stat">
          <span>Без менеджера</span>
          <strong>
            {
              active.filter(
                (item) =>
                  !item.assignments.some((entry) =>
                    ["Руководитель заявки", "Менеджер"].includes(entry.role),
                  ),
              ).length
            }
          </strong>
        </div>
      </div>
      {readOnly && (
        <div className="notice warning">
          <strong>Режим просмотра</strong>
          <span>{workspaceAccess.message}</span>
        </div>
      )}
      <div className="surface calendar-toolbar">
        <div className="chart-tabs">
          <button
            className={view === "calendar" ? "active" : ""}
            type="button"
            onClick={() => setView("calendar")}
          >
            Календарь
          </button>
          <button
            className={view === "distribution" ? "active" : ""}
            type="button"
            onClick={() => setView("distribution")}
          >
            Распределение
          </button>
          <button
            className={view === "load" ? "active" : ""}
            type="button"
            onClick={() => setView("load")}
          >
            Загрузка специалистов
          </button>
        </div>
        <div className="calendar-actions">
          <button
            className="secondary small"
            type="button"
            onClick={() =>
              setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))
            }
          >
            ‹
          </button>
          <strong>{monthLabel(month)}</strong>
          <button
            className="secondary small"
            type="button"
            onClick={() =>
              setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))
            }
          >
            ›
          </button>
          {!readOnly && (
            <button
              className="primary"
              type="button"
              onClick={() => setEditing("new")}
            >
              Запланировать заявку
            </button>
          )}
        </div>
      </div>

      {schedules.error && (
        <div className="notice error">
          Не удалось открыть календарь: {schedules.error}
        </div>
      )}
      {view === "calendar" && (
        <div className="surface tender-calendar">
          <div className="calendar-weekdays">
            {["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"].map((day) => (
              <span key={day}>{day}</span>
            ))}
          </div>
          <div className="calendar-grid">
            {cells.map((cell) => {
              const events = schedules.records.filter(
                ({ payload }) =>
                  payload.preparationStart <= cell.date &&
                  payload.submissionDeadline >= cell.date,
              );
              return (
                <div
                  key={cell.date}
                  className={`calendar-day ${cell.current ? "" : "outside"} ${cell.date === dateKey(new Date()) ? "today" : ""}`}
                >
                  <time>{Number(cell.date.slice(-2))}</time>
                  <div>
                    {events.slice(0, 4).map((record) => {
                      const item = record.payload;
                      const isDeadline = item.submissionDeadline === cell.date;
                      return (
                        <button
                          key={record.id}
                          disabled={readOnly}
                          className={`calendar-event complexity-${tenderComplexities.indexOf(item.complexity) + 1} ${isDeadline ? "deadline" : ""}`}
                          type="button"
                          title={`${item.procurementTitle} · ${item.complexity} · ${item.status}`}
                          onClick={() => setEditing(record)}
                        >
                          <span>
                            {isDeadline ? "Подача · " : ""}
                            {item.procurementTitle}
                          </span>
                          <small>
                            {staffName(
                              item.assignments.find(
                                (entry) => entry.role === "Руководитель заявки",
                              )?.staffId || "",
                            )}
                          </small>
                        </button>
                      );
                    })}
                    {events.length > 4 && (
                      <small className="more-events">
                        + ещё {events.length - 4}
                      </small>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {view === "distribution" && (
        <div className="surface table-surface">
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Закупка</th>
                  <th>Сложность</th>
                  <th>Руководитель</th>
                  <th>Команда</th>
                  <th>Распределено</th>
                  <th>Внутренний срок</th>
                  <th>Статус</th>
                  <th>Риски</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {schedules.records.map((record) => {
                  const item = record.payload;
                  const planned = item.assignments.reduce(
                    (sum, entry) => sum + entry.plannedHours,
                    0,
                  );
                  const risks = scheduleRisks(item, values);
                  return (
                    <tr key={record.id}>
                      <td>
                        <button
                          className="link-button"
                          disabled={readOnly}
                          type="button"
                          onClick={() => setEditing(record)}
                        >
                          <strong>{item.procurementTitle}</strong>
                          <small>{item.customer}</small>
                        </button>
                      </td>
                      <td>
                        <span
                          className={`status ${item.complexity === "Экспертная" || item.complexity === "Высокая" ? "warning" : "neutral"}`}
                        >
                          {item.complexity}
                        </span>
                      </td>
                      <td>
                        {staffName(
                          item.assignments.find(
                            (entry) => entry.role === "Руководитель заявки",
                          )?.staffId || "",
                        )}
                      </td>
                      <td>
                        {
                          new Set(
                            item.assignments
                              .map((entry) => entry.staffId)
                              .filter(Boolean),
                          ).size
                        }
                      </td>
                      <td>
                        <div className="completion load-completion">
                          <span
                            style={{
                              width: `${Math.min(100, (planned / Math.max(1, item.estimatedHours)) * 100)}%`,
                            }}
                          />
                          <small>
                            {planned} / {item.estimatedHours} ч.
                          </small>
                        </div>
                      </td>
                      <td>
                        {item.internalDeadline || item.submissionDeadline}
                      </td>
                      <td>{item.status}</td>
                      <td>
                        {risks.length ? (
                          <span
                            className="status danger"
                            title={risks.join("\n")}
                          >
                            {risks.length} риска
                          </span>
                        ) : (
                          <span className="status success">В норме</span>
                        )}
                      </td>
                      <td>
                        <button
                          className="icon-button danger"
                          disabled={readOnly}
                          type="button"
                          aria-label={`Архивировать ${item.procurementTitle}`}
                          onClick={() => setArchiving(record)}
                        >
                          ×
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {!readOnly && !schedules.loading && !schedules.records.length && (
            <EmptyCalendar onCreate={() => setEditing("new")} />
          )}
        </div>
      )}

      {view === "load" && (
        <div className="surface">
          <div className="surface-title">
            <h2>Загрузка специалистов за {monthLabel(month)}</h2>
            <span>Норма: 8 часов в рабочий день</span>
          </div>
          <div className="surface-body workload-list">
            {loads.map(({ record, load }) => (
              <div className="workload-row" key={record.id}>
                <div>
                  <strong>{record.payload.fullName}</strong>
                  <small>
                    {record.payload.role} ·{" "}
                    {record.payload.qualification || "квалификация не указана"}
                  </small>
                </div>
                <div className="workload-track">
                  <i
                    className={
                      load.loadPercent > 100
                        ? "over"
                        : load.loadPercent > 80
                          ? "busy"
                          : ""
                    }
                    style={{ width: `${Math.min(100, load.loadPercent)}%` }}
                  />
                </div>
                <strong className={load.loadPercent > 100 ? "danger" : ""}>
                  {Math.round(load.loadPercent)}%
                </strong>
                <small>
                  {Math.round(load.plannedHours)} из {load.capacityHours} ч.
                </small>
                {load.conflicts.length > 0 && (
                  <span
                    className="status danger"
                    title={load.conflicts.join("\n")}
                  >
                    {load.conflicts.length} перегрузок
                  </span>
                )}
              </div>
            ))}
            {!loads.length && (
              <div className="empty-inline">
                В этом месяце нагрузка ещё не распределена.
              </div>
            )}
          </div>
        </div>
      )}

      {!readOnly && editing && (
        <ScheduleEditor
          record={editing === "new" ? undefined : editing}
          procurements={procurements.records}
          staff={staff.records}
          allSchedules={values}
          onClose={() => setEditing(null)}
          onSave={async (item, id) => {
            const saved = await schedules.save(item.procurementTitle, item, id);
            setEditing(saved);
          }}
        />
      )}
      {!readOnly && archiving && (
        <ConfirmDialog
          title="Убрать заявку из календаря?"
          message={archiving.payload.procurementTitle}
          confirmLabel="В архив"
          onClose={() => setArchiving(null)}
          onConfirm={() => {
            void schedules.archive(archiving.id);
            setArchiving(null);
          }}
        />
      )}
    </div>
  );
}

function EmptyCalendar({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="empty-state">
      <span className="empty-icon">▦</span>
      <h2>Календарь пока пуст</h2>
      <p>
        Добавьте закупку, оцените сложность и распределите часы между
        сотрудниками.
      </p>
      <button className="primary" type="button" onClick={onCreate}>
        Запланировать заявку
      </button>
    </div>
  );
}

function ScheduleEditor({
  record,
  procurements,
  staff,
  allSchedules,
  onSave,
  onClose,
}: {
  record?: StoredRecord<TenderScheduleData>;
  procurements: StoredRecord<ProcurementData>[];
  staff: StoredRecord<StaffData>[];
  allSchedules: TenderScheduleData[];
  onSave: (item: TenderScheduleData, id?: string) => Promise<void>;
  onClose: () => void;
}) {
  const [item, setItem] = useState<TenderScheduleData>(
    record
      ? {
          ...emptyTenderSchedule(),
          ...structuredClone(record.payload),
          source: record.payload.procurementId ? "procurement" : "manual",
        }
      : emptyTenderSchedule(),
  );
  const [error, setError] = useState("");
  const update = <K extends keyof TenderScheduleData>(
    key: K,
    value: TenderScheduleData[K],
  ) => setItem((current) => ({ ...current, [key]: value }));
  const recommendations = recommendStaff(
    staff,
    allSchedules.filter((entry) => entry !== record?.payload),
    item,
  );
  const staffName = (id: string) =>
    staff.find((entry) => entry.id === id)?.payload.fullName || "";
  const chooseProcurement = (id: string) => {
    const source = procurements.find((entry) => entry.id === id);
    if (!source) return;
    const deadline = source.payload.submissionDeadline;
    setItem((current) => ({
      ...current,
      source: "procurement",
      procurementId: id,
      procurementTitle: source.payload.name,
      customer: source.payload.customer,
      submissionDeadline: deadline,
      internalDeadline: deadline
        ? plusDays(deadline, -2)
        : current.internalDeadline,
      requiredSkills: [
        ...new Set(
          source.payload.requirements
            .map((entry) => entry.category)
            .filter(Boolean),
        ),
      ],
    }));
  };
  const save = async () => {
    if (!item.procurementTitle.trim())
      return setError("Укажите название заявки.");
    if (
      item.procurementId &&
      allSchedules.some(
        (entry) =>
          entry !== record?.payload &&
          entry.procurementId === item.procurementId,
      )
    )
      return setError("Эта закупка уже добавлена в календарь.");
    if (!item.submissionDeadline) return setError("Укажите срок подачи.");
    const preparationStart =
      item.preparationStart || new Date().toISOString().slice(0, 10);
    const ready = {
      ...item,
      preparationStart,
      internalDeadline:
        item.internalDeadline ||
        suggestedInternalDeadline(preparationStart, item.submissionDeadline),
    };
    if (
      ready.preparationStart > ready.internalDeadline ||
      ready.internalDeadline > ready.submissionDeadline
    )
      return setError(
        "Даты должны идти в порядке: начало → внутренний срок → подача.",
      );
    if (
      item.assignments.some(
        (entry) =>
          !entry.staffId ||
          !entry.startDate ||
          !entry.endDate ||
          entry.startDate > entry.endDate ||
          entry.plannedHours <= 0,
      )
    )
      return setError("Проверьте сотрудника, даты и часы во всех назначениях.");
    await onSave(ready, record?.id);
    setError("");
  };
  const risks = scheduleRisks(item, [
    ...allSchedules.filter((entry) => entry !== record?.payload),
    item,
  ]);

  return (
    <aside
      className="detail-drawer procurement-drawer"
      role="dialog"
      aria-modal="true"
      aria-label="План подготовки заявки"
    >
      <header>
        <div>
          <h2>{record ? item.procurementTitle : "Новая заявка в календаре"}</h2>
          <p>Распределение подготовки, сроки и загрузка команды</p>
        </div>
        <button className="icon-button" type="button" onClick={onClose}>
          ×
        </button>
      </header>
      <div className="drawer-body schedule-editor">
        {error && <div className="notice error">{error}</div>}
        {risks.length > 0 && (
          <div className="notice warning">
            <strong>Требует внимания</strong>
            {risks.map((risk) => (
              <span key={risk}>{risk}</span>
            ))}
          </div>
        )}
        <h3>Заявка и срок</h3>
        <div className="form-grid">
          <label className="wide">
            Способ добавления
            <select
              value={item.source}
              disabled={Boolean(record)}
              onChange={(event) =>
                setItem((current) => ({
                  ...current,
                  source: event.target.value as TenderScheduleData["source"],
                  procurementId: "",
                  procurementTitle: "",
                  customer: "",
                }))
              }
            >
              <option value="manual">Вручную, минимальная карточка</option>
              <option value="procurement">Из реестра закупок</option>
            </select>
          </label>
          {item.source === "procurement" ? (
            <label className="wide">
              Закупка *
              <select
                value={item.procurementId}
                disabled={Boolean(record)}
                onChange={(event) => chooseProcurement(event.target.value)}
              >
                <option value="">Выберите закупку…</option>
                {procurements
                  .filter(
                    (entry) =>
                      Boolean(record) ||
                      !allSchedules.some(
                        (schedule) => schedule.procurementId === entry.id,
                      ),
                  )
                  .map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.payload.name} · {entry.payload.customer}
                    </option>
                  ))}
              </select>
            </label>
          ) : (
            <>
              <label className="wide">
                Название заявки *
                <input
                  value={item.procurementTitle}
                  onChange={(event) =>
                    update("procurementTitle", event.target.value)
                  }
                  placeholder="Например, аудит информационной безопасности"
                />
              </label>
              <label className="wide">
                Заказчик
                <input
                  value={item.customer}
                  onChange={(event) => update("customer", event.target.value)}
                />
              </label>
            </>
          )}
          <label>
            Срок подачи *
            <input
              type="date"
              value={item.submissionDeadline}
              onChange={(event) => {
                const deadline = event.target.value;
                setItem((current) => ({
                  ...current,
                  submissionDeadline: deadline,
                  internalDeadline:
                    current.internalDeadline ||
                    (deadline
                      ? suggestedInternalDeadline(
                          current.preparationStart,
                          deadline,
                        )
                      : ""),
                }));
              }}
            />
          </label>
          <label>
            Начало подготовки
            <input
              type="date"
              value={item.preparationStart}
              onChange={(event) =>
                update("preparationStart", event.target.value)
              }
            />
          </label>
          <label>
            Внутренний срок
            <input
              type="date"
              value={item.internalDeadline}
              onChange={(event) =>
                update("internalDeadline", event.target.value)
              }
            />
          </label>
          <label>
            Сложность
            <select
              value={item.complexity}
              onChange={(event) => {
                const complexity = event.target
                  .value as TenderScheduleData["complexity"];
                setItem((current) => ({
                  ...current,
                  complexity,
                  estimatedHours: complexityHours[complexity],
                }));
              }}
            >
              {tenderComplexities.map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <label>
            Приоритет
            <select
              value={item.priority}
              onChange={(event) =>
                update(
                  "priority",
                  event.target.value as TenderScheduleData["priority"],
                )
              }
            >
              <option>Обычный</option>
              <option>Высокий</option>
              <option>Критический</option>
            </select>
          </label>
          <label>
            Статус
            <select
              value={item.status}
              onChange={(event) =>
                update(
                  "status",
                  event.target.value as TenderScheduleData["status"],
                )
              }
            >
              {preparationStatuses.map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <label>
            Оценка трудоёмкости, ч.
            <input
              type="number"
              min="1"
              value={item.estimatedHours}
              onChange={(event) =>
                update("estimatedHours", Number(event.target.value))
              }
            />
          </label>
          <label className="wide">
            Требуемые навыки
            <input
              value={item.requiredSkills.join(", ")}
              onChange={(event) =>
                update(
                  "requiredSkills",
                  event.target.value
                    .split(",")
                    .map((value) => value.trim())
                    .filter(Boolean),
                )
              }
              placeholder="44-ФЗ, сметы, банковские гарантии"
            />
          </label>
        </div>
        <h3>Команда и распределение часов</h3>
        <div className="recommendation-panel">
          <strong>Рекомендуемые сотрудники</strong>
          {recommendations.slice(0, 5).map((entry) => (
            <span key={entry.staffId}>
              <b>{staffName(entry.staffId)}</b>
              <i>{entry.score} баллов</i>
              <small>{entry.reason}</small>
            </span>
          ))}
        </div>
        <button
          className="secondary"
          type="button"
          onClick={() =>
            update("assignments", [
              ...item.assignments,
              {
                ...emptyAssignment(),
                startDate: item.preparationStart,
                endDate: item.internalDeadline,
              },
            ])
          }
        >
          Добавить назначение
        </button>
        {item.assignments.map((assignment) => {
          const score = recommendations.find(
            (entry) => entry.staffId === assignment.staffId,
          );
          return (
            <div
              className="surface compact-card assignment-card"
              key={assignment.id}
            >
              <div className="form-grid">
                <label>
                  Сотрудник
                  <select
                    value={assignment.staffId}
                    onChange={(event) =>
                      update(
                        "assignments",
                        item.assignments.map((entry) =>
                          entry.id === assignment.id
                            ? { ...entry, staffId: event.target.value }
                            : entry,
                        ),
                      )
                    }
                  >
                    <option value="">Выберите…</option>
                    {recommendations.map((entry) => (
                      <option value={entry.staffId} key={entry.staffId}>
                        {staffName(entry.staffId)} · {entry.score} баллов
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Роль
                  <select
                    value={assignment.role}
                    onChange={(event) =>
                      update(
                        "assignments",
                        item.assignments.map((entry) =>
                          entry.id === assignment.id
                            ? {
                                ...entry,
                                role: event.target.value as typeof entry.role,
                              }
                            : entry,
                        ),
                      )
                    }
                  >
                    {assignmentRoles.map((role) => (
                      <option key={role}>{role}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Часы
                  <input
                    type="number"
                    min="1"
                    value={assignment.plannedHours}
                    onChange={(event) =>
                      update(
                        "assignments",
                        item.assignments.map((entry) =>
                          entry.id === assignment.id
                            ? {
                                ...entry,
                                plannedHours: Number(event.target.value),
                              }
                            : entry,
                        ),
                      )
                    }
                  />
                </label>
                <label>
                  С
                  <input
                    type="date"
                    value={assignment.startDate}
                    onChange={(event) =>
                      update(
                        "assignments",
                        item.assignments.map((entry) =>
                          entry.id === assignment.id
                            ? { ...entry, startDate: event.target.value }
                            : entry,
                        ),
                      )
                    }
                  />
                </label>
                <label>
                  По
                  <input
                    type="date"
                    value={assignment.endDate}
                    onChange={(event) =>
                      update(
                        "assignments",
                        item.assignments.map((entry) =>
                          entry.id === assignment.id
                            ? { ...entry, endDate: event.target.value }
                            : entry,
                        ),
                      )
                    }
                  />
                </label>
                <label>
                  Комментарий
                  <input
                    value={assignment.comment}
                    onChange={(event) =>
                      update(
                        "assignments",
                        item.assignments.map((entry) =>
                          entry.id === assignment.id
                            ? { ...entry, comment: event.target.value }
                            : entry,
                        ),
                      )
                    }
                  />
                </label>
              </div>
              <div className="assignment-footer">
                <span
                  className={`status ${score && score.score >= 70 ? "success" : "warning"}`}
                >
                  {score
                    ? `${score.qualification}% квалификация · ${Math.round(score.load)}% загрузка до назначения`
                    : "Оценка недоступна"}
                </span>
                <button
                  className="secondary small danger"
                  type="button"
                  onClick={() =>
                    update(
                      "assignments",
                      item.assignments.filter(
                        (entry) => entry.id !== assignment.id,
                      ),
                    )
                  }
                >
                  Удалить
                </button>
              </div>
            </div>
          );
        })}
        <h3>Контрольные точки</h3>
        <button
          className="secondary"
          type="button"
          onClick={() =>
            update("milestones", [
              ...item.milestones,
              { ...emptyMilestone(), dueDate: item.internalDeadline },
            ])
          }
        >
          Добавить контрольную точку
        </button>
        {item.milestones.map((milestone) => (
          <div className="milestone-row" key={milestone.id}>
            <input
              type="checkbox"
              checked={milestone.done}
              onChange={(event) =>
                update(
                  "milestones",
                  item.milestones.map((entry) =>
                    entry.id === milestone.id
                      ? { ...entry, done: event.target.checked }
                      : entry,
                  ),
                )
              }
            />
            <input
              aria-label="Контрольная точка"
              value={milestone.title}
              placeholder="Проверить обеспечение заявки"
              onChange={(event) =>
                update(
                  "milestones",
                  item.milestones.map((entry) =>
                    entry.id === milestone.id
                      ? { ...entry, title: event.target.value }
                      : entry,
                  ),
                )
              }
            />
            <input
              aria-label="Срок контрольной точки"
              type="date"
              value={milestone.dueDate}
              onChange={(event) =>
                update(
                  "milestones",
                  item.milestones.map((entry) =>
                    entry.id === milestone.id
                      ? { ...entry, dueDate: event.target.value }
                      : entry,
                  ),
                )
              }
            />
            <select
              aria-label="Ответственный"
              value={milestone.responsibleStaffId}
              onChange={(event) =>
                update(
                  "milestones",
                  item.milestones.map((entry) =>
                    entry.id === milestone.id
                      ? { ...entry, responsibleStaffId: event.target.value }
                      : entry,
                  ),
                )
              }
            >
              <option value="">Ответственный…</option>
              {staff.map((entry) => (
                <option value={entry.id} key={entry.id}>
                  {entry.payload.fullName}
                </option>
              ))}
            </select>
            <button
              className="icon-button danger"
              type="button"
              onClick={() =>
                update(
                  "milestones",
                  item.milestones.filter((entry) => entry.id !== milestone.id),
                )
              }
            >
              ×
            </button>
          </div>
        ))}
        <label>
          Примечания
          <textarea
            rows={4}
            value={item.notes}
            onChange={(event) => update("notes", event.target.value)}
          />
        </label>
      </div>
      <footer>
        <span className="drawer-completeness">
          Распределено{" "}
          {item.assignments.reduce((sum, entry) => sum + entry.plannedHours, 0)}{" "}
          из {item.estimatedHours} ч.
        </span>
        <button className="secondary" type="button" onClick={onClose}>
          Закрыть
        </button>
        <button className="primary" type="button" onClick={() => void save()}>
          Сохранить план
        </button>
      </footer>
    </aside>
  );
}
