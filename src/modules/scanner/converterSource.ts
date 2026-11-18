import { scannerSourceExtensions, scannerSourceType } from "./scannerSource";

export const converterSourceExtensions = [
  ...scannerSourceExtensions,
  "jfif", "heic", "heif", "hif", "tif", "tiff", "bmp", "dib", "webp", "gif", "ico", "tga", "pcx", "pbm", "pgm", "ppm", "pnm",
];

const extensions = new Set(converterSourceExtensions);
export const converterSourceFormats = "PDF, DOCX, JPEG, PNG, HEIC/HEIF, TIFF, BMP, WebP, GIF, ICO, TGA, PCX и PNM";

export function converterSourceMatches(path: string, format: string) {
  const kind = /\.jfif$/i.test(path) ? "JPEG" : scannerSourceType(path);
  return kind === format;
}

export function converterSourcePaths(paths: string[]) {
  const unique = [...new Set(paths)];
  const unsupported = unique.find((path) => !extensions.has(path.match(/\.([a-z]+)$/i)?.[1]?.toLowerCase() || ""));
  if (unsupported !== undefined) {
    const name = unsupported.split(/[\\/]/).pop() || unsupported;
    throw new Error(`Формат файла «${name}» не поддерживается. Доступны ${converterSourceFormats}.`);
  }
  if (unique.length > 100) throw new Error("Можно добавить до 100 исходных файлов за один раз.");
  return unique;
}
