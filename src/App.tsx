import { useMemo, useRef, useState } from "react";
import type { PointerEvent, ReactNode } from "react";
import "./App.css";

type ToolId = "calculator" | "scanner" | "contracts" | "staff" | "settings";
type Expense = { id: number; name: string; amount: number; enabled: boolean };

const tools: Array<{ id: ToolId; icon: string; label: string }> = [
  { id: "calculator", icon: "₽", label: "Калькулятор" },
  { id: "scanner", icon: "▤", label: "Сканирование" },
  { id: "contracts", icon: "✓", label: "Опыт по договорам" },
  { id: "staff", icon: "●", label: "Кадры" },
];

const toolTitles: Record<ToolId, [string, string]> = {
  calculator: ["Тендерный калькулятор", "Цена, расходы, прибыль и сценарии"],
  scanner: ["Сканирование документов", "Пресеты, OCR и размещение факсимиле"],
  contracts: ["Опыт по договорам", "Стадии исполнения, оплаты и акты"],
  staff: ["Кадры", "Люди, документы и основание сотрудничества"],
  settings: ["Настройки", "Рабочая папка и резервное копирование"],
};

const formatMoney = (value: number) =>
  new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(value) + " ₽";

function App() {
  const [activeTool, setActiveTool] = useState<ToolId>(() =>
    (localStorage.getItem("sbk-tools:last-tool") as ToolId) || "calculator",
  );
  const selectTool = (tool: ToolId) => {
    setActiveTool(tool);
    localStorage.setItem("sbk-tools:last-tool", tool);
  };
  const [title, subtitle] = toolTitles[activeTool];

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Инструменты">
        <div className="brand"><div className="brand-mark">СБК</div><div><strong>Инструменты</strong><span>Рабочее пространство</span></div></div>
        <p className="nav-caption">ИНСТРУМЕНТЫ</p>
        <nav className="tool-nav">
          {tools.map((tool) => <button key={tool.id} className={activeTool === tool.id ? "active" : ""} onClick={() => selectTool(tool.id)} type="button"><span className="nav-icon" aria-hidden="true">{tool.icon}</span>{tool.label}</button>)}
        </nav>
        <nav className="settings-nav"><button className={activeTool === "settings" ? "active" : ""} onClick={() => selectTool("settings")} type="button"><span className="nav-icon" aria-hidden="true">⚙</span>Настройки</button></nav>
      </aside>
      <main className="workspace">
        <header className="topbar"><div><h1>{title}</h1><p>{subtitle}</p></div><span className="saved-status">✓ Изменения сохранены</span></header>
        <div className="tool-content">
          {activeTool === "calculator" && <Calculator />}
          {activeTool === "scanner" && <Scanner />}
          {activeTool === "contracts" && <ContractsRegistry />}
          {activeTool === "staff" && <StaffRegistry />}
          {activeTool === "settings" && <Settings />}
        </div>
      </main>
    </div>
  );
}

function Calculator() {
  const [cost, setCost] = useState(1_000_000);
  const [margin, setMargin] = useState(20);
  const [vat, setVat] = useState(22);
  const [expenses, setExpenses] = useState<Expense[]>([
    { id: 1, name: "Банковская гарантия", amount: 45_000, enabled: true },
    { id: 2, name: "Логистика", amount: 30_000, enabled: true },
  ]);
  const expenseTotal = expenses.reduce((sum, item) => sum + (item.enabled ? item.amount : 0), 0);
  const base = cost + expenseTotal;
  const priceWithoutVat = margin >= 100 ? base : base / (1 - margin / 100);
  const priceWithVat = priceWithoutVat * (1 + vat / 100);
  const profit = priceWithoutVat - base;
  const updateExpense = (id: number, field: keyof Expense, value: string | number | boolean) => setExpenses((current) => current.map((item) => item.id === id ? { ...item, [field]: value } : item));

  return <div className="calculator-layout">
    <section className="input-column">
      <div className="surface"><div className="surface-title"><h2>Исходные данные</h2></div><div className="surface-body form-grid">
        <label>Себестоимость<input type="number" value={cost} min="0" onChange={(e) => setCost(Number(e.target.value))} /></label>
        <label>Целевая маржа<input type="number" value={margin} min="0" max="95" onChange={(e) => setMargin(Number(e.target.value))} /></label>
        <label>НДС<select value={vat} onChange={(e) => setVat(Number(e.target.value))}><option value="0">Без НДС</option><option value="5">5%</option><option value="7">7%</option><option value="22">22%</option></select></label>
      </div></div>
      <div className="surface"><div className="surface-title"><h2>Дополнительные расходы</h2><button className="secondary" type="button" onClick={() => setExpenses((items) => [...items, { id: Date.now(), name: "Новый расход", amount: 0, enabled: true }])}>+ Добавить</button></div><div className="surface-body expense-list">
        {expenses.map((expense) => <div className="expense-row" key={expense.id}>
          <input aria-label="Учитывать расход" type="checkbox" checked={expense.enabled} onChange={(e) => updateExpense(expense.id, "enabled", e.target.checked)} />
          <input aria-label="Название расхода" value={expense.name} onChange={(e) => updateExpense(expense.id, "name", e.target.value)} />
          <input aria-label="Сумма расхода" className="money-input" type="number" min="0" value={expense.amount} onChange={(e) => updateExpense(expense.id, "amount", Number(e.target.value))} />
          <button className="icon-button danger" aria-label={`Удалить ${expense.name}`} type="button" onClick={() => setExpenses((items) => items.filter((item) => item.id !== expense.id))}>×</button>
        </div>)}
        <div className="total-row"><span>Всего дополнительных расходов</span><strong>{formatMoney(expenseTotal)}</strong></div>
      </div></div>
    </section>
    <section className="result-column">
      <div className="surface result-panel"><div className="surface-title"><h2>Результат</h2><span className="status success">Расчёт корректен</span></div><div className="surface-body">
        <span className="eyebrow">Цена для заказчика с НДС</span><strong className="hero-number">{formatMoney(priceWithVat)}</strong>
        <div className="metric-grid"><div><span>Прибыль</span><strong>{formatMoney(profit)}</strong></div><div><span>Маржа</span><strong>{margin.toFixed(1)}%</strong></div><div><span>Без НДС</span><strong>{formatMoney(priceWithoutVat)}</strong></div><div><span>Расходы</span><strong>{formatMoney(expenseTotal)}</strong></div></div>
        <button className="primary full-width" type="button">Сохранить расчёт</button>
      </div></div>
      <CalculatorCharts cost={cost} expenses={expenseTotal} profit={profit} price={priceWithoutVat} />
    </section>
  </div>;
}

