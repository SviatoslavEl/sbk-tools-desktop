import { useEffect, useMemo, useState } from "react";
import { ConfirmDialog } from "../../components/Dialog";
import { useRecords } from "../../hooks/useRecords";
import { chooseSavePath, exportText } from "../../lib/files";
import { writeTextFile, writeXlsx, type StoredRecord } from "../../lib/storage";
import { useWorkspaceAccess } from "../../lib/workspaceAccess";
import type { CalculatorData } from "../calculator/types";
import type { ContractData } from "../contracts/types";
import type { StaffData } from "../staff/types";
import {
  buildRebidSteps,
  complianceSummary,
  daysUntil,
  procurementWarnings,
  suggestedExperience,
  suggestedTeam,
  type RebidPreset,
} from "./domain";
import {
  anonymousCalculationBody,
  documentHtml,
  experienceReferenceBody,
  html,
  money,
  safeBase,
  summaryBody,
  teamListBody,
  workAllocationBody,
} from "./documents";
import {
  complianceStatuses,
  emptyChecklist,
  emptyPartner,
  emptyPriceRound,
  emptyProcurement,
  emptyRequirement,
  evidenceKinds,
  normalizeProcurement,
  procurementStatuses,
  type ProcurementData,
  type SnapshotLink,
} from "./types";
import { Stage2Workspace } from "./Stage2Workspace";
import { demoProcurements } from "./demo";

const demoSeedTitle = "demo-procurements-v1";

function snapshot(
  sourceModule: SnapshotLink["sourceModule"],
  record: StoredRecord<unknown>,
): SnapshotLink {
  return {
    id: crypto.randomUUID(),
    sourceModule,
    sourceId: record.id,
    title: record.title,
    capturedAt: new Date().toISOString(),
    snapshot: structuredClone(record.payload) as Record<string, unknown>,
  };
}

