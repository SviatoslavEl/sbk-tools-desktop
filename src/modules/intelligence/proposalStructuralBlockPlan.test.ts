import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildProposalStructuralBlockPlan, parseProposalStructuralBlockResponse, PROPOSAL_STRUCTURAL_BLOCK_LIMITS, ProposalStructuralBlockPlanError, type ProposalStructuralBlockPlan } from './proposalStructuralBlockPlan';
import type { DocxFragmentStructure } from './documentStructure';
import type { IntelligenceFragment, IntelligenceSource } from './workbenchTypes';

function paragraph(index: number, text = `Учебное действие ${index}: проверить компонент.`, native: Partial<DocxFragmentStructure> = {}): IntelligenceFragment {
  return { id: `owner-${index}`, locator: `Позиция ${index}`, text, structure: { version: 1, format: 'docx', method: 'ooxml', part: 'word/document.xml', kind: 'paragraph', containerId: 'body-container', order: index, physicalSection: 0, ...native } };
}
function row(index: number, tableId: string, rowIndex: number, rowCount: number, texts: string[], headerMarker = false): IntelligenceFragment {
  return { id: `owner-${index}`, locator: `Позиция ${index}`, text: texts.join('\t'), structure: { version: 1, format: 'docx', method: 'ooxml', part: 'word/document.xml', kind: 'table-row', containerId: tableId,
    order: index, physicalSection: 0, tableId, rowIndex, rowCount, headerMarker,
    cells: texts.map((text, cellIndex) => ({ index: cellIndex, text, gridSpan: 1, verticalMerge: 'none', nestedTableCount: 0 })) } };
}
const aux = (index: number) => paragraph(index, `Условие вспомогательной части ${index}.`, { part: `word/header${index}.xml`, kind: 'header-footer', containerId: `aux-${index}` });
const source = (fragments: IntelligenceFragment[]): IntelligenceSource[] => [{ id: 'synthetic-source', name: 'Учебный источник', sha256: 'a'.repeat(64), text: 'AGGREGATE IS NOT AN OWNER', coverage: { complete: true, requiresOcr: false }, fragments }];
const build = (input: IntelligenceSource[], extra = {}) => buildProposalStructuralBlockPlan(input, { focus: 'work-scope', ...extra });
function reply(plan: ProposalStructuralBlockPlan, index = 0, status = 'answered') {
  const block = plan.blocks[index];
  return { sourceSnapshotKey: plan.sourceSnapshotKey, structureSnapshotKey: plan.structureSnapshotKey, blockId: block.id, status,
    answer: status === 'answered' ? 'Учебный ответ модели, не предметная приёмка.' : null,
    evidence: status === 'answered' ? [{ ownerId: block.primary[0].ownerId, quote: block.primary[0].text }] : [] };
}
const parse = (wire: unknown, plan: ProposalStructuralBlockPlan, input: IntelligenceSource[], index = 0) => parseProposalStructuralBlockResponse(JSON.stringify(wire), plan, plan.blocks[index].id, input);
const payload = (prompt: string) => JSON.parse(prompt.split('Целый блок (данные): ')[1]);
afterEach(() => vi.unstubAllGlobals());

