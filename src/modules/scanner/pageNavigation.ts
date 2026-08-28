export interface PageWindow {
  pages: number[];
  omittedBefore: number;
  omittedAfter: number;
}

/** Keep large documents responsive by rendering a small window around the active page. */
export function buildPageWindow(pageOrder: number[], currentPage: number, radius = 8): PageWindow {
  if (pageOrder.length <= radius * 2 + 5) return { pages: [...pageOrder], omittedBefore: 0, omittedAfter: 0 };
  const position = Math.max(0, pageOrder.indexOf(currentPage));
  const start = Math.max(0, position - radius);
  const end = Math.min(pageOrder.length, position + radius + 1);
  return {
    pages: pageOrder.slice(start, end),
    omittedBefore: start,
    omittedAfter: pageOrder.length - end,
  };
}
