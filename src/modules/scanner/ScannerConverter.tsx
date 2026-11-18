import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState, type FormEvent, type RefObject } from "react";
import { trackedOperation } from "../../lib/activity";
import { chooseDirectory, chooseOpenPaths } from "../../lib/files";
import { invoke } from "../../lib/networkDiagnostics";
import { converterSourceExtensions, converterSourceFormats, converterSourceMatches, converterSourcePaths } from "./converterSource";
import { ScannerSingleFlight, subscribeScannerProgress } from "./scannerAsyncOperations";
import type { ScannerProgress } from "./scannerOperationState";

const formats = { pdf: "PDF", jpeg: "JPEG", png: "PNG" } as const;
type Format = keyof typeof formats;
interface Outcome { paths?: string[]; warnings?: string[]; error?: string }

function displayName(path: string) {
  return path.split(/[\\/]/).pop() || path;
}

export function ScannerConverter({ active, blocked, busy, onBusyChange, dropHandler }: {
  active: boolean;
  blocked: boolean;
  busy: boolean;
  onBusyChange: (busy: boolean) => void;
  dropHandler: RefObject<(paths: string[]) => void>;
}) {
  const [paths, setPaths] = useState<string[]>([]);
  const [format, setFormat] = useState<Format>("pdf");
  const [dpi, setDpi] = useState(150);
  const [directory, setDirectory] = useState("");
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  const [error, setError] = useState("");
  const [completedCount, setCompletedCount] = useState(0);
  const [pageProgress, setPageProgress] = useState<ScannerProgress | null>(null);
  const currentJob = useRef("");
  const gate = useRef(new ScannerSingleFlight());
  const matching = (path: string) => converterSourceMatches(path, formats[format]);
  const queue = paths.filter((path) => !matching(path));
  const resultCount = Object.values(outcomes).reduce((count, outcome) => count + (outcome.paths?.length || 0), 0);

  const append = (newPaths: string[]) => {
    if (blocked || gate.current.busy || !newPaths.length) return;
    try {
      setPaths(converterSourcePaths([...paths, ...newPaths]));
      setError("");
    } catch (reason) { setError(String(reason)); }
  };

  useEffect(() => {
    dropHandler.current = append;
  });

  useEffect(() => subscribeScannerProgress(active && "__TAURI_INTERNALS__" in window, () =>
    listen<{ jobId: string; event: { type: string } & ScannerProgress }>("scanner-progress", ({ payload }) => {
      if (currentJob.current === payload.jobId && payload.event.type === "progress") setPageProgress(payload.event);
    }), () => undefined), [active]);

  const selectFiles = async () => {
    try { append(await chooseOpenPaths("Выберите файлы для конвертации", converterSourceExtensions)); }
    catch (reason) { setError(`Не удалось выбрать файлы. ${String(reason)}`); }
  };

  const selectDirectory = async () => {
    try {
      const selected = await chooseDirectory("Выберите папку для результатов конвертации");
      if (selected && !gate.current.busy) { setDirectory(selected); setOutcomes({}); setError(""); }
    } catch (reason) { setError(`Не удалось выбрать папку. ${String(reason)}`); }
  };

  const convert = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (blocked || busy || !directory || !queue.length) return;
    void gate.current.run(async () => {
      onBusyChange(true);
      setError("");
      setOutcomes({});
      setCompletedCount(0);
      try {
        for (const [index, path] of queue.entries()) {
          const jobId = crypto.randomUUID();
          currentJob.current = jobId;
          setPageProgress(null);
          try {
            const result = await trackedOperation("Конвертация файлов", () => invoke<{ outputPaths: string[]; warnings: string[] }>("scanner_run", {
              jobId, operation: "convert", config: { protocolVersion: 2, inputPath: path, outputDirectory: directory, outputFormat: format, dpi },
            }));
            setOutcomes((previous) => ({ ...previous, [path]: { paths: result.outputPaths, warnings: result.warnings } }));
          } catch (reason) {
            setOutcomes((previous) => ({ ...previous, [path]: { error: String(reason) } }));
          }
          setCompletedCount(index + 1);
        }
      } finally {
        currentJob.current = "";
        onBusyChange(false);
      }
    });
  };

  const openFolder = async () => {
    try { await invoke("open_scanner_output", { path: directory, reveal: false }); }
    catch (reason) { setError(`Файлы сохранены. Не удалось открыть папку. ${String(reason)}`); }
  };

  return <div className="scanner-converter" role="tabpanel" id="scanner-converter" aria-labelledby="scanner-converter-tab" hidden={!active}>
    <form onSubmit={convert} className="scanner-converter-form">
      <div className="scanner-converter-intro">
        <div><h2>Конвертер файлов</h2><p>{`Перетащите сюда файлы или выберите на компьютере. Доступны ${converterSourceFormats}.`}</p></div>
        <button type="button" className="secondary" onClick={() => void selectFiles()} disabled={blocked || busy}>Добавить файлы</button>
      </div>
      {paths.length > 0 && <ul className="scanner-converter-files" aria-label="Файлы для конвертации">{paths.map((path) => {
        const outcome = outcomes[path];
        return <li key={path}><div><strong title={path}>{displayName(path)}</strong>
          {matching(path) && <small>Уже в формате {formats[format]}</small>}
          {outcome?.error && <small className="scanner-converter-error">{outcome.error}</small>}
          {outcome?.paths && <small>{outcome.paths.length === 1 ? displayName(outcome.paths[0]) : `Сохранено файлов: ${outcome.paths.length}`}</small>}
          {!!outcome?.warnings?.length && <small>{outcome.warnings.join(" ")}</small>}
        </div><button type="button" className="secondary small" aria-label={`Убрать ${displayName(path)}`} disabled={busy} onClick={() => {
          setPaths((previous) => previous.filter((item) => item !== path));
          setOutcomes(({ [path]: removed, ...rest }) => rest);
        }}>Убрать</button></li>;
      })}</ul>}
      <div className="scanner-converter-options">
        <label>Формат результата<select value={format} disabled={busy} onChange={(event) => { setFormat(event.target.value as Format); setOutcomes({}); }}>
          {Object.entries(formats).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></label>
        {format !== "pdf" && <label>Разрешение страниц<select value={dpi} disabled={busy} onChange={(event) => { setDpi(Number(event.target.value)); setOutcomes({}); }}>
          <option value="150">150 dpi</option><option value="300">300 dpi</option>
        </select></label>}
      </div>
      {format === "pdf" ? <p className="help-text">Страницы TIFF и кадры анимации сохраняются в одном PDF.</p>
        : <p className="help-text">Каждая страница или кадр сохраняется отдельным изображением. DPI применяется к PDF и DOCX.</p>}
      <div className="scanner-converter-directory"><div><strong>Папка сохранения</strong><small title={directory}>{directory || "Папка не выбрана"}</small></div>
        <button type="button" className="secondary" disabled={blocked || busy} onClick={() => void selectDirectory()}>Выбрать папку</button>
      </div>
      {error && <p className="notice error" role="alert">{error}</p>}
      {busy && <div role="status" className="scanner-converter-progress">
        <span>Файл {Math.min(completedCount + 1, queue.length)} из {queue.length}{pageProgress?.totalPages ? ` · Страницы ${pageProgress.currentPage} из ${pageProgress.totalPages}` : ""}</span>
        <progress aria-label="Ход конвертации" value={completedCount + (pageProgress?.percent || 0) / 100} max={queue.length} />
      </div>}
      <div className="button-row scanner-converter-actions">
        <button type="submit" className="primary" disabled={blocked || busy || !queue.length || !directory}>Конвертировать</button>
        {resultCount > 0 && <button type="button" className="secondary" onClick={() => void openFolder()}>Открыть папку</button>}
        {!busy && resultCount > 0 && <span role="status">Сохранено файлов: {resultCount}</span>}
      </div>
    </form>
  </div>;
}
