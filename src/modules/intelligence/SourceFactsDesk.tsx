import { useEffect, useState } from "react";
import { dateFactField } from "./sourceGrounding";
import { fieldDefinitions } from "./workbenchModel";
import { repairConditionsFromSources, repairDateFromSource, repairPositionFromSources, sourceRepairCleanup, type SourceRepair } from "./sourceRepairs";
import type { SourceFactsInventory } from "./sourceFactsWorker";
import type { EvidenceExcerpt } from "./resultEvidence";
import type { IntelligenceItem, IntelligenceSource } from "./workbenchTypes";

const conditionLabels: Record<string, string> = { requirement: "Требование", certificate: "Сертификат", license: "Лицензия", document: "Документ заявки", quantity: "Количество", payment: "Оплата", delivery: "Сроки и поставка", exception: "Исключение / оговорка" };
const eventLabels: Record<string, string> = { "submission-start": "Начало подачи", "submission-end": "Окончание подачи", "question-deadline": "Окончание разъяснений", publication: "Публикация", revision: "Редакция документа", consideration: "Рассмотрение", results: "Подведение итогов", "execution-start": "Начало выполнения", "execution-end": "Окончание выполнения", "contract-date": "Дата договора", "proposal-date": "Дата КП", "valid-until": "Срок действия КП" };
const factKey = (fact: EvidenceExcerpt & { category: string }) => JSON.stringify([fact.sourceId, fact.fragmentId, fact.locator, fact.category, fact.quote]);
function Quote({ fact }: { fact: EvidenceExcerpt }) { return <details className="iw-source-fact-quote"><summary>{fact.sourceName} · {fact.locator}</summary><blockquote>{fact.quote}</blockquote></details>; }

