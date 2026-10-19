import { afterEach, describe, expect, it, vi } from 'vitest';
import * as automatic from './automaticConditions';
import * as quotePlan from './proposalQuotePlan';
import { buildProposalQuotePlan } from './proposalQuotePlan';
import { ResponsePreparationCancelled, responsePreparationTimeoutMilliseconds, startProposalQuotePreparation, startResponsePreparation } from './responsePreparation';
import { runProposalQuotePreparation, runResponsePreparation, validResponsePreparationReply } from './responsePreparationWorker';
import type { ProposalQuotePreparationRequest, ProposalQuotePreparationWireRequest } from './proposalQuotePreparation';
import type { IntelligenceSource } from './workbenchTypes';

function source(): IntelligenceSource {
  const lines = ['Договор', 'Исполнитель: ООО «Учебные работы»', 'Заказчик: ООО «Контроль QA»',
    '1. Предмет договора', '1.1. Исполнитель оказывает комплекс услуг по проверке учебной системы, состав которых определён в приложении.',
    '2. Состав оказываемых услуг', '2.1. Анализ документации с сохранением ограничений доступа.',
    '3. Итоговые материалы и результат оказания услуг', '3.1. Отчёт с рисками и рекомендациями.',
    '4. Стоимость услуг и порядок расчетов', '4.1. Аванс 25% в течение 4 календарных дней от подписания.',
    '5. Срок оказания услуг', '5.1. Максимальный срок — 16 рабочих дней после полного аванса или всех материалов, что наступит позднее.'];
  return { id: 'source', name: 'Учебный договор', text: lines.join('\n'), fragments: lines.map((text, index) => ({ id: `p-${index}`, locator: `Абзац ${index}`, text })), coverage: { complete: true, requiresOcr: false } };
}
async function request(core = true): Promise<ProposalQuotePreparationWireRequest> {
  const sources = [source()], options = { maxUnitsPerBatch: 2 }, plan = await buildProposalQuotePlan(sources, options);
  return { origin: 'model-selected-quotes', revision: 7, sources, options, parts: plan.batches.map(batch => ({ batchId: batch.id, model: 'synthetic-model', raw: JSON.stringify({ sourceSnapshotKey: plan.sourceSnapshotKey, batchId: batch.id,
    units: Object.fromEntries(batch.units.map(unit => [unit.unitId, { disposition: core && unit.fragmentIndex === 6 ? 'commercial' : 'context', roles: core && unit.fragmentIndex === 6 ? ['scope'] : [], quote: core && unit.fragmentIndex === 6 ? unit.text : null }])) }) })) };
}
function bare(input: ProposalQuotePreparationWireRequest): ProposalQuotePreparationRequest { const { origin: _origin, ...rest } = input; return rest; }
class LocalWorker {
  static instances: LocalWorker[] = [];
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessageerror: ((event: Event) => void) | null = null;
  terminated = 0; request: unknown;
  constructor() { LocalWorker.instances.push(this); }
  postMessage(value: unknown) { this.request = structuredClone(value); }
  terminate() { this.terminated++; }
  reply(value: unknown) { this.onmessage?.({ data: value } as MessageEvent<unknown>); }
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); LocalWorker.instances = []; });

