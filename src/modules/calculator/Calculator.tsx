import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { useRecords } from "../../hooks/useRecords";
import { exportText, importText } from "../../lib/files";
import { clearDraft, readDraft, saveDraft } from "../../lib/storage";
import { useWorkspaceAccess } from "../../lib/workspaceAccess";
import { calculate, competitorComparablePrice, priceScenarios, recommendPrice } from "./engine";
import {
  initialCalculatorData,
  migrateCalculatorData,
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

const percent = (value: number) => Number.isFinite(value) ? `${value.toFixed(1)}%` : "—";
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

function restoredCalculatorData(value: unknown) {
  try {
    return value ? migrateCalculatorData(value) : clone(initialCalculatorData);
  } catch {
    return clone(initialCalculatorData);
  }
}

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
  const workspaceAccess = useWorkspaceAccess();
  const saved = useRecords<CalculatorData>("calculator");
  const [data, setData] = useState<CalculatorData>(() => restoredCalculatorData(null));
  const [draftReady, setDraftReady] = useState(false);
  const [recordId, setRecordId] = useState<string | undefined>();
  const [savedStatus, setSavedStatus] = useState("Загружаем черновик…");
  const [formError, setFormError] = useState("");
  const [activeChart, setActiveChart] = useState<"structure" | "scenario" | "competitors">("structure");
  const result = useMemo(() => calculate(data), [data]);
  const scenarios = useMemo(() => priceScenarios(data), [data]);
  const recommendation = useMemo(() => recommendPrice(data), [data]);

  useEffect(() => {
    let active = true;
    void readDraft<unknown>("calculator", "new")
      .then((draft) => { if (active) { if (draft) setData(restoredCalculatorData(draft)); setSavedStatus(draft ? "Черновик восстановлен" : "Новый черновик"); } })
      .catch(() => { if (active) setSavedStatus("Черновик не удалось восстановить"); })
      .finally(() => { if (active) setDraftReady(true); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (workspaceAccess.editor) return;
    let generation = 0;
    const refresh = () => {
      const current = ++generation;
      void readDraft<unknown>("calculator", recordId || "new").then((draft) => {
        if (current === generation && draft) setData(restoredCalculatorData(draft));
      });
    };
    window.addEventListener("sbk-workspace-refresh", refresh);
    return () => { generation += 1; window.removeEventListener("sbk-workspace-refresh", refresh); };
  }, [workspaceAccess.editor, recordId]);

  useEffect(() => {
    if (!draftReady || !workspaceAccess.editor) return;
    setSavedStatus("Сохраняем черновик…");
    const timer = window.setTimeout(() => {
      void saveDraft("calculator", data, recordId || "new")
        .then(() => setSavedStatus("Изменения сохранены"))
        .catch(() => setSavedStatus("Черновик не сохранён"));
    }, 450);
    return () => window.clearTimeout(timer);
  }, [data, draftReady, recordId, workspaceAccess.editor]);

  const update = <K extends keyof CalculatorData>(key: K, value: CalculatorData[K]) =>
    setData((current) => ({ ...current, [key]: value }));

  const saveCalculation = async (duplicate = false) => {
    if (!result.valid) {
      setFormError(result.issues.find((issue) => issue.blocking)?.message || "Исправьте ошибки расчёта перед сохранением.");
      return;
    }
    const title = data.name.trim() || "Расчёт без названия";
    const record = await saved.save(title, data, duplicate ? undefined : recordId);
    setRecordId(record.id);
    void clearDraft("calculator", recordId || "new");
    setSavedStatus(duplicate ? "Копия сохранена" : "Расчёт сохранён");
  };

  const newCalculation = () => {
    setData({ ...clone(initialCalculatorData), name: `Расчёт ${new Date().toLocaleDateString("ru-RU")}` });
    setRecordId(undefined);
    setSavedStatus("Новый черновик");
  };

  const exportCalculation = async () => {
    if (!result.valid) {
      setFormError(result.issues.find((issue) => issue.blocking)?.message || "Исправьте ошибки расчёта перед экспортом.");
      return;
    }
    if (result.status === "danger" && !window.confirm("Расчёт убыточный или ниже минимальной маржи. Экспортировать с предупреждением?")) return;
    await exportText("Экспорт расчёта", `${data.name || "расчёт"}.sbkcalc.json`, ["json"], JSON.stringify({ version: 2, data, result }, null, 2));
  };

  const importCalculation = async () => {
    const imported = await importText("Импорт расчёта", ["json"]);
    if (!imported) return;
    try {
      const parsed = JSON.parse(imported.content) as { data?: unknown };
      setData(migrateCalculatorData(parsed.data ?? parsed, true));
      setRecordId(undefined);
      setFormError("");
      setSavedStatus("Импортирован новый черновик");
    } catch (reason) {
      setFormError(reason instanceof Error ? reason.message : "Файл расчёта повреждён или несовместим.");
    }
  };

  return <div className="module-stack">
    <div className="module-toolbar">
      <div className="record-switcher">
        <label>Текущий расчёт
          <select value={recordId || ""} onChange={(event) => {
            const record = saved.records.find((item) => item.id === event.target.value);
            if (record) {
              setRecordId(record.id);
              void readDraft<unknown>("calculator", record.id).then((draft) => setData(restoredCalculatorData(draft || record.payload)));
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
        <button className="secondary" disabled={!result.valid} type="button" onClick={() => void exportCalculation()}>Экспорт</button>
        {recordId && <button className="secondary danger" type="button" onClick={() => { if (window.confirm("Переместить расчёт в архив?")) void saved.archive(recordId).then(newCalculation); }}>В архив</button>}
        <button className="primary" disabled={!result.valid} type="button" onClick={() => void saveCalculation(false)}>Сохранить расчёт</button>
      </div>
    </div>

    {saved.error && <div className="notice error"><strong>База недоступна.</strong><span>{saved.error}</span></div>}
    {formError && <div className="notice error"><strong>Расчёт не сохранён.</strong><span>{formError}</span></div>}
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
            <label>Налоговый режим<select value={data.costTaxRegime} onChange={(event) => update("costTaxRegime", event.target.value as CalculatorData["costTaxRegime"])}><option value="vat-payer">Плательщик НДС</option><option value="no-vat">Без НДС / УСН</option></select></label>
            <label className="checkbox-row"><input type="checkbox" checked={data.costInputVatDeductible} disabled={data.costTaxRegime === "no-vat"} onChange={(event) => update("costInputVatDeductible", event.target.checked)} /> Входной НДС принимается к вычету</label>
            <label>Режим расчёта
              <select value={data.mode} onChange={(event) => update("mode", event.target.value as CalculatorData["mode"])}>
                <option value="margin-to-price">Задаю маржу → получаю цену</option>
                <option value="price-to-margin">Задаю цену → получаю прибыль</option>
              </select>
            </label>
            {data.mode === "margin-to-price" ? <>
              <label>Целевой показатель<select value={data.targetType} onChange={(event) => update("targetType", event.target.value as CalculatorData["targetType"])}><option value="margin">Маржа</option><option value="markup">Наценка</option></select></label>
              <label>Значение<NumberField value={data.targetValue} min={-99} max={data.targetType === "margin" ? 99 : 10_000} onChange={(value) => update("targetValue", value)} suffix="%" /></label>
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
              <label>Налоговый режим агента<select value={data.agentTaxRegime} onChange={(event) => update("agentTaxRegime", event.target.value as CalculatorData["agentTaxRegime"])}><option value="no-vat">Без НДС / УСН</option><option value="vat-payer">Плательщик НДС</option></select></label>
              <label>Формат комиссии<select value={data.agentAmountType} onChange={(event) => update("agentAmountType", event.target.value as CalculatorData["agentAmountType"])}><option value="without-vat">Без НДС</option><option value="with-vat">С НДС</option></select></label>
              {data.agentTaxRegime === "vat-payer" && <><label>НДС агента<VatSelect value={data.agentVatRate} onChange={(value) => update("agentVatRate", value)} /></label><label className="checkbox-row"><input type="checkbox" checked={data.agentInputVatDeductible} onChange={(event) => update("agentInputVatDeductible", event.target.checked)} /> Входной НДС к вычету</label></>}
            </div>}
            <Subcontractors items={data.subcontractors} onChange={(items) => update("subcontractors", items)} />
            <label className="checkbox-row"><input type="checkbox" checked={data.currencyComponentEnabled} onChange={(event) => update("currencyComponentEnabled", event.target.checked)} /> Учитывать валютную составляющую по фиксированному курсу</label>
            {data.currencyComponentEnabled && <div className="form-grid compact"><label>Валюта<select value={data.foreignCurrency} onChange={(event) => update("foreignCurrency", event.target.value as CalculatorData["foreignCurrency"])}><option>USD</option><option>EUR</option><option>CNY</option></select></label><label>Сумма<NumberField value={data.foreignAmount} min={0} onChange={(value) => update("foreignAmount", value)} suffix={data.foreignCurrency} /></label><label>Курс к рублю<NumberField value={data.exchangeRate} min={0.0001} onChange={(value) => update("exchangeRate", value)} suffix="₽" /></label><div className="metric-inline"><span>В затратах</span><strong>{money(data.foreignAmount * data.exchangeRate)}</strong></div></div>}
            <label className="checkbox-row"><input type="checkbox" checked={data.financingEnabled} onChange={(event) => update("financingEnabled", event.target.checked)} /> Учитывать стоимость финансирования и гарантий</label>
            {data.financingEnabled && <div className="form-grid compact">
              <label>Аванс<NumberField value={data.advancePercent} min={0} max={100} onChange={(value) => update("advancePercent", value)} suffix="%" /></label>
              <label>Отсрочка<NumberField value={data.paymentDelayDays} min={0} max={3650} onChange={(value) => update("paymentDelayDays", value)} suffix="дней" /></label>
              <label>Ставка финансирования<NumberField value={data.annualFinancingRate} min={0} max={1000} onChange={(value) => update("annualFinancingRate", value)} suffix="%" /></label>
              <label>Период ставки<select value={data.financingRatePeriod} onChange={(event) => update("financingRatePeriod", event.target.value as CalculatorData["financingRatePeriod"])}><option value="annual">в год</option><option value="monthly">в месяц</option></select></label>
              <label className="checkbox-row"><input type="checkbox" checked={data.factoringEnabled} onChange={(event) => update("factoringEnabled", event.target.checked)} /> Факторинг / ранняя выплата</label>
              {data.factoringEnabled && <label>Комиссия факторинга<NumberField value={data.factoringCommissionPercent} min={0} max={100} onChange={(value) => update("factoringCommissionPercent", value)} suffix="%" /></label>}
              <label>Гарантия заявки<NumberField value={data.bidGuaranteeCost} min={0} onChange={(value) => update("bidGuaranteeCost", value)} suffix="₽" /></label>
              <label>Гарантия исполнения<NumberField value={data.performanceGuaranteeCost} min={0} onChange={(value) => update("performanceGuaranteeCost", value)} suffix="₽" /></label>
              <label>Гарантия аванса<NumberField value={data.advanceGuaranteeCost} min={0} onChange={(value) => update("advanceGuaranteeCost", value)} suffix="₽" /></label>
              <label>Резерв роста стоимости<NumberField value={data.costGrowthReservePercent} min={0} max={100} onChange={(value) => update("costGrowthReservePercent", value)} suffix="% прямых затрат" /></label>
            </div>}
            {data.financingEnabled && <PaymentStages data={data} setData={setData} />}
          </div>
        </details>

        <details className="surface advanced-card">
          <summary>Конкуренты и пороги</summary>
          <div className="surface-body advanced-sections">
            <label>База сравнения цен<select value={data.comparisonBasis} onChange={(event) => update("comparisonBasis", event.target.value as CalculatorData["comparisonBasis"])}><option value="gross">Полная цена договора с НДС</option><option value="net">Цена без НДС</option><option value="adjusted">Приведённая цена по корректировке</option></select></label>
            <Competitors items={data.competitors} onChange={(items) => update("competitors", items)} />
            <div className="form-grid compact"><label>Минимальная маржа<NumberField value={data.minMargin} min={-99} max={99} onChange={(value) => update("minMargin", value)} suffix="%" /></label><label>Зона предупреждения<NumberField value={data.warningMargin} min={data.minMargin} max={99} onChange={(value) => update("warningMargin", value)} suffix="%" /></label></div>
            <div className="notice"><strong>Зоны результата</strong><span>Красная — убыток, ошибка или маржа ниже минимальной; жёлтая — между минимальной и зоной предупреждения; зелёная — не ниже зоны предупреждения.</span></div>
            <label>Комментарий<textarea rows={3} value={data.notes} onChange={(event) => update("notes", event.target.value)} /></label>
          </div>
        </details>
      </section>

      <section className="result-column">
        <div className={`surface result-panel ${result.status}`}>
          <div className="surface-title"><h2>Результат</h2><span className={`status ${result.status}`}>{result.status === "success" ? "✓ Расчёт устойчив" : result.status === "warning" ? "⚠ Низкая маржа" : "! Убыточно или ниже порога"}</span></div>
          <div className="surface-body">
            <span className="eyebrow">Цена для заказчика с НДС</span>
            <strong className="hero-number">{result.valid ? money(result.priceGross) : "Расчёт невозможен"}</strong>
            <div className="metric-grid">
              <div><span>Прибыль</span><strong>{money(result.profit)}</strong></div>
              <div><span>Маржа</span><strong>{percent(result.margin)}</strong></div>
              <div><span>Без НДС</span><strong>{money(result.priceNet)}</strong></div>
              <div><span>Наценка на полные затраты</span><strong>{percent(result.markup)}</strong></div>
              <div><span>Выходной НДС</span><strong>{money(result.outputVat)}</strong></div>
              <div><span>Входной НДС к вычету</span><strong>{money(result.inputVatDeductible)}</strong></div>
              <div><span>НДС к уплате</span><strong>{money(result.vatPayable)}</strong></div>
              <div><span>Прямые затраты</span><strong>{money(result.directCosts)}</strong></div>
              <div><span>Доп. расходы</span><strong>{money(result.additionalCosts)}</strong></div>
              <div><span>Агентская комиссия</span><strong>{money(result.agentCommission)}</strong></div>
              <div><span>Финансирование</span><strong>{money(result.financingCost)}</strong></div>
              <div><span>Валютная составляющая</span><strong>{money(result.currencyCost)}</strong></div>
              <div><span>Полные затраты</span><strong>{money(result.fullCosts)}</strong></div>
              <div><span>Рентабельность полных затрат</span><strong>{percent(result.profitability)}</strong></div>
            </div>
            <details className="formula-details"><summary>Как получены цена и прибыль</summary><div><span>Полные затраты = прямые {money(result.directCosts)} + валюта {money(result.currencyCost)} + дополнительные {money(result.additionalCosts)} + агент {money(result.agentCommission)} + финансирование {money(result.financingCost)}</span><strong>{money(result.fullCosts)}</strong><span>Прибыль = цена без НДС {money(result.priceNet)} − полные затраты {money(result.fullCosts)}</span><strong>{money(result.profit)}</strong><span>Маржа = прибыль ÷ цена без НДС; наценка = прибыль ÷ полные затраты</span><strong>{percent(result.margin)} / {percent(result.markup)}</strong>{result.expenseResults.map((expense) => <small key={expense.id}>{expense.name}: {expense.explanation} → {money(expense.effectiveCost)}</small>)}</div></details>
            {!result.valid && <div className="notice error"><strong>Цена не рассчитана.</strong><span>{result.issues.find((issue) => issue.blocking)?.message}</span></div>}
            {result.valid && result.status === "danger" && <div className="notice warning"><strong>Проверьте цену.</strong><span>Расчёт убыточный или находится ниже установленного порога.</span></div>}
            {recommendation && !recommendation.valid && <div className="notice error"><strong>Рекомендация недоступна.</strong><span>{recommendation.issue?.message}</span></div>}
            {recommendation?.valid && <div className="recommendation-card"><span>Рекомендованная цена с НДС</span><strong>{money(recommendation.priceGross)}</strong><small>База: {recommendation.basisLabel}. Ближайшее сравнимое предложение: {money(recommendation.lowestCompetitor)}. {recommendation.limitedByMargin ? `Ниже опускаться рискованно: защита маржи ${percent(data.minMargin)}.` : `Шаг ниже конкурента; расчётная маржа ${percent(recommendation.margin)}.`}</small><button className="secondary" type="button" onClick={() => setData((current) => ({ ...current, mode: "price-to-margin", proposedPrice: recommendation.priceGross, priceAmountType: "with-vat" }))}>Применить рекомендацию</button></div>}
            <div className="button-row"><button className="primary grow" disabled={!result.valid} type="button" onClick={() => void saveCalculation(false)}>Сохранить</button><button className="secondary" disabled={!result.valid} type="button" onClick={() => void saveCalculation(true)}>Дублировать</button></div>
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
        return <tr key={expense.id}><td><input aria-label={`Учитывать ${expense.name}`} type="checkbox" checked={expense.enabled} onChange={(event) => updateExpense(expense.id, { enabled: event.target.checked })} /></td><td><input aria-label="Название расхода" value={expense.name} onChange={(event) => updateExpense(expense.id, { name: event.target.value })} /><input aria-label="Категория расхода" className="sub-input" value={expense.category} onChange={(event) => updateExpense(expense.id, { category: event.target.value })} /></td><td><select value={expense.type} onChange={(event) => updateExpense(expense.id, { type: event.target.value as Expense["type"] })}><option value="fixed">Сумма</option><option value="percent">Процент</option></select>{expense.type === "percent" && <><select value={expense.percentBase} onChange={(event) => updateExpense(expense.id, { percentBase: event.target.value as Expense["percentBase"] })}><option value="cost">от прямых затрат</option><option value="contract-price">от цены контракта</option><option value="custom">от своей базы</option></select>{expense.percentBase === "contract-price" && <select aria-label="Формат базы цены" value={expense.percentPriceBase} onChange={(event) => updateExpense(expense.id, { percentPriceBase: event.target.value as Expense["percentPriceBase"] })}><option value="net">цена без НДС</option><option value="gross">цена с НДС</option></select>}</>}</td><td><NumberField value={expense.value} min={0} onChange={(value) => updateExpense(expense.id, { value })} suffix={expense.type === "percent" ? "%" : "₽"} />{expense.type === "percent" && expense.percentBase === "custom" && <NumberField value={expense.customBase || 0} min={0} onChange={(value) => updateExpense(expense.id, { customBase: value })} suffix="₽ база" />}<select aria-label="Налоговый режим расхода" value={expense.taxRegime} onChange={(event) => updateExpense(expense.id, { taxRegime: event.target.value as Expense["taxRegime"] })}><option value="no-vat">без НДС / УСН</option><option value="vat-payer">плательщик НДС</option></select>{expense.taxRegime === "vat-payer" && <><VatSelect value={expense.vatRate} onChange={(value) => updateExpense(expense.id, { vatRate: value })} /><label className="checkbox-row"><input type="checkbox" checked={expense.inputVatDeductible} onChange={(event) => updateExpense(expense.id, { inputVatDeductible: event.target.checked })} /> к вычету</label></>}</td><td><strong>{money(calculated?.effectiveCost || 0)}</strong><small>{calculated?.explanation}</small></td><td><div className="row-actions"><button className="icon-button" type="button" title="Дублировать" onClick={() => setData((current) => ({ ...current, expenses: [...current.expenses, { ...expense, id: crypto.randomUUID(), name: `${expense.name} — копия` }] }))}>⧉</button><button className="icon-button danger" type="button" title="Удалить" onClick={() => setData((current) => ({ ...current, expenses: current.expenses.filter((item) => item.id !== expense.id) }))}>×</button></div></td></tr>;
      })}
    </tbody></table><div className="total-row"><span>Всего дополнительных расходов</span><strong>{money(result.expensesTotal)}</strong></div></div>
  </div>;
}

function PaymentStages({ data, setData }: { data: CalculatorData; setData: Dispatch<SetStateAction<CalculatorData>> }) {
  const update = (id: string, patch: Partial<CalculatorData["paymentStages"][number]>) => setData((current) => ({ ...current, paymentStages: current.paymentStages.map((stage) => stage.id === id ? { ...stage, ...patch } : stage) }));
  const total = data.paymentStages.reduce((sum, stage) => sum + stage.sharePercent, 0);
  return <div className="repeatable-block"><div className="inline-heading"><div><h3>График платежей</h3><p>{data.paymentStages.length ? `Сумма долей: ${total.toFixed(1)}%` : "Если не задан, используются общий аванс и отсрочка."}</p></div><button className="secondary small" type="button" onClick={() => setData((current) => ({ ...current, paymentStages: [...current.paymentStages, { id: crypto.randomUUID(), name: `Этап ${current.paymentStages.length + 1}`, sharePercent: 0, delayDays: 0, plannedDate: "" }] }))}>Добавить этап</button></div>{data.paymentStages.map((stage) => <div className="payment-stage-row" key={stage.id}><input aria-label="Название этапа" value={stage.name} onChange={(event) => update(stage.id, { name: event.target.value })} /><label>Доля, %<NumberField value={stage.sharePercent} min={0} max={100} onChange={(value) => update(stage.id, { sharePercent: value })} /></label><label>Отсрочка, дней<NumberField value={stage.delayDays} min={0} max={3650} onChange={(value) => update(stage.id, { delayDays: value })} /></label><label>Плановая дата<input type="date" value={stage.plannedDate} onChange={(event) => update(stage.id, { plannedDate: event.target.value })} /></label><button className="icon-button danger" type="button" onClick={() => setData((current) => ({ ...current, paymentStages: current.paymentStages.filter((item) => item.id !== stage.id) }))}>×</button></div>)}</div>;
}

function Subcontractors({ items, onChange }: { items: Subcontractor[]; onChange: (items: Subcontractor[]) => void }) {
  const update = (id: string, patch: Partial<Subcontractor>) => onChange(items.map((item) => item.id === id ? { ...item, ...patch } : item));
  const add = () => onChange([...items, {
    id: crypto.randomUUID(), name: `Соисполнитель ${items.length + 1}`, amount: 0,
    vatRate: 22, amountType: "with-vat", taxRegime: "vat-payer",
    inputVatDeductible: true, includeInTotalCost: true,
  }]);
  return <div className="repeatable-block"><div className="inline-heading"><h3>Соисполнители</h3><button className="secondary small" type="button" onClick={add}>+ Добавить</button></div>{items.length === 0 ? <p className="muted">Не используются.</p> : items.map((item) => <div className="repeatable-row" key={item.id}><input aria-label="Название соисполнителя" value={item.name} onChange={(event) => update(item.id, { name: event.target.value })} /><NumberField value={item.amount} min={0} onChange={(value) => update(item.id, { amount: value })} suffix="₽" /><select aria-label="Налоговый режим" value={item.taxRegime} onChange={(event) => update(item.id, { taxRegime: event.target.value as Subcontractor["taxRegime"] })}><option value="vat-payer">плательщик НДС</option><option value="no-vat">без НДС / УСН</option></select>{item.taxRegime === "vat-payer" && <VatSelect value={item.vatRate} onChange={(value) => update(item.id, { vatRate: value })} />}<select aria-label="Формат суммы" value={item.amountType} onChange={(event) => update(item.id, { amountType: event.target.value as Subcontractor["amountType"] })}><option value="with-vat">с НДС</option><option value="without-vat">без НДС</option></select>{item.taxRegime === "vat-payer" && <label className="checkbox-row"><input type="checkbox" checked={item.inputVatDeductible} onChange={(event) => update(item.id, { inputVatDeductible: event.target.checked })} /> НДС к вычету</label>}<button className="icon-button danger" type="button" onClick={() => onChange(items.filter((current) => current.id !== item.id))}>×</button></div>)}</div>;
}

function Competitors({ items, onChange }: { items: Competitor[]; onChange: (items: Competitor[]) => void }) {
  const update = (id: string, patch: Partial<Competitor>) => onChange(items.map((item) => item.id === id ? { ...item, ...patch } : item));
  const add = () => onChange([...items, {
    id: crypto.randomUUID(), name: `Конкурент ${items.length + 1}`, price: 0,
    vatRate: 22, amountType: "with-vat", taxRegime: "vat-payer", adjustmentPercent: 0,
  }]);
  return <div className="repeatable-block"><div className="inline-heading"><h3>Конкуренты</h3><button className="secondary small" type="button" onClick={add}>+ Добавить</button></div>{items.length === 0 ? <p className="muted">Добавьте цены для сравнительного графика.</p> : items.map((item) => <div className="repeatable-row" key={item.id}><input aria-label="Название конкурента" value={item.name} onChange={(event) => update(item.id, { name: event.target.value })} /><NumberField value={item.price} min={0} onChange={(value) => update(item.id, { price: value })} suffix="₽" /><select aria-label="Налоговый режим конкурента" value={item.taxRegime} onChange={(event) => update(item.id, { taxRegime: event.target.value as Competitor["taxRegime"] })}><option value="vat-payer">плательщик НДС</option><option value="no-vat">без НДС / УСН</option></select>{item.taxRegime === "vat-payer" && <VatSelect value={item.vatRate} onChange={(value) => update(item.id, { vatRate: value })} />}<select aria-label="Формат цены" value={item.amountType} onChange={(event) => update(item.id, { amountType: event.target.value as Competitor["amountType"] })}><option value="with-vat">с НДС</option><option value="without-vat">без НДС</option></select><label>Корректировка<NumberField value={item.adjustmentPercent} min={-99} max={1000} onChange={(value) => update(item.id, { adjustmentPercent: value })} suffix="%" /></label><button className="icon-button danger" type="button" onClick={() => onChange(items.filter((current) => current.id !== item.id))}>×</button></div>)}</div>;
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
    {active === "competitors" && <div className="competitor-chart">{[...data.competitors.map((item) => ({ name: item.name, value: competitorComparablePrice(item, data.comparisonBasis) })), { name: "Наше предложение", value: data.comparisonBasis === "net" ? result.priceNet : result.priceGross }].sort((a, b) => b.value - a.value).map((item, _index, rows) => <div className="competitor-bar" key={item.name}><span>{item.name}</span><div><i style={{ width: `${item.value / Math.max(...rows.map((row) => row.value), 1) * 100}%` }} /></div><strong>{money(item.value)}</strong></div>)}</div>}
  </div></div>;
}
