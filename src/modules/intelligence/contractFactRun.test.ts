import { describe, expect, it, vi } from 'vitest';
import { buildContractFactPlan } from './contractFactPlan';
import { startContractFactRun, ContractFactRunError } from './contractFactRun';
import { factSources, syntheticFactJobReply } from './contractFacts.test-fixture';
import { createWorkingProposalFromFacts } from '../proposals/contractFactWorking';
import { editWorkingProposal, inspectWorkingProposalHistory, createWorkingProposalReviewIntent, projectWorkingProposalPublic, parseWorkingProposalDocument } from '../proposals/workingDocument';
import type { ContractClauseData, ContractFact } from './contractFactTypes';

describe('new typed fact whole runtime and ordinary CP — SYNTHETIC protocol fixtures only', () => {
  it('runs every whole-source frame serially, preserves all typed fields and goes directly to a savable ordinary document', async () => {
    const source = factSources(Array.from({ length: 10 }, (_, n) => `Учебные исходные данные ${n}; это синтетическая проверка.`));
    const options = { responseTokenBudget: 4096, schemaCarrier: 'native' as const }, plan = await buildContractFactPlan(source, options), calls: string[] = [];
    const handle = startContractFactRun({ sources: source, options, isCurrent: () => true, transport: async job => {
      calls.push(`${job.blockId}:${job.kind}`);
      return syntheticFactJobReply(plan, job, units => {
        if (job.blockId !== plan.blocks[0].id) return;
        units[0].status = 'facts'; units[0].facts = [{ kind: 'party', data: { name: 'SYNTHETIC_MODEL_COMPANY', role: 'contractor', roleDescription: 'Исполнитель',
          representatives: [{ name: 'SYNTHETIC_MODEL_PERSON', title: 'SYNTHETIC_MODEL_TITLE', authority: 'SYNTHETIC_MODEL_AUTHORITY' }] },
          evidence: [{ unitId: units[0].unitId, quote: 'Учебные исходные данные' }], links: [] }];
        units[1].status = 'facts'; units[1].facts = [{ kind: 'price', data: { amount: '1122.33', currency: 'USD', vatRate: '17%', vatTreatment: 'включён',
          share: null, payer: null, payee: null, trigger: null, timing: null, conditions: ['SYNTHETIC_PRICE_CONDITION'], alternatives: [] },
          evidence: [{ unitId: units[1].unitId, quote: 'Учебные исходные данные' }], links: [] }];
      });
    } });
    const result = await handle.promise;
    expect(calls).toEqual(plan.blocks.flatMap(b => [`${b.id}:extraction`, `${b.id}:review`])); expect(result.parts).toHaveLength(4);
    expect(result.coverage.frames.every(f => f.state === 'REVIEWED')).toBe(true); expect(result.coverage.semanticCompleteness).toBe('NOT_ASSESSED');
    const seed = await createWorkingProposalFromFacts(result, source), parties = seed.document.sections.find(s => s.area === 'parties-roles')!.blocks[0].text;
    expect(parties).toContain('SYNTHETIC_MODEL_PERSON'); expect(parties).toContain('SYNTHETIC_MODEL_AUTHORITY');
    expect(seed.document.sections.find(s => s.area === 'price-vat')!.blocks[0].text).toContain('1122.33');
    expect(seed.document.metadata.currency).toBeNull(); expect(seed.document.questions).toEqual([]);
    expect((await inspectWorkingProposalHistory(seed.document, seed.historyJson)).state).toBe('available-unvalidated');
    expect(parseWorkingProposalDocument(JSON.stringify(seed.document))).toEqual(seed.document);
    const edited = editWorkingProposal(seed.document, d => { d.sections[0].userText = 'SYNTHETIC_HUMAN_EDIT'; d.sections[0].userTextIncluded = true; });
    const intent = await createWorkingProposalReviewIntent(edited), output = await projectWorkingProposalPublic(edited, 'final', intent);
    expect(JSON.stringify(output)).toContain('SYNTHETIC_MODEL_COMPANY'); expect(JSON.stringify(output)).not.toContain('Учебные исходные данные');
    expect(JSON.stringify(output)).not.toContain('reviewPlanKey'); expect(JSON.stringify(output)).not.toContain('uncertainties');
    await expect(createWorkingProposalFromFacts(structuredClone(result), source)).rejects.toThrow(/исходный запуск/);
    const changed = editWorkingProposal(edited, d => { d.title = 'Новая ручная редакция'; });
    await expect(projectWorkingProposalPublic(changed, 'final', intent)).rejects.toThrow(/проверка пользователем/);
  });
  it('keeps a false AI omission/witness as history, never as a required customer question or automatic answer repair', async () => {
    const source = factSources(['SYNTHETIC_ALREADY_PRESENT: уведомить партнёра письменно.']), plan = await buildContractFactPlan(source);
    const data: ContractClauseData = { actor: 'SYNTHETIC_ACTOR', action: 'уведомить партнёра письменно', object: null,
      conditions: [], triggers: [], timing: ['SYNTHETIC_TIMING'], notices: ['письменно'], alternatives: [], inputs: [], outputs: [] };
    const result = await startContractFactRun({ sources: source, isCurrent: () => true, transport: async job => {
      const reply = syntheticFactJobReply(plan, job, units => { units[0].status = 'facts'; units[0].facts = [{ kind: 'schedule', data,
        evidence: [{ unitId: units[0].unitId, quote: 'уведомить партнёра письменно' }], links: [] }]; });
      if (job.kind === 'review') { const raw = JSON.parse(reply.text); raw.issues = [{ unitId: plan.units[0].id, kind: 'omission', reason: 'SYNTHETIC_FALSE_MISSING_NOTICE',
        evidence: [{ unitId: plan.units[0].id, quote: 'уведомить партнёра письменно' }] }]; reply.text = JSON.stringify(raw); }
      return reply;
    } }).promise;
    const seed = await createWorkingProposalFromFacts(result, source);
    expect(seed.document.questions).toEqual([]); expect(seed.historyJson).toContain('SYNTHETIC_FALSE_MISSING_NOTICE');
    const schedule = seed.document.sections.find(s => s.area === 'schedule')!.blocks[0].text;
    expect(schedule).toContain('уведомить партнёра письменно'); expect(schedule).not.toContain('SYNTHETIC_FALSE_MISSING_NOTICE');
    expect(result.records[0].review.issues[0].kind).toBe('omission'); // unchanged model opinion, no regex flip
    const fakeHistory = JSON.parse(seed.historyJson); fakeHistory.humanApproval = true;
    expect((await inspectWorkingProposalHistory(seed.document, JSON.stringify(fakeHistory))).state).toBe('mismatch');
  });
  it('does not turn model-declared subcontract/admin rights into the primary work scope', async () => {
    const source = factSources(['Учебное условие о привлечении помощника.']), plan = await buildContractFactPlan(source);
    const right: ContractFact = { kind: 'right', data: { actor: 'SYNTHETIC_ACTOR', action: 'Привлечь помощника', object: null,
      conditions: ['Ответственность за помощника'], triggers: [], timing: [], notices: [], alternatives: [], inputs: [], outputs: [] },
      evidence: [{ unitId: plan.units[0].id, quote: 'о привлечении помощника' }], links: [] };
    const result = await startContractFactRun({ sources: source, isCurrent: () => true, transport: async job => syntheticFactJobReply(plan, job, units => { units[0].status = 'facts'; units[0].facts = [right]; }) }).promise;
    const seed = await createWorkingProposalFromFacts(result, source);
    expect(seed.document.sections.find(s => s.area === 'work-scope')!.blocks).toEqual([]);
    expect(seed.document.sections.find(s => s.area === 'parties-roles')!.blocks[0].text).toContain('Дополнительное право');
  });
  it('rejects insufficient complete-run budgets before any provider call and retains a malformed raw before stopping', async () => {
    const source = factSources(['Учебный текст.']), transport = vi.fn();
    const error = await startContractFactRun({ sources: source, isCurrent: () => true, transport, maxRequests: 1 }).promise.catch(e => e);
    expect(error).toBeInstanceOf(ContractFactRunError); expect(error.code).toBe('LIMITS'); expect(transport).not.toHaveBeenCalled();
    const malformed = await startContractFactRun({ sources: source, isCurrent: () => true, transport: async () => ({ text: 'SYNTHETIC_BAD_JSON' }) }).promise.catch(e => e);
    expect(malformed).toBeInstanceOf(ContractFactRunError); expect(malformed.capturedParts[0].raw).toBe('SYNTHETIC_BAD_JSON');
    expect(malformed.coverage.requestsAttempted).toBe(1); expect(malformed.coverage.frames.some((f: { state: string }) => f.state === 'REVIEWED')).toBe(false);
  });
  it('cancels promptly, retains a late bounded raw with honest live counters and never installs a partial CP', async () => {
    const source = factSources(['Учебный текст.']), plan = await buildContractFactPlan(source); let release!: (reply: { text: string }) => void;
    const transport = vi.fn((_job: import('./contractFactRun').ContractFactJob) => new Promise<{ text: string }>(resolve => { release = resolve; }));
    const handle = startContractFactRun({ sources: source, isCurrent: () => true, transport }), settled = handle.promise.catch(e => e);
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1)); handle.cancel(); const error = await settled;
    expect(error.code).toBe('CANCELLED'); const elapsed = error.coverage.elapsedMs;
    release(syntheticFactJobReply(plan, transport.mock.calls[0][0]));
    await vi.waitFor(() => expect(error.capturedParts).toHaveLength(1));
    expect(error.coverage.retainedRawBytes).toBe(error.capturedParts[0].rawBytes); expect(error.coverage.elapsedMs).toBe(elapsed);
    expect(transport).toHaveBeenCalledTimes(1); expect(error.coverage.frames.filter((f: { state: string }) => f.state === 'REVIEWED')).toEqual([]);
  });
  it('configuration/source mutation during reply cannot publish a new draft or continue another request', async () => {
    const source = factSources(['Учебный текст.']), plan = await buildContractFactPlan(source); const publish = vi.fn();
    const error = await startContractFactRun({ sources: source, isCurrent: () => true, onPart: publish, transport: async job => {
      source[0].text += 'SYNTHETIC_EDIT'; return syntheticFactJobReply(plan, job);
    } }).promise.catch(e => e);
    expect(error.code).toBe('STALE'); expect(error.capturedParts).toHaveLength(1); expect(publish).not.toHaveBeenCalled();
  });
});