describe('whole-owner native structural block planning, not semantic acceptance', () => {
  it('maps a synthetic 189-owner source completely under 64 blocks without using aggregate text or a corpus rule', async () => {
    const fragments: IntelligenceFragment[] = Array.from({ length: 164 }, (_, index) => paragraph(index, `Учебный абзац ${index}. ${'Сохранить целое исходное условие. '.repeat(10)}`));
    for (let index = 164; index < 188; index++) fragments.push(row(index, 'native-table', index - 164, 24, [`Полная ячейка ${index}`, 'Проверить учебный объект.']));
    fragments.push(aux(188)); const input = source(fragments), before = structuredClone(input), plan = await build(input);
    expect(plan.blocks.length).toBeLessThanOrEqual(64); expect(plan.coverage.originalOwners).toBe(189); expect(plan.coverage.canonicalPrimaryOwners).toBe(189);
    expect(plan.coverage.completeOriginalOwnerMapping).toBe(true); expect(plan.coverage.wholeNativeDocumentClaim).toBe(false);
    expect(plan.blocks.flatMap(block => block.primary.map(owner => [owner.fragmentIndex, owner.ownerId, owner.text]))).toEqual(fragments.map((fragment, index) => [index, fragment.id, fragment.text]));
    expect(new Set(plan.coverage.ledger.map(entry => entry.ownerId)).size).toBe(189);
    for (const entry of plan.coverage.ledger) expect(plan.blocks.find(block => block.id === entry.primaryBlockId)!.primary.some(owner => owner.ownerId === entry.ownerId)).toBe(true);
    for (const block of plan.blocks) {
      expect(block.sourcePayloadBytes).toBeLessThanOrEqual(12 * 1024); expect(block.sourcePayloadBytes).toBe(new TextEncoder().encode(JSON.stringify(payload(block.prompt))).byteLength);
      expect(block.promptBytes).toBe(new TextEncoder().encode(block.prompt).byteLength); expect(block.semanticSectionClaim).toBe(false); expect(block.prompt).not.toContain(input[0].text);
      expect(block.primary.length).toBeLessThanOrEqual(20); expect(block.prompt).toContain('полный перечень запрошенных действий или результатов с указанными существенными условиями и ограничениями');
    }
    expect(input).toEqual(before); expect(Object.isFrozen(plan.blocks[0].primary[0].structure)).toBe(true);
  });

  it('segments a long physical prose run only between whole owners, with explicit incomplete-region continuation', async () => {
    const input = source(Array.from({ length: 48 }, (_, index) => paragraph(index, `Условие ${index}: ${'x'.repeat(900)}`))), plan = await build(input);
    expect(plan.blocks.length).toBeGreaterThan(3);
    const regions = new Set(plan.blocks.map(block => block.continuation!.regionId)); expect(regions.size).toBe(1);
    for (const [index, block] of plan.blocks.entries()) {
      expect(block.kind).toBe('physical-prose-interval'); expect(block.primary.length).toBeLessThanOrEqual(20);
      expect(block.continuation).toEqual({ regionId: plan.blocks[0].continuation!.regionId, index, count: plan.blocks.length, wholeRegionComplete: false, logicalSectionClaim: false });
    }
    expect(plan.blocks.flatMap(block => block.primary.map(owner => owner.text))).toEqual(input[0].fragments!.map(fragment => fragment.text));
  });

  it('never invents outline semantics from style names, numbers or wording; native outline alone adds whole context', async () => {
    const input = source([paragraph(0, '1. Заголовок', { styleId: 'Heading1' }), paragraph(1, 'Обычный текст'), paragraph(2, 'Нативный уровень', { outlineLevel: 1, outlineBasis: 'style' }), paragraph(3, 'Целое условие')]);
    const plan = await build(input, { maxOwnersPerProseBlock: 1 });
    expect(plan.blocks[1].context).toEqual([]); expect(plan.blocks[3].context.map(entry => [entry.owner.ownerId, entry.basis])).toEqual([['owner-2', 'native-outline-heading']]);
    expect(plan.blocks.every(block => block.semanticSectionClaim === false)).toBe(true);
  });

  it('resets native headings on a paragraph-container boundary but preserves heading context into a following table', async () => {
    const input = source([paragraph(0, 'Нативный заголовок', { outlineLevel: 0, outlineBasis: 'paragraph', containerId: 'container-A' }),
      row(1, 'following-table', 0, 1, ['Целая строка']), paragraph(2, 'Другой непрозрачный контейнер', { containerId: 'container-B' }),
      paragraph(3, 'Тело второго контейнера', { containerId: 'container-B' })]);
    const plan = await build(input, { maxOwnersPerProseBlock: 1 });
    expect(plan.blocks[1].context.map(entry => entry.owner.ownerId)).toEqual(['owner-0']);
    expect(plan.blocks[2].context).toEqual([]); expect(plan.blocks[3].context).toEqual([]);
  });

  it('does not bridge part/physical-section/container or native row-index gaps, while retaining every emitted owner', async () => {
    const input = source([paragraph(0), paragraph(1, 'Другая физическая часть', { physicalSection: 1 }),
      row(2, 'gapped-table', 0, 3, ['Реальный нативный заголовок'], true), row(3, 'gapped-table', 2, 3, ['Действие после пустой нативной строки']), aux(4)]);
    const plan = await build(input); expect(plan.blocks).toHaveLength(5);
    expect(plan.blocks[3].context).toEqual([]); expect(plan.blocks[3].table!.wholeNativeTableClaim).toBe(false);
    expect(plan.coverage.canonicalPrimaryOwners).toBe(5); expect(plan.blocks[plan.blocks.length - 1].kind).toBe('auxiliary');
    const reordered = structuredClone(input); reordered[0].fragments![1].structure!.order = 4;
    await expect(build(reordered)).rejects.toThrow(/глобальный порядок/);
  });

  it('keeps native headers as PRIMARY once AND context, including their currency/VAT/conditions', async () => {
    const input = source([row(0, 'terms-table', 0, 3, ['Валюта EUR; НДС указан отдельно; только после согласования.'], true),
      row(1, 'terms-table', 1, 3, ['Проверить учебную систему.']), row(2, 'terms-table', 2, 3, ['Подготовить учебное заключение.'])]);
    const plan = await build(input); expect(plan.blocks).toHaveLength(3);
    expect(plan.blocks[0].kind).toBe('native-table-header'); expect(plan.blocks[0].primary[0].text).toBe(input[0].fragments![0].text);
    expect(plan.coverage.ledger[0]).toEqual({ ownerId: 'owner-0', fragmentIndex: 0, primaryBlockId: plan.blocks[0].id,
      contextOccurrences: [1, 2].map(index => ({ blockId: plan.blocks[index].id, basis: 'native-leading-table-header' })) });
    const header = reply(plan); header.evidence[0].quote = 'Валюта EUR'; expect((await parse(header, plan, input)).evidence[0].ownerId).toBe('owner-0');
    const rowClaim = reply(plan, 1); rowClaim.evidence = [{ ownerId: 'owner-0', quote: 'Валюта EUR' }]; await expect(parse(rowClaim, plan, input, 1)).rejects.toThrow(/PRIMARY/);
  });

  it('never guesses an unmarked first-row header, and retains all-header/orphan marked rows as targets', async () => {
    const unmarked = await build(source([row(0, 'unmarked', 0, 2, ['Название', 'Состав']), row(1, 'unmarked', 1, 2, ['Работа', 'Выполнить проверку'])]));
    expect(unmarked.blocks.every(block => block.kind === 'table-row' && block.context.length === 0)).toBe(true);
    const allHeader = await build(source([row(0, 'all-header', 0, 2, ['Условие A'], true), row(1, 'all-header', 1, 2, ['Условие B'], true)]));
    expect(allHeader.blocks).toHaveLength(1); expect(allHeader.blocks[0].primary.map(owner => owner.ownerId)).toEqual(['owner-0', 'owner-1']);
    const orphan = await build(source([row(0, 'orphan', 2, 3, ['Нативный маркер без начальной цепочки'], true)]));
    expect(orphan.coverage.canonicalPrimaryOwners).toBe(1); expect(orphan.blocks[0].context).toEqual([]);
    const later = await build(source([row(0, 'late-marker', 0, 2, ['Целая немаркированная строка']), row(1, 'late-marker', 1, 2, ['Поздний нативный маркер'], true)]));
    expect(later.blocks.every(block => block.kind === 'table-row' && block.context.length === 0)).toBe(true);
  });

  it('blocks a21-owner native header chain instead of expanding PRIMARY slots or splitting the chain', async () => {
    const input = source(Array.from({ length: 21 }, (_, index) => row(index, 'many-headers', index, 21, ['h'], true))), before = structuredClone(input);
    await expect(build(input)).rejects.toMatchObject({ code: 'BLOCKED_LIMITS' });
    await expect(build(input)).rejects.toThrow(/20 целых PRIMARY/); expect(input).toEqual(before);
    const limits = (await build(source([paragraph(0)]))).limits;
    expect(limits.maxPrimaryOwnersPerBlock).toBe(20); expect(limits.maxHeaderContextOwners).toBe(20);
    expect(limits.maxOutlineContextOwners).toBe(9); expect(limits.maxContextOwnersPerBlock).toBe(29);
  });

  it('requires a reported64hex parent-file digest, while the immutable identity still binds all source text and native metadata', async () => {
    for (const sha256 of [undefined, '', 'g'.repeat(64), 'b'.repeat(63), 'b'.repeat(65), null, 42]) {
      const input = source([paragraph(0)]); input[0].sha256 = sha256 as never;
      await expect(build(input)).rejects.toMatchObject({ code: 'BLOCKED_NEEDS_STRUCTURE' });
    }
    const input = source([paragraph(0)]), original = await build(input), edited = structuredClone(input);
    edited[0].fragments![0].text += ' Изменено при том же reported file SHA';
    expect(edited[0].sha256).toBe(input[0].sha256); expect((await build(edited)).sourceSnapshotKey).not.toBe(original.sourceSnapshotKey);
  });

  it('preserves whole merged/nested cells and rejects altered or partial cell ownership', async () => {
    const fragment = row(0, 'nested', 0, 1, ['Целая ячейка\nВложенный ряд\tЗначение', 'Другая ячейка']);
    fragment.structure!.cells![0] = { ...fragment.structure!.cells![0], gridSpan: 3, verticalMerge: 'restart', nestedTableCount: 1 };
    const input = source([fragment]), plan = await build(input);
    expect(payload(plan.blocks[0].prompt).block.primary[0].structure.cells).toEqual(fragment.structure!.cells);
    expect(plan.blocks[0].primary[0].text).toBe(fragment.text); expect(plan.coverage.canonicalPrimaryOwners).toBe(1);
    const changed = structuredClone(input); changed[0].fragments![0].structure!.cells![0].text = 'Обрезано'; await expect(build(changed)).rejects.toThrow();
  });

  it('blocks absent/partial/unsupported metadata, incomplete sources, explicit exclusions and inconsistent tables atomically', async () => {
    const missing = source([paragraph(0)]); delete missing[0].fragments![0].structure;
    await expect(build(missing)).rejects.toMatchObject({ code: 'BLOCKED_NEEDS_STRUCTURE' });
    for (const change of [(s: IntelligenceSource[]) => { s[0].fragments![0].includedByUser = false; }, (s: IntelligenceSource[]) => { s[0].fragments![0].sheetState = 'hidden'; },
      (s: IntelligenceSource[]) => { s[0].coverage!.complete = false; }, (s: IntelligenceSource[]) => { s[0].coverage!.requiresOcr = true; },
      (s: IntelligenceSource[]) => { s[0].text += '\ud800'; },
      (s: IntelligenceSource[]) => { s[0].fragments![0].structure!.format = 'pdf' as never; }]) {
      const input = source([paragraph(0)]); change(input); const before = structuredClone(input); await expect(build(input)).rejects.toThrow(); expect(input).toEqual(before);
    }
    const duplicatedRows = source([row(0, 'ambiguous', 0, 2, ['A']), row(1, 'ambiguous', 0, 2, ['B'])]); await expect(build(duplicatedRows)).rejects.toThrow(/строки/);
  });

  it('fails visibly for long whole owners/header+row, more than64 blocks and4MiB plans with no partial result', async () => {
    const whole = source([paragraph(0, 'x'.repeat(13 * 1024))]), before = structuredClone(whole);
    await expect(build(whole)).rejects.toMatchObject({ code: 'BLOCKED_LIMITS' }); expect(whole).toEqual(before);
    const pair = source([row(0, 'large-header', 0, 2, ['h'.repeat(4000)], true), row(1, 'large-header', 1, 2, ['b'.repeat(4000)])]); await expect(build(pair)).rejects.toThrow(/целым контекстом/);
    await expect(build(source(Array.from({ length: 65 }, (_, index) => aux(index))))).rejects.toThrow(/64/);
    await expect(build(source(Array.from({ length: 64 }, (_, index) => aux(index))), { instruction: '\\'.repeat(20_000) })).rejects.toThrow(/4 МБ/);
  });

  it('normalizes undefined defaults and rejects source/options edits across asynchronous digest awaits', async () => {
    const input = source([paragraph(0)]), ordinary = await build(input);
    expect(await build(input, { instruction: undefined, maxSourcePayloadBytes: undefined, maxOwnersPerProseBlock: undefined })).toEqual(ordinary);
    for (const mutation of ['source', 'options']) {
      let release!: (value: ArrayBuffer) => void;
      const digest = vi.fn().mockImplementationOnce(() => new Promise<ArrayBuffer>(resolve => { release = resolve; })).mockResolvedValue(new Uint8Array(32).buffer);
      vi.stubGlobal('crypto', { subtle: { digest } });
      const current = source([paragraph(0)]), options = { focus: 'work-scope' as const, instruction: 'Исходное' }, pending = buildProposalStructuralBlockPlan(current, options);
      if (mutation === 'source') current[0].fragments![0].text += ' изменено'; else options.instruction = 'Изменено';
      release(new Uint8Array(32).buffer); await expect(pending).rejects.toThrow(/изменились во время подготовки/);
    }
  });
});

