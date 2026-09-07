export function droppedDocumentPaths(paths: string[]): string[] {
  if (!paths.length) throw new Error("Не удалось получить пути перетаскиваемых файлов.");
  const unique = [...new Set(paths)];
  if (unique.some((path) => !/\.(pdf|docx)$/i.test(path))) {
    throw new Error("В сканер можно перетащить только файлы PDF или DOCX. Для факсимиле используйте кнопку добавления факсимиле.");
  }
  return unique;
}