function CalculatorCharts({ cost, expenses, profit, price }: { cost: number; expenses: number; profit: number; price: number }) {
  const safePrice = Math.max(price, 1);
  return <div className="surface chart-panel"><div className="surface-title"><h2>Структура цены</h2></div><div className="surface-body">
    <div className="stacked-bar" aria-label="Структура цены"><span className="cost" style={{ width: `${(cost / safePrice) * 100}%` }} /><span className="expense" style={{ width: `${(expenses / safePrice) * 100}%` }} /><span className="profit" style={{ width: `${(profit / safePrice) * 100}%` }} /></div>
    <div className="chart-legend"><span><i className="cost-dot" />Себестоимость</span><span><i className="expense-dot" />Расходы</span><span><i className="profit-dot" />Прибыль</span></div>
    <svg className="line-chart" viewBox="0 0 520 180" role="img" aria-label="Зависимость маржи от цены"><title>Зависимость маржи от цены предложения</title><line x1="42" y1="145" x2="500" y2="145" /><line x1="42" y1="20" x2="42" y2="145" /><polyline points="42,134 135,119 228,96 321,70 414,45 500,27" /><circle cx="321" cy="70" r="6" /><text x="334" y="65">текущий сценарий</text><text x="42" y="168">ниже цена</text><text x="438" y="168">выше цена</text></svg>
  </div></div>;
}

const scannerPresets = ["Офисный", "Чёткий ч/б", "Мягкий", "Цветной", "Архивный", "Контрастный"];

function Scanner() {
  const [preset, setPreset] = useState("Офисный");
  const [documentName, setDocumentName] = useState("Коммерческое предложение.pdf");
  const [facsimileUrl, setFacsimileUrl] = useState<string | null>(null);
  const [position, setPosition] = useState({ x: 52, y: 68 });
  const dragging = useRef(false);
  const moveFacsimile = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    setPosition({ x: Math.max(5, Math.min(80, ((event.clientX - bounds.left) / bounds.width) * 100)), y: Math.max(8, Math.min(85, ((event.clientY - bounds.top) / bounds.height) * 100)) });
  };
  return <div className="scanner-layout">
    <section className="surface scanner-controls"><div className="surface-title"><h2>Настройки</h2></div><div className="surface-body">
      <label className="file-picker">Выбрать PDF или DOCX<input type="file" accept=".pdf,.docx" onChange={(e) => setDocumentName(e.target.files?.[0]?.name || documentName)} /></label><p className="selected-file">{documentName}</p>
      <h3>Готовый стиль</h3><div className="preset-grid">{scannerPresets.map((name) => <button key={name} className={preset === name ? "selected" : ""} type="button" onClick={() => setPreset(name)}>{name}</button>)}</div>
      <details><summary>Точная настройка</summary><label>Интенсивность эффекта<input type="range" min="0" max="100" defaultValue="55" /></label></details>
      <div className="control-divider" /><h3>Факсимиле</h3><label className="secondary file-button">Загрузить изображение<input type="file" accept="image/png,image/jpeg" onChange={(e) => { const file = e.target.files?.[0]; if (file) setFacsimileUrl(URL.createObjectURL(file)); }} /></label><label className="checkbox-row"><input type="checkbox" defaultChecked /> Поисковый OCR</label>
    </div></section>
    <section className="surface preview-panel"><div className="surface-title"><h2>Предпросмотр</h2><span>Страница 1 из 8 · {preset}</span></div><div className="document-stage"><div className="document-page" onPointerMove={moveFacsimile} onPointerUp={() => { dragging.current = false; }}>
      <div className="fake-heading" /><div className="fake-line short" /><div className="fake-line" /><div className="fake-line" /><div className="fake-line short" /><div className="fake-gap" /><div className="fake-line" /><div className="fake-line" /><div className="fake-line short" />
      <div className="facsimile" style={{ left: `${position.x}%`, top: `${position.y}%` }} onPointerDown={(event) => { dragging.current = true; event.currentTarget.setPointerCapture(event.pointerId); }}>{facsimileUrl ? <img src={facsimileUrl} alt="Факсимиле" /> : <span>И. И. Иванов</span>}</div>
    </div></div><div className="actionbar"><span>Перетащите факсимиле в нужное место</span><button className="primary" type="button">Сохранить PDF</button></div></section>
  </div>;
}

