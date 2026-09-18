import { describe, expect, it } from "vitest";
import { BUILTIN_TEMPLATES, cloneProposal, createProposal, createProposalLine, nextProposalRevision } from "./defaults";
import { buildProposalPublic, safeProposalFileName, validateProposal } from "./exportPublic";
import { formatMoneyMinor, normalizeDecimal, priceProposal, priceProposalLine } from "./pricing";
import type { ProposalData, ProposalLine } from "./types";
import { sourcePrice } from "./sources";

const line = (patch: Partial<ProposalLine> = {}): ProposalLine => ({ ...createProposalLine(), title: "Работы", unitPrice: "1", ...patch });
function proposal(): ProposalData {
  const data = createProposal(new Date(2030, 0, 1));
  data.title = "Предложение"; data.issuer.name = "Исполнитель"; data.recipient.name = "Заказчик"; data.lines = [line()];
  return data;
}

describe("independent price/DTO review regressions", () => {
  it.each([
    [{ quantity: "0.1", unitPrice: "0.2" }, "2", "0", "2"],
    [{ unitPrice: "0.005" }, "1", "0", "1"],
    [{ unitPrice: "0.0049" }, "0", "0", "0"],
    [{ priceBasis: "net", unitPrice: "0.05", tax: { kind: "vat", rate: 10 } }, "5", "1", "6"],
    [{ priceBasis: "gross", unitPrice: "1", tax: { kind: "vat", rate: 22 } }, "82", "18", "100"],
    [{ quantity: "2.5", unitPrice: "1234.5678", discountPercent: "12.34", tax: { kind: "vat", rate: 20 } }, "225463", "45093", "270556"],
    [{ quantity: "2.5", unitPrice: "1234.5678", discountPercent: "12.34", priceBasis: "net", tax: { kind: "vat", rate: 20 } }, "270556", "54111", "324667"],
    [{ unitPrice: "1234", discountPercent: "100", tax: { kind: "vat", rate: 22 } }, "0", "0", "0"],
  ] as Array<[Partial<ProposalLine>, string, string, string]>)("keeps exact minor units for %j", (input, netMinor, vatMinor, grossMinor) => {
    const priced = priceProposalLine(line(input));
    expect(priced).toMatchObject({ netMinor, vatMinor, grossMinor });
    expect(BigInt(priced.netMinor) + BigInt(priced.vatMinor)).toBe(BigInt(priced.grossMinor));
  });

  it("sums rounded line VAT, not VAT recalculated from the total; keeps zero-rate distinct", () => {
    const input = [line({ priceBasis: "net", unitPrice: "0.05", tax: { kind: "vat", rate: 10 } }), line({ priceBasis: "net", unitPrice: "0.05", tax: { kind: "vat", rate: 10 } }), line({ priceBasis: "net", unitPrice: "0.05", tax: { kind: "vat", rate: 10 } }), line({ tax: { kind: "vat", rate: 0 } }), line()];
    const before = structuredClone(input);
    const { totals } = priceProposal(input);
    expect(totals).toMatchObject({ netMinor: "215", vatMinor: "3", grossMinor: "218" });
    expect(totals.byTax.map((group) => group.tax)).toEqual([{ kind: "vat", rate: 10 }, { kind: "vat", rate: 0 }, { kind: "none" }]);
    expect(input).toEqual(before);
  });

  it("normalizes human input but rejects unsupported precision, exponent, sign and range", () => {
    expect(normalizeDecimal(" 001 234,5600 ", 4)).toBe("1234.56");
    for (const quantity of ["0", "-1", "NaN", "Infinity", "1e3", "1.0000001", "1000000000.000001"])
      expect(() => priceProposalLine(line({ quantity })), quantity).toThrow();
    for (const unitPrice of ["-0.01", "1.00001", "1000000000000.0001", "9e20"])
      expect(() => priceProposalLine(line({ unitPrice })), unitPrice).toThrow();
    for (const discountPercent of ["-1", "100.01", "0.001"])
      expect(() => priceProposalLine(line({ discountPercent })), discountPercent).toThrow();
    expect(() => priceProposal([line({ quantity: "1000000000", unitPrice: "1000000000000" })])).toThrow(/предел/);
    expect(() => priceProposal(Array.from({ length: 1001 }, () => line()))).toThrow(/1000/);
    expect(formatMoneyMinor("9007199254740991")).toBe("90 071 992 547 409,91 ₽");
  });

  it.each([[1.005, "1.01"], [2.675, "2.68"], [1e-7, "0.00"], [5e-3, "0.01"], [1e12, "1000000000000.00"]])("rounds a Number source %s through decimal half-up", (value, expected) => {
    expect(sourcePrice(value as number)).toBe(expected);
  });

  it("rejects a validity date before the proposal date even when both are in the future", () => {
    const data = proposal(); data.documentDate = "2030-02-10"; data.validUntil = "2030-02-01";
    expect(validateProposal(data, { today: "2030-01-01" })).toContainEqual(expect.objectContaining({ field: "validUntil", severity: "error" }));
    expect(() => buildProposalPublic(data)).toThrow(/раньше/);
  });

  it("requires a separate zero-price confirmation without mutating the source", () => {
    const data = proposal(); data.lines[0].discountPercent = "100";
    expect(validateProposal(data).some((issue) => issue.severity === "warning" && issue.message.includes("нулю"))).toBe(true);
    expect(() => buildProposalPublic(data)).toThrow(/нулевой/);
    expect(buildProposalPublic(data, { allowZero: true }).totals.grossMinor).toBe("0");
    expect(data.lines[0].unitPrice).toBe("1");
  });

  it("constructs a deeply detached public whitelist even when nested inputs contain extra internal fields", () => {
    const data = proposal();
    const secret = "INTERNAL-MARKER-9173";
    Object.assign(data, { internalNote: secret, source: { tool: "calculator", capturedAt: secret, wasUnsaved: true, priceOrigin: secret }, privateExtra: secret });
    Object.assign(data.issuer, { companyId: secret, sourceUpdatedAt: secret, privateCost: secret });
    Object.assign(data.contact, { internalNote: secret });
    Object.assign(data.lines[0], { cost: secret, margin: secret, sourceSnapshot: { secret } });
    Object.assign(data.lines[0].tax, { internalExtra: secret });
    Object.assign(data.template.show, { internalExtra: secret });
    Object.assign(data.template, { id: secret, version: 93, name: secret });
    const output = buildProposalPublic(data);
    expect(JSON.stringify(output)).not.toContain(secret);
    expect(Object.keys(output)).not.toContain("internalNote");
    output.issuer.name = "External mutation"; output.layout.show.address = false; output.lines[0].title = "Changed";
    expect(data.issuer.name).toBe("Исполнитель"); expect(data.template.show.address).toBe(true); expect(data.lines[0].title).toBe("Работы");
  });

  it("copies families or creates revisions without aliasing frozen source snapshots", () => {
    const original = proposal(); original.status = "ready"; original.revision = 3;
    const before = structuredClone(original);
    const copy = cloneProposal(original), next = nextProposalRevision(original, 8);
    expect(copy).toMatchObject({ status: "draft", revision: 1 }); expect(copy.familyId).not.toBe(original.familyId); expect(copy.number).not.toBe(original.number);
    expect(next).toMatchObject({ status: "draft", revision: 9, familyId: original.familyId, number: original.number });
    copy.template.show.address = false; next.lines[0].title = "New";
    expect(original).toEqual(before); expect(BUILTIN_TEMPLATES[0].show.address).toBe(true);
  });

  it("uses bounded, path-safe export names", () => {
    const data = proposal(); data.number = '../C:\\secret:*?"'; data.recipient.name = 'Заказчик/'.repeat(50);
    const fileName = safeProposalFileName(data, "docx");
    expect(new TextEncoder().encode(fileName).length).toBeLessThanOrEqual(200); expect(fileName).not.toMatch(/[<>:"/\\|?*\u0000-\u001f]/); expect(fileName).toMatch(/\.docx$/);
    expect(() => safeProposalFileName(data, "exe")).toThrow();
  });
});
