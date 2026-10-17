import { useEffect, useRef, useState } from "react";
import { runSourceFacts, validSourceFactsInventory, type SourceFactsInventory } from "./sourceFactsWorker";
import type { IntelligenceSource } from "./workbenchTypes";

/** One lazy RAM-only worker per workbench, not one worker per result card. */
export const sourceFactsTimeoutMilliseconds = 60_000;
export function useSourceFactsInventory(sources: IntelligenceSource[], enabled: boolean) {
  const revision = useRef(0);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ sources: IntelligenceSource[]; inventory?: SourceFactsInventory; failed?: boolean } | null>(null);
  useEffect(() => {
    const current = ++revision.current;
    setState(null);
    if (!enabled) return;
    let settled = false, disposed = false;
    let worker: Worker | null = null;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const release = () => {
      if (timeout !== undefined) { clearTimeout(timeout); timeout = undefined; }
      const active = worker; worker = null;
      if (active) { active.onmessage = null; active.onerror = null; active.onmessageerror = null; active.terminate(); }
    };
    const accept = (value: unknown) => {
      if (disposed || settled || revision.current !== current) return;
      const reply = value && typeof value === "object" ? value as Record<string, unknown> : null;
      if (reply && typeof reply.revision === "number" && reply.revision !== current) return;
      const success = Boolean(reply && reply.revision === current && (reply.failed === undefined || reply.failed === false) && validSourceFactsInventory(reply.inventory));
      settled = true; release();
      setState(success ? { sources, inventory: reply!.inventory as SourceFactsInventory } : { sources, failed: true });
    };
    if (typeof Worker !== "function") accept(runSourceFacts({ revision: current, sources }));
    else try {
        worker = new Worker(new URL("./sourceFactsWorker.ts", import.meta.url), { type: "module" });
        worker.onmessage = (event: MessageEvent<unknown>) => accept(event.data);
        const fail = (event: Event) => { event?.preventDefault(); accept({ revision: current, failed: true }); };
        worker.onerror = fail; worker.onmessageerror = fail;
        timeout = setTimeout(() => accept({ revision: current, failed: true }), sourceFactsTimeoutMilliseconds);
        worker.postMessage({ revision: current, sources });
      } catch { accept({ revision: current, failed: true }); }
    return () => { disposed = true; revision.current++; release(); };
  }, [sources, enabled, attempt]);
  const current = enabled && state?.sources === sources ? state : null;
  return { inventory: current?.inventory, pending: enabled && !current, failed: current?.failed || false, retry: () => setAttempt((previous) => previous + 1) };
}
