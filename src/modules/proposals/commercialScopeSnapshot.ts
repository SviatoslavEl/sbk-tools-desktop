import { COMMERCIAL_DOCUMENT_LIMITS, isCommercialId, isCommercialSha256, validateCommercialDocument } from './commercialDocument';
import type { ProposalData } from './types';

type ScopeSnapshotInput = Readonly<Pick<ProposalData, 'lines' | 'commercialDocument' | 'commercialScopeSnapshot'>>;
const receiptFields = ['version', 'lineId', 'title', 'description', 'sourceSnapshotKey', 'documentId'];
const plainObject = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
const receiptText = (value: unknown): value is string => typeof value === 'string' && Boolean(value.trim())
  && Array.from(value).length <= COMMERCIAL_DOCUMENT_LIMITS.element
  && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)
  && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);

/** A private canonical-handoff receipt identifies an inherited, inactive line
 * snapshot. It is not a price approval or a statement that the current body is
 * ready for a customer. A mismatch preserves the line description; it never
 * tries to infer ownership from a financial candidate or service-like words.
 * Presentation callers separately decide whether the description is long
 * enough to need a full-width body reference. */
export function hasFreshCommercialScopeSnapshot(data: ScopeSnapshotInput): boolean {
  try {
    const receipt: unknown = data.commercialScopeSnapshot;
    if (!plainObject(receipt) || Object.keys(receipt).length !== receiptFields.length
      || !receiptFields.every((field) => Object.prototype.hasOwnProperty.call(receipt, field))
      || receipt.version !== 1 || !isCommercialId(receipt.lineId) || !isCommercialId(receipt.documentId)
      || !isCommercialSha256(receipt.sourceSnapshotKey) || !receiptText(receipt.title) || !receiptText(receipt.description)
      || !Array.isArray(data.lines) || data.lines.length !== 1) return false;
    const line = data.lines[0], document = data.commercialDocument;
    if (!line || line.id !== receipt.lineId || line.title !== receipt.title || line.description !== receipt.description
      || !document || validateCommercialDocument(document).some((issue) => issue.severity === 'error')) return false;
    const appendix = document.privateAppendix;
    if (appendix.sourceSnapshotKey !== receipt.sourceSnapshotKey || appendix.documentId !== receipt.documentId
      || !appendix.containers.some((container) => container.kind === 'contract' && Boolean(container.heading.trim())
        && appendix.clauses.some((clause) => clause.containerId === container.id && clause.sourceId === container.sourceId && Boolean(clause.quote.trim())))) return false;
    const meaningful = (parts: Array<{ kind: string; text?: string }>) => parts.some((part) => part.kind === 'text' && Boolean(part.text?.trim()));
    return document.body.sections.some((section) => ['scope', 'perimeter', 'deliverables'].includes(section.kind) && section.blocks.some((block) => {
      if (block.kind === 'paragraph') return meaningful(block.content);
      if (block.kind === 'list') return block.items.some(meaningful);
      return block.rows.some((row) => row.some(meaningful));
    }));
  } catch {
    // Damaged persisted input is not authority to hide customer-facing text.
    return false;
  }
}