describe('quote preparation distinct worker origin', () => {
  it('separates actual scope selection from independent canonical local completion without model field counts', async () => {
    const input = await request(), before = structuredClone(input), fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const reply = await runProposalQuotePreparation(input), item = reply.prepared!.items[0], ledger = reply.modelQuoteProvenance!;
    expect(reply.failed).toBeUndefined(); expect(validResponsePreparationReply(reply, 7, 'model-selected-quotes')).toBe(true);
    expect(validResponsePreparationReply(reply, 7)).toBe(false); expect(validResponsePreparationReply(reply, 7, 'source-contract')).toBe(false);
    expect(ledger.counts.commercial).toBe(1); expect(ledger.selections.map(selection => selection.quote)).toEqual([input.sources[0].fragments![6].text]);
    expect(ledger.parts).toEqual(input.parts); expect(ledger.projectedItemId).toBe(item.id); expect(item.fields.lines).toBeDefined(); expect(item.fields.paymentTerms).toContain('Аванс');
    expect(reply.prepared!.sourcePreparation?.changes.some(change => change.field === 'lines')).toBe(true); expect(reply.prepared!.sourcePreparation?.origin).toBeUndefined();
    expect(reply).not.toHaveProperty('modelContribution'); expect(item).not.toHaveProperty('modelQuoteProvenance'); expect(input).toEqual(before); expect(fetch).not.toHaveBeenCalled();
  });
  it('returns explicit empty without invoking local completion when the model selected no core commercial content', async () => {
    const complete = vi.spyOn(automatic, 'completeIntelligenceConditions'), reply = await runProposalQuotePreparation(await request(false));
    expect(reply).toEqual({ revision: 7, origin: 'model-selected-quotes', empty: true }); expect(complete).not.toHaveBeenCalled(); expect(validResponsePreparationReply(reply, 7, 'model-selected-quotes')).toBe(true);
  });
  it('rejects invalid late parts atomically without canonical fallback or a partial ledger', async () => {
    const input = await request(); input.parts[input.parts.length - 1].raw = '{'; const complete = vi.spyOn(automatic, 'completeIntelligenceConditions');
    const reply = await runProposalQuotePreparation(input); expect(reply.failed).toBeTypeOf('string'); expect(reply.prepared).toBeUndefined(); expect(reply.modelQuoteProvenance).toBeUndefined(); expect(complete).not.toHaveBeenCalled();
  });
  it.each(['raw', 'destinations', 'modelContribution', 'modelQuoteProvenance', 'ack', 'items'])('rejects injected %s metadata rather than treating it as provenance', async key => {
    const reply = await runProposalQuotePreparation({ ...await request(), [key]: {} }); expect(reply.failed).toBeTypeOf('string'); expect(reply.prepared).toBeUndefined();
  });
  it('does not accept quote input through the old synchronous provider route', async () => {
    const reply = runResponsePreparation(await request()); expect(reply.failed).toBeTypeOf('string'); expect(reply.prepared).toBeUndefined(); expect(reply.modelContribution).toBeUndefined();
  });
  it('requires matching ledger owner and rejects metadata on failed/empty/ordinary replies', async () => {
    const good = await runProposalQuotePreparation(await request());
    for (const mutate of [
      (copy: typeof good) => { delete copy.modelQuoteProvenance; },
      (copy: typeof good) => { copy.modelQuoteProvenance!.projectedItemId = 'another'; },
      (copy: typeof good) => { Object.assign(copy, { modelContribution: { items: 1 } }); },
      (copy: typeof good) => { copy.prepared!.sourcePreparation!.origin = 'source-contract'; },
    ]) { const copy = structuredClone(good); mutate(copy); expect(validResponsePreparationReply(copy, 7, 'model-selected-quotes')).toBe(false); }
    expect(validResponsePreparationReply({ revision: 7, origin: 'model-selected-quotes', empty: true, modelQuoteProvenance: good.modelQuoteProvenance }, 7, 'model-selected-quotes')).toBe(false);
    expect(validResponsePreparationReply({ revision: 7, origin: 'model-selected-quotes', failed: 'QA', modelQuoteProvenance: good.modelQuoteProvenance }, 7, 'model-selected-quotes')).toBe(false);
    expect(validResponsePreparationReply({ ...good, origin: undefined }, 7)).toBe(false);
  });
});

