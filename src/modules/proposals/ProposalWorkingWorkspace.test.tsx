import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProposalWorkingWorkspace, type ProposalWorkingServices, type ProposalWorkingWorkspaceProps, type ProposalWorkingSummary } from './ProposalWorkingWorkspace';
import { PROPOSAL_AREAS } from '../intelligence/proposalAreaPlan';
import { fingerprintWorkingProposal, serializeWorkingProposalDocument, type WorkingProposalDocument } from './workingDocument';

// Source-only ordinary DTO fixtures and a hook/callback/SSR harness. These tests
// are not browser clicks, keyboard-focus/layout acceptance, native I/O or model QA.
const hooks = vi.hoisted(() => ({ at: 0, slots: [] as { value?: unknown; deps?: readonly unknown[]; cleanup?: () => void }[], effects: [] as (() => void)[] }));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(),
  useState: (initial: unknown) => { const index = hooks.at++; hooks.slots[index] ??= { value: typeof initial === 'function' ? initial() : initial };
    return [hooks.slots[index].value, (next: unknown) => { hooks.slots[index].value = typeof next === 'function' ? next(hooks.slots[index].value) : next; }]; },
  useRef: (initial: unknown) => { const index = hooks.at++; hooks.slots[index] ??= { value: { current: initial } }; return hooks.slots[index].value; },
  useEffect: (callback: () => (() => void) | void, deps: readonly unknown[]) => {
    const index = hooks.at++, before = hooks.slots[index];
    if (!before || !before.deps || before.deps.length !== deps.length || deps.some((value, at) => !Object.is(value, before.deps![at]))) {
      hooks.effects.push(() => { before?.cleanup?.(); const cleanup = callback(); hooks.slots[index] = { deps, cleanup: typeof cleanup === 'function' ? cleanup : undefined }; });
    }
  },
  useId: () => 'ordinary-working-proposal',
}));

// Ordinary untrusted historical envelope, not a restored issued capability.
const historyJson = JSON.stringify({ version: 1, purpose: 'unapproved-model-whole-proposal-draft', planKey: `sha256:${'c'.repeat(64)}`,
  sourceSnapshotKey: `sha256:${'a'.repeat(64)}`, structureSnapshotKey: `sha256:${'b'.repeat(64)}`, sourceSnapshot: [{ text: 'PRIVATE_HISTORICAL_SENTINEL' }],
  owners: [], sections: [], clarificationQuestions: [], unvalidatedDetails: [], audit: {}, runCoverage: {}, approvedContent: [],
  readyForClient: false, humanApproval: false, semanticTruth: 'not-proven', completeness: 'not-assessed', providerAuthenticity: 'not-attested' });
