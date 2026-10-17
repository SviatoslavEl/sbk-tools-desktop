import { facsimilePreviewGeometry, positionFacsimileInRegion, type FacsimilePlacementPayload, type FacsimilePreviewMetrics } from "./facsimilePreview";

/** Read-only physical dimensions of the image before rotation, not its bounding
 * rectangle. The requested width remains untouched in the document settings. */
export function fittedFacsimileSize(placement: FacsimilePlacementPayload, pageIndex: number, pageSizeMm: [number, number], imageAspect: number) {
  if (![...pageSizeMm, imageAspect].every((value) => Number.isFinite(value) && value > 0)) return null;
  const metrics: FacsimilePreviewMetrics = { pageAspect: pageSizeMm[0] / pageSizeMm[1], imageAspect };
  const displayed = facsimilePreviewGeometry(positionFacsimileInRegion(placement, pageIndex), metrics);
  const requestedWidthMm = placement.width * pageSizeMm[0];
  return { requestedWidthMm, widthMm: displayed.width * pageSizeMm[0], heightMm: displayed.height * pageSizeMm[1], reduced: displayed.width < placement.width - 1e-6 };
}

export function FacsimileFitSummary({ placement, pageIndex, pageSizeMm, imageAspect }: { placement: FacsimilePlacementPayload; pageIndex: number; pageSizeMm: [number, number] | null; imageAspect: number }) {
  if (!placement.region || !pageSizeMm) return null;
  const size = fittedFacsimileSize(placement, pageIndex, pageSizeMm, imageAspect);
  if (!size) return null;
  const number = (value: number) => new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 }).format(value);
  return <p className="help-text facsimile-fit-summary" role="status">
    На стр. {pageIndex + 1}: ≈ {number(size.widthMm)} × {number(size.heightMm)} мм{size.reduced ? " · уменьшено до области" : " · без уменьшения"}.
    <small> Задано по ширине: {number(size.requestedWidthMm)} мм. Размер изображения указан без рамки поворота; на других страницах вписывание может отличаться.</small>
  </p>;
}