describe('quote selection one-shot bridge', () => {
  it('snapshots raw parts and sources, ignores stale revision and accepts only matching original provenance', async () => {
    vi.stubGlobal('Worker', LocalWorker); const input = await request(), task = startProposalQuotePreparation(bare(input)), worker = LocalWorker.instances[0];
    input.parts[0].raw = 'changed'; input.sources[0].fragments![6].text = 'changed'; const reply = await runProposalQuotePreparation(worker.request);
    worker.reply({ ...reply, revision: 8 }); expect(worker.terminated).toBe(0); worker.reply(reply);
    expect((await task.promise).modelQuoteProvenance?.parts[0].raw).not.toBe('changed'); expect(worker.terminated).toBe(1); expect(worker.onmessage).toBeNull(); task.cancel(); expect(worker.terminated).toBe(1);
  });
  it('rejects a structurally valid receipt whose source hash was substituted', async () => {
    vi.stubGlobal('Worker', LocalWorker); const task = startProposalQuotePreparation(bare(await request())), worker = LocalWorker.instances[0], reply = await runProposalQuotePreparation(worker.request);
    reply.modelQuoteProvenance!.sourceSnapshotKey = `sha256:${'a'.repeat(64)}`; worker.reply(reply); await expect(task.promise).rejects.toThrow(/Ключ/); expect(worker.terminated).toBe(1);
  });
  it.each(['raw', 'quote'] as const)('rejects a changed receipt %s against the immutable input', async variant => {
    vi.stubGlobal('Worker', LocalWorker); const task = startProposalQuotePreparation(bare(await request())), worker = LocalWorker.instances[0], reply = await runProposalQuotePreparation(worker.request);
    if (variant === 'raw') reply.modelQuoteProvenance!.parts[0].raw += ' '; else reply.modelQuoteProvenance!.selections[0].quote += ' changed';
    worker.reply(reply); await expect(task.promise).rejects.toThrow(/Журнал/); expect(worker.terminated).toBe(1);
  });
  it('rejects a mutated valid role even when the quotation, source hash and raw parts are unchanged', async () => {
    vi.stubGlobal('Worker', LocalWorker); const task = startProposalQuotePreparation(bare(await request())), worker = LocalWorker.instances[0], reply = await runProposalQuotePreparation(worker.request);
    expect(reply.modelQuoteProvenance!.selections[0].roles).toEqual(['scope']);
    reply.modelQuoteProvenance!.selections[0].roles = ['payment'];
    expect(validResponsePreparationReply(reply, 7, 'model-selected-quotes')).toBe(true);
    worker.reply(reply); await expect(task.promise).rejects.toThrow(/Журнал/); expect(worker.terminated).toBe(1);
  });
  it('rejects an actual source quotation added to selections when the original model raw classified it as context', async () => {
    vi.stubGlobal('Worker', LocalWorker); const task = startProposalQuotePreparation(bare(await request())), worker = LocalWorker.instances[0], reply = await runProposalQuotePreparation(worker.request);
    const captured = worker.request as ProposalQuotePreparationWireRequest, fragment = captured.sources[0].fragments![10];
    const originalUnit = captured.parts.map(part => JSON.parse(part.raw).units[fragment.id!]).find(Boolean);
    expect(originalUnit).toMatchObject({ disposition: 'context', quote: null });
    const ledger = reply.modelQuoteProvenance!;
    ledger.selections.push({ unitId: fragment.id!, sourceId: captured.sources[0].id, fragmentId: fragment.id!, locator: fragment.locator, quote: fragment.text, roles: ['payment'] });
    ledger.counts.commercial++; ledger.counts.context--;
    expect(validResponsePreparationReply(reply, 7, 'model-selected-quotes')).toBe(true);
    worker.reply(reply); await expect(task.promise).rejects.toThrow(/Журнал/); expect(worker.terminated).toBe(1);
  });
  it('cancels an in-flight fresh raw proof without publishing or continuing through its remaining batches', async () => {
    vi.stubGlobal('Worker', LocalWorker); const input = await request(), task = startProposalQuotePreparation(bare(input)), worker = LocalWorker.instances[0];
    const reply = await runProposalQuotePreparation(worker.request), plan = await buildProposalQuotePlan(input.sources, input.options);
    let resume!: () => void, started!: () => void;
    const gate = new Promise<void>(resolve => { resume = resolve; }), entered = new Promise<void>(resolve => { started = resolve; });
    const build = vi.spyOn(quotePlan, 'buildProposalQuotePlan').mockImplementationOnce(async () => { started(); await gate; return plan; });
    const parse = vi.spyOn(quotePlan, 'parseProposalQuoteResponse');
    worker.reply(reply); await entered;
    // Duplicate callbacks must not allocate a second asynchronous proof.
    worker.reply(reply); expect(build).toHaveBeenCalledTimes(1);
    const rejection = expect(task.promise).rejects.toBeInstanceOf(ResponsePreparationCancelled);
    task.cancel(); resume(); await rejection; await Promise.resolve();
    expect(parse).not.toHaveBeenCalled(); expect(worker.terminated).toBe(1); expect(worker.onmessage).toBeNull();
  });
  it('cancels immediately and ignores a retained late worker callback', async () => {
    vi.stubGlobal('Worker', LocalWorker); const task = startProposalQuotePreparation(bare(await request())), worker = LocalWorker.instances[0], stale = worker.onmessage!;
    const rejection = expect(task.promise).rejects.toBeInstanceOf(ResponsePreparationCancelled); task.cancel(); stale({ data: { revision: 7, origin: 'model-selected-quotes', empty: true } } as MessageEvent<unknown>);
    await rejection; expect(worker.terminated).toBe(1);
  });
  it('times out after 60 seconds without retries or another worker', async () => {
    const input = bare(await request()); vi.stubGlobal('Worker', LocalWorker); vi.useFakeTimers(); const task = startProposalQuotePreparation(input), rejection = expect(task.promise).rejects.toThrow(/60 секунд/);
    await vi.advanceTimersByTimeAsync(responsePreparationTimeoutMilliseconds); await rejection; expect(LocalWorker.instances).toHaveLength(1); expect(LocalWorker.instances[0].terminated).toBe(1);
  });
  it.each(['onerror', 'onmessageerror'] as const)('releases the worker on %s without a replacement result', async kind => {
    vi.stubGlobal('Worker', LocalWorker); const task = startProposalQuotePreparation(bare(await request())), worker = LocalWorker.instances[0], rejection = expect(task.promise).rejects.toThrow();
    worker[kind]!(new Event('error')); await rejection; expect(worker.terminated).toBe(1);
  });
  it('supports an asynchronous no-worker fallback and its cancellation', async () => {
    vi.stubGlobal('Worker', undefined); const input = bare(await request()), before = structuredClone(input), reply = await startProposalQuotePreparation(input).promise;
    expect(reply.modelQuoteProvenance?.counts.commercial).toBe(1); expect(input).toEqual(before);
    const task = startProposalQuotePreparation(input), rejection = expect(task.promise).rejects.toBeInstanceOf(ResponsePreparationCancelled); task.cancel(); await rejection;
  });
  it('validates bad envelopes before worker allocation and preserves the distinct failure origin', async () => {
    vi.stubGlobal('Worker', LocalWorker); const input = bare(await request()); input.parts[0].raw = 'x'.repeat(2 * 1024 * 1024 + 1);
    const reply = await startProposalQuotePreparation(input).promise; expect(reply.failed).toContain('2 МБ'); expect(reply.origin).toBe('model-selected-quotes'); expect(LocalWorker.instances).toHaveLength(0);
  });
  it('does not pass quote replies through an old provider request', async () => {
    vi.stubGlobal('Worker', LocalWorker); const task = startResponsePreparation({ revision: 7, raw: '{"items":[]}', sources: [source()], destinations: ['proposals'] });
    LocalWorker.instances[0].reply(await runProposalQuotePreparation(await request())); await expect(task.promise).rejects.toThrow(/некорректный/);
  });
});
