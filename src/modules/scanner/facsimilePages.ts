export type FacsimileApplication = "current" | "all" | "explicitPages";

export type FacsimilePageSelection = {
  application: FacsimileApplication;
  pages: number[];
};

export class FacsimilePageRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FacsimilePageRangeError";
  }
}

export function parseFacsimilePages(
  applyTo: "current" | "all" | "range",
  pageRange: string,
  currentPageIndex: number,
  pageCount: number,
): FacsimilePageSelection {
  if (!Number.isInteger(pageCount) || pageCount < 1) {
    throw new FacsimilePageRangeError("Сначала дождитесь определения количества страниц документа.");
  }
  if (applyTo === "all") return { application: "all", pages: [] };
  if (applyTo === "current") {
    if (!Number.isInteger(currentPageIndex) || currentPageIndex < 0 || currentPageIndex >= pageCount) {
      throw new FacsimilePageRangeError("Текущая страница находится вне документа.");
    }
    return { application: "current", pages: [currentPageIndex] };
  }
  if (!pageRange.trim()) {
    throw new FacsimilePageRangeError("Укажите страницы, например: 1-3, 5.");
  }
  const pages = new Set<number>();
  for (const rawPart of pageRange.split(",")) {
    const part = rawPart.trim();
    const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part);
    if (!match) throw new FacsimilePageRangeError(`Некорректный фрагмент диапазона: «${part || "пусто"}».`);
    const start = Number(match[1]);
    const end = Number(match[2] || match[1]);
    if (start < 1 || end < 1) throw new FacsimilePageRangeError("Нумерация страниц начинается с 1.");
    if (end < start) throw new FacsimilePageRangeError(`Обратный диапазон ${start}-${end} недопустим.`);
    if (end > pageCount) throw new FacsimilePageRangeError(`В документе только ${pageCount} стр.; страница ${end} отсутствует.`);
    for (let page = start; page <= end; page += 1) pages.add(page - 1);
  }
  if (!pages.size) throw new FacsimilePageRangeError("Диапазон не содержит ни одной страницы.");
  return { application: "explicitPages", pages: [...pages].sort((left, right) => left - right) };
}
