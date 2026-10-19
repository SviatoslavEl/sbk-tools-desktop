import { runProposalQuotePreparation, runResponsePreparation, validResponsePreparationReply, type ResponsePreparationReply, type ResponsePreparationRequest } from "./responsePreparationWorker";
import { assertResponsePreparationRaw, assertResponsePreparationSources } from "./responsePreparationBounds";
import type { SourceContractPreparationRequest, SourceContractPreparationWireRequest } from "./sourceContractPreparation";
import { assertPreparedSourceContract } from "./sourceContractPreparation";
import { assertProposalQuotePreparationRequest, type ProposalQuotePreparationRequest, type ProposalQuotePreparationWireRequest, type ProposalQuoteProvenance } from "./proposalQuotePreparation";
import { buildProposalQuotePlan, parseProposalQuoteResponse } from "./proposalQuotePlan";
import { taskSourceSnapshotKey } from "./taskSourceIdentity";
export type { SourceContractPreparationRequest } from "./sourceContractPreparation";
export type { ProposalQuotePreparationRequest } from "./proposalQuotePreparation";

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

/** Separate model selection grammar, with original parts preserved verbatim.
 * Local completion remains distinct from the model-selected quote receipt. */
export function startProposalQuotePreparation(request: ProposalQuotePreparationRequest): {
  promise: Promise<ResponsePreparationReply>; cancel: () => void;
} {
  return startPreparation({ ...request, origin: "model-selected-quotes" }, "model-selected-quotes");
}

