import type { PreviewPreparation } from "./scannerPreviewSession";

export function ScannerPreparationStatus({ pageCount, preparation }: { pageCount: number; preparation: PreviewPreparation }) {
  if (pageCount < 2) return null;
  return <div className="scanner-preparation-status" role="status" aria-live="polite">
    <span>В документе {pageCount} стр.</span>
    {preparation.state === "preparing" && <span><i className="loading-spinner" aria-hidden="true" />Готовим соседние страницы · {preparation.prepared}/{preparation.total}</span>}
    {preparation.state === "ready" && <span>Соседние страницы готовы · {preparation.prepared}</span>}
    {preparation.state === "unavailable" && <span>Страницы будут подготовлены при переходе</span>}
  </div>;
}
