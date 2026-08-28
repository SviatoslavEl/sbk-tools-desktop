export type OutputPageMode = "all" | "range";

export class OutputPageRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutputPageRangeError";
  }
}

export function parseOutputPages(mode: OutputPageMode, value: string, pageCount: number): number[] | null {
  if (!Number.isInteger(pageCount) || pageCount < 1) throw new OutputPageRangeError("Сначала дождитесь определения количества страниц документа.");
  if (mode === "all") return null;
  if (!value.trim()) throw new OutputPageRangeError("Укажите страницы итогового PDF, например: 1-3, 5.");
  const pages: number[] = [];
  const seen = new Set<number>();
  for (const rawPart of value.split(",")) {
    const part = rawPart.trim();
    const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part);
    if (!match) throw new OutputPageRangeError(`Некорректный фрагмент диапазона: «${part || "пусто"}».`);
    const start = Number(match[1]);
    const end = Number(match[2] || match[1]);
    if (start < 1 || end < 1) throw new OutputPageRangeError("Нумерация страниц начинается с 1.");
    if (end < start) throw new OutputPageRangeError(`Обратный диапазон ${start}-${end} недопустим.`);
    if (end > pageCount) throw new OutputPageRangeError(`В документе только ${pageCount} стр.; страница ${end} отсутствует.`);
    for (let page = start; page <= end; page += 1) {
      const index = page - 1;
      if (seen.has(index)) throw new OutputPageRangeError(`Страница ${page} указана повторно.`);
      seen.add(index);
      pages.push(index);
    }
  }
  return pages;
}

export function buildOutputPageOrder(currentOrder: number[], mode: OutputPageMode, value: string, pageCount: number): number[] {
  void pageCount;
  const selected = parseOutputPages(mode, value, currentOrder.length);
  if (selected === null) return [...currentOrder];
  return selected.map((position) => currentOrder[position]);
}
