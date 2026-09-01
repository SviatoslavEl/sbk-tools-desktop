import { useEffect, useState } from "react";
import "./App.css";
import { Dialog } from "./components/Dialog";
import { Archive } from "./modules/archive/Archive";
import { Calculator } from "./modules/calculator/Calculator";
import { ContractsRegistry } from "./modules/contracts/Contracts";
import { CounterpartiesRegistry } from "./modules/contracts/Counterparties";
import { Scanner } from "./modules/scanner/Scanner";
import { About, Settings } from "./modules/settings/Settings";
import { StaffRegistry } from "./modules/staff/Staff";
import { Dashboard } from "./modules/dashboard/Dashboard";
import { ProcurementRegistry } from "./modules/procurement/Procurement";
import { TenderCalendar } from "./modules/tender-calendar/TenderCalendar";
import { chooseDirectory } from "./lib/files";
import {
  createBackup,
  getWorkspaceInfo,
  quitApplication,
  rotateBackups,
  setWorkspaceLocation,
  workspaceAccessInvalidatedEvent,
  type WorkspaceInfo,
} from "./lib/storage";
import {
  accessTimerEvent,
  AutomaticBackupGate,
  lastAutomaticBackupAttemptKey,
  lastAutomaticBackupKey,
  readAccessTimers,
  workspaceLocalKey,
  type AccessTimers,
} from "./lib/sharedWorkspace";
import {
  ReadOnlyWorkspaceBoundary,
  WorkspaceAccessProvider,
} from "./lib/workspaceAccess";

type ToolId =
  | "dashboard"
  | "procurement"
  | "tender-calendar"
  | "calculator"
  | "scanner"
  | "contracts"
  | "counterparties"
  | "staff"
  | "archive"
  | "settings"
  | "about";

const tools: Array<{ id: ToolId; icon: string; label: string }> = [
  { id: "dashboard", icon: "▦", label: "Главная" },
  { id: "procurement", icon: "◆", label: "Закупки" },
  { id: "tender-calendar", icon: "▣", label: "Календарь тендеров" },
  { id: "calculator", icon: "₽", label: "Тендерный калькулятор" },
  { id: "scanner", icon: "▤", label: "Сканирование документов" },
  { id: "contracts", icon: "✓", label: "Опыт по договорам" },
  { id: "counterparties", icon: "⌕", label: "Контрагенты" },
  { id: "staff", icon: "●", label: "Кадры" },
];

const toolTitles: Record<ToolId, [string, string]> = {
  dashboard: ["Главная", "Сроки, риски и готовность рабочих данных"],
  procurement: [
    "Закупки",
    "Требования, расчёты, команда, документы и переторжка",
  ],
  "tender-calendar": [
    "Календарь тендеров",
    "Распределение заявок, контроль сроков и загрузка специалистов",
  ],
  calculator: [
    "Тендерный калькулятор",
    "Цена, дополнительные расходы, прибыль и сценарии",
  ],
  scanner: [
    "Сканирование документов",
    "Выберите файл, пресет и сохраните новый PDF",
  ],
  contracts: [
    "Опыт по договорам",
    "Самостоятельный реестр исполнения, оплат и актов",
  ],
  counterparties: [
    "Контрагенты",
    "Быстрый поиск компаний и лиц, принимающих решения",
  ],
  staff: ["Кадры", "Люди, основания сотрудничества и подтверждающие документы"],
  archive: ["Архив", "Восстановление и окончательное удаление записей"],
  settings: ["Настройки", "Рабочая папка, интерфейс и резервные копии"],
  about: ["О программе", "Версия, приватность и лицензии компонентов"],
};

