import { useState } from "react";
import "./App.css";
import { Dialog } from "./components/Dialog";
import { Calculator } from "./modules/calculator/Calculator";
import { ContractsRegistry } from "./modules/contracts/Contracts";
import { Scanner } from "./modules/scanner/Scanner";
import { About, Settings } from "./modules/settings/Settings";
import { StaffRegistry } from "./modules/staff/Staff";

type ToolId = "calculator" | "scanner" | "contracts" | "staff" | "settings" | "about";

const tools: Array<{ id: ToolId; icon: string; label: string }> = [
  { id: "calculator", icon: "₽", label: "Тендерный калькулятор" },
  { id: "scanner", icon: "▤", label: "Сканирование документов" },
  { id: "contracts", icon: "✓", label: "Опыт по договорам" },
  { id: "staff", icon: "●", label: "Кадры" },
];

const toolTitles: Record<ToolId, [string, string]> = {
  calculator: ["Тендерный калькулятор", "Цена, дополнительные расходы, прибыль и сценарии"],
  scanner: ["Сканирование документов", "Выберите файл, пресет и сохраните новый PDF"],
  contracts: ["Опыт по договорам", "Самостоятельный реестр исполнения, оплат и актов"],
  staff: ["Кадры", "Люди, основания сотрудничества и подтверждающие документы"],
  settings: ["Настройки", "Рабочая папка, интерфейс и резервные копии"],
  about: ["О программе", "Версия, приватность и лицензии компонентов"],
};

const helpText: Record<ToolId, string> = {
  calculator: "Введите себестоимость и выберите режим расчёта. Дополнительные расходы можно задавать суммой или процентом от выбранной базы. Графики обновляются сразу.",
  scanner: "Обычный сценарий требует трёх действий: выбрать документ, выбрать пресет и сохранить новый PDF. Исходный файл не перезаписывается.",
  contracts: "Стадия исполнения, состояние оплаты и состояние актов — независимые поля. Двойной щелчок по строке открывает карточку.",
  staff: "Основание сотрудничества хранится отдельно от должности и статуса. Дипломы, сертификаты и договоры добавляются повторяемыми записями.",
  settings: "Резервная копия включает базы и вложения. Перед восстановлением приложение автоматически создаёт страховочную копию текущих данных.",
  about: "Все инструменты работают локально и не обмениваются бизнес-данными друг с другом.",
};

function App() {
  const [activeTool, setActiveTool] = useState<ToolId>(() => {
    const saved = localStorage.getItem("sbk-tools:last-tool") as ToolId | null;
    return saved && Object.prototype.hasOwnProperty.call(toolTitles, saved) ? saved : "calculator";
  });
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("sbk-tools:sidebar-collapsed") === "true");
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

  return <div className={`app-shell ${collapsed ? "sidebar-collapsed" : ""}`}>
    <aside className="sidebar" aria-label="Инструменты">
      <div className="brand"><div className="brand-mark">СБК</div><div className="brand-text"><strong>Инструменты</strong><span>Рабочее пространство</span></div></div>
      <button className="collapse-button" type="button" aria-label={collapsed ? "Развернуть навигацию" : "Свернуть навигацию"} onClick={() => updateCollapsed(!collapsed)}>{collapsed ? "›" : "‹"}</button>
      <p className="nav-caption">ИНСТРУМЕНТЫ</p>
      <nav className="tool-nav">{tools.map((tool) => <button key={tool.id} title={collapsed ? tool.label : undefined} className={activeTool === tool.id ? "active" : ""} onClick={() => selectTool(tool.id)} type="button"><span className="nav-icon" aria-hidden="true">{tool.icon}</span><span className="nav-label">{tool.label}</span></button>)}</nav>
      <nav className="settings-nav"><button title={collapsed ? "Настройки" : undefined} className={activeTool === "settings" ? "active" : ""} onClick={() => selectTool("settings")} type="button"><span className="nav-icon" aria-hidden="true">⚙</span><span className="nav-label">Настройки</span></button><button title={collapsed ? "О программе" : undefined} className={activeTool === "about" ? "active" : ""} onClick={() => selectTool("about")} type="button"><span className="nav-icon" aria-hidden="true">i</span><span className="nav-label">О программе</span></button></nav>
    </aside>
    <main className="workspace">
      <header className="topbar"><div><h1>{title}</h1><p>{subtitle}</p></div><button className="help-button" type="button" onClick={() => setShowHelp(true)}>?</button></header>
      <div className="tool-content">
        {activeTool === "calculator" && <Calculator />}
        {activeTool === "scanner" && <Scanner />}
        {activeTool === "contracts" && <ContractsRegistry />}
        {activeTool === "staff" && <StaffRegistry />}
        {activeTool === "settings" && <Settings collapsed={collapsed} onCollapsed={updateCollapsed} />}
        {activeTool === "about" && <About />}
      </div>
    </main>
    {showHelp && <Dialog title={`Справка: ${title}`} onClose={() => setShowHelp(false)} width="560px"><div className="dialog-body"><p>{helpText[activeTool]}</p><p className="help-text">Данные текущего инструмента не передаются в другие разделы.</p></div><footer className="dialog-actions"><button className="primary" type="button" onClick={() => setShowHelp(false)}>Понятно</button></footer></Dialog>}
  </div>;
}

export default App;
