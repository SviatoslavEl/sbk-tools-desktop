import { afterEach, describe, expect, it, vi } from 'vitest';
import { createContractProposalProver } from './contractProposalCompletion';
import { startSourceContractPreparation, ResponsePreparationCancelled, responsePreparationTimeoutMilliseconds, startResponsePreparation } from './responsePreparation';
import { runResponsePreparation, validResponsePreparationReply } from './responsePreparationWorker';
import { assertPreparedSourceContract, type SourceContractPreparationWireRequest } from './sourceContractPreparation';
import { buildIntelligenceHandoff } from './workbenchModel';
import type { IntelligenceSource } from './workbenchTypes';

function source(): IntelligenceSource {
  const lines = ['Договор', 'Исполнитель: ООО «Учебные работы»', 'Заказчик: ООО «Контроль QA»',
    '1. Предмет договора', '1.1. Исполнитель оказывает комплекс услуг по проверке учебной системы, состав которых определён в приложении.',
    '2. Состав оказываемых услуг', '2.1. Анализ документации с сохранением ограничений доступа.', '2.2. Проверка компонентов; SBOM при наличии.',
    '3. Итоговые материалы и результат оказания услуг', '3.1. Отчёт с рисками и рекомендациями.', '3.2. Материалы в DOCX и PDF; встреча по результатам.',
    '4. Стоимость услуг и порядок расчетов', '4.1. Стоимость услуг составляет 12 000,00 рублей, в том числе НДС 22%.',
    '4.2. Аванс 25% в течение 4 календарных дней от подписания.', '4.3. Окончательный расчет в течение 6 рабочих дней от акта или истечения срока отказа.',
    '5. Срок оказания услуг', '5.1. Максимальный срок — 16 рабочих дней после полного аванса или всех материалов, что наступит позднее.',
    '6. Входные данные и условия проведения работ', '6.1. Заказчик предоставляет доступы, материалы и разрешения; репозиторий при наличии.',
    '7. Допущения и ограничения', '7.1. Восстановление архитектуры в объём работ не входит.'];
  return { id: 'source', name: 'Учебный договор', text: lines.join('\n'), fragments: lines.map((text, index) => ({ id: `p-${index}`, locator: `Абзац ${index}`, text })), coverage: { complete: true, requiresOcr: false } };
}
const request = (): SourceContractPreparationWireRequest => ({ origin: 'source-contract', revision: 9, sources: [source()] });
const freeze = <T,>(value: T): T => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
class LocalWorker {
  static instances: LocalWorker[] = [];
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessageerror: ((event: Event) => void) | null = null;
  terminated = 0; request: unknown;
  constructor() { LocalWorker.instances.push(this); }
  postMessage(value: unknown) { this.request = structuredClone(value); }
  terminate() { this.terminated++; }
  reply(value: unknown = runResponsePreparation(this.request)) { this.onmessage?.({ data: value } as MessageEvent<unknown>); }
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); LocalWorker.instances = []; });

