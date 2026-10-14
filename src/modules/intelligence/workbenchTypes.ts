import type { ContractData } from "../contracts/types";
import type { CompanyCard } from "../contracts/companies";
import type { ProcurementData } from "../procurement/types";
import type { ProposalData } from "../proposals/types";
import type { StaffData } from "../staff/types";

export type IntelligenceDestination = "procurement" | "contracts" | "staff" | "counterparties" | "proposals";
export type IntelligenceFieldValue = string | number | boolean | string[];
export interface IntelligenceSource {
  id: string;
  name: string;
  text: string;
  sha256?: string;
  fragments?: Array<{ locator: string; text: string }>;
}
export interface IntelligenceItem {
  id: string;
  title: string;
  destination: IntelligenceDestination;
  fields: Record<string, IntelligenceFieldValue>;
  sourceIds: string[];
  selectedFields: string[];
}
export interface IntelligenceFieldDefinition {
  key: string;
  label: string;
  kind: "text" | "number" | "date" | "list" | "choice";
  options?: readonly string[];
}
export type IntelligenceHandoff = { id: string; workspaceRoot: string; provenance: string } & (
  | { destination: "procurement"; data: ProcurementData }
  | { destination: "contracts"; data: ContractData }
  | { destination: "staff"; data: StaffData }
  | { destination: "counterparties"; data: CompanyCard }
  | { destination: "proposals"; data: ProposalData }
);
