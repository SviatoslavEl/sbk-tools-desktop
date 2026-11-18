const inputTypes: Readonly<Record<string, "PDF" | "DOCX" | "JPEG" | "PNG">> = {
  pdf: "PDF", docx: "DOCX", jpg: "JPEG", jpeg: "JPEG", png: "PNG",
};

export const scannerSourceExtensions = Object.keys(inputTypes);
export const scannerSourceFormats = "PDF, DOCX, JPEG и PNG";

export function scannerSourceType(path: string) {
  const ext = path.match(/\.([a-z]+)$/i)?.[1]?.toLowerCase();
  return ext && Object.prototype.hasOwnProperty.call(inputTypes, ext) ? inputTypes[ext] : undefined;
}

export function scannerSourceStem(name: string) {
  return scannerSourceType(name) ? name.slice(0, name.lastIndexOf(".")) || name : name;
}
