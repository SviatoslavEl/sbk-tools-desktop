import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { useRecords } from "../../hooks/useRecords";
import { chooseDirectory, chooseOpenPath, chooseOpenPaths, chooseSavePath } from "../../lib/files";
import { copyAttachment, getWorkspaceInfo } from "../../lib/storage";
import { useWorkspaceAccess } from "../../lib/workspaceAccess";
import { parseFacsimilePages, type FacsimilePageSelection } from "./facsimilePages";
import { buildOutputPageBlocks, buildOutputPageOrder, type OutputBlockDefinition, type OutputPageMode } from "./outputPages";
import {
  applyGeometryToPages,
  BoundedPreviewCache,
  buildFacsimilePlacement,
  buildFacsimilePlacements,
  facsimileAppliesTo,
  facsimileGeometry,
  facsimileOverlayStyle,
  previewCacheKey,
  positionFacsimileInRegion,
  selectedFacsimilePages,
  suppressLabelActivation,
  updateFacsimileGeometry,
  type EditableFacsimile,
  type FacsimileGeometry,
} from "./facsimilePreview";
import { buildPageWindow } from "./pageNavigation";
import { compressionProfile, type CompressionMode } from "./compression";
import {
  facsimileHeight,
  drawnRect,
  moveRect,
  normalizeFacsimile,
  normalizeRect,
  pointerDelta,
  resizeRect,
  rotationFromPointer,
  type NormalizedRect,
  type ResizeHandle,
} from "./interactiveGeometry";
import "./scanner.css";

const presets = [
  ["Оригинал", "Минимальная обработка"], ["Офисный скан", "Естественный офисный вид"],
  ["Чёткий ч/б", "Максимальная читаемость"], ["Мягкий ч/б", "Спокойные серые тона"],
  ["Цветной скан", "Цвет и лёгкая текстура"], ["Архивный", "Пожелтевшая бумага"],
  ["Контрастный", "Выраженный текст"], ["Экономичный", "Меньший итоговый файл"],
] as const;

interface FacsimileState extends EditableFacsimile {
  id: string;
  applyTo: "current" | "all" | "range";
  pageRange: string;
  pageGeometries: Record<number, FacsimileGeometry>;
  lockedSelection?: FacsimilePageSelection;
  imageAspect: number;
}

interface ScannerRecord { kind: "facsimile-template" | "processing-journal"; relativePath?: string; fileName?: string; inputType?: string; pageCount?: number; preset?: string; ocr?: boolean; status?: string; durationMs?: number; outputSha256?: string; appliedOperations?: string[]; }
interface RedactionState { id: string; page: number; x: number; y: number; width: number; height: number; color: "black" | "white"; }
interface AnnotationState { id: string; kind: "marker" | "stroke" | "blur" | "print_blur"; page: number; x: number; y: number; width: number; height: number; color: string; intensity: number; shape: "rectangle" | "ellipse"; }

type OverlaySelection = { kind: "redaction" | "annotation"; id: string } | null;
type DrawingTool = "redaction" | AnnotationState["kind"];
type DragState =
  | { target: "redaction" | "annotation"; id: string; mode: "move" | ResizeHandle; start: { x: number; y: number }; initial: NormalizedRect }
  | { target: "region"; mode: "move" | ResizeHandle; start: { x: number; y: number }; initial: NormalizedRect }
  | { target: "facsimile"; mode: "move" | "resize" | "rotate"; start: { x: number; y: number }; initial: FacsimileGeometry; center?: { x: number; y: number } }
  | { target: "draw"; tool: DrawingTool; id: string; start: { x: number; y: number } };

interface ProgressState { stage: string; currentPage: number; totalPages: number; percent: number }
type OutputSaveMode = OutputPageMode | "blocks";
type ResultKind = "single" | "batch" | "split" | "";
interface PreviewResult {
  previewUrl: string;
  originalUrl: string;
  pageCount: number;
  warnings: string[];
  estimatedOutputBytes: number;
  originalBytes: number;
  estimatedSavingsPercent: number;
  pageSizePoints?: [number, number];
}

const initialFacsimile = (path: string, url: string, fileName: string, width = 0.22): FacsimileState => ({
  id: crypto.randomUUID(), imagePath: path, imageUrl: url, fileName, x: 0.62, y: 0.72, width, rotation: 0, opacity: 1,
  removeLightBackground: true, applyTo: "current", pageRange: "", pageGeometries: {},
  placementMode: "manual", region: [0.1, 0.1, 0.8, 0.8], randomSeed: 42, randomRotationDegrees: 0, imageAspect: 3,
});

const resizeLabels: Record<ResizeHandle, string> = { nw: "Изменить размер сверху слева", ne: "Изменить размер сверху справа", sw: "Изменить размер снизу слева", se: "Изменить размер снизу справа" };

function ResizeHandles({ onStart }: { onStart: (handle: ResizeHandle, event: PointerEvent<HTMLButtonElement>) => void }) {
  return <>{(["nw", "ne", "sw", "se"] as const).map((handle) => <button key={handle} className={`geometry-handle ${handle}`} type="button" aria-label={resizeLabels[handle]} onPointerDown={(event) => onStart(handle, event)} />)}</>;
}

function InfoHint({ label, children }: { label: string; children: string }) {
  return <button className="scanner-info" type="button" aria-label={`${label}. ${children}`} onPointerDown={(event) => event.stopPropagation()} onClick={suppressLabelActivation}>i<span className="scanner-info-text" role="tooltip">{children}</span></button>;
}

