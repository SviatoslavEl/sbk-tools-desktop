import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { useRecords } from "../../hooks/useRecords";
import { exportText, importText } from "../../lib/files";
import { clearDraft, readDraft, saveDraft } from "../../lib/storage";
import { calculate, priceScenarios, recommendPrice, toGross, toNet } from "./engine";
import {
  initialCalculatorData,
  newExpense,
  type CalculatorData,
  type Competitor,
  type Expense,
  type Subcontractor,
  type VatRate,
} from "./types";

const money = (value: number) => new Intl.NumberFormat("ru-RU", {
  maximumFractionDigits: 0,
}).format(Number.isFinite(value) ? value : 0) + " ₽";

const percent = (value: number) => `${value.toFixed(1)}%`;
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

function NumberField({ value, onChange, min, max, suffix }: {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  suffix?: string;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const parsed = Number(text.replace(/ /g, "").replace(",", "."));
  const invalid = !Number.isFinite(parsed) || (min != null && parsed < min) || (max != null && parsed > max);
  return <div className="number-field">
    <input
      type="text"
      inputMode="decimal"
      value={text}
      aria-invalid={invalid}
      onChange={(event) => {
        const next = event.target.value;
        setText(next);
        const numeric = Number(next.replace(/ /g, "").replace(",", "."));
        if (Number.isFinite(numeric) && (min == null || numeric >= min) && (max == null || numeric <= max)) onChange(numeric);
      }}
    />
    {suffix && <span>{suffix}</span>}
    {invalid && <small className="field-error">Проверьте число{min != null || max != null ? ` (${min ?? "−∞"}…${max ?? "∞"})` : ""}</small>}
  </div>;
}

export function Calculator() {
  const saved = useRecords<CalculatorData>("calculator");
  const [data, setData] = useState<CalculatorData>(() => readDraft<CalculatorData>("calculator") || clone(initialCalculatorData));
  const [recordId, setRecordId] = useState<string | undefined>();
  const [savedStatus, setSavedStatus] = useState("Черновик восстановлен");
  const [activeChart, setActiveChart] = useState<"structure" | "scenario" | "competitors">("structure");
  const result = useMemo(() => calculate(data), [data]);
  const scenarios = useMemo(() => priceScenarios(data), [data]);
  const recommendation = useMemo(() => recommendPrice(data), [data]);

  useEffect(() => {
    setSavedStatus("Сохраняем черновик…");
    const timer = window.setTimeout(() => {
      saveDraft("calculator", data);
      setSavedStatus("Изменения сохранены");
    }, 450);
    return () => window.clearTimeout(timer);
  }, [data]);

  const update = <K extends keyof CalculatorData>(key: K, value: CalculatorData[K]) =>
    setData((current) => ({ ...current, [key]: value }));

  const saveCalculation = async (duplicate = false) => {
    const title = data.name.trim() || "Расчёт без названия";
    const record = await saved.save(title, data, duplicate ? undefined : recordId);
    setRecordId(record.id);
    clearDraft("calculator");
    setSavedStatus(duplicate ? "Копия сохранена" : "Расчёт сохранён");
  };

  const newCalculation = () => {
    setData({ ...clone(initialCalculatorData), name: `Расчёт ${new Date().toLocaleDateString("ru-RU")}` });
    setRecordId(undefined);
    setSavedStatus("Новый черновик");
  };

  const exportCalculation = async () => {
    if (result.status === "danger" && !window.confirm("Расчёт убыточный или ниже минимальной маржи. Экспортировать с предупреждением?")) return;
    await exportText("Экспорт расчёта", `${data.name || "расчёт"}.sbkcalc.json`, ["json"], JSON.stringify({ version: 1, data, result }, null, 2));
  };

  const importCalculation = async () => {
    const imported = await importText("Импорт расчёта", ["json"]);
    if (!imported) return;
    const parsed = JSON.parse(imported.content);
    const next = parsed.data || parsed;
    setData({ ...clone(initialCalculatorData), ...next });
    setRecordId(undefined);
    setSavedStatus("Импортирован новый черновик");
  };

  return <div className="module-stack">
    <div className="module-toolbar">
      <div className="record-switcher">
        <label>Текущий расчёт
          <select value={recordId || ""} onChange={(event) => {
            const record = saved.records.find((item) => item.id === event.target.value);
            if (record) {
              setRecordId(record.id);
              setData({ ...clone(initialCalculatorData), ...record.payload });
            }
          }}>
            <option value="">Черновик — {data.name}</option>
            {saved.records.map((record) => <option key={record.id} value={record.id}>{record.title}</option>)}
          </select>
        </label>
        <span className="autosave-status">✓ {savedStatus}</span>
      </div>
      <div className="toolbar-actions">
        <button className="secondary" type="button" onClick={newCalculation}>Новый</button>
        <button className="secondary" type="button" onClick={() => void importCalculation()}>Импорт</button>
        <button className="secondary" type="button" onClick={() => void exportCalculation()}>Экспорт</button>
        <button className="primary" type="button" onClick={() => void saveCalculation(false)}>Сохранить расчёт</button>
      </div>
    </div>

    {saved.error && <div className="notice error"><strong>База недоступна.</strong><span>{saved.error}</span></div>}
    <div className="calculator-layout">
      <section className="input-column">
        <div className="surface">
          <div className="surface-title"><h2>Основные параметры</h2></div>
          <div className="surface-body form-grid">
            <label className="wide">Название расчёта<input value={data.name} onChange={(event) => update("name", event.target.value)} /></label>
            <label>Себестоимость<NumberField value={data.cost} min={0} onChange={(value) => update("cost", value)} suffix="₽" /></label>
            <label>Сумма себестоимости
              <select value={data.costAmountType} onChange={(event) => update("costAmountType", event.target.value as CalculatorData["costAmountType"])}>
                <option value="without-vat">Без НДС</option><option value="with-vat">С НДС</option>
              </select>
            </label>
            <label>НДС себестоимости<VatSelect value={data.costVatRate} onChange={(value) => update("costVatRate", value)} /></label>
            <label>Режим расчёта
              <select value={data.mode} onChange={(event) => update("mode", event.target.value as CalculatorData["mode"])}>
                <option value="margin-to-price">Задаю маржу → получаю цену</option>
                <option value="price-to-margin">Задаю цену → получаю прибыль</option>
              </select>
            </label>
            {data.mode === "margin-to-price" ? <>
              <label>Целевой показатель<select value={data.targetType} onChange={(event) => update("targetType", event.target.value as CalculatorData["targetType"])}><option value="margin">Маржа</option><option value="markup">Наценка</option></select></label>
              <label>Значение<NumberField value={data.targetValue} min={-99} max={95} onChange={(value) => update("targetValue", value)} suffix="%" /></label>
            </> : <>
              <label>Предлагаемая цена<NumberField value={data.proposedPrice} min={0} onChange={(value) => update("proposedPrice", value)} suffix="₽" /></label>
              <label>Формат цены<select value={data.priceAmountType} onChange={(event) => update("priceAmountType", event.target.value as CalculatorData["priceAmountType"])}><option value="with-vat">С НДС</option><option value="without-vat">Без НДС</option></select></label>
            </>}
            <label>НДС заказчику<VatSelect value={data.priceVatRate} onChange={(value) => update("priceVatRate", value)} /></label>
          </div>
        </div>

        <ExpensesTable data={data} setData={setData} result={result} />

        <details className="surface advanced-card">
          <summary>Условия сделки, агент и соисполнители</summary>
          <div className="surface-body advanced-sections">
            <label className="checkbox-row"><input type="checkbox" checked={data.hasAgent} onChange={(event) => update("hasAgent", event.target.checked)} /> Учитывать агента</label>
            {data.hasAgent && <div className="form-grid compact">
              <label>Тип комиссии<select value={data.agentType} onChange={(event) => update("agentType", event.target.value as CalculatorData["agentType"])}><option value="percent">Процент</option><option value="fixed">Фиксированная</option></select></label>
              <label>Комиссия<NumberField value={data.agentValue} min={0} onChange={(value) => update("agentValue", value)} suffix={data.agentType === "percent" ? "%" : "₽"} /></label>
              {data.agentType === "percent" && <label>База<select value={data.agentPercentBase} onChange={(event) => update("agentPercentBase", event.target.value as CalculatorData["agentPercentBase"])}><option value="net">Цена без НДС</option><option value="gross">Цена с НДС</option></select></label>}
            </div>}
            <Subcontractors items={data.subcontractors} onChange={(items) => update("subcontractors", items)} />
            <label className="checkbox-row"><input type="checkbox" checked={data.paymentRiskEnabled} onChange={(event) => update("paymentRiskEnabled", event.target.checked)} /> Учитывать риск отсрочки платежа</label>
            {data.paymentRiskEnabled && <label>Снижение эффективной маржи<NumberField value={data.paymentRiskPercent} min={0} max={50} onChange={(value) => update("paymentRiskPercent", value)} suffix="п.п." /></label>}
          </div>
        </details>

        <details className="surface advanced-card">
          <summary>Конкуренты и пороги</summary>
          <div className="surface-body advanced-sections">
            <Competitors items={data.competitors} onChange={(items) => update("competitors", items)} />
            <div className="form-grid compact"><label>Минимальная маржа<NumberField value={data.minMargin} min={-50} max={95} onChange={(value) => update("minMargin", value)} suffix="%" /></label><label>Зона предупреждения<NumberField value={data.warningMargin} min={-50} max={95} onChange={(value) => update("warningMargin", value)} suffix="%" /></label></div>
            <label>Комментарий<textarea rows={3} value={data.notes} onChange={(event) => update("notes", event.target.value)} /></label>
          </div>
        </details>
      </section>

      <section className="result-column">
        <div className={`surface result-panel ${result.status}`}>
          <div className="surface-title"><h2>Результат</h2><span className={`status ${result.status}`}>{result.status === "success" ? "✓ Расчёт устойчив" : result.status === "warning" ? "⚠ Низкая маржа" : "! Убыточно или ниже порога"}</span></div>
          <div className="surface-body">
            <span className="eyebrow">Цена для заказчика с НДС</span>
            <strong className="hero-number">{money(result.priceGross)}</strong>
            <div className="metric-grid">
              <div><span>Прибыль</span><strong>{money(result.profit)}</strong></div>
              <div><span>Маржа</span><strong>{percent(result.margin)}</strong></div>
              <div><span>Без НДС</span><strong>{money(result.priceNet)}</strong></div>
              <div><span>Рентабельность</span><strong>{percent(result.profitability)}</strong></div>
              <div><span>НДС</span><strong>{money(result.vatAmount)}</strong></div>
              <div><span>Доп. расходы</span><strong>{money(result.expensesTotal)}</strong></div>
            </div>
            {result.status === "danger" && <div className="notice warning"><strong>Проверьте цену.</strong><span>Экспорт потребует отдельного подтверждения.</span></div>}
            {recommendation && <div className="recommendation-card"><span>Рекомендованная цена с НДС</span><strong>{money(recommendation.priceGross)}</strong><small>{recommendation.limitedByMargin ? `Ниже опускаться рискованно: защита маржи ${percent(data.minMargin)}.` : `На 0,5% или 1 000 ₽ ниже ближайшего конкурента; расчётная маржа ${percent(recommendation.margin)}.`}</small><button className="secondary" type="button" onClick={() => setData((current) => ({ ...current, mode: "price-to-margin", proposedPrice: recommendation.priceGross, priceAmountType: "with-vat" }))}>Применить рекомендацию</button></div>}
            <div className="button-row"><button className="primary grow" type="button" onClick={() => void saveCalculation(false)}>Сохранить</button><button className="secondary" type="button" onClick={() => void saveCalculation(true)}>Дублировать</button></div>
          </div>
        </div>
        <CalculatorCharts data={data} result={result} scenarios={scenarios} active={activeChart} onActive={setActiveChart} />
      </section>
    </div>
  </div>;
}

function VatSelect({ value, onChange }: { value: VatRate; onChange: (value: VatRate) => void }) {
  return <select value={value} onChange={(event) => onChange(Number(event.target.value) as VatRate)}>{[0, 5, 7, 10, 11, 20, 22].map((rate) => <option key={rate} value={rate}>{rate === 0 ? "Без НДС" : `${rate}%`}</option>)}</select>;
}

function ExpensesTable({ data, setData, result }: { data: CalculatorData; setData: Dispatch<SetStateAction<CalculatorData>>; result: ReturnType<typeof calculate> }) {
  const updateExpense = (id: string, patch: Partial<Expense>) => setData((current) => ({ ...current, expenses: current.expenses.map((item) => item.id === id ? { ...item, ...patch } : item) }));
  const addTemplate = (template: "logistics" | "guarantee" | "insurance" | "platform" | "unexpected" | "empty") => {
    const templates: Record<typeof template, Partial<Expense>> = {
      logistics: { name: "Логистика", category: "Логистика", type: "fixed", value: 0 },
      guarantee: { name: "Банковская гарантия", category: "Финансы", type: "percent", value: 2, percentBase: "contract-price" },
      insurance: { name: "Страхование", category: "Финансы", type: "percent", value: 1, percentBase: "contract-price" },
      platform: { name: "Комиссия площадки", category: "Комиссии", type: "percent", value: 1, percentBase: "contract-price" },
      unexpected: { name: "Непредвиденные расходы", category: "Резерв", type: "percent", value: 3, percentBase: "cost" },
      empty: {},
    };
    setData((current) => ({ ...current, expenses: [...current.expenses, { ...newExpense(), ...templates[template] }] }));
  };
  return <div className="surface">
    <div className="surface-title"><h2>Дополнительные расходы</h2><select aria-label="Добавить расход" defaultValue="" onChange={(event) => { if (event.target.value) addTemplate(event.target.value as Parameters<typeof addTemplate>[0]); event.target.value = ""; }}><option value="">+ Добавить расход</option><option value="logistics">Логистика</option><option value="guarantee">Банковская гарантия</option><option value="insurance">Страхование</option><option value="platform">Комиссия площадки</option><option value="unexpected">Непредвиденные</option><option value="empty">Пустая строка</option></select></div>
    <div className="surface-body expense-table-wrap"><table className="expense-table"><thead><tr><th>Вкл.</th><th>Название и категория</th><th>Тип и база</th><th>Значение</th><th>Сумма</th><th aria-label="Действия" /></tr></thead><tbody>
      {data.expenses.map((expense) => {
        const calculated = result.expenseResults.find((item) => item.id === expense.id);
        return <tr key={expense.id}><td><input aria-label={`Учитывать ${expense.name}`} type="checkbox" checked={expense.enabled} onChange={(event) => updateExpense(expense.id, { enabled: event.target.checked })} /></td><td><input aria-label="Название расхода" value={expense.name} onChange={(event) => updateExpense(expense.id, { name: event.target.value })} /><input aria-label="Категория расхода" className="sub-input" value={expense.category} onChange={(event) => updateExpense(expense.id, { category: event.target.value })} /></td><td><select value={expense.type} onChange={(event) => updateExpense(expense.id, { type: event.target.value as Expense["type"] })}><option value="fixed">Сумма</option><option value="percent">Процент</option></select>{expense.type === "percent" && <select value={expense.percentBase} onChange={(event) => updateExpense(expense.id, { percentBase: event.target.value as Expense["percentBase"] })}><option value="cost">от себестоимости</option><option value="contract-price">от цены контракта</option><option value="custom">от своей базы</option></select>}</td><td><NumberField value={expense.value} min={0} onChange={(value) => updateExpense(expense.id, { value })} suffix={expense.type === "percent" ? "%" : "₽"} />{expense.type === "percent" && expense.percentBase === "custom" && <NumberField value={expense.customBase || 0} min={0} onChange={(value) => updateExpense(expense.id, { customBase: value })} suffix="₽ база" />}</td><td><strong>{money(calculated?.amount || 0)}</strong><small>{calculated?.explanation}</small></td><td><div className="row-actions"><button className="icon-button" type="button" title="Дублировать" onClick={() => setData((current) => ({ ...current, expenses: [...current.expenses, { ...expense, id: crypto.randomUUID(), name: `${expense.name} — копия` }] }))}>⧉</button><button className="icon-button danger" type="button" title="Удалить" onClick={() => setData((current) => ({ ...current, expenses: current.expenses.filter((item) => item.id !== expense.id) }))}>×</button></div></td></tr>;
      })}
    </tbody></table><div className="total-row"><span>Всего дополнительных расходов</span><strong>{money(result.expensesTotal)}</strong></div></div>
  </div>;
}

function Subcontractors({ items, onChange }: { items: Subcontractor[]; onChange: (items: Subcontractor[]) => void }) {
  const update = (id: string, patch: Partial<Subcontractor>) => onChange(items.map((item) => item.id === id ? { ...item, ...patch } : item));
  return <div className="repeatable-block"><div className="inline-heading"><h3>Соисполнители</h3><button className="secondary small" type="button" onClick={() => onChange([...items, { id: crypto.randomUUID(), name: `Соисполнитель ${items.length + 1}`, amount: 0, vatRate: 22, amountType: "with-vat" }])}>+ Добавить</button></div>{items.length === 0 ? <p className="muted">Не используются.</p> : items.map((item) => <div className="repeatable-row" key={item.id}><input aria-label="Название соисполнителя" value={item.name} onChange={(event) => update(item.id, { name: event.target.value })} /><NumberField value={item.amount} min={0} onChange={(value) => update(item.id, { amount: value })} suffix="₽" /><VatSelect value={item.vatRate} onChange={(value) => update(item.id, { vatRate: value })} /><select aria-label="Формат суммы" value={item.amountType} onChange={(event) => update(item.id, { amountType: event.target.value as Subcontractor["amountType"] })}><option value="with-vat">с НДС</option><option value="without-vat">без НДС</option></select><button className="icon-button danger" type="button" onClick={() => onChange(items.filter((current) => current.id !== item.id))}>×</button></div>)}</div>;
}

function Competitors({ items, onChange }: { items: Competitor[]; onChange: (items: Competitor[]) => void }) {
  const update = (id: string, patch: Partial<Competitor>) => onChange(items.map((item) => item.id === id ? { ...item, ...patch } : item));
  return <div className="repeatable-block"><div className="inline-heading"><h3>Конкуренты</h3><button className="secondary small" type="button" onClick={() => onChange([...items, { id: crypto.randomUUID(), name: `Конкурент ${items.length + 1}`, price: 0, vatRate: 22, amountType: "with-vat" }])}>+ Добавить</button></div>{items.length === 0 ? <p className="muted">Добавьте цены для сравнительного графика.</p> : items.map((item) => <div className="repeatable-row" key={item.id}><input aria-label="Название конкурента" value={item.name} onChange={(event) => update(item.id, { name: event.target.value })} /><NumberField value={item.price} min={0} onChange={(value) => update(item.id, { price: value })} suffix="₽" /><VatSelect value={item.vatRate} onChange={(value) => update(item.id, { vatRate: value })} /><select aria-label="Формат цены" value={item.amountType} onChange={(event) => update(item.id, { amountType: event.target.value as Competitor["amountType"] })}><option value="with-vat">с НДС</option><option value="without-vat">без НДС</option></select><button className="icon-button danger" type="button" onClick={() => onChange(items.filter((current) => current.id !== item.id))}>×</button></div>)}</div>;
}

function CalculatorCharts({ data, result, scenarios, active, onActive }: { data: CalculatorData; result: ReturnType<typeof calculate>; scenarios: ReturnType<typeof priceScenarios>; active: "structure" | "scenario" | "competitors"; onActive: (value: "structure" | "scenario" | "competitors") => void }) {
  const structure = [{ label: "Себестоимость", value: result.internalCostNet + result.subcontractorsNet, className: "cost" }, { label: "Доп. расходы", value: result.expensesTotal + result.agentCommission, className: "expense" }, { label: "Прибыль", value: Math.max(0, result.profit), className: "profit" }];
  const maxProfit = Math.max(...scenarios.map((item) => item.profit), 1);
  const minProfit = Math.min(...scenarios.map((item) => item.profit), 0);
  const y = (value: number) => 150 - ((value - minProfit) / Math.max(1, maxProfit - minProfit)) * 120;
  const points = scenarios.map((item, index) => `${45 + index * (450 / (scenarios.length - 1))},${y(item.profit)}`).join(" ");
  return <div className="surface chart-panel"><div className="chart-tabs"><button className={active === "structure" ? "active" : ""} type="button" onClick={() => onActive("structure")}>Структура</button><button className={active === "scenario" ? "active" : ""} type="button" onClick={() => onActive("scenario")}>Цена и прибыль</button><button className={active === "competitors" ? "active" : ""} type="button" disabled={data.competitors.length === 0} onClick={() => onActive("competitors")}>Конкуренты</button></div><div className="surface-body">
    {active === "structure" && <><div className="stacked-bar">{structure.map((item) => <span key={item.label} className={item.className} title={`${item.label}: ${money(item.value)}`} style={{ width: `${Math.max(0, item.value) / Math.max(result.priceNet, 1) * 100}%` }} />)}</div><div className="chart-legend">{structure.map((item) => <span key={item.label}><i className={`${item.className}-dot`} />{item.label}: {money(item.value)}</span>)}</div><p className="chart-summary">Из каждых 100 ₽ цены {Math.round((result.internalCostNet + result.subcontractorsNet) / Math.max(1, result.priceNet) * 100)} ₽ покрывают себестоимость, {Math.round(result.expensesTotal / Math.max(1, result.priceNet) * 100)} ₽ — дополнительные расходы, {Math.round(result.profit / Math.max(1, result.priceNet) * 100)} ₽ остаются прибылью.</p></>}
    {active === "scenario" && <><svg className="line-chart" viewBox="0 0 540 190" role="img" aria-label="Зависимость прибыли от предлагаемой цены"><line x1="45" y1="150" x2="505" y2="150" /><line x1="45" y1="20" x2="45" y2="150" /><polyline points={points} />{scenarios.map((item, index) => <circle key={item.price} cx={45 + index * (450 / (scenarios.length - 1))} cy={y(item.profit)} r={index === Math.floor(scenarios.length / 2) ? 6 : 3}><title>{money(item.price)} · прибыль {money(item.profit)} · маржа {percent(item.margin)}</title></circle>)}</svg><p className="chart-summary">При текущей цене прибыль составляет {money(result.profit)}, маржа — {percent(result.margin)}. Наведите на точки для сравнения сценариев ±20%.</p></>}
    {active === "competitors" && <div className="competitor-chart">{[...data.competitors.map((item) => ({ name: item.name, value: toGross(toNet(item.price, item.vatRate, item.amountType), data.priceVatRate) })), { name: "Наше предложение", value: result.priceGross }].sort((a, b) => b.value - a.value).map((item) => <div className="competitor-bar" key={item.name}><span>{item.name}</span><div><i style={{ width: `${item.value / Math.max(result.priceGross, ...data.competitors.map((entry) => entry.price), 1) * 100}%` }} /></div><strong>{money(item.value)}</strong></div>)}</div>}
  </div></div>;
}
