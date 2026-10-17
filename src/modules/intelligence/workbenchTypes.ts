import type { ContractData } from "../contracts/types";
import type { CompanyCard } from "../contracts/companies";
import type { ProcurementData } from "../procurement/types";
import type { ProposalData } from "../proposals/types";
import type { StaffData } from "../staff/types";

export type IntelligenceDestination = "procurement" | "contracts" | "staff" | "counterparties" | "proposals";
export type IntelligenceFieldValue = string | number | boolean | string[];
export type PdfBounds = [left: number, bottom: number, right: number, top: number];
export interface PdfGridRow {
  version: 1;
  page: number;
  /** Describes the extracted text, not OCR accuracy or source completeness. */
  textLayer?: "ocr" | "text";
  bounds: PdfBounds;
  cells: Array<{ bounds: PdfBounds; text: string }>;
}
export interface IntelligenceFragment {
  id?: string;
  locator: string;
  text: string;
  /** Closed vector-grid cells from the same immutable PDF extraction snapshot. */
  pdfGrid?: PdfGridRow;
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
/** A whole certificate row bound to its explicitly named owner. These source
 * facts are candidates, not acknowledgements, files or employment claims. */
export interface IntelligenceStaffDocument {
  id: string;
  ownerFullName: string;
  category: "certificate";
  name: string;
  seriesNumber: string;
  examDate: string;
  reportedValidity: string;
  sourceId: string;
  fragmentId: string;
  headerFragmentId: string;
  quote: string;
  headerQuote: string;
}
export interface IntelligenceItem {
  id: string;
  title: string;
  destination: IntelligenceDestination;
  fields: Record<string, IntelligenceFieldValue>;
  sourceIds: string[];
  selectedFields: string[];
  evidence?: IntelligenceEvidence[];
  staffDocuments?: IntelligenceStaffDocument[];
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
