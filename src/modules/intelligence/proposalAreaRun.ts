import { buildProposalAreaPlan, parseProposalAreaBlockResponse, buildProposalAreaReviewPlan, parseProposalAreaReviewResponse, type ProposalAreaPlan, type ProposalAreaPlanOptions, type ProposalAreaSchemaCarrier } from './proposalAreaPlan';
import { buildProposalWholeDraft, revalidateProposalWholeDraft, type ProposalWholeDraft, type ProposalWholeDraftRecord } from './proposalWholeDraft';
import { assertResponsePreparationSources } from './responsePreparationBounds';
import type { IntelligenceSource } from './workbenchTypes';

export const PROPOSAL_AREA_RUN_LIMITS = Object.freeze({ requests: 128, durationMs: 20 * 60 * 1000,
  promptSchemaBytes: 4 * 1024 * 1024, rawBytesPerReply: 2 * 1024 * 1024, combinedRawBytes: 2 * 1024 * 1024 });
export interface ProposalAreaRunCoverage {
  readonly frames: readonly { readonly blockId: string; readonly state: 'NOT_PROCESSED' | 'EXTRACTION_RECEIVED' | 'REVIEW_RECEIVED' | 'REVIEWED'; readonly extractionRequests: number; readonly reviewRequests: number }[];
  readonly requestsAttempted: number; readonly promptSchemaBytes: number; readonly retainedRawBytes: number; readonly elapsedMs: number;
  /** Prompt + closed JSON schema only, not a claim about transport framing. */
  readonly payloadAccounting: 'utf8-prompt-plus-schema-not-provider-wire';
}
export interface ProposalAreaTransportJob {
  readonly kind: 'extraction' | 'review'; readonly requestId: ReturnType<typeof crypto.randomUUID>; readonly blockId: string;
  readonly prompt: string; readonly responseSchema: Readonly<Record<string, unknown>>; readonly signal: AbortSignal;
  readonly schemaCarrier: ProposalAreaSchemaCarrier;
}
export interface ProposalAreaRunPart {
  readonly kind: ProposalAreaTransportJob['kind']; readonly blockId: string; readonly requestId: string;
  readonly raw: string; readonly rawBytes: number; readonly model: string | null;
}
export interface ProposalAreaRunProgress { readonly phase: 'prepare' | 'extraction' | 'review' | 'assemble'; readonly completedRequests: number; readonly totalRequests: number; readonly blockId: string | null }
export interface ProposalAreaRunInput {
  readonly sources: readonly IntelligenceSource[]; readonly options?: ProposalAreaPlanOptions;
  readonly transport: (job: ProposalAreaTransportJob) => Promise<{ text: string; model?: string }>;
  /** The caller must include workspace, revision, permission, mount and profile
   * changes. A fresh source hash alone cannot establish those UI conditions. */
  readonly isCurrent: () => boolean;
  readonly currentSources?: () => readonly IntelligenceSource[]; readonly signal?: AbortSignal;
  readonly onProgress?: (progress: ProposalAreaRunProgress) => void; readonly onPart?: (part: ProposalAreaRunPart) => void;
  readonly maxRequests?: number; readonly maxTotalRawBytes?: number; readonly maxDurationMs?: number; readonly maxPromptSchemaBytes?: number;
}
export interface ProposalAreaRunResult {
  readonly plan: ProposalAreaPlan; readonly records: readonly ProposalWholeDraftRecord[]; readonly draft: ProposalWholeDraft;
  readonly parts: readonly ProposalAreaRunPart[]; readonly coverage: ProposalAreaRunCoverage; readonly providerCompletion: 'not-independently-attested'; readonly readyForClient: false;
}
export class ProposalAreaRunError extends Error {
  constructor(readonly code: 'CANCELLED' | 'STALE' | 'LIMITS' | 'FAILED', message: string,
    readonly capturedParts: readonly ProposalAreaRunPart[], readonly providerCompletion: 'not-independently-attested' = 'not-independently-attested', readonly coverage?: ProposalAreaRunCoverage) {
    super(message); this.name = 'ProposalAreaRunError';
  }
}
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
function snapshot(sources: readonly IntelligenceSource[]) {
  assertResponsePreparationSources(sources); const captured = structuredClone(sources); assertResponsePreparationSources(captured);
  const serialized = JSON.stringify(captured);
  if (JSON.stringify(sources) !== serialized) throw new Error('Источник изменился во время фиксации.');
  return { captured, serialized };
}
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }

