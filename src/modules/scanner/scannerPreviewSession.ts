import { BoundedPreviewCache, previewCacheKey } from "./facsimilePreview";
import type { PreviewImage } from "./scannerPreviewImages";

export interface PreviewSettings {
  inputPath: string;
  preset: string;
  pageIndex: number;
  dpi: number;
  quality: number;
  compressionMode: string;
  compressionTargetRatio?: number;
  pageRotations: Record<number, number>;
}
export interface PreviewResult {
  retainedBytes?: number;
  previewUrl: string;
  originalUrl: string;
  pageCount: number;
  warnings: string[];
  estimatedOutputBytes: number;
  originalBytes: number;
  pageSizePoints?: [number, number];
  sourceFingerprint?: string;
}
export interface WorkerPreview {
  outputPath: string;
  originalPath?: string;
  pageIndex?: number;
  pageCount: number;
  warnings?: string[];
  estimatedOutputBytes?: number;
  originalBytes?: number;
  pageSizePoints?: [number, number];
  sourceFingerprint?: string;
}
export interface PreparedPreviews {
  pageCount: number;
  sourceFingerprint?: string;
  previews: WorkerPreview[];
}
export type PreviewPreparation = { state: "idle" | "preparing" | "ready" | "unavailable" | "changed"; prepared: number; total: number };
export const SOURCE_CHANGED_MESSAGE = "Исходный документ изменился. Откройте его повторно через «Заменить файл», чтобы не применить разметку к другой версии.";
export interface PreviewTransport {
  run(jobId: string, operation: "preview" | "preparePreview", config: Record<string, unknown>): Promise<WorkerPreview | PreparedPreviews>;
  cancel(jobId: string): Promise<unknown>;
  read(path: string): Promise<string | PreviewImage>;
  release?(url: string): void;
  remove(path: string): Promise<unknown>;
  revision(path: string): Promise<string>;
}

export function previewSettingsKey(settings: PreviewSettings): string {
  return previewCacheKey({ ...settings, pageRotation: settings.pageRotations[settings.pageIndex] || 0, redactions: [], annotations: [] });
}

/** Follow the user's arranged page order; never warm deleted pages or the whole file. */
export function neighboringPages(order: number[], current: number): number[] {
  const position = order.indexOf(current);
  if (position < 0) return [];
  return [...new Set([order[position + 1], order[position + 2], order[position - 1]])]
    .filter((page): page is number => Number.isInteger(page) && page >= 0 && page !== current);
}

function workerConfig(settings: PreviewSettings): Record<string, unknown> {
  return { protocolVersion: 2, inputPath: settings.inputPath, preset: settings.preset, pageIndex: settings.pageIndex,
    seed: 42, settings: { dpi: settings.dpi, jpeg_quality: settings.quality }, compressionTargetRatio: settings.compressionTargetRatio,
    pageRotations: settings.pageRotations, redactions: [], annotations: [] };
}

/** Foreground navigation always preempts bounded, best-effort background work. */
export class ScannerPreviewSession {
  private activeResult: PreviewResult | undefined;
  private displayedResult: PreviewResult | undefined;
  private readonly retained = new Set<PreviewResult>();
  private readonly cache = new BoundedPreviewCache<PreviewResult>(16, 48 * 1024 * 1024,
    (value) => value.retainedBytes ?? (value.previewUrl.length + value.originalUrl.length) * 2,
    (value) => { this.retained.delete(value); if (!this.isPinned(value)) this.releaseResult(value); });
  private foreground = "";
  private background = "";
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private fingerprint: string | undefined;
  private sourceRevision = "";
  private sourcePath = "";
  private changed = false;
  private sourceEpoch = 0;

  constructor(private readonly transport: PreviewTransport, private readonly report: (status: PreviewPreparation) => void) {}

  isCached(settings: PreviewSettings): boolean { return this.cache.has(previewSettingsKey(settings)); }
  get sourceFingerprint(): string | undefined { return this.fingerprint; }
  get sourceGeneration(): number { return this.sourceEpoch; }

