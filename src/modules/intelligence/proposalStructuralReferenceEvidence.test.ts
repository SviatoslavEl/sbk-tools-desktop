import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildProposalStructuralReferencePlan, parseProposalStructuralReferenceResponse } from './proposalStructuralReferencePlan';
import { materializeProposalStructuralReferenceEvidence, revalidateProposalStructuralMaterializedEvidence, PROPOSAL_STRUCTURAL_REFERENCE_EVIDENCE_LIMITS } from './proposalStructuralReferenceEvidence';
import type { IntelligenceFragment, IntelligenceSource } from './workbenchTypes';

const byteLength = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
function source(fragment: IntelligenceFragment): IntelligenceSource[] {
  return [{ id: 'synthetic-source', name: 'Синтетический Word', sha256: 'a'.repeat(64), text: fragment.text,
    coverage: { complete: true, requiresOcr: false }, fragments: [fragment] }];
}
function row(texts = ['  Целая\nмногострочная ячейка\r\nс 🧪 и\tтабуляцией  ', 'Другая ячейка'], locator = 'Нативная строка'): IntelligenceFragment {
  return { id: 'row-A', locator, text: texts.join('\t'), structure: { version: 1, format: 'docx', method: 'ooxml',
    part: 'word/document.xml', kind: 'table-row', containerId: 'native-table-A', tableId: 'native-table-A', order: 0, physicalSection: 0,
    rowIndex: 0, rowCount: 1, headerMarker: false,
    cells: texts.map((text, index) => ({ index, text, gridSpan: index === 0 ? 3 : 1, verticalMerge: index === 0 ? 'restart' : 'continue', nestedTableCount: index === 0 ? 1 : 0 })) } };
}
function paragraph(): IntelligenceFragment {
  return { id: 'paragraph-A', locator: 'Нативный абзац', text: '  \nУсловие целиком\r\nс сохранением краёв  ', structure: {
    version: 1, format: 'docx', method: 'ooxml', part: 'word/document.xml', kind: 'paragraph', containerId: 'body', order: 0, physicalSection: 0,
  } };
}
async function issued(input: IntelligenceSource[], refs = [{ ownerId: input[0].fragments![0].id!, cellIndex: 0 as number | null }], status = 'answered', answer: string | null = 'Не проверенное по смыслу утверждение модели.\nНикакой источник его не дополняет.') {
  const plan = await buildProposalStructuralReferencePlan(input, { focus: 'work-scope' }), block = plan.blocks[0];
  const raw = JSON.stringify({ referencePlanKey: plan.referencePlanKey, sourceSnapshotKey: plan.sourceSnapshotKey,
    structureSnapshotKey: plan.structureSnapshotKey, blockId: block.id, status, answer, evidenceRefs: refs });
  const response = await parseProposalStructuralReferenceResponse(raw, plan, block.id, input);
  return { plan, raw, response };
}
afterEach(() => vi.unstubAllGlobals());

