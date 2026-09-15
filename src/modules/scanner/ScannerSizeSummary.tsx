import type { ReactNode } from "react";

export interface ScannerResultSize {
  inputPath: string;
  resultPath: string;
  kind: "single" | "split";
  originalBytes: number;
  outputBytes: number | null;
  fileCount: number;
}

export function positiveFileBytes(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** Never report a partial sum as the total size of a completed group of files. */
export function totalScannerOutputBytes(files: readonly (number | undefined)[]): number | null {
  if (!files.length || files.some((bytes) => positiveFileBytes(bytes) === null)) return null;
  return positiveFileBytes(files.reduce<number>((sum, bytes) => sum + bytes!, 0));
}

interface ScannerSizeSummaryProps {
  inputPath: string;
  resultPath: string;
  resultKind: "single" | "split" | "batch" | "";
  originalBytes: number;
  estimatedOutputBytes: number;
  savedResult: ScannerResultSize | null;
  children?: ReactNode;
}

export function scannerSizeSummary(props: ScannerSizeSummaryProps) {
  const completed = Boolean(props.resultPath) && (props.resultKind === "single" || props.resultKind === "split");
  const saved = props.savedResult;
  const matching = completed && saved?.inputPath === props.inputPath
    && saved.resultPath === props.resultPath && saved.kind === props.resultKind ? saved : null;
  const originalBytes = positiveFileBytes(matching?.originalBytes ?? props.originalBytes);
  const outputBytes = positiveFileBytes(completed ? matching?.outputBytes : props.estimatedOutputBytes);
  const savingsPercent = originalBytes && outputBytes ? (1 - outputBytes / originalBytes) * 100 : null;
  return { completed, originalBytes, outputBytes, savingsPercent, fileCount: matching?.fileCount };
}

export function ScannerSizeSummary(props: ScannerSizeSummaryProps) {
  const summary = scannerSizeSummary(props);
  const size = (bytes: number | null, missing: string) => bytes ? `${(bytes / 1024 / 1024).toFixed(1)} МБ` : missing;
  const label = !summary.completed ? "Оценка результата" : props.resultKind === "split"
    ? `Общий размер сохранённых блоков${summary.fileCount ? ` (${summary.fileCount} PDF)` : ""}`
    : "Размер сохранённого PDF";
  return <div className="scanner-estimate">
    <span>Исходный размер: {size(summary.originalBytes, "считается")}</span>
    <span>{label}: {!summary.completed && summary.outputBytes ? "≈ " : ""}{size(summary.outputBytes, summary.completed ? "не получен" : "рассчитывается")}</span>
    {summary.savingsPercent !== null && <span className={summary.savingsPercent >= 0 ? "estimate-good" : "estimate-warning"}>
      {summary.savingsPercent >= 0 ? "Меньше" : "Больше"} {summary.completed ? "" : "примерно "}на {Math.abs(summary.savingsPercent).toFixed(0)}%
    </span>}
    {summary.completed && props.resultKind === "split" && <span>Сумма всех блоков сравнивается с полным исходным документом.</span>}
    {props.children}
  </div>;
}
