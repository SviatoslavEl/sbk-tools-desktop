import type { IntelligenceSource } from './workbenchTypes';
import type { ProposalArea, ProposalAreaSchemaCarrier } from './proposalAreaPlan';

export const CONTRACT_FACT_LIMITS = Object.freeze({ sources: 16, owners: 4096, units: 4096, frames: 64,
  unitCharacters: 256, unitsPerFrame: 8, contextUnits: 128, sourcePayloadBytes: 48 * 1024,
  factsPerUnit: 12, questionsPerUnit: 2, textCharacters: 2000, listItems: 12,
  rawBytes: 2 * 1024 * 1024, planBytes: 8 * 1024 * 1024 });
export const CONTRACT_FACT_PROTOCOL = 'source-unit-facts-v1';
export const CONTRACT_FACT_KINDS = ['party', 'work', 'deliverable', 'facet', 'constraint', 'input', 'event', 'schedule', 'right', 'administrative', 'other', 'price', 'vat', 'payment'] as const;
export type ContractFactKind = typeof CONTRACT_FACT_KINDS[number];
export interface ContractFactOwner {
  readonly id: string; readonly sourceId: string; readonly fragmentId: string | null; readonly fragmentIndex: number; readonly locator: string;
  readonly text: string; readonly native: unknown;
  readonly cells: readonly { readonly index: number; readonly text: string }[] | null;
}
/** UTF-16 boundaries are reversible and never split surrogate pairs. Native
 * cell indices are retained, including empty cells. No business classification. */
export interface ContractFactUnit {
  readonly id: string; readonly ownerId: string; readonly cellIndex: number | null;
  readonly offsetUnit: 'utf16-code-unit';
  readonly address: { readonly sourceId: string; readonly fragmentId: string | null; readonly fragmentIndex: number;
    readonly part: string | null; readonly containerId: string | null; readonly order: number | null; readonly cellIndex: number | null };
  readonly start: number; readonly end: number; readonly text: string;
}
export interface ContractFactOptions { instruction?: string; schemaCarrier?: ProposalAreaSchemaCarrier; responseTokenBudget?: number | null; unitsPerFrame?: number }
export interface ContractFactFrame {
  readonly id: string; readonly index: number; readonly unitIds: readonly string[]; readonly contextUnitIds: readonly string[];
  readonly ownerIds: readonly string[]; readonly payload: string; readonly prompt: string;
  readonly responseSchema: Readonly<Record<string, unknown>>;
}
export interface ContractFactPlan {
  readonly version: 1; readonly protocol: typeof CONTRACT_FACT_PROTOCOL; readonly planKey: string;
  readonly sourceSnapshotKey: string; readonly structureSnapshotKey: string;
  readonly options: Required<ContractFactOptions>; readonly sources: readonly IntelligenceSource[];
  readonly owners: readonly ContractFactOwner[]; readonly units: readonly ContractFactUnit[]; readonly blocks: readonly ContractFactFrame[];
  readonly coverage: { readonly owners: number; readonly units: number; readonly nativeCells: number; readonly wholeProvidedSnapshot: true;
    readonly originalFileCompleteness: 'producer-reported-or-unknown-not-independently-attested' };
}
export interface ContractFactEvidence { unitId: string; quote: string }
export interface ContractPartyData {
  name: string | null; role: 'contractor' | 'customer' | 'other' | 'unknown'; roleDescription: string | null;
  representatives: { name: string | null; title: string | null; authority: string | null }[];
}
export interface ContractClauseData {
  actor: string | null; action: string | null; object: string | null;
  conditions: string[]; triggers: string[]; timing: string[]; notices: string[]; alternatives: string[]; inputs: string[]; outputs: string[];
}
export interface ContractFinanceData {
  amount: string | null; currency: string | null; vatRate: string | null; vatTreatment: string | null;
  share: string | null; payer: string | null; payee: string | null; trigger: string | null; timing: string | null;
  conditions: string[]; alternatives: string[];
}
/** Every value is model-declared. Literal evidence validates attribution only;
 * no source text is copied into data or used to complete missing fields. */
export interface ContractFact {
  kind: ContractFactKind; data: ContractPartyData | ContractClauseData | ContractFinanceData;
  evidence: ContractFactEvidence[];
  links: { targetUnitId: string | null; sourceReference: string; relation: 'governs' | 'depends-on' | 'exception' | 'same-party' | 'refers-to' }[];
}
export interface ContractSourceQuestion {
  area: ProposalArea; question: string; basis: 'explicit-source-open-item'; evidence: ContractFactEvidence[];
}
export interface ContractUnitFacts {
  unitId: string; status: 'facts' | 'not-relevant' | 'unclear' | 'empty'; facts: ContractFact[];
  /** Model uncertainty stays internal. It never becomes a customer question. */
  uncertainties: string[]; questions: ContractSourceQuestion[];
}
export interface ContractFactResponse {
  readonly version: 1; readonly protocol: typeof CONTRACT_FACT_PROTOCOL; readonly planKey: string; readonly blockId: string;
  readonly units: readonly ContractUnitFacts[];
  readonly raw: string;
}
export interface ContractFactReviewPlan {
  readonly version: 1; readonly protocol: typeof CONTRACT_FACT_PROTOCOL; readonly planKey: string; readonly blockId: string;
  readonly reviewPlanKey: string; readonly extraction: ContractFactResponse;
  readonly prompt: string; readonly responseSchema: Readonly<Record<string, unknown>>;
}
export interface ContractFactReviewResponse {
  readonly version: 1; readonly protocol: typeof CONTRACT_FACT_PROTOCOL; readonly planKey: string; readonly blockId: string; readonly reviewPlanKey: string;
  /** Revised values must themselves come from the new model raw. */
  readonly units: readonly ContractUnitFacts[];
  readonly issues: readonly { unitId: string; kind: 'omission' | 'unsupported' | 'classification' | 'relation' | 'uncertain'; reason: string; evidence: ContractFactEvidence[] }[];
  readonly raw: string;
}
export interface ContractFactRecord { readonly extraction: ContractFactResponse; readonly reviewPlan: ContractFactReviewPlan; readonly review: ContractFactReviewResponse }
