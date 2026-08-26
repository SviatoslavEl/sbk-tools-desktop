import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openPath } from "@tauri-apps/plugin-opener";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { useRecords } from "../../hooks/useRecords";
import { chooseDirectory, chooseOpenPath, chooseOpenPaths, chooseSavePath } from "../../lib/files";
import { copyAttachment, getWorkspaceInfo } from "../../lib/storage";
import { parseFacsimilePages } from "./facsimilePages";

const presets = [
  ["Оригинал", "Минимальная обработка"], ["Офисный скан", "Естественный офисный вид"],
  ["Чёткий ч/б", "Максимальная читаемость"], ["Мягкий ч/б", "Спокойные серые тона"],
  ["Цветной скан", "Цвет и лёгкая текстура"], ["Архивный", "Пожелтевшая бумага"],
  ["Контрастный", "Выраженный текст"], ["Экономичный", "Меньший итоговый файл"],
] as const;

interface FacsimileState {
  imagePath: string;
  imageUrl: string;
  fileName: string;
  x: number;
  y: number;
  width: number;
  rotation: number;
  opacity: number;
  removeLightBackground: boolean;
  applyTo: "current" | "all" | "range";
  pageRange: string;
}

interface ScannerRecord { kind: "facsimile-template" | "processing-journal"; relativePath?: string; fileName?: string; inputType?: string; pageCount?: number; preset?: string; ocr?: boolean; status?: string; durationMs?: number; outputSha256?: string; appliedOperations?: string[]; }
interface RedactionState { id: string; page: number; x: number; y: number; width: number; height: number; color: "black" | "white"; }

interface ProgressState { stage: string; currentPage: number; totalPages: number; percent: number }

const initialFacsimile = (path: string, url: string, fileName: string): FacsimileState => ({
  imagePath: path, imageUrl: url, fileName, x: 0.62, y: 0.72, width: 0.22, rotation: 0, opacity: 1,
  removeLightBackground: false, applyTo: "current", pageRange: "",
});