const helpText: Record<ToolId, string> = {
  dashboard:
    "Главная показывает ближайшие сроки и риски из локальных реестров. Данные не отправляются в сеть.",
  procurement:
    "Карточка закупки хранит только явно добавленные снимки расчётов, опыта и команды. Исходные реестры автоматически не связываются.",
  "tender-calendar":
    "Руководитель группы распределяет подготовку заявок между менеджерами и специалистами. Рекомендации учитывают сложность, навыки, опыт, доступность и уже назначенную загрузку.",
  calculator:
    "Введите себестоимость и выберите режим расчёта. Дополнительные расходы можно задавать суммой или процентом от выбранной базы. Графики обновляются сразу.",
  scanner:
    "Обычный сценарий требует трёх действий: выбрать документ, выбрать пресет и сохранить новый PDF. Исходный файл не перезаписывается.",
  contracts:
    "Стадия исполнения, состояние оплаты и состояние актов — независимые поля. Двойной щелчок по строке открывает карточку.",
  counterparties:
    "Отдельный справочник внутренних компаний и внешних контрагентов. Поиск работает по реквизитам, контактам, ФИО и должностям лиц, принимающих решения.",
  staff:
    "Основание сотрудничества хранится отдельно от должности и статуса. Дипломы, сертификаты и договоры добавляются повторяемыми записями.",
  archive:
    "Архивные расчёты, договоры и кадровые карточки можно восстановить. Окончательное удаление также удаляет историю и связанные файлы.",
  settings:
    "Резервная копия включает базы и вложения. Перед восстановлением приложение автоматически создаёт страховочную копию текущих данных.",
  about:
    "Все инструменты работают локально и не обмениваются бизнес-данными друг с другом.",
};

