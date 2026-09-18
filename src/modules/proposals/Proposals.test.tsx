import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Proposals } from './Proposals';
import { VersionHistory } from '../../components/VersionHistory';
import { createProposal } from './defaults';
import { buildProposalPublic, proposalExportAssets } from './exportPublic';
import type { ProposalData, ProposalRenderResult, ProposalTemplateData } from './types';
import type { StoredRecord } from '../../lib/storage';

// Real component callbacks/effects with persistent hook slots. DOM layout and
// child components are covered separately; storage and native rendering are boundaries.
const runtime = vi.hoisted(() => ({ cursor: 0, changed: false, slots: [] as Array<{ value?: unknown; deps?: readonly unknown[]; cleanup?: () => void }>, effects: [] as Array<() => void>, editor: true,
  store: { records: [] as StoredRecord<ProposalData | ProposalTemplateData>[], loading: false, error: null as string | null, save: vi.fn(), reload: vi.fn() },
  readDraft: vi.fn(), saveDraft: vi.fn(), clearDraft: vi.fn(), copyAttachment: vi.fn(), getWorkspace: vi.fn(), chooseSave: vi.fn(), chooseOpen: vi.fn(), invoke: vi.fn(),
}));
vi.mock('react', async (original) => {
  const same = (left?: readonly unknown[], right?: readonly unknown[]) => left !== undefined && right !== undefined && left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
  const memo = (factory: () => unknown, deps?: readonly unknown[]) => { const index = runtime.cursor++; const previous = runtime.slots[index]; if (!previous || !same(previous.deps, deps)) runtime.slots[index] = { value: factory(), deps }; return runtime.slots[index].value; };
  return { ...await original<typeof import('react')>(),
    useState: (initial: unknown) => { const index = runtime.cursor++; if (!runtime.slots[index]) runtime.slots[index] = { value: typeof initial === 'function' ? initial() : initial }; return [runtime.slots[index].value, (next: unknown) => { const value = typeof next === 'function' ? next(runtime.slots[index].value) : next; if (!Object.is(value, runtime.slots[index].value)) { runtime.slots[index].value = value; runtime.changed = true; } }]; },
    useRef: (initial: unknown) => { const index = runtime.cursor++; if (!runtime.slots[index]) runtime.slots[index] = { value: { current: initial } }; return runtime.slots[index].value; },
    useMemo: memo, useCallback: (callback: unknown, deps?: readonly unknown[]) => memo(() => callback, deps),
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => { const index = runtime.cursor++; const previous = runtime.slots[index]; if (previous && same(previous.deps, deps)) return; runtime.slots[index] = { ...previous, deps }; runtime.effects.push(() => { previous?.cleanup?.(); const cleanup = effect(); runtime.slots[index].cleanup = typeof cleanup === 'function' ? cleanup : undefined; }); },
  };
});
vi.mock('../../hooks/useRecords', () => ({ useRecords: () => runtime.store }));
vi.mock('../../lib/workspaceAccess', () => ({ useWorkspaceAccess: () => ({ editor: runtime.editor, message: 'Тестовый доступ' }) }));
vi.mock('../../lib/storage', () => ({ readDraft: runtime.readDraft, saveDraft: runtime.saveDraft, clearDraft: runtime.clearDraft, copyAttachment: runtime.copyAttachment, getWorkspaceInfo: runtime.getWorkspace }));
vi.mock('../../lib/files', () => ({ chooseSavePath: runtime.chooseSave, chooseOpenPath: runtime.chooseOpen }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: runtime.invoke, convertFileSrc: (path: string) => `asset://${path}` }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openPath: vi.fn().mockResolvedValue(undefined) }));