const contractRows = [["№ 18/24", "АО «Энергосеть»", "Модернизация инфраструктуры", "Исполнен", "Оплачен", "3 из 3"], ["№ 77-К", "ООО «Технопарк»", "Поставка оборудования", "Приёмка", "70% оплачено", "1 из 2"], ["№ 03-115", "ГУП «Регион»", "Техническое обслуживание", "Исполнение", "Просрочено", "Нет"]];
const staffRows = [["Анна Крылова", "Руководитель проекта", "В штате", "4", "1", "Трудовой"], ["Михаил Серов", "Главный инженер", "ГПХ", "6", "1", "ГПХ до 31.12"], ["Елена Власова", "Специалист ОТ", "Партнёр", "3", "2", "Соглашение"]];

function ContractsRegistry() {
  const [search, setSearch] = useState(""); const rows = contractRows.filter((row) => row.join(" ").toLowerCase().includes(search.toLowerCase()));
  return <RegistryLayout stats={[["Всего договоров", "48"], ["В исполнении", "9"], ["Ожидают оплаты", "4"]]} search={search} onSearch={setSearch} primaryAction="Добавить договор"><table><thead><tr><th>Договор</th><th>Заказчик</th><th>Предмет</th><th>Стадия</th><th>Оплата</th><th>Акты</th></tr></thead><tbody>{rows.map((row) => <tr key={row[0]}>{row.map((cell, index) => <td key={cell}>{index >= 3 ? <span className="status neutral">{cell}</span> : cell}</td>)}</tr>)}</tbody></table></RegistryLayout>;
}

function StaffRegistry() {
  const [search, setSearch] = useState(""); const rows = staffRows.filter((row) => row.join(" ").toLowerCase().includes(search.toLowerCase()));
  return <RegistryLayout stats={[["Людей в реестре", "64"], ["Документов", "139"], ["Скоро истекают", "7"]]} search={search} onSearch={setSearch} primaryAction="Добавить человека"><table><thead><tr><th>Человек</th><th>Роль</th><th>Основание</th><th>Сертификаты</th><th>Дипломы</th><th>Договоры</th></tr></thead><tbody>{rows.map((row) => <tr key={row[0]}>{row.map((cell, index) => <td key={cell}>{index === 2 ? <span className="status neutral">{cell}</span> : cell}</td>)}</tr>)}</tbody></table></RegistryLayout>;
}

function RegistryLayout({ stats, search, onSearch, primaryAction, children }: { stats: string[][]; search: string; onSearch: (value: string) => void; primaryAction: string; children: ReactNode }) {
  return <><div className="stats-row">{stats.map(([label, value]) => <div className="stat" key={label}><span>{label}</span><strong>{value}</strong></div>)}</div><div className="registry-toolbar"><input aria-label="Поиск" placeholder="Поиск по реестру" value={search} onChange={(e) => onSearch(e.target.value)} /><button className="secondary" type="button">Фильтры</button><button className="secondary" type="button">Импорт / экспорт</button><button className="primary" type="button">{primaryAction}</button></div><div className="surface table-surface"><div className="table-scroll">{children}</div></div></>;
}

function Settings() {
  const settings = useMemo(() => [["Режим хранения", "Portable workspace"], ["Рабочая папка", "ProductData"], ["Тема", "Светло-зелёная"], ["Резервная копия", "Вручную"]], []);
  return <div className="settings-grid"><section className="surface"><div className="surface-title"><h2>Приложение</h2></div><div className="surface-body">{settings.map(([label, value]) => <div className="settings-row" key={label}><span>{label}</span><strong>{value}</strong></div>)}</div></section><section className="surface"><div className="surface-title"><h2>Данные</h2></div><div className="surface-body settings-actions"><button className="secondary" type="button">Выбрать рабочую папку</button><button className="secondary" type="button">Создать резервную копию</button><button className="secondary" type="button">Восстановить из копии</button></div></section></div>;
}

export default App;
