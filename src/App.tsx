import { useEffect, useRef, useState } from "react";
import "./App.css";
import { Dialog } from "./components/Dialog";
import { AdministrationNotice } from "./components/AdministrationNotice";
import { ToolIcon } from "./components/ToolIcon";
import { GlobalSearch } from "./modules/search/GlobalSearch";
import { StatusCenter } from "./modules/status/StatusCenter";
import { StatusIndicator } from "./modules/status/StatusIndicator";
import { Proposals, type ProposalHandoff } from "./modules/proposals/Proposals";
import type { ProposalData } from "./modules/proposals/types";
import { clearActivities } from "./lib/activity";
import { setViewStateWorkspace } from "./hooks/useViewState";
import { useAutomaticBackup } from "./hooks/useAutomaticBackup";
import { editorStatus, unavailableWorkspaceInfo } from "./lib/editorStatus";
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
  getStartupStatus,
  getWorkspaceInfo,
  quitApplication,
  reportStartupUiVisible,
  retryWorkspaceInitialization,
  setWorkspaceLocation,
  workspaceAccessInvalidatedEvent,
  type StartupStatus,
  type WorkspaceInfo,
} from "./lib/storage";
import {
  accessTimerEvent,
  readAccessTimers,
  type AccessTimers,
} from "./lib/sharedWorkspace";
import {
  ReadOnlyWorkspaceBoundary,
  WorkspaceAccessProvider,
} from "./lib/workspaceAccess";

type ToolId =
  | "dashboard"
  | "procurement"
  | "calculator"
  | "scanner"
  | "contracts"
  | "counterparties"
  | "staff"
  | "archive"
  | "proposals"
  | "status"
  | "settings"
  | "about";

const tools: Array<{ id: ToolId; label: string }> = [
  { id: "dashboard", label: "Главная" },
  { id: "procurement", label: "Закупки" },
  { id: "calculator", label: "Тендерный калькулятор" },
  { id: "proposals", label: "Коммерческие предложения" },
  { id: "scanner", label: "Сканирование документов" },
  { id: "contracts", label: "Опыт по договорам" },
  { id: "counterparties", label: "Контрагенты" },
  { id: "staff", label: "Кадры" },
];

const installedFastStart =
  import.meta.env.VITE_SBK_INSTALLED_FAST_START === "true";

