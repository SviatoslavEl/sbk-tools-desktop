import { describe, expect, it } from 'vitest';
import { createProposal, createProposalLine, cloneProposal, nextProposalRevision } from './defaults';
import { buildProposalPublic, safeProposalFileName, validateProposal } from './exportPublic';
import { formatMoneyMinor, normalizeDecimal, priceProposal } from './pricing';
import type { ProposalLine } from './types';

function line(patch: Partial<ProposalLine> = {}): ProposalLine { return { ...createProposalLine(), title: 'Услуга', unitPrice: '120', ...patch }; }
function fixture() {
  const proposal = createProposal(new Date(2030, 0, 1)); proposal.title = 'Внедрение';
  proposal.issuer.name = 'Исполнитель'; proposal.recipient.name = 'Заказчик'; proposal.lines = [line()];
  return proposal;
}
describe('proposal-pricing/1', () => {
  it.each([
    [{ priceBasis: 'net', tax: { kind: 'vat', rate: 20 }, unitPrice: '100' }, ['10000', '2000', '12000']],
    [{ priceBasis: 'gross', tax: { kind: 'vat', rate: 20 } }, ['10000', '2000', '12000']],
    [{ quantity: '0.1', unitPrice: '0.2' }, ['2', '0', '2']],
    [{ quantity: '3', unitPrice: '0.005' }, ['2', '0', '2']],
    [{ discountPercent: '100', tax: { kind: 'vat', rate: 22 } }, ['0', '0', '0']],
    [{ quantity: '1.234567', unitPrice: '100.1234', discountPercent: '12.34', priceBasis: 'net', tax: { kind: 'vat', rate: 5 } }, ['10836', '542', '11378']],
  ] as const)('uses exact decimal and half-up amounts: %o', (patch, expected) => {
    const result = priceProposal([line(patch)]).totals;
    expect([result.netMinor, result.vatMinor, result.grossMinor]).toEqual(expected);
  });
  it('sums rounded lines and separates no VAT from 0%', () => {
    const result = priceProposal([line({ unitPrice: '0.005' }), line({ unitPrice: '0.005', tax: { kind: 'vat', rate: 0 } }), line({ unitPrice: '0.05', tax: { kind: 'vat', rate: 20 } })]);
    expect(result.totals.grossMinor).toBe('7'); expect(result.totals.vatMinor).toBe('1'); expect(result.totals.byTax).toHaveLength(3);
  });
  it.each(['NaN', 'Infinity', '1e5', '-1', '', '1.2.3', '0xFF'])('rejects invalid monetary input %s', (unitPrice) => expect(() => priceProposal([line({ unitPrice })])).toThrow());
  it('enforces precision, quantity, discounts, bounded money and maximum rows', () => {
    for (const patch of [{ quantity: '0' }, { quantity: '1.0000001' }, { unitPrice: '0.00001' }, { discountPercent: '100.01' }, { quantity: '1000000000', unitPrice: '1000000000000' }]) expect(() => priceProposal([line(patch)])).toThrow();
    expect(() => priceProposal(Array.from({ length: 1001 }, () => line()))).toThrow();
    expect(priceProposal(Array.from({ length: 1000 }, () => line())).totals.grossMinor).toBe('12000000');
  });
  it('normalizes spaces, decimal comma and leading zeros without float', () => {
    expect(normalizeDecimal(' 01 234,5000 ', 4)).toBe('1234.5'); expect(formatMoneyMinor('12345678901')).toBe('123 456 789,01 ₽');
  });
});
describe('public proposal boundary', () => {
  it('exports no private source IDs, notes, paths, template IDs or extra properties', () => {
    const proposal = fixture();
    proposal.internalNote = 'SECRET_INTERNAL'; proposal.source = { tool: 'calculator', capturedAt: 'SECRET_CAPTURE', wasUnsaved: true, priceOrigin: 'SECRET_ORIGIN', recordId: 'SECRET_RECORD' };
    proposal.issuer.companyId = 'SECRET_COMPANY'; proposal.recipient.sourceUpdatedAt = 'SECRET_DATE';
    proposal.template.id = 'SECRET_TEMPLATE';
    Object.assign(proposal.lines[0], { cost: 'SECRET_COST' });
    const output = JSON.stringify(buildProposalPublic(proposal)); expect(output).not.toContain('SECRET_');
    expect(JSON.parse(output).totals.grossMinor).toBe('12000');
  });
  it('requires explicit zero total confirmation', () => {
    const proposal = fixture(); proposal.lines[0].discountPercent = '100';
    expect(() => buildProposalPublic(proposal)).toThrow(/Подтвердите/);
    expect(buildProposalPublic(proposal, { allowZero: true }).totals.grossMinor).toBe('0');
  });
  it('blocks expiry earlier than document date even in the future', () => {
    const proposal = fixture(); proposal.documentDate = '2030-02-10'; proposal.validUntil = '2030-02-01';
    expect(validateProposal(proposal).some((issue) => issue.field === 'validUntil' && issue.severity === 'error')).toBe(true);
    expect(() => buildProposalPublic(proposal)).toThrow();
  });
  it('uses independent copied snapshots and commercial revisions', () => {
    const proposal = fixture(); const copy = cloneProposal(proposal); const revision = nextProposalRevision(proposal, 5);
    expect(copy.familyId).not.toBe(proposal.familyId); expect(copy.revision).toBe(1); expect(revision.familyId).toBe(proposal.familyId); expect(revision.revision).toBe(6);
    revision.issuer.name = 'Изменено'; expect(proposal.issuer.name).toBe('Исполнитель');
  });
  it('rejects invalid dates and strips forbidden filename characters', () => {
    const proposal = fixture(); proposal.documentDate = '2030-02-30'; expect(validateProposal(proposal).some((issue) => issue.field === 'documentDate')).toBe(true);
    proposal.number = '../A:*?'; expect(safeProposalFileName(proposal, 'pdf')).not.toMatch(/[/\\:*?]/);
    proposal.number = 'Я😀'.repeat(200);
    expect(new TextEncoder().encode(safeProposalFileName(proposal, 'docx')).length).toBeLessThanOrEqual(200);
  });
});
