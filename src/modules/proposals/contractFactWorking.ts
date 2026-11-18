import { PROPOSAL_AREAS, type ProposalArea } from '../intelligence/proposalAreaPlan';
import { resolveContractFactRun, type ContractFactRunResult } from '../intelligence/contractFactRun';
import type { ContractFact, ContractPartyData, ContractClauseData, ContractFinanceData } from '../intelligence/contractFactTypes';
import type { IntelligenceSource } from '../intelligence/workbenchTypes';
import { parseWorkingProposalDocument, WORKING_PROPOSAL_LIMITS, type WorkingProposalDocument } from './workingDocument';

export const CONTRACT_FACT_HISTORY_PURPOSE = 'unapproved-model-fact-proposal-draft';
const titles: Record<ProposalArea, string> = { 'work-scope': 'Предмет и условия выполнения', deliverables: 'Результаты работ',
  'checked-facets': 'Проверяемые аспекты', 'price-vat': 'Стоимость и НДС', payment: 'Порядок оплаты', 'parties-roles': 'Стороны и полномочия', schedule: 'Сроки и события' };
const labels: Record<string, string> = { work: 'Работы', deliverable: 'Результат', facet: 'Проверяемый аспект', constraint: 'Условие выполнения', input: 'Необходимые входные данные',
  event: 'Событие', schedule: 'Срок', right: 'Дополнительное право', administrative: 'Организационное условие', other: 'Дополнительное условие',
  price: 'Стоимость', vat: 'НДС', payment: 'Платёж', conditions: 'Условия', triggers: 'События отсчёта', timing: 'Сроки', notices: 'Уведомления', alternatives: 'Альтернативы', inputs: 'Входные данные', outputs: 'Результаты' };
const present = (v: string | null): v is string => v !== null && v !== '';
function fields(items: readonly [string, string | null][]) { return items.filter(([, v]) => present(v)).map(([label, v]) => `${label}: ${v}`).join('\n'); }
/** Formatting only MODEL fields. Never reads source text/quotes to fill a field,
 * infer a party/amount, repair a review reason or generate a customer question. */