function App() {
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [startupDelayElapsed, setStartupDelayElapsed] = useState(false);
  const [workspaceError, setWorkspaceError] = useState("");
  const [workspaceReady, setWorkspaceReady] = useState("");
  const [accessTimers, setAccessTimers] =
    useState<AccessTimers>(readAccessTimers);
  useEffect(() => {
    const timer = window.setTimeout(() => setStartupDelayElapsed(true), 3500);
    return () => window.clearTimeout(timer);
  }, []);
  useEffect(() => {
    let generation = 0;
    const refreshWorkspace = () => {
      const current = ++generation;
      void getWorkspaceInfo()
        .then((value) => {
          if (current === generation) setWorkspace(value);
        })
        .catch((reason) => {
          if (current === generation) setWorkspaceError(String(reason));
        });
    };
    refreshWorkspace();
    window.addEventListener("sbk-workspace-refresh", refreshWorkspace);
    window.addEventListener(workspaceAccessInvalidatedEvent, refreshWorkspace);
    return () => {
      generation += 1;
      window.removeEventListener("sbk-workspace-refresh", refreshWorkspace);
      window.removeEventListener(
        workspaceAccessInvalidatedEvent,
        refreshWorkspace,
      );
    };
  }, []);
  useEffect(() => {
    if (workspace?.root) setAccessTimers(readAccessTimers(workspace.root));
  }, [workspace?.root]);
  useEffect(() => {
    const update = (event: Event) =>
      setAccessTimers(
        (event as CustomEvent<AccessTimers>).detail || readAccessTimers(),
      );
    window.addEventListener(accessTimerEvent, update);
    return () => window.removeEventListener(accessTimerEvent, update);
  }, []);
  useEffect(() => {
    if (accessTimers.refreshSeconds <= 0) return;
    const timer = window.setInterval(
      () => window.dispatchEvent(new Event("sbk-workspace-refresh")),
      accessTimers.refreshSeconds * 1000,
    );
    return () => window.clearInterval(timer);
  }, [accessTimers.refreshSeconds]);
  useEffect(() => {
    if (!workspace?.editor || accessTimers.backupHours <= 0) return;
    const gate = new AutomaticBackupGate();
    const runIfDue = async () => {
      let currentWorkspace: WorkspaceInfo;
      try {
        currentWorkspace = await getWorkspaceInfo();
      } catch (reason) {
        console.warn("Workspace access check before backup failed", reason);
        return;
      }
      setWorkspace(currentWorkspace);
      if (!currentWorkspace.editor) return;
      const lastKey = workspaceLocalKey(lastAutomaticBackupKey, workspace.root);
      const attemptKey = workspaceLocalKey(
        lastAutomaticBackupAttemptKey,
        workspace.root,
      );
      const last = Number(localStorage.getItem(lastKey) || "0");
      const lastAttempt = Number(localStorage.getItem(attemptKey) || "0");
      const startedAt = Date.now();
      if (
        !gate.beginIfDue(last, lastAttempt, startedAt, accessTimers.backupHours)
      )
        return;
      localStorage.setItem(attemptKey, String(startedAt));
      try {
        await createBackup();
        await rotateBackups(
          accessTimers.retentionCount,
          accessTimers.retentionDays,
        );
        localStorage.setItem(lastKey, String(Date.now()));
      } catch (reason) {
        console.warn("Automatic workspace backup failed", reason);
      } finally {
        gate.finish();
      }
    };
    void runIfDue();
    const timer = window.setInterval(() => void runIfDue(), 60_000);
    return () => window.clearInterval(timer);
  }, [
    workspace?.editor,
    workspace?.root,
    accessTimers.backupHours,
    accessTimers.retentionCount,
    accessTimers.retentionDays,
  ]);
  const chooseFirstWorkspace = async () => {
    const selected = await chooseDirectory(
      "Выберите рабочую папку СБК Инструменты",
    );
    if (!selected) return;
    try {
      const root = await setWorkspaceLocation(selected);
      setWorkspaceReady(root);
      setWorkspaceError("");
    } catch (reason) {
      setWorkspaceError(String(reason));
    }
  };
  const [activeTool, setActiveTool] = useState<ToolId>(() => {
    const saved = localStorage.getItem("sbk-tools:last-tool") as ToolId | null;
    return saved && Object.prototype.hasOwnProperty.call(toolTitles, saved)
      ? saved
      : "dashboard";
  });
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem("sbk-tools:sidebar-collapsed") === "true",
  );
  const [showHelp, setShowHelp] = useState(false);
  const selectTool = (tool: ToolId) => {
    setActiveTool(tool);
    localStorage.setItem("sbk-tools:last-tool", tool);
  };
  const updateCollapsed = (value: boolean) => {
    setCollapsed(value);
    localStorage.setItem("sbk-tools:sidebar-collapsed", String(value));
  };
  const [title, subtitle] = toolTitles[activeTool];

  if (!workspace || !startupDelayElapsed)
    return (
      <div className="startup-screen">
        <div className="startup-card">
          <div className="brand-mark large">СБК</div>
          <h1>Подготавливаем рабочее пространство</h1>
          <p>{workspaceError || "Проверяем папку данных, доступ редактора и встроенные модули…"}</p>
          {!workspaceError && <><div className="startup-progress" aria-hidden="true"><span /></div><div className="startup-steps"><span>Рабочая папка</span><span>Базы</span><span>Модули</span></div></>}
        </div>
      </div>
    );
  if (!workspace.configured)
    return (
      <div className="startup-screen">
        <div className="startup-card">
          <div className="brand-mark large">СБК</div>
          <h1>Где будем работать?</h1>
          <p>
            Выберите постоянную папку. В ней появится каталог{" "}
            <strong>ProductData</strong> с отдельными базами договоров, кадров и
            календаря, а также папками вложений и экспорта.
          </p>
          {workspace.warning && (
            <div className="notice warning">
              <strong>Рабочая папка недоступна</strong>
              <span>{workspace.warning}</span>
            </div>
          )}
          {workspaceError && (
            <div className="notice error">{workspaceError}</div>
          )}
          {workspaceReady ? (
            <>
              <div className="notice success">
                <strong>Рабочая папка создана</strong>
                <span>{workspaceReady}</span>
              </div>
              <p>
                Чтобы открыть новые базы, приложение сейчас закроется. Запустите
                его ещё раз.
              </p>
              <button
                className="primary"
                type="button"
                onClick={() => void quitApplication()}
              >
                Закрыть приложение
              </button>
            </>
          ) : (
            <>
              <button
                className="primary"
                type="button"
                onClick={() => void chooseFirstWorkspace()}
              >
                Выбрать папку
              </button>
              <p className="help-text">
                Папку можно разместить в Документах, общей рабочей папке или на
                USB-накопителе. Права администратора не нужны.
              </p>
            </>
          )}
        </div>
      </div>
    );
  return (
    <WorkspaceAccessProvider
      editor={workspace.editor}
      message={workspace.accessMessage}
    >
      <div className={`app-shell ${collapsed ? "sidebar-collapsed" : ""}`}>
        <aside className="sidebar" aria-label="Инструменты">
          <div className="brand">
            <div className="brand-mark">СБК</div>
            <div className="brand-text">
              <strong>Инструменты</strong>
              <span>Рабочее пространство</span>
            </div>
          </div>
          <button
            className="collapse-button"
            type="button"
            aria-label={
              collapsed ? "Развернуть навигацию" : "Свернуть навигацию"
            }
            onClick={() => updateCollapsed(!collapsed)}
          >
            {collapsed ? "›" : "‹"}
          </button>
          <p className="nav-caption">ИНСТРУМЕНТЫ</p>
          <nav className="tool-nav">
            {tools.map((tool) => (
              <button
                key={tool.id}
                aria-label={tool.label}
                title={tool.label}
                className={activeTool === tool.id ? "active" : ""}
                onClick={() => selectTool(tool.id)}
                type="button"
              >
                <span className="nav-icon" aria-hidden="true">
                  {tool.icon}
                </span>
                <span className="nav-label">{tool.label}</span>
              </button>
            ))}
          </nav>
          <nav className="settings-nav">
            <button
              aria-label="Архив"
              title="Архив"
              className={activeTool === "archive" ? "active" : ""}
              onClick={() => selectTool("archive")}
              type="button"
            >
              <span className="nav-icon" aria-hidden="true">
                ⌫
              </span>
              <span className="nav-label">Архив</span>
            </button>
            <button
              aria-label="Настройки"
              title="Настройки"
              className={activeTool === "settings" ? "active" : ""}
              onClick={() => selectTool("settings")}
              type="button"
            >
              <span className="nav-icon" aria-hidden="true">
                ⚙
              </span>
              <span className="nav-label">Настройки</span>
            </button>
            <button
              aria-label="О программе"
              title="О программе"
              className={activeTool === "about" ? "active" : ""}
              onClick={() => selectTool("about")}
              type="button"
            >
              <span className="nav-icon" aria-hidden="true">
                i
              </span>
              <span className="nav-label">О программе</span>
            </button>
          </nav>
        </aside>
        <main className="workspace">
          <header className="topbar">
            <div>
              <h1>{title}</h1>
              <p>{subtitle}</p>
            </div>
            {!workspace.editor && (
              <span className="status neutral" title={workspace.accessMessage}>
                {workspace.editorOwner ? `Редактор: ${workspace.editorOwner.displayName}` : "Только просмотр и экспорт"}
              </span>
            )}
            <button
              className="help-button"
              type="button"
              onClick={() => setShowHelp(true)}
            >
              ?
            </button>
          </header>
          <div className="tool-content">
            <ReadOnlyWorkspaceBoundary
              allowMutations={activeTool === "scanner"}
              disableFormControls={activeTool === "calculator"}
            >
              {activeTool === "dashboard" && <Dashboard />}
              {activeTool === "procurement" && <ProcurementRegistry />}
              {activeTool === "tender-calendar" && <TenderCalendar />}
              {activeTool === "calculator" && <Calculator />}
              {activeTool === "scanner" && <Scanner />}
              {activeTool === "contracts" && <ContractsRegistry />}
              {activeTool === "counterparties" && <CounterpartiesRegistry />}
              {activeTool === "staff" && <StaffRegistry />}
              {activeTool === "archive" && <Archive />}
              {activeTool === "settings" && (
                <Settings collapsed={collapsed} onCollapsed={updateCollapsed} />
              )}
              {activeTool === "about" && <About />}
            </ReadOnlyWorkspaceBoundary>
          </div>
        </main>
        {showHelp && (
          <Dialog
            title={`Справка: ${title}`}
            onClose={() => setShowHelp(false)}
            width="560px"
          >
            <div className="dialog-body">
              <p>{helpText[activeTool]}</p>
              <p className="help-text">
                Данные текущего инструмента не передаются в другие разделы.
              </p>
            </div>
            <footer className="dialog-actions">
              <button
                className="primary"
                type="button"
                onClick={() => setShowHelp(false)}
              >
                Понятно
              </button>
            </footer>
          </Dialog>
        )}
      </div>
    </WorkspaceAccessProvider>
  );
}

export default App;
