import { describe, expect, it } from 'vitest';
import { buildContractFactPlan, resolveContractFactPlan, parseContractFactResponse, buildContractFactReviewPlan,
  parseContractFactReviewResponse, resolveContractFactReview } from './contractFactPlan';
import { factSources, nativeFactSources, syntheticFacts } from './contractFacts.test-fixture';
import type { IntelligenceFragment } from './workbenchTypes';

describe('whole source unit facts — attribution and structure, not semantic truth', () => {
  it('partitions Unicode prose without gaps/overlap/normalization and keeps duplicate texts at distinct addresses', async () => {
    const value = ('Учебное\u00a0условие\u2011текст 😀 e\u0301.\n').repeat(40), source = factSources([value, value]);
    const plan = await buildContractFactPlan(source);
    expect(plan.owners).toHaveLength(2);
    for (const owner of plan.owners) {
      const units = plan.units.filter(u => u.ownerId === owner.id); let at = 0;
      for (const unit of units) {
        expect(unit.offsetUnit).toBe('utf16-code-unit'); expect(unit.start).toBe(at); expect(unit.text).toBe(value.slice(unit.start, unit.end));
        expect(unit.text).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u); at = unit.end;
      }
      expect(at).toBe(value.length); expect(units.map(u => u.text).join('')).toBe(value);
      expect(new TextEncoder().encode(units.map(u => u.text).join(''))).toEqual(new TextEncoder().encode(value));
    }
    expect(plan.units[0].address.fragmentIndex).not.toBe(plan.units.find(u => u.ownerId === plan.owners[1].id)!.address.fragmentIndex);
    expect(plan.blocks.flatMap(b => b.unitIds)).toEqual(plan.units.map(u => u.id));
    expect(plan.blocks.some(b => b.contextUnitIds.length)).toBe(true);
  });
  it('keeps a multiline whole cell, empty indexed cell, trailing TAB and all native metadata', async () => {
    const multiline = Array.from({ length: 6 }, (_, n) => `${n}: ${'Учебная строка; '.repeat(12)}`).join('\n');
    const row: IntelligenceFragment = { id: 'synthetic-row', locator: 'Учебная таблица', text: `${multiline}\t`, structure: {
      version: 1, format: 'docx', method: 'ooxml', part: 'word/document.xml', kind: 'table-row', containerId: 't', tableId: 't', order: 0, physicalSection: 0,
      rowIndex: 0, rowCount: 1, headerMarker: false, cells: [{ index: 0, text: multiline, gridSpan: 2, verticalMerge: 'restart', nestedTableCount: 0 },
        { index: 1, text: '', gridSpan: 1, verticalMerge: 'none', nestedTableCount: 0 }] } };
    const footer: IntelligenceFragment = { id: 'synthetic-footer', locator: 'Нижний колонтитул', text: 'Учебный колонтитул', structure: {
      version: 1, format: 'docx', method: 'ooxml', part: 'word/footer1.xml', kind: 'header-footer', containerId: 'footer', order: 0, physicalSection: 0 } };
    const source = nativeFactSources([row, footer]), before = JSON.stringify(source), plan = await buildContractFactPlan(source);
    expect(plan.coverage.nativeCells).toBe(2); expect(plan.coverage.owners).toBe(2); expect(plan.units).toHaveLength(3);
    expect(plan.units[0].text).toBe(multiline); expect(plan.units[0].end).toBe(multiline.length); expect(plan.units[1].text).toBe('');
    expect(plan.units[1].cellIndex).toBe(1); expect(plan.owners[0].text.endsWith('\t')).toBe(true);
    expect(plan.owners[0].native).toEqual(row.structure); expect(plan.owners[1].native).toEqual(footer.structure); expect(JSON.stringify(source)).toBe(before);
  });
  it('retains unmatched aggregate text explicitly instead of dropping part of a supplied source', async () => {
    const source = factSources(['Указан один фрагмент.']); source[0].text += '\nДополнительный текст агрегата.';
    const plan = await buildContractFactPlan(source); expect(plan.owners).toHaveLength(2); expect(plan.owners[1].text).toBe(source[0].text);
  });
  it('blocks incomplete OCR, excluded hidden sheets, duplicate source IDs and whole cells beyond limits without partial plan', async () => {
    const incomplete = factSources(['Учебный текст']); incomplete[0].coverage!.requiresOcr = true;
    await expect(buildContractFactPlan(incomplete)).rejects.toThrow(/OCR/);
    const hidden = factSources(['Скрытый текст']); hidden[0].fragments![0].sheetState = 'hidden';
    await expect(buildContractFactPlan(hidden)).rejects.toThrow(/скрытые/);
    await expect(buildContractFactPlan([factSources(['Один'])[0], factSources(['Два'])[0]])).rejects.toThrow(/идентификатор/);
    const whole = 'x'.repeat(50_000), huge = nativeFactSources([{ id: 'large-cell', locator: 'Большая целая ячейка', text: whole, structure: {
      version: 1, format: 'docx', method: 'ooxml', part: 'word/document.xml', kind: 'table-row', containerId: 'large', tableId: 'large', order: 0, physicalSection: 0,
      rowIndex: 0, rowCount: 1, headerMarker: false, cells: [{ index: 0, text: whole, gridSpan: 1, verticalMerge: 'none', nestedTableCount: 0 }] } }]);
    await expect(buildContractFactPlan(huge)).rejects.toThrow(/объём|пакетов/);
  });
  it('binds options/source/unit map/issued identity; rejects missing, duplicate and foreign units and old raw', async () => {
    const source = factSources(['Первый учебный фрагмент.', 'Второй учебный фрагмент.']), plan = await buildContractFactPlan(source);
    const raw = syntheticFacts(plan, plan.blocks[0].id), response = parseContractFactResponse(raw, plan, plan.blocks[0].id, source);
    expect(response.raw).toBe(raw); expect(resolveContractFactPlan(plan, source)).toBe(plan);
    expect(() => resolveContractFactPlan(structuredClone(plan), source)).toThrow(/исходный план/);
    const bad = JSON.parse(raw); bad.units[1].unitId = bad.units[0].unitId;
    expect(() => parseContractFactResponse(JSON.stringify(bad), plan, plan.blocks[0].id, source)).toThrow(/Повторена/);
    const changed = await buildContractFactPlan(source, { responseTokenBudget: 4096 }); expect(changed.planKey).not.toBe(plan.planKey);
    expect(() => parseContractFactResponse(raw, changed, changed.blocks[0].id, source)).toThrow(/другого/);
    const stale = structuredClone(source); stale[0].text += 'Правка'; expect(() => resolveContractFactPlan(plan, stale)).toThrow();
  });
  it('does not hydrate model party fields from source, and keeps a false reviewer witness as an unverified issue', async () => {
    const source = factSources(['SYNTHETIC_SOURCE_COMPANY полномочие Устав.']), plan = await buildContractFactPlan(source);
    const raw = syntheticFacts(plan, plan.blocks[0].id, undefined, units => {
      units[0].status = 'facts'; units[0].facts = [{ kind: 'party', data: { name: 'MODEL_DIFFERENT_COMPANY', role: 'contractor', roleDescription: null, representatives: [] },
        evidence: [{ unitId: units[0].unitId, quote: 'SYNTHETIC_SOURCE_COMPANY' }], links: [] }];
    });
    const response = parseContractFactResponse(raw, plan, plan.blocks[0].id, source), reviewPlan = await buildContractFactReviewPlan(response, plan, source);
    const reviewRaw = JSON.parse(syntheticFacts(plan, plan.blocks[0].id, reviewPlan.reviewPlanKey)); reviewRaw.units = JSON.parse(raw).units;
    reviewRaw.issues = [{ unitId: plan.units[0].id, kind: 'omission', reason: 'SYNTHETIC_ALREADY_PRESENT_WITNESS', evidence: [{ unitId: plan.units[0].id, quote: 'SYNTHETIC_SOURCE_COMPANY' }] }];
    const revised = parseContractFactReviewResponse(JSON.stringify(reviewRaw), reviewPlan, plan, source);
    expect((revised.units[0].facts[0].data as { name: string }).name).toBe('MODEL_DIFFERENT_COMPANY');
    expect(revised.units[0].questions).toEqual([]); expect(revised.issues[0].reason).toBe('SYNTHETIC_ALREADY_PRESENT_WITNESS');
    expect(resolveContractFactReview(revised, reviewPlan, plan, source)).toBe(revised);
    expect(() => resolveContractFactReview(structuredClone(revised), reviewPlan, plan, source)).toThrow(/исходная/);
  });
  it('requires own PRIMARY literal evidence; a valid context quote cannot be promoted into another unit', async () => {
    const source = factSources(['Одинаковый учебный текст.', 'Одинаковый учебный текст.']), plan = await buildContractFactPlan(source, { unitsPerFrame: 1 });
    const first = plan.blocks[0], raw = JSON.parse(syntheticFacts(plan, first.id)); raw.units[0].status = 'facts';
    raw.units[0].facts = [{ kind: 'party', data: { name: 'SYNTHETIC', role: 'other', roleDescription: null, representatives: [] },
      evidence: [{ unitId: first.contextUnitIds[0], quote: 'Одинаковый' }], links: [] }];
    expect(() => parseContractFactResponse(JSON.stringify(raw), plan, first.id, source)).toThrow(/собственную PRIMARY/);
  });
});
