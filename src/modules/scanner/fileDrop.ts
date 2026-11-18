import { scannerSourceFormats, scannerSourceType } from "./scannerSource";

export function droppedDocumentPaths(paths: string[]): string[] {
  if (!paths.length) throw new Error("Не удалось получить пути перетаскиваемых файлов.");
  const unique = [...new Set(paths)];
  if (unique.some((path) => !scannerSourceType(path))) {
    throw new Error(`В сканер можно перетащить только файлы ${scannerSourceFormats}.`);
  }
  return unique;
}