/** Pure cancellable orchestration. No provider import, fallback, automatic
 * retry, persistence, public DTO or UI installation exists here. The caller
 * atomically installs only the fully resolved promise, never partial parts.
 * Cancel stops local waiting; a provider may continue remotely. */
export function startProposalAreaRun(input: ProposalAreaRunInput): { readonly promise: Promise<ProposalAreaRunResult>; readonly cancel: () => void } {
  const controller = new AbortController(); const parts: ProposalAreaRunPart[] = [];
  const sources = input.sources, options = input.options, transport = input.transport, isCurrent = input.isCurrent;
  const currentSources = input.currentSources, onProgress = input.onProgress, onPart = input.onPart;
  const externalSignal = input.signal, maxRequests = input.maxRequests, maxTotalRawBytes = input.maxTotalRawBytes;
  const maxDurationMs = input.maxDurationMs, maxPromptSchemaBytes = input.maxPromptSchemaBytes;
  const requestedLimit = input.maxRequests ?? PROPOSAL_AREA_RUN_LIMITS.requests, rawLimit = input.maxTotalRawBytes ?? PROPOSAL_AREA_RUN_LIMITS.combinedRawBytes;
  const durationLimit = maxDurationMs ?? PROPOSAL_AREA_RUN_LIMITS.durationMs, payloadLimit = maxPromptSchemaBytes ?? PROPOSAL_AREA_RUN_LIMITS.promptSchemaBytes;
  const startedAt = performance.now(); let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const frames: { blockId: string; state: ProposalAreaRunCoverage['frames'][number]['state']; extractionRequests: number; reviewRequests: number }[] = [];
  let payloadBytes = 0;
  const externalAbort = () => controller.abort(); externalSignal?.addEventListener('abort', externalAbort, { once: true });
  if (externalSignal?.aborted) controller.abort();
  let terminal: ProposalAreaRunError | null = null;
  let originalSnapshot: ReturnType<typeof snapshot>, optionsSerialized: string, requests = 0, totalRaw = 0, expectedRequests = 0;
  const coverage = (): ProposalAreaRunCoverage => freeze({ frames: frames.map(frame => ({ ...frame })), requestsAttempted: requests,
    promptSchemaBytes: payloadBytes, retainedRawBytes: totalRaw, elapsedMs: Math.max(0, performance.now() - startedAt), payloadAccounting: 'utf8-prompt-plus-schema-not-provider-wire' as const });
  const stop = (code: ProposalAreaRunError['code'], message: string) => terminal ??= new ProposalAreaRunError(code, message, Object.freeze([...parts]), 'not-independently-attested', coverage());
  const fail = (code: ProposalAreaRunError['code'], message: string): never => { throw stop(code, message); };
  const check = () => {
    if (terminal) throw terminal;
    if (performance.now() - startedAt >= durationLimit) fail('LIMITS', 'Истёк общий лимит времени подготовки КП. Необработанные блоки не заменены частичным результатом.');
    if (controller.signal.aborted) fail('CANCELLED', 'Подготовка КП отменена. Частичный результат не установлен; завершение работы провайдера не подтверждено.');
    // Read callback-owned state first, then guard the resulting configuration
    // and abort state again. Callbacks must not cancel/swap the task and still
    // allow the final pre-transport check to return successfully.
    const liveSources = currentSources ? currentSources() : sources;
    const stillCurrent = isCurrent();
    const live = snapshot(liveSources).serialized;
    const changed = input.sources !== sources || input.options !== options || input.transport !== transport || input.isCurrent !== isCurrent || input.currentSources !== currentSources
      || input.signal !== externalSignal || input.onProgress !== onProgress || input.onPart !== onPart || input.maxRequests !== maxRequests || input.maxTotalRawBytes !== maxTotalRawBytes
      || input.maxDurationMs !== maxDurationMs || input.maxPromptSchemaBytes !== maxPromptSchemaBytes
      || !stillCurrent || JSON.stringify(options ?? {}) !== optionsSerialized || live !== originalSnapshot.serialized;
    if (controller.signal.aborted) fail('CANCELLED', 'Подготовка КП отменена. Частичный результат не установлен; завершение работы провайдера не подтверждено.');
    if (performance.now() - startedAt >= durationLimit) fail('LIMITS', 'Истёк общий лимит времени подготовки КП. Следующий запрос не отправлен.');
    if (changed) fail('STALE', 'Источник, задача, доступ или рабочая папка изменились. Прежний результат не заменён.');
  };
  const progress = (phase: ProposalAreaRunProgress['phase'], blockId: string | null = null) => {
    check(); onProgress?.(Object.freeze({ phase, completedRequests: requests, totalRequests: expectedRequests, blockId })); check();
  };
  const awaitCurrent = async <T,>(factory: () => Promise<T> | T, retainBeforePublication?: (value: T) => void): Promise<T> => {
    check();
    let listener!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      listener = () => reject(stop('CANCELLED', 'Подготовка КП отменена. Завершение работы провайдера не подтверждено.'));
      controller.signal.addEventListener('abort', listener, { once: true });
      if (controller.signal.aborted) listener();
    });
    // Work is not even created before its initial guard. Both race handlers
    // are attached synchronously before the deferred factory can run/reject.
    const work = Promise.resolve().then(() => { check(); return factory(); });
    try { const value = await Promise.race([work, cancelled]); retainBeforePublication?.(value); check(); return value; }
    finally { controller.signal.removeEventListener('abort', listener); }
  };
  const call = async (kind: ProposalAreaTransportJob['kind'], blockId: string, prompt: string, responseSchema: Readonly<Record<string, unknown>>, schemaCarrier: ProposalAreaSchemaCarrier) => {
    check(); if (requests >= requestedLimit) fail('LIMITS', 'Исчерпан общий бюджет запросов. Повтор или частичный результат не подставлены.');
    const requestBytes = bytes(prompt) + bytes(JSON.stringify(responseSchema));
    if (payloadBytes + requestBytes > payloadLimit) fail('LIMITS', 'Исчерпан общий бюджет текста запросов и JSON-схем. Следующий блок не отправлен, частичный КП не установлен.');
    const requestId = crypto.randomUUID();
    const job = Object.freeze({ kind, blockId, requestId, prompt, responseSchema, schemaCarrier, signal: controller.signal });
    let part: ProposalAreaRunPart | undefined;
    await awaitCurrent(() => { check(); requests++; payloadBytes += requestBytes; const frame = frames.find(frame => frame.blockId === blockId)!;
      if (kind === 'extraction') frame.extractionRequests++; else frame.reviewRequests++;
      return transport(job); }, reply => {
      const raw = reply?.text;
      if (typeof raw !== 'string' || raw.length > PROPOSAL_AREA_RUN_LIMITS.rawBytesPerReply) fail('LIMITS', 'Ответ отсутствует или превышает допустимый объём. Он не усечён и не принят.');
      const rawBytes = bytes(raw);
      if (rawBytes > PROPOSAL_AREA_RUN_LIMITS.rawBytesPerReply) fail('LIMITS', 'Ответ превышает2МиБ. Он не усечён и не принят.');
      // Optional metadata must not prevent retention of an already returned,
      // bounded raw answer (including a malformed accessor).
      let model: unknown; try { model = reply?.model; } catch { model = null; }
      part = Object.freeze({ kind, blockId, requestId, raw, rawBytes, model: typeof model === 'string' && model.length <= 200 ? model : null });
      // Retain the bounded returned reply BEFORE the freshness publication
      // gate. A stale result is never sent to onPart or installed as a draft.
      // Aggregate acceptance failure retains <=4MiB, without truncation.
      parts.push(part); totalRaw += rawBytes;
      frames.find(frame => frame.blockId === blockId)!.state = kind === 'extraction' ? 'EXTRACTION_RECEIVED' : 'REVIEW_RECEIVED';
    });
    check(); const accepted = part;
    if (!accepted) throw stop('FAILED', 'Ответ не сохранён до проверки актуальности.');
    onPart?.(accepted); check();
    if (totalRaw > rawLimit) fail('LIMITS', 'Суммарный объём ответов превышает бюджет подготовки. Все полученные ограниченные ответы сохранены отдельно; частичный КП не установлен.');
    return accepted;
  };
  const promise = (async () => {
    try {
      if (typeof transport !== 'function' || typeof isCurrent !== 'function' || currentSources !== undefined && typeof currentSources !== 'function'
        || !Number.isSafeInteger(requestedLimit) || requestedLimit < 0 || requestedLimit > PROPOSAL_AREA_RUN_LIMITS.requests
        || !Number.isSafeInteger(rawLimit) || rawLimit < 1 || rawLimit > PROPOSAL_AREA_RUN_LIMITS.combinedRawBytes
        || !Number.isSafeInteger(durationLimit) || durationLimit < 1 || durationLimit > PROPOSAL_AREA_RUN_LIMITS.durationMs
        || !Number.isSafeInteger(payloadLimit) || payloadLimit < 1 || payloadLimit > PROPOSAL_AREA_RUN_LIMITS.promptSchemaBytes) fail('LIMITS', 'Некорректный или превышенный бюджет полного прохода КП.');
      deadlineTimer = setTimeout(() => { stop('LIMITS', 'Истёк общий лимит времени подготовки КП. Завершение работы провайдера не подтверждено.'); controller.abort(); }, Math.max(0, durationLimit - (performance.now() - startedAt)));
      originalSnapshot = snapshot(sources); optionsSerialized = JSON.stringify(options ?? {}); check(); progress('prepare');
      const plan = await awaitCurrent(() => buildProposalAreaPlan(originalSnapshot.captured, options)); check();
      frames.push(...plan.blocks.map(block => ({ blockId: block.id, state: 'NOT_PROCESSED' as const, extractionRequests: 0, reviewRequests: 0 })));
      expectedRequests = plan.blocks.length * 2;
      if (expectedRequests > requestedLimit) fail('LIMITS', 'Бюджета недостаточно для всех блоков и отдельной семантической проверки. Запросы не отправлены.');
      const records: ProposalWholeDraftRecord[] = [];
      for (const block of plan.blocks) {
        progress('extraction', block.id);
        const extractionPart = await call('extraction', block.id, block.prompt, block.responseSchema, plan.schemaCarrier); check();
        const response = await awaitCurrent(() => parseProposalAreaBlockResponse(extractionPart.raw, plan, block.id, originalSnapshot.captured)); check();
        const reviewPlan = await awaitCurrent(() => buildProposalAreaReviewPlan(response, plan, originalSnapshot.captured)); check();
        progress('review', block.id);
        const reviewPart = await call('review', block.id, reviewPlan.prompt, reviewPlan.responseSchema, plan.schemaCarrier); check();
        const reviewResponse = await awaitCurrent(() => parseProposalAreaReviewResponse(reviewPart.raw, reviewPlan, plan, originalSnapshot.captured)); check();
        records.push(Object.freeze({ response, reviewPlan, reviewResponse }));
        frames.find(frame => frame.blockId === block.id)!.state = 'REVIEWED';
      }
      progress('assemble');
      const stableRecords = Object.freeze(records);
      const draft = await awaitCurrent(() => buildProposalWholeDraft(plan, stableRecords, originalSnapshot.captured)); check();
      await awaitCurrent(() => revalidateProposalWholeDraft(draft, plan, stableRecords, originalSnapshot.captured)); check();
      return freeze({ plan, records: stableRecords, draft, parts: [...parts], coverage: coverage(), providerCompletion: 'not-independently-attested' as const, readyForClient: false as const });
    } catch (reason) {
      // An accessor/callback can synchronously abort while a bounded reply is
      // being captured. Preserve the primary stop reason, but seal diagnostics
      // only AFTER that synchronous retention has completed, not at abort time.
      if (terminal || reason instanceof ProposalAreaRunError) {
        const primary = terminal || reason as ProposalAreaRunError;
        terminal = new ProposalAreaRunError(primary.code, primary.message, Object.freeze([...parts]), primary.providerCompletion, coverage());
        throw terminal;
      }
      const message = reason instanceof Error ? reason.message : 'Не удалось подготовить полный черновик КП.';
      throw stop('FAILED', message);
    } finally { if (deadlineTimer !== undefined) clearTimeout(deadlineTimer); externalSignal?.removeEventListener('abort', externalAbort); }
  })();
  return Object.freeze({ promise, cancel: () => controller.abort() });
}