describe('explicit local source-contract preparation', () => {
  it('prepares one fresh complete canonical project and identifies local origin without approvals or invented fields', () => {
    const input = freeze(request()), before = structuredClone(input), reply = runResponsePreparation(input), item = reply.prepared!.items[0];
    expect(reply.origin).toBe('source-contract'); expect(reply.prepared!.sourcePreparation!.origin).toBe('source-contract'); expect(reply.failed).toBeUndefined();
    expect(validResponsePreparationReply(reply, 9, 'source-contract')).toBe(true); expect(validResponsePreparationReply(reply, 9)).toBe(false);
    expect(() => assertPreparedSourceContract(reply.prepared!.items, input.sources)).not.toThrow();
    expect([...createContractProposalProver(input.sources).prove(item, [item])!.fields.keys()]).toEqual(expect.arrayContaining(['title', 'introduction', 'lines', 'lineDescriptions', 'deliveryTerms', 'paymentTerms']));
    expect(item.proposalSourceFinancials).toHaveLength(1); expect(item.proposalSourceParties).toHaveLength(2);
    expect(item.fields).not.toHaveProperty('documentDate'); expect(item.fields).not.toHaveProperty('validUntil'); expect(item.fields).not.toHaveProperty('unitPrice'); expect(item.fields).not.toHaveProperty('contactName');
    const handoff = buildIntelligenceHandoff(item, input.sources, '/isolated-workspace');
    expect(handoff.destination === 'proposals' && handoff.data.sourceFinancials?.decision).toBeUndefined();
    expect(input).toEqual(before); expect(reply.prepared!.sourcePreparation!.changes.every(change => change.requiresReview)).toBe(true);
  });
  it('does not reinterpret or mutate a nonempty poisoned model template or its raw recovery copy', () => {
    const sources = [source()], raw = JSON.stringify({ items: [{ destination: 'proposals', title: 'КП', fields: { title: 'Чужой проект', lines: ['Чужая поставка'], lineDescriptions: ['Неверный состав'], deliveryTerms: 'Завтра', paymentTerms: 'Бесплатно' }, sourceIds: ['source'] }] });
    const model = runResponsePreparation({ revision: 1, raw, sources, destinations: ['proposals'] }), before = structuredClone({ raw, model, sources });
    const local = runResponsePreparation({ revision: 2, origin: 'source-contract', sources });
    expect(local.prepared?.items[0].fields.title).toBe('КП по проверке учебной системы'); expect(JSON.stringify(local.prepared)).not.toContain('Чужая поставка');
    expect({ raw, model, sources }).toEqual(before); expect(model.origin).toBeUndefined();
    expect(() => assertPreparedSourceContract(model.prepared!.items, sources)).toThrow(/Полный/);
  });
  it.each(['raw', 'items', 'destinations', 'ack'])('rejects source-route %s input rather than parsing or granting it', key => {
    const reply = runResponsePreparation({ ...request(), [key]: key === 'raw' ? '{"items":[]}' : [] });
    expect(reply.origin).toBe('source-contract'); expect(reply.failed).toBeTypeOf('string'); expect(reply.prepared).toBeUndefined();
  });
  it.each(['incomplete', 'ocr', 'unknown-coverage', 'hidden', 'excluded', 'multiple', 'duplicate-heading', 'technical-task', 'missing-payment', 'field-limit'])('fails %s atomically without a partial card', variant => {
    const input = request(), first = input.sources[0];
    if (variant === 'incomplete') first.coverage!.complete = false;
    if (variant === 'ocr') first.coverage!.requiresOcr = true;
    if (variant === 'unknown-coverage') delete first.coverage;
    if (variant === 'hidden') Object.assign(first.fragments![6], { sheetState: 'hidden' });
    if (variant === 'excluded') first.fragments![6].includedByUser = false;
    if (variant === 'multiple') input.sources.push({ ...structuredClone(first), id: 'another' });
    if (variant === 'duplicate-heading') first.fragments!.push({ id: 'another-heading', locator: 'Другой договор', text: 'Договор' });
    if (variant === 'technical-task') first.fragments![0].text = 'Техническое задание';
    if (variant === 'missing-payment') first.fragments = first.fragments!.filter(fragment => !/Аванс|расчет|расчетов/iu.test(fragment.text));
    if (variant === 'field-limit') first.fragments![6].text += ' подробности'.repeat(2000);
    const before = structuredClone(input), reply = runResponsePreparation(input);
    expect(reply.failed).toBeTypeOf('string'); expect(reply.prepared).toBeUndefined(); expect(reply.empty).toBeUndefined(); expect(input).toEqual(before);
  });
  it('keeps whole long evidence with bounded contiguous quote pieces instead of truncating it', () => {
    const input = request(); input.sources[0].fragments![6].text += ' Сохраняется оговорка об исходных материалах.'.repeat(60);
    const reply = runResponsePreparation(input), item = reply.prepared!.items[0];
    expect(reply.failed).toBeUndefined(); expect((item.fields.lineDescriptions as string[])[0]).toContain(input.sources[0].fragments![6].text);
    expect(item.evidence!.every(claim => claim.quote.length <= 2000)).toBe(true);
    expect(() => assertPreparedSourceContract([item], input.sources)).not.toThrow();
  });
  it('leaves normal invalid JSON and origin-spoofed responses rejected without changing parse behavior', () => {
    const input = { revision: 3, raw: 'not JSON', sources: [source()], destinations: ['proposals'] };
    const reply = runResponsePreparation(input); expect(reply.failed).toBeTypeOf('string'); expect(reply.origin).toBeUndefined();
    expect(validResponsePreparationReply({ revision: 3, origin: 'source-contract', failed: 'failure' }, 3)).toBe(false);
    expect(validResponsePreparationReply({ revision: 3, failed: 'failure' }, 3, 'source-contract')).toBe(false);
  });
});

