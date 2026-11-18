import { buildContractFactPlan, resolveContractFactPlan, parseContractFactResponse, buildContractFactReviewPlan,
  parseContractFactReviewResponse, resolveContractFactReview } from './contractFactPlan';
import type { ContractFactOptions, ContractFactPlan, ContractFactRecord } from './contractFactTypes';
import { assertResponsePreparationSources } from './responsePreparationBounds';
import type { IntelligenceSource } from './workbenchTypes';

export const CONTRACT_FACT_RUN_LIMITS = Object.freeze({ requests: 128, durationMs: 90 * 60 * 1000,
  perRequestMs: 300000, promptSchemaBytes: 8 * 1024 * 1024, rawBytes: 2 * 1024 * 1024 });
export interface ContractFactJob {
  readonly kind: 'extraction' | 'review'; readonly blockId: string; readonly requestId: ReturnType<typeof crypto.randomUUID>;
  readonly prompt: string; readonly responseSchema: Readonly<Record<string, unknown>>; readonly signal: AbortSignal;
  readonly schemaCarrier: ContractFactPlan['options']['schemaCarrier']; readonly responseTokenBudget: number | null;
}
export interface ContractFactPart { readonly kind: ContractFactJob['kind']; readonly blockId: string; readonly requestId: string; readonly raw: string; readonly rawBytes: number; readonly model: string | null }
export interface ContractFactRunCoverage {
  readonly frames: readonly { readonly blockId: string; readonly units: number; readonly state: 'NOT_PROCESSED' | 'EXTRACTION_RECEIVED' | 'REVIEWED' }[];
  readonly requestsAttempted: number; readonly retainedRawBytes: number; readonly promptSchemaBytes: number;
  readonly elapsedMs: number; readonly semanticCompleteness: 'NOT_ASSESSED';
}
export interface ContractFactRunInput {
  sources: readonly IntelligenceSource[]; options?: ContractFactOptions;
  transport: (job: ContractFactJob) => Promise<{ text: string; model?: string }>;
  isCurrent: () => boolean; currentSources?: () => readonly IntelligenceSource[]; signal?: AbortSignal;
  onPart?: (part: ContractFactPart) => void;
  onProgress?: (progress: { phase: 'prepare' | 'extraction' | 'review' | 'assemble'; completedRequests: number; totalRequests: number; blockId: string | null }) => void;
  maxRequests?: number; maxDurationMs?: number; maxPromptSchemaBytes?: number; maxTotalRawBytes?: number;
}
export interface ContractFactRunResult {
  readonly kind: 'contract-fact-run'; readonly plan: ContractFactPlan; readonly records: readonly ContractFactRecord[];
  readonly parts: readonly ContractFactPart[]; readonly coverage: ContractFactRunCoverage;
  readonly readyForClient: false; readonly semanticTruth: 'not-proven'; readonly providerAuthenticity: 'not-attested';
}
export class ContractFactRunError extends Error {
  readonly name = 'ContractFactRunError';
  constructor(readonly code: 'CANCELLED' | 'STALE' | 'LIMITS' | 'FAILED', message: string,
    private readonly parts: ContractFactPart[], private readonly currentCoverage: () => ContractFactRunCoverage) { super(message); }
  /** A late bounded reply can be retained after local cancellation; it never
   * installs a draft or resurrects a request. No durable-storage claim. */
  get capturedParts(): readonly ContractFactPart[] { return Object.freeze([...this.parts]); }
  get coverage(): ContractFactRunCoverage { return this.currentCoverage(); }
}
const issued = new WeakMap<ContractFactRunResult, string>();
const bytes = (s: string) => new TextEncoder().encode(s).byteLength;
const freeze = <T,>(v: T): T => { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v; };
const snapshot = (sources: readonly IntelligenceSource[]) => { assertResponsePreparationSources(sources); return JSON.stringify(sources); };

/** Sequential complete-source run. No silent retry, alternate provider,
 * source completion or partial installation. An AI issue is not an oracle. */
