import type { IntelligenceItem } from "./workbenchTypes";

/** A readable draft, not a rendered export or an approval of its conditions. */
export function ProposalContentPreview({ item }: { item: IntelligenceItem }) {
  const value = (key: string) => item.selectedFields.includes(key) ? item.fields[key] : undefined;
  const text = (key: string) => typeof value(key) === "string" ? value(key) as string : "";
  const lines = Array.isArray(value("lines")) ? value("lines") as string[] : [];
  const descriptions = Array.isArray(value("lineDescriptions")) ? value("lineDescriptions") as string[] : [];
  return <article className="iw-proposal-preview" aria-label="Содержание черновика КП">
    <p className="help-text">Содержание черновика. Оформленный DOCX/PDF проверяется в редакторе КП перед выгрузкой.</p>
    <h3>{text("title") || item.title}</h3>
    <dl><dt>Исполнитель</dt><dd>{text("issuerName") || "Не установлен"}</dd><dt>Заказчик</dt><dd>{text("recipientName") || "Не установлен"}</dd></dl>
    {text("introduction") && <section><h4>Что предлагаем</h4><p>{text("introduction")}</p></section>}
    {lines.length > 0 && <section><h4>Состав предложения</h4>{lines.map((line, index) => <div key={index}><h5>{line}</h5><p>{descriptions[index] || "Описание не подготовлено"}</p></div>)}</section>}
    {text("conclusion") && <section><h4>Дополнительный состав и результаты</h4><p>{text("conclusion")}</p></section>}
    {text("deliveryTerms") && <section><h4>Сроки и условия выполнения</h4><p>{text("deliveryTerms")}</p></section>}
    {text("paymentTerms") && <section><h4>Оплата</h4><p>{text("paymentTerms")}</p></section>}
    {Boolean(item.proposalSourceFinancials?.length) && <section><h4>Цена в источнике — ещё не цена нового КП</h4>{item.proposalSourceFinancials!.map((candidate) => <p key={candidate.id}>{candidate.gross ?? candidate.net ?? candidate.unitPrice} {candidate.currency}{candidate.tax.kind === "vat" ? ` · НДС ${candidate.tax.rate}%` : candidate.tax.kind === "none" ? " · без НДС" : " · НДС требует проверки"}. Применение к этому проекту подтверждается в редакторе КП.</p>)}</section>}
    {text("internalNote") && <details><summary>Внутренняя заметка — не выгружается</summary><p>{text("internalNote")}</p></details>}
  </article>;
}