export function Scanner() {
  const templates = useRecords<ScannerRecord>("scanner");
  const [inputPath, setInputPath] = useState("");
  const [documentName, setDocumentName] = useState("");
  const [preset, setPreset] = useState("Офисный скан");
  const [pageIndex, setPageIndex] = useState(0);
  const [pageCount, setPageCount] = useState(0);
  const [pageOrder, setPageOrder] = useState<number[]>([]);
  const [pageRotations, setPageRotations] = useState<Record<number, number>>({});
  const [previewUrl, setPreviewUrl] = useState("");
  const [originalUrl, setOriginalUrl] = useState("");
  const [showOriginal, setShowOriginal] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [batchPaths, setBatchPaths] = useState<string[]>([]);
  const [previewAspect, setPreviewAspect] = useState(0.707);
  const [previewing, setPreviewing] = useState(false);
  const [ocrEnabled, setOcrEnabled] = useState(false);
  const [ocrLanguages, setOcrLanguages] = useState("rus+eng");
  const [pdfaEnabled, setPdfaEnabled] = useState(false);
  const [dpi, setDpi] = useState(200);
  const [quality, setQuality] = useState(84);
  const [facsimile, setFacsimile] = useState<FacsimileState | null>(null);
  const [savedFacsimiles, setSavedFacsimiles] = useState<Record<string, unknown>[]>([]);
  const [facsimilePreviewCommitted, setFacsimilePreviewCommitted] = useState(false);
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [activeJob, setActiveJob] = useState("");
  const [error, setError] = useState("");
  const [resultPath, setResultPath] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [estimatedOutputBytes, setEstimatedOutputBytes] = useState(0);
  const [pageSizeMm, setPageSizeMm] = useState<[number, number] | null>(null);
  const [ocrConfidence, setOcrConfidence] = useState<number | null>(null);
  const [ocrText, setOcrText] = useState("");
  const [lowConfidenceWords, setLowConfidenceWords] = useState<Array<{ page: number; text: string; confidence: number }>>([]);
  const [redactions, setRedactions] = useState<RedactionState[]>([]);
  const dragging = useRef(false);
  const latestPreviewJob = useRef("");
  const activeJobRef = useRef("");
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [facsimileRevision, setFacsimileRevision] = useState(0);
  const journal = templates.records.filter((record) => record.payload.kind === "processing-journal").slice(0, 10);

  useEffect(() => {
    let unsubscribe = () => {};
    void listen<{ jobId: string; event: { type: string } & ProgressState }>("scanner-progress", ({ payload }) => {
      if (payload.jobId === activeJobRef.current && payload.event.type === "progress") setProgress(payload.event);
    }).then((fn) => { unsubscribe = fn; });
    return () => unsubscribe();
  }, []);

  const facsimileSelection = useMemo(() => {
    if (!facsimile) return { selection: null, error: "" };
    try {
      return { selection: parseFacsimilePages(facsimile.applyTo, facsimile.pageRange, pageIndex, pageCount), error: "" };
    } catch (reason) {
      return { selection: null, error: reason instanceof Error ? reason.message : "Некорректный диапазон страниц." };
    }
  }, [facsimile, pageIndex, pageCount]);

  const workerFacsimile = facsimile && facsimileSelection.selection ? {
    imagePath: facsimile.imagePath, x: facsimile.x, y: facsimile.y, width: facsimile.width,
    rotation: facsimile.rotation, opacity: facsimile.opacity,
    removeLightBackground: facsimile.removeLightBackground,
    application: facsimileSelection.selection.application,
    pages: facsimileSelection.selection.pages,
  } : null;

  const makePreview = async (path = inputPath, selectedPreset = preset, selectedPage = pageIndex, includeFacsimile = true, rotations = pageRotations) => {
    if (!path) return;
    setPreviewing(true); setError("");
    if (latestPreviewJob.current) void invoke("scanner_cancel", { jobId: latestPreviewJob.current }).catch(() => undefined);
    const jobId = crypto.randomUUID();
    latestPreviewJob.current = jobId;
    let previewFacsimile = null;
    if (includeFacsimile && facsimile) {
      try {
        const selected = parseFacsimilePages(facsimile.applyTo, facsimile.pageRange, selectedPage, pageCount);
        previewFacsimile = { imagePath: facsimile.imagePath, x: facsimile.x, y: facsimile.y, width: facsimile.width, rotation: facsimile.rotation, opacity: facsimile.opacity, removeLightBackground: facsimile.removeLightBackground, application: selected.application, pages: selected.pages };
      } catch { /* The visible range error blocks export; keep the previous preview. */ }
    }
    try {
      const response = await invoke<{ outputPath: string; originalPath?: string; pageCount: number; warnings?: string[]; estimatedOutputBytes?: number; pageSizePoints?: [number, number] }>("scanner_run", {
        jobId, operation: "preview", config: { protocolVersion: 2, inputPath: path, preset: selectedPreset, pageIndex: selectedPage, seed: 42, settings: { dpi, jpeg_quality: quality }, facsimiles: [...savedFacsimiles, ...(previewFacsimile ? [previewFacsimile] : [])], pageRotations: rotations, redactions: redactions.map((entry) => ({ pages: [entry.page], x: entry.x, y: entry.y, width: entry.width, height: entry.height, color: entry.color })) },
      });
      if (latestPreviewJob.current !== jobId) return;
      setPageCount(response.pageCount);
      setPageOrder((current) => current.length && current.every((index) => index < response.pageCount) ? current : Array.from({ length: response.pageCount }, (_, index) => index));
      setEstimatedOutputBytes(response.estimatedOutputBytes || 0);
      setPageSizeMm(response.pageSizePoints ? response.pageSizePoints.map((value) => value * 25.4 / 72) as [number, number] : null);
      let url = "";
      try {
        url = await invoke<string>("read_binary_file", { path: response.outputPath, maxBytes: 24 * 1024 * 1024 });
      } finally {
        void invoke("delete_runtime_file", { path: response.outputPath }).catch(() => undefined);
      }
      if (latestPreviewJob.current !== jobId) return;
      setPreviewUrl(url);
      if (response.originalPath) {
        try { setOriginalUrl(await invoke<string>("read_binary_file", { path: response.originalPath, maxBytes: 24 * 1024 * 1024 })); }
        finally { void invoke("delete_runtime_file", { path: response.originalPath }).catch(() => undefined); }
      }
      setWarnings(response.warnings || []);
      setFacsimilePreviewCommitted(Boolean(previewFacsimile));
    } catch (reason) { if (latestPreviewJob.current === jobId) setError(String(reason)); }
    finally { if (latestPreviewJob.current === jobId) setPreviewing(false); }
  };

  const chooseDocument = async () => {
    const path = await chooseOpenPath("Выберите PDF или DOCX", ["pdf", "docx"]);
    if (!path) return;
    setInputPath(path); setDocumentName(path.split(/[\\/]/).pop() || path); setPageIndex(0); setPageOrder([]); setPageRotations({}); setResultPath(""); setWarnings([]); setFacsimile(null); setSavedFacsimiles([]); setRedactions([]); setOcrConfidence(null); setOcrText(""); setLowConfidenceWords([]); setFacsimilePreviewCommitted(false);
    await makePreview(path, preset, 0, false);
  };
  const chooseBatch = async () => {
    const paths = await chooseOpenPaths("Выберите PDF и DOCX для пакета", ["pdf", "docx"]);
    if (paths.length) { setBatchPaths(paths); setError(""); setResultPath(""); }
  };

  const processBatch = async () => {
    if (!batchPaths.length) return;
    const directory = await chooseDirectory("Выберите папку для обработанных PDF"); if (!directory) return;
    const separator = directory.includes("\\") ? "\\" : "/"; const startedAt = Date.now(); setError(""); setWarnings([]);
    for (const [index, path] of batchPaths.entries()) {
      const jobId = crypto.randomUUID(); setActiveJob(jobId); activeJobRef.current = jobId;
      setProgress({ stage: `Файл ${index + 1} из ${batchPaths.length}`, currentPage: 0, totalPages: 0, percent: Math.round(index / batchPaths.length * 100) });
      const name = (path.split(/[\\/]/).pop() || `документ-${index + 1}`).replace(/\.(pdf|docx)$/i, "");
      const outputPath = `${directory}${separator}${name} — обработано.pdf`;
      try { await invoke("scanner_run", { jobId, operation: "process", config: { protocolVersion: 2, inputPath: path, outputPath, preset, ocrEnabled, ocrLanguages, pdfaEnabled, seed: 42, settings: { dpi, jpeg_quality: quality }, pageOrder: [], redactions: [] } }); }
      catch (reason) { setError(`Файл ${index + 1}: ${String(reason)}`); await templates.save(`Пакет: ошибка ${new Date().toLocaleString("ru-RU")}`, { kind: "processing-journal", inputType: path.toLowerCase().endsWith(".docx") ? "DOCX" : "PDF", preset, ocr: ocrEnabled, status: "failed", durationMs: Date.now() - startedAt }).catch(() => undefined); setActiveJob(""); activeJobRef.current = ""; return; }
    }
    setActiveJob(""); activeJobRef.current = ""; setProgress({ stage: "Пакет готов", currentPage: batchPaths.length, totalPages: batchPaths.length, percent: 100 });
    setResultPath(directory); await templates.save(`Пакет ${new Date().toLocaleString("ru-RU")}`, { kind: "processing-journal", inputType: "BATCH", pageCount: batchPaths.length, preset, ocr: ocrEnabled, status: "completed", durationMs: Date.now() - startedAt });
  };

  const chooseFacsimile = async () => {
    const path = await chooseOpenPath("Выберите факсимиле", ["png", "jpg", "jpeg"]);
    if (!path) return;
    const imageUrl = await invoke<string>("read_binary_file", { path, maxBytes: 12 * 1024 * 1024 });
    setFacsimile(initialFacsimile(path, imageUrl, path.split(/[\\/]/).pop() || "Факсимиле")); setFacsimilePreviewCommitted(false);
  };

  const useTemplate = async (template: ScannerRecord) => {
    if (!template.relativePath || !template.fileName) return;
    const workspace = await getWorkspaceInfo();
    const separator = workspace.root.includes("\\") ? "\\" : "/";
    const path = `${workspace.root}${separator}${template.relativePath.replace(/\//g, separator)}`;
    const imageUrl = await invoke<string>("read_binary_file", { path, maxBytes: 12 * 1024 * 1024 });
    setFacsimile(initialFacsimile(path, imageUrl, template.fileName)); setFacsimilePreviewCommitted(false);
  };

  const saveFacsimileTemplate = async () => {
    if (!facsimile) return;
    const id = crypto.randomUUID();
    const attachment = await copyAttachment(facsimile.imagePath, "scanner", id);
    await templates.save(facsimile.fileName, { kind: "facsimile-template", relativePath: attachment.relativePath, fileName: attachment.fileName }, id);
  };

  const processDocument = async () => {
    if (!inputPath) return;
    if (facsimile && !facsimileSelection.selection) { setError(facsimileSelection.error); return; }
    if (facsimile?.applyTo === "all" && pageCount > 1 && !window.confirm(`Добавить факсимиле на все ${pageCount} страниц?`)) return;
    const base = documentName.replace(/\.(pdf|docx)$/i, "");
    const outputPath = await chooseSavePath("Сохранить обработанный PDF", `${base} — обработано.pdf`, ["pdf"]);
    if (!outputPath) return;
    const jobId = crypto.randomUUID(); setActiveJob(jobId); activeJobRef.current = jobId; setProgress({ stage: "Подготовка", currentPage: 0, totalPages: pageOrder.length, percent: 0 }); setError(""); setResultPath(""); setWarnings([]);
    const startedAt = Date.now();
    try {
      const response = await invoke<{ outputPath: string; outputSha256?: string; warnings?: string[]; ocrConfidence?: number | null; ocrText?: string; lowConfidenceWords?: Array<{ page: number; text: string; confidence: number }> }>("scanner_run", { jobId, operation: "process", config: { protocolVersion: 2, inputPath, outputPath, preset, ocrEnabled, ocrLanguages, pdfaEnabled, seed: 42, settings: { dpi, jpeg_quality: quality }, facsimiles: [...savedFacsimiles, ...(workerFacsimile ? [workerFacsimile] : [])], pageOrder, pageRotations, redactions: redactions.map((entry) => ({ pages: [entry.page], x: entry.x, y: entry.y, width: entry.width, height: entry.height, color: entry.color })) } });
      setResultPath(response.outputPath || outputPath); setWarnings(response.warnings || []); setOcrConfidence(response.ocrConfidence ?? null); setOcrText(response.ocrText || ""); setLowConfidenceWords(response.lowConfidenceWords || []); setProgress({ stage: "Готово", currentPage: pageOrder.length, totalPages: pageOrder.length, percent: 100 });
      const appliedOperations = [`Пресет: ${preset}`, `${dpi} dpi`, `Качество ${quality}%`, ...(ocrEnabled ? [`OCR ${ocrLanguages}`] : []), ...(pdfaEnabled ? ["PDF/A-2b"] : []), ...(savedFacsimiles.length || workerFacsimile ? [`Факсимиле: ${savedFacsimiles.length + (workerFacsimile ? 1 : 0)}`] : []), ...(redactions.length ? [`Скрытие областей: ${redactions.length}`] : []), ...(pageOrder.some((value, index) => value !== index) ? ["Изменён порядок страниц"] : []), ...(Object.values(pageRotations).some(Boolean) ? ["Поворот страниц"] : [])];
      await templates.save(`Обработка ${new Date().toLocaleString("ru-RU")}`, { kind: "processing-journal", inputType: inputPath.toLowerCase().endsWith(".docx") ? "DOCX" : "PDF", pageCount: pageOrder.length, preset, ocr: ocrEnabled, status: "completed", durationMs: Date.now() - startedAt, outputSha256: response.outputSha256, appliedOperations });
    } catch (reason) { setError(String(reason)); setProgress(null); await templates.save(`Ошибка ${new Date().toLocaleString("ru-RU")}`, { kind: "processing-journal", inputType: inputPath.toLowerCase().endsWith(".docx") ? "DOCX" : "PDF", pageCount: pageOrder.length, preset, ocr: ocrEnabled, status: "failed", durationMs: Date.now() - startedAt }).catch(() => undefined); }
    finally { setActiveJob(""); activeJobRef.current = ""; }
  };

  const cancel = async () => { if (activeJob) await invoke("scanner_cancel", { jobId: activeJob }); };

  const moveFacsimile = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragging.current || !facsimile) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(1 - facsimile.width, (event.clientX - bounds.left) / bounds.width - facsimile.width / 2));
    const y = Math.max(0, Math.min(0.94, (event.clientY - bounds.top) / bounds.height - 0.04));
    setFacsimile({ ...facsimile, x, y });
    setFacsimilePreviewCommitted(false);
  };

  const nudge = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!facsimile) return;
    const step = event.shiftKey ? 0.01 : 0.002;
    const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
    if (!delta) return;
    event.preventDefault(); setFacsimile({ ...facsimile, x: Math.max(0, Math.min(1 - facsimile.width, facsimile.x + delta[0])), y: Math.max(0, Math.min(0.95, facsimile.y + delta[1])) }); setFacsimilePreviewCommitted(false); setFacsimileRevision((value) => value + 1);
  };
  const moveCurrentPage = (direction: -1 | 1) => setPageOrder((current) => {
    const position = current.indexOf(pageIndex); const target = position + direction;
    if (position < 0 || target < 0 || target >= current.length) return current;
    const next = [...current]; [next[position], next[target]] = [next[target], next[position]]; return next;
  });
  const deleteCurrentPage = () => setPageOrder((current) => {
    if (current.length <= 1) { setError("В итоговом документе должна остаться хотя бы одна страница."); return current; }
    const position = current.indexOf(pageIndex); const next = current.filter((index) => index !== pageIndex); const selected = next[Math.min(Math.max(0, position), next.length - 1)];
    setPageIndex(selected); void makePreview(inputPath, preset, selected); return next;
  });
  const rotateCurrentPage = (degrees: -90 | 90) => setPageRotations((current) => {
    const next = ((current[pageIndex] || 0) + degrees + 360) % 360;
    const rotations = { ...current, [pageIndex]: next };
    void makePreview(inputPath, preset, pageIndex, true, rotations);
    return rotations;
  });

  useEffect(() => {
    if (facsimileRevision > 0 && inputPath && facsimileSelection.selection) void makePreview();
    // makePreview intentionally uses the latest component state after dragging ends.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [facsimileRevision]);

  const visibleOnCurrentPage = facsimile && facsimileSelection.selection
    && (facsimileSelection.selection.application === "all" || facsimileSelection.selection.pages.includes(pageIndex));
  return <div className="scanner-layout">
    <section className="surface scanner-controls"><div className="surface-title"><h2>Настройки</h2></div><div className="surface-body scanner-control-stack">
      <button className="primary full-width" type="button" onClick={() => void chooseDocument()}>{inputPath ? "Заменить файл" : "Выбрать PDF или DOCX"}</button><button className="secondary full-width" type="button" onClick={() => void chooseBatch()}>Пакетная обработка</button>{batchPaths.length > 0 && <div className="notice success"><span>Выбрано файлов: {batchPaths.length}</span><button className="primary small" type="button" onClick={() => void processBatch()}>Обработать пакет в папку</button></div>}{documentName && <p className="selected-file">▧ {documentName}</p>}
      <div><h3>Пресет</h3><div className="preset-grid">{presets.map(([name, description]) => <button key={name} className={preset === name ? "selected" : ""} type="button" onClick={() => { setPreset(name); void makePreview(inputPath, name, pageIndex); }}><strong>{name}</strong><small>{description}</small></button>)}</div></div>
      <div className="control-divider" /><div><div className="inline-heading"><h3>Факсимиле</h3>{facsimile && <button className="link-button danger" type="button" onClick={() => { setFacsimile(null); setFacsimilePreviewCommitted(false); void makePreview(inputPath, preset, pageIndex, false); }}>Удалить</button>}</div>{!facsimile ? <><button className="secondary full-width" type="button" onClick={() => void chooseFacsimile()}>Добавить факсимиле</button>{templates.records.filter((record) => record.payload.kind === "facsimile-template").length > 0 && <select aria-label="Шаблон факсимиле" defaultValue="" onChange={(event) => { const template = templates.records.find((record) => record.id === event.target.value); if (template) void useTemplate(template.payload); }}><option value="">Выбрать сохранённый шаблон</option>{templates.records.filter((record) => record.payload.kind === "facsimile-template").map((record) => <option key={record.id} value={record.id}>{record.title}</option>)}</select>}</> : <div className="facsimile-controls"><strong>{facsimile.fileName}</strong><label>Применить<select value={facsimile.applyTo} onChange={(event) => { setFacsimile({ ...facsimile, applyTo: event.target.value as FacsimileState["applyTo"] }); setFacsimilePreviewCommitted(false); setFacsimileRevision((value) => value + 1); }}><option value="current">к текущей странице</option><option value="range">к диапазону</option><option value="all">ко всем страницам</option></select></label>{facsimile.applyTo === "range" && <label>Страницы<input aria-invalid={!!facsimileSelection.error} value={facsimile.pageRange} placeholder="1-3, 5" onChange={(event) => { setFacsimile({ ...facsimile, pageRange: event.target.value }); setFacsimilePreviewCommitted(false); }} onBlur={() => setFacsimileRevision((value) => value + 1)} />{facsimileSelection.error && <small className="field-error">{facsimileSelection.error}</small>}</label>}<label>Размер <input type="range" min="8" max="60" value={facsimile.width * 100} onChange={(event) => { setFacsimile({ ...facsimile, width: Number(event.target.value) / 100 }); setFacsimilePreviewCommitted(false); }} onPointerUp={() => setFacsimileRevision((value) => value + 1)} /> {Math.round(facsimile.width * 100)}%{pageSizeMm ? ` · ${(pageSizeMm[0] * facsimile.width).toFixed(1)} мм` : ""}</label><label>Поворот <input type="range" min="-180" max="180" value={facsimile.rotation} onChange={(event) => { setFacsimile({ ...facsimile, rotation: Number(event.target.value) }); setFacsimilePreviewCommitted(false); }} onPointerUp={() => setFacsimileRevision((value) => value + 1)} /> {facsimile.rotation}°</label><label>Прозрачность <input type="range" min="10" max="100" value={facsimile.opacity * 100} onChange={(event) => { setFacsimile({ ...facsimile, opacity: Number(event.target.value) / 100 }); setFacsimilePreviewCommitted(false); }} onPointerUp={() => setFacsimileRevision((value) => value + 1)} /> {Math.round(facsimile.opacity * 100)}%</label><label className="checkbox-row"><input type="checkbox" checked={facsimile.removeLightBackground} onChange={(event) => { setFacsimile({ ...facsimile, removeLightBackground: event.target.checked }); setFacsimilePreviewCommitted(false); setFacsimileRevision((value) => value + 1); }} /> Удалить светлый фон</label><button className="secondary small" type="button" onClick={() => void saveFacsimileTemplate()}>Сохранить как шаблон</button></div>}</div>
      {savedFacsimiles.length > 0 && <div className="notice success"><span>Зафиксировано факсимиле: {savedFacsimiles.length}</span><button className="link-button danger" type="button" onClick={() => { setSavedFacsimiles([]); void makePreview(inputPath, preset, pageIndex, false); }}>Удалить зафиксированные</button></div>}{facsimile && workerFacsimile && <button className="secondary full-width" type="button" onClick={async () => { if (facsimile.applyTo === "all" && pageCount > 1 && !window.confirm(`Зафиксировать факсимиле на всех ${pageCount} страницах?`)) return; setSavedFacsimiles((current) => [...current, workerFacsimile]); setFacsimile(null); setFacsimilePreviewCommitted(false); await chooseFacsimile(); }}>Зафиксировать и добавить ещё</button>}
      <div className="control-divider" /><label className="checkbox-row"><input type="checkbox" checked={ocrEnabled} onChange={(event) => setOcrEnabled(event.target.checked)} /> Поисковый OCR</label>{ocrEnabled && <label>Языки OCR<select value={ocrLanguages} onChange={(event) => setOcrLanguages(event.target.value)}><option value="rus+eng">Русский + английский</option><option value="rus">Русский</option><option value="eng">Английский</option></select></label>}<label className="checkbox-row"><input type="checkbox" checked={pdfaEnabled} onChange={(event) => setPdfaEnabled(event.target.checked)} /> Архивный PDF/A-2b</label>
      <details><summary>Точная настройка</summary><label>Разрешение<select value={dpi} onChange={(event) => setDpi(Number(event.target.value))}><option value="150">150 dpi</option><option value="200">200 dpi</option><option value="300">300 dpi</option></select></label><label>Качество PDF<input type="range" min="55" max="100" value={quality} onChange={(event) => setQuality(Number(event.target.value))} /> {quality}%</label><button className="secondary small" type="button" onClick={() => { setDpi(200); setQuality(84); }}>Вернуть значения пресета</button></details>
      <details><summary>Журнал обработки · {journal.length}</summary>{journal.length === 0 ? <p className="help-text">Записей пока нет.</p> : <div className="journal-list">{journal.map((record) => <div key={record.id}><strong>{record.payload.status === "completed" ? "✓" : "!"} {record.title}</strong><span>{record.payload.inputType} · {record.payload.pageCount || 0} стр. · {record.payload.durationMs ? `${(record.payload.durationMs / 1000).toFixed(1)} с` : "—"}</span>{record.payload.appliedOperations?.length ? <small>{record.payload.appliedOperations.join(" · ")}</small> : null}{record.payload.outputSha256 ? <small title={record.payload.outputSha256}>SHA-256: {record.payload.outputSha256.slice(0, 16)}…</small> : null}</div>)}</div>}</details>
      <div className="control-divider" /><div><div className="inline-heading"><h3>Безвозвратное скрытие</h3><button className="secondary small" type="button" disabled={!inputPath} onClick={() => setRedactions((current) => [...current, { id: crypto.randomUUID(), page: pageIndex, x: .15, y: .15, width: .3, height: .08, color: "black" }])}>Добавить область</button></div><p className="help-text">Область закрашивается до OCR и не попадает в текстовый слой.</p>{redactions.map((entry) => <div className="redaction-row" key={entry.id}><strong>Стр. {entry.page + 1}</strong><label>X, %<input type="number" min="0" max="99" value={Math.round(entry.x * 100)} onChange={(event) => setRedactions((current) => current.map((item) => item.id === entry.id ? { ...item, x: Number(event.target.value) / 100 } : item))} /></label><label>Y, %<input type="number" min="0" max="99" value={Math.round(entry.y * 100)} onChange={(event) => setRedactions((current) => current.map((item) => item.id === entry.id ? { ...item, y: Number(event.target.value) / 100 } : item))} /></label><label>Ширина, %<input type="number" min="1" max="100" value={Math.round(entry.width * 100)} onChange={(event) => setRedactions((current) => current.map((item) => item.id === entry.id ? { ...item, width: Number(event.target.value) / 100 } : item))} /></label><label>Высота, %<input type="number" min="1" max="100" value={Math.round(entry.height * 100)} onChange={(event) => setRedactions((current) => current.map((item) => item.id === entry.id ? { ...item, height: Number(event.target.value) / 100 } : item))} /></label><select aria-label="Цвет скрытия" value={entry.color} onChange={(event) => setRedactions((current) => current.map((item) => item.id === entry.id ? { ...item, color: event.target.value as RedactionState["color"] } : item))}><option value="black">Чёрный</option><option value="white">Белый</option></select><button className="icon-button danger" type="button" onClick={() => setRedactions((current) => current.filter((item) => item.id !== entry.id))}>×</button></div>)}</div>
    </div></section>
    <section className={`surface preview-panel ${fullscreen ? "fullscreen-preview" : ""}`}><div className="surface-title"><h2>Предпросмотр</h2><div className="button-row">{originalUrl && <button className="secondary small" type="button" onClick={() => setShowOriginal((value) => !value)}>{showOriginal ? "Показать обработку" : "Показать оригинал"}</button>}<button className="secondary small" type="button" onClick={() => setFullscreen((value) => !value)}>{fullscreen ? "Закрыть полный экран" : "На весь экран"}</button><span>{pageCount ? `Страница ${pageIndex + 1} из ${pageCount}` : "Файл не выбран"} · {preset}</span></div></div>
      {inputPath && <div className="page-editor"><span>Итоговый порядок ({pageOrder.length}):</span><div>{pageOrder.map((sourceIndex) => <button key={sourceIndex} className={sourceIndex === pageIndex ? "active" : ""} type="button" onClick={() => { setPageIndex(sourceIndex); void makePreview(inputPath, preset, sourceIndex); }}>{sourceIndex + 1}{pageRotations[sourceIndex] ? ` · ${pageRotations[sourceIndex]}°` : ""}</button>)}</div><button className="secondary small" type="button" onClick={() => moveCurrentPage(-1)}>← Раньше</button><button className="secondary small" type="button" onClick={() => moveCurrentPage(1)}>Позже →</button><button className="secondary small" type="button" onClick={() => rotateCurrentPage(-90)}>↶ 90°</button><button className="secondary small" type="button" onClick={() => rotateCurrentPage(90)}>↷ 90°</button><button className="secondary small danger" type="button" onClick={deleteCurrentPage}>Удалить страницу</button><button className="link-button" type="button" onClick={() => { setPageOrder(Array.from({ length: pageCount }, (_, index) => index)); setPageRotations({}); }}>Сбросить</button></div>}
      {!inputPath ? <div className="drop-empty" onClick={() => void chooseDocument()}><span>▧</span><h2>Выберите документ</h2><p>PDF или DOCX до 200 МБ. Исходный файл не изменяется.</p><button className="primary" type="button">Выбрать файл</button></div> : <div className="preview-workspace">{pageCount > 1 && <aside className="page-strip" aria-label="Страницы">{pageOrder.map((sourceIndex) => <button key={sourceIndex} className={pageIndex === sourceIndex ? "active" : ""} type="button" onClick={() => { setPageIndex(sourceIndex); void makePreview(inputPath, preset, sourceIndex); }}><span>{sourceIndex + 1}</span></button>)}</aside>}<div className="document-stage" ref={stageRef} onPointerMove={moveFacsimile} onPointerUp={() => { if (dragging.current) setFacsimileRevision((value) => value + 1); dragging.current = false; }}><div className="document-page real-preview" style={{ aspectRatio: String(previewAspect) }}>{previewing ? <div className="preview-loader">Обновляем страницу…</div> : previewUrl ? <img className="page-image" src={showOriginal && originalUrl ? originalUrl : previewUrl} alt={`${showOriginal ? "Оригинал" : "Обработка"} страницы ${pageIndex + 1}`} onLoad={(event) => setPreviewAspect(event.currentTarget.naturalWidth / Math.max(1, event.currentTarget.naturalHeight))} /> : null}{!showOriginal && visibleOnCurrentPage && <div className="facsimile real" role="button" tabIndex={0} aria-label="Факсимиле: перемещайте стрелками" style={{ left: `${facsimile.x * 100}%`, top: `${facsimile.y * 100}%`, width: `${facsimile.width * 100}%`, transform: `rotate(${facsimile.rotation}deg)` }} onKeyDown={nudge} onPointerDown={(event) => { dragging.current = true; setFacsimilePreviewCommitted(false); event.currentTarget.setPointerCapture(event.pointerId); }}><img src={facsimile.imageUrl} alt="Факсимиле" style={{ opacity: facsimilePreviewCommitted ? 0 : facsimile.opacity }} /></div>}</div></div></div>}
      {error && <div className="scanner-error"><strong>Не удалось обработать документ</strong><span>{error}</span><div><button className="secondary" type="button" onClick={() => void makePreview()}>Повторить</button>{ocrEnabled && <button className="secondary" type="button" onClick={() => setOcrEnabled(false)}>Без OCR</button>}<button className="secondary" type="button" onClick={() => void chooseDocument()}>Другой файл</button></div></div>}
      {warnings.length > 0 && <div className="notice warning"><strong>Проверьте результат</strong>{warnings.map((warning) => <span key={warning}>{warning}</span>)}</div>}
      {inputPath && <div className="scanner-estimate"><span>Оценка результата: {estimatedOutputBytes ? `≈ ${(estimatedOutputBytes / 1024 / 1024).toFixed(1)} МБ` : "рассчитывается"}</span>{pageSizeMm && <span>Страница: {pageSizeMm[0].toFixed(1)} × {pageSizeMm[1].toFixed(1)} мм</span>}{ocrConfidence != null && <span>Средняя уверенность OCR: {ocrConfidence.toFixed(1)}%</span>}</div>}
      {ocrText && <details className="ocr-result"><summary>Распознанный текст · сомнительных слов: {lowConfidenceWords.length}</summary><textarea readOnly rows={10} value={ocrText} aria-label="Распознанный текст" />{lowConfidenceWords.length > 0 && <div className="low-confidence-list">{lowConfidenceWords.slice(0, 100).map((word, index) => <span key={`${word.page}-${index}`} title={`Страница ${word.page}`}>{word.text} · {word.confidence.toFixed(0)}%</span>)}</div>}<p className="help-text">Текст показывается только в текущем окне и не записывается в журнал обработки.</p></details>}
      {progress && <div className="progress-panel"><div><strong>{progress.stage}</strong><span>{progress.totalPages ? `Страница ${progress.currentPage} из ${progress.totalPages}` : ""}</span></div><progress max="100" value={progress.percent} /><strong>{progress.percent}%</strong>{activeJob && <button className="secondary" type="button" onClick={() => void cancel()}>Отменить</button>}</div>}
      {resultPath ? <div className="ready-panel"><div><strong>✓ PDF готов</strong><span>{resultPath}</span></div><button className="secondary" type="button" onClick={() => void openPath(resultPath)}>Открыть PDF</button><button className="secondary" type="button" onClick={() => void openPath(resultPath.replace(/[\\/][^\\/]+$/, ""))}>Открыть папку</button><button className="primary" type="button" onClick={() => { setInputPath(""); setPreviewUrl(""); setPageCount(0); setResultPath(""); setWarnings([]); setProgress(null); }}>Другой файл</button></div> : <div className="actionbar"><span>{facsimileSelection.error || (facsimile ? "Предпросмотр обновляется тем же worker, что и итоговый PDF" : "Выберите пресет и сохраните новый PDF")}</span><button className="primary" disabled={!inputPath || !!activeJob || !!facsimileSelection.error} type="button" onClick={() => void processDocument()}>Сохранить PDF</button></div>}
    </section>
  </div>;
}