  private sourceChanged(): never {
    this.changed = true;
    this.clearImages();
    this.report({ state: "changed", prepared: 0, total: 0 });
    throw new Error(SOURCE_CHANGED_MESSAGE);
  }

  private async checkRevision(path: string, isCurrent: () => boolean): Promise<boolean> {
    if (!isCurrent()) return false;
    if (this.changed) return this.sourceChanged();
    const revision = await this.transport.revision(path);
    if (!isCurrent()) return false;
    if (this.sourcePath && (this.sourcePath !== path || this.sourceRevision !== revision)) return this.sourceChanged();
    this.sourcePath = path;
    this.sourceRevision = revision;
    return true;
  }

  async verifySource(): Promise<boolean> {
    if (!this.sourcePath) return false;
    const epoch = this.sourceEpoch;
    return this.checkRevision(this.sourcePath, () => epoch === this.sourceEpoch);
  }

  private cancel(jobId: string) { if (jobId) void this.transport.cancel(jobId).catch(() => undefined); }

  pause() {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.generation += 1;
    this.cancel(this.background);
    this.background = "";
  }

  clear() {
    this.pause();
    this.cancel(this.foreground);
    this.foreground = "";
    this.fingerprint = undefined;
    this.sourceRevision = "";
    this.sourcePath = "";
    this.changed = false;
    this.sourceEpoch += 1;
    this.clearImages();
  }

  private releaseResult(result: PreviewResult) {
    for (const url of new Set([result.previewUrl, result.originalUrl])) if (url) this.transport.release?.(url);
  }

  private isPinned(result: PreviewResult) { return result === this.activeResult || result === this.displayedResult; }

  /** React acknowledges the committed image; cleanup cannot revoke the old frame early. */
  confirmDisplayed(previewUrl: string) {
    const previous = this.displayedResult;
    if (previewUrl && this.activeResult?.previewUrl !== previewUrl) return;
    this.displayedResult = previewUrl ? this.activeResult : undefined;
    if (previous && !this.isPinned(previous) && !this.retained.has(previous)) this.releaseResult(previous);
  }

  private clearImages() {
    const pinned = new Set([this.activeResult, this.displayedResult]);
    this.activeResult = undefined;
    this.displayedResult = undefined;
    for (const value of pinned) if (value && !this.retained.has(value)) this.releaseResult(value);
    this.cache.clear();
  }

  private activate(result: PreviewResult) {
    const previous = this.activeResult;
    this.activeResult = result;
    // The displayed page survives speculative cache eviction until replaced.
    if (previous && !this.isPinned(previous) && !this.retained.has(previous)) this.releaseResult(previous);
  }

  private store(settings: PreviewSettings, result: PreviewResult) {
    this.retained.add(result);
    this.cache.set(previewSettingsKey(settings), result);
  }

  private async removeOutputs(responses: WorkerPreview[]) {
    const paths = [...new Set(responses.flatMap((response) => [response.outputPath, response.originalPath]).filter((path): path is string => !!path))];
    await Promise.all(paths.map((path) => this.transport.remove(path).catch(() => undefined)));
  }

