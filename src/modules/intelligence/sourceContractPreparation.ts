import { collectContractProposalFacts } from './contractProposalFacts';
import { createContractProposalProver } from './contractProposalCompletion';
import { assertResponsePreparationSources } from './responsePreparationBounds';
import type { IntelligenceItem, IntelligenceSource } from './workbenchTypes';

export interface SourceContractPreparationRequest { revision: number; sources: IntelligenceSource[] }
export interface SourceContractPreparationWireRequest extends SourceContractPreparationRequest { origin: 'source-contract' }
const wholeFields = ['title', 'introduction', 'lines', 'lineDescriptions', 'deliveryTerms', 'paymentTerms'];

/** Admission for an explicit local action, not a repair/reinterpretation of a
 * provider answer. Unknown extraction completeness cannot become authority. */
export function assertSourceContractSources(sources: unknown): asserts sources is IntelligenceSource[] {
  assertResponsePreparationSources(sources);
  if (!sources.length || sources.some(source => source.coverage?.complete !== true || source.coverage.requiresOcr
    || source.fragments?.some(fragment => fragment.includedByUser === false || (fragment.sheetState === 'hidden' || fragment.sheetState === 'veryHidden') && fragment.includedByUser !== true))) {
    throw new Error('Нужен полностью извлечённый договор без нераспознанных или исключённых фрагментов. Полнота неизвестна либо выбран только фрагмент; локальный проект не создан.');
  }
  const inventory = collectContractProposalFacts(sources);
  const document = inventory.documents[0];
  if (inventory.limited || inventory.documents.length !== 1 || !document?.eligible || !document.complete || document.kind !== 'contract'
    || sources.some(source => !document.sourceIds.includes(source.id))) {
    throw new Error('Для локальной подготовки нужен один однозначный полный договор. Несколько договоров, отдельное ТЗ, посторонние источники или неразобранная принадлежность не объединяются автоматически.');
  }
}

/** Postcondition after the shared source pipeline. It cannot approve a model
 * prefix, an incomplete draft, financial decisions or a generic ACK. */
export function assertPreparedSourceContract(items: readonly IntelligenceItem[], sources: readonly IntelligenceSource[]): void {
  assertSourceContractSources(sources);
  if (items.length !== 1 || items[0].destination !== 'proposals') throw new Error('Из договора не подготовлен единственный проект КП. Частичные карточки не приняты.');
  const document = collectContractProposalFacts(sources).documents[0];
  if (!document || items[0].sourceIds.length !== document.sourceIds.length || items[0].sourceIds.some(id => !document.sourceIds.includes(id))) throw new Error('Источники локального проекта не совпадают с единственным исходным договором.');
  const proof = createContractProposalProver(sources).prove(items[0], items);
  if (!proof || wholeFields.some(field => !proof.fields.has(field))) throw new Error('Полный предмет, состав, результаты, сроки и оплата не подтверждены свежим текстом договора. Частичный локальный проект не принят.');
}
