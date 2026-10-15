import type { ContractData } from "../contracts/types";
import type { CompanyCard } from "../contracts/companies";
import type { ProcurementData } from "../procurement/types";
import type { ProposalData } from "../proposals/types";
import type { StaffData } from "../staff/types";

export type IntelligenceDestination = "procurement" | "contracts" | "staff" | "counterparties" | "proposals";
export type IntelligenceFieldValue = string | number | boolean | string[];
export interface IntelligenceFragment {
  id?: string;
  locator: string;
  text: string;
  sheetId?: string;
  sheetState?: "visible" | "hidden" | "veryHidden";
  /** Explicit opt-in for hidden sheets; false on visible sheets means default inclusion. */
  includedByUser?: boolean;
}
export interface IntelligenceEvidence {
  field: string;
  sourceId: string;
  fragmentId?: string;
  quote: string;
}
export interface IntelligenceSource {
  id: string;
  name: string;
  text: string;
  sha256?: string;
  fragments?: IntelligenceFragment[];
  warnings?: string[];
  coverage?: { complete: boolean; requiresOcr: boolean; pagesWithoutText?: number[]; pagesWithImages?: number[] };
}
export interface IntelligenceItem {
  id: string;
  title: string;
  destination: IntelligenceDestination;
  fields: Record<string, IntelligenceFieldValue>;
  sourceIds: string[];
  selectedFields: string[];
  evidence?: IntelligenceEvidence[];
}
export interface IntelligenceFieldDefinition {
  key: string;
  label: string;
  kind: "text" | "number" | "date" | "list" | "choice";
  options?: readonly string[];
  maxLength?: number;
}
export type IntelligenceHandoff = { id: string; workspaceRoot: string; provenance: string } & (
  | { destination: "procurement"; data: ProcurementData }
  | { destination: "contracts"; data: ContractData }
  | { destination: "staff"; data: StaffData }
  | { destination: "counterparties"; data: CompanyCard }
  | { destination: "proposals"; data: ProposalData }
);
