import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openPath } from "@tauri-apps/plugin-opener";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { useRecords } from "../../hooks/useRecords";
import { chooseOpenPath, chooseSavePath } from "../../lib/files";
import { copyAttachment, getWorkspaceInfo } from "../../lib/storage";

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

interface ScannerTemplate {
  kind: "facsimile-template";
  relativePath: string;
  fileName: string;
}

interface ProgressState { stage: string; currentPage: number; totalPages: number; percent: number }

const initialFacsimile = (path: string, url: string, fileName: string): FacsimileState => ({
  imagePath: path, imageUrl: url, fileName, x: 0.62, y: 0.72, width: 0.22, rotation: 0, opacity: 1,
  removeLightBackground: false, applyTo: "current", pageRange: "",
});

export function Scanner() {
  const templates = useRecords<ScannerTemplate>("scanner");
  const [inputPath, setInputPath] = useState("");
  const [documentName, setDocumentName] = useState("");
  const [preset, setPreset] = useState("Офисный скан");
  const [pageIndex, setPageIndex] = useState(0);
  const [pageCount, setPageCount] = useState(0);
  const [previewUrl, setPreviewUrl] = useState("");
  const [previewAspect, setPreviewAspect] = useState(0.707);
  const [previewing, setPreviewing] = useState(false);
  const [ocrEnabled, setOcrEnabled] = useState(false);
  const [ocrLanguages, setOcrLanguages] = useState("rus+eng");
  const [dpi, setDpi] = useState(200);
  const [quality, setQuality] = useState(84);
  const [facsimile, setFacsimile] = useState<FacsimileState | null>(null);
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [activeJob, setActiveJob] = useState("");
  const [error, setError] = useState("");
  const [resultPath, setResultPath] = useState("");
  const dragging = useRef(false);
  const stageRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let unsubscribe = () => {};
    void listen<{ jobId: string; event: { type: string } & ProgressState }>("scanner-progress", ({ payload }) => {
      if (payload.event.type === "progress") setProgress(payload.event);
    }).then((fn) => { unsubscribe = fn; });
    return () => unsubscribe();
  }, []);

  const facsimilePages = useMemo(() => {
    if (!facsimile || facsimile.applyTo === "all") return [];
    if (facsimile.applyTo === "current") return [pageIndex];
    const pages = new Set<number>();
    for (const part of facsimile.pageRange.split(",")) {
      const [startText, endText] = part.trim().split("-");
      const start = Number(startText); const end = Number(endText || startText);
      if (Number.isFinite(start) && Number.isFinite(end)) for (let page = Math.max(1, start); page <= Math.min(pageCount, end); page += 1) pages.add(page - 1);
    }
    return [...pages];
  }, [facsimile, pageIndex, pageCount]);

  const workerFacsimile = facsimile ? {
    imagePath: facsimile.imagePath, x: facsimile.x, y: facsimile.y, width: facsimile.width,
    rotation: facsimile.rotation, opacity: facsimile.opacity,
    removeLightBackground: facsimile.removeLightBackground, pages: facsimilePages,
  } : null;

  const makePreview = async (path = inputPath, selectedPreset = preset, selectedPage = pageIndex) => {
    if (!path) return;
    setPreviewing(true); setError("");
    const jobId = crypto.randomUUID();
    try {
      const response = await invoke<{ outputPath: string; pageCount: number }>("scanner_run", {
        jobId, operation: "preview", config: { inputPath: path, preset: selectedPreset, pageIndex: selectedPage, seed: 42, settings: { dpi, jpeg_quality: quality } },
      });
      setPageCount(response.pageCount);
      const url = await invoke<string>("read_binary_file", { path: response.outputPath, maxBytes: 24 * 1024 * 1024 });
      setPreviewUrl(url);
    } catch (reason) { setError(String(reason)); }
    finally { setPreviewing(false); }
  };

  const chooseDocument = async () => {
    const path = await chooseOpenPath("Выберите PDF или DOCX", ["pdf", "docx"]);
    if (!path) return;
    setInputPath(path); setDocumentName(path.split(/[\\/]/).pop() || path); setPageIndex(0); setResultPath("");
    await makePreview(path, preset, 0);
  };

  const chooseFacsimile = async () => {
    const path = await chooseOpenPath("Выберите факсимиле", ["png", "jpg", "jpeg"]);
    if (!path) return;
    const imageUrl = await invoke<string>("read_binary_file", { path, maxBytes: 12 * 1024 * 1024 });
    setFacsimile(initialFacsimile(path, imageUrl, path.split(/[\\/]/).pop() || "Факсимиле"));
  };

  const useTemplate = async (template: { relativePath: string; fileName: string }) => {
    const workspace = await getWorkspaceInfo();
    const separator = workspace.root.includes("\\") ? "\\" : "/";
    const path = `${workspace.root}${separator}${template.relativePath.replace(/\//g, separator)}`;
    const imageUrl = await invoke<string>("read_binary_file", { path, maxBytes: 12 * 1024 * 1024 });
    setFacsimile(initialFacsimile(path, imageUrl, template.fileName));
  };

  const saveFacsimileTemplate = async () => {
    if (!facsimile) return;
    const id = crypto.randomUUID();
    const attachment = await copyAttachment(facsimile.imagePath, "scanner", id);
    await templates.save(facsimile.fileName, { kind: "facsimile-template", relativePath: attachment.relativePath, fileName: attachment.fileName }, id);
  };

  const processDocument = async () => {
    if (!inputPath) return;
    if (facsimile?.applyTo === "all" && pageCount > 1 && !window.confirm(`Добавить факсимиле на все ${pageCount} страниц?`)) return;
    const base = documentName.replace(/\.(pdf|docx)$/i, "");
    const outputPath = await chooseSavePath("Сохранить обработанный PDF", `${base} — обработано.pdf`, ["pdf"]);
    if (!outputPath) return;
    const jobId = crypto.randomUUID(); setActiveJob(jobId); setProgress({ stage: "Подготовка", currentPage: 0, totalPages: pageCount, percent: 0 }); setError(""); setResultPath("");
    try {
      const response = await invoke<{ outputPath: string; warnings?: string[] }>("scanner_run", { jobId, operation: "process", config: { inputPath, outputPath, preset, ocrEnabled, ocrLanguages, seed: 42, settings: { dpi, jpeg_quality: quality }, facsimile: workerFacsimile } });
      setResultPath(response.outputPath || outputPath); setProgress({ stage: "Готово", currentPage: pageCount, totalPages: pageCount, percent: 100 });
    } catch (reason) { setError(String(reason)); setProgress(null); }
    finally { setActiveJob(""); }
  };

  const cancel = async () => { if (activeJob) await invoke("scanner_cancel", { jobId: activeJob }); };

  const moveFacsimile = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragging.current || !facsimile) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(1 - facsimile.width, (event.clientX - bounds.left) / bounds.width - facsimile.width / 2));
    const y = Math.max(0, Math.min(0.94, (event.clientY - bounds.top) / bounds.height - 0.04));
    setFacsimile({ ...facsimile, x, y });
  };

  const nudge = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!facsimile) return;
    const step = event.shiftKey ? 0.01 : 0.002;
    const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
    if (!delta) return;
    event.preventDefault(); setFacsimile({ ...facsimile, x: Math.max(0, Math.min(1 - facsimile.width, facsimile.x + delta[0])), y: Math.max(0, Math.min(0.95, facsimile.y + delta[1])) });
  };

  const visibleOnCurrentPage = facsimile && (facsimile.applyTo === "all" || facsimile.applyTo === "current" || facsimilePages.includes(pageIndex));
  return <div className="scanner-layout">
    <section className="surface scanner-controls"><div className="surface-title"><h2>Настройки</h2></div><div className="surface-body scanner-control-stack">
      <button className="primary full-width" type="button" onClick={() => void chooseDocument()}>{inputPath ? "Заменить файл" : "Выбрать PDF или DOCX"}</button>{documentName && <p className="selected-file">▧ {documentName}</p>}
      <div><h3>Пресет</h3><div className="preset-grid">{presets.map(([name, description]) => <button key={name} className={preset === name ? "selected" : ""} type="button" onClick={() => { setPreset(name); void makePreview(inputPath, name, pageIndex); }}><strong>{name}</strong><small>{description}</small></button>)}</div></div>
      <div className="control-divider" /><div><div className="inline-heading"><h3>Факсимиле</h3>{facsimile && <button className="link-button danger" type="button" onClick={() => setFacsimile(null)}>Удалить</button>}</div>{!facsimile ? <><button className="secondary full-width" type="button" onClick={() => void chooseFacsimile()}>Добавить факсимиле</button>{templates.records.filter((record) => record.payload.kind === "facsimile-template").length > 0 && <select aria-label="Шаблон факсимиле" defaultValue="" onChange={(event) => { const template = templates.records.find((record) => record.id === event.target.value); if (template) void useTemplate(template.payload); }}><option value="">Выбрать сохранённый шаблон</option>{templates.records.filter((record) => record.payload.kind === "facsimile-template").map((record) => <option key={record.id} value={record.id}>{record.title}</option>)}</select>}</> : <div className="facsimile-controls"><strong>{facsimile.fileName}</strong><label>Применить<select value={facsimile.applyTo} onChange={(event) => setFacsimile({ ...facsimile, applyTo: event.target.value as FacsimileState["applyTo"] })}><option value="current">к текущей странице</option><option value="range">к диапазону</option><option value="all">ко всем страницам</option></select></label>{facsimile.applyTo === "range" && <label>Страницы<input value={facsimile.pageRange} placeholder="1-3, 5" onChange={(event) => setFacsimile({ ...facsimile, pageRange: event.target.value })} /></label>}<label>Размер <input type="range" min="8" max="60" value={facsimile.width * 100} onChange={(event) => setFacsimile({ ...facsimile, width: Number(event.target.value) / 100 })} /> {Math.round(facsimile.width * 100)}%</label><label>Поворот <input type="range" min="-180" max="180" value={facsimile.rotation} onChange={(event) => setFacsimile({ ...facsimile, rotation: Number(event.target.value) })} /> {facsimile.rotation}°</label><label>Прозрачность <input type="range" min="10" max="100" value={facsimile.opacity * 100} onChange={(event) => setFacsimile({ ...facsimile, opacity: Number(event.target.value) / 100 })} /> {Math.round(facsimile.opacity * 100)}%</label><label className="checkbox-row"><input type="checkbox" checked={facsimile.removeLightBackground} onChange={(event) => setFacsimile({ ...facsimile, removeLightBackground: event.target.checked })} /> Удалить светлый фон</label><button className="secondary small" type="button" onClick={() => void saveFacsimileTemplate()}>Сохранить как шаблон</button></div>}</div>
      <div className="control-divider" /><label className="checkbox-row"><input type="checkbox" checked={ocrEnabled} onChange={(event) => setOcrEnabled(event.target.checked)} /> Поисковый OCR</label>{ocrEnabled && <label>Языки OCR<select value={ocrLanguages} onChange={(event) => setOcrLanguages(event.target.value)}><option value="rus+eng">Русский + английский</option><option value="rus">Русский</option><option value="eng">Английский</option></select></label>}
      <details><summary>Точная настройка</summary><label>Разрешение<select value={dpi} onChange={(event) => setDpi(Number(event.target.value))}><option value="150">150 dpi</option><option value="200">200 dpi</option><option value="300">300 dpi</option></select></label><label>Качество PDF<input type="range" min="55" max="100" value={quality} onChange={(event) => setQuality(Number(event.target.value))} /> {quality}%</label><button className="secondary small" type="button" onClick={() => { setDpi(200); setQuality(84); }}>Вернуть значения пресета</button></details>
    </div></section>
    <section className="surface preview-panel"><div className="surface-title"><h2>Предпросмотр</h2><span>{pageCount ? `Страница ${pageIndex + 1} из ${pageCount}` : "Файл не выбран"} · {preset}</span></div>
      {!inputPath ? <div className="drop-empty" onClick={() => void chooseDocument()}><span>▧</span><h2>Выберите документ</h2><p>PDF или DOCX до 250 МБ. Исходный файл не изменяется.</p><button className="primary" type="button">Выбрать файл</button></div> : <div className="preview-workspace">{pageCount > 1 && <aside className="page-strip" aria-label="Страницы">{Array.from({ length: pageCount }, (_, index) => <button key={index} className={pageIndex === index ? "active" : ""} type="button" onClick={() => { setPageIndex(index); void makePreview(inputPath, preset, index); }}><span>{index + 1}</span></button>)}</aside>}<div className="document-stage" ref={stageRef} onPointerMove={moveFacsimile} onPointerUp={() => { dragging.current = false; }}><div className="document-page real-preview" style={{ aspectRatio: String(previewAspect) }}>{previewing ? <div className="preview-loader">Обновляем страницу…</div> : previewUrl ? <img className="page-image" src={previewUrl} alt={`Предпросмотр страницы ${pageIndex + 1}`} onLoad={(event) => setPreviewAspect(event.currentTarget.naturalWidth / Math.max(1, event.currentTarget.naturalHeight))} /> : null}{visibleOnCurrentPage && <div className="facsimile real" role="button" tabIndex={0} aria-label="Факсимиле: перемещайте стрелками" style={{ left: `${facsimile.x * 100}%`, top: `${facsimile.y * 100}%`, width: `${facsimile.width * 100}%`, transform: `rotate(${facsimile.rotation}deg)`, opacity: facsimile.opacity }} onKeyDown={nudge} onPointerDown={(event) => { dragging.current = true; event.currentTarget.setPointerCapture(event.pointerId); }}><img src={facsimile.imageUrl} alt="Факсимиле" /></div>}</div></div></div>}
      {error && <div className="scanner-error"><strong>Не удалось обработать документ</strong><span>{error}</span><div><button className="secondary" type="button" onClick={() => void makePreview()}>Повторить</button>{ocrEnabled && <button className="secondary" type="button" onClick={() => setOcrEnabled(false)}>Без OCR</button>}<button className="secondary" type="button" onClick={() => void chooseDocument()}>Другой файл</button></div></div>}
      {progress && <div className="progress-panel"><div><strong>{progress.stage}</strong><span>{progress.totalPages ? `Страница ${progress.currentPage} из ${progress.totalPages}` : ""}</span></div><progress max="100" value={progress.percent} /><strong>{progress.percent}%</strong>{activeJob && <button className="secondary" type="button" onClick={() => void cancel()}>Отменить</button>}</div>}
      {resultPath ? <div className="ready-panel"><div><strong>✓ PDF готов</strong><span>{resultPath}</span></div><button className="secondary" type="button" onClick={() => void openPath(resultPath)}>Открыть PDF</button><button className="secondary" type="button" onClick={() => void openPath(resultPath.replace(/[\\/][^\\/]+$/, ""))}>Открыть папку</button><button className="primary" type="button" onClick={() => { setInputPath(""); setPreviewUrl(""); setPageCount(0); setResultPath(""); setProgress(null); }}>Другой файл</button></div> : <div className="actionbar"><span>{facsimile ? "Рамка не попадёт в итоговый PDF" : "Выберите пресет и сохраните новый PDF"}</span><button className="primary" disabled={!inputPath || !!activeJob} type="button" onClick={() => void processDocument()}>Сохранить PDF</button></div>}
    </section>
  </div>;
}
