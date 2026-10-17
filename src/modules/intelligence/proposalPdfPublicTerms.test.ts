import { describe, expect, it } from "vitest";
import { completeProposalPublicTerms, extractProposalPublicTerms, proveProposalPublicTerms } from "./proposalPublicTerms";
import { auditIntelligenceResult, getBlockingEvidenceFindings } from "./resultEvidence";
import { runResponsePreparation } from "./responsePreparationWorker";
import { buildIntelligenceHandoff } from "./workbenchModel";
import type { IntelligenceItem, IntelligenceSource } from "./workbenchTypes";

const validity = "Срок действия коммерческого предложения: 14 календарных дней";
const currency = "Стоимость предложения действительна при официальном курсе доллара США к рублю не выше 90 рублей за 1 доллар США.";
const text = ["С уважением,", validity, currency, "Условия оплаты: 100% предоплата", "КОММЕРЧЕСКОЕ ПРЕДЛОЖЕНИЕ", "В ответ на Ваш запрос предлагаем продукцию."].join("\r\n");
const source = (): IntelligenceSource => ({ id: "pdf", name: "Предложение.pdf", text: "UNSELECTED_AGGREGATE", coverage: { complete: false, requiresOcr: false }, fragments: [{ id: "page-1", locator: "Страница 1", text }] });
const item = (): IntelligenceItem => ({ id: "cp", title: "Поставка", destination: "proposals", fields: { title: "Поставка", internalNote: "PRIVATE" }, selectedFields: ["title", "internalNote"], sourceIds: ["pdf"] });

describe("closed same-page literal PDF proposal conditions", () => {
  it("preserves the whole relative validity and currency cap publicly, never inventing an absolute expiry", () => {
    const sources = [source()], before = structuredClone(sources), original = item();
    const result = completeProposalPublicTerms([original], sources), prepared = result.items[0];
    expect(prepared.fields.deliveryTerms).toBe(`${validity}\n${currency}`);
    expect(prepared.fields.validUntil).toBeUndefined();
    expect(prepared.fields.internalNote).toBe("PRIVATE");
    expect(proveProposalPublicTerms(prepared, result.items, sources)).toBeTruthy();
    const report = auditIntelligenceResult(result.items, sources);
    expect(report.fields.find((entry) => entry.field === "deliveryTerms")?.status).toBe("confirmed");
    expect(getBlockingEvidenceFindings(report, prepared).some((entry) => entry.code === "incomplete-source-coverage")).toBe(true);
    const handoff = buildIntelligenceHandoff(prepared, sources, "/synthetic/qa");
    if (handoff.destination !== "proposals") throw new Error("Wrong destination");
    expect(handoff.data.deliveryTerms).toBe(`${validity}\n${currency}`);
    expect(handoff.data.validUntil).toBe("");
    expect(sources).toEqual(before); expect(original.fields.deliveryTerms).toBeUndefined();
  });
  it("also applies to a parsed fresh-style response without acknowledging source warnings", () => {
    const sources = [source()], raw = JSON.stringify({ items: [{ title: "Поставка", destination: "proposals", fields: { title: "Поставка" }, sourceIds: ["pdf"], positions: [] }] });
    const result = runResponsePreparation({ revision: 1, sources, raw, destinations: ["proposals"] });
    expect(result.failed).toBeUndefined();
    expect(result.prepared!.items[0].fields.deliveryTerms).toBe(`${validity}\n${currency}`);
    expect(result.prepared).not.toHaveProperty("reviewedFindings");
  });
  it.each([
    ["missing closing payment", text.replace("Условия оплаты: 100% предоплата", "")],
    ["noncontiguous clauses", text.replace(currency, `Не связанная строка\r\n${currency}`)],
    ["second proposal", `${text}\r\nКОММЕРЧЕСКОЕ ПРЕДЛОЖЕНИЕ №2`],
    ["another document", `${text}\r\nДОГОВОР`],
    ["truncated cap", text.replace(currency, currency.slice(0, -1))],
  ])("does not transfer an ambiguous or incomplete block: %s", (_name, changed) => {
    const sources = [source()]; sources[0].fragments![0].text = changed;
    expect(extractProposalPublicTerms(sources).sections).toHaveLength(0);
    expect(completeProposalPublicTerms([item()], sources).items[0].fields.deliveryTerms).toBeUndefined();
  });
  it("rejects a hidden page even if opted in, mismatched locator, duplicate ID, and multi-page scope", () => {
    const variants = [source(), source(), source(), source()];
    variants[0].fragments![0].sheetState = "hidden"; variants[0].fragments![0].includedByUser = true;
    variants[1].fragments![0].locator = "Страница 2";
    variants[2].fragments!.push({ ...variants[2].fragments![0] });
    variants[3].fragments!.push({ id: "page-2", locator: "Страница 2", text: "Дополнение" });
    for (const candidate of variants) expect(extractProposalPublicTerms([candidate]).sections).toHaveLength(0);
  });
  it("keeps an unproven public prefix blocked instead of laundering it through two real clauses", () => {
    const original = item(); original.fields.deliveryTerms = "Доставка завтра без ограничений.";
    const sources = [source()], result = completeProposalPublicTerms([original], sources);
    expect(result.items[0].fields.deliveryTerms).toContain(original.fields.deliveryTerms);
    expect(proveProposalPublicTerms(result.items[0], result.items, sources)).toBeUndefined();
    expect(auditIntelligenceResult(result.items, sources).fields.find((entry) => entry.field === "deliveryTerms")?.status).not.toBe("confirmed");
  });
  it("does not distribute one source's clauses between two proposals", () => {
    const result = completeProposalPublicTerms([item(), { ...item(), id: "cp-2" }], [source()]);
    expect(result.items.every((entry) => entry.fields.deliveryTerms === undefined)).toBe(true);
    expect(result.skipped).toHaveLength(2);
  });
});
