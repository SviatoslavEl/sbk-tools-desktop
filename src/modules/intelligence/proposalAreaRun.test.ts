import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROPOSAL_AREAS } from './proposalAreaPlan';
import { startProposalAreaRun, ProposalAreaRunError, PROPOSAL_AREA_RUN_LIMITS, type ProposalAreaTransportJob } from './proposalAreaRun';
import type { IntelligenceSource } from './workbenchTypes';

function sources(frames = 1): IntelligenceSource[] {
  return [{ id: 'run-source', name: 'Учебный документ', text: 'AGGREGATE IS NOT MODEL OUTPUT', sha256: 'b'.repeat(64), coverage: { complete: true, requiresOcr: false },
    fragments: Array.from({ length: frames }, (_, index) => ({ id: `owner-${index}`, locator: `Учебная часть ${index}`, text: `Учебное условие ${index}.`, structure: {
      version: 1 as const, format: 'docx' as const, method: 'ooxml' as const, part: frames === 1 ? 'word/document.xml' : `word/header${index}.xml`, kind: frames === 1 ? 'paragraph' as const : 'header-footer' as const,
      containerId: frames === 1 ? 'body' : `aux-${index}`, order: index, physicalSection: 0,
    } })) }];
}
function wire(job: ProposalAreaTransportJob, reason = 'Учебный fallible verdict, не проверка точности модели.') {
  const properties = job.responseSchema.properties as Record<string, { enum?: string[] }>;
  const keys = Object.fromEntries(Object.entries(properties).filter(([key]) => key !== 'areas').map(([key, spec]) => [key, spec.enum![0]]));
  const ownerIndex = Number(job.blockId.match(/block-(\d+)$/u)![1]) - 1;
  const areas = Object.fromEntries(PROPOSAL_AREAS.map(area => [area, job.kind === 'extraction'
    ? { status: 'answered', answer: `Неизменённый учебный ответ ${area}.`, evidenceRefs: [{ ownerId: `owner-${ownerIndex}`, cellIndex: null }] }
    : { decision: 'answer-complete', verdict: 'supported', reason, basis: 'answer-supported', counterexample: null }]));
  return JSON.stringify({ ...keys, areas });
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('cancellable atomic seven-area runtime with explicit extraction AND review budget', () => {
  it('assembles all seven areas only after both phases for every frame; never invokes a source completion tail', async () => {
    const input = sources(2), before = structuredClone(input), jobs: ProposalAreaTransportJob[] = [], parts: string[] = [];
    const transport = vi.fn(async (job: ProposalAreaTransportJob) => { jobs.push(job); return { text: wire(job), model: 'synthetic-only' }; });
    const result = await startProposalAreaRun({ sources: input, isCurrent: () => true, transport, onPart: part => parts.push(part.raw) }).promise;
    expect(jobs.map(job => job.kind)).toEqual(['extraction', 'review', 'extraction', 'review']); expect(result.records).toHaveLength(2); expect(result.parts).toHaveLength(4);
    expect(result.parts.map(part => part.raw)).toEqual(parts); expect(result.draft.sections.map(section => section.area)).toEqual(PROPOSAL_AREAS);
    expect(result.draft.sections.every(section => section.bundles.length === 2)).toBe(true); expect(result.draft.sourceSnapshot).toEqual(input);
    expect(result).toMatchObject({ readyForClient: false, providerCompletion: 'not-independently-attested' }); expect(result.draft.approvedContent).toEqual([]); expect(input).toEqual(before);
    expect(new Set(jobs.map(job => job.requestId)).size).toBe(4); expect(Object.isFrozen(result.records[0])).toBe(true);
    expect(result.coverage.frames.map(frame => frame.state)).toEqual(['REVIEWED', 'REVIEWED']);
    expect(result.coverage).toMatchObject({ requestsAttempted: 4, payloadAccounting: 'utf8-prompt-plus-schema-not-provider-wire' });
    expect(result.coverage.promptSchemaBytes).toBe(jobs.reduce((sum, job) => sum + new TextEncoder().encode(job.prompt).byteLength + new TextEncoder().encode(JSON.stringify(job.responseSchema)).byteLength, 0));
  });

  it('preflights the full extraction plus review request count before sending even the first request', async () => {
    const transport = vi.fn(async (job: ProposalAreaTransportJob) => ({ text: wire(job) }));
    const error = await startProposalAreaRun({ sources: sources(2), isCurrent: () => true, transport, maxRequests: 3 }).promise.catch(error => error);
    expect(error.code).toBe('LIMITS'); expect(error.coverage.frames.map((frame: { state: string }) => frame.state)).toEqual(['NOT_PROCESSED', 'NOT_PROCESSED']); expect(transport).not.toHaveBeenCalled();
    for (const maxRequests of [-1, 129, 0.5]) await expect(startProposalAreaRun({ sources: sources(), isCurrent: () => true, transport, maxRequests }).promise).rejects.toMatchObject({ code: 'LIMITS' });
    expect(transport).not.toHaveBeenCalled();
  });

  it('fails before transport for stale access/workspace/profile revision or incomplete source', async () => {
    const transport = vi.fn(async (job: ProposalAreaTransportJob) => ({ text: wire(job) }));
    await expect(startProposalAreaRun({ sources: sources(), isCurrent: () => false, transport }).promise).rejects.toMatchObject({ code: 'STALE' });
    const input = sources(); input[0].coverage!.complete = false; await expect(startProposalAreaRun({ sources: input, isCurrent: () => true, transport }).promise).rejects.toThrow(); expect(transport).not.toHaveBeenCalled();
  });

  it('stops after a malformed extraction reply, retains exact raw and never sends review or another frame', async () => {
    const raw = '  {"not":"the closed seven-area protocol"}\r\n', transport = vi.fn(async () => ({ text: raw }));
    const error = await startProposalAreaRun({ sources: sources(2), isCurrent: () => true, transport }).promise.catch(error => error);
    expect(error).toBeInstanceOf(ProposalAreaRunError); expect(error.code).toBe('FAILED'); expect(error.capturedParts.map((part: { raw: string }) => part.raw)).toEqual([raw]); expect(transport).toHaveBeenCalledTimes(1);
    expect(error.coverage.frames).toEqual([{ blockId: 'work-scope:block-1', state: 'EXTRACTION_RECEIVED', extractionRequests: 1, reviewRequests: 0 }, { blockId: 'work-scope:block-2', state: 'NOT_PROCESSED', extractionRequests: 0, reviewRequests: 0 }]);
  });

  it('stops after any malformed review/guard error, without retries or a partial assembled result', async () => {
    const transport = vi.fn(async (job: ProposalAreaTransportJob) => ({ text: job.kind === 'extraction' ? wire(job) : '[]' }));
    const error = await startProposalAreaRun({ sources: sources(2), isCurrent: () => true, transport }).promise.catch(error => error);
    expect(error.code).toBe('FAILED'); expect(error.capturedParts).toHaveLength(2); expect(error.capturedParts[1].raw).toBe('[]'); expect(transport).toHaveBeenCalledTimes(2);
  });

  it('retains the bounded last whole reply when the combined raw budget is exceeded, without partial draft acceptance', async () => {
    const transport = vi.fn(async (job: ProposalAreaTransportJob) => ({ text: wire(job, 'x'.repeat(1000)) }));
    const error = await startProposalAreaRun({ sources: sources(2), isCurrent: () => true, transport, maxTotalRawBytes: 5000 }).promise.catch(error => error);
    expect(error.code).toBe('LIMITS'); expect(error.capturedParts).toHaveLength(2); expect(transport).toHaveBeenCalledTimes(2);
    expect(error.capturedParts[1].raw).toContain('x'.repeat(1000)); expect(error.capturedParts.reduce((sum: number, part: { rawBytes: number }) => sum + part.rawBytes, 0)).toBeGreaterThan(5000);
  });

  it('rejects an oversized single reply without truncation, parse, retry or an unbounded retained envelope', async () => {
    const transport = vi.fn(async () => ({ text: 'x'.repeat(2_097_153) }));
    const error = await startProposalAreaRun({ sources: sources(), isCurrent: () => true, transport }).promise.catch(error => error);
    expect(error.code).toBe('LIMITS'); expect(error.capturedParts).toEqual([]); expect(transport).toHaveBeenCalledTimes(1);
  });

  it('captures transport text/model once so accessor changes cannot bypass raw limits or corrupt byte accounting', async () => {
    const reads: number[] = [], modelReads: number[] = [];
    const result = await startProposalAreaRun({ sources: sources(), isCurrent: () => true, transport: async job => {
      const index = reads.length; reads.push(0); modelReads.push(0); const first = wire(job);
      return { get text() { return ++reads[index] === 1 ? first : 'x'.repeat(2_097_153); }, get model() { modelReads[index]++; return 'synthetic'; } };
    } }).promise;
    expect(reads).toEqual([1, 1]); expect(modelReads).toEqual([1, 1]);
    for (const part of result.parts) expect(part.rawBytes).toBe(new TextEncoder().encode(part.raw).byteLength);
  });

  it('retains exact bounded raw even when optional model metadata throws', async () => {
    const result = await startProposalAreaRun({ sources: sources(), isCurrent: () => true, transport: async job => ({ text: wire(job), get model(): string { throw new Error('synthetic metadata getter'); } }) }).promise;
    expect(result.parts).toHaveLength(2); expect(result.parts.every(part => part.model === null)).toBe(true);
  });

  it.each(['text', 'model'] as const)('seals latest raw/coverage after a synchronous %s getter abort without losing the primary cancellation', async getter => {
    const controller = new AbortController(), onPart = vi.fn(); let exact = '';
    const transport = vi.fn(async (job: ProposalAreaTransportJob) => {
      exact = wire(job); return { get text() { if (getter === 'text') controller.abort(); return exact; }, get model() { if (getter === 'model') controller.abort(); return 'synthetic'; } };
    });
    const error = await startProposalAreaRun({ sources: sources(2), isCurrent: () => true, signal: controller.signal, transport, onPart }).promise.catch(error => error);
    expect(error.code).toBe('CANCELLED'); expect(error.capturedParts.map((part: { raw: string }) => part.raw)).toEqual([exact]);
    expect(error.coverage.frames.map((frame: { state: string }) => frame.state)).toEqual(['EXTRACTION_RECEIVED', 'NOT_PROCESSED']);
    expect(onPart).not.toHaveBeenCalled(); expect(transport).toHaveBeenCalledTimes(1);
  });

  it('caps aggregate prompt plus schema bytes without sending an over-budget request or calling it processed', async () => {
    const transport = vi.fn(async (job: ProposalAreaTransportJob) => ({ text: wire(job) }));
    const error = await startProposalAreaRun({ sources: sources(2), isCurrent: () => true, transport, maxPromptSchemaBytes: 1 }).promise.catch(error => error);
    expect(error.code).toBe('LIMITS'); expect(transport).not.toHaveBeenCalled(); expect(error.coverage.promptSchemaBytes).toBe(0);
    expect(error.coverage.frames.every((frame: { state: string }) => frame.state === 'NOT_PROCESSED')).toBe(true);
    for (const option of [{ maxDurationMs: 0 }, { maxDurationMs: PROPOSAL_AREA_RUN_LIMITS.durationMs + 1 }, { maxPromptSchemaBytes: 0 }, { maxPromptSchemaBytes: PROPOSAL_AREA_RUN_LIMITS.promptSchemaBytes + 1 }])
      await expect(startProposalAreaRun({ sources: sources(), isCurrent: () => true, transport, ...option }).promise).rejects.toMatchObject({ code: 'LIMITS' });
    expect(transport).not.toHaveBeenCalled();
  });

  it('stops local waiting at the aggregate deadline with explicit unprocessed coverage, abort signal and no later call', async () => {
    vi.useFakeTimers();
    let called!: () => void, finish!: (value: { text: string }) => void, activeJob!: ProposalAreaTransportJob;
    const reached = new Promise<void>(resolve => { called = resolve; });
    const transport = vi.fn((job: ProposalAreaTransportJob) => { activeJob = job; called(); return new Promise<{ text: string }>(resolve => { finish = resolve; }); });
    const run = startProposalAreaRun({ sources: sources(2), isCurrent: () => true, transport, maxDurationMs: 1000 });
    const captured = run.promise.catch(error => error); await reached; await vi.advanceTimersByTimeAsync(1000); const error = await captured;
    expect(error.code).toBe('LIMITS'); expect(activeJob.signal.aborted).toBe(true); expect(error.coverage.requestsAttempted).toBe(1);
    expect(error.coverage.frames.map((frame: { state: string }) => frame.state)).toEqual(['NOT_PROCESSED', 'NOT_PROCESSED']);
    expect(error.coverage.frames[0].extractionRequests).toBe(1); expect(error.providerCompletion).toBe('not-independently-attested');
    finish({ text: wire(activeJob) }); await Promise.resolve(); await Promise.resolve(); expect(transport).toHaveBeenCalledTimes(1); expect(error.capturedParts).toEqual([]);
  });

  it('retains a returned raw answer when the monotonic deadline crosses before publication and sends no review', async () => {
    let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now);
    const transport = vi.fn(async (job: ProposalAreaTransportJob) => { const text = wire(job); now = 1000; return { text }; });
    const error = await startProposalAreaRun({ sources: sources(2), isCurrent: () => true, transport, maxDurationMs: 1000 }).promise.catch(error => error);
    expect(error.code).toBe('LIMITS'); expect(error.capturedParts).toHaveLength(1); expect(transport).toHaveBeenCalledTimes(1);
    expect(error.coverage.frames.map((frame: { state: string }) => frame.state)).toEqual(['EXTRACTION_RECEIVED', 'NOT_PROCESSED']);
  });

  it('cancels local waiting promptly and ignores a late provider reply without claiming server idle', async () => {
    let complete!: (value: { text: string }) => void, reached!: () => void, activeJob!: ProposalAreaTransportJob;
    const called = new Promise<void>(resolve => { reached = resolve; });
    const transport = vi.fn((job: ProposalAreaTransportJob) => { activeJob = job; reached(); return new Promise<{ text: string }>(resolve => { complete = resolve; }); });
    const onPart = vi.fn(), handle = startProposalAreaRun({ sources: sources(), isCurrent: () => true, transport, onPart }); await called;
    handle.cancel(); const error = await handle.promise.catch(error => error); expect(error.code).toBe('CANCELLED'); expect(activeJob.signal.aborted).toBe(true); expect(error.providerCompletion).toBe('not-independently-attested');
    complete({ text: wire(activeJob) }); await Promise.resolve(); await Promise.resolve(); expect(transport).toHaveBeenCalledTimes(1); expect(onPart).not.toHaveBeenCalled();
  });

  it('supports an already-aborted or later external abort signal without starting another request', async () => {
    const controller = new AbortController(), transport = vi.fn(async (job: ProposalAreaTransportJob) => ({ text: wire(job) })); controller.abort();
    await expect(startProposalAreaRun({ sources: sources(), isCurrent: () => true, transport, signal: controller.signal }).promise).rejects.toMatchObject({ code: 'CANCELLED' }); expect(transport).not.toHaveBeenCalled();
    const late = new AbortController();
    await expect(startProposalAreaRun({ sources: sources(2), isCurrent: () => true, transport, signal: late.signal, onPart: () => late.abort() }).promise).rejects.toMatchObject({ code: 'CANCELLED' }); expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each(['source', 'current-source', 'revision', 'options'])('rejects %s change during an awaited transport call and never publishes a stale result', async kind => {
    const input = sources(2); let current = true, live = input;
    const options = { instruction: 'Исходный вопрос.' };
    const transport = vi.fn(async (job: ProposalAreaTransportJob) => {
      if (kind === 'source') input[0].name += ' changed'; else if (kind === 'current-source') { live = structuredClone(input); live[0].name += ' changed'; }
      else if (kind === 'revision') current = false; else options.instruction = 'Изменённый вопрос.';
      return { text: wire(job) };
    });
    let installed = false; const onPart = vi.fn();
    const error = await startProposalAreaRun({ sources: input, options, isCurrent: () => current, currentSources: () => live, transport, onPart }).promise.then(result => { installed = true; return result; }).catch(error => error);
    expect(error.code).toBe('STALE'); expect(installed).toBe(false); expect(transport).toHaveBeenCalledTimes(1); expect(onPart).not.toHaveBeenCalled();
    expect(error.capturedParts).toHaveLength(1); expect(error.capturedParts[0].raw).toContain('Неизменённый учебный ответ');
  });

  it('does not start transport after a transient stale guard has already terminally stopped deferred work', async () => {
    for (let failAt = 1; failAt <= 22; failAt++) {
      let guards = 0, calls = 0, callsAtFailure = -1;
      const transport = vi.fn(async (job: ProposalAreaTransportJob) => { calls++; return { text: wire(job) }; });
      const isCurrent = () => { if (++guards !== failAt) return true; callsAtFailure = calls; return false; };
      const error = await startProposalAreaRun({ sources: sources(), isCurrent, transport }).promise.catch(error => error);
      expect(error.code).toBe('STALE'); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      expect(callsAtFailure).toBeGreaterThanOrEqual(0); expect(calls).toBe(callsAtFailure);
    }
  });

  it('rechecks abort after isCurrent callbacks so an already-aborted transport is never initiated', async () => {
    for (let abortAt = 1; abortAt <= 22; abortAt++) {
      const controller = new AbortController(); let guards = 0;
      const transport = vi.fn(async (job: ProposalAreaTransportJob) => { expect(job.signal.aborted).toBe(false); return { text: wire(job) }; });
      const isCurrent = () => { if (++guards === abortAt) controller.abort(); return true; };
      const error = await startProposalAreaRun({ sources: sources(), isCurrent, transport, signal: controller.signal }).promise.catch(error => error);
      expect(error.code).toBe('CANCELLED'); await Promise.resolve(); await Promise.resolve();
    }
  });

  it('observes a rejected transport promise and stops before any retry or review', async () => {
    const failure = new Error('Synthetic transport failure'), transport = vi.fn(async () => { throw failure; });
    const error = await startProposalAreaRun({ sources: sources(2), isCurrent: () => true, transport }).promise.catch(error => error);
    expect(error.code).toBe('FAILED'); expect(error.message).toBe(failure.message); expect(error.capturedParts).toEqual([]);
    await Promise.resolve(); await Promise.resolve(); expect(transport).toHaveBeenCalledTimes(1);
  });

  it('checks after user callbacks and does not initiate transport when progress invalidates the run', async () => {
    let current = true; const transport = vi.fn(async (job: ProposalAreaTransportJob) => ({ text: wire(job) }));
    await expect(startProposalAreaRun({ sources: sources(), isCurrent: () => current, transport, onProgress: () => { current = false; } }).promise).rejects.toMatchObject({ code: 'STALE' }); expect(transport).not.toHaveBeenCalled();
    current = true;
    await expect(startProposalAreaRun({ sources: sources(2), isCurrent: () => current, transport, onPart: () => { current = false; } }).promise).rejects.toMatchObject({ code: 'STALE' }); expect(transport).toHaveBeenCalledTimes(1);
  });

  it('uses only the explicitly injected transport, never global fetch, Worker, native storage or exporters', async () => {
    const fetch = vi.fn(), Worker = vi.fn(); vi.stubGlobal('fetch', fetch); vi.stubGlobal('Worker', Worker);
    const result = await startProposalAreaRun({ sources: sources(), isCurrent: () => true, transport: async job => ({ text: wire(job) }) }).promise;
    expect(result.readyForClient).toBe(false); expect(fetch).not.toHaveBeenCalled(); expect(Worker).not.toHaveBeenCalled();
  });
});