export function SourceFactsDesk({ item, sources, inventory, pending, failed, onRequest, onRetry, onApply }: {
  item: IntelligenceItem; sources: IntelligenceSource[]; inventory?: SourceFactsInventory; pending: boolean; failed: boolean;
  onRequest: () => void; onRetry: () => void; onApply: (patch: SourceRepair) => void;
}) {
  const [open, setOpen] = useState(false), [selected, setSelected] = useState<string[]>([]);
  const [skuId, setSkuId] = useState(""), [configurationId, setConfigurationId] = useState(""), [positionIndex, setPositionIndex] = useState(-1);
  const [error, setError] = useState("");
  const owns = (fact: EvidenceExcerpt) => item.sourceIds.includes(fact.sourceId);
  const dates = inventory?.dates.facts.filter(owns) || [];
  const conditions = inventory?.conditions.facts.filter(owns) || [];
  const positions = inventory?.positions.positions.filter(owns) || [], configurations = inventory?.positions.configurations.filter(owns) || [];
  const limited = Boolean(inventory && (inventory.dates.limited || inventory.conditions.limited || inventory.positions.truncated));
  const cleanup = sourceRepairCleanup(item);
  useEffect(() => { setSelected([]); setSkuId(""); setConfigurationId(""); setPositionIndex(-1); setError(""); }, [inventory, item.sourceIds.join("\n")]);
  const apply = (build: () => SourceRepair) => { try { const patch = build(); onApply(patch); setError(""); setSelected([]); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } };
  const names = Array.isArray(item.fields.lines) ? item.fields.lines : [];
  return <details className="iw-source-facts" open={open} onToggle={(event) => { const next = event.currentTarget.open; setOpen(next); if (next) onRequest(); }}>
    <summary>Точный разбор источников — даты, условия и артикулы</summary>
    {open && <div className="iw-source-facts-body">
      <p className="help-text">Это найденные программой цитаты, не новый ответ модели. Выберите применимые сведения: они изменят только этот черновик, не исходный ответ и не базу. Ручные подтверждения карточки сбросятся.</p>
      {!item.sourceIds.length && <p className="notice warning">Сначала выберите источники этой карточки.</p>}
      {pending && <p role="status">Ищем факты в локальном снимке источников…</p>}
      {failed && <div className="notice error" role="alert">Разбор источников не выполнен.<button type="button" onClick={onRetry}>Повторить разбор источников</button></div>}
      {error && <p className="notice error" role="alert">{error}</p>}
      {cleanup.keys.length > 0 && <div className="iw-source-fact-row"><strong>Заглушки и некорректные даты: {cleanup.keys.map((key) => fieldDefinitions[item.destination].find((field) => field.key === key)?.label || key).join(", ")}</strong><p className="help-text">Значения «null» строкой и невозможные даты не являются фактами. Исходный ответ останется доступен.</p><button type="button" className="secondary" onClick={() => apply(() => cleanup.patch)}>Убрать заглушки и неверные даты ({cleanup.keys.length})</button></div>}
      {inventory && <>
        {limited && <p className="notice warning">Достигнут предел локального разбора. Список неполный; разделите источники и проверьте исходный документ.</p>}
        {sources.some((source) => item.sourceIds.includes(source.id) && source.coverage && (!source.coverage.complete || source.coverage.requiresOcr)) && <p className="notice warning">Есть ограничения извлечения / OCR. Найденные цитаты не подтверждают полноту исходного документа.</p>}
        <section><h4>Даты по событиям ({dates.length})</h4><p className="help-text">Редакция, публикация, подача и выполнение не подменяют друг друга. Относительные дни не превращаются в календарную дату.</p>
          {dates.length ? dates.map((fact, index) => { const field = dateFactField(item.destination, fact.event), label = fieldDefinitions[item.destination].find((entry) => entry.key === field)?.label; return <div className="iw-source-fact-row" key={index}>
            <strong>{label || eventLabels[fact.event] || "Дата события"}: {fact.iso}{fact.time ? ` ${fact.time}` : ""}{fact.timezone ? ` ${fact.timezone}` : ""}{fact.lowerBound ? " · не ранее" : ""}</strong><Quote fact={fact} />{fact.supportingEvidence?.map((support, at) => <Quote key={at} fact={support} />)}
            {fact.ambiguous && <p className="help-text">Связь с лотом / часовой пояс неоднозначны. Уточните по оригиналу и заполните поле вручную.</p>}
            {field && <button type="button" className="secondary" disabled={fact.ambiguous} onClick={() => apply(() => repairDateFromSource(item, fact, sources))}>Использовать: {label} · {fact.iso}</button>}
          </div>; }) : <p className="help-text">Явных дат с распознанным событием не найдено. Неизвестное оставьте пустым.</p>}
        </section>
        <section><h4>Условия и документы ({conditions.length})</h4><p className="help-text">Сохраняются точные формулировки с числами и исключениями. Применимость к этой карточке проверяете вы.</p>
          {conditions.length > 100 && <p className="help-text">За одно действие — до 100 условий. Группа заменяет текущий выбор; проверьте лимиты полей перед добавлением.</p>}
          {conditions.length > 0 && <div className="iw-actions">{Array.from({ length: Math.ceil(conditions.length / 100) }, (_, index) => <button type="button" className="secondary" key={index} onClick={() => { setSelected(conditions.slice(index * 100, (index + 1) * 100).map(factKey)); setError(""); }}>{conditions.length <= 100 ? "Выбрать все найденные условия" : `Выбрать группу ${index * 100 + 1}–${Math.min(conditions.length, (index + 1) * 100)}`}</button>)}<button type="button" className="secondary" onClick={() => setSelected([])}>Снять выбор условий</button><button type="button" className="primary" disabled={!conditions.some((fact) => selected.includes(factKey(fact)))} onClick={() => apply(() => repairConditionsFromSources(item, conditions.filter((fact) => selected.includes(factKey(fact))), sources))}>Добавить выбранные условия ({conditions.filter((fact) => selected.includes(factKey(fact))).length})</button></div>}
          {conditions.map((fact) => <div className="iw-source-fact-row" key={factKey(fact)}><label className="iw-fact-choice"><input type="checkbox" checked={selected.includes(factKey(fact))} onChange={(event) => { const checked = event.target.checked; if (checked && !selected.includes(factKey(fact)) && selected.length >= 100) { setError("За одно действие можно выбрать до 100 условий."); return; } setSelected((previous) => checked ? [...new Set([...previous, factKey(fact)])] : previous.filter((key) => key !== factKey(fact))); }} />{conditionLabels[fact.category] || "Условие"}{fact.ambiguous ? " · проверьте исключения / контекст" : ""}</label><blockquote>{fact.quote}</blockquote><small>{fact.sourceName} · {fact.locator}</small></div>)}
        </section>
        {item.destination === "proposals" && <section><h4>Артикулы и полные составы ({positions.length} / {configurations.length})</h4><p className="help-text">Один артикул — одна комплектация. Если таблица и состав разделены, сопоставьте их по оригиналу: порядок блоков не является доказательством связи.</p>
          {positions.map((fact) => <div className="iw-source-fact-row" key={fact.id}><strong>{fact.sku}{fact.ambiguous ? " · связь с составом требует проверки" : ""}</strong><Quote fact={fact} /></div>)}
          {configurations.map((fact) => <details className="iw-source-fact-row" key={fact.id}><summary>{fact.name || "Состав комплектации"} · компонентов: {fact.componentCount}</summary><blockquote>{fact.description}</blockquote><small>{fact.sourceName} · {fact.locator}</small></details>)}
          {positions.length > 0 && configurations.length > 0 && <div className="iw-source-position-map">
            <label>Позиция КП<select aria-label="Куда назначить артикул и состав" value={positionIndex} onChange={(event) => setPositionIndex(Number(event.target.value))}><option value={-1}>Добавить новую позицию</option>{names.map((name, index) => <option value={index} key={index}>{index + 1}. {name}</option>)}</select></label>
            <label>Артикул из источника<select aria-label="Артикул для сопоставления" value={skuId} onChange={(event) => setSkuId(event.target.value)}><option value="">Выберите артикул</option>{positions.map((fact) => <option value={fact.id} key={fact.id}>{fact.sku} · {fact.sourceName}</option>)}</select></label>
            <label>Полный состав из источника<select aria-label="Состав для сопоставления" value={configurationId} onChange={(event) => setConfigurationId(event.target.value)}><option value="">Выберите состав по оригиналу</option>{configurations.map((fact, index) => <option value={fact.id} key={fact.id}>{index + 1}. {fact.name || "Состав"} · {fact.componentCount} компонентов · {fact.description.slice(0, 90)}</option>)}</select></label>
            <button type="button" className="secondary" disabled={!skuId || !configurationId} onClick={() => apply(() => { const sku = positions.find((fact) => fact.id === skuId), configuration = configurations.find((fact) => fact.id === configurationId); if (!sku || !configuration) throw new Error("Повторно выберите артикул и состав."); return repairPositionFromSources(item, positionIndex, skuId, configurationId, sources, { skuQuote: sku.quote, configurationQuote: configuration.quote, description: configuration.description }); })}>Применить выбранный артикул и полный состав</button>
          </div>}
        </section>}
      </>}
    </div>}
  </details>;
}