export function startContractFactRun(input: ContractFactRunInput): { promise: Promise<ContractFactRunResult>; cancel: () => void } {
  const controller = new AbortController(), sourceRef = input.sources, original = structuredClone(input.sources), sourceKey = snapshot(original);
  const optionsRef = input.options, optionKey = JSON.stringify(optionsRef ?? {}), transport = input.transport, isCurrent = input.isCurrent;
  const currentSources = input.currentSources, onPart = input.onPart, onProgress = input.onProgress, external = input.signal;
  const limits = { requests: input.maxRequests ?? CONTRACT_FACT_RUN_LIMITS.requests, durationMs: input.maxDurationMs ?? CONTRACT_FACT_RUN_LIMITS.durationMs,
    promptSchemaBytes: input.maxPromptSchemaBytes ?? CONTRACT_FACT_RUN_LIMITS.promptSchemaBytes, rawBytes: input.maxTotalRawBytes ?? CONTRACT_FACT_RUN_LIMITS.rawBytes };
  const declaredLimits = JSON.stringify([input.maxRequests, input.maxDurationMs, input.maxPromptSchemaBytes, input.maxTotalRawBytes]);
  const parts: ContractFactPart[] = [], frames: { blockId: string; units: number; state: ContractFactRunCoverage['frames'][number]['state'] }[] = [];
  let attempts = 0, rawBytes = 0, promptSchemaBytes = 0, expected = 0, terminal: ContractFactRunError | null = null, stoppedAt: number | null = null;
  const origin = { wall: Date.now(), mono: performance.now() }; let lastWall = origin.wall, lastMono = origin.mono;
  const coverage = (): ContractFactRunCoverage => freeze({ frames: frames.map(f => ({ ...f })), requestsAttempted: attempts, retainedRawBytes: rawBytes,
    promptSchemaBytes, elapsedMs: Math.max(0, (stoppedAt ?? performance.now()) - origin.mono), semanticCompleteness: 'NOT_ASSESSED' });
  const stop = (code: ContractFactRunError['code'], message: string): ContractFactRunError => {
    stoppedAt ??= performance.now(); return terminal ??= new ContractFactRunError(code, message, parts, coverage);
  };
  function fail(code: ContractFactRunError['code'], message: string): never { throw stop(code, message); }
  const abort = () => { stop('CANCELLED', 'Подготовка отменена. Частичный КП не установлен; завершение удалённого сервиса не подтверждено.'); controller.abort(); };
  external?.addEventListener('abort', abort, { once: true }); if (external?.aborted) abort();
  const check = () => {
    if (terminal) throw terminal;
    if (controller.signal.aborted) fail('CANCELLED', 'Подготовка отменена.');
    const live = snapshot(currentSources ? currentSources() : sourceRef), stillCurrent = isCurrent();
    const wall = Date.now(), mono = performance.now();
    if (![wall, mono].every(Number.isFinite) || wall < lastWall || mono < lastMono) fail('STALE', 'Изменились часы сеанса. Следующий запрос не отправлен.');
    if (wall - origin.wall >= limits.durationMs || mono - origin.mono >= limits.durationMs) fail('LIMITS', 'Истёк общий срок подготовки. Все полученные ответы оставлены в диагностике.');
    lastWall = wall; lastMono = mono;
    if (controller.signal.aborted) fail('CANCELLED', 'Подготовка отменена.');
    if (!stillCurrent || input.sources !== sourceRef || input.options !== optionsRef || input.transport !== transport || input.isCurrent !== isCurrent
      || input.currentSources !== currentSources || input.signal !== external || input.onPart !== onPart || input.onProgress !== onProgress
      || live !== sourceKey || JSON.stringify(optionsRef ?? {}) !== optionKey
      || JSON.stringify([input.maxRequests, input.maxDurationMs, input.maxPromptSchemaBytes, input.maxTotalRawBytes]) !== declaredLimits)
      fail('STALE', 'Материалы, рабочая папка, задача, доступ или подключение изменились. Прежний документ не заменён.');
  };
  const progress = (phase: 'prepare' | 'extraction' | 'review' | 'assemble', blockId: string | null = null) => {
    check(); onProgress?.({ phase, blockId, completedRequests: attempts, totalRequests: expected }); check();
  };
  const pending = async <T,>(factory: () => T | Promise<T>, timeout = limits.durationMs): Promise<T> => {
    check(); let timer: ReturnType<typeof setTimeout> | undefined, listener: (() => void) | undefined;
    const cutoff = new Promise<never>((_resolve, reject) => {
      listener = () => reject(terminal ?? stop('CANCELLED', 'Локальное ожидание остановлено; завершение сервиса не подтверждено.'));
      controller.signal.addEventListener('abort', listener, { once: true });
      timer = setTimeout(() => { const error = stop('LIMITS', 'Истёк срок ожидания. Частичный КП не принят; сервис может ещё работать.'); controller.abort(); reject(error); }, Math.max(1, timeout));
    });
    const work = Promise.resolve().then(() => { check(); return factory(); });
    try { const value = await Promise.race([work, cutoff]); check(); return value; }
    finally { if (timer) clearTimeout(timer); if (listener) controller.signal.removeEventListener('abort', listener); }
  };
  const call = async (kind: ContractFactJob['kind'], blockId: string, prompt: string, schema: Readonly<Record<string, unknown>>, plan: ContractFactPlan): Promise<ContractFactPart> => {
    check(); if (attempts >= limits.requests) fail('LIMITS', 'Исчерпан бюджет запросов; повторы не выполняются.');
    const size = bytes(prompt) + bytes(JSON.stringify(schema));
    if (promptSchemaBytes + size > limits.promptSchemaBytes) fail('LIMITS', 'Исчерпан общий бюджет запросов и схем. Частичный результат не установлен.');
    const requestId = crypto.randomUUID(), requestOrigin = { wall: Date.now(), mono: performance.now() };
    const remaining = () => Math.min(CONTRACT_FACT_RUN_LIMITS.perRequestMs - (Date.now() - requestOrigin.wall), CONTRACT_FACT_RUN_LIMITS.perRequestMs - (performance.now() - requestOrigin.mono),
      limits.durationMs - (Date.now() - origin.wall), limits.durationMs - (performance.now() - origin.mono));
    let captured: ContractFactPart | undefined;
    await pending(() => {
      check(); if (remaining() <= 0) fail('LIMITS', 'Срок запроса истёк до отправки.');
      attempts++; promptSchemaBytes += size;
      const job = Object.freeze({ kind, blockId, requestId, prompt, responseSchema: schema, signal: controller.signal,
        schemaCarrier: plan.options.schemaCarrier, responseTokenBudget: plan.options.responseTokenBudget });
      return Promise.resolve(transport(job)).then(reply => {
        const raw = reply?.text;
        if (typeof raw !== 'string' || raw.length > CONTRACT_FACT_RUN_LIMITS.rawBytes || bytes(raw) > CONTRACT_FACT_RUN_LIMITS.rawBytes) fail('LIMITS', 'Ответ отсутствует или превышает 2 МиБ; он не усечён.');
        let model: unknown; try { model = reply.model; } catch { model = null; }
        captured = Object.freeze({ kind, blockId, requestId, raw, rawBytes: bytes(raw), model: typeof model === 'string' && model.length < 201 ? model : null });
        // Always retain the bounded returned raw, even if local cancel/staleness
        // won its race. Do not publish late data through callbacks or as a CP.
        parts.push(captured); rawBytes += captured.rawBytes;
        if (remaining() <= 0) fail('LIMITS', 'Получен ответ после срока запроса. Он сохранён отдельно, но не принят.');
        check(); if (rawBytes > limits.rawBytes) fail('LIMITS', 'Общий бюджет ответов исчерпан. Ответы сохранены, частичный КП не установлен.');
        onPart?.(captured); check(); return captured;
      });
    }, Math.max(1, remaining()));
    if (!captured) fail('FAILED', 'Ответ не сохранён.'); return captured;
  };
  let totalTimer: ReturnType<typeof setTimeout> | undefined;
  const promise = (async () => {
    try {
      for (const [key, cap] of Object.entries(CONTRACT_FACT_RUN_LIMITS)) {
        if (key === 'perRequestMs') continue;
        const value = limits[key as keyof typeof limits]; if (!Number.isSafeInteger(value) || value < 1 || value > cap) fail('LIMITS', 'Некорректный бюджет полного прохода.');
      }
      totalTimer = setTimeout(() => { stop('LIMITS', 'Истёк общий срок подготовки.'); controller.abort(); }, limits.durationMs);
      progress('prepare'); const plan = await pending(() => buildContractFactPlan(original, optionsRef));
      frames.push(...plan.blocks.map(b => ({ blockId: b.id, units: b.unitIds.length, state: 'NOT_PROCESSED' as const })));
      expected = plan.blocks.length * 2;
      if (expected > limits.requests) fail('LIMITS', 'Бюджета недостаточно для всех исходных единиц и проверочного прохода; запросы не отправлены.');
      const records: ContractFactRecord[] = [];
      for (const frame of plan.blocks) {
        progress('extraction', frame.id); const first = await call('extraction', frame.id, frame.prompt, frame.responseSchema, plan);
        frames[frame.index].state = 'EXTRACTION_RECEIVED';
        const extraction = await pending(() => parseContractFactResponse(first.raw, plan, frame.id, original));
        const reviewPlan = await pending(() => buildContractFactReviewPlan(extraction, plan, original));
        progress('review', frame.id); const second = await call('review', frame.id, reviewPlan.prompt, reviewPlan.responseSchema, plan);
        const review = await pending(() => parseContractFactReviewResponse(second.raw, reviewPlan, plan, original));
        resolveContractFactReview(review, reviewPlan, plan, original); check();
        records.push(Object.freeze({ extraction, reviewPlan, review })); frames[frame.index].state = 'REVIEWED';
      }
      progress('assemble'); const result: ContractFactRunResult = freeze({ kind: 'contract-fact-run', plan, records, parts: [...parts], coverage: coverage(),
        readyForClient: false, semanticTruth: 'not-proven', providerAuthenticity: 'not-attested' });
      check(); issued.set(result, JSON.stringify(result)); return result;
    } catch (reason) {
      if (terminal) throw terminal;
      throw stop('FAILED', reason instanceof Error ? reason.message : 'Не удалось завершить полный проход фактов.');
    } finally { if (totalTimer) clearTimeout(totalTimer); external?.removeEventListener('abort', abort); }
  })();
  return Object.freeze({ promise, cancel: abort });
}
export function resolveContractFactRun(result: ContractFactRunResult, sources: readonly IntelligenceSource[]) {
  if (issued.get(result) !== JSON.stringify(result)) throw new Error('Нужен завершённый исходный запуск фактов, а не восстановленный JSON.');
  resolveContractFactPlan(result.plan, sources);
  if (result.records.length !== result.plan.blocks.length) throw new Error('Не все пакеты обработаны.');
  result.records.forEach((r, at) => {
    if (r.extraction.blockId !== result.plan.blocks[at].id || r.reviewPlan.extraction !== r.extraction) throw new Error('Нарушен порядок или привязка исходных объектов.');
    resolveContractFactReview(r.review, r.reviewPlan, result.plan, sources);
  }); return result;
}