let historySHA: string;
const realSetTimeout = setTimeout;
const tick = () => new Promise<void>(resolve => realSetTimeout(resolve, 0));
const titles = ['Состав работ', 'Результаты', 'Проверяемые аспекты', 'Цена и НДС', 'Оплата', 'Участники и роли', 'Сроки'];
function fixture(id = '01234567-1234-4123-8123-0123456789ab'): WorkingProposalDocument {
  return { kind: 'proposal-working-document', schemaVersion: 1, id, revision: 0, title: 'Рабочее КП без выдуманных реквизитов',
    metadata: { number: null, documentDate: null, validUntil: null, currency: null, issuerName: null, recipientName: null }, layout: { style: 'standard', accentColor: '#247A64' },
    sections: PROPOSAL_AREAS.map((area, index) => ({ area, title: titles[index], blocks: [{ id: `${area}:block-1`, frameId: 'work-scope:block-1', frameIndex: 0,
      text: `  SYNTHETIC_WHOLE_${area}\nСущественные условия без сокращения.  `, origin: 'historical-model-answer', included: true }], userText: '', userTextIncluded: false })),
    questions: [{ id: 'question-payment', area: 'payment', topic: 'Условия', question: 'Какие условия оплаты следует уточнить?', answer: 'PRIVATE_QUESTION_ANSWER', state: 'answered' }],
    historicalSource: { kind: 'unvalidated-history', sha256: historySHA, bytes: new TextEncoder().encode(historyJson).byteLength, sourceSnapshotKey: `sha256:${'a'.repeat(64)}`, structureSnapshotKey: `sha256:${'b'.repeat(64)}`, planKey: `sha256:${'c'.repeat(64)}` } };
}
let props: ProposalWorkingWorkspaceProps, tree: ReactNode;
function services(): ProposalWorkingServices {
  return {
    list: vi.fn(async request => ({ binding: request.binding, summaries: [] })),
    open: vi.fn(async request => { const document = fixture(request.id); return { binding: request.binding, document, storageToken: request.storageToken, documentFingerprint: await fingerprintWorkingProposal(document) }; }),
    save: vi.fn(async request => ({ binding: request.binding, storageToken: 'saved-token-2', documentFingerprint: request.binding.documentFingerprint })),
    history: vi.fn(async request => ({ binding: request.binding, text: historyJson })),
    export: vi.fn(async request => ({ binding: request.binding, format: request.format, clientProjectionFingerprint: request.clientProjectionFingerprint, fileName: `КП.${request.format}` })),
  };
}
function render(next = props) {
  props = next; hooks.at = 0; hooks.effects = []; tree = ProposalWorkingWorkspace(props); const effects = hooks.effects; hooks.effects = []; effects.forEach(run => run());
}
function start(extra: Partial<ProposalWorkingWorkspaceProps> = {}) {
  render({ initialDocument: fixture(), initialStorageToken: null, sessionKey: 'session-1', context: { workspaceRoot: 'synthetic-root', leaseGeneration: 'lease-1', taskKey: 'task-1', access: 'editor', stale: false }, services: services(), ...extra });
}
interface NodeProps {
  children?: ReactNode; value?: string; checked?: boolean; disabled?: boolean; 'aria-label'?: string; 'data-block-id'?: string;
  onChange?: (event: { target: { value: string; checked: boolean } }) => void; onClick?: () => void;
}
function nodes(node: ReactNode = tree): ReactElement<NodeProps>[] { if (Array.isArray(node)) return node.flatMap(child => nodes(child ?? null)); if (!isValidElement<NodeProps>(node)) return []; return [node, ...nodes(node.props.children ?? null)]; }
function text(node: ReactNode = tree): string { if (Array.isArray(node)) return node.map(child => text(child ?? null)).join(''); if (isValidElement<NodeProps>(node)) return text(node.props.children ?? null); return typeof node === 'string' || typeof node === 'number' ? String(node) : ''; }
function control(label: string) { const node = nodes().find(node => node.props['aria-label'] === label); if (!node) throw new Error(`Missing control ${label}`); return node; }
function button(label: string) { const node = nodes().find(node => node.type === 'button' && text(node) === label); if (!node) throw new Error(`Missing button ${label}`); return node; }
function edit(label: string, value: string) { control(label).props.onChange!({ target: { value, checked: false } }); render(); }
function check(label: string, checked: boolean) { control(label).props.onChange!({ target: { value: '', checked } }); render(); }
function click(label: string) { button(label).props.onClick!(); render(); }
async function waitUntil(predicate: () => boolean) {
  for (let at = 0; at < 300; at++) { await tick(); render(); if (predicate()) return; }
  throw new Error(`Callback did not settle. Current text: ${text().slice(0, 700)}`);
}
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function preview() { click('Просмотреть документ'); await waitUntil(() => text().includes('Что будет отправлено заказчику')); }
async function approve() { await preview(); check('Я проверил текущий документ и нерешённые вопросы', true); click('Подтвердить мою проверку'); await waitUntil(() => !button('Скачать DOCX').props.disabled); }
const summary: ProposalWorkingSummary = { id: '11234567-1234-4123-8123-0123456789ab', title: 'Другой сохранённый черновик', storageToken: 'other-token-1', updatedAt: null };

beforeAll(async () => { const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(historyJson)); historySHA = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join(''); });
beforeEach(() => { hooks.at = 0; hooks.slots = []; hooks.effects = []; });
afterEach(() => { hooks.slots.forEach(slot => slot.cleanup?.()); vi.useRealTimers(); });