describe('separate exact source-materialized reference evidence, not a model answer or ready CP', () => {
  it('materializes only the explicitly returned whole cell with every newline, edge and Unicode character intact', async () => {
    const input = source(row()), before = structuredClone(input), { plan, raw, response } = await issued(input);
    const actualAnswer = response.answer, materialized = await materializeProposalStructuralReferenceEvidence(response, plan, input);
    expect(materialized.entries).toHaveLength(1); expect(materialized.entries[0].text).toBe(input[0].fragments![0].structure!.cells![0].text);
    expect(materialized.entries[0].origin).toBe('source-materialized-whole-native-cell'); expect(materialized.entries[0].modelProvidedText).toBe(false);
    expect(materialized.entries[0].cellIndex).toBe(0); expect(materialized.entries[0].fragmentIndex).toBe(0);
    expect(materialized.origin).toBe('model-returned-refs/source-materialized-evidence'); expect(materialized.modelRawSHA256).toBe(response.rawSHA256);
    expect(response.answer).toBe(actualAnswer); expect(JSON.parse(raw).answer).toBe(actualAnswer); expect(input).toEqual(before);
    for (const key of ['answer', 'quote', 'canFinalize', 'confirmed', 'price', 'projectedItem']) expect(materialized).not.toHaveProperty(key);
    expect(materialized.modelAnswerModified).toBe(false); expect(materialized.semanticReviewRequired).toBe(true);
    expect(materialized.readiness).toBe('not-assessed'); expect(materialized.providerAuthenticity).toBe('not-attested');
    expect(Object.isFrozen(materialized.entries[0])).toBe(true);
  });

  it('preserves model-returned reference order and native cell index, not gridSpan/visual column or all members', async () => {
    const input = source(row(['Первый реальный текст', 'Второй реальный текст', 'Третий НЕ выбран']));
    const { plan, response } = await issued(input, [{ ownerId: 'row-A', cellIndex: 1 }, { ownerId: 'row-A', cellIndex: 0 }]);
    const result = await materializeProposalStructuralReferenceEvidence(response, plan, input);
    expect(result.entries.map(entry => [entry.cellIndex, entry.text])).toEqual([[1, 'Второй реальный текст'], [0, 'Первый реальный текст']]);
    expect(result.entries.some(entry => entry.text.includes('НЕ выбран'))).toBe(false);
  });

  it('materializes a paragraph only from an explicit null-index reference without trimming its whole snapshot text', async () => {
    const input = source(paragraph()), { plan, response } = await issued(input, [{ ownerId: 'paragraph-A', cellIndex: null }]);
    const result = await materializeProposalStructuralReferenceEvidence(response, plan, input);
    expect(result.entries[0].origin).toBe('source-materialized-whole-owner'); expect(result.entries[0].cellIndex).toBeNull();
    expect(result.entries[0].text).toBe(input[0].fragments![0].text);
  });

  it.each(['not-stated', 'unclear'])('keeps %s as a model status with no inferred refs/materializations or absence/completeness proof', async status => {
    const input = source(row()), { plan, response } = await issued(input, [], status, null);
    const result = await materializeProposalStructuralReferenceEvidence(response, plan, input);
    expect(result.modelStatus).toBe(status); expect(result.entries).toEqual([]); expect(result.semanticReviewRequired).toBe(true);
    expect(result).not.toHaveProperty('absent'); expect(result).not.toHaveProperty('complete');
  });

  it('requires the original issued response/plan and evidence capability; typed or persisted JSON copies cannot substitute', async () => {
    const input = source(row()), { plan, response } = await issued(input), result = await materializeProposalStructuralReferenceEvidence(response, plan, input);
    await expect(materializeProposalStructuralReferenceEvidence(structuredClone(response), plan, input)).rejects.toThrow();
    await expect(materializeProposalStructuralReferenceEvidence(response, structuredClone(plan), input)).rejects.toThrow();
    await expect(revalidateProposalStructuralMaterializedEvidence(structuredClone(result), response, plan, input)).rejects.toThrow();
    const other = await issued(input);
    await expect(revalidateProposalStructuralMaterializedEvidence(result, other.response, plan, input)).rejects.toThrow();
    await expect(revalidateProposalStructuralMaterializedEvidence(result, response, other.plan, input)).rejects.toThrow();
    expect(await revalidateProposalStructuralMaterializedEvidence(result, response, plan, input)).toBe(result);
  });

  it('rejects stale cell/owner/structure/source-flag changes atomically without rematching text or filling merged cells', async () => {
    const input = source(row()), { plan, response } = await issued(input), result = await materializeProposalStructuralReferenceEvidence(response, plan, input);
    for (const change of [
      (current: IntelligenceSource[]) => { current[0].fragments![0].structure!.cells![0].text += ' изменено'; current[0].fragments![0].text = current[0].fragments![0].structure!.cells!.map(cell => cell.text).join('\t'); current[0].text = current[0].fragments![0].text; },
      (current: IntelligenceSource[]) => { current[0].fragments![0].locator += ' изменено'; },
      (current: IntelligenceSource[]) => { current[0].fragments![0].structure!.cells![0].gridSpan = 2; },
      (current: IntelligenceSource[]) => { current[0].fragments![0].includedByUser = false; },
    ]) {
      const current = structuredClone(input); change(current); const before = structuredClone(current);
      await expect(materializeProposalStructuralReferenceEvidence(response, plan, current)).rejects.toThrow();
      await expect(revalidateProposalStructuralMaterializedEvidence(result, response, plan, current)).rejects.toThrow();
      expect(current).toEqual(before);
    }
  });

  it('does not publish a receipt if the actual source changes while a fresh-plan digest is pending', async () => {
    const input = source(row()), { plan, response } = await issued(input), native = globalThis.crypto;
    let release!: (value: ArrayBuffer) => void, algorithm!: AlgorithmIdentifier, payload!: BufferSource;
    const digest = vi.fn().mockImplementationOnce((selected: AlgorithmIdentifier, data: BufferSource) => { algorithm = selected; payload = data; return new Promise<ArrayBuffer>(resolve => { release = resolve; }); })
      .mockImplementation((selected: AlgorithmIdentifier, data: BufferSource) => native.subtle.digest(selected, data));
    vi.stubGlobal('crypto', { subtle: { digest } });
    const pending = materializeProposalStructuralReferenceEvidence(response, plan, input);
    expect(release).toBeTypeOf('function'); input[0].name += ' изменено во время await';
    release(await native.subtle.digest(algorithm, payload)); await expect(pending).rejects.toThrow();
  });

  it('enforces an explicit64KiB serialized receipt bound exactly and+1, independently of unchanged model/source budgets', async () => {
    const refs = Array.from({ length: 20 }, (_, index) => ({ ownerId: 'row-A', cellIndex: index }));
    const fixture = (locatorLength: number, pad: number) => source(row(Array.from({ length: 20 }, (_, index) => `C${index}${index === 0 ? 'x'.repeat(pad) : ''}`), 'L'.repeat(locatorLength)));
    const baseline = fixture(1, 0), issuedBaseline = await issued(baseline, refs);
    const base = await materializeProposalStructuralReferenceEvidence(issuedBaseline.response, issuedBaseline.plan, baseline);
    const maximum = PROPOSAL_STRUCTURAL_REFERENCE_EVIDENCE_LIMITS.receiptBytes, remaining = maximum - byteLength(base);
    expect(remaining).toBeGreaterThan(0);
    const locatorLength = 1 + Math.floor(remaining / 20), pad = remaining % 20;
    const boundary = fixture(locatorLength, pad), issuedBoundary = await issued(boundary, refs);
    const exact = await materializeProposalStructuralReferenceEvidence(issuedBoundary.response, issuedBoundary.plan, boundary);
    expect(byteLength(exact)).toBe(maximum); expect(exact.entries).toHaveLength(20);
    const overflow = fixture(locatorLength, pad + 1), issuedOverflow = await issued(overflow, refs), before = structuredClone(overflow);
    await expect(materializeProposalStructuralReferenceEvidence(issuedOverflow.response, issuedOverflow.plan, overflow)).rejects.toThrow(/64 КиБ/);
    expect(overflow).toEqual(before);
  });

  it('is offline-only, with no worker/fetch/projection or response-text replacement', async () => {
    const fetch = vi.fn(), Worker = vi.fn(); vi.stubGlobal('fetch', fetch); vi.stubGlobal('Worker', Worker);
    const input = source(row()), { plan, response } = await issued(input);
    await materializeProposalStructuralReferenceEvidence(response, plan, input);
    expect(fetch).not.toHaveBeenCalled(); expect(Worker).not.toHaveBeenCalled(); expect(response.answer).toContain('Не проверенное по смыслу');
  });
});
