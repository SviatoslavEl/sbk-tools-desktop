import type { AttachmentInfo } from '../../lib/storage';

export type DecimalText = string;
export type ProposalStatus = 'draft' | 'ready' | 'sent' | 'accepted' | 'rejected';
export const VAT_RATES = [0, 5, 7, 10, 11, 20, 22] as const;
export type Tax = { kind: 'none' } | { kind: 'vat'; rate: typeof VAT_RATES[number] };
export interface PartySnapshot {
  companyId?: string; sourceUpdatedAt?: string;
  name: string; shortName: string; inn: string; kpp: string; ogrn: string;
  address: string; contact: string; paymentDetails: string;
}
export interface ProposalContact { fullName: string; position: string; phone: string; email: string }
export interface ProposalSigner extends ProposalContact {
  basis: string; issuedAt: string; expiresAt: string; sourceSignerId?: string;
}
export interface ProposalLine {
  id: string; title: string; description: string; unit: string;
  quantity: DecimalText; unitPrice: DecimalText; priceBasis: 'gross' | 'net';
  discountPercent: DecimalText; tax: Tax;
}
export interface ProposalSource {
  tool: 'calculator' | 'procurement'; recordId?: string; sourceRevision?: string;
  capturedAt: string; wasUnsaved: boolean; priceOrigin: string;
}
export interface ProposalTemplate {
  schemaVersion: 1; id: string; version: number; name: string;
  style: 'standard' | 'compact'; accentColor: string; logo?: AttachmentInfo;
  show: { address: boolean; requisites: boolean; contact: boolean; signer: boolean };
  introduction: string; conclusion: string; footer: string;
  deliveryTerms?: string; paymentTerms?: string;
}
export interface ProposalTemplateData extends ProposalTemplate { kind: 'template' }
export interface ProposalData {
  kind: 'proposal'; schemaVersion: 1; number: string; documentDate: string;
  title: string; validUntil: string; currency: 'RUB'; status: ProposalStatus;
  revision: number; familyId: string; issuer: PartySnapshot; recipient: PartySnapshot;
  addressee: ProposalContact; contact: ProposalContact; signer?: ProposalSigner;
  lines: ProposalLine[]; deliveryTerms: string; paymentTerms: string;
  introduction: string; conclusion: string; attachments: AttachmentInfo[];
  template: ProposalTemplate; source?: ProposalSource; internalNote: string;
}
export interface PublicLine {
  title: string; description: string; unit: string; quantity: DecimalText;
  unitPrice: DecimalText; priceBasis: 'gross' | 'net'; discountPercent: DecimalText;
  tax: Tax; netMinor: string; vatMinor: string; grossMinor: string;
}
export interface TaxTotal { tax: Tax; netMinor: string; vatMinor: string; grossMinor: string }
export interface PublicTotals {
  pricingVersion: 'proposal-pricing/1'; netMinor: string; vatMinor: string;
  grossMinor: string; byTax: TaxTotal[];
}
export interface PublicAsset { fileName: string; sizeBytes: number; sha256: string; mimeType: string }
export interface PublicTerms { delivery: string; payment: string; introduction: string; conclusion: string }
export interface PublicLayout {
  style: 'standard' | 'compact'; accentColor: string; logo?: PublicAsset;
  show: ProposalTemplate['show']; footer: string;
}
export interface ProposalPublicDocument {
  schemaVersion: 1; number: string; revision: number; documentDate: string;
  title: string; validUntil: string; currency: 'RUB';
  issuer: Omit<PartySnapshot, 'companyId' | 'sourceUpdatedAt'>;
  recipient: Omit<PartySnapshot, 'companyId' | 'sourceUpdatedAt'>;
  addressee: ProposalContact; contact: ProposalContact;
  signer?: Omit<ProposalSigner, 'sourceSignerId'>;
  lines: PublicLine[]; totals: PublicTotals; terms: PublicTerms;
  layout: PublicLayout; attachments: PublicAsset[];
}
export interface ProposalIssue {
  field: string; step: 1 | 2 | 3 | 4 | 5;
  severity: 'error' | 'warning'; message: string; lineId?: string;
}
export type ProposalRenderFormat = 'docx' | 'pdf' | 'zip' | 'preview';
export interface ProposalRenderResult {
  outputPath: string; outputBytes: number; sha256: string;
  pageCount?: number; previewPages?: string[];
}
