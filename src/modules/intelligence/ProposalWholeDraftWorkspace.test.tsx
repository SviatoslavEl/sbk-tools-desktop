import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProposalWholeDraftWorkspace, type ProposalWholeDraftWorkspaceProps } from './ProposalWholeDraftWorkspace';
import { buildProposalAreaPlan, buildProposalAreaReviewPlan, parseProposalAreaBlockResponse, parseProposalAreaReviewResponse, PROPOSAL_AREAS, type ProposalArea, type ProposalAreaAnswer } from './proposalAreaPlan';
import { buildProposalWholeDraft } from './proposalWholeDraft';
import { createProposalDraftEditorHandoff, projectProposalDraftEditorPreview, PROPOSAL_DRAFT_EDITOR_LIMITS } from './proposalDraftEditorAdapter';
import type { IntelligenceSource } from './workbenchTypes';
import { syntheticReview, syntheticReviewContract } from './proposalAreaReview.test-fixture';

// Real source-only protocol/assembler/adapter fixtures; synthetic model answers
// and verdicts only. This hook/SSR harness exercises callbacks, not a real DOM,
// keyboard focus, browser layout, native application or model accuracy.
const hooks = vi.hoisted(() => ({ at: 0, slots: [] as { value: unknown }[] }));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(),
  useState: (initial: unknown) => { const index = hooks.at++; hooks.slots[index] ??= { value: typeof initial === 'function' ? initial() : initial };
    return [hooks.slots[index].value, (next: unknown) => { hooks.slots[index].value = typeof next === 'function' ? next(hooks.slots[index].value) : next; }]; },
  useRef: (initial: unknown) => { const index = hooks.at++; hooks.slots[index] ??= { value: { current: initial } }; return hooks.slots[index].value; },
  useId: () => 'synthetic-workspace',
}));

async function fixture(options: { allAnswered?: boolean; blocked?: ProposalArea } = {}) {
  const cells = ['SYNTHETIC_OWNED_TEXT', 'PRIVATE_SOURCE_NOT_EDITABLE'].map((text, index) => ({ index, text, gridSpan: 1, verticalMerge: 'none' as const, nestedTableCount: 0 }));
  const sources: IntelligenceSource[] = [{ id: 'source', name: 'Synthetic source', sha256: 'd'.repeat(64), text: 'PRIVATE_AGGREGATE_NOT_EDITOR_TEXT', coverage: { complete: true, requiresOcr: false },
    fragments: [{ id: 'owner', locator: 'Synthetic native row', text: cells.map(cell => cell.text).join('\t'), structure: { version: 1, format: 'docx', method: 'ooxml', part: 'word/document.xml',
      kind: 'table-row', containerId: 'table', tableId: 'table', order: 0, physicalSection: 0, rowIndex: 0, rowCount: 1, headerMarker: true, cells } }] }];
  const plan = await buildProposalAreaPlan(sources), records = [];
  for (const block of plan.blocks) {
    const areas = {} as Record<ProposalArea, ProposalAreaAnswer>;
    for (const area of PROPOSAL_AREAS) areas[area] = options.allAnswered || area === 'work-scope' || area === options.blocked
      ? { status: 'answered', answer: `  SYNTHETIC_MODEL_${area}\r\nWhole unchanged answer.  `, evidenceRefs: [{ ownerId: 'owner', cellIndex: 0 }] }
      : { status: 'not-stated', answer: null, evidenceRefs: [] };
    const response = await parseProposalAreaBlockResponse(JSON.stringify({ schemaCarrier: plan.schemaCarrier, planKey: plan.planKey, sourceSnapshotKey: plan.sourceSnapshotKey, structureSnapshotKey: plan.structureSnapshotKey, blockId: block.id, areas }), plan, block.id, sources);
    const reviewPlan = await buildProposalAreaReviewPlan(response, plan, sources);
    const reviewResponse = await parseProposalAreaReviewResponse(JSON.stringify({ ...syntheticReviewContract, reviewPlanKey: reviewPlan.reviewPlanKey, planKey: plan.planKey, sourceSnapshotKey: plan.sourceSnapshotKey, structureSnapshotKey: plan.structureSnapshotKey,
      blockId: block.id, areas: Object.fromEntries(PROPOSAL_AREAS.map(area => [area, syntheticReview(response.areas[area].status, area === options.blocked ? 'unsupported' : 'supported', `PRIVATE_REVIEW_${area}`)])) }), reviewPlan, plan, sources);
    records.push({ response, reviewPlan, reviewResponse });
  }
  const draft = await buildProposalWholeDraft(plan, records, sources);
  return { handoff: await createProposalDraftEditorHandoff(draft, plan, records, sources), draft };
}
interface NodeProps { children?: ReactNode; value?: string; disabled?: boolean; 'aria-label'?: string; 'data-block-id'?: string; 'data-question-id'?: string; style?: Record<string, unknown>; onChange?: (event: { target: { value: string } }) => void; onClick?: () => void; }
let tree: ReactNode, props: ProposalWholeDraftWorkspaceProps;
function render(next = props) { props = next; hooks.at = 0; tree = ProposalWholeDraftWorkspace(props); }
function nodes(node: ReactNode = tree): ReactElement<NodeProps>[] { if (Array.isArray(node)) return node.flatMap(child => nodes(child ?? null)); if (!isValidElement<NodeProps>(node)) return []; return [node, ...nodes(node.props.children ?? null)]; }
function text(node: ReactNode = tree): string { if (Array.isArray(node)) return node.map(child => text(child ?? null)).join(''); if (isValidElement<NodeProps>(node)) return text(node.props.children ?? null); return typeof node === 'string' || typeof node === 'number' ? String(node) : ''; }
function input(label: string) { const found = nodes().find(node => node.type === 'textarea' && node.props['aria-label'] === label); if (!found) throw new Error(`Missing textarea ${label}`); return found; }
function edit(label: string, value: string) { input(label).props.onChange!({ target: { value } }); render(); }
beforeEach(() => { hooks.at = 0; hooks.slots = []; });