export function Scanner() {
  const workspaceAccess = useWorkspaceAccess();
  const templates = useRecords<ScannerRecord>("scanner");
  const [inputPath, setInputPath] = useState("");
  const [documentName, setDocumentName] = useState("");
  const [preset, setPreset] = useState("Офисный скан");
  const [pageIndex, setPageIndex] = useState(0);
  const [pageCount, setPageCount] = useState(0);
  const [pageOrder, setPageOrder] = useState<number[]>([]);
  const [outputPageMode, setOutputPageMode] = useState<OutputSaveMode>("all");
  const [outputPageRange, setOutputPageRange] = useState("");
  const [outputBlocks, setOutputBlocks] = useState<OutputBlockDefinition[]>([]);
  const [pageRotations, setPageRotations] = useState<Record<number, number>>({});
  const [previewUrl, setPreviewUrl] = useState("");
  const [originalUrl, setOriginalUrl] = useState("");
  const [showOriginal, setShowOriginal] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [batchPaths, setBatchPaths] = useState<string[]>([]);
  const [previewAspect, setPreviewAspect] = useState(0.707);
  const [previewZoom, setPreviewZoom] = useState(1);
  const [previewing, setPreviewing] = useState(false);
  const [ocrEnabled, setOcrEnabled] = useState(false);
  const [ocrLanguages, setOcrLanguages] = useState("rus+eng");
  const [pdfaEnabled, setPdfaEnabled] = useState(false);
  const [dpi, setDpi] = useState(200);
  const [quality, setQuality] = useState(84);
  const [compressionMode, setCompressionMode] = useState<CompressionMode>("balanced");
  const [facsimile, setFacsimile] = useState<FacsimileState | null>(null);
  const [savedFacsimiles, setSavedFacsimiles] = useState<FacsimileState[]>([]);
  const [editingFacsimileId, setEditingFacsimileId] = useState("");
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [activeJob, setActiveJob] = useState("");
  const [error, setError] = useState("");
  const [resultPath, setResultPath] = useState("");
  const [resultKind, setResultKind] = useState<ResultKind>("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [estimatedOutputBytes, setEstimatedOutputBytes] = useState(0);
  const [originalBytes, setOriginalBytes] = useState(0);
  const [estimatedSavingsPercent, setEstimatedSavingsPercent] = useState(0);
  const [pageSizeMm, setPageSizeMm] = useState<[number, number] | null>(null);
  const [ocrConfidence, setOcrConfidence] = useState<number | null>(null);
  const [ocrText, setOcrText] = useState("");
  const [lowConfidenceWords, setLowConfidenceWords] = useState<Array<{ page: number; text: string; confidence: number }>>([]);
  const [redactions, setRedactions] = useState<RedactionState[]>([]);
  const [annotations, setAnnotations] = useState<AnnotationState[]>([]);
  const [selectedOverlay, setSelectedOverlay] = useState<OverlaySelection>(null);
  const [drawingTool, setDrawingTool] = useState<DrawingTool | null>(null);
  const pageElement = useRef<HTMLDivElement | null>(null);
  const dragState = useRef<DragState | null>(null);
  const latestPreviewJob = useRef("");
  const activeJobRef = useRef("");
  const previewCache = useRef(new BoundedPreviewCache<PreviewResult>(8));
  const lastFacsimileWidth = useRef(0.22);
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
    if (facsimile.lockedSelection) return { selection: facsimile.lockedSelection, error: "" };
    try {
      return { selection: parseFacsimilePages(facsimile.applyTo, facsimile.pageRange, pageIndex, pageCount), error: "" };
    } catch (reason) {
      return { selection: null, error: reason instanceof Error ? reason.message : "Некорректный диапазон страниц." };
    }
  }, [facsimile, pageIndex, pageCount]);

  const currentFacsimileGeometry = facsimile ? facsimileGeometry(facsimile, pageIndex) : null;
  const workerFacsimile = facsimile && currentFacsimileGeometry && facsimileSelection.selection
    ? buildFacsimilePlacement({ ...facsimile, ...currentFacsimileGeometry }, facsimileSelection.selection)
    : null;
  const outputPageSelection = useMemo(() => {
    if (!inputPath || !pageCount) return { order: pageOrder, error: "" };
    if (outputPageMode === "blocks") return { order: [] as number[], error: "" };
    try {
      return { order: buildOutputPageOrder(pageOrder, outputPageMode, outputPageRange, pageCount), error: "" };
    } catch (reason) {
      return { order: [] as number[], error: reason instanceof Error ? reason.message : "Некорректный диапазон итогового PDF." };
    }
  }, [inputPath, outputPageMode, outputPageRange, pageCount, pageOrder]);
  const outputBlockSelection = useMemo(() => {
    if (outputPageMode !== "blocks" || !inputPath || !pageCount) return { blocks: [], error: "" };
    try {
      return { blocks: buildOutputPageBlocks(pageOrder, outputBlocks, pageCount), error: "" };
    } catch (reason) {
      return { blocks: [], error: reason instanceof Error ? reason.message : "Некорректные блоки страниц." };
    }
  }, [inputPath, outputPageMode, outputBlocks, pageCount, pageOrder]);
  const compressionTargetRatio = compressionProfile(compressionMode).targetRatio;
  const pageWindow = useMemo(() => buildPageWindow(pageOrder, pageIndex), [pageOrder, pageIndex]);

  const applyPreview = (result: PreviewResult) => {
    setPageCount(result.pageCount);
    setPageOrder((current) => current.length && current.every((index) => index < result.pageCount)
      ? current
      : Array.from({ length: result.pageCount }, (_, index) => index));
    setEstimatedOutputBytes(result.estimatedOutputBytes);
    setOriginalBytes(result.originalBytes);
    setEstimatedSavingsPercent(result.estimatedSavingsPercent);
    setPageSizeMm(result.pageSizePoints
      ? result.pageSizePoints.map((value) => value * 25.4 / 72) as [number, number]
      : null);
    setPreviewUrl(result.previewUrl);
    setOriginalUrl(result.originalUrl);
    setWarnings(result.warnings);
  };

  const makePreview = async (path = inputPath, selectedPreset = preset, selectedPage = pageIndex, rotations = pageRotations) => {
    if (!path) return;
    const cacheKey = previewCacheKey({
      inputPath: path,
      preset: selectedPreset,
      pageIndex: selectedPage,
      dpi,
      quality,
      pageRotation: rotations[selectedPage] || 0,
      redactions: [],
      annotations: [],
      compressionMode,
    });
    const cached = previewCache.current.get(cacheKey);
    if (cached) {
      if (latestPreviewJob.current) void invoke("scanner_cancel", { jobId: latestPreviewJob.current }).catch(() => undefined);
      latestPreviewJob.current = `cache-${crypto.randomUUID()}`;
      applyPreview(cached);
      setPreviewing(false);
      setError("");
      return;
    }
    setPreviewing(true); setError("");
    if (latestPreviewJob.current) void invoke("scanner_cancel", { jobId: latestPreviewJob.current }).catch(() => undefined);
    const jobId = crypto.randomUUID();
    latestPreviewJob.current = jobId;
    try {
      const response = await invoke<{ outputPath: string; originalPath?: string; pageCount: number; warnings?: string[]; estimatedOutputBytes?: number; originalBytes?: number; estimatedSavingsPercent?: number; pageSizePoints?: [number, number] }>("scanner_run", {
        jobId, operation: "preview", config: { protocolVersion: 2, inputPath: path, preset: selectedPreset, pageIndex: selectedPage, seed: 42, settings: { dpi, jpeg_quality: quality }, compressionTargetRatio, pageRotations: rotations, redactions: [], annotations: [] },
      });
      if (latestPreviewJob.current !== jobId) return;
      let url = "";
      let original = "";
      try {
        url = await invoke<string>("read_binary_file", { path: response.outputPath, maxBytes: 24 * 1024 * 1024 });
      } finally {
        void invoke("delete_runtime_file", { path: response.outputPath }).catch(() => undefined);
      }
      if (latestPreviewJob.current !== jobId) return;
      setPreviewUrl(url);
      if (response.originalPath) {
        try { original = await invoke<string>("read_binary_file", { path: response.originalPath, maxBytes: 24 * 1024 * 1024 }); }
        finally { void invoke("delete_runtime_file", { path: response.originalPath }).catch(() => undefined); }
      }
      const result: PreviewResult = {
        previewUrl: url,
        originalUrl: original,
        pageCount: response.pageCount,
        warnings: response.warnings || [],
        estimatedOutputBytes: response.estimatedOutputBytes || 0,
        originalBytes: response.originalBytes || 0,
        estimatedSavingsPercent: response.estimatedSavingsPercent || 0,
        pageSizePoints: response.pageSizePoints,
      };
      previewCache.current.set(cacheKey, result);
      applyPreview(result);
    } catch (reason) { if (latestPreviewJob.current === jobId) setError(String(reason)); }
    finally { if (latestPreviewJob.current === jobId) setPreviewing(false); }
  };

  useEffect(() => {
    if (!inputPath) return;
    const timer = window.setTimeout(() => { void makePreview(inputPath, preset, pageIndex, pageRotations); }, 250);
    return () => window.clearTimeout(timer);
    // Page changes invoke makePreview directly; this effect is only for output-size controls.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compressionMode, dpi, quality]);

  const chooseDocument = async () => {
    const path = await chooseOpenPath("Выберите PDF или DOCX", ["pdf", "docx"]);
    if (!path) return;
    previewCache.current.clear();
    setInputPath(path); setDocumentName(path.split(/[\\/]/).pop() || path); setPageIndex(0); setPageOrder([]); setOutputPageMode("all"); setOutputPageRange(""); setOutputBlocks([]); setPageRotations({}); setResultPath(""); setResultKind(""); setWarnings([]); setFacsimile(null); setSavedFacsimiles([]); setEditingFacsimileId(""); setRedactions([]); setAnnotations([]); setSelectedOverlay(null); setOriginalBytes(0); setEstimatedOutputBytes(0); setEstimatedSavingsPercent(0); setOcrConfidence(null); setOcrText(""); setLowConfidenceWords([]); setPreviewZoom(1);
    await makePreview(path, preset, 0, {});
  };
  const chooseBatch = async () => {
    const paths = await chooseOpenPaths("Выберите PDF и DOCX для пакета", ["pdf", "docx"]);
    if (paths.length) { setBatchPaths(paths); setError(""); setResultPath(""); setResultKind(""); }
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
      try { await invoke("scanner_run", { jobId, operation: "process", config: { protocolVersion: 2, inputPath: path, outputPath, preset, ocrEnabled, ocrLanguages, pdfaEnabled, seed: 42, settings: { dpi, jpeg_quality: quality }, compressionTargetRatio, pageOrder: [], redactions: [], annotations: [] } }); }
      catch (reason) { setError(`Файл ${index + 1}: ${String(reason)}`); await templates.save(`Пакет: ошибка ${new Date().toLocaleString("ru-RU")}`, { kind: "processing-journal", inputType: path.toLowerCase().endsWith(".docx") ? "DOCX" : "PDF", preset, ocr: ocrEnabled, status: "failed", durationMs: Date.now() - startedAt }).catch(() => undefined); setActiveJob(""); activeJobRef.current = ""; return; }
    }
    setActiveJob(""); activeJobRef.current = ""; setProgress({ stage: "Пакет готов", currentPage: batchPaths.length, totalPages: batchPaths.length, percent: 100 });
    setResultPath(directory); setResultKind("batch"); if (workspaceAccess.editor) await templates.save(`Пакет ${new Date().toLocaleString("ru-RU")}`, { kind: "processing-journal", inputType: "BATCH", pageCount: batchPaths.length, preset, ocr: ocrEnabled, status: "completed", durationMs: Date.now() - startedAt }).catch(() => undefined);
  };

  const chooseFacsimile = async () => {
    const path = await chooseOpenPath("Выберите факсимиле", ["png", "jpg", "jpeg"]);
    if (!path) return;
    const imageUrl = await invoke<string>("read_binary_file", { path, maxBytes: 12 * 1024 * 1024 });
    setFacsimile(initialFacsimile(path, imageUrl, path.split(/[\\/]/).pop() || "Факсимиле", lastFacsimileWidth.current));
  };

  const useTemplate = async (template: ScannerRecord) => {
    if (!template.relativePath || !template.fileName) return;
    const workspace = await getWorkspaceInfo();
    const separator = workspace.root.includes("\\") ? "\\" : "/";
    const path = `${workspace.root}${separator}${template.relativePath.replace(/\//g, separator)}`;
    const imageUrl = await invoke<string>("read_binary_file", { path, maxBytes: 12 * 1024 * 1024 });
    setFacsimile(initialFacsimile(path, imageUrl, template.fileName, lastFacsimileWidth.current));
  };

  const saveFacsimileTemplate = async () => {
    if (!workspaceAccess.editor) { setError("Шаблоны в общей базе доступны только редактору."); return; }
    if (!facsimile) return;
    const id = crypto.randomUUID();
    const attachment = await copyAttachment(facsimile.imagePath, "scanner", id);
    await templates.save(facsimile.fileName, { kind: "facsimile-template", relativePath: attachment.relativePath, fileName: attachment.fileName }, id);
  };

  const updateCurrentFacsimileGeometry = (update: Partial<FacsimileGeometry>) => {
    setFacsimile((current) => current ? updateFacsimileGeometry(current, pageIndex, update) : current);
  };

  const updateSharedFacsimileAppearance = (update: Partial<Pick<FacsimileGeometry, "width" | "opacity" | "removeLightBackground">>) => {
    setFacsimile((current) => {
      if (!current) return current;
      const pageGeometries = Object.fromEntries(Object.entries(current.pageGeometries).map(([page, geometry]) => [page, { ...geometry, ...update }]));
      const next = { ...current, ...update, pageGeometries };
      if (update.width != null) lastFacsimileWidth.current = update.width;
      return next;
    });
  };

  const commitFacsimile = async (addAnother: boolean) => {
    if (!facsimile || !facsimileSelection.selection) return;
    if (!editingFacsimileId && facsimile.applyTo === "all" && pageCount > 1 && !window.confirm(`Зафиксировать факсимиле на всех ${pageCount} страницах?`)) return;
    lastFacsimileWidth.current = facsimile.width;
    const committed = { ...facsimile, lockedSelection: facsimileSelection.selection };
    setSavedFacsimiles((current) => editingFacsimileId
      ? current.map((entry) => entry.id === editingFacsimileId ? committed : entry)
      : [...current, committed]);
    const wasEditing = Boolean(editingFacsimileId);
    setFacsimile(null);
    setEditingFacsimileId("");
    if (addAnother && !wasEditing) await chooseFacsimile();
  };

  const editSavedFacsimile = (saved: FacsimileState) => {
    setFacsimile(structuredClone(saved));
    setEditingFacsimileId(saved.id);
    const firstPage = saved.lockedSelection?.pages[0];
    if (firstPage != null && firstPage !== pageIndex) {
      setPageIndex(firstPage);
      void makePreview(inputPath, preset, firstPage);
    }
  };

  const removeActiveFacsimile = () => {
    if (editingFacsimileId) setSavedFacsimiles((current) => current.filter((entry) => entry.id !== editingFacsimileId));
    setFacsimile(null);
    setEditingFacsimileId("");
  };

  const placeAllFacsimilesOnEveryPage = () => {
    setSavedFacsimiles((current) => current.map((entry) => {
      const geometry = facsimileGeometry(entry, pageIndex);
      return {
        ...entry,
        ...geometry,
        applyTo: "all",
        pageRange: "",
        lockedSelection: { application: "all", pages: [] },
        pageGeometries: {},
      };
    }));
  };

  const processDocument = async () => {
    if (!inputPath) return;
    if (facsimile && !facsimileSelection.selection) { setError(facsimileSelection.error); return; }
    if (outputPageSelection.error) { setError(outputPageSelection.error); return; }
    if (outputBlockSelection.error) { setError(outputBlockSelection.error); return; }
    if (facsimile?.applyTo === "all" && pageCount > 1 && !window.confirm(`Добавить факсимиле на все ${pageCount} страниц?`)) return;
    const base = documentName.replace(/\.(pdf|docx)$/i, "");
    const outputDirectory = outputPageMode === "blocks" ? await chooseDirectory("Выберите папку для блоков PDF") : null;
    if (outputPageMode === "blocks" && !outputDirectory) return;
    const outputPath = outputPageMode === "blocks" ? "" : await chooseSavePath("Сохранить обработанный PDF", `${base} — обработано.pdf`, ["pdf"]);
    if (outputPageMode !== "blocks" && !outputPath) return;
    // Expanding per-page facsimile overrides can touch all 5,000 pages. Do it
    // once when saving, never during pointer movement or ordinary React renders.
    const workerFacsimiles = facsimile && facsimileSelection.selection
      ? buildFacsimilePlacements(facsimile, facsimileSelection.selection, pageCount)
      : [];
    const savedWorkerFacsimiles = savedFacsimiles
      .filter((entry) => entry.id !== editingFacsimileId)
      .flatMap((entry) => buildFacsimilePlacements(entry, entry.lockedSelection || { application: "current", pages: [pageIndex] }, pageCount));
    const processingConfig = (selectedOutputPath: string, selectedPageOrder: number[]) => ({ protocolVersion: 2, inputPath, outputPath: selectedOutputPath, preset, ocrEnabled, ocrLanguages, pdfaEnabled, seed: 42, settings: { dpi, jpeg_quality: quality }, compressionTargetRatio, facsimiles: [...savedWorkerFacsimiles, ...workerFacsimiles], pageOrder: selectedPageOrder, pageRotations, redactions: redactions.map((entry) => ({ pages: [entry.page], x: entry.x, y: entry.y, width: entry.width, height: entry.height, color: entry.color })), annotations: annotations.map((entry) => ({ kind: entry.kind, pages: [entry.page], x: entry.x, y: entry.y, width: entry.width, height: entry.height, color: entry.color, intensity: entry.intensity, shape: entry.shape })) });

    if (outputPageMode === "blocks" && outputDirectory) {
      const separator = outputDirectory.includes("\\") ? "\\" : "/";
      const totalPages = outputBlockSelection.blocks.reduce((sum, block) => sum + block.order.length, 0);
      const startedAt = Date.now(); let completedPages = 0; let totalOutputBytes = 0; const combinedWarnings = new Set<string>();
      setError(""); setResultPath(""); setResultKind(""); setWarnings([]);
      try {
        for (const [index, block] of outputBlockSelection.blocks.entries()) {
          const blockOutputPath = `${outputDirectory}${separator}${base} — ${block.fileName}.pdf`;
          const jobId = crypto.randomUUID(); setActiveJob(jobId); activeJobRef.current = jobId;
          setProgress({ stage: `Блок ${index + 1} из ${outputBlockSelection.blocks.length}: ${block.name}`, currentPage: completedPages, totalPages, percent: Math.round(completedPages / totalPages * 100) });
          try {
            const response = await invoke<{ outputPath: string; warnings?: string[]; outputBytes?: number }>("scanner_run", { jobId, operation: "process", config: processingConfig(blockOutputPath, block.order) });
            response.warnings?.forEach((warning) => combinedWarnings.add(warning));
            totalOutputBytes += response.outputBytes || 0;
          } catch (reason) {
            throw new Error(`Блок «${block.name}»: ${String(reason)}`);
          }
          completedPages += block.order.length;
        }
        setResultPath(outputDirectory); setResultKind("split"); setWarnings([...combinedWarnings]); if (totalOutputBytes) setEstimatedOutputBytes(totalOutputBytes);
        setProgress({ stage: "Все блоки готовы", currentPage: totalPages, totalPages, percent: 100 });
        if (workspaceAccess.editor) await templates.save(`Разделение ${new Date().toLocaleString("ru-RU")}`, { kind: "processing-journal", inputType: inputPath.toLowerCase().endsWith(".docx") ? "DOCX" : "PDF", pageCount: totalPages, preset, ocr: ocrEnabled, status: "completed", durationMs: Date.now() - startedAt, appliedOperations: [`Файлов: ${outputBlockSelection.blocks.length}`, ...outputBlockSelection.blocks.map((block) => `${block.name}: ${block.order.length} стр.`)] }).catch(() => undefined);
      } catch (reason) {
        setError(String(reason)); setProgress(null);
        await templates.save(`Ошибка разделения ${new Date().toLocaleString("ru-RU")}`, { kind: "processing-journal", inputType: inputPath.toLowerCase().endsWith(".docx") ? "DOCX" : "PDF", pageCount: completedPages, preset, ocr: ocrEnabled, status: "failed", durationMs: Date.now() - startedAt }).catch(() => undefined);
      } finally { setActiveJob(""); activeJobRef.current = ""; }
      return;
    }

    if (!outputPath) return;
    const finalPageOrder = outputPageSelection.order;
    const jobId = crypto.randomUUID(); setActiveJob(jobId); activeJobRef.current = jobId; setProgress({ stage: "Подготовка", currentPage: 0, totalPages: finalPageOrder.length, percent: 0 }); setError(""); setResultPath(""); setResultKind(""); setWarnings([]);
    const startedAt = Date.now();
    try {
      const response = await invoke<{ outputPath: string; outputSha256?: string; warnings?: string[]; ocrConfidence?: number | null; ocrText?: string; lowConfidenceWords?: Array<{ page: number; text: string; confidence: number }>; outputBytes?: number; originalBytes?: number; savingsPercent?: number }>("scanner_run", { jobId, operation: "process", config: processingConfig(outputPath, finalPageOrder) });
      setResultPath(response.outputPath || outputPath); setResultKind("single"); setWarnings(response.warnings || []); setOcrConfidence(response.ocrConfidence ?? null); setOcrText(response.ocrText || ""); setLowConfidenceWords(response.lowConfidenceWords || []); if (response.outputBytes) setEstimatedOutputBytes(response.outputBytes); if (response.originalBytes) setOriginalBytes(response.originalBytes); if (response.savingsPercent != null) setEstimatedSavingsPercent(response.savingsPercent); setProgress({ stage: "Готово", currentPage: finalPageOrder.length, totalPages: finalPageOrder.length, percent: 100 });
      const logicalFacsimileCount = savedFacsimiles.length + (facsimile && !editingFacsimileId ? 1 : 0);
      const appliedOperations = [`Пресет: ${preset}`, `${dpi} dpi`, `Качество ${quality}%`, `Сжатие: ${compressionMode}`, ...(ocrEnabled ? [`OCR ${ocrLanguages}`] : []), ...(pdfaEnabled ? ["PDF/A-2b"] : []), ...(savedWorkerFacsimiles.length || workerFacsimiles.length ? [`Факсимиле: ${logicalFacsimileCount}`] : []), ...(redactions.length ? [`Скрытие областей: ${redactions.length}`] : []), ...(annotations.length ? [`Инструменты: ${annotations.length}`] : []), ...(pageOrder.some((value, index) => value !== index) ? ["Изменён порядок страниц"] : []), ...(finalPageOrder.length !== pageOrder.length ? ["Выбран диапазон итоговых страниц"] : []), ...(Object.values(pageRotations).some(Boolean) ? ["Поворот страниц"] : [])];
      if (workspaceAccess.editor) await templates.save(`Обработка ${new Date().toLocaleString("ru-RU")}`, { kind: "processing-journal", inputType: inputPath.toLowerCase().endsWith(".docx") ? "DOCX" : "PDF", pageCount: finalPageOrder.length, preset, ocr: ocrEnabled, status: "completed", durationMs: Date.now() - startedAt, outputSha256: response.outputSha256, appliedOperations }).catch(() => undefined);
    } catch (reason) { setError(String(reason)); setProgress(null); await templates.save(`Ошибка ${new Date().toLocaleString("ru-RU")}`, { kind: "processing-journal", inputType: inputPath.toLowerCase().endsWith(".docx") ? "DOCX" : "PDF", pageCount: finalPageOrder.length, preset, ocr: ocrEnabled, status: "failed", durationMs: Date.now() - startedAt }).catch(() => undefined); }
    finally { setActiveJob(""); activeJobRef.current = ""; }
  };

  const cancel = async () => { if (activeJob) await invoke("scanner_cancel", { jobId: activeJob }); };

  const openGeneratedPath = async (path: string, label: string) => {
    try {
      await openPath(path);
      setError("");
    } catch (reason) {
      setError(`Не удалось открыть ${label}: ${String(reason)}`);
    }
  };

  const revealGeneratedFile = async (path: string) => {
    try {
      await revealItemInDir(path);
      setError("");
    } catch (reason) {
      setError(`Не удалось открыть папку: ${String(reason)}`);
    }
  };

  const addDrawingOverlay = (origin: NormalizedRect) => {
    if (!drawingTool || showOriginal) return "";
    const id = crypto.randomUUID();
    if (drawingTool === "redaction") {
      setRedactions((items) => [...items, { id, page: pageIndex, ...origin, color: "black" }]);
      setSelectedOverlay({ kind: "redaction", id });
    } else {
      const defaults = {
        marker: { color: "#ffd84d", intensity: .6, shape: "rectangle" as const },
        stroke: { color: "#202020", intensity: .7, shape: "rectangle" as const },
        blur: { color: "#ffffff", intensity: .6, shape: "rectangle" as const },
        print_blur: { color: "#ffffff", intensity: .8, shape: "ellipse" as const },
      }[drawingTool];
      setAnnotations((items) => [...items, { id, kind: drawingTool, page: pageIndex, ...origin, ...defaults }]);
      setSelectedOverlay({ kind: "annotation", id });
    }
    return id;
  };

  const startDrawingOnPage = (event: PointerEvent<HTMLDivElement>) => {
    if (!drawingTool || showOriginal || !pageElement.current) return;
    event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
    const bounds = pageElement.current.getBoundingClientRect();
    const origin = normalizeRect({ x: (event.clientX - bounds.left) / bounds.width, y: (event.clientY - bounds.top) / bounds.height, width: .015, height: .015 }, .015);
    const id = addDrawingOverlay(origin);
    if (!id) return;
    dragState.current = { target: "draw", tool: drawingTool, id, start: { x: event.clientX, y: event.clientY } };
  };

  const drawFromKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!drawingTool || showOriginal || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    const ellipse = drawingTool === "print_blur";
    addDrawingOverlay(normalizeRect({ x: .4, y: .4, width: .2, height: ellipse ? .2 : .08 }, .015));
    setDrawingTool(null);
  };

  const startRectDrag = (target: "redaction" | "annotation", id: string, mode: "move" | ResizeHandle, event: PointerEvent<HTMLElement>) => {
    const source = target === "redaction" ? redactions.find((item) => item.id === id) : annotations.find((item) => item.id === id);
    if (!source) return;
    event.preventDefault(); event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId);
    setSelectedOverlay({ kind: target, id });
    dragState.current = { target, id, mode, start: { x: event.clientX, y: event.clientY }, initial: normalizeRect(source) };
  };

  const startRegionDrag = (mode: "move" | ResizeHandle, event: PointerEvent<HTMLElement>) => {
    if (!facsimile?.region) return;
    event.preventDefault(); event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId);
    const [x, y, width, height] = facsimile.region;
    dragState.current = { target: "region", mode, start: { x: event.clientX, y: event.clientY }, initial: normalizeRect({ x, y, width, height }, .05) };
  };

  const startFacsimileDrag = (mode: "move" | "resize" | "rotate", event: PointerEvent<HTMLElement>) => {
    if (!facsimile || !currentFacsimileGeometry || !pageElement.current) return;
    event.preventDefault(); event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId);
    const bounds = pageElement.current.getBoundingClientRect();
    const displayed = workerFacsimile ? positionFacsimileInRegion(workerFacsimile, pageIndex) : currentFacsimileGeometry;
    const initial = { ...currentFacsimileGeometry, x: displayed.x, y: displayed.y };
    const height = facsimileHeight(initial.width, previewAspect, facsimile.imageAspect);
    if (facsimile.placementMode === "random-region") setFacsimile((current) => current ? { ...current, placementMode: "region" } : current);
    dragState.current = {
      target: "facsimile", mode, start: { x: event.clientX, y: event.clientY }, initial,
      center: { x: bounds.left + (initial.x + initial.width / 2) * bounds.width, y: bounds.top + (initial.y + height / 2) * bounds.height },
    };
  };

  const moveInteractive = (event: PointerEvent<HTMLDivElement>) => {
    const action = dragState.current;
    if (!action || !pageElement.current) return;
    const bounds = pageElement.current.getBoundingClientRect();
    const delta = pointerDelta(action.start, { x: event.clientX, y: event.clientY }, bounds);
    if (action.target === "draw") {
      const next = drawnRect(action.start, { x: event.clientX, y: event.clientY }, bounds, action.tool === "print_blur", .015);
      if (action.tool === "redaction") setRedactions((items) => items.map((item) => item.id === action.id ? { ...item, ...next } : item));
      else setAnnotations((items) => items.map((item) => item.id === action.id ? { ...item, ...next } : item));
      return;
    }
    if (action.target === "redaction" || action.target === "annotation") {
      const next = action.mode === "move" ? moveRect(action.initial, delta.x, delta.y) : resizeRect(action.initial, action.mode, delta.x, delta.y, .015);
      if (action.target === "redaction") setRedactions((items) => items.map((item) => item.id === action.id ? { ...item, ...next } : item));
      else setAnnotations((items) => items.map((item) => item.id === action.id ? { ...item, ...next } : item));
      return;
    }
    if (action.target === "region") {
      const next = action.mode === "move" ? moveRect(action.initial, delta.x, delta.y) : resizeRect(action.initial, action.mode, delta.x, delta.y, .05);
      setFacsimile((current) => current ? { ...current, region: [next.x, next.y, next.width, next.height] } : current);
      return;
    }
    if (!facsimile || action.target !== "facsimile") return;
    if (action.mode === "rotate" && action.center) {
      updateCurrentFacsimileGeometry({ rotation: rotationFromPointer(action.center, action.start, { x: event.clientX, y: event.clientY }, action.initial.rotation) });
      return;
    }
    const candidate = normalizeFacsimile({
      x: action.initial.x + (action.mode === "move" ? delta.x : 0),
      y: action.initial.y + (action.mode === "move" ? delta.y : 0),
      width: action.initial.width + (action.mode === "resize" ? delta.x : 0),
      rotation: action.initial.rotation,
    }, previewAspect, facsimile.imageAspect);
    if (action.mode === "resize") {
      updateCurrentFacsimileGeometry({ x: candidate.x, y: candidate.y });
      updateSharedFacsimileAppearance({ width: candidate.width });
    } else updateCurrentFacsimileGeometry(candidate);
  };

  const stopInteractive = () => { if (dragState.current?.target === "draw") setDrawingTool(null); dragState.current = null; };

  const updateAnnotationIntensity = (id: string, percent: number) => setAnnotations((items) => items.map((item) => item.id === id ? { ...item, intensity: Math.max(.05, Math.min(1, percent / 100 || .05)) } : item));
  const nudge = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!facsimile || !currentFacsimileGeometry) return;
    const step = event.shiftKey ? 0.01 : 0.002;
    const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
    if (!delta) return;
    event.preventDefault();
    updateCurrentFacsimileGeometry(normalizeFacsimile({ ...currentFacsimileGeometry, x: currentFacsimileGeometry.x + delta[0], y: currentFacsimileGeometry.y + delta[1] }, previewAspect, facsimile.imageAspect));
  };
  const nudgeOverlay = (target: "redaction" | "annotation", id: string, event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      if (target === "redaction") setRedactions((items) => items.filter((item) => item.id !== id));
      else setAnnotations((items) => items.filter((item) => item.id !== id));
      setSelectedOverlay(null);
      return;
    }
    const step = event.shiftKey ? .01 : .002;
    const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
    if (!delta) return;
    event.preventDefault();
    if (target === "redaction") setRedactions((items) => items.map((item) => item.id === id ? { ...item, ...moveRect(item, delta[0], delta[1]) } : item));
    else setAnnotations((items) => items.map((item) => item.id === id ? { ...item, ...moveRect(item, delta[0], delta[1]) } : item));
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
  const changeOutputPageMode = (mode: OutputSaveMode) => {
    setOutputPageMode(mode);
    if (mode === "blocks" && outputBlocks.length === 0) {
      setOutputBlocks([{ id: crypto.randomUUID(), name: "Блок 1", pageRange: pageOrder.length > 1 ? `1-${pageOrder.length}` : "1" }]);
    }
  };
  const addOutputBlock = () => setOutputBlocks((current) => [...current, { id: crypto.randomUUID(), name: `Блок ${current.length + 1}`, pageRange: "" }]);
  const updateOutputBlock = (id: string, update: Partial<OutputBlockDefinition>) => setOutputBlocks((current) => current.map((block) => block.id === id ? { ...block, ...update } : block));
  const rotateCurrentPage = (degrees: -90 | 90) => setPageRotations((current) => {
    const next = ((current[pageIndex] || 0) + degrees + 360) % 360;
    const rotations = { ...current, [pageIndex]: next };
    void makePreview(inputPath, preset, pageIndex, rotations);
    return rotations;
  });

  const visibleOnCurrentPage = facsimile && facsimileSelection.selection
    && (facsimileSelection.selection.application === "all" || facsimileSelection.selection.pages.includes(pageIndex));
  const visibleSavedFacsimiles = savedFacsimiles
    .filter((entry) => entry.id !== editingFacsimileId)
    .map((entry) => {
      const selection = entry.lockedSelection || { application: "current" as const, pages: [pageIndex] };
      const geometry = facsimileGeometry(entry, pageIndex);
      return { saved: entry, placement: buildFacsimilePlacement({ ...entry, ...geometry }, selection) };
    })
    .filter(({ placement }) => facsimileAppliesTo(placement, pageIndex));
  return <div className="scanner-layout">
    <section className="surface scanner-controls"><div className="surface-title"><h2>Настройки</h2></div><div className="surface-body scanner-control-stack">
      <button className="primary full-width" type="button" onClick={() => void chooseDocument()}>{inputPath ? "Заменить файл" : "Выбрать PDF или DOCX"}</button><button className="secondary full-width" type="button" onClick={() => void chooseBatch()}>Пакетная обработка</button>{batchPaths.length > 0 && <div className="notice success"><span>Выбрано файлов: {batchPaths.length}</span><button className="primary small" type="button" onClick={() => void processBatch()}>Обработать пакет в папку</button></div>}{documentName && <p className="selected-file">▧ {documentName}</p>}
      <div><h3>Пресет</h3><div className="preset-grid">{presets.map(([name, description]) => <button key={name} className={preset === name ? "selected" : ""} type="button" onClick={() => { setPreset(name); void makePreview(inputPath, name, pageIndex); }}><strong>{name}</strong><small>{description}</small></button>)}</div></div>
      <div className="control-divider" />
      <div>
        <div className="inline-heading"><h3>Факсимиле</h3>{facsimile && <button className="link-button danger" type="button" onClick={removeActiveFacsimile}>Удалить</button>}</div>
        {!facsimile ? <>
          <button className="secondary full-width" type="button" onClick={() => void chooseFacsimile()}>Добавить факсимиле</button>
          {templates.records.filter((record) => record.payload.kind === "facsimile-template").length > 0 && <select aria-label="Шаблон факсимиле" defaultValue="" onChange={(event) => { const template = templates.records.find((record) => record.id === event.target.value); if (template) void useTemplate(template.payload); }}><option value="">Выбрать сохранённый шаблон</option>{templates.records.filter((record) => record.payload.kind === "facsimile-template").map((record) => <option key={record.id} value={record.id}>{record.title}</option>)}</select>}
        </> : <div className="facsimile-controls">
          <strong>{editingFacsimileId ? "Редактирование: " : ""}{facsimile.fileName}</strong>
          <label>Применить<select value={facsimile.applyTo} onChange={(event) => { const applyTo = event.target.value as FacsimileState["applyTo"]; setFacsimile({ ...facsimile, applyTo, placementMode: applyTo === "current" ? "manual" : facsimile.placementMode, lockedSelection: undefined }); }}><option value="current">к текущей странице</option><option value="range">к диапазону</option><option value="all">ко всем страницам</option></select></label>
          {facsimile.applyTo === "range" && <label>Страницы<input aria-invalid={!!facsimileSelection.error} value={facsimile.pageRange} placeholder="1-3, 5" onChange={(event) => setFacsimile({ ...facsimile, pageRange: event.target.value, lockedSelection: undefined })} />{facsimileSelection.error && <small className="field-error">{facsimileSelection.error}</small>}</label>}
          {facsimile.applyTo !== "current" && <><label>Размещение<select value={facsimile.placementMode || "manual"} onChange={(event) => setFacsimile({ ...facsimile, placementMode: event.target.value as NonNullable<FacsimileState["placementMode"]> })}><option value="manual">Одинаковое положение</option><option value="region">В выбранной области</option><option value="random-region">Случайно внутри области</option></select></label>{facsimile.placementMode !== "manual" && facsimile.region && <p className="help-text">Область перемещается и растягивается прямо на документе. Координаты вводить не нужно.</p>}<label className="checkbox-row"><input type="checkbox" checked={(facsimile.randomRotationDegrees || 0) > 0} onChange={(event) => setFacsimile({ ...facsimile, randomRotationDegrees: event.target.checked ? 8 : 0 })} /> Случайный поворот на разных страницах</label>{(facsimile.randomRotationDegrees || 0) > 0 && <label>Разброс поворота <input type="range" min="1" max="30" value={facsimile.randomRotationDegrees || 8} onChange={(event) => setFacsimile({ ...facsimile, randomRotationDegrees: event.target.valueAsNumber })} /> ±{Math.round(facsimile.randomRotationDegrees || 8)}°</label>}</>}
          {visibleOnCurrentPage && currentFacsimileGeometry && <>
            <label>Размер на всех выбранных страницах <input type="range" min="8" max="60" value={currentFacsimileGeometry.width * 100} onChange={(event) => updateSharedFacsimileAppearance({ width: normalizeFacsimile({ ...currentFacsimileGeometry, width: Number(event.target.value) / 100 }, previewAspect, facsimile.imageAspect).width })} /> {Math.round(currentFacsimileGeometry.width * 100)}%{pageSizeMm ? ` · ${(pageSizeMm[0] * currentFacsimileGeometry.width).toFixed(1)} мм` : ""}</label>
            <label>Поворот <input type="range" min="-180" max="180" value={currentFacsimileGeometry.rotation} onChange={(event) => updateCurrentFacsimileGeometry(normalizeFacsimile({ ...currentFacsimileGeometry, rotation: Number(event.target.value) }, previewAspect, facsimile.imageAspect))} /> {currentFacsimileGeometry.rotation}°</label>
            <label>Прозрачность на всех выбранных страницах <input type="range" min="10" max="100" value={currentFacsimileGeometry.opacity * 100} onChange={(event) => updateSharedFacsimileAppearance({ opacity: Number(event.target.value) / 100 })} /> {Math.round(currentFacsimileGeometry.opacity * 100)}%</label>
            <label className="checkbox-row"><input type="checkbox" checked={currentFacsimileGeometry.removeLightBackground} onChange={(event) => updateSharedFacsimileAppearance({ removeLightBackground: event.target.checked })} /> Удалить светлый фон на всех размещениях</label>
          </>}
          {!visibleOnCurrentPage && facsimileSelection.selection && <p className="help-text">Открытая страница не входит в выбранный диапазон факсимиле. Перейдите на одну из выбранных страниц для изменения её положения.</p>}
          {facsimileSelection.selection && facsimile.applyTo !== "current" && <><p className="help-text">Положение и угол можно настроить отдельно; размер, прозрачность и удаление фона общие для выбранных страниц.</p><button className="secondary small" type="button" onClick={() => setFacsimile((current) => current && facsimileSelection.selection ? applyGeometryToPages(current, pageIndex, selectedFacsimilePages(facsimileSelection.selection, pageCount)) : current)}>Скопировать положение на выбранные страницы</button></>}
          <button className="secondary small" type="button" onClick={() => void saveFacsimileTemplate()}>Сохранить изображение как шаблон</button>
          <button className="primary small" type="button" disabled={!facsimileSelection.selection} onClick={() => void commitFacsimile(false)}>{editingFacsimileId ? "Сохранить изменения" : "Зафиксировать"}</button>
        </div>}
      </div>
      {savedFacsimiles.length > 0 && <div className="notice success"><span>Зафиксировано факсимиле: {savedFacsimiles.length}</span><div className="facsimile-saved-list">{savedFacsimiles.map((saved, index) => <div className="facsimile-saved-row" key={saved.id}><span>{index + 1}. {saved.fileName}</span><div className="button-row"><button className="link-button" type="button" onClick={() => editSavedFacsimile(saved)}>Изменить</button><button className="link-button danger" type="button" onClick={() => { setSavedFacsimiles((current) => current.filter((entry) => entry.id !== saved.id)); if (editingFacsimileId === saved.id) { setFacsimile(null); setEditingFacsimileId(""); } }}>Удалить</button></div></div>)}</div>{savedFacsimiles.length > 1 && <button className="secondary small" type="button" onClick={placeAllFacsimilesOnEveryPage}>Объединить и разместить все на каждой странице</button>}<button className="link-button danger" type="button" onClick={() => { setSavedFacsimiles([]); setFacsimile(null); setEditingFacsimileId(""); }}>Удалить все</button></div>}
      {facsimile && workerFacsimile && !editingFacsimileId && <button className="secondary full-width" type="button" onClick={() => void commitFacsimile(true)}>Зафиксировать и добавить ещё</button>}
      <div className="control-divider" />
      <label className="checkbox-row"><input type="checkbox" checked={ocrEnabled} onChange={(event) => setOcrEnabled(event.target.checked)} /> Поисковый OCR <InfoHint label="Поисковый OCR">Добавляет в PDF невидимый текстовый слой: по документу можно искать и копировать распознанный текст. Работает локально, но увеличивает время обработки.</InfoHint></label>
      {ocrEnabled && <label>Языки OCR<select value={ocrLanguages} onChange={(event) => setOcrLanguages(event.target.value)}><option value="rus+eng">Русский + английский</option><option value="rus">Русский</option><option value="eng">Английский</option></select></label>}
      <label className="checkbox-row"><input type="checkbox" checked={pdfaEnabled} onChange={(event) => setPdfaEnabled(event.target.checked)} /> Архивный PDF/A-2b <InfoHint label="PDF/A-2b">Создаёт вариант PDF для долговременного хранения со встроенным цветовым профилем и метаданными. Может увеличить размер файла; это не электронная подпись.</InfoHint></label>
      <div className="compression-controls"><h3>Сжатие PDF</h3><label>Режим<select value={compressionMode} onChange={(event) => { const mode = event.target.value as CompressionMode; const profile = compressionProfile(mode); setCompressionMode(mode); if (profile.dpi) setDpi(profile.dpi); if (profile.quality) setQuality(profile.quality); }}><option value="none">Без целевого ограничения</option><option value="balanced">Бережное · цель около 70%</option><option value="strong">Сильное · цель около 50%</option><option value="maximum">Экстремальное · цель около 12%</option></select></label><p className="help-text">Оценка считается один раз по всему файлу и не меняется при переходе между страницами. Экстремальный режим использует 96 dpi и сильное JPEG-сжатие; мелкий текст следует проверить.</p></div>
      <details><summary>Точная настройка</summary><label>Разрешение<select value={dpi} onChange={(event) => setDpi(Number(event.target.value))}><option value="96">96 dpi</option><option value="120">120 dpi</option><option value="150">150 dpi</option><option value="200">200 dpi</option><option value="300">300 dpi</option></select></label><label>Качество PDF<input type="range" min="32" max="100" value={quality} onChange={(event) => setQuality(Number(event.target.value))} /> {quality}%</label><button className="secondary small" type="button" onClick={() => { setDpi(200); setQuality(84); }}>Вернуть значения пресета</button></details>
      <details><summary>Журнал обработки · {journal.length}</summary>{journal.length === 0 ? <p className="help-text">Записей пока нет.</p> : <div className="journal-list">{journal.map((record) => <div key={record.id}><strong>{record.payload.status === "completed" ? "✓" : "!"} {record.title}</strong><span>{record.payload.inputType} · {record.payload.pageCount || 0} стр. · {record.payload.durationMs ? `${(record.payload.durationMs / 1000).toFixed(1)} с` : "—"}</span>{record.payload.appliedOperations?.length ? <small>{record.payload.appliedOperations.join(" · ")}</small> : null}{record.payload.outputSha256 ? <small title={record.payload.outputSha256}>SHA-256: {record.payload.outputSha256.slice(0, 16)}…</small> : null}</div>)}</div>}</details>
      <div className="control-divider" />
      <div>
        <div className="inline-heading"><h3>Безвозвратное скрытие</h3><button className={`secondary small ${drawingTool === "redaction" ? "selected-tool" : ""}`} type="button" aria-pressed={drawingTool === "redaction"} disabled={!inputPath} onClick={() => setDrawingTool((current) => current === "redaction" ? null : "redaction")}>Нарисовать область</button></div>
        <p className="help-text">Выберите инструмент и протяните область на документе. Заливка применяется до OCR.</p>
        {redactions.map((entry) => <div className="geometry-control-card" key={entry.id}><div className="geometry-card-header"><strong>Стр. {entry.page + 1} · Скрытие</strong><button className="icon-button danger" type="button" aria-label="Удалить область скрытия" onClick={() => { setRedactions((items) => items.filter((item) => item.id !== entry.id)); setSelectedOverlay(null); }}>×</button></div><label className="geometry-inline-select"><span>Цвет</span><select aria-label="Цвет скрытия" value={entry.color} onChange={(event) => setRedactions((items) => items.map((item) => item.id === entry.id ? { ...item, color: event.target.value as RedactionState["color"] } : item))}><option value="black">Чёрный</option><option value="white">Белый</option></select></label></div>)}
      </div>
      <div className="control-divider" />
      <div>
        <div className="inline-heading"><h3>Инструменты страницы</h3></div>
        <div className="annotation-buttons">{(["marker", "stroke", "blur", "print_blur"] as const).map((kind) => <button key={kind} className={`secondary small ${drawingTool === kind ? "selected-tool" : ""}`} type="button" aria-pressed={drawingTool === kind} disabled={!inputPath} onClick={() => setDrawingTool((current) => current === kind ? null : kind)}>{{ marker: "Маркер", stroke: "Штрих", blur: "Размытие", print_blur: "Размытие для печати" }[kind]}</button>)}</div>
        <p className="help-text">Выберите инструмент и протяните его по документу. Обычное размытие создаётся прямоугольником, размытие для печати — кругом. Область перемещается и растягивается прямо на странице.</p>
        {annotations.map((entry) => <div className="geometry-control-card" key={entry.id}><div className="geometry-card-header"><strong>Стр. {entry.page + 1} · {{ marker: "Маркер", stroke: "Штрих", blur: "Размытие", print_blur: "Для печати" }[entry.kind]}</strong><button className="icon-button danger" type="button" aria-label="Удалить инструмент" onClick={() => { setAnnotations((items) => items.filter((item) => item.id !== entry.id)); setSelectedOverlay(null); }}>×</button></div><label className="geometry-intensity"><span>{entry.kind === "blur" || entry.kind === "print_blur" ? "Сила размытия" : "Интенсивность / прозрачность"}</span><span><input aria-label={`Интенсивность инструмента на странице ${entry.page + 1}`} type="range" min="5" max="100" value={Math.round(entry.intensity * 100)} onChange={(event) => updateAnnotationIntensity(entry.id, event.target.valueAsNumber)} /><output>{Math.round(entry.intensity * 100)}%</output></span></label></div>)}
      </div>
    </div></section>
    <section className={`surface preview-panel ${fullscreen ? "fullscreen-preview" : ""}`}><div className="surface-title"><h2>Предпросмотр</h2><div className="button-row">{originalUrl && <button className="secondary small" type="button" onClick={() => setShowOriginal((value) => !value)}>{showOriginal ? "Показать обработку" : "Показать оригинал"}</button>}<button className="secondary small" type="button" disabled={previewZoom <= .5} aria-label="Уменьшить масштаб" onClick={() => setPreviewZoom((value) => Math.max(.5, Number((value - .25).toFixed(2))))}>−</button><button className="secondary small zoom-value" type="button" title="Сбросить масштаб" onClick={() => setPreviewZoom(1)}>{Math.round(previewZoom * 100)}%</button><button className="secondary small" type="button" disabled={previewZoom >= 2} aria-label="Увеличить масштаб" onClick={() => setPreviewZoom((value) => Math.min(2, Number((value + .25).toFixed(2))))}>+</button><button className="secondary small" type="button" onClick={() => setFullscreen((value) => !value)}>{fullscreen ? "Закрыть полный экран" : "На весь экран"}</button><span>{pageCount ? `Страница ${pageIndex + 1} из ${pageCount}` : "Файл не выбран"} · {preset}</span></div></div>
      {inputPath && <>
        <div className="page-editor"><span>Итоговый порядок ({pageOrder.length}):</span><div>{pageWindow.omittedBefore > 0 && <span className="page-gap">…{pageWindow.omittedBefore}…</span>}{pageWindow.pages.map((sourceIndex) => <button key={sourceIndex} className={sourceIndex === pageIndex ? "active" : ""} type="button" onClick={() => { setPageIndex(sourceIndex); void makePreview(inputPath, preset, sourceIndex); }}>{sourceIndex + 1}{pageRotations[sourceIndex] ? ` · ${pageRotations[sourceIndex]}°` : ""}</button>)}{pageWindow.omittedAfter > 0 && <span className="page-gap">…{pageWindow.omittedAfter}…</span>}</div><label className="page-jump">К странице<input type="number" min="1" max={pageCount} value={pageIndex + 1} onChange={(event) => { const selected = Math.max(0, Math.min(pageCount - 1, Number(event.target.value) - 1)); setPageIndex(selected); void makePreview(inputPath, preset, selected); }} /></label><button className="secondary small" type="button" onClick={() => moveCurrentPage(-1)}>← Раньше</button><button className="secondary small" type="button" onClick={() => moveCurrentPage(1)}>Позже →</button><button className="secondary small" type="button" onClick={() => rotateCurrentPage(-90)}>↶ 90°</button><button className="secondary small" type="button" onClick={() => rotateCurrentPage(90)}>↷ 90°</button><button className="secondary small danger" type="button" onClick={deleteCurrentPage}>Удалить страницу</button><button className="link-button" type="button" onClick={() => { const rotations = {}; setPageOrder(Array.from({ length: pageCount }, (_, index) => index)); setPageRotations(rotations); void makePreview(inputPath, preset, pageIndex, rotations); }}>Сбросить</button></div>
        <div className="output-page-selection">
          <label>Сохранение страниц<select value={outputPageMode} onChange={(event) => changeOutputPageMode(event.target.value as OutputSaveMode)}><option value="all">Один PDF · все страницы</option><option value="range">Один PDF · выбранные страницы</option><option value="blocks">Несколько PDF · блоки страниц</option></select></label>
          {outputPageMode === "range" && <label>Номера страниц готового PDF<input aria-invalid={!!outputPageSelection.error} value={outputPageRange} placeholder="1-3, 5, 8-10" onChange={(event) => setOutputPageRange(event.target.value)} /></label>}
          {outputPageMode === "blocks" ? <div className="split-blocks"><p>Страницы указываются по итоговому порядку. Одна страница может входить в несколько блоков.</p>{outputBlocks.map((block, index) => <div className="split-block-row" key={block.id}><label>Название файла<input aria-label={`Название блока ${index + 1}`} value={block.name} placeholder={`Блок ${index + 1}`} onChange={(event) => updateOutputBlock(block.id, { name: event.target.value })} /></label><label>Страницы<input aria-label={`Страницы блока ${index + 1}`} aria-invalid={!!outputBlockSelection.error} value={block.pageRange} placeholder="1-3, 7, 10-12" onChange={(event) => updateOutputBlock(block.id, { pageRange: event.target.value })} /></label><button className="icon-button danger" type="button" aria-label={`Удалить блок ${index + 1}`} onClick={() => setOutputBlocks((current) => current.filter((entry) => entry.id !== block.id))}>×</button></div>)}<div className="split-block-footer"><button className="secondary small" type="button" onClick={addOutputBlock}>Добавить блок</button><span>{outputBlockSelection.error ? <small className="field-error">{outputBlockSelection.error}</small> : `Будет создано файлов: ${outputBlockSelection.blocks.length}.`}</span></div></div> : <span>{outputPageSelection.error ? <small className="field-error">{outputPageSelection.error}</small> : `Будет сохранено страниц: ${outputPageSelection.order.length}. Перестановка и удаления учитываются.`}</span>}
        </div>
      </>}
      {!inputPath ? <div className="drop-empty" onClick={() => void chooseDocument()}><span>▧</span><h2>Выберите документ</h2><p>PDF или DOCX до 1 ГБ и до 5000 страниц. Исходный файл не изменяется.</p><button className="primary" type="button">Выбрать файл</button></div> : <div className={`preview-workspace ${pageCount > 1 ? "" : "single-page"}`}>
        {pageCount > 1 && <aside className="page-strip" aria-label="Страницы">{pageWindow.omittedBefore > 0 && <span className="page-gap">+{pageWindow.omittedBefore}</span>}{pageWindow.pages.map((sourceIndex) => <button key={sourceIndex} className={pageIndex === sourceIndex ? "active" : ""} type="button" onClick={() => { setPageIndex(sourceIndex); void makePreview(inputPath, preset, sourceIndex); }}><span>{sourceIndex + 1}</span></button>)}{pageWindow.omittedAfter > 0 && <span className="page-gap">+{pageWindow.omittedAfter}</span>}</aside>}
        <div className="document-stage">
          <div ref={pageElement} className={`document-page real-preview ${drawingTool ? "drawing-tool-active" : ""}`} role="group" tabIndex={0} aria-label={drawingTool ? `Полотно документа: применить инструмент «${{ redaction: "Скрытие", marker: "Маркер", stroke: "Штрих", blur: "Размытие", print_blur: "Размытие для печати" }[drawingTool]}» клавишей Enter или протянуть мышью` : "Полотно документа"} style={{ aspectRatio: String(previewAspect), width: `${72 * previewZoom}%`, maxWidth: `${720 * previewZoom}px` }} onKeyDown={drawFromKeyboard} onPointerDown={startDrawingOnPage} onPointerMove={moveInteractive} onPointerUp={stopInteractive} onPointerCancel={stopInteractive} onLostPointerCapture={stopInteractive}>
            {previewUrl && <img className="page-image" draggable={false} src={showOriginal && originalUrl ? originalUrl : previewUrl} alt={`${showOriginal ? "Оригинал" : "Обработка"} страницы ${pageIndex + 1}`} onLoad={(event) => setPreviewAspect(event.currentTarget.naturalWidth / Math.max(1, event.currentTarget.naturalHeight))} />}
            {previewing && <div className="preview-loader" role="status" aria-live="polite"><span className="loading-spinner" aria-hidden="true" /><strong>Загружаем документ</strong><small>Подготавливаем страницу и рассчитываем весь файл…</small></div>}
            {!showOriginal && facsimile && facsimile.applyTo !== "current" && facsimile.placementMode !== "manual" && facsimile.region && <div className="facsimile-region editable-geometry selected" role="button" tabIndex={0} aria-label="Область размещения факсимиле: перетаскивайте или изменяйте размер за углы" style={{ left: `${facsimile.region[0] * 100}%`, top: `${facsimile.region[1] * 100}%`, width: `${facsimile.region[2] * 100}%`, height: `${facsimile.region[3] * 100}%` }} onPointerDown={(event) => startRegionDrag("move", event)}><ResizeHandles onStart={(handle, event) => startRegionDrag(handle, event)} /></div>}
            {!showOriginal && redactions.filter((entry) => entry.page === pageIndex).map((entry) => <div key={entry.id} className={`redaction-overlay editable-geometry ${selectedOverlay?.kind === "redaction" && selectedOverlay.id === entry.id ? "selected" : ""} ${entry.color}`} role="button" tabIndex={0} aria-label={`Область скрытия на странице ${entry.page + 1}`} style={{ left: `${entry.x * 100}%`, top: `${entry.y * 100}%`, width: `${entry.width * 100}%`, height: `${entry.height * 100}%` }} onKeyDown={(event) => nudgeOverlay("redaction", entry.id, event)} onPointerDown={(event) => startRectDrag("redaction", entry.id, "move", event)}>{selectedOverlay?.kind === "redaction" && selectedOverlay.id === entry.id && <ResizeHandles onStart={(handle, event) => startRectDrag("redaction", entry.id, handle, event)} />}</div>)}
            {!showOriginal && annotations.filter((entry) => entry.page === pageIndex).map((entry) => <div key={entry.id} className={`annotation-overlay editable-geometry ${entry.kind} ${entry.shape} ${selectedOverlay?.kind === "annotation" && selectedOverlay.id === entry.id ? "selected" : ""}`} role="button" tabIndex={0} aria-label={`${{ marker: "Маркер", stroke: "Штрих", blur: "Размытие", print_blur: "Размытие для печати" }[entry.kind]} на странице ${entry.page + 1}`} style={{ left: `${entry.x * 100}%`, top: `${entry.y * 100}%`, width: `${entry.width * 100}%`, height: `${entry.height * 100}%`, backgroundColor: entry.kind === "marker" ? entry.color : undefined, opacity: entry.kind === "marker" ? Math.max(.08, entry.intensity * .65) : Math.max(.12, entry.intensity), borderColor: entry.kind === "stroke" ? entry.color : undefined, backdropFilter: entry.kind === "blur" ? `blur(${2 + entry.intensity * 10}px)` : entry.kind === "print_blur" ? `blur(${4 + entry.intensity * 14}px)` : undefined }} onKeyDown={(event) => nudgeOverlay("annotation", entry.id, event)} onPointerDown={(event) => startRectDrag("annotation", entry.id, "move", event)}>{selectedOverlay?.kind === "annotation" && selectedOverlay.id === entry.id && <ResizeHandles onStart={(handle, event) => startRectDrag("annotation", entry.id, handle, event)} />}</div>)}
            {!showOriginal && visibleSavedFacsimiles.map(({ saved, placement }, index) => <div className="facsimile real saved" role="button" tabIndex={0} aria-label={`Изменить зафиксированное факсимиле ${saved.fileName}`} key={`${saved.id}-${index}`} style={facsimileOverlayStyle(positionFacsimileInRegion(placement, pageIndex))} onClick={() => editSavedFacsimile(saved)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") editSavedFacsimile(saved); }}><img src={placement.imageUrl} alt="Зафиксированное факсимиле" style={{ opacity: placement.opacity, mixBlendMode: placement.removeLightBackground ? "multiply" : "normal" }} /></div>)}
            {!showOriginal && visibleOnCurrentPage && workerFacsimile && currentFacsimileGeometry && <div className="facsimile real editable-geometry selected" role="button" tabIndex={0} aria-label="Факсимиле: перемещайте стрелками или мышью, меняйте размер и поворот ручками" style={facsimileOverlayStyle(positionFacsimileInRegion(workerFacsimile, pageIndex))} onKeyDown={nudge} onPointerDown={(event) => startFacsimileDrag("move", event)}><img src={facsimile.imageUrl} alt="Факсимиле" onLoad={(event) => { const aspect = event.currentTarget.naturalWidth / Math.max(1, event.currentTarget.naturalHeight); setFacsimile((current) => current && Math.abs(current.imageAspect - aspect) > .001 ? { ...current, imageAspect: aspect } : current); }} style={{ opacity: currentFacsimileGeometry.opacity, mixBlendMode: currentFacsimileGeometry.removeLightBackground ? "multiply" : "normal" }} /><button className="facsimile-resize-handle" type="button" aria-label="Изменить размер факсимиле" onPointerDown={(event) => startFacsimileDrag("resize", event)} /><button className="facsimile-rotate-handle" type="button" aria-label="Повернуть факсимиле" onPointerDown={(event) => startFacsimileDrag("rotate", event)}>↻</button></div>}
          </div>
        </div>
      </div>}
      {error && <div className="scanner-error"><strong>Не удалось обработать документ</strong><span>{error}</span><div><button className="secondary" type="button" onClick={() => void makePreview()}>Повторить</button>{ocrEnabled && <button className="secondary" type="button" onClick={() => setOcrEnabled(false)}>Без OCR</button>}<button className="secondary" type="button" onClick={() => void chooseDocument()}>Другой файл</button></div></div>}
      {warnings.length > 0 && <div className="notice warning"><strong>Проверьте результат</strong>{warnings.map((warning) => <span key={warning}>{warning}</span>)}</div>}
      {inputPath && <div className="scanner-estimate"><span>Исходный размер: {originalBytes ? `${(originalBytes / 1024 / 1024).toFixed(1)} МБ` : "считается"}</span><span>{resultKind === "single" ? "Размер результата" : "Оценка результата"}: {estimatedOutputBytes ? `${resultKind === "single" ? "" : "≈ "}${(estimatedOutputBytes / 1024 / 1024).toFixed(1)} МБ` : "рассчитывается"}</span>{originalBytes > 0 && estimatedOutputBytes > 0 && <span className={estimatedSavingsPercent >= 0 ? "estimate-good" : "estimate-warning"}>{estimatedSavingsPercent >= 0 ? `Меньше ${resultKind === "single" ? "" : "примерно "}на ${estimatedSavingsPercent.toFixed(0)}%` : `Больше ${resultKind === "single" ? "" : "примерно "}на ${Math.abs(estimatedSavingsPercent).toFixed(0)}%`}</span>}{pageSizeMm && <span>Страница: {pageSizeMm[0].toFixed(1)} × {pageSizeMm[1].toFixed(1)} мм</span>}{ocrConfidence != null && <span>Средняя уверенность OCR: {ocrConfidence.toFixed(1)}%</span>}</div>}
      {ocrText && <details className="ocr-result"><summary>Распознанный текст · сомнительных слов: {lowConfidenceWords.length}</summary><textarea readOnly rows={10} value={ocrText} aria-label="Распознанный текст" />{lowConfidenceWords.length > 0 && <div className="low-confidence-list">{lowConfidenceWords.slice(0, 100).map((word, index) => <span key={`${word.page}-${index}`} title={`Страница ${word.page}`}>{word.text} · {word.confidence.toFixed(0)}%</span>)}</div>}<p className="help-text">Текст показывается только в текущем окне и не записывается в журнал обработки.</p></details>}
      {progress && <div className="progress-panel"><div><strong>{progress.stage}</strong><span>{progress.totalPages ? `Страница ${progress.currentPage} из ${progress.totalPages}` : ""}</span></div><progress max="100" value={progress.percent} /><strong>{progress.percent}%</strong>{activeJob && <button className="secondary" type="button" onClick={() => void cancel()}>Отменить</button>}</div>}
      {resultPath ? resultKind === "batch" || resultKind === "split" ? <div className="ready-panel"><div><strong>✓ {resultKind === "split" ? "Блоки PDF готовы" : "Пакет готов"}</strong><span>{resultPath}</span></div><button className="primary" type="button" onClick={() => void openGeneratedPath(resultPath, "папку")}>Открыть папку</button><button className="secondary" type="button" onClick={() => { if (resultKind === "batch") setBatchPaths([]); setResultPath(""); setResultKind(""); setProgress(null); }}>{resultKind === "split" ? "Изменить блоки" : "Другой пакет"}</button></div> : <div className="ready-panel"><div><strong>✓ PDF готов</strong><span>{resultPath}</span></div><button className="secondary" type="button" onClick={() => void openGeneratedPath(resultPath, "PDF")}>Открыть PDF</button><button className="secondary" type="button" onClick={() => void revealGeneratedFile(resultPath)}>Открыть папку</button><button className="primary" disabled={!!activeJob || !!facsimileSelection.error || !!outputPageSelection.error || !!outputBlockSelection.error} type="button" onClick={() => void processDocument()}>Сохранить ещё одну версию</button><button className="secondary" type="button" onClick={() => { setInputPath(""); setPreviewUrl(""); setPageCount(0); setResultPath(""); setResultKind(""); setWarnings([]); setProgress(null); setFacsimile(null); setSavedFacsimiles([]); setEditingFacsimileId(""); previewCache.current.clear(); }}>Другой файл</button></div> : <div className="actionbar"><span>{facsimileSelection.error || outputPageSelection.error || outputBlockSelection.error || (facsimile ? "Факсимиле перемещается и поворачивается мгновенно, без повторной загрузки документа" : outputPageMode === "blocks" ? "Настройте блоки и сохраните несколько PDF" : "Выберите пресет и сохраните новый PDF")}</span><button className="primary" disabled={!inputPath || !!activeJob || !!facsimileSelection.error || !!outputPageSelection.error || !!outputBlockSelection.error} type="button" onClick={() => void processDocument()}>{outputPageMode === "blocks" ? "Сохранить блоки PDF" : "Сохранить PDF"}</button></div>}
    </section>
  </div>;
}