describe('strict whole-block response ownership, not answer correctness or a usable CP', () => {
  it('retains actual model answer and only returned exact PRIMARY evidence, never selecting every member or materializing text', async () => {
    const input = source([paragraph(0), paragraph(1)]), before = structuredClone(input), plan = await build(input), data = reply(plan);
    data.answer = 'Непроверенное утверждение модели; принадлежность цитаты не доказывает его смысл.';
    const raw = JSON.stringify(data), result = await parseProposalStructuralBlockResponse(raw, plan, plan.blocks[0].id, input);
    expect(result.answer).toBe(data.answer); expect(result.evidence).toHaveLength(1); expect(result.evidence[0].quote).toBe(data.evidence[0].quote); expect(result.semanticReviewRequired).toBe(true);
    for (const absent of ['items', 'selected', 'references', 'wholeBlockText', 'canFinalize', 'confirmed', 'price']) expect(result).not.toHaveProperty(absent);
    expect(Object.isFrozen(result.evidence[0])).toBe(true); expect(raw).toBe(JSON.stringify(data)); expect(input).toEqual(before);
  });

  it.each(['not-stated', 'unclear'])('accepts model %s only with null answer/empty evidence, without claiming absence or full semantic coverage', async status => {
    const input = source([paragraph(0)]), plan = await build(input), result = await parse(reply(plan, 0, status), plan, input);
    expect(result.status).toBe(status); expect(result.answer).toBeNull(); expect(result.evidence).toEqual([]); expect(result.semanticReviewRequired).toBe(true); expect(result).not.toHaveProperty('complete');
  });

  it('rejects foreign/context evidence, transformed quotes, repeated evidence and invalid status cross-fields without repair', async () => {
    const input = source([row(0, 'proof-table', 0, 2, ['Только контекст валюты'], true), row(1, 'proof-table', 1, 2, ['Проверить\r\nучебный объект.'])]), plan = await build(input);
    const valid = reply(plan, 1); expect((await parse(valid, plan, input, 1)).evidence[0].quote).toBe(input[0].fragments![1].text);
    for (const patch of [{ evidence: [{ ownerId: 'owner-0', quote: 'Только контекст валюты' }] }, { evidence: [{ ownerId: 'owner-1', quote: 'Проверить\nучебный объект.' }] },
      { evidence: [...valid.evidence, ...valid.evidence] }, { evidence: [] }, { answer: '' }, { status: 'not-stated' }, { status: 'unclear' }, { price: 100 }, { answer: '\ud800' }]) {
      const invalid = { ...valid, ...patch }; await expect(parse(invalid, plan, input, 1)).rejects.toThrow();
    }
  });

  it('bounds quotes by2000 Unicode characters without changing source characters', async () => {
    const text = '🧪'.repeat(2001), input = source([paragraph(0, text)]), plan = await build(input), data = reply(plan);
    data.evidence[0].quote = '🧪'.repeat(2000); expect((await parse(data, plan, input)).evidence[0].quote).toBe(data.evidence[0].quote);
    data.evidence[0].quote = text; await expect(parse(data, plan, input)).rejects.toThrow(/свидетельство/);
  });

  it('rejects duplicate JSON keys, old per-owner raw, extra keys, forged plans and cross-focus replies', async () => {
    const input = source([paragraph(0)]), plan = await build(input), data = reply(plan), raw = JSON.stringify(data);
    await expect(parseProposalStructuralBlockResponse(raw.replace('"status":', '"status":"unclear","status":'), plan, plan.blocks[0].id, input)).rejects.toThrow(/повторённое поле/);
    await expect(parse({ sourceSnapshotKey: plan.sourceSnapshotKey, batchId: plan.blocks[0].id, units: { 'owner-0': { selected: true, reason: 'Учебный выбор' } } }, plan, input)).rejects.toThrow();
    await expect(parse({ ...data, roles: ['scope'] }, plan, input)).rejects.toThrow();
    await expect(parseProposalStructuralBlockResponse(raw, structuredClone(plan), plan.blocks[0].id, input)).rejects.toThrow(/исходный/);
    const other = await build(input, { focus: 'deliverables' }); await expect(parseProposalStructuralBlockResponse(raw, other, other.blocks[0].id, input)).rejects.toThrow();
  });

  it('rejects stale source text/native metadata and current-source mutation during parsing', async () => {
    const input = source([paragraph(0)]), plan = await build(input), raw = JSON.stringify(reply(plan));
    for (const change of [(current: IntelligenceSource[]) => { current[0].fragments![0].text += ' Изменено'; }, (current: IntelligenceSource[]) => { current[0].fragments![0].structure!.styleId = 'NativeChanged'; }]) {
      const current = structuredClone(input); change(current); await expect(parseProposalStructuralBlockResponse(raw, plan, plan.blocks[0].id, current)).rejects.toThrow(/изменились/);
    }
    const pending = parseProposalStructuralBlockResponse(raw, plan, plan.blocks[0].id, input); input[0].name += ' changed during await'; await expect(pending).rejects.toThrow(/изменились/);
  });

  it('retains raw bounds and offline-only operation', async () => {
    const fetch = vi.fn(), Worker = vi.fn(); vi.stubGlobal('fetch', fetch); vi.stubGlobal('Worker', Worker);
    const input = source([paragraph(0)]), plan = await build(input);
    await expect(parseProposalStructuralBlockResponse('я'.repeat(1_048_577), plan, plan.blocks[0].id, input)).rejects.toThrow(/2 МБ/);
    await parse(reply(plan), plan, input); expect(fetch).not.toHaveBeenCalled(); expect(Worker).not.toHaveBeenCalled();
    expect(PROPOSAL_STRUCTURAL_BLOCK_LIMITS.blocks).toBe(64); expect(ProposalStructuralBlockPlanError.prototype).toBeInstanceOf(Error);
  });
});