export function formatContractFact(fact: ContractFact): string {
  if (fact.kind === 'party') {
    const p = fact.data as ContractPartyData;
    const role = { contractor: 'Исполнитель', customer: 'Заказчик', other: 'Сторона', unknown: 'Сторона' }[p.role];
    return [fields([[role, p.name], ['Роль', p.name === null && p.role !== 'unknown' ? role : null], ['Роль в договоре', p.roleDescription === role ? null : p.roleDescription]]), ...p.representatives.map(r => fields([
      ['Представитель', r.name], ['Должность', r.title], ['Основание полномочий', r.authority],
    ]))].filter(Boolean).join('\n');
  }
  let body: string;
  if (['price', 'vat', 'payment'].includes(fact.kind)) {
    const p = fact.data as ContractFinanceData;
    body = [fields([['Сумма', p.amount], ['Валюта', p.currency], ['Ставка НДС', p.vatRate], ['Режим НДС', p.vatTreatment],
      ['Доля платежа', p.share], ['Плательщик', p.payer], ['Получатель', p.payee], ['Основание платежа', p.trigger], ['Срок', p.timing]]),
    ...p.conditions.map(v => `Условие: ${v}`), ...p.alternatives.map(v => `Альтернатива: ${v}`)].filter(Boolean).join('\n');
  } else {
    const p = fact.data as ContractClauseData;
    body = [fields([['Кто', p.actor], ['Действие', p.action], ['Объект', p.object]]),
      ...(['conditions', 'triggers', 'timing', 'notices', 'alternatives', 'inputs', 'outputs'] as const).flatMap(k => p[k].map(v => `${labels[k]}: ${v}`))].filter(Boolean).join('\n');
  }
  return [`${labels[fact.kind]}:`, body, ...fact.links.map(l => l.sourceReference ? `Связь с другим условием: ${l.sourceReference}` : '')].filter(Boolean).join('\n');
}
export function contractFactArea(fact: ContractFact): ProposalArea {
  if (fact.kind === 'party') return 'parties-roles';
  if (fact.kind === 'price' || fact.kind === 'vat') return 'price-vat';
  if (fact.kind === 'payment') return 'payment';
  if (fact.kind === 'deliverable') return 'deliverables';
  if (fact.kind === 'facet') return 'checked-facets';
  if (['work', 'constraint', 'input'].includes(fact.kind)) return 'work-scope';
  if (['event', 'schedule'].includes(fact.kind)) return 'schedule';
  // A model-declared right or administrative clause never becomes a primary
  // DD action. Its declared timing, if present, remains a schedule condition.
  return (fact.data as ContractClauseData).timing.length ? 'schedule' : 'parties-roles';
}
async function sha(s: string) { const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)); return Array.from(new Uint8Array(b), x => x.toString(16).padStart(2, '0')).join(''); }
export async function createWorkingProposalFromFacts(result: ContractFactRunResult, sources: readonly IntelligenceSource[], options: { title?: string; id?: string } = {}): Promise<{ document: WorkingProposalDocument; historyJson: string }> {
  resolveContractFactRun(result, sources); const before = JSON.stringify(result), sourceBefore = JSON.stringify(sources);
  const renderedBlocks: { id: string; frameId: string; frameIndex: number; area: ProposalArea; text: string; unitIds: string[] }[] = [];
  for (const [index, record] of result.records.entries()) {
    for (const area of PROPOSAL_AREAS) {
      const rows = record.review.units.flatMap(u => u.facts.filter(f => contractFactArea(f) === area).map(f => ({ unitId: u.unitId, text: formatContractFact(f) })));
      // No semantic merging or cross-source defaults. Every model-declared
      // field remains visible. Context/reviewer notes never supply CP prose.
      if (rows.length) renderedBlocks.push({ id: `${area}:${record.review.blockId}`, frameId: record.review.blockId, frameIndex: index, area,
        text: rows.map(r => r.text).join('\n\n'), unitIds: [...new Set(rows.map(r => r.unitId))] });
    }
  }
  const questions = result.records.flatMap((r, frame) => r.review.units.flatMap(u => u.questions.map((q, at) => ({
    id: `source-question:${frame}:${u.unitId}:${at}`, area: q.area, topic: titles[q.area], question: q.question, answer: '', state: 'open' as const,
  }))));
  const sections = PROPOSAL_AREAS.map(area => ({ area, title: titles[area], blocks: renderedBlocks.filter(b => b.area === area).map(b => ({
    id: b.id, frameId: b.frameId, frameIndex: b.frameIndex, text: b.text, origin: 'formatted-model-facts' as const, included: true,
  })), userText: '', userTextIncluded: false }));
  const history = { version: 2, purpose: CONTRACT_FACT_HISTORY_PURPOSE, planKey: result.plan.planKey,
    sourceSnapshotKey: result.plan.sourceSnapshotKey, structureSnapshotKey: result.plan.structureSnapshotKey,
    sourceSnapshot: result.plan.sources, owners: result.plan.owners, sections, clarificationQuestions: questions,
    unvalidatedDetails: PROPOSAL_AREAS.map(area => ({ area, label: 'Замечания ИИ не подтверждают пробел и не создают вопрос клиенту' })),
    audit: { kind: 'source-unit-facts-v1', units: result.plan.units, frames: result.plan.blocks.map(b => ({ id: b.id, unitIds: b.unitIds, contextUnitIds: b.contextUnitIds })),
      records: result.records, parts: result.parts, renderedBlocks,
      reviewIssuesAreUnverifiedOpinions: true, modelCoverageIsNotSourceTruth: true, revisedFactsAreNewModelRaw: true, projectionOrigin: 'formatted-model-fields-not-verbatim-answer' },
    runCoverage: result.coverage, approvedContent: [], readyForClient: false, humanApproval: false,
    semanticTruth: 'not-proven', completeness: 'not-assessed', providerAuthenticity: 'not-attested' };
  const historyJson = JSON.stringify(history), historyBytes = new TextEncoder().encode(historyJson).byteLength;
  if (historyBytes > WORKING_PROPOSAL_LIMITS.historyBytes) throw new Error('Полная частная история превышает 16 МиБ. Она не усечена, документ не установлен.');
  const historySHA = await sha(historyJson);
  resolveContractFactRun(result, sources);
  if (JSON.stringify(result) !== before || JSON.stringify(sources) !== sourceBefore) throw new Error('Результат или материалы изменились во время сборки.');
  const document = parseWorkingProposalDocument({ kind: 'proposal-working-document', schemaVersion: 2, id: options.id ?? crypto.randomUUID(), revision: 0,
    title: options.title ?? 'Коммерческое предложение', metadata: { number: null, documentDate: null, validUntil: null, currency: null, issuerName: null, recipientName: null },
    layout: { style: 'standard', accentColor: '#247A64' }, sections, questions,
    historicalSource: { kind: 'unvalidated-history', sha256: historySHA, bytes: historyBytes, sourceSnapshotKey: result.plan.sourceSnapshotKey,
      structureSnapshotKey: result.plan.structureSnapshotKey, planKey: result.plan.planKey } });
  return { document, historyJson };
}