type ComponentProps = Parameters<typeof Proposals>[0];
type NodeProps = { children?: ReactNode; onClick?: () => unknown; onChange?: (event: { target: { value: string; checked?: boolean } }) => unknown; onRestore?: (value: unknown) => Promise<void>; value?: unknown; disabled?: boolean; id?: string; title?: string; type?: string; 'aria-label'?: string; src?: string; alt?: string };
let tree: ReactNode;
let props: ComponentProps;
function render(next = props) { props = next; runtime.cursor = 0; runtime.changed = false; tree = Proposals(props); for (const effect of runtime.effects.splice(0)) effect(); }
async function flush() { for (let turn = 0; turn < 30; turn += 1) { await Promise.resolve(); if (runtime.changed) render(); } }
function nodes(node: ReactNode = tree): ReactElement<NodeProps>[] { if (Array.isArray(node)) return node.flatMap((child) => nodes(child ?? null)); if (!isValidElement<NodeProps>(node)) return []; return [node, ...nodes(node.props.children ?? null)]; }
function text(node: ReactNode = tree): string { if (Array.isArray(node)) return node.map((child) => text(child ?? null)).join(''); if (isValidElement<NodeProps>(node)) return text(node.props.children ?? null); return typeof node === 'string' || typeof node === 'number' ? String(node) : ''; }
function button(label: string) { const found = nodes().find((node) => node.type === 'button' && text(node.props.children) === label); if (!found) throw new Error(`Button not found: ${label}`); return found; }
function input(id: string) { const found = nodes().find((node) => node.type === 'input' && node.props.id === id); if (!found) throw new Error(`Input not found: ${id}`); return found; }
const click = async (label: string) => { button(label).props.onClick!(); await flush(); };
const edit = async (id: string, value: string) => { input(id).props.onChange!({ target: { value } }); await flush(); };
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function proposal(title = 'Тестовое предложение'): ProposalData {
  const data = createProposal(); data.title = title; data.issuer.name = 'Исполнитель'; data.recipient.name = 'Заказчик'; data.lines[0].title = 'Услуга'; data.lines[0].unitPrice = '1000';
  data.internalNote = 'СЕКРЕТ: внутренняя себестоимость'; data.source = { tool: 'calculator', recordId: 'private-source', capturedAt: '2026-09-18', wasUnsaved: false, priceOrigin: 'цена' };
  return data;
}
const record = (id: string, data: ProposalData): StoredRecord<ProposalData> => ({ id, title: data.title, payload: structuredClone(data), archived: false, createdAt: '2026-09-18', updatedAt: '2026-09-18' });
const result: ProposalRenderResult = { outputPath: '/tmp/proposal.pdf', outputBytes: 1234, sha256: 'a'.repeat(64), pageCount: 1, previewPages: ['/tmp/proposal-page-1.png'] };
async function seed(data = proposal()) { render({ handoff: { id: `handoff-${data.familyId}`, data } }); await flush(); }
const renderCalls = () => runtime.invoke.mock.calls.filter(([command]) => command === 'proposal_render');

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-18T12:00:00Z'));
  runtime.cursor = 0; runtime.changed = false; runtime.slots = []; runtime.effects = []; runtime.editor = true; props = {};
  runtime.store.records = []; runtime.store.loading = false; runtime.store.error = null;
  for (const mock of [runtime.store.save, runtime.store.reload, runtime.readDraft, runtime.saveDraft, runtime.clearDraft, runtime.copyAttachment, runtime.getWorkspace, runtime.chooseSave, runtime.chooseOpen, runtime.invoke]) mock.mockReset();
  runtime.readDraft.mockResolvedValue(null); runtime.saveDraft.mockResolvedValue(undefined); runtime.clearDraft.mockResolvedValue(undefined);
  runtime.chooseSave.mockResolvedValue('/tmp/proposal.docx'); runtime.chooseOpen.mockResolvedValue(null);
  runtime.getWorkspace.mockResolvedValue({ root: '/tmp/qa-workspace', editor: true });
  runtime.copyAttachment.mockImplementation(async (path: string, _module: string, owner: string) => ({ relativePath: `attachment-staging/commercial-proposals/${owner}/${path.split('/').pop()}`, fileName: path.split('/').pop()!, sizeBytes: 100, sha256: 'a'.repeat(64), mimeType: path.endsWith('.png') ? 'image/png' : 'application/pdf' }));
  runtime.invoke.mockImplementation(async (command: string) => command === 'proposal_render' ? result : command === 'read_binary_file' ? 'data:image/png;base64,TEST-PREVIEW' : undefined);
  runtime.store.save.mockImplementation(async (_title: string, data: ProposalData, id?: string) => record(id || 'created-record', data));
  vi.stubGlobal('window', { __TAURI_INTERNALS__: {}, addEventListener: vi.fn(), removeEventListener: vi.fn() });
});
afterEach(() => { runtime.slots.forEach((slot) => slot.cleanup?.()); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('proposal saving and viewer workflow', () => {
  it('restores an unfinished new draft on initial entry without overwriting its fields', async () => {
    const draft = proposal('Восстановленный черновик');
    runtime.readDraft.mockImplementation(async (module: string, key: string) => module === 'commercial-proposals' && key === 'proposal:new' ? draft : null);
    render(); await flush();
    expect(input('proposal-title').props.value).toBe(draft.title); expect(text()).toContain('Незавершённое новое КП восстановлено из черновика'); expect(runtime.store.save).not.toHaveBeenCalled();
    await click('Сохранить КП'); expect(runtime.store.save.mock.calls[0][1].familyId).toBe(draft.familyId);
  });
  it('protects an existing stored new draft when a calculator handoff arrives', async () => {
    const old = proposal('Незавершённое старое КП'); const incoming = proposal('Новый расчёт');
    runtime.readDraft.mockImplementation(async (module: string, key: string) => module === 'commercial-proposals' && key === 'proposal:new' ? old : null);
    await seed(incoming);
    expect(input('proposal-title').props.value).toBe(old.title); expect(nodes().some((node) => node.props.title === 'Есть несохранённые изменения КП')).toBe(true);
    expect(runtime.clearDraft).not.toHaveBeenCalled(); expect(runtime.store.save).not.toHaveBeenCalled(); await click('Отмена');
    expect(input('proposal-title').props.value).toBe(old.title); expect(runtime.clearDraft).not.toHaveBeenCalled();
  });
  it('blocks malformed stored drafts without silently saving a fresh replacement', async () => {
    runtime.readDraft.mockImplementation(async (module: string, key: string) => module === 'commercial-proposals' && key === 'proposal:new' ? { kind: 'proposal', schemaVersion: 1, familyId: 'bad' } : null);
    render(); await flush(); expect(text()).toContain('Черновик повреждён'); await click('Новое КП'); await vi.advanceTimersByTimeAsync(1000); await flush();
    expect(text()).toContain('Запись поверх него остановлена'); expect(runtime.saveDraft).not.toHaveBeenCalled(); expect(runtime.store.save).not.toHaveBeenCalled(); expect(runtime.clearDraft).not.toHaveBeenCalled();
  });
  it('saves a draft once and subsequently updates the stable record ID', async () => {
    await seed(); await click('Сохранить КП');
    const writeId = runtime.store.save.mock.calls[0][2]; expect(writeId).toEqual(expect.any(String)); expect(writeId).not.toBe(runtime.store.save.mock.calls[0][1].familyId); expect(button('Сохранить КП').props.disabled).toBe(true);
    await edit('proposal-title', 'Уточнённый предмет'); await click('Сохранить КП');
    expect(runtime.store.save.mock.calls[1][2]).toBe(writeId); expect(runtime.store.save.mock.calls[1][1].title).toBe('Уточнённый предмет');
    expect(runtime.clearDraft).toHaveBeenCalledWith('commercial-proposals', `proposal:${writeId}`);
  });
  it('uses backend-promoted attachment and logo paths when exporting immediately after save', async () => {
    const data = proposal();
    const asset = { relativePath: 'attachment-staging/commercial-proposals/session/new.pdf', fileName: 'new.pdf', sizeBytes: 100, sha256: 'a'.repeat(64), mimeType: 'application/pdf' };
    data.attachments = [asset];
    runtime.store.save.mockImplementationOnce(async (_title: string, value: ProposalData) => {
      const saved = structuredClone(value);
      saved.attachments[0].relativePath = 'attachments/commercial-proposals/created-record/new.pdf';
      return record('created-record', saved);
    });
    await seed(data); await click('Сохранить КП'); await click('5. Проверка и экспорт'); await click('Скачать PDF');
    expect(renderCalls()).toHaveLength(1);
    expect(renderCalls()[0][1].assets[0].relativePath).toBe('attachments/commercial-proposals/created-record/new.pdf');
    expect(button('Сохранить КП').props.disabled).toBe(true);
    expect(data.attachments[0].relativePath).toContain('attachment-staging/');
  });
  it('prevents duplicate writes and retains edited inputs after a failed save, then permits retry', async () => {
    const pending = deferred<StoredRecord<ProposalData>>(); runtime.store.save.mockImplementationOnce(() => pending.promise);
    await seed(); await edit('proposal-title', 'Не потерять это поле'); const save = button('Сохранить КП'); save.props.onClick!(); save.props.onClick!(); await flush();
    expect(runtime.store.save).toHaveBeenCalledOnce(); expect(input('proposal-title').props.disabled).toBe(true);
    pending.reject(new Error('Сетевая папка недоступна')); await flush();
    expect(input('proposal-title').props.value).toBe('Не потерять это поле'); expect(text()).toContain('Введённые данные остаются в форме'); expect(runtime.clearDraft).not.toHaveBeenCalled();
    await click('Сохранить КП'); expect(runtime.store.save).toHaveBeenCalledTimes(2); expect(runtime.store.save.mock.calls[1][1].title).toBe('Не потерять это поле');
  });
  it('keeps the successful record ID even if clearing its old draft fails', async () => {
    runtime.clearDraft.mockRejectedValueOnce(new Error('Не удалось очистить черновик')); await seed(); await click('Сохранить КП');
    expect(text()).toContain('Карточка сохранена, но старый черновик не очищен');
    const writeId = runtime.store.save.mock.calls[0][2];
    await edit('proposal-title', 'Следующая правка'); await click('Сохранить КП'); expect(runtime.store.save.mock.calls[1][2]).toBe(writeId);
  });
  it('does not let an earlier autosave failure permanently block explicit saving', async () => {
    runtime.saveDraft.mockRejectedValueOnce(new Error('Временная ошибка черновика')); await seed(); await vi.advanceTimersByTimeAsync(600); await flush();
    expect(text()).toContain('Черновик не сохранён'); await click('Сохранить КП');
    expect(runtime.store.save).toHaveBeenCalledOnce(); expect(text()).toContain('Все изменения сохранены в общей базе');
  });
  it('viewer handoff is editable locally but never writes a draft or a record', async () => {
    runtime.editor = false; const data = proposal(); await seed(data); await edit('proposal-title', 'Локальная правка'); await vi.advanceTimersByTimeAsync(2000); await flush();
    expect(input('proposal-title').props.value).toBe('Локальная правка'); expect(input('proposal-title').props.disabled).toBe(false);
    expect(text()).toContain('Локальная копия · не сохраняется в общую базу'); expect(nodes().some((node) => node.type === 'button' && text(node.props.children) === 'Сохранить КП')).toBe(false);
    expect(runtime.saveDraft).not.toHaveBeenCalled(); expect(runtime.store.save).not.toHaveBeenCalled(); expect(runtime.clearDraft).not.toHaveBeenCalled(); expect(data.title).toBe('Тестовое предложение');
  });
  it('viewer opening a persisted record can read/export but must make a local copy to edit', async () => {
    runtime.editor = false; runtime.store.records = [record('saved', proposal())]; render({ openRecordId: 'saved' }); await flush();
    expect(input('proposal-title').props.disabled).toBe(true); expect(button('Сохранить КП').props.disabled).toBe(true);
    await click('Локальная копия'); expect(input('proposal-title').props.disabled).toBe(false); await edit('proposal-title', 'Локальная'); await vi.advanceTimersByTimeAsync(1000); await flush();
    expect(runtime.store.save).not.toHaveBeenCalled(); expect(runtime.saveDraft).not.toHaveBeenCalled();
  });
  it('viewer local proposal can export existing assets without enabling uploads or database writes', async () => {
    runtime.editor = false; await seed(); await click('5. Проверка и экспорт');
    expect(button('Добавить приложение').props.disabled).toBe(true); await click('Скачать PDF');
    expect(renderCalls()).toHaveLength(1); expect(renderCalls()[0][1].format).toBe('pdf');
    expect(runtime.copyAttachment).not.toHaveBeenCalled(); expect(runtime.store.save).not.toHaveBeenCalled(); expect(runtime.saveDraft).not.toHaveBeenCalled();
  });
  it('does not save from a stale click handler after editor access has been revoked', async () => {
    await seed(); const staleSave = button('Сохранить КП').props.onClick!;
    runtime.editor = false; render(); await flush(); staleSave(); await flush();
    expect(runtime.store.save).not.toHaveBeenCalled(); expect(text()).toContain('Сохранение общей карточки сейчас недоступно');
  });
  it('ready records are immutable; a new revision saves as a separate record with the same family', async () => {
    const data = proposal(); data.status = 'ready'; data.revision = 2;
    const later = { ...structuredClone(data), revision: 4 }; runtime.store.records = [record('ready', data), record('later', later)]; render({ openRecordId: 'ready' }); await flush();
    expect(input('proposal-title').props.disabled).toBe(true); expect(text()).toContain('Сохранённая редакция защищена от изменения');
    await click('Новая редакция'); expect(input('proposal-title').props.disabled).toBe(false); await click('Сохранить КП');
    expect(runtime.store.save.mock.calls[0][2]).toEqual(expect.any(String)); expect(runtime.store.save.mock.calls[0][2]).not.toBe('ready'); expect(runtime.store.save.mock.calls[0][2]).not.toBe(data.familyId); expect(runtime.store.save.mock.calls[0][1]).toMatchObject({ familyId: data.familyId, revision: 5, status: 'draft' });
    expect(runtime.store.records[0].payload).toEqual(data);
  });
  it('copying a ready record creates a new family without overwriting the source', async () => {
    const data = proposal(); data.status = 'ready'; runtime.store.records = [record('ready', data)]; render({ openRecordId: 'ready' }); await flush();
    await click('Создать копию'); await click('Сохранить КП');
    expect(runtime.store.save.mock.calls[0][2]).toEqual(expect.any(String)); expect(runtime.store.save.mock.calls[0][2]).not.toBe('ready'); expect(runtime.store.save.mock.calls[0][2]).not.toBe(runtime.store.save.mock.calls[0][1].familyId); expect(runtime.store.save.mock.calls[0][1].familyId).not.toBe(data.familyId); expect(runtime.store.save.mock.calls[0][1].revision).toBe(1);
    expect(runtime.store.records[0].payload).toEqual(data);
  });
  it('history restore creates a higher draft revision instead of overwriting an immutable record', async () => {
    const current = proposal(); current.status = 'sent'; current.revision = 3; const historical = { ...structuredClone(current), title: 'Предыдущий текст', revision: 1 };
    runtime.store.records = [record('sent', current)]; render({ openRecordId: 'sent' }); await flush();
    await nodes().find((node) => node.type === VersionHistory)!.props.onRestore!(historical); await flush();
    expect(runtime.store.save).toHaveBeenCalledExactlyOnceWith(expect.any(String), expect.objectContaining({ title: 'Предыдущий текст', familyId: current.familyId, revision: 4, status: 'draft' }));
    expect(runtime.store.records[0].payload).toEqual(current); expect(input('proposal-title').props.value).toBe(current.title);
  });
  it('history restore rejects a different proposal family and viewer writes', async () => {
    const current = proposal(); current.status = 'ready'; runtime.store.records = [record('ready', current)]; render({ openRecordId: 'ready' }); await flush();
    let restore = nodes().find((node) => node.type === VersionHistory)!.props.onRestore!;
    await expect(restore(proposal('Другая семья'))).rejects.toThrow('Снимок не относится к этому КП');
    runtime.editor = false; render(); await flush(); restore = nodes().find((node) => node.type === VersionHistory)!.props.onRestore!;
    await expect(restore(current)).rejects.toThrow('восстановление доступно редактору'); expect(runtime.store.save).not.toHaveBeenCalled();
  });
  it('saves only reusable public layout and terms in a template, never parties/prices/signers/internal data', async () => {
    const data = proposal(); data.deliveryTerms = '10 дней'; data.paymentTerms = 'Предоплата'; data.introduction = 'Здравствуйте'; data.signer = { fullName: 'Подписант', position: '', phone: '', email: '', basis: '', issuedAt: '', expiresAt: '' };
    await seed(data); await click('4. Оформление'); await click('Сохранить как шаблон'); await click('Сохранить шаблон');
    expect(runtime.store.save).toHaveBeenCalledOnce(); const saved = runtime.store.save.mock.calls[0][1];
    expect(saved).toMatchObject({ kind: 'template', deliveryTerms: data.deliveryTerms, paymentTerms: data.paymentTerms, introduction: data.introduction, show: data.template.show });
    for (const key of ['issuer', 'recipient', 'lines', 'source', 'internalNote', 'signer', 'attachments', 'contact', 'addressee']) expect(saved).not.toHaveProperty(key);
    expect(runtime.store.save.mock.calls[0][2]).toBe(saved.id);
  });
});

describe('proposal native rendering boundary and cancellation', () => {
  it('requires explicit zero-price consent and clears it after changing the document', async () => {
    const data = proposal(); data.lines[0].unitPrice = '0'; await seed(data); await click('5. Проверка и экспорт');
    expect(button('Скачать PDF').props.disabled).toBe(true); await click('Скачать PDF'); expect(renderCalls()).toHaveLength(0); expect(text()).toContain('Подтвердите экспорт КП с нулевой стоимостью');
    const label = nodes().find((node) => node.type === 'label' && text(node.props.children).includes('Подтверждаю предложение с нулевой итоговой ценой'))!;
    nodes(label).find((node) => node.type === 'input')!.props.onChange!({ target: { value: '', checked: true } }); await flush();
    expect(button('Скачать PDF').props.disabled).toBe(false); await click('Скачать PDF'); expect(renderCalls()).toHaveLength(1);
    await click('1. Стороны'); await edit('proposal-title', 'Изменённый нулевой расчёт'); await click('5. Проверка и экспорт'); expect(button('Скачать PDF').props.disabled).toBe(true);
  });
  it('sends only the public document plus separate asset transport metadata', async () => {
    const data = proposal(); data.attachments = [{ relativePath: 'attachments/commercial-proposals/one/file.pdf', fileName: 'file.pdf', sizeBytes: 100, sha256: 'b'.repeat(64), mimeType: 'application/pdf' }]; data.issuer.companyId = 'private-company'; data.issuer.sourceUpdatedAt = 'private-date';
    await seed(data); await click('5. Проверка и экспорт'); await click('Скачать DOCX');
    expect(renderCalls()).toHaveLength(1); expect(renderCalls()[0][1]).toEqual({ jobId: expect.any(String), document: buildProposalPublic(data), assets: proposalExportAssets(data), format: 'docx', outputPath: '/tmp/proposal.docx' });
    const document = JSON.stringify(renderCalls()[0][1].document);
    for (const privateValue of ['internalNote', 'СЕКРЕТ', 'private-source', 'private-company', 'private-date', 'relativePath']) expect(document).not.toContain(privateValue);
    expect(renderCalls()[0][1].assets[0].relativePath).toBe(data.attachments[0].relativePath);
  });
  it('does not invoke rendering when the save dialog is cancelled', async () => {
    runtime.chooseSave.mockResolvedValue(null); await seed(); await click('5. Проверка и экспорт'); await click('Скачать PDF');
    expect(renderCalls()).toHaveLength(0); expect(text()).not.toContain('Создан файл:'); expect(button('Скачать PDF').props.disabled).toBe(false);
  });
  it('cancelled preview cannot install late PDF pages or announce success', async () => {
    const pending = deferred<ProposalRenderResult>(); runtime.invoke.mockImplementation((command: string) => command === 'proposal_render' ? pending.promise : Promise.resolve(undefined));
    await seed(); await click('5. Проверка и экспорт'); await click('Предпросмотр PDF'); const job = renderCalls()[0][1].jobId;
    await click('Отменить создание'); expect(runtime.invoke).toHaveBeenCalledWith('scanner_cancel', { jobId: job });
    pending.resolve(result); await flush(); expect(nodes().filter((node) => node.type === 'img')).toHaveLength(0); expect(text()).toContain('Создание документа отменено'); expect(text()).not.toContain('PDF · страниц');
  });
  it('a handoff received during rendering is not silently consumed or lost', async () => {
    const pending = deferred<ProposalRenderResult>(); runtime.invoke.mockImplementation((command: string) => command === 'proposal_render' ? pending.promise : Promise.resolve(undefined));
    await seed(); await click('5. Проверка и экспорт'); await click('Предпросмотр PDF');
    const next = proposal('Второй источник'); const consumed = vi.fn(); render({ handoff: { id: 'new-source', data: next }, onHandoffConsumed: consumed }); await flush();
    await click('Отменить создание'); pending.resolve(result); await flush();
    // The existing dirty proposal requires an explicit decision before replacement.
    expect(nodes().some((node) => node.props.title === 'Есть несохранённые изменения КП')).toBe(true); await click('Заменить без сохранения');
    expect(input('proposal-title').props.value).toBe('Второй источник'); expect(consumed).toHaveBeenCalledOnce(); expect(nodes().filter((node) => node.type === 'img')).toHaveLength(0);
  });
  it('successfully previewed pages are cleared when switching to a new target', async () => {
    await seed(); await click('5. Проверка и экспорт'); await click('Предпросмотр PDF'); expect(nodes().filter((node) => node.type === 'img')).toHaveLength(1);
    await click('Новое КП'); await click('Заменить без сохранения'); await click('5. Проверка и экспорт'); expect(nodes().filter((node) => node.type === 'img')).toHaveLength(0);
  });
  it('loads only the current preview page and opens the PDF via the restricted native command', async () => {
    runtime.invoke.mockImplementation(async (command: string, args: { path?: string }) => command === 'proposal_render' ? { ...result, pageCount: 2, previewPages: ['/tmp/page-1.png', '/tmp/page-2.png'] } : command === 'read_binary_file' ? `data:image/png;base64,${args.path}` : undefined);
    await seed(); await click('5. Проверка и экспорт'); await click('Предпросмотр PDF');
    expect(runtime.invoke.mock.calls.filter(([command]) => command === 'read_binary_file')).toEqual([['read_binary_file', { path: '/tmp/page-1.png', maxBytes: 24 * 1024 * 1024 }]]);
    await click('Следующая'); expect(nodes().find((node) => node.type === 'img')?.props.src).toContain('/tmp/page-2.png'); expect(button('Следующая').props.disabled).toBe(true);
    await click('Открыть PDF'); expect(runtime.invoke).toHaveBeenCalledWith('proposal_open_output', { path: result.outputPath, reveal: false });
  });
  it('ignores a late preview image read after moving to a new proposal', async () => {
    const page = deferred<string>(); runtime.invoke.mockImplementation((command: string) => command === 'proposal_render' ? Promise.resolve(result) : command === 'read_binary_file' ? page.promise : Promise.resolve(undefined));
    await seed(); await click('5. Проверка и экспорт'); await click('Предпросмотр PDF'); expect(text()).toContain('Загружаем страницу PDF');
    await click('Новое КП'); await click('Заменить без сохранения'); page.resolve('data:image/png;base64,OLD'); await flush(); await click('5. Проверка и экспорт');
    expect(nodes().filter((node) => node.type === 'img')).toHaveLength(0); expect(runtime.invoke).toHaveBeenCalledWith('proposal_cleanup_preview', { outputPath: result.outputPath });
  });
});

describe('proposal attachment ownership and durable draft identity', () => {
  it('restages attachments and logo under the new write ID when copying an unsaved proposal without saving the original', async () => {
    await seed(); runtime.chooseOpen.mockResolvedValueOnce('/tmp/contract.pdf'); await click('5. Проверка и экспорт'); await click('Добавить приложение');
    runtime.chooseOpen.mockResolvedValueOnce('/tmp/logo.png'); await click('4. Оформление'); await click('Добавить логотип');
    const originalWriteId = runtime.copyAttachment.mock.calls[0][2];
    await click('Создать копию'); await click('Заменить без сохранения');
    expect(runtime.copyAttachment).toHaveBeenCalledTimes(4);
    const copyWriteId = runtime.copyAttachment.mock.calls[2][2]; expect(copyWriteId).not.toBe(originalWriteId);
    expect(runtime.copyAttachment.mock.calls[2]).toEqual([`/tmp/qa-workspace/attachment-staging/commercial-proposals/${originalWriteId}/contract.pdf`, 'commercial-proposals', copyWriteId]);
    expect(runtime.copyAttachment.mock.calls[3]).toEqual([`/tmp/qa-workspace/attachment-staging/commercial-proposals/${originalWriteId}/logo.png`, 'commercial-proposals', copyWriteId]);
    expect(runtime.store.save).not.toHaveBeenCalled();
    await click('Сохранить КП');
    expect(runtime.store.save.mock.calls[0][2]).toBe(copyWriteId);
    expect(runtime.store.save.mock.calls[0][1].attachments[0].relativePath).toBe(`attachment-staging/commercial-proposals/${copyWriteId}/contract.pdf`);
    expect(runtime.store.save.mock.calls[0][1].template.logo.relativePath).toBe(`attachment-staging/commercial-proposals/${copyWriteId}/logo.png`);
  });
  it('uses promoted paths in a pending copy after Save and Continue, never reopening removed staging files', async () => {
    await seed(); runtime.chooseOpen.mockResolvedValueOnce('/tmp/contract.pdf'); await click('5. Проверка и экспорт'); await click('Добавить приложение');
    runtime.chooseOpen.mockResolvedValueOnce('/tmp/logo.png'); await click('4. Оформление'); await click('Добавить логотип');
    const originalWriteId = runtime.copyAttachment.mock.calls[0][2];
    runtime.store.save.mockImplementationOnce(async (_title: string, data: ProposalData, id: string) => {
      const promoted = structuredClone(data); promoted.attachments[0].relativePath = `attachments/commercial-proposals/${id}/contract.pdf`; promoted.template.logo!.relativePath = `attachments/commercial-proposals/${id}/logo.png`;
      return record(id, promoted);
    });
    await click('Создать копию'); await click('Сохранить и продолжить');
    expect(runtime.store.save).toHaveBeenCalledOnce(); expect(runtime.store.save.mock.calls[0][2]).toBe(originalWriteId);
    // There should be no extra reads/copies from staging after the backend promoted it.
    expect(runtime.copyAttachment).toHaveBeenCalledTimes(2);
    await click('Сохранить КП'); expect(runtime.store.save).toHaveBeenCalledTimes(2);
    const [_, copied, copyWriteId] = runtime.store.save.mock.calls[1];
    expect(copyWriteId).not.toBe(originalWriteId); expect(copyWriteId).not.toBe(copied.familyId);
    expect(copied.attachments[0].relativePath).toBe(`attachments/commercial-proposals/${originalWriteId}/contract.pdf`);
    expect(copied.template.logo.relativePath).toBe(`attachments/commercial-proposals/${originalWriteId}/logo.png`);
    expect(JSON.stringify(copied)).not.toContain('attachment-staging/');
  });
  it('blocks a copy when a staged asset hash changed and retains the original proposal inputs', async () => {
    await seed(); runtime.chooseOpen.mockResolvedValueOnce('/tmp/contract.pdf'); await click('5. Проверка и экспорт'); await click('Добавить приложение');
    await click('1. Стороны'); const originalNumber = input('proposal-number').props.value;
    runtime.copyAttachment.mockImplementationOnce(async (_path: string, _module: string, id: string) => ({ relativePath: `attachment-staging/commercial-proposals/${id}/contract.pdf`, fileName: 'contract.pdf', sizeBytes: 100, sha256: 'b'.repeat(64), mimeType: 'application/pdf' }));
    await click('Создать копию'); await click('Заменить без сохранения');
    expect(text()).toContain('Временное вложение изменилось'); expect(input('proposal-number').props.value).toBe(originalNumber); expect(input('proposal-title').props.value).toBe('Тестовое предложение'); expect(runtime.store.save).not.toHaveBeenCalled();
  });
  it('uses one stable write ID for new attachments, the draft envelope and the first record save', async () => {
    const data = proposal(); await seed(data); runtime.chooseOpen.mockResolvedValueOnce('/tmp/contract.pdf');
    await click('5. Проверка и экспорт'); await click('Добавить приложение');
    const writeId = runtime.copyAttachment.mock.calls[0][2];
    expect(writeId).toMatch(/^[0-9a-f-]{36}$/i); expect(writeId).not.toBe(data.familyId);
    runtime.chooseOpen.mockResolvedValueOnce('/tmp/logo.png'); await click('4. Оформление'); await click('Добавить логотип');
    expect(runtime.copyAttachment.mock.calls[1][2]).toBe(writeId);
    await vi.advanceTimersByTimeAsync(600); await flush();
    const [module, envelope, key] = runtime.saveDraft.mock.lastCall!;
    expect(module).toBe('commercial-proposals'); expect(key).toBe('proposal:new');
    expect(envelope).toMatchObject({ kind: 'proposal-draft', schemaVersion: 1, recordId: writeId, data: { kind: 'proposal', familyId: data.familyId } });
    expect(envelope.data.attachments[0].relativePath).toBe(`attachment-staging/commercial-proposals/${writeId}/contract.pdf`);
    expect(envelope.data.template.logo.relativePath).toBe(`attachment-staging/commercial-proposals/${writeId}/logo.png`);
    await click('Сохранить КП'); expect(runtime.store.save.mock.calls[0][2]).toBe(writeId);
  });
  it('restores the persisted envelope write ID before copying another attachment or saving', async () => {
    const data = proposal('Восстановленный с вложением'); const writeId = '11111111-1111-4111-8111-111111111111';
    const envelope = { kind: 'proposal-draft', schemaVersion: 1, recordId: writeId, data };
    runtime.readDraft.mockImplementation(async (module: string, key: string) => module === 'commercial-proposals' && key === 'proposal:new' ? envelope : null);
    render(); await flush(); expect(input('proposal-title').props.value).toBe(data.title);
    runtime.chooseOpen.mockResolvedValueOnce('/tmp/added.pdf'); await click('5. Проверка и экспорт'); await click('Добавить приложение');
    expect(runtime.copyAttachment).toHaveBeenCalledExactlyOnceWith('/tmp/added.pdf', 'commercial-proposals', writeId);
    await click('Сохранить КП'); expect(runtime.store.save.mock.calls[0][2]).toBe(writeId); expect(runtime.store.save.mock.calls[0][1].familyId).toBe(data.familyId);
  });
  it.each(['Создать копию', 'Новая редакция'])('%s gets its own staging owner and never saves under the old card or family ID', async (action) => {
    const data = proposal(); data.status = 'ready'; data.revision = 3; runtime.store.records = [record('existing-card', data)];
    render({ openRecordId: 'existing-card' }); await flush(); await click(action);
    runtime.chooseOpen.mockResolvedValueOnce('/tmp/new-revision.pdf'); await click('5. Проверка и экспорт'); await click('Добавить приложение');
    const writeId = runtime.copyAttachment.mock.calls[0][2]; expect(writeId).toMatch(/^[0-9a-f-]{36}$/i); expect(writeId).not.toBe('existing-card'); expect(writeId).not.toBe(data.familyId);
    await click('Сохранить КП'); expect(runtime.store.save.mock.calls[0][2]).toBe(writeId);
    const saved = runtime.store.save.mock.calls[0][1] as ProposalData;
    expect(writeId).not.toBe(saved.familyId); expect(saved.attachments[0].relativePath).toContain(`/${writeId}/`);
    if (action === 'Новая редакция') expect(saved).toMatchObject({ familyId: data.familyId, revision: 4 });
    else { expect(saved.familyId).not.toBe(data.familyId); expect(saved.revision).toBe(1); }
    expect(runtime.store.records[0].payload).toEqual(data);
  });
  it('copies an unsaved logo to template-owned staging and leaves the proposal logo unchanged', async () => {
    await seed(); runtime.chooseOpen.mockResolvedValueOnce('/tmp/logo.png'); await click('4. Оформление'); await click('Добавить логотип');
    const proposalWriteId = runtime.copyAttachment.mock.calls[0][2]; const proposalLogoPath = `attachment-staging/commercial-proposals/${proposalWriteId}/logo.png`;
    await click('Сохранить как шаблон'); await click('Сохранить шаблон');
    expect(runtime.copyAttachment).toHaveBeenCalledTimes(2);
    const template = runtime.store.save.mock.calls[0][1] as ProposalTemplateData;
    expect(template.id).not.toBe(proposalWriteId);
    expect(runtime.copyAttachment.mock.calls[1]).toEqual([`/tmp/qa-workspace/${proposalLogoPath}`, 'commercial-proposals', template.id]);
    expect(template.logo?.relativePath).toBe(`attachment-staging/commercial-proposals/${template.id}/logo.png`);
    expect(runtime.store.save.mock.calls[0][2]).toBe(template.id);
    await click('Сохранить КП'); expect(runtime.store.save.mock.calls[1][2]).toBe(proposalWriteId); expect(runtime.store.save.mock.calls[1][1].template.logo.relativePath).toBe(proposalLogoPath);
  });
});
