import { useEffect, useRef, useState } from "react";
import { applyProposalQuotedText, previewProposalQuotedText } from "./proposalQuotedText";
import type { SourceRepair } from "./sourceRepairs";
import type { IntelligenceItem, IntelligenceSource } from "./workbenchTypes";

interface Props {
  item: IntelligenceItem; field: string; label: string; sources: IntelligenceSource[];
  disabled?: boolean; onApply: (patch: SourceRepair) => void;
}
interface Review {
  item: IntelligenceItem; field: string; sources: IntelligenceSource[];
  preview?: ReturnType<typeof previewProposalQuotedText>; error?: string;
  previousValue?: string;
}

/** Explicit, RAM-only quotation repair. Neither preview nor apply is a model
 * verdict, a source completeness check, a saved record or an approval. */
export function ProposalQuotedTextRepair({ item, field, label, sources, disabled, onApply }: Props) {
  const [review, setReview] = useState<Review | null>(null);
  const activeReview = useRef<Review | null>(null);
  const live = useRef({ item, field, sources, disabled });
  live.current = { item, field, sources, disabled };
  if (disabled) activeReview.current = null;
  const cancel = () => { activeReview.current = null; setReview(null); };
  // Release the captured bounded source bytes as soon as the draft changes;
  // merely hiding an obsolete preview would keep its private snapshot in RAM.
  useEffect(() => { cancel(); }, [item, field, sources, disabled]);
  useEffect(() => () => { activeReview.current = null; }, []);
  const current = review?.item === item && review.field === field && review.sources === sources ? review : null;
  if (item.destination !== "proposals" || !["introduction", "conclusion", "paymentTerms", "deliveryTerms"].includes(field)
    || !item.evidence?.some(claim => claim.field === field)) return null;
  const show = () => {
    if (live.current.disabled || live.current.item !== item || live.current.field !== field || live.current.sources !== sources) return;
    try {
      const preview = previewProposalQuotedText(item, field, sources);
      const value = item.fields[field];
      const next = { item, field, sources, preview, previousValue: typeof value === "string" ? value : undefined };
      activeReview.current = next; setReview(next);
    } catch (reason) { activeReview.current = null; setReview({ item, field, sources, error: reason instanceof Error ? reason.message : "Не удалось проверить цитаты." }); }
  };
  const apply = () => {
    if (live.current.disabled || live.current.item !== item || live.current.field !== field || live.current.sources !== sources
      || !current?.preview || activeReview.current !== current) return;
    // Consume this explicit choice once, before parent callbacks can rerender.
    activeReview.current = null;
    try {
      onApply(applyProposalQuotedText(item, field, sources, { previousValue: current.previousValue, value: current.preview.value, sourceSnapshot: current.preview.sourceSnapshot }));
      setReview(null);
    } catch (reason) { setReview({ item, field, sources, error: reason instanceof Error ? reason.message : "Не удалось перенести цитаты." }); }
  };
  return <div className="iw-quoted-text-repair" role="group" aria-label={`Дословные цитаты: ${label}`}>
    {!current?.preview && <button type="button" className="secondary small" disabled={disabled} onClick={show}>Сверить поле с полными цитатами</button>}
    {current?.error && <p className="notice error" role="alert">{current.error}</p>}
    {current?.preview && <div className="iw-field-evidence unverified">
      <p>После замены в поле «{label}» попадут только приведённые ниже дословные цитаты. Текущий текст поля будет заменён; остальные поля и исходный ответ ИИ не изменятся.</p>
      <p className="help-text">Это публичное поле КП: не переносите внутренние и конфиденциальные сведения. Цитаты могут включать локальные дополнения. Они не доказывают полноту, смысловую связь или применимость условий к новому КП. Проверьте контекст и повторные замечания после замены.</p>
      {current.preview.evidence.map((entry, index) => <figure key={index}><figcaption>{entry.sourceName} · {entry.locator}</figcaption><blockquote>{entry.quote}</blockquote></figure>)}
      <div className="iw-actions"><button type="button" className="secondary" disabled={disabled || current.preview.value === item.fields[field]} onClick={apply}>Заменить поле дословными цитатами</button><button type="button" className="secondary" onClick={cancel}>Отмена замены</button></div>
    </div>}
  </div>;
}