export function ProcurementRegistry() {
  const workspaceAccess = useWorkspaceAccess();
  const readOnly = !workspaceAccess.editor;
  const store = useRecords<ProcurementData>("procurement");
  const demoSettings = useRecords<{ seededAt: string }>("settings");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [editing, setEditing] = useState<
    StoredRecord<ProcurementData> | "new" | null
  >(null);
  const [archiving, setArchiving] =
    useState<StoredRecord<ProcurementData> | null>(null);
  const [seedingDemos, setSeedingDemos] = useState(false);
  const addDemos = async () => {
    if (seedingDemos) return;
    setSeedingDemos(true);
    try {
      const existingIds = new Set(store.records.map((record) => record.id));
      for (const demo of demoProcurements())
        if (!existingIds.has(demo.id))
          await store.save(demo.item.name, demo.item, demo.id);
      const marker = demoSettings.records.find(
        (record) => record.title === demoSeedTitle,
      );
      await demoSettings.save(
        demoSeedTitle,
        { seededAt: new Date().toISOString() },
        marker?.id,
      );
    } finally {
      setSeedingDemos(false);
    }
  };
  useEffect(() => {
    if (
      !readOnly &&
      !store.loading &&
      !demoSettings.loading &&
      !demoSettings.records.some((record) => record.title === demoSeedTitle)
    )
      void addDemos();
    // The marker is stored in the current workspace, so a newly selected workspace gets its own demos.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly, store.loading, demoSettings.loading]);
  const filtered = store.records.filter(
    (record) =>
      [
        record.payload.name,
        record.payload.customer,
        record.payload.subject,
        record.payload.platform,
      ]
        .join(" ")
        .toLowerCase()
        .includes(search.toLowerCase()) &&
      (!status || record.payload.status === status),
  );
  const urgent = store.records.filter((record) => {
    const days = daysUntil(record.payload.submissionDeadline);
    return (
      days != null &&
      days >= 0 &&
      days <= 7 &&
      !["Подана", "Победа", "Проигрыш", "Отменена"].includes(
        record.payload.status,
      )
    );
  }).length;
  return (
    <div className="module-stack">
      <div className="stats-row">
        <div className="stat">
          <span>Закупок</span>
          <strong>{store.records.length}</strong>
        </div>
        <div className="stat">
          <span>Срок ≤ 7 дней</span>
          <strong>{urgent}</strong>
        </div>
        <div className="stat">
          <span>Подано / победы</span>
          <strong>
            {
              store.records.filter((record) =>
                ["Подана", "Победа"].includes(record.payload.status),
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
      <div className="registry-toolbar">
        <label className="search-box">
          <span>Поиск</span>
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Название, заказчик, предмет"
          />
        </label>
        <label>
          <span>Статус</span>
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value)}
          >
            <option value="">Все</option>
            {procurementStatuses.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        {!readOnly && (
          <div className="toolbar-actions">
            <button
              className="secondary"
              type="button"
              disabled={seedingDemos}
              onClick={() => void addDemos()}
            >
              {seedingDemos ? "Добавляем…" : "Добавить демо"}
            </button>
            <button
              className="primary"
              type="button"
              onClick={() => setEditing("new")}
            >
              Добавить закупку
            </button>
          </div>
        )}
      </div>
      <div className="surface table-surface">
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Закупка</th>
                <th>Заказчик</th>
                <th>Предмет</th>
                <th>НМЦ</th>
                <th>Площадка</th>
                <th>Подача</th>
                <th>Статус</th>
                <th>Матрица</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {filtered.map((record) => {
                const item = record.payload;
                const deadline = daysUntil(item.submissionDeadline);
                const compliance = complianceSummary(item.requirements);
                return (
                  <tr key={record.id}>
                    <td className="sticky-cell">
                      {readOnly ? (
                        <>
                          <strong>{item.name}</strong>
                          <small>{record.updatedAt.slice(0, 10)}</small>
                        </>
                      ) : (
                        <button
                          className="link-button"
                          type="button"
                          onClick={() => setEditing(record)}
                        >
                          <strong>{item.name}</strong>
                          <small>{record.updatedAt.slice(0, 10)}</small>
                        </button>
                      )}
                    </td>
                    <td>{item.customer}</td>
                    <td className="wide-cell">{item.subject}</td>
                    <td>{money(item.nmc)}</td>
                    <td>{item.platform || "—"}</td>
                    <td>
                      <span
                        className={`status ${deadline != null && deadline < 0 ? "danger" : deadline != null && deadline <= 7 ? "warning" : "neutral"}`}
                      >
                        {item.submissionDeadline || "—"}
                        {deadline != null
                          ? ` · ${deadline < 0 ? "просрочено" : `${deadline} дн.`}`
                          : ""}
                      </span>
                    </td>
                    <td>{item.status}</td>
                    <td>
                      {compliance.confirmed} из {compliance.total}
                    </td>
                    <td>
                      {!readOnly && (
                        <button
                          className="icon-button danger"
                          type="button"
                          aria-label={`Архивировать ${item.name}`}
                          onClick={() => setArchiving(record)}
                        >
                          ×
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!store.loading && filtered.length === 0 && (
          <div className="empty-state">
            <span className="empty-icon">◆</span>
            <h2>
              {store.records.length
                ? "Ничего не найдено"
                : "Создайте первую закупку"}
            </h2>
            <p>
              Требования, расчёты, команда, документы и переторжка будут собраны
              в одной карточке.
            </p>
            {!store.records.length && !readOnly && (
              <button
                className="primary"
                type="button"
                onClick={() => setEditing("new")}
              >
                Добавить закупку
              </button>
            )}
          </div>
        )}
      </div>
      {!readOnly && editing && (
        <ProcurementEditor
          record={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
          onSave={async (item, id) => {
            const saved = await store.save(item.name, item, id);
            setEditing(saved);
          }}
        />
      )}
      {!readOnly && archiving && (
        <ConfirmDialog
          title="Переместить закупку в архив?"
          message={archiving.payload.name}
          confirmLabel="В архив"
          onClose={() => setArchiving(null)}
          onConfirm={() => {
            void store.archive(archiving.id);
            setArchiving(null);
          }}
        />
      )}
    </div>
  );
}

type Tab =
  | "main"
  | "compliance"
  | "links"
  | "partners"
  | "checklist"
  | "rebid"
  | "stage2"
  | "documents";

function ProcurementEditor({
  record,
  onSave,
  onClose,
}: {
  record?: StoredRecord<ProcurementData>;
  onSave: (item: ProcurementData, id?: string) => Promise<void>;
  onClose: () => void;
}) {
  const calculations = useRecords<CalculatorData>("calculator");
  const contracts = useRecords<ContractData>("contract-experience");
  const staff = useRecords<StaffData>("staff");
  const [item, setItem] = useState<ProcurementData>(
    record
      ? normalizeProcurement(
          structuredClone(record.payload) as ProcurementData &
            Record<string, unknown>,
        )
      : emptyProcurement(),
  );
  const [tab, setTab] = useState<Tab>("main");
  const [error, setError] = useState("");
  const [cost, setCost] = useState(
    () => Number(item.calculations[0]?.snapshot.cost) || 0,
  );
  const [stepCount, setStepCount] = useState(6);
  const [reduction, setReduction] = useState(1);
  const [rebidPreset, setRebidPreset] = useState<RebidPreset>("comfort");
  const warnings = procurementWarnings(item);
  const compliance = complianceSummary(item.requirements);
  const steps = useMemo(() => {
    try {
      return buildRebidSteps(item.nmc, cost, stepCount, reduction, rebidPreset);
    } catch {
      return [];
    }
  }, [item.nmc, cost, stepCount, reduction, rebidPreset]);
  const update = <K extends keyof ProcurementData>(
    key: K,
    value: ProcurementData[K],
  ) => setItem((current) => ({ ...current, [key]: value }));
  const save = async () => {
    const blocking = procurementWarnings(item).filter(
      (warning) =>
        warning.startsWith("Не заполнены") ||
        warning.startsWith("НМЦ") ||
        warning.startsWith("Срок вопросов") ||
        warning.includes("превышает 100"),
    );
    if (blocking.length) {
      setError(blocking.join(" "));
      return;
    }
    await onSave(item, record?.id);
    setError("");
  };
  const addLink = (
    key: "calculations" | "experience" | "team",
    link: SnapshotLink,
  ) => {
    if (item[key].some((existing) => existing.sourceId === link.sourceId))
      return;
    update(key, [...item[key], link]);
  };
  const remove = <
    K extends
      | "requirements"
      | "partners"
      | "checklist"
      | "priceHistory"
      | "calculations"
      | "experience"
      | "team",
  >(
    key: K,
    id: string,
  ) =>
    update(
      key,
      item[key].filter((entry) => entry.id !== id) as ProcurementData[K],
    );
  const exportSummary = async () => {
    await exportText(
      "Сводка закупки",
      `${safeBase(item.name)}-сводка.html`,
      ["html"],
      documentHtml(item, "Сводка закупки", summaryBody(item)),
    );
  };
  const exportHtmlDocument = async (
    label: string,
    suffix: string,
    body: string,
  ) =>
    exportText(
      label,
      `${safeBase(item.name)}-${suffix}.html`,
      ["html"],
      documentHtml(item, label, body),
    );
  const exportChecklist = async () => {
    const path = await chooseSavePath(
      "Чек-лист подачи",
      `${safeBase(item.name)}-чек-лист.xlsx`,
      ["xlsx"],
    );
    if (path)
      await writeXlsx(path, {
        sheetName: "Чек-лист",
        rows: [
          ["Готово", "Пункт", "Ответственный", "Срок"],
          ...item.checklist.map((row) => [
            row.done ? "Да" : "Нет",
            row.text,
            row.responsible,
            row.dueDate,
          ]),
        ],
      });
  };
  const exportRebid = async () => {
    const path = await chooseSavePath(
      "Таблица переторжки",
      `${safeBase(item.name)}-переторжка.xlsx`,
      ["xlsx"],
    );
    if (!path) return;
    await writeXlsx(path, {
      sheetName: "Переторжка",
      rows: [
        ["Шаг", "Цена", "Снижение", "Прибыль", "Маржа, %", "Запас", "Убыток"],
        ...steps.map((step) => [
          String(step.number),
          String(step.price),
          String(step.reduction),
          String(step.profit),
          step.margin.toFixed(2),
          String(step.headroom),
          step.loss ? "Да" : "Нет",
        ]),
      ],
    });
  };
  const exportOffers = async () => {
    const chosen = await chooseSavePath(
      "Коммерческие предложения",
      `${safeBase(item.name)}-КП-шаг-1.html`,
      ["html"],
    );
    if (!chosen) return;
    const directory = chosen.replace(/[\\/][^\\/]+$/, "");
    const separator = chosen.includes("\\") ? "\\" : "/";
    for (const step of steps)
      await writeTextFile(
        `${directory}${separator}${safeBase(item.name)}-КП-шаг-${step.number}.html`,
        documentHtml(
          item,
          `Коммерческое предложение — шаг ${step.number}`,
          `<h2>Цена предложения: ${html(money(step.price))}</h2><p>Снижение от НМЦ: ${html(money(step.reduction))}</p><p>Срок действия и условия поставки уточняются в закупочной документации.</p>${step.loss ? '<p class="warn"><b>Внутреннее предупреждение: цена ниже себестоимости.</b></p>' : ""}`,
        ),
      );
  };
  const tabs: Array<[Tab, string]> = [
    ["main", "Основное"],
    ["compliance", "Матрица"],
    ["links", "Опыт и команда"],
    ["partners", "Партнёры"],
    ["checklist", "Чек-лист"],
    ["rebid", "Переторжка"],
    ["stage2", "Полный контур"],
    ["documents", "Документы"],
  ];
  return (
    <aside
      className="detail-drawer procurement-drawer"
      role="dialog"
      aria-modal="true"
    >
      <header>
        <div>
          <h2>{record ? item.name : "Новая закупка"}</h2>
          <p>Локальная карточка подготовки заявки</p>
        </div>
        <button className="icon-button" type="button" onClick={onClose}>
          ×
        </button>
      </header>
      <nav className="drawer-tabs">
        {tabs.map(([value, label]) => (
          <button
            key={value}
            className={tab === value ? "active" : ""}
            type="button"
            onClick={() => setTab(value)}
          >
            {label}
          </button>
        ))}
      </nav>
      <div className="drawer-body">
        {error && <div className="notice error">{error}</div>}
        {warnings.length > 0 && (
          <div className="notice warning">
            {warnings.map((warning) => (
              <span key={warning}>{warning}</span>
            ))}
          </div>
        )}
        {tab === "main" && (
          <>
            <h3>Карточка</h3>
            <div className="form-grid">
              <label className="wide">
                Название *
                <input
                  value={item.name}
                  onChange={(event) => update("name", event.target.value)}
                />
              </label>
              <label className="wide">
                Заказчик *
                <input
                  value={item.customer}
                  onChange={(event) => update("customer", event.target.value)}
                />
              </label>
              <label className="wide">
                Предмет *
                <textarea
                  rows={3}
                  value={item.subject}
                  onChange={(event) => update("subject", event.target.value)}
                />
              </label>
              <label>
                НМЦ
                <input
                  type="number"
                  min="0"
                  value={item.nmc}
                  onChange={(event) =>
                    update("nmc", Number(event.target.value))
                  }
                />
              </label>
              <label>
                Статус
                <select
                  value={item.status}
                  onChange={(event) =>
                    update(
                      "status",
                      event.target.value as ProcurementData["status"],
                    )
                  }
                >
                  {procurementStatuses.map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </label>
              <label>
                Площадка
                <input
                  value={item.platform}
                  onChange={(event) => update("platform", event.target.value)}
                />
              </label>
              <label>
                Публикация
                <input
                  type="date"
                  value={item.publishedDate}
                  onChange={(event) =>
                    update("publishedDate", event.target.value)
                  }
                />
              </label>
              <label>
                Вопросы до
                <input
                  type="date"
                  value={item.questionDeadline}
                  onChange={(event) =>
                    update("questionDeadline", event.target.value)
                  }
                />
              </label>
              <label>
                Подача до
                <input
                  type="date"
                  value={item.submissionDeadline}
                  onChange={(event) =>
                    update("submissionDeadline", event.target.value)
                  }
                />
              </label>
              <label className="wide">
                Результат
                <textarea
                  rows={3}
                  value={item.result}
                  onChange={(event) => update("result", event.target.value)}
                />
              </label>
              <label className="wide">
                Примечания
                <textarea
                  rows={4}
                  value={item.notes}
                  onChange={(event) => update("notes", event.target.value)}
                />
              </label>
            </div>
          </>
        )}
        {tab === "compliance" && (
          <>
            <div className="inline-heading">
              <div>
                <h3>Матрица соответствия</h3>
                <p>
                  {compliance.confirmed} из {compliance.total} подтверждено ·
                  пробелов {compliance.gaps.length} · вопросов{" "}
                  {compliance.questions.length}
                </p>
              </div>
              <button
                className="secondary small"
                type="button"
                onClick={() =>
                  update("requirements", [
                    ...item.requirements,
                    emptyRequirement(),
                  ])
                }
              >
                Добавить требование
              </button>
            </div>
            {item.requirements.map((row) => (
              <div className="editor-card" key={row.id}>
                <div className="form-grid">
                  <label className="wide">
                    Требование
                    <textarea
                      rows={2}
                      value={row.text}
                      onChange={(event) =>
                        update(
                          "requirements",
                          item.requirements.map((entry) =>
                            entry.id === row.id
                              ? { ...entry, text: event.target.value }
                              : entry,
                          ),
                        )
                      }
                    />
                  </label>
                  <label>
                    Источник
                    <select
                      value={row.evidenceKind}
                      onChange={(event) =>
                        update(
                          "requirements",
                          item.requirements.map((entry) =>
                            entry.id === row.id
                              ? {
                                  ...entry,
                                  evidenceKind: event.target
                                    .value as typeof row.evidenceKind,
                                }
                              : entry,
                          ),
                        )
                      }
                    >
                      {evidenceKinds.map((value) => (
                        <option key={value}>{value}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Статус
                    <select
                      value={row.status}
                      onChange={(event) =>
                        update(
                          "requirements",
                          item.requirements.map((entry) =>
                            entry.id === row.id
                              ? {
                                  ...entry,
                                  status: event.target
                                    .value as typeof row.status,
                                }
                              : entry,
                          ),
                        )
                      }
                    >
                      {complianceStatuses.map((value) => (
                        <option key={value}>{value}</option>
                      ))}
                    </select>
                  </label>
                  <label className="wide">
                    Подтверждение
                    <input
                      value={row.evidence}
                      onChange={(event) =>
                        update(
                          "requirements",
                          item.requirements.map((entry) =>
                            entry.id === row.id
                              ? { ...entry, evidence: event.target.value }
                              : entry,
                          ),
                        )
                      }
                    />
                  </label>
                  <label>
                    Действует до
                    <input
                      type="date"
                      value={row.expiresDate}
                      onChange={(event) =>
                        update(
                          "requirements",
                          item.requirements.map((entry) =>
                            entry.id === row.id
                              ? { ...entry, expiresDate: event.target.value }
                              : entry,
                          ),
                        )
                      }
                    />
                  </label>
                  <label className="wide">
                    Вопрос заказчику
                    <input
                      value={row.question}
                      onChange={(event) =>
                        update(
                          "requirements",
                          item.requirements.map((entry) =>
                            entry.id === row.id
                              ? { ...entry, question: event.target.value }
                              : entry,
                          ),
                        )
                      }
                    />
                  </label>
                </div>
                <button
                  className="link-button danger"
                  type="button"
                  onClick={() => remove("requirements", row.id)}
                >
                  Удалить
                </button>
              </div>
            ))}
          </>
        )}
        {tab === "links" && (
          <LinkSelection
            item={item}
            calculations={calculations.records}
            contracts={contracts.records}
            staff={staff.records}
            addLink={addLink}
            remove={remove}
          />
        )}
        {tab === "partners" && (
          <>
            <div className="inline-heading">
              <h3>Партнёры и консорциум</h3>
              <button
                className="secondary small"
                type="button"
                onClick={() =>
                  update("partners", [...item.partners, emptyPartner()])
                }
              >
                Добавить партнёра
              </button>
            </div>
            {item.partners.map((partner) => (
              <div className="editor-card" key={partner.id}>
                <div className="form-grid">
                  <label>
                    Организация
                    <input
                      value={partner.name}
                      onChange={(event) =>
                        update(
                          "partners",
                          item.partners.map((entry) =>
                            entry.id === partner.id
                              ? { ...entry, name: event.target.value }
                              : entry,
                          ),
                        )
                      }
                    />
                  </label>
                  <label>
                    Роль
                    <input
                      value={partner.role}
                      onChange={(event) =>
                        update(
                          "partners",
                          item.partners.map((entry) =>
                            entry.id === partner.id
                              ? { ...entry, role: event.target.value }
                              : entry,
                          ),
                        )
                      }
                    />
                  </label>
                  <label>
                    Доля работ, %
                    <input
                      type="number"
                      min="0"
                      max="100"
                      value={partner.workShare}
                      onChange={(event) =>
                        update(
                          "partners",
                          item.partners.map((entry) =>
                            entry.id === partner.id
                              ? {
                                  ...entry,
                                  workShare: Number(event.target.value),
                                }
                              : entry,
                          ),
                        )
                      }
                    />
                  </label>
                  <label className="wide">
                    Зона ответственности
                    <input
                      value={partner.responsibility}
                      onChange={(event) =>
                        update(
                          "partners",
                          item.partners.map((entry) =>
                            entry.id === partner.id
                              ? { ...entry, responsibility: event.target.value }
                              : entry,
                          ),
                        )
                      }
                    />
                  </label>
                </div>
                <button
                  className="link-button danger"
                  type="button"
                  onClick={() => remove("partners", partner.id)}
                >
                  Удалить
                </button>
              </div>
            ))}
          </>
        )}
        {tab === "checklist" && (
          <>
            <div className="inline-heading">
              <h3>Чек-лист подачи</h3>
              <button
                className="secondary small"
                type="button"
                onClick={() =>
                  update("checklist", [...item.checklist, emptyChecklist()])
                }
              >
                Добавить пункт
              </button>
            </div>
            {item.checklist.map((row) => (
              <div className="checklist-row" key={row.id}>
                <input
                  type="checkbox"
                  checked={row.done}
                  onChange={(event) =>
                    update(
                      "checklist",
                      item.checklist.map((entry) =>
                        entry.id === row.id
                          ? { ...entry, done: event.target.checked }
                          : entry,
                      ),
                    )
                  }
                />
                <input
                  aria-label="Пункт"
                  value={row.text}
                  onChange={(event) =>
                    update(
                      "checklist",
                      item.checklist.map((entry) =>
                        entry.id === row.id
                          ? { ...entry, text: event.target.value }
                          : entry,
                      ),
                    )
                  }
                />
                <input
                  aria-label="Ответственный"
                  placeholder="Ответственный"
                  value={row.responsible}
                  onChange={(event) =>
                    update(
                      "checklist",
                      item.checklist.map((entry) =>
                        entry.id === row.id
                          ? { ...entry, responsible: event.target.value }
                          : entry,
                      ),
                    )
                  }
                />
                <input
                  aria-label="Срок"
                  type="date"
                  value={row.dueDate}
                  onChange={(event) =>
                    update(
                      "checklist",
                      item.checklist.map((entry) =>
                        entry.id === row.id
                          ? { ...entry, dueDate: event.target.value }
                          : entry,
                      ),
                    )
                  }
                />
                <button
                  className="icon-button danger"
                  type="button"
                  onClick={() => remove("checklist", row.id)}
                >
                  ×
                </button>
              </div>
            ))}
          </>
        )}
        {tab === "rebid" && (
          <>
            <h3>Мастер переторжки</h3>
            <div className="form-grid">
              <label>
                Себестоимость
                <input
                  type="number"
                  min="0"
                  value={cost}
                  onChange={(event) => setCost(Number(event.target.value))}
                />
              </label>
              <label>
                Шагов
                <input
                  type="number"
                  min="1"
                  max="20"
                  value={stepCount}
                  onChange={(event) => setStepCount(Number(event.target.value))}
                />
              </label>
              <label>
                Снижение на шаг, %
                <input
                  type="number"
                  min="0.01"
                  max="50"
                  step="0.1"
                  value={reduction}
                  onChange={(event) => setReduction(Number(event.target.value))}
                />
              </label>
              <label>
                Стратегия
                <select
                  value={rebidPreset}
                  onChange={(event) =>
                    setRebidPreset(event.target.value as RebidPreset)
                  }
                >
                  <option value="comfort">Комфорт</option>
                  <option value="working-minimum">Рабочий минимум</option>
                  <option value="any-price">Любая цена</option>
                </select>
              </label>
            </div>
            <div className="button-row">
              <button
                className="secondary"
                type="button"
                onClick={() =>
                  update("priceHistory", [
                    ...item.priceHistory,
                    emptyPriceRound(),
                  ])
                }
              >
                Добавить раунд/конкурента
              </button>
              <button
                className="secondary"
                type="button"
                onClick={() => void exportRebid()}
              >
                Экспорт таблицы
              </button>
              <button
                className="secondary"
                type="button"
                onClick={() => void exportOffers()}
              >
                КП для каждого шага
              </button>
            </div>
            {steps.some((step) => step.loss) && (
              <div className="notice error">
                <strong>Есть убыточные шаги.</strong>
                <span>Они выделены и требуют осознанного решения.</span>
              </div>
            )}
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Шаг</th>
                    <th>Цена</th>
                    <th>Снижение</th>
                    <th>Прибыль</th>
                    <th>Маржа</th>
                    <th>Запас</th>
                  </tr>
                </thead>
                <tbody>
                  {steps.map((step) => (
                    <tr
                      key={step.number}
                      className={step.loss ? "loss-row" : ""}
                    >
                      <td>{step.number}</td>
                      <td>{money(step.price)}</td>
                      <td>{money(step.reduction)}</td>
                      <td>{money(step.profit)}</td>
                      <td>{step.margin.toFixed(1)}%</td>
                      <td>{money(step.headroom)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <h3>История раундов</h3>
            {item.priceHistory.map((round) => (
              <div className="checklist-row price-row" key={round.id}>
                <input
                  type="number"
                  aria-label="Наша цена"
                  placeholder="Наша цена"
                  value={round.ourPrice}
                  onChange={(event) =>
                    update(
                      "priceHistory",
                      item.priceHistory.map((entry) =>
                        entry.id === round.id
                          ? { ...entry, ourPrice: Number(event.target.value) }
                          : entry,
                      ),
                    )
                  }
                />
                <input
                  type="number"
                  aria-label="Цена конкурента"
                  placeholder="Конкурент"
                  value={round.competitorPrice}
                  onChange={(event) =>
                    update(
                      "priceHistory",
                      item.priceHistory.map((entry) =>
                        entry.id === round.id
                          ? {
                              ...entry,
                              competitorPrice: Number(event.target.value),
                            }
                          : entry,
                      ),
                    )
                  }
                />
                <input
                  aria-label="Комментарий"
                  placeholder="Комментарий"
                  value={round.note}
                  onChange={(event) =>
                    update(
                      "priceHistory",
                      item.priceHistory.map((entry) =>
                        entry.id === round.id
                          ? { ...entry, note: event.target.value }
                          : entry,
                      ),
                    )
                  }
                />
                <button
                  className="icon-button danger"
                  type="button"
                  onClick={() => remove("priceHistory", round.id)}
                >
                  ×
                </button>
              </div>
            ))}
          </>
        )}
        {tab === "documents" && (
          <>
            <h3>Версионированные документы</h3>
            <p className="muted">
              Создаются локально из сохранённых данных карточки. Шаблон
              SBK-PROCUREMENT/1.
            </p>
            <div className="document-actions">
              <button
                className="secondary"
                type="button"
                onClick={() => void exportSummary()}
              >
                Сводка и матрица HTML
              </button>
              <button
                className="secondary"
                type="button"
                onClick={() =>
                  void exportHtmlDocument(
                    "Обезличенный расчёт",
                    "обезличенный-расчёт",
                    anonymousCalculationBody(item),
                  )
                }
              >
                Обезличенный расчёт
              </button>
              <button
                className="secondary"
                type="button"
                onClick={() =>
                  void exportHtmlDocument(
                    "Распределение работ",
                    "распределение-работ",
                    workAllocationBody(item),
                  )
                }
              >
                Распределение работ
              </button>
              <button
                className="secondary"
                type="button"
                onClick={() =>
                  void exportHtmlDocument(
                    "Справка об опыте",
                    "справка-об-опыте",
                    experienceReferenceBody(item),
                  )
                }
              >
                Справка об опыте
              </button>
              <button
                className="secondary"
                type="button"
                onClick={() =>
                  void exportHtmlDocument(
                    "Состав команды",
                    "состав-команды",
                    teamListBody(item),
                  )
                }
              >
                Состав команды
              </button>
              <button
                className="secondary"
                type="button"
                onClick={() => void exportChecklist()}
              >
                Чек-лист XLSX
              </button>
              <button
                className="secondary"
                type="button"
                onClick={() => void exportRebid()}
              >
                Согласование цены XLSX
              </button>
              <button
                className="secondary"
                type="button"
                onClick={() => void exportOffers()}
              >
                Пакет КП по шагам
              </button>
            </div>
            <label>
              Лицензии и допуски, по одному в строке
              <textarea
                rows={6}
                value={item.licenses.join("\n")}
                onChange={(event) =>
                  update(
                    "licenses",
                    event.target.value.split("\n").filter(Boolean),
                  )
                }
              />
            </label>
            <label>
              Документы заявки, по одному в строке
              <textarea
                rows={8}
                value={item.documents.join("\n")}
                onChange={(event) =>
                  update(
                    "documents",
                    event.target.value.split("\n").filter(Boolean),
                  )
                }
              />
            </label>
          </>
        )}
        {tab === "stage2" && (
          <Stage2Workspace
            item={item}
            procurementId={record?.id}
            onChange={setItem}
          />
        )}
      </div>
      <footer>
        <span className="drawer-completeness">
          Матрица: {compliance.confirmed} из {compliance.total} · чек-лист:{" "}
          {item.checklist.filter((row) => row.done).length} из{" "}
          {item.checklist.length}
        </span>
        <button className="secondary" type="button" onClick={onClose}>
          Закрыть
        </button>
        <button className="primary" type="button" onClick={() => void save()}>
          Сохранить закупку
        </button>
      </footer>
    </aside>
  );
}

function LinkSelection({
  item,
  calculations,
  contracts,
  staff,
  addLink,
  remove,
}: {
  item: ProcurementData;
  calculations: StoredRecord<CalculatorData>[];
  contracts: StoredRecord<ContractData>[];
  staff: StoredRecord<StaffData>[];
  addLink: (
    key: "calculations" | "experience" | "team",
    link: SnapshotLink,
  ) => void;
  remove: <K extends "calculations" | "experience" | "team">(
    key: K,
    id: string,
  ) => void;
}) {
  const experienceSuggestions = new Set(suggestedExperience(item, contracts));
  const teamSuggestions = new Set(suggestedTeam(item, staff));
  const group = (
    title: string,
    key: "calculations" | "experience" | "team",
    source: SnapshotLink["sourceModule"],
    records: StoredRecord<unknown>[],
    suggestions = new Set<string>(),
  ) => {
    const available = records
      .filter(
        (candidate) =>
          !item[key].some((link) => link.sourceId === candidate.id),
      )
      .sort(
        (left, right) =>
          Number(suggestions.has(right.id)) -
            Number(suggestions.has(left.id)) ||
          left.title.localeCompare(right.title, "ru"),
      );
    return (
      <section className="link-group">
        <h3>{title}</h3>
        <p className="muted">
          {suggestions.size
            ? `Подходящих вариантов: ${suggestions.size}. `
            : ""}
          Добавление создаёт снимок; окончательный выбор всегда делает
          пользователь.
        </p>
        <div className="snapshot-list">
          {item[key].map((link) => (
            <div key={link.id}>
              <span>
                <strong>{link.title}</strong>
                <small>
                  Снимок {new Date(link.capturedAt).toLocaleString("ru-RU")}
                </small>
              </span>
              <button
                className="link-button danger"
                type="button"
                onClick={() => remove(key, link.id)}
              >
                Удалить
              </button>
            </div>
          ))}
        </div>
        <select
          aria-label={`Добавить ${title}`}
          defaultValue=""
          onChange={(event) => {
            const record = records.find(
              (candidate) => candidate.id === event.target.value,
            );
            if (record) addLink(key, snapshot(source, record));
            event.target.value = "";
          }}
        >
          <option value="">Выбрать и добавить снимок…</option>
          {available.map((record) => {
            const payload = record.payload as Partial<ContractData & StaffData>;
            const disclosureNote =
              source !== "calculator" && !payload.disclosureAllowed
                ? " · раскрытие не разрешено"
                : "";
            return (
              <option value={record.id} key={record.id}>
                {suggestions.has(record.id) ? "★ Подходит · " : ""}
                {record.title}
                {disclosureNote}
              </option>
            );
          })}
        </select>
      </section>
    );
  };
  return (
    <>
      {group(
        "Расчёты",
        "calculations",
        "calculator",
        calculations as StoredRecord<unknown>[],
      )}
      {group(
        "Опыт",
        "experience",
        "contract-experience",
        contracts as StoredRecord<unknown>[],
        experienceSuggestions,
      )}
      {group(
        "Команда",
        "team",
        "staff",
        staff as StoredRecord<unknown>[],
        teamSuggestions,
      )}
    </>
  );
}
