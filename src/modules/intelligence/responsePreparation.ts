import { runResponsePreparation, validResponsePreparationReply, type ResponsePreparationReply, type ResponsePreparationRequest } from "./responsePreparationWorker";
import { assertResponsePreparationRaw, assertResponsePreparationSources } from "./responsePreparationBounds";

export const responsePreparationTimeoutMilliseconds = 60_000;
export class ResponsePreparationCancelled extends Error {
  constructor() { super("Подготовка результата отменена."); this.name = "ResponsePreparationCancelled"; }
}

/** One-shot local worker. Never retries automatically or changes a draft itself. */
export function startResponsePreparation(request: ResponsePreparationRequest): {
  promise: Promise<ResponsePreparationReply>; cancel: () => void;
} {
  let worker: Worker | null = null, settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectPromise!: (reason: Error) => void;
  const release = () => {
    if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
    const active = worker; worker = null;
    if (active) { active.onmessage = null; active.onerror = null; active.onmessageerror = null; active.terminate(); }
  };
  const promise = new Promise<ResponsePreparationReply>((resolve, reject) => {
    rejectPromise = reject;
    const fail = (message: string) => { if (settled) return; settled = true; release(); reject(new Error(message)); };
    const accept = (value: unknown) => {
      if (settled) return;
      // A well-formed response for an old task cannot settle the new request.
      if (value && typeof value === "object" && typeof (value as { revision?: unknown }).revision === "number"
        && (value as { revision: number }).revision !== request.revision) return;
      if (!validResponsePreparationReply(value, request.revision)) { fail("Локальный разбор вернул некорректный результат. Повторите разбор ответа."); return; }
      settled = true; release(); resolve(value);
    };
    // Share send/manual-parse limits before allocating a worker and cloning its
    // message. A rejected snapshot stays intact and produces the same reason.
    try { assertResponsePreparationRaw(request.raw); assertResponsePreparationSources(request.sources); }
    catch (reason) { accept({ revision: request.revision, failed: (reason instanceof Error ? reason.message : "Не удалось проверить материалы.").slice(0, 1000) }); return; }
    if (typeof Worker !== "function") { accept(runResponsePreparation(request)); return; }
    try {
      worker = new Worker(new URL("./responsePreparationWorker.ts", import.meta.url), { type: "module" });
      worker.onmessage = (event: MessageEvent<unknown>) => accept(event.data);
      const error = (event: Event) => { event?.preventDefault(); fail("Не удалось выполнить локальное извлечение сертификатов и документов. Повторите разбор ответа."); };
      worker.onerror = error; worker.onmessageerror = error;
      timer = setTimeout(() => fail("Локальный разбор не завершился за 60 секунд. Разделите материалы и повторите разбор."), responsePreparationTimeoutMilliseconds);
      worker.postMessage(request);
    } catch { fail("Не удалось запустить локальное извлечение сертификатов и документов. Повторите разбор ответа."); }
  });
  return { promise, cancel: () => { if (settled) return; settled = true; release(); rejectPromise(new ResponsePreparationCancelled()); } };
}