describe('source-contract one-shot client', () => {
  it('snapshots sources and revision before posting and accepts only its matching origin/revision', async () => {
    vi.stubGlobal('Worker', LocalWorker); const input = request(), task = startSourceContractPreparation({ revision: input.revision, sources: input.sources }), worker = LocalWorker.instances[0];
    input.revision++; input.sources[0].fragments![6].text = 'Поздний чужой текст';
    expect((worker.request as SourceContractPreparationWireRequest).sources[0].fragments![6].text).not.toContain('Поздний');
    worker.reply({ revision: 10, origin: 'source-contract', failed: 'stale' }); expect(worker.terminated).toBe(0);
    worker.reply(); expect((await task.promise).prepared?.sourcePreparation?.origin).toBe('source-contract'); expect(worker.terminated).toBe(1);
  });
  it('cancels once and ignores a retained late callback without a result', async () => {
    vi.stubGlobal('Worker', LocalWorker); const task = startSourceContractPreparation({ revision: 1, sources: [source()] }), worker = LocalWorker.instances[0], old = worker.onmessage!;
    const rejection = expect(task.promise).rejects.toBeInstanceOf(ResponsePreparationCancelled); task.cancel(); old({ data: runResponsePreparation(worker.request) } as MessageEvent<unknown>);
    await rejection; expect(worker.terminated).toBe(1);
  });
  it('times out without retries and rejects a normal-mode reply even with the right revision', async () => {
    vi.stubGlobal('Worker', LocalWorker); vi.useFakeTimers(); const task = startSourceContractPreparation({ revision: 1, sources: [source()] });
    const rejection = expect(task.promise).rejects.toThrow(/60 секунд/); await vi.advanceTimersByTimeAsync(responsePreparationTimeoutMilliseconds); await rejection;
    expect(LocalWorker.instances).toHaveLength(1); expect(LocalWorker.instances[0].terminated).toBe(1);
    vi.useRealTimers(); const other = startSourceContractPreparation({ revision: 1, sources: [source()] }); LocalWorker.instances[1].reply({ revision: 1, failed: 'normal mode' });
    await expect(other.promise).rejects.toThrow(/некорректный/);
  });
  it('shares bounds before worker allocation and supports the no-worker pure path', async () => {
    vi.stubGlobal('Worker', LocalWorker); const sources = [source()]; sources[0].name = 'x'.repeat(20001);
    const reply = await startSourceContractPreparation({ revision: 1, sources }).promise; expect(reply.failed).toBeTypeOf('string'); expect(reply.origin).toBe('source-contract'); expect(LocalWorker.instances).toHaveLength(0);
    vi.stubGlobal('Worker', undefined); const fallback = await startSourceContractPreparation({ revision: 2, sources: [source()] }).promise; expect(fallback.prepared?.items).toHaveLength(1);
  });
  it('does not admit source-only results through the normal preparation client', async () => {
    vi.stubGlobal('Worker', LocalWorker); const task = startResponsePreparation({ revision: 9, raw: '{"items":[]}', sources: [source()], destinations: ['proposals'] });
    LocalWorker.instances[0].reply(runResponsePreparation(request())); await expect(task.promise).rejects.toThrow(/некорректный/);
  });
  it('rejects a valid source-mode reply from another source snapshot or with an added foreign owner', async () => {
    vi.stubGlobal('Worker', LocalWorker); const task = startSourceContractPreparation({ revision: 9, sources: [source()] }), other = request();
    other.sources[0].fragments![4].text = other.sources[0].fragments![4].text.replace('учебной системы', 'другой системы');
    const reply = runResponsePreparation(other); expect(reply.prepared).toBeDefined(); LocalWorker.instances[0].reply(reply);
    await expect(task.promise).rejects.toThrow(/снимку исходного договора/);
    const second = startSourceContractPreparation({ revision: 9, sources: [source()] }), foreign = runResponsePreparation(request()); foreign.prepared!.items[0].sourceIds.push('foreign-source');
    LocalWorker.instances[1].reply(foreign); await expect(second.promise).rejects.toThrow(/снимку исходного договора/);
  });
});
