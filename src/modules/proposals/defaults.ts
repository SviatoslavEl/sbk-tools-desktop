import type { PartySnapshot, ProposalContact, ProposalData, ProposalLine, ProposalTemplate } from './types';

export function emptyParty(): PartySnapshot {
  return { name: '', shortName: '', inn: '', kpp: '', ogrn: '', address: '', contact: '', paymentDetails: '' };
}
export function emptyContact(): ProposalContact { return { fullName: '', position: '', phone: '', email: '' }; }
export function localDate(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
export const BUILTIN_TEMPLATES: readonly ProposalTemplate[] = [
  { schemaVersion: 1, id: 'builtin-standard', version: 1, name: 'Стандартный', style: 'standard', accentColor: '#245C48', show: { address: true, requisites: true, contact: true, signer: true }, introduction: '', conclusion: '', footer: '' },
  { schemaVersion: 1, id: 'builtin-compact', version: 1, name: 'Краткий', style: 'compact', accentColor: '#245C48', show: { address: true, requisites: true, contact: true, signer: true }, introduction: '', conclusion: '', footer: '' },
];
export function createProposalLine(): ProposalLine {
  return { id: crypto.randomUUID(), title: '', description: '', unit: 'усл.', quantity: '1', unitPrice: '', priceBasis: 'gross', discountPercent: '0', tax: { kind: 'none' } };
}
export function createProposal(now = new Date()): ProposalData {
  const familyId = crypto.randomUUID();
  const validUntil = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 30);
  return { kind: 'proposal', schemaVersion: 1, number: `КП-${localDate(now).replace(/-/g, '')}-${familyId.slice(0, 6)}`, documentDate: localDate(now), title: '', validUntil: localDate(validUntil), currency: 'RUB', status: 'draft', revision: 1, familyId, issuer: emptyParty(), recipient: emptyParty(), addressee: emptyContact(), contact: emptyContact(), lines: [createProposalLine()], deliveryTerms: '', paymentTerms: '', introduction: '', conclusion: '', attachments: [], template: structuredClone(BUILTIN_TEMPLATES[0]), internalNote: '' };
}
export function cloneProposal(source: ProposalData): ProposalData {
  const fresh = createProposal();
  return { ...structuredClone(source), familyId: fresh.familyId, number: fresh.number, documentDate: fresh.documentDate, validUntil: fresh.validUntil, revision: 1, status: 'draft' };
}
export function nextProposalRevision(source: ProposalData, maxRevision = source.revision): ProposalData {
  return { ...structuredClone(source), revision: Math.max(source.revision, maxRevision) + 1, status: 'draft' };
}