describe('ordinary working proposal — source-only callback/SSR scenarios', () => {
  it('shows seven full areas, historical warnings and null metadata without defaults or eager history', () => {
    start(); const html = renderToStaticMarkup(<>{tree}</>);
    titles.forEach(title => expect(html).toContain(title)); expect(html).toContain('Исторические ответы ИИ могут содержать ошибки');
    expect(html).toContain('Валюта, даты, суммы и стороны не заполняются автоматически');
    for (const label of ['Номер КП', 'Дата КП', 'Действует до', 'Валюта', 'Отправитель', 'Получатель']) expect(control(label).props.value).toBe('');
    expect(props.services.history).not.toHaveBeenCalled(); expect(html).not.toContain('PRIVATE_HISTORICAL_SENTINEL');
    expect(nodes().filter(node => node.props['data-block-id'])).toHaveLength(7);
  });

  it('keeps stable block keys and full decoded text, separates question resolution from client content', async () => {
    start(); const key = nodes().find(node => node.props['data-block-id'] === 'work-scope:block-1')!.key;
    edit('Текст блока 1 — Состав работ', 'П'); edit('Текст блока 1 — Состав работ', '  Полная правка\nбез усечения 😀  ');
    expect(control('Текст блока 1 — Состав работ').props.value).toBe('  Полная правка\nбез усечения 😀  ');
    expect(nodes().find(node => node.props['data-block-id'] === 'work-scope:block-1')!.key).toBe(key);
    edit('Ответ на вопрос — question-payment', 'PRIVATE_UPDATED_ANSWER'); check('Вопрос решён — question-payment', true);
    edit('Дополнение — Оплата', 'Личный текст пока не выбран'); await preview();
    const publicPreview = nodes().find(node => node.props['aria-label'] === 'Предпросмотр документа')!;
    expect(text(control('Текст будущего файла'))).not.toContain('PRIVATE_UPDATED_ANSWER'); expect(text(control('Текст будущего файла'))).not.toContain('Личный текст пока не выбран');
    expect(text(publicPreview)).toContain('Некоторые блоки или дополнения исключены');
  });

  it('rejects invalid edits atomically and permits explicit selection of complete blocks/user text', async () => {
    start(); const before = control('Текст блока 1 — Состав работ').props.value;
    edit('Текст блока 1 — Состав работ', 'bad\u0000text'); expect(control('Текст блока 1 — Состав работ').props.value).toBe(before);
    expect(text()).toContain('Предыдущее значение сохранено');
    edit('Дополнение — Состав работ', 'Мой выбранный текст'); check('Включить дополнение — Состав работ', true); check('Включить блок 1 — Состав работ', false);
    await preview(); const publicPreview = control('Текст будущего файла');
    expect(text(publicPreview)).toContain('Мой выбранный текст'); expect(text(publicPreview)).not.toContain('SYNTHETIC_WHOLE_work-scope');
    expect(control('Текст блока 1 — Состав работ').props.value).toBe(before);
  });

  it('saves only its exact submitted immutable snapshot and validates the matching root/id/operation receipt', async () => {
    const changed = vi.fn(); start({ initialStorageToken: 'token-1', onChange: changed }); edit('Название КП', 'Моя редакция');
    const captured = serializeWorkingProposalDocument(changed.mock.lastCall![0]); click('Сохранить черновик'); await waitUntil(() => text().includes('Черновик сохранён.'));
    const request = vi.mocked(props.services.save).mock.calls[0][0];
    expect(request.expectedStorageToken).toBe('token-1'); expect(request.binding).toMatchObject({ sessionKey: 'session-1', workspaceRoot: 'synthetic-root', leaseGeneration: 'lease-1', taskKey: 'task-1', documentId: props.initialDocument.id, documentRevision: 1 });
    expect(request.binding.operationId).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u);
    expect(serializeWorkingProposalDocument(request.document)).toBe(captured); expect(Object.isFrozen(request.document.sections[0].blocks[0])).toBe(true);
    expect(text()).toContain('сохранённая редакция');
  });

  it('does not mark newer edits saved when an earlier Save completes and uses the returned CAS for the next Save', async () => {
    const first = deferred<Awaited<ReturnType<ProposalWorkingServices['save']>>>(); const api = services(); api.save = vi.fn(() => first.promise); start({ services: api });
    click('Сохранить черновик'); await waitUntil(() => vi.mocked(api.save).mock.calls.length === 1);
    const request = vi.mocked(api.save).mock.calls[0][0]; edit('Название КП', 'Новая правка во время записи');
    first.resolve({ binding: request.binding, storageToken: 'token-new', documentFingerprint: request.binding.documentFingerprint }); await waitUntil(() => text().includes('Сохранена предыдущая редакция'));
    expect(control('Название КП').props.value).toBe('Новая правка во время записи'); expect(text()).toContain('есть несохранённые изменения');
    api.save = vi.fn(async value => ({ binding: value.binding, storageToken: 'token-next', documentFingerprint: value.binding.documentFingerprint })); render(); click('Сохранить черновик');
    await waitUntil(() => text().includes('Черновик сохранён.')); expect(vi.mocked(api.save).mock.calls[0][0].expectedStorageToken).toBe('token-new');
  });

  it('rejects a foreign save receipt and suppresses rapid duplicate submissions without losing text', async () => {
    const api = services(); api.save = vi.fn(async request => ({ binding: { ...request.binding, workspaceRoot: 'foreign-root' }, storageToken: 'x', documentFingerprint: request.binding.documentFingerprint })); start({ services: api });
    const callback = button('Сохранить черновик').props.onClick!; callback(); callback(); render(); await waitUntil(() => text().includes('Ответ относится к другому документу'));
    expect(api.save).toHaveBeenCalledOnce(); expect(control('Название КП').props.value).toBe(props.initialDocument.title); expect(text()).toContain('есть несохранённые изменения');
  });

  it('lets a viewer edit a local copy and list summaries but blocks a captured editor-save callback after access changes', async () => {
    start(); const save = button('Сохранить черновик').props.onClick!;
    render({ ...props, context: { ...props.context, access: 'viewer', leaseGeneration: null } }); save(); edit('Дополнение — Оплата', 'Локальная правка просмотра');
    expect(button('Сохранить черновик').props.disabled).toBe(true); expect(props.services.save).not.toHaveBeenCalled();
    click('Сохранённые черновики'); await waitUntil(() => text().includes('Сохранённых черновиков пока нет'));
    expect(props.services.list).toHaveBeenCalledOnce(); expect(control('Дополнение — Оплата').props.value).toBe('Локальная правка просмотра');
  });

  it.each(['workspaceRoot', 'leaseGeneration', 'taskKey', 'sessionKey'] as const)('ignores a delayed save after %s changes', async key => {
    const pending = deferred<Awaited<ReturnType<ProposalWorkingServices['save']>>>(), api = services(); api.save = vi.fn(() => pending.promise); start({ services: api });
    click('Сохранить черновик'); await waitUntil(() => vi.mocked(api.save).mock.calls.length === 1); const request = vi.mocked(api.save).mock.calls[0][0];
    render(key === 'sessionKey' ? { ...props, sessionKey: 'another-session' } : { ...props, context: { ...props.context, [key]: 'changed' } });
    pending.resolve({ binding: request.binding, storageToken: 'stale', documentFingerprint: request.binding.documentFingerprint });
    for (let at = 0; at < 15; at++) { await tick(); render(); }
    expect(text()).not.toContain('Черновик сохранён.'); expect(text()).toContain('есть несохранённые изменения');
    expect(control('Название КП').props.value).toBe(props.initialDocument.title);
  });

  it('warns before close/open dirty loss and cancellation preserves exact current values', async () => {
    const api = services(), close = vi.fn(); api.list = vi.fn(async request => ({ binding: request.binding, summaries: [summary] })); start({ services: api, onClose: close });
    edit('Дополнение — Оплата', '  Несохранённый текст\n😀  '); click('Закрыть КП'); expect(text()).toContain('будут потеряны'); click('Остаться в черновике');
    expect(close).not.toHaveBeenCalled(); expect(control('Дополнение — Оплата').props.value).toBe('  Несохранённый текст\n😀  ');
    click('Сохранённые черновики'); await waitUntil(() => text().includes(summary.title)); click('Открыть'); click('Остаться в черновике'); expect(api.open).not.toHaveBeenCalled();
    click('Закрыть КП'); click('Закрыть без сохранения'); expect(close).toHaveBeenCalledOnce();
  });

  it('opens ordinary historical data without reusing approval and retains current form on corrupt data', async () => {
    const api = services(); api.list = vi.fn(async request => ({ binding: request.binding, summaries: [summary] })); start({ services: api, initialStorageToken: 'initial' });
    click('Сохранённые черновики'); await waitUntil(() => text().includes(summary.title)); click('Открыть');
    await waitUntil(() => text().includes('Открыт сохранённый рабочий черновик'));
    expect(control('Название КП').props.value).toBe(fixture(summary.id).title); expect(nodes().some(node => node.type === 'button' && text(node) === 'Скачать DOCX')).toBe(false);
    edit('Название КП', 'Оставить мою версию'); api.open = vi.fn(async request => ({ binding: request.binding, document: { schemaVersion: 999 }, storageToken: request.storageToken, documentFingerprint: 'bad' }));
    render(); click('Открыть'); click('Открыть без сохранения'); await waitUntil(() => text().includes('Неверная или неизвестная структура'));
    expect(control('Название КП').props.value).toBe('Оставить мою версию');
  });

  it('does not replace edits entered while an open request is pending', async () => {
    const api = services(), pending = deferred<Awaited<ReturnType<ProposalWorkingServices['open']>>>(); api.list = vi.fn(async request => ({ binding: request.binding, summaries: [summary] })); api.open = vi.fn(() => pending.promise); start({ services: api, initialStorageToken: 'initial' });
    click('Сохранённые черновики'); await waitUntil(() => text().includes(summary.title)); click('Открыть'); await waitUntil(() => vi.mocked(api.open).mock.calls.length === 1);
    const request = vi.mocked(api.open).mock.calls[0][0], loaded = fixture(summary.id); edit('Название КП', 'Правка пока читалась база');
    pending.resolve({ binding: request.binding, document: loaded, storageToken: summary.storageToken, documentFingerprint: await fingerprintWorkingProposal(loaded) });
    await waitUntil(() => text().includes('Пока черновик открывался')); expect(control('Название КП').props.value).toBe('Правка пока читалась база');
  });

  it('requires explicit review of shown selection before export, passes only allowlisted public DTO and invalidates on edit', async () => {
    start(); await approve(); click('Скачать DOCX'); await waitUntil(() => text().includes('Файл подготовлен: КП.docx'));
    const request = vi.mocked(props.services.export!).mock.calls[0][0], body = JSON.stringify(request.publicDocument);
    expect(request.publicDocument).toMatchObject({ schemaVersion: 3, mode: 'final' }); expect(body).not.toContain('PRIVATE_QUESTION_ANSWER'); expect(body).not.toContain('historicalSource'); expect(body).not.toContain('evidence');
    expect(request.publicDocument.metadata.currency).toBeNull(); expect(request.publicDocument.metadata.documentDate).toBeNull();
    edit('Название КП', 'Изменение после проверки'); expect(nodes().some(node => node.type === 'button' && text(node) === 'Скачать DOCX')).toBe(false);
    await preview(); expect(button('Скачать DOCX').props.disabled).toBe(true); expect(props.services.export).toHaveBeenCalledOnce();
  });

  it('attributes a delayed export to its old revision rather than the newer text', async () => {
    const api = services(), pending = deferred<Awaited<ReturnType<NonNullable<ProposalWorkingServices['export']>>>>(); api.export = vi.fn(() => pending.promise); start({ services: api }); await approve(); click('Скачать PDF');
    await waitUntil(() => vi.mocked(api.export!).mock.calls.length === 1); const request = vi.mocked(api.export!).mock.calls[0][0]; edit('Дополнение — Сроки', 'Новая редакция срока');
    pending.resolve({ binding: request.binding, format: request.format, clientProjectionFingerprint: request.clientProjectionFingerprint, fileName: 'old.pdf' }); await waitUntil(() => text().includes('файл предыдущей редакции'));
    expect(text()).toContain('Последние правки в него не вошли'); expect(control('Дополнение — Сроки').props.value).toBe('Новая редакция срока');
  });

  it('loads history lazily, verifies its hash and leaves editable text intact on missing/corrupt history', async () => {
    const api = services(); start({ services: api }); expect(api.history).not.toHaveBeenCalled(); click('Загрузить исходный контекст'); await waitUntil(() => text().includes('PRIVATE_HISTORICAL_SENTINEL'));
    expect(api.history).toHaveBeenCalledOnce(); expect(control('Текст блока 1 — Состав работ').props.value).not.toContain('PRIVATE_HISTORICAL');
    hooks.slots.forEach(slot => slot.cleanup?.()); hooks.slots = []; const bad = services(); bad.history = vi.fn(async request => ({ binding: request.binding, text: '{}' })); start({ services: bad });
    edit('Дополнение — Цена и НДС', 'Не терять мои условия'); click('Загрузить исходный контекст'); await waitUntil(() => text().includes('Частная история повреждена'));
    expect(control('Дополнение — Цена и НДС').props.value).toBe('Не терять мои условия');
  });

  it('keeps optional recovery ownership/CAS distinct from explicit Save and does not repeat unchanged autosaves', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); const api = services();
    api.autosave = vi.fn(async request => ({ binding: request.binding, autosaveOwnerId: request.autosaveOwnerId, autosaveToken: `recovery-${vi.mocked(api.autosave!).mock.calls.length}`, documentFingerprint: request.binding.documentFingerprint }));
    start({ services: api, initialStorageToken: 'record-token' }); edit('Дополнение — Оплата', 'Восстановить эту правку'); await vi.advanceTimersByTimeAsync(1500); render();
    await waitUntil(() => text().includes('Восстановительная копия обновлена'));
    expect(api.save).not.toHaveBeenCalled(); expect(text()).toContain('есть несохранённые изменения');
    const first = vi.mocked(api.autosave).mock.calls[0][0]; expect(first.expectedAutosaveToken).toBeNull(); expect(first.baseRecordStorageToken).toBe('record-token'); expect(first.autosaveOwnerId).toMatch(/^[a-f0-9-]{36}$/u);
    await vi.advanceTimersByTimeAsync(5000); render(); expect(api.autosave).toHaveBeenCalledOnce();
    edit('Дополнение — Оплата', 'Следующая правка'); await vi.advanceTimersByTimeAsync(1500); render(); await waitUntil(() => vi.mocked(api.autosave!).mock.calls.length === 2 && text().includes('Восстановительная копия обновлена'));
    expect(vi.mocked(api.autosave).mock.calls[1][0]).toMatchObject({ expectedAutosaveToken: 'recovery-1', baseRecordStorageToken: 'record-token', autosaveOwnerId: first.autosaveOwnerId });
  });

  it('does not let old close/approval callbacks bypass current dirty state or review a newer unseen document', async () => {
    const onClose = vi.fn(); start({ initialStorageToken: 'initial', onClose }); const oldClose = button('Закрыть КП').props.onClick!;
    await preview(); check('Я проверил текущий документ и нерешённые вопросы', true); const oldApprove = button('Подтвердить мою проверку').props.onClick!;
    edit('Название КП', 'Новая непроверенная редакция'); oldClose(); render(); expect(text()).toContain('Есть несохранённые изменения'); expect(onClose).not.toHaveBeenCalled();
    click('Остаться в черновике'); oldApprove(); render(); for (let at = 0; at < 8; at++) { await tick(); render(); }
    await preview(); expect(button('Скачать DOCX').props.disabled).toBe(true); expect(props.services.export).not.toHaveBeenCalled();
  });

  it('advances the recovery CAS from an exact atomic Save receipt before the next autosave', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); const api = services();
    api.autosave = vi.fn(async request => ({ binding: request.binding, autosaveOwnerId: request.autosaveOwnerId, autosaveToken: 'recovery-before-save', documentFingerprint: request.binding.documentFingerprint }));
    api.save = vi.fn(async request => ({ binding: request.binding, storageToken: 'saved-after-recovery', documentFingerprint: request.binding.documentFingerprint,
      consumedAutosave: { previousToken: 'recovery-before-save', nextToken: 'consumed-tombstone' } }));
    start({ services: api }); edit('Дополнение — Оплата', 'Правка до сохранения'); await vi.advanceTimersByTimeAsync(1500); render(); await waitUntil(() => text().includes('Восстановительная копия обновлена'));
    click('Сохранить черновик'); await waitUntil(() => text().includes('Черновик сохранён.'));
    edit('Дополнение — Оплата', 'Правка после сохранения'); await vi.advanceTimersByTimeAsync(1500); render(); await waitUntil(() => vi.mocked(api.autosave!).mock.calls.length === 2);
    expect(vi.mocked(api.autosave!).mock.calls[1][0]).toMatchObject({ expectedAutosaveToken: 'consumed-tombstone', baseRecordStorageToken: 'saved-after-recovery' });
  });

  it('does not label the form saved if an atomic-save recovery receipt names another recovery snapshot', async () => {
    const api = services(); api.save = vi.fn(async request => ({ binding: request.binding, storageToken: 'saved-token', documentFingerprint: request.binding.documentFingerprint,
      consumedAutosave: { previousToken: 'foreign-recovery', nextToken: 'foreign-next' } }));
    start({ services: api }); edit('Дополнение — Оплата', 'Не потерять ввод'); click('Сохранить черновик'); await waitUntil(() => text().includes('восстановительная копия не подтверждена'));
    expect(text()).toContain('есть несохранённые изменения'); expect(control('Дополнение — Оплата').props.value).toBe('Не потерять ввод'); expect(text()).not.toContain('Черновик сохранён.');
  });

  it('resumes only a consumed recovery CAS and does not overwrite a protected unconsumed recovery', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); const api = services();
    api.autosave = vi.fn(async request => ({ binding: request.binding, autosaveOwnerId: request.autosaveOwnerId, autosaveToken: 'next-recovery', documentFingerprint: request.binding.documentFingerprint }));
    start({ services: api, initialStorageToken: 'saved', initialRecovery: { ownerId: 'prior-storage-owner', storageToken: 'consumed-cas' } });
    edit('Дополнение — Оплата', 'После повторного открытия'); await vi.advanceTimersByTimeAsync(1500); render(); await waitUntil(() => vi.mocked(api.autosave!).mock.calls.length === 1);
    expect(vi.mocked(api.autosave!).mock.calls[0][0]).toMatchObject({ autosaveOwnerId: 'prior-storage-owner', expectedAutosaveToken: 'consumed-cas', baseRecordStorageToken: 'saved' });
    hooks.slots.forEach(slot => slot.cleanup?.()); hooks.slots = []; vi.mocked(api.autosave).mockClear();
    start({ services: api, initialStorageToken: 'saved', initialRecovery: 'protected' }); edit('Дополнение — Оплата', 'Не затереть отдельную копию');
    await vi.advanceTimersByTimeAsync(10000); render(); expect(api.autosave).not.toHaveBeenCalled(); expect(text()).toContain('не перезаписывается автоматически');
    click('Сохранить черновик'); await waitUntil(() => vi.mocked(api.save).mock.calls.length === 1); expect(control('Дополнение — Оплата').props.value).toBe('Не затереть отдельную копию');
  });

  it('changes whole-block order only explicitly and keeps every full block and stable ID for the preview', async () => {
    const document = fixture(); document.sections[0].blocks.push({ ...document.sections[0].blocks[0], id: 'second-block', frameId: 'work-scope:block-2', frameIndex: 1, text: 'SECOND_WHOLE_TEXT' });
    start({ initialDocument: document }); control('Переместить блок 2 выше — Состав работ').props.onClick!(); render();
    expect(control('Текст блока 1 — Состав работ').props.value).toBe('SECOND_WHOLE_TEXT'); expect(control('Текст блока 2 — Состав работ').props.value).toBe(document.sections[0].blocks[0].text);
    expect(nodes().filter(node => node.props['data-block-id']).map(node => node.props['data-block-id']).slice(0, 2)).toEqual(['second-block', document.sections[0].blocks[0].id]);
    await preview(); const body = text(control('Текст будущего файла')); expect(body.indexOf('SECOND_WHOLE_TEXT')).toBeLessThan(body.indexOf('SYNTHETIC_WHOLE_work-scope'));
  });

  it('retains an old-root form but disables new operations rather than saving it into a newly selected root', () => {
    start(); edit('Дополнение — Оплата', 'Не переносить в другую папку молча'); render({ ...props, context: { ...props.context, workspaceRoot: 'new-root' } });
    expect(button('Сохранить черновик').props.disabled).toBe(true); expect(text()).toContain('операции старого сеанса отключены');
    button('Сохранить черновик').props.onClick!(); expect(props.services.save).not.toHaveBeenCalled(); expect(control('Дополнение — Оплата').props.value).toBe('Не переносить в другую папку молча');
  });

  it('keeps an empty selection reviewable as a draft but will not confirm it as a final document', async () => {
    start(); titles.forEach(title => check(`Включить блок 1 — ${title}`, false)); await preview();
    expect(text(control('Текст будущего файла'))).toContain('Текст не выбран'); expect(text()).toContain('Не войдёт в файл · Состав работ');
    check('Я проверил текущий документ и нерешённые вопросы', true); click('Подтвердить мою проверку'); await waitUntil(() => text().includes('Для итогового документа выберите или введите текст'));
    expect(button('Скачать DOCX').props.disabled).toBe(true);
  });

  it('cancelled waiting cannot announce a late save or clear the busy status of a newer operation', async () => {
    const api = services(), pending = deferred<Awaited<ReturnType<ProposalWorkingServices['save']>>>(); api.save = vi.fn(() => pending.promise); start({ services: api });
    click('Сохранить черновик'); await waitUntil(() => vi.mocked(api.save).mock.calls.length === 1); const submitted = vi.mocked(api.save).mock.calls[0][0]; click('Остановить ожидание');
    const newer = deferred<Awaited<ReturnType<ProposalWorkingServices['list']>>>(); api.list = vi.fn(() => newer.promise); render(); click('Сохранённые черновики'); await waitUntil(() => vi.mocked(api.list).mock.calls.length === 1);
    pending.resolve({ binding: submitted.binding, storageToken: 'old-save', documentFingerprint: submitted.binding.documentFingerprint });
    for (let at = 0; at < 8; at++) { await tick(); render(); } expect(text()).toContain('Загружаем список…'); expect(text()).not.toContain('Черновик сохранён.');
    const listed = vi.mocked(api.list).mock.calls[0][0]; newer.resolve({ binding: listed.binding, summaries: [] }); await waitUntil(() => text().includes('Сохранённых черновиков пока нет'));
  });

  it('failed recovery is not retried in a tight unchanged-document loop and does not masquerade as explicit Save', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); const api = services(); api.autosave = vi.fn(async () => { throw new Error('Нет связи с общей папкой'); }); start({ services: api });
    edit('Дополнение — Оплата', 'Не терять локальный текст'); await vi.advanceTimersByTimeAsync(1500); render(); await waitUntil(() => text().includes('Нет связи с общей папкой'));
    await vi.advanceTimersByTimeAsync(10000); render(); expect(api.autosave).toHaveBeenCalledOnce(); expect(api.save).not.toHaveBeenCalled();
    expect(text()).toContain('есть несохранённые изменения'); expect(control('Дополнение — Оплата').props.value).toBe('Не терять локальный текст');
  });
});