describe('private whole-draft workspace — synthetic callback and SSR coverage only', () => {
  it('shows all seven areas, scoped absence and session/export limitations without manufacturing approval or defaults', async () => {
    const f = await fixture(); render({ handoff: f.handoff, stale: false });
    const html = renderToStaticMarkup(<>{tree}</>);
    for (const section of f.handoff.sections) expect(html).toContain(section.title);
    expect(html).toContain('Личный черновик текущего сеанса — не готовое КП');
    expect(html).toContain('Этот предварительный просмотр хранится в памяти сеанса');
    expect(html).toContain('Для сохранения и подготовки файла перейдите в рабочий редактор');
    expect(html).toContain('Это не доказательство их отсутствия');
    expect(nodes().filter(node => node.props['data-question-id']).map(node => node.props['data-question-id'])).toEqual(f.handoff.questions.map(question => question.id));
    expect(nodes().filter(node => node.type === 'textarea').every(node => node.props.style?.width === '100%' && node.props.style?.minWidth === 0)).toBe(true);
    expect(nodes().filter(node => node.type === 'button').map(node => text(node))).not.toEqual(expect.arrayContaining(['Экспорт', 'Сохранить', 'Согласовать']));
    const values = nodes().filter(node => node.type === 'textarea').map(node => node.props.value).join('\n');
    expect(values).not.toContain('PRIVATE_SOURCE'); expect(values).not.toContain('PRIVATE_REVIEW'); expect(values).not.toContain('PRIVATE_AGGREGATE');
    expect(f.handoff).not.toHaveProperty('currency'); expect(f.handoff.readyForClient).toBe(false);
  });

  it('edits the whole supported block without changing its stable element key or immutable original answer and refs', async () => {
    const f = await fixture(), original = f.draft.sections[0].bundles[0], before = JSON.stringify(original); render({ handoff: f.handoff, stale: false });
    const block = f.handoff.sections[0].blocks[0], key = nodes().find(node => node.props['data-block-id'] === block.id)!.key;
    edit('Текст блока 1 — Состав работ', 'П'); edit('Текст блока 1 — Состав работ', 'Проверить вручную');
    expect(block).toMatchObject({ text: 'Проверить вручную', origin: 'user-edit-unreviewed' });
    expect(nodes().find(node => node.props['data-block-id'] === block.id)!.key).toBe(key);
    expect(JSON.stringify(original)).toBe(before); expect(text()).toContain('Ваша правка — не проверена');
    expect(text()).toContain('не наследуют подтверждение'); expect(projectProposalDraftEditorPreview(f.handoff).publicCPAllowed).toBe(false);
  });

  it('accepts user section text and actual question answers, and rolls both back atomically on validation failure', async () => {
    const f = await fixture(); render({ handoff: f.handoff, stale: false });
    const question = f.handoff.questions[0], section = f.handoff.sections.find(section => section.area === question.area)!;
    edit(`Собственный текст — ${section.title}`, 'Мой вариант без автоматического подтверждения.');
    edit(`Ответ на уточнение — ${question.id}`, 'Ответ пользователя.');
    expect(section.userText).toBe('Мой вариант без автоматического подтверждения.'); expect(question.answer).toBe('Ответ пользователя.');
    const key = nodes().find(node => node.props['data-question-id'] === question.id)!.key;
    edit(`Собственный текст — ${section.title}`, 'x'.repeat(PROPOSAL_DRAFT_EDITOR_LIMITS.textCharacters + 1));
    expect(section.userText).toBe('Мой вариант без автоматического подтверждения.'); expect(text()).toContain('Предыдущее значение сохранено');
    edit(`Ответ на уточнение — ${question.id}`, 'bad\u0000text');
    expect(question.answer).toBe('Ответ пользователя.'); expect(nodes().find(node => node.props['data-question-id'] === question.id)!.key).toBe(key);
    expect(f.handoff.readyForClient).toBe(false); expect(f.handoff.questions).toHaveLength(f.draft.clarificationQuestions.length);
  });

  it('rolls an invalid supported-block edit back instead of truncating or inheriting evidence for it', async () => {
    const f = await fixture(); render({ handoff: f.handoff, stale: false }); const before = { ...f.handoff.sections[0].blocks[0] };
    edit('Текст блока 1 — Состав работ', 'x'.repeat(PROPOSAL_DRAFT_EDITOR_LIMITS.textCharacters + 1));
    expect(f.handoff.sections[0].blocks[0]).toEqual(before); expect(input('Текст блока 1 — Состав работ').props.value).toBe(before.text); expect(text()).toContain('Предыдущее значение сохранено');
  });

  it('keeps blocked answer/reviewer evidence separate from editable text and never fabricates questions for complete supported areas', async () => {
    const f = await fixture({ allAnswered: true, blocked: 'payment' }); render({ handoff: f.handoff, stale: false });
    expect(f.handoff.questions.every(question => question.area === 'payment')).toBe(true);
    expect(nodes().filter(node => node.props['data-question-id'])).toHaveLength(f.handoff.questions.length);
    expect(text()).toContain('SYNTHETIC_MODEL_payment'); expect(text()).toContain('PRIVATE_REVIEW_payment');
    const values = nodes().filter(node => node.type === 'textarea').map(node => node.props.value).join('\n');
    expect(values).not.toContain('SYNTHETIC_MODEL_payment'); expect(values).not.toContain('PRIVATE_REVIEW_payment');
    expect(text()).toContain('Это отдельный неизменяемый контекст, не текст КП'); expect(text()).toContain('SYNTHETIC_OWNED_TEXT');
    const full = await fixture({ allAnswered: true }); render({ handoff: full.handoff, stale: false });
    expect(nodes().filter(node => node.props['data-question-id'])).toEqual([]);
  });

  it('disables stale edits, guards a previously captured callback and leaves close available', async () => {
    const f = await fixture(), close = vi.fn(); render({ handoff: f.handoff, stale: false, onClose: close });
    const oldChange = input('Текст блока 1 — Состав работ').props.onChange!, before = f.handoff.sections[0].blocks[0].text;
    render({ handoff: f.handoff, stale: true, onClose: close }); oldChange({ target: { value: 'late stale edit' } }); render();
    expect(f.handoff.sections[0].blocks[0].text).toBe(before); expect(nodes().filter(node => node.type === 'textarea').every(node => node.props.disabled)).toBe(true);
    expect(text()).toContain('Этот черновик устарел'); nodes().find(node => node.type === 'button' && text(node) === 'Закрыть черновик')!.props.onClick!(); expect(close).toHaveBeenCalledOnce();
  });

  it('rejects a cloned handoff without showing editable fields and guards callbacks from a replaced session', async () => {
    const f = await fixture(); render({ handoff: f.handoff, stale: false });
    const callback = input('Текст блока 1 — Состав работ').props.onChange!, before = f.handoff.sections[0].blocks[0].text;
    render({ handoff: structuredClone(f.handoff), stale: false });
    expect(text()).toContain('Черновик КП недоступен'); expect(nodes().filter(node => node.type === 'textarea')).toEqual([]);
    callback({ target: { value: 'wrong session' } }); expect(f.handoff.sections[0].blocks[0].text).toBe(before);
  });
});