function startPreparation(request: ResponsePreparationRequest | SourceContractPreparationWireRequest | ProposalQuotePreparationWireRequest, expectedOrigin?: "source-contract" | "model-selected-quotes"): {
  promise: Promise<ResponsePreparationReply>; cancel: () => void;
} {
  const revision = request.revision;
  let snapshot: ResponsePreparationRequest | SourceContractPreparationWireRequest | ProposalQuotePreparationWireRequest;
  let worker: Worker | null = null, settled = false, validating = false;
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
      if (settled || validating) return;
      // A well-formed response for an old task cannot settle the new request.
      if (value && typeof value === "object" && typeof (value as { revision?: unknown }).revision === "number"
        && (value as { revision: number }).revision !== revision) return;
      if (!validResponsePreparationReply(value, revision, expectedOrigin)) { fail(expectedOrigin === "model-selected-quotes" ? "Подготовка выбранных цитат вернула некорректный результат. Прежние карточки сохранены." : expectedOrigin ? "Локальная подготовка договора вернула некорректный результат. Повторите подготовку по выбранным источникам." : "Локальный разбор вернул некорректный результат. Повторите разбор ответа."); return; }
      // A well-shaped local result for another source snapshot is not this
      // action's project. Recollect whole-field proof against the captured
      // sources before publishing; normal provider replies keep their audit.
      if (expectedOrigin === "source-contract" && value.prepared) {
        try { assertPreparedSourceContract(value.prepared.items, snapshot.sources); }
        catch { fail("Локальный проект не соответствует снимку исходного договора. Предыдущие результаты не заменены."); return; }
      }
      if (expectedOrigin === "model-selected-quotes" && value.prepared) {
        let candidate: ResponsePreparationReply;
        try { candidate = structuredClone(value); }
        catch { fail("Не удалось сохранить неизменный журнал выбранных цитат. Прежние карточки сохранены."); return; }
        const captured = snapshot as ProposalQuotePreparationWireRequest, ledger = candidate.modelQuoteProvenance!;
        if (JSON.stringify(ledger.parts) !== JSON.stringify(captured.parts) || ledger.selections.some(selection => !captured.sources.some(source => source.id === selection.sourceId
          && source.fragments?.some(fragment => fragment.id === selection.fragmentId && fragment.locator === selection.locator && fragment.text === selection.quote)))) {
          fail("Журнал выбранных цитат не соответствует исходным ответам и снимку материалов. Прежние карточки сохранены."); return;
        }
        // Accept at most one candidate while the asynchronous source/raw proof
        // is pending. Source membership alone cannot prove model selection.
        validating = true;
        void (async () => {
          const key = await taskSourceSnapshotKey(captured.sources);
          if (settled) return;
          if (key !== ledger.sourceSnapshotKey) throw new Error("Ключ выбранных цитат не соответствует снимку материалов. Прежние карточки сохранены.");
          const plan = await buildProposalQuotePlan(captured.sources, captured.options);
          if (settled) return;
          if (captured.parts.length !== plan.batches.length || captured.parts.some((part, index) => part.batchId !== plan.batches[index].id)) throw new Error("Журнал выбранных цитат не соответствует полному плану исходных ответов. Прежние карточки сохранены.");
          const selections: ProposalQuoteProvenance["selections"] = [];
          const counts = { units: 0, commercial: 0, context: 0, unclear: 0, batches: plan.batches.length };
          for (const part of captured.parts) {
            const parsed = await parseProposalQuoteResponse(part.raw, plan, part.batchId, captured.sources);
            if (settled) return;
            counts.units += parsed.units.length;
            for (const kind of ["commercial", "context", "unclear"] as const) counts[kind] += parsed.counts[kind];
            selections.push(...parsed.selections.map(selection => ({ unitId: selection.unitId, sourceId: selection.sourceId, fragmentId: selection.fragmentId,
              locator: selection.locator, quote: selection.quote, roles: [...selection.roles] })));
          }
          if (selections.length !== ledger.selections.length || selections.some((selection, index) => {
            const claimed = ledger.selections[index];
            return selection.unitId !== claimed.unitId || selection.sourceId !== claimed.sourceId || selection.fragmentId !== claimed.fragmentId
              || selection.locator !== claimed.locator || selection.quote !== claimed.quote || selection.roles.length !== claimed.roles.length
              || selection.roles.some((role, at) => role !== claimed.roles[at]);
          }) || (["units", "commercial", "context", "unclear", "batches"] as const).some(kind => counts[kind] !== ledger.counts[kind])) {
            throw new Error("Журнал выбранных цитат, их порядок, роли или количества не соответствуют исходным ответам модели. Прежние карточки сохранены.");
          }
          settled = true; release(); resolve(candidate);
        })().catch(reason => fail(reason instanceof Error ? reason.message : "Не удалось подтвердить владение выбранными моделью цитатами."));
        return;
      }
      settled = true; release(); resolve(value);
    };
    // Share send/manual-parse limits before allocating a worker and cloning its
    // message. A rejected snapshot stays intact and produces the same reason.
    try {
      if (expectedOrigin === "model-selected-quotes") assertProposalQuotePreparationRequest(request, true);
      else if (expectedOrigin) {
        if (!Number.isSafeInteger(revision) || revision < 0 || Object.keys(request).some(key => !["revision", "sources", "origin"].includes(key))) throw new Error("Локальная подготовка договора принимает только редакцию и снимок источников, без ответа модели.");
      } else assertResponsePreparationRaw((request as ResponsePreparationRequest).raw);
      assertResponsePreparationSources(request.sources);
      snapshot = structuredClone(request);
    }
    catch (reason) { accept({ revision, ...(expectedOrigin ? { origin: expectedOrigin } : {}), failed: (reason instanceof Error ? reason.message : "Не удалось проверить материалы.").slice(0, 1000) }); return; }
    if (typeof Worker !== "function") {
      if (expectedOrigin === "model-selected-quotes") {
        timer = setTimeout(() => fail("Локальный разбор не завершился за 60 секунд. Разделите материалы и повторите разбор."), responsePreparationTimeoutMilliseconds);
        void runProposalQuotePreparation(snapshot).then(accept, reason => fail(reason instanceof Error ? reason.message : "Не удалось подготовить выбранные цитаты."));
      } else accept(runResponsePreparation(snapshot));
      return;
    }
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