const toolTitles: Record<ToolId, [string, string]> = {
  dashboard: ["Главная", "Сроки, риски и готовность рабочих данных"],
  procurement: [
    "Закупки",
    "Требования, расчёты, команда, документы и переторжка",
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
  proposals: ["Коммерческие предложения", "Состав, стоимость, условия и клиентские документы"],
  status: ["Центр состояния", "Рабочая папка, редактор, резервные копии и операции"],
  archive: ["Архив", "Восстановление и окончательное удаление записей"],
  settings: ["Настройки", "Рабочая папка, интерфейс и резервные копии"],
  about: ["О программе", "Версия, приватность и лицензии компонентов"],
};

const helpText: Record<ToolId, string> = {
  dashboard:
    "Главная показывает ближайшие сроки и риски из локальных реестров. Данные не отправляются в сеть.",
  procurement:
    "Карточка закупки хранит только явно добавленные снимки расчётов, опыта и команды. Исходные реестры автоматически не связываются.",
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
  proposals: "Создавайте предложение по шагам. Данные сторон и цены сохраняются снимком; изменения справочника не меняют готовое КП. Внутренние заметки не включаются в клиентский документ.",
  status: "Центр состояния только читает сведения. Он не перехватывает редактора и не снимает блокировки. Состояние сетевой папки проверяется отдельно от наличия резервной копии.",
  settings:
    "Резервная копия включает базы и вложения. Перед восстановлением приложение автоматически создаёт страховочную копию текущих данных.",
  about:
    "Все инструменты работают локально и не обмениваются бизнес-данными друг с другом.",
};

function App() {
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [startup, setStartup] = useState<StartupStatus>({
    stage: "Запускаем СБК Инструменты",
    stageIndex: 0,
    ready: false,
    failed: false,
    needsWorkspace: false,
  });
  const [workspaceError, setWorkspaceError] = useState("");
  const [workspaceReady, setWorkspaceReady] = useState("");
  const [accessTimers, setAccessTimers] =
    useState<AccessTimers>(readAccessTimers);
  useEffect(() => {
    if (installedFastStart) void reportStartupUiVisible();
  }, []);
  useEffect(() => {
    let stopped = false;
    let timer = 0;
    const refreshWorkspace = () => {
      window.clearTimeout(timer);
      if (!installedFastStart) {
        void getWorkspaceInfo()
          .then((value) => {
            if (!stopped) setWorkspace(value);
          })
          .catch((reason) => {
            if (!stopped) setWorkspaceError(String(reason));
          });
        return;
      }
      void getStartupStatus()
        .then(async (status) => {
          if (stopped) return;
          setStartup(status);
          if (status.ready) {
            const value = await getWorkspaceInfo();
            if (stopped) return;
            setWorkspace(value);
            setWorkspaceError("");
            return;
          }
          setWorkspace(null);
          if (!status.failed)
            timer = window.setTimeout(refreshWorkspace, 140);
        })
        .catch((reason) => {
          if (stopped) return;
          setWorkspaceError(String(reason));
          timer = window.setTimeout(refreshWorkspace, 500);
        });
    };
    refreshWorkspace();
    window.addEventListener("sbk-workspace-refresh", refreshWorkspace);
    window.addEventListener(workspaceAccessInvalidatedEvent, refreshWorkspace);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
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
    if (!workspace?.root) return;
    let stopped = false;
    let running = false;
    const refreshAccess = async () => {
      if (running) return;
      running = true;
      try {
        const next = await getWorkspaceInfo();
        if (!stopped) {
          setWorkspace(next);
        }
      } catch {
        if (!stopped) setWorkspace((current) => current ? unavailableWorkspaceInfo(current) : current);
      } finally {
        running = false;
      }
    };
    const timer = window.setInterval(() => void refreshAccess(), 3000);
    window.addEventListener("focus", refreshAccess);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshAccess);
    };
  }, [workspace?.root]);
  useEffect(() => {
    if (workspace) window.dispatchEvent(new CustomEvent("sbk-workspace-access-status", { detail: workspace }));
  }, [workspace]);
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
  useAutomaticBackup(workspace, setWorkspace);
  const chooseFirstWorkspace = async () => {
    const selected = await chooseDirectory(
      "Выберите рабочую папку СБК Инструменты",
    );
    if (!selected) return;
    try {
      const root = await setWorkspaceLocation(selected, installedFastStart);
      setWorkspaceError("");
      if (installedFastStart) {
        setStartup({
          stage: "Проверяем рабочую папку",
          stageIndex: 1,
          ready: false,
          failed: false,
          needsWorkspace: false,
        });
        window.dispatchEvent(new Event("sbk-workspace-refresh"));
      } else {
        setWorkspaceReady(root);
      }
    } catch (reason) {
      setWorkspaceError(String(reason));
    }
  };
  const retryStartup = async () => {
    setWorkspaceError("");
    try {
      setStartup(await retryWorkspaceInitialization());
      window.dispatchEvent(new Event("sbk-workspace-refresh"));
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
  const [scannerOpened, setScannerOpened] = useState(activeTool === "scanner");
  const [calculatorOpened, setCalculatorOpened] = useState(activeTool === "calculator");
  const [proposalsOpened, setProposalsOpened] = useState(activeTool === "proposals");
  const [proposalHandoff, setProposalHandoff] = useState<ProposalHandoff | undefined>();
  const [showHelp, setShowHelp] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [openRecord, setOpenRecord] = useState<{ tool: ToolId; id: string } | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => { setOpenRecord(null); setShowSearch(false); setProposalHandoff(undefined); clearActivities(); setViewStateWorkspace(workspace?.root || ""); }, [workspace?.root]);
  useEffect(() => {
    const openSearch = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k" && !document.querySelector('[role="dialog"]')) { event.preventDefault(); setShowSearch(true); }
    };
    window.addEventListener("keydown", openSearch);
    return () => window.removeEventListener("keydown", openSearch);
  }, []);
  useEffect(() => { contentRef.current?.scrollTo(0, 0); }, [activeTool]);
  const recordOpened = () => setOpenRecord(null);
  const selectTool = (tool: ToolId, recordId?: string) => {
    if (tool === "scanner") setScannerOpened(true);
    if (tool === "calculator") setCalculatorOpened(true);
    if (tool === "proposals") setProposalsOpened(true);
    setOpenRecord(recordId ? { tool, id: recordId } : null);
    setActiveTool(tool);
    localStorage.setItem("sbk-tools:last-tool", tool);
  };
  const updateCollapsed = (value: boolean) => {
    setCollapsed(value);
    localStorage.setItem("sbk-tools:sidebar-collapsed", String(value));
  };
  const [title, subtitle] = toolTitles[activeTool];
  const createProposal = (data: ProposalData) => { setProposalHandoff({id:crypto.randomUUID(),data}); selectTool("proposals"); };

  if (!installedFastStart && !workspace)
    return (
      <div className="startup-screen">
        <div className="startup-card">
          <div className="brand-mark large">СБК</div>
          <h1>Подготавливаем рабочее пространство</h1>
          <p>
            {workspaceError ||
              "Проверяем папку данных, доступ редактора и встроенные модули…"}
          </p>
          {!workspaceError && (
            <>
              <div className="startup-progress" aria-hidden="true">
                <span />
              </div>
              <div className="startup-steps">
                <span>Рабочая папка</span>
                <span>Базы</span>
                <span>Модули</span>
              </div>
            </>
          )}
        </div>
      </div>
    );
  if (installedFastStart && (!workspace || !startup.ready))
    return (
      <div className="startup-screen">
        <div className="startup-card">
          <div className="brand-mark large">СБК</div>
          <h1>
            {startup.needsWorkspace
              ? "Где будем работать?"
              : startup.failed || workspaceError
                ? "Не удалось завершить запуск"
                : "Запускаем СБК Инструменты"}
          </h1>
          {startup.needsWorkspace && (
            <p>
              Выберите постоянную папку для баз, документов и резервных копий.
              Существующие данные не перемещаются и не удаляются.
            </p>
          )}
          {(startup.failed || workspaceError) ? (
            <>
              <div className="notice error" role="alert">
                <strong>{startup.stage}</strong>
                <span>{workspaceError || startup.error}</span>
              </div>
              <div className="startup-actions">
                <button
                  className="primary"
                  type="button"
                  onClick={() => void retryStartup()}
                >
                  Повторить
                </button>
                <button
                  className="secondary"
                  type="button"
                  onClick={() => void chooseFirstWorkspace()}
                >
                  Выбрать другую папку
                </button>
                <button
                  className="secondary"
                  type="button"
                  onClick={() => void quitApplication()}
                >
                  Закрыть
                </button>
              </div>
            </>
          ) : (
            <>
              <p aria-live="polite">{startup.stage}</p>
              <div className="startup-progress" aria-hidden="true">
                <span />
              </div>
              <div
                className="startup-steps staged"
                aria-label="Этапы запуска"
              >
                {[
                  "Запускаем СБК Инструменты",
                  "Проверяем рабочую папку",
                  "Открываем базы данных",
                  "Готовим модули",
                  "Готово",
                ].map((step, index) => (
                  <span
                    className={index <= startup.stageIndex ? "active" : ""}
                    key={step}
                  >
                    {step}
                  </span>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    );
  if (!workspace)
    return (
      <div className="startup-screen">
        <div className="startup-card">
          <div className="brand-mark large">СБК</div>
          <h1>Запускаем СБК Инструменты</h1>
          <p>Ожидаем готовность рабочей папки…</p>
          <div className="startup-progress" aria-hidden="true">
            <span />
          </div>
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
  const access = editorStatus(workspace);
  const accessLabel = workspace.editor ? "Режим редактора" : access.unknown ? "Доступ не подтверждён" : "Режим просмотра";
  const workspaceName = workspace.root.split(/[\\/]/).filter(Boolean).slice(-2).join(" / ");
  return (
    <WorkspaceAccessProvider
      editor={workspace.editor}
      message={workspace.accessMessage}
    >
      <div className={`app-shell ${collapsed ? "sidebar-collapsed" : ""}`}>
        <a className="skip-link" href="#main-content">Перейти к рабочей области</a>
        <aside className="sidebar" aria-label="Инструменты">
          <div className="brand">
            <div className="brand-mark">СБК</div>
            <div className="brand-text">
              <strong>Инструменты</strong>
              <span>Рабочее пространство</span>
            </div>
          <button
            className="collapse-button"
            type="button"
            aria-label={
              collapsed ? "Развернуть навигацию" : "Свернуть навигацию"
            }
            title={collapsed ? "Развернуть навигацию" : "Свернуть навигацию"}
            aria-expanded={!collapsed}
            onClick={() => updateCollapsed(!collapsed)}
          >
            <ToolIcon name={collapsed ? "chevron-right" : "chevron-left"} />
          </button>
          </div>
          <p className="nav-caption">ИНСТРУМЕНТЫ</p>
          <nav className="tool-nav">
            {tools.map((tool) => (
              <button
                key={tool.id}
                aria-label={tool.label}
                aria-current={activeTool === tool.id ? "page" : undefined}
                title={tool.label}
                className={activeTool === tool.id ? "active" : ""}
                onClick={() => selectTool(tool.id)}
                type="button"
              >
                <span className="nav-icon" aria-hidden="true">
                  <ToolIcon name={tool.id} />
                </span>
                <span className="nav-label">{tool.label}</span>
              </button>
            ))}
          </nav>
          <nav className="settings-nav">
            <button aria-label="Центр состояния" aria-current={activeTool === "status" ? "page" : undefined} title="Центр состояния" className={activeTool === "status" ? "active" : ""} onClick={() => selectTool("status")} type="button"><span className="nav-icon" aria-hidden="true"><ToolIcon name="status" /></span><span className="nav-label">Центр состояния</span><StatusIndicator /></button>
            <button
              aria-label="Архив"
              aria-current={activeTool === "archive" ? "page" : undefined}
              title="Архив"
              className={activeTool === "archive" ? "active" : ""}
              onClick={() => selectTool("archive")}
              type="button"
            >
              <span className="nav-icon" aria-hidden="true">
                <ToolIcon name="archive" />
              </span>
              <span className="nav-label">Архив</span>
            </button>
            <button
              aria-label="Настройки"
              aria-current={activeTool === "settings" ? "page" : undefined}
              title="Настройки"
              className={activeTool === "settings" ? "active" : ""}
              onClick={() => selectTool("settings")}
              type="button"
            >
              <span className="nav-icon" aria-hidden="true">
                <ToolIcon name="settings" />
              </span>
              <span className="nav-label">Настройки</span>
            </button>
            <button
              aria-label="О программе"
              aria-current={activeTool === "about" ? "page" : undefined}
              title="О программе"
              className={activeTool === "about" ? "active" : ""}
              onClick={() => selectTool("about")}
              type="button"
            >
              <span className="nav-icon" aria-hidden="true">
                <ToolIcon name="about" />
              </span>
              <span className="nav-label">О программе</span>
            </button>
          </nav>
          <button className="sidebar-workspace" type="button" title={`Рабочая папка: ${workspace.root}`} aria-label="Открыть настройки рабочей папки" onClick={() => selectTool("settings")}>
            <span className={`workspace-dot ${workspace.editor ? "is-editor" : "is-viewer"}`} aria-hidden="true" />
            <span className="nav-label"><strong>{workspaceName}</strong><small>{accessLabel}</small></span>
            <ToolIcon name="folder" />
          </button>
        </aside>
        <main className="workspace">
          <header className="topbar">
            <div className="topbar-heading">
              <h1>{title}</h1>
              <p>{subtitle}</p>
            </div>
            <div className="topbar-actions">
            <button className="secondary global-search-button" type="button" aria-label="Глобальный поиск" title="Поиск по рабочей папке (Ctrl/⌘ K)" onClick={() => setShowSearch(true)}><ToolIcon name="search" /><span>Поиск</span></button>
            <button className={`workspace-access-chip ${workspace.editor ? "is-editor" : access.unknown ? "is-unknown" : "is-viewer"}`} type="button" onClick={() => selectTool("settings")} title={workspace.accessMessage} aria-label={`${accessLabel}. Открыть настройки доступа`}>
              <ToolIcon name={workspace.editor ? "check" : "lock"} />
              <span><strong>{accessLabel}</strong>{!workspace.editor && access.occupied && !access.unknown && <small>Редактор: {access.text}</small>}</span>
            </button>
            <button
              className="help-button"
              type="button"
              aria-label={`Открыть справку: ${title}`}
              title="Открыть справку"
              onClick={(event) => {
                event.currentTarget.focus();
                setShowHelp(true);
              }}
            >
              <ToolIcon name="about" />
            </button>
            </div>
          </header>
          <div ref={contentRef} id="main-content" tabIndex={-1} className={`tool-content ${["contracts", "staff", "counterparties", "procurement"].includes(activeTool) ? "registry-content" : ""}`}>
            <AdministrationNotice key={`notice-${workspace.root}`} message={workspace.administrationNotice} />
            {scannerOpened && <div hidden={activeTool !== "scanner"} key={`scanner-${workspace.root}`}>
              <ReadOnlyWorkspaceBoundary allowMutations>
                <Scanner active={activeTool === "scanner"} />
              </ReadOnlyWorkspaceBoundary>
            </div>}
            <ReadOnlyWorkspaceBoundary>
              {activeTool === "dashboard" && <div className="module-stack"><Dashboard onNavigate={selectTool} /><section className="dashboard-calendar" aria-label="Календарь тендеров"><h2>Календарь тендеров</h2><p className="help-text">Дважды щёлкните по дню, чтобы назначить закупку. С клавиатуры — Enter на выбранном дне.</p><TenderCalendar /></section></div>}
              {activeTool === "procurement" && <ProcurementRegistry onCreateProposal={createProposal} openRecordId={openRecord?.tool === "procurement" ? openRecord.id : undefined} onRecordOpened={recordOpened} />}
              {calculatorOpened && <div hidden={activeTool !== "calculator"} key={`calculator-${workspace.root}`}><Calculator onCreateProposal={createProposal} active={activeTool === "calculator"} openRecordId={openRecord?.tool === "calculator" ? openRecord.id : undefined} onRecordOpened={recordOpened} /></div>}
              {proposalsOpened && <div hidden={activeTool !== "proposals"} key={`proposals-${workspace.root}`}><Proposals active={activeTool === "proposals"} handoff={proposalHandoff} onHandoffConsumed={() => setProposalHandoff(undefined)} openRecordId={openRecord?.tool === "proposals" ? openRecord.id : undefined} onRecordOpened={recordOpened} /></div>}
              {activeTool === "contracts" && <ContractsRegistry openRecordId={openRecord?.tool === "contracts" ? openRecord.id : undefined} onRecordOpened={recordOpened} />}
              {activeTool === "counterparties" && <CounterpartiesRegistry openRecordId={openRecord?.tool === "counterparties" ? openRecord.id : undefined} onRecordOpened={recordOpened} />}
              {activeTool === "staff" && <StaffRegistry openRecordId={openRecord?.tool === "staff" ? openRecord.id : undefined} onRecordOpened={recordOpened} />}
              {activeTool === "archive" && <Archive />}
              {activeTool === "status" && <StatusCenter key={`status-${workspace.root}`} workspace={workspace} onSettings={() => selectTool("settings")} />}
              {activeTool === "settings" && (
                <Settings collapsed={collapsed} onCollapsed={updateCollapsed} workspace={workspace} onWorkspaceChange={setWorkspace} />
              )}
              {activeTool === "about" && <About />}
            </ReadOnlyWorkspaceBoundary>
          </div>
        </main>
        {showSearch && <GlobalSearch key={`search-${workspace.root}`} onClose={() => setShowSearch(false)} onNavigate={selectTool} />}
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
