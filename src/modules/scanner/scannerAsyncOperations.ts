/** Always release temporary rasters, including stale/cancelled preview responses. */
export async function readCurrentPreview(
  response: { outputPath: string; originalPath?: string },
  read: (path: string) => Promise<string>,
  remove: (path: string) => Promise<unknown>,
  isCurrent: () => boolean,
): Promise<string | undefined> {
  try {
    if (!isCurrent()) return undefined;
    const image = await read(response.outputPath);
    return isCurrent() ? image : undefined;
  } finally {
    await Promise.all([...new Set([response.outputPath, response.originalPath].filter((path): path is string => !!path))]
      .map((path) => remove(path).catch(() => undefined)));
  }
}

/** Ref-backed admission: a second click cannot enter before React rerenders. */
export class ScannerSingleFlight {
  private pending = false;
  get busy() { return this.pending; }
  async run<T>(operation: () => Promise<T>): Promise<T | undefined> {
    if (this.pending) return undefined;
    this.pending = true;
    try { return await operation(); } finally { this.pending = false; }
  }
}

export interface SplitOutcome {
  inputPath: string; outputPath: string; pages: number[];
  status: "planned" | "working" | "done" | "error";
  error?: string; outputBytes?: number; warnings?: string[];
}
export interface SplitPlan { key: string; directory: string; outcomes: SplitOutcome[] }
export const resumableSplitPlan = (plan: SplitPlan | null, key: string): SplitPlan | null =>
  plan?.key === key && plan.outcomes.some((entry) => entry.status !== "done") ? plan : null;

/** Preserve successful entries and their original destinations across retries. */
export async function runSplitPlan(
  plan: SplitPlan,
  process: (entry: SplitOutcome, index: number) => Promise<{ outputBytes?: number; warnings?: string[] }>,
  changed: (outcomes: SplitOutcome[]) => void,
  cancelled: () => boolean,
): Promise<void> {
  const publish = () => changed(plan.outcomes.map((entry) => ({ ...entry })));
  for (const [index, entry] of plan.outcomes.entries()) {
    if (entry.status === "done") continue;
    if (cancelled()) throw new Error("Разделение отменено. Готовые блоки сохранены; можно продолжить неготовые.");
    entry.status = "working"; entry.error = undefined; publish();
    try {
      const result = await process(entry, index);
      entry.status = "done"; entry.outputBytes = result.outputBytes; entry.warnings = result.warnings || [];
      publish();
    } catch (reason) {
      entry.status = "error"; entry.error = String(reason); publish();
      throw new Error(`Блок ${index + 1}: ${String(reason)}`);
    }
  }
}

/** Browser-only previews must not attempt to call the native event bridge. */
export function subscribeScannerProgress(
  nativeAvailable: boolean,
  subscribe: () => Promise<() => void>,
  reportError: (reason: unknown) => void,
): () => void {
  let disposed = false;
  let unsubscribe: (() => void) | undefined;
  if (nativeAvailable) void subscribe().then((stop) => {
    if (disposed) stop(); else unsubscribe = stop;
  }).catch((reason) => { if (!disposed) reportError(reason); });
  return () => { disposed = true; unsubscribe?.(); };
}
