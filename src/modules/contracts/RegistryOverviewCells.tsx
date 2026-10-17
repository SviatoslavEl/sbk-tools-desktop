import "./registry-overview.css";

/** Long registry values stay readable without making every row a paragraph. */
export function RegistryCellText({ text }: { text: string }) {
  const value = text || "—";
  if (value.length <= 90 && !value.includes("\n")) return <span className="registry-cell-text">{value}</span>;
  const summary = `${value.replace(/\s+/gu, " ").slice(0, 87).trimEnd()}…`;
  return <details className="registry-cell-disclosure" onDoubleClick={(event) => event.stopPropagation()}>
    <summary aria-label={`Показать полный текст: ${summary}`}><span>{summary}</span></summary>
    <div>{value}</div>
  </details>;
}

export function RegistryScrollHint({ id }: { id: string }) {
  return <p id={id} className="registry-scroll-hint">Дополнительные столбцы — прокрутка по горизонтали <span aria-hidden="true">↔</span>. Номер / имя и действия закреплены.</p>;
}
