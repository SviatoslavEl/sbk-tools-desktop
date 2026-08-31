export type OutputPageMode = "all" | "range";

export interface OutputBlockDefinition {
  id: string;
  name: string;
  pageRange: string;
}

export interface OutputPageBlock {
  id: string;
  name: string;
  fileName: string;
  order: number[];
}

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

export function safeOutputBlockName(value: string): string {
  return value.trim().replace(/\.pdf$/i, "").replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ").replace(/\s+/g, " ").replace(/[. ]+$/g, "");
}

export function buildOutputPageBlocks(
  currentOrder: number[],
  definitions: OutputBlockDefinition[],
  pageCount: number,
): OutputPageBlock[] {
  if (!definitions.length) throw new OutputPageRangeError("Добавьте хотя бы один блок страниц.");
  const usedNames = new Set<string>();
  return definitions.map((definition, index) => {
    const name = definition.name.trim();
    if (!name) throw new OutputPageRangeError(`Укажите название блока ${index + 1}.`);
    const fileName = safeOutputBlockName(name);
    if (!fileName) throw new OutputPageRangeError(`Название блока ${index + 1} не содержит допустимых символов.`);
    const nameKey = fileName.toLocaleLowerCase("ru-RU");
    if (usedNames.has(nameKey)) throw new OutputPageRangeError(`Название «${fileName}» используется повторно.`);
    usedNames.add(nameKey);
    return {
      id: definition.id,
      name,
      fileName,
      order: buildOutputPageOrder(currentOrder, "range", definition.pageRange, pageCount),
    };
  });
}
