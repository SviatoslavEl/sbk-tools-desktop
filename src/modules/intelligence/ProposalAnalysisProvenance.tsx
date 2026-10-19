import { useMemo, useState } from "react";
import { validProposalQuoteProvenance, type ProposalQuoteProvenance } from "./proposalQuotePreparation";
import type { ProposalQuoteRole } from "./proposalQuotePlan";
import "./proposal-analysis-provenance.css";

const roleLabels: Record<ProposalQuoteRole, string> = {
  subject: "Предмет", scope: "Состав работ", deliverable: "Результат", perimeter: "Границы объекта",
  "customer-input": "Материалы заказчика", payment: "Оплата", schedule: "Сроки", dependency: "Зависимости",
  exclusion: "Исключения", party: "Стороны", financial: "Исходные финансовые сведения", context: "Контекст",
};

/** A private, historical receipt, never a freshness, authenticity or readiness
 * gate. Large raw answers/quotes are not mounted while their panels are closed. */
export function ProposalAnalysisProvenance({ value }: { value?: ProposalQuoteProvenance | null }) {
  const valid = useMemo(() => value === undefined || value === null || validProposalQuoteProvenance(value), [value]);
  const [openedFor, setOpenedFor] = useState<ProposalQuoteProvenance | null>(null);
  const [quotesFor, setQuotesFor] = useState<ProposalQuoteProvenance | null>(null);
  const [rawFor, setRawFor] = useState<ProposalQuoteProvenance | null>(null);
  if (!value) return null;
  if (!valid) return <p className="notice warning" role="status">Журнал участия ИИ повреждён. Он не подтверждает происхождение или готовность текущего КП.</p>;
  const opened = openedFor === value;
  return <details className="proposal-analysis-provenance" open={opened} onToggle={event => {
    setOpenedFor(event.currentTarget.open ? value : null);
    if (!event.currentTarget.open) { setQuotesFor(null); setRawFor(null); }
  }}>
    <summary>Участие ИИ · выбрано {value.counts.commercial} из {value.counts.units} фрагментов</summary>
    {opened && <div>
      <p className="help-text">Это журнал исходного запуска: модель выбирала темы и целые цитаты. Программа отдельно перенесла их в поля и могла дополнить результат из источника. Ручные правки после этого не проверены заново этим журналом.</p>
      <p className="help-text">Выбранные темы «Состав работ» и «Результат» пока сохранены для сверки в этом журнале. Позиции КП формируются отдельным разбором источника: их заполнение не означает, что модель перенесла все выбранные работы и результаты.</p>
      <p className="help-text">Справочный контекст — {value.counts.context}, назначение не определено — {value.counts.unclear}. Счётчики и точность цитат не доказывают правильность тем, полноту связей, применимость условий или согласование цены нового КП. Проверяйте содержание по оригиналу. Журнал не включается в клиентские DOCX/PDF и шаблоны.</p>
      <details open={quotesFor === value} onToggle={event => setQuotesFor(event.currentTarget.open ? value : null)}>
        <summary>Цитаты, выбранные моделью ({value.selections.length})</summary>
        {quotesFor === value && <div className="proposal-analysis-scroll">{value.selections.map(selection => <figure key={selection.unitId}>
          <figcaption>{selection.locator || "Фрагмент документа"} · {selection.roles.map(role => roleLabels[role]).join(" · ")}</figcaption>
          <blockquote>{selection.quote}</blockquote>
        </figure>)}</div>}
      </details>
      <details open={rawFor === value} onToggle={event => setRawFor(event.currentTarget.open ? value : null)}>
        <summary>Исходные ответы ИИ ({value.parts.length})</summary>
        {rawFor === value && <div className="proposal-analysis-scroll">{value.parts.map((part, index) => <section key={part.batchId}>
          <h5>Пакет {index + 1} · {part.model}</h5><pre>{part.raw}</pre>
        </section>)}</div>}
      </details>
    </div>}
  </details>;
}
