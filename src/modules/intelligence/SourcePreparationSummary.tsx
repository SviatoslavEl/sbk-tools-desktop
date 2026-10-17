import { fieldDefinitions } from "./workbenchModel";
import type { SourcePreparationReceipt } from "./responsePreparationWorker";
import type { IntelligenceFieldValue, IntelligenceItem } from "./workbenchTypes";

const display = (value: IntelligenceFieldValue) => Array.isArray(value) ? value.join("\n") : String(value);
const kinds = { added: "Добавлено из источника", replaced: "Уточнено по источнику", created: "Новый несохранённый черновик", quarantined: "Исключено из передачи", deduplicated: "Свёрнуты точные повторы" };
export function SourcePreparationSummary({ receipt, items }: { receipt: SourcePreparationReceipt | null; items: IntelligenceItem[] }) {
  if (!receipt || !items.length) return null;
  const ids = new Set(items.map((item) => item.id));
  const changes = receipt.changes.filter((entry) => ids.has(entry.itemId));
  const skipped = receipt.skipped.filter((entry) => !entry.itemId || ids.has(entry.itemId));
  if (!changes.length && !skipped.length && !receipt.limited) return null;
  const created = changes.filter((entry) => entry.kind === "created").length;
  const quarantined = changes.filter((entry) => entry.kind === "quarantined").length;
  const duplicates = changes.reduce((total, entry) => total + (entry.kind === "deduplicated" ? entry.previousValue.length - entry.value.length : 0), 0);
  return <div className="iw-automatic-conditions iw-source-preparation">
    <p className="help-text" role="status">Подготовка по исходникам: новых черновиков — {created}, уточнений — {changes.filter((entry) => entry.kind === "added" || entry.kind === "replaced").length}.{duplicates ? ` Свёрнуто повторов требований: ${duplicates}.` : ""}</p>
    {quarantined > 0 && <p className="notice warning" role="status">Неподтверждённые значения исключены из передачи: {quarantined}. Они оставлены в полях без отметок. Проверьте журнал и исходники, прежде чем выбирать их снова.</p>}
    {(skipped.length > 0 || receipt.limited) && <p className="notice warning" role="status">Часть сведений нельзя распределить автоматически. Полнота результата не подтверждена; проверьте пропуски в журнале.</p>}
    <details><summary>Журнал уточнений и исключённых значений ({changes.length + skipped.length})</summary>
      <p className="help-text">Это история подготовки, не подтверждение правильности или полноты. Исходный ответ модели не изменён. Карточки не сохранены в базе; последующие ручные правки видны ниже.</p>
      {changes.map((entry, index) => {
        const item = items.find((candidate) => candidate.id === entry.itemId)!;
        const label = fieldDefinitions[item.destination].find((field) => field.key === entry.field)?.label || "Карточка";
        return <div className="iw-source-fact-row" key={`change-${index}`}><strong>{kinds[entry.kind]} · {label}</strong><small>{item.title}{entry.kind !== "deduplicated" ? ` · ${entry.sourceName} · ${entry.locator}` : ""}</small>
          {entry.kind !== "deduplicated" && <blockquote>{entry.quote}</blockquote>}
          {entry.previousValue !== undefined && <details><summary>Было в ответе модели</summary><pre>{display(entry.previousValue)}</pre></details>}
          {entry.value !== undefined && <details><summary>После подготовки</summary><pre>{display(entry.value)}</pre></details>}
        </div>;
      })}
      {skipped.map((entry, index) => <div className="iw-source-fact-row" key={`skip-${index}`}><strong>Нужно проверить вручную</strong><p>{entry.message}</p>{entry.sourceName && <small>{entry.sourceName} · {entry.locator}</small>}{entry.quote && <blockquote>{entry.quote}</blockquote>}</div>)}
    </details>
  </div>;
}
