import { runResponsePreparation, validResponsePreparationReply, type ResponsePreparationReply, type ResponsePreparationRequest } from "./responsePreparationWorker";
import { assertResponsePreparationRaw, assertResponsePreparationSources } from "./responsePreparationBounds";
import type { SourceContractPreparationRequest, SourceContractPreparationWireRequest } from "./sourceContractPreparation";
import { assertPreparedSourceContract } from "./sourceContractPreparation";
export type { SourceContractPreparationRequest } from "./sourceContractPreparation";

export const responsePreparationTimeoutMilliseconds = 60_000;
export class ResponsePreparationCancelled extends Error {
  constructor() { super("Подготовка результата отменена."); this.name = "ResponsePreparationCancelled"; }
}

/** One-shot local worker. Never retries automatically or changes a draft itself. */
export function startResponsePreparation(request: ResponsePreparationRequest): {
  promise: Promise<ResponsePreparationReply>; cancel: () => void;
} {
  return startPreparation(request);
}

/** Explicit local source action. No provider text/items are accepted or
 * rewritten; the returned origin never describes a successful model reply. */
export function startSourceContractPreparation(request: SourceContractPreparationRequest): {
  promise: Promise<ResponsePreparationReply>; cancel: () => void;
} {
  return startPreparation({ ...request, origin: "source-contract" }, "source-contract");
}

function startPreparation(request: ResponsePreparationRequest | SourceContractPreparationWireRequest, expectedOrigin?: "source-contract"): {
  promise: Promise<ResponsePreparationReply>; cancel: () => void;
} {
  const revision = request.revision;
  let snapshot: ResponsePreparationRequest | SourceContractPreparationWireRequest;
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
        && (value as { revision: number }).revision !== revision) return;
      if (!validResponsePreparationReply(value, revision, expectedOrigin)) { fail(expectedOrigin ? "Локальная подготовка договора вернула некорректный результат. Повторите подготовку по выбранным источникам." : "Локальный разбор вернул некорректный результат. Повторите разбор ответа."); return; }
      // A well-shaped local result for another source snapshot is not this
      // action's project. Recollect whole-field proof against the captured
      // sources before publishing; normal provider replies keep their audit.
      if (expectedOrigin && value.prepared) {
        try { assertPreparedSourceContract(value.prepared.items, snapshot.sources); }
        catch { fail("Локальный проект не соответствует снимку исходного договора. Предыдущие результаты не заменены."); return; }
      }
      settled = true; release(); resolve(value);
    };
    // Share send/manual-parse limits before allocating a worker and cloning its
    // message. A rejected snapshot stays intact and produces the same reason.
    try {
      if (expectedOrigin) {
        if (!Number.isSafeInteger(revision) || revision < 0 || Object.keys(request).some(key => !["revision", "sources", "origin"].includes(key))) throw new Error("Локальная подготовка договора принимает только редакцию и снимок источников, без ответа модели.");
      } else assertResponsePreparationRaw((request as ResponsePreparationRequest).raw);
      assertResponsePreparationSources(request.sources);
      snapshot = structuredClone(request);
    }
    catch (reason) { accept({ revision, ...(expectedOrigin ? { origin: expectedOrigin } : {}), failed: (reason instanceof Error ? reason.message : "Не удалось проверить материалы.").slice(0, 1000) }); return; }
    if (typeof Worker !== "function") { accept(runResponsePreparation(snapshot)); return; }
    try {
      worker = new Worker(new URL("./responsePreparationWorker.ts", import.meta.url), { type: "module" });
      worker.onmessage = (event: MessageEvent<unknown>) => accept(event.data);
      const error = (event: Event) => { event?.preventDefault(); fail(expectedOrigin ? "Не удалось выполнить локальную подготовку договора. Повторите подготовку по выбранным источникам." : "Не удалось выполнить локальное извлечение сертификатов и документов. Повторите разбор ответа."); };
      worker.onerror = error; worker.onmessageerror = error;
      timer = setTimeout(() => fail("Локальный разбор не завершился за 60 секунд. Разделите материалы и повторите разбор."), responsePreparationTimeoutMilliseconds);
      worker.postMessage(snapshot);
    } catch { fail(expectedOrigin ? "Не удалось запустить локальную подготовку договора. Повторите подготовку по выбранным источникам." : "Не удалось запустить локальное извлечение сертификатов и документов. Повторите разбор ответа."); }
  });
  return { promise, cancel: () => { if (settled) return; settled = true; release(); rejectPromise(new ResponsePreparationCancelled()); } };
}
