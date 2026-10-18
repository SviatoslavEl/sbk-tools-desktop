import { createContractProposalProver } from '../intelligence/contractProposalCompletion';
import type { IntelligenceItem, IntelligenceSource } from '../intelligence/workbenchTypes';
import type { CommercialSha256 } from './commercialDocument';
import { prepareCommercialDocument } from './commercialPreparation';
import type { ProposalData } from './types';

/** Bounded source-derived contract route only. Never reinterpret a manual or
 * model-authored subset as the canonical whole contract and silently replace
 * it with different conditions. Other document/configuration paths stay V1. */
export async function prepareCommercialTaskProposal(input: {
  data: ProposalData; item: IntelligenceItem; items: readonly IntelligenceItem[];
  sources: readonly IntelligenceSource[]; sourceSnapshotKey: CommercialSha256;
}): Promise<{ data: ProposalData; structured: boolean; reason?: string }> {
  const data = structuredClone(input.data), item = structuredClone(input.item), items = structuredClone(input.items), sources = structuredClone(input.sources);
  if (data.commercialDocument !== undefined || data.status !== 'draft' || data.sourceFinancials?.decision) throw new Error('Структурная подготовка применяется только к новому черновику, не к сохранённому или согласованному документу.');
  const proof = createContractProposalProver(sources).prove(item, items);
  const required = ['title', 'introduction', 'lines', 'lineDescriptions', 'deliveryTerms', 'paymentTerms'];
  if (!proof || required.some((field) => !proof.fields.has(field))) return { data, structured: false, reason: 'not-canonical-whole-contract' };
  if (data.title !== item.fields.title || data.introduction !== item.fields.introduction || data.deliveryTerms !== item.fields.deliveryTerms || data.paymentTerms !== item.fields.paymentTerms
    || JSON.stringify(data.lines.map((line) => line.title)) !== JSON.stringify(item.fields.lines)
    || JSON.stringify(data.lines.map((line) => line.description)) !== JSON.stringify(item.fields.lineDescriptions)) throw new Error('Черновик изменён после подготовки исходного состава. Его текст не заменён; повторите передачу текущего результата.');
  const result = await prepareCommercialDocument({ sources, sourceSnapshotKey: input.sourceSnapshotKey });
  if (!result.document || result.limited || result.issues.some((issue) => issue.severity === 'error' || ['commercial-unsupported-envelope', 'commercial-incomplete-text'].includes(issue.code))
    || !result.document.body.sections.some((section) => section.blocks.length)) return { data, structured: false, reason: result.issues[0]?.message || 'unsupported-source-envelope' };
  const line = data.lines.length === 1 ? data.lines[0] : undefined;
  return { data: { ...data, commercialDocument: result.document, ...(line ? { commercialScopeSnapshot: {
    version: 1 as const, lineId: line.id, title: line.title, description: line.description,
    sourceSnapshotKey: result.document.privateAppendix.sourceSnapshotKey, documentId: result.document.privateAppendix.documentId,
  } } : {}) }, structured: true };
}
