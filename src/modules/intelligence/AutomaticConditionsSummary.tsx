import type { AutoConditionResult } from "./automaticConditions";
import type { IntelligenceItem } from "./workbenchTypes";

type Receipt = Omit<AutoConditionResult, "items">;
const categoryLabel = { certificate: "Сертификат", document: "Документ / условие заявки", exception: "Оговорка к документам", license: "Лицензионное условие", quantity: "Количество / объём", payment: "Оплата", delivery: "Поставка / исполнение", requirement: "Требование" };
export function AutomaticConditionsSummary({ receipt, items }: { receipt: Receipt | null; items: IntelligenceItem[] }) {
  const procurement = items.filter((item) => item.destination === "procurement");
  // This receipt concerns procurement requirements, not actual staff
  // certificates. A historical/global skip must not leak into a staff-only task.
  if (!receipt || !procurement.length) return null;
  const ids = new Set(procurement.map((item) => item.id));
  const changes = receipt.changes.filter((change) => ids.has(change.itemId));
  const skipped = receipt.skipped.filter((entry) => !entry.itemId && !entry.itemIds?.length || Boolean(entry.itemId && ids.has(entry.itemId)) || entry.itemIds?.some((id) => ids.has(id)));
  if (!changes.length && !skipped.length && !receipt.limited) return null;
  const added = changes.filter((entry) => entry.kind === "added"), present = changes.length - added.length;
  return <div className="iw-automatic-conditions">
    <p className="help-text" role="status">Из источников автоматически добавлено: {added.length} · уже было: {present}.{skipped.length ? ` Не дополнено автоматически: ${skipped.length}.` : ""}</p>
    {(receipt.limited || skipped.length > 0) && <p className="notice warning" role="status">Автодополнение неполное. Есть ограничения или неоднозначная принадлежность условий — проверьте подробности и исходники. Это не подтверждение полноты.</p>}
    <details><summary>Что добавлено автоматически и откуда{skipped.length ? ` · требуют проверки: ${skipped.length}` : ""}</summary>
      <p className="help-text">Журнал подготовки черновика. Формулировки, числа и исключения перенесены дословно; применимость условий нужно проверить. Исходный ответ модели не изменён. Последующие ручные правки видны в полях и проверке результата ниже. Сертификаты и документы не становятся прикреплёнными файлами или подтверждёнными сведениями.</p>
      {changes.map((entry, index) => <div className="iw-source-fact-row" key={`change-${index}`}><strong>{entry.kind === "added" ? "Добавлено при подготовке" : "Уже было в ответе"} · {categoryLabel[entry.category]}</strong><small>{items.find((item) => item.id === entry.itemId)?.title} · {entry.sourceName} · {entry.locator}</small><blockquote>{entry.quote}</blockquote></div>)}
      {skipped.map((entry, index) => <div className="iw-source-fact-row" key={`skip-${index}`}><strong>Не дополнено автоматически</strong><p>{entry.message}</p>{entry.sourceName && <small>{entry.sourceName} · {entry.locator}</small>}{entry.quote && <blockquote>{entry.quote}</blockquote>}</div>)}
    </details>
  </div>;
}