  private async readResult(response: WorkerPreview): Promise<PreviewResult> {
    if (!Number.isInteger(response.pageCount) || response.pageCount < 1 || response.pageCount > 5000) throw new Error("Недопустимое число страниц в документе.");
    const results = await Promise.allSettled([
      this.transport.read(response.outputPath), response.originalPath ? this.transport.read(response.originalPath) : Promise.resolve(""),
    ]);
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") {
      for (const result of results) if (result.status === "fulfilled") {
        this.transport.release?.(typeof result.value === "string" ? result.value : result.value.url);
      }
      throw failed.reason;
    }
    const images = results.map((result) => result.status === "fulfilled" ? result.value : "");
    const [previewUrl, originalUrl] = images.map((image) => typeof image === "string" ? image : image.url);
    const retainedBytes = images.reduce((size, image) => size + (typeof image === "string" ? image.length * 2 : image.retainedBytes), 0);
    return { previewUrl, originalUrl, pageCount: response.pageCount, warnings: response.warnings || [],
      retainedBytes,
      estimatedOutputBytes: response.estimatedOutputBytes || 0, originalBytes: response.originalBytes || 0,
      pageSizePoints: response.pageSizePoints, sourceFingerprint: response.sourceFingerprint };
  }

  async request(settings: PreviewSettings, jobId: string): Promise<PreviewResult | undefined> {
    this.pause();
    this.cancel(this.foreground);
    this.foreground = jobId;
    let response: WorkerPreview | undefined;
    let loaded: PreviewResult | undefined;
    try {
      if (!await this.checkRevision(settings.inputPath, () => this.foreground === jobId)) return undefined;
      const cached = this.cache.get(previewSettingsKey(settings));
      if (cached) { this.activate(cached); return cached; }
      response = await this.transport.run(jobId, "preview", workerConfig(settings)) as WorkerPreview;
      if (this.foreground !== jobId) return undefined;
      const result = await this.readResult(response);
      loaded = result;
      if (this.foreground !== jobId) return undefined;
      if (!await this.checkRevision(settings.inputPath, () => this.foreground === jobId)) return undefined;
      if (this.fingerprint && result.sourceFingerprint && this.fingerprint !== result.sourceFingerprint) return this.sourceChanged();
      this.fingerprint = result.sourceFingerprint;
      this.activate(result);
      this.store(settings, result);
      return result;
    } finally {
      if (this.foreground === jobId) this.foreground = "";
      if (loaded && loaded !== this.activeResult && !this.retained.has(loaded)) this.releaseResult(loaded);
      if (response) await this.removeOutputs([response]);
    }
  }

  schedule(settings: PreviewSettings, order: number[]) {
    this.pause();
    const neighbors = neighboringPages(order, settings.pageIndex);
    const missing = neighbors.filter((pageIndex) => !this.isCached({ ...settings, pageIndex }));
    const initial = neighbors.length - missing.length;
    this.report({ state: missing.length ? "preparing" : neighbors.length ? "ready" : "idle", prepared: initial, total: neighbors.length });
    const generation = this.generation;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.prepare(settings, missing, neighbors, generation);
    }, 500);
  }

  private async prepare(settings: PreviewSettings, pages: number[], neighbors: number[], generation: number) {
    if (generation !== this.generation) return;
    const jobId = crypto.randomUUID();
    this.background = jobId;
    const total = neighbors.length;
    const preparedCount = () => neighbors.filter((pageIndex) => this.isCached({ ...settings, pageIndex })).length;
    let responses: WorkerPreview[] = [];
    try {
      if (!await this.checkRevision(settings.inputPath, () => generation === this.generation)) return;
      if (!pages.length) return;
      const response = await this.transport.run(jobId, "preparePreview", { ...workerConfig(settings), pageIndices: pages }) as PreparedPreviews;
      responses = response.previews || [];
      if (generation !== this.generation) return;
      if (!await this.checkRevision(settings.inputPath, () => generation === this.generation)) return;
      if (this.fingerprint && response.sourceFingerprint !== this.fingerprint) return this.sourceChanged();
      for (const page of responses) {
        if (generation !== this.generation) return;
        if (!Number.isInteger(page.pageIndex) || !pages.includes(page.pageIndex!)) continue;
        const result = await this.readResult(page);
        if (generation !== this.generation) { this.releaseResult(result); return; }
        const pageSettings = { ...settings, pageIndex: page.pageIndex! };
        this.store(pageSettings, result);
        this.report({ state: "preparing", prepared: preparedCount(), total });
      }
      const prepared = preparedCount();
      this.report({ state: prepared === total ? "ready" : "unavailable", prepared, total });
    } catch {
      if (generation === this.generation && !this.changed) this.report({ state: "unavailable", prepared: preparedCount(), total });
      // Navigation remains available when speculative preparation fails or disk is full.
    } finally {
      if (this.background === jobId) this.background = "";
      await this.removeOutputs(responses);
    }
  }
}
