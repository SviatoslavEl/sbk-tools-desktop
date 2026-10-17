import { describe, expect, it } from "vitest";
import { auditIntelligenceResult, getBlockingEvidenceFindings } from "./resultEvidence";
import { completeProposalPublicTerms, proveProposalPublicTerms } from "./proposalPublicTerms";
import type { IntelligenceItem, IntelligenceSource } from "./workbenchTypes";
const scope = "Дополнительные работы за рамками согласованного периметра проекта могут быть предметом отдельного согласования;";
const schedule = "Состав проектной команды уточняется на этапе запуска проекта с учетом доступности участников.";
const relative = "90 календарных дней с даты исходящего письма.";
const source = (): IntelligenceSource => ({ id: "source", name: "Публичные условия QA", text: "Агрегат не используется", fragments: ["Коммерческое предложение", "Оговорки:", scope, schedule, "Срок действия предложения:", relative, "С уважением,"].map((text, index) => ({ id: `paragraph-${index + 1}`, locator: `Абзац ${index + 1}`, text })) });
const card = (): IntelligenceItem => ({ id: "card", destination: "proposals", title: "Аудит QA", fields: {}, sourceIds: ["source"], selectedFields: [], evidence: [] });
const prepared = (input: IntelligenceSource) => completeProposalPublicTerms([card()], [input]).items[0];
const blockers = (item: IntelligenceItem, sources: IntelligenceSource[], items = [item]) => getBlockingEvidenceFindings(auditIntelligenceResult(items, sources), item).filter((finding) => finding.field === "deliveryTerms");
describe("strict whole public delivery terms evidence", () => {
  it("confirms every owned literal clause and role claim, without ACK or legal/completeness promises", () => {
    const input = source(), item = prepared(input), report = auditIntelligenceResult([item], [input]);
    expect(report.fields.find((entry) => entry.field === "deliveryTerms")?.status).toBe("confirmed"); expect(blockers(item, [input])).toEqual([]);
    expect(item).not.toHaveProperty("reviewedFindings"); expect(proveProposalPublicTerms(item, [item], [input])?.claims.size).toBe(6);
  });
  it.each(["unproven-prefix", "changed-number", "dropped-clause", "reordered", "first-clause-only", "missing-clause-proof", "missing-heading-proof", "missing-cp-proof", "stale-source", "foreign-claim", "hidden", "gap", "sheet", "two-owners", "duplicate-source"])("does not confirm a correct subset when %s is present", (variant) => {
    const input = source(), item = prepared(input), sources = [input], items = [item];
    if (variant === "unproven-prefix") item.fields.deliveryTerms = `Нет подтверждения этому сроку.\n${item.fields.deliveryTerms}`;
    if (variant === "changed-number") item.fields.deliveryTerms = String(item.fields.deliveryTerms).replace("90", "89");
    if (variant === "dropped-clause") item.fields.deliveryTerms = String(item.fields.deliveryTerms).replace(`${scope}\n`, "");
    if (variant === "reordered") item.fields.deliveryTerms = String(item.fields.deliveryTerms).replace(`${scope}\n${schedule}`, `${schedule}\n${scope}`);
    if (variant === "first-clause-only") { item.fields.deliveryTerms = scope; item.evidence = item.evidence!.filter((claim) => claim.quote === scope); }
    if (variant === "missing-clause-proof") item.evidence = item.evidence!.filter((claim) => claim.quote !== relative);
    if (variant === "missing-heading-proof") item.evidence = item.evidence!.filter((claim) => claim.quote !== "Оговорки:");
    if (variant === "missing-cp-proof") item.evidence = item.evidence!.filter((claim) => claim.quote !== "Коммерческое предложение");
    if (variant === "stale-source") item.sourceIds = ["old-source"];
    if (variant === "foreign-claim") item.evidence![0].sourceId = "foreign";
    if (variant === "hidden") { input.fragments![2].sheetState = "hidden"; input.fragments![2].includedByUser = true; }
    if (variant === "gap") { input.fragments![2].id = "paragraph-20"; input.fragments![2].locator = "Абзац 20"; }
    if (variant === "sheet") input.fragments![2].sheetId = "other";
    if (variant === "two-owners") items.push({ ...card(), id: "other" });
    if (variant === "duplicate-source") sources.push(structuredClone(input));
    expect(proveProposalPublicTerms(item, items, sources)).toBeUndefined(); expect(blockers(item, sources, items).length).toBeGreaterThan(0);
  });
  it("retains a meaningful old prefix when auto-appending and leaves it blocking", () => {
    const input = source(), item = card(); item.fields.deliveryTerms = "Поставка через один день."; item.selectedFields = ["deliveryTerms"];
    const current = completeProposalPublicTerms([item], [input]).items[0]; expect(String(current.fields.deliveryTerms)).toMatch(/^Поставка через один день\./u); expect(blockers(current, [input]).length).toBeGreaterThan(0);
  });
  it.each([scope, `${scope}\n${schedule}\n${relative}`])("accepts a canonicalized complete source-only body without a false public-terms block: %s", (previous) => {
    const input = source(), item = card(); item.fields.deliveryTerms = previous; item.selectedFields = ["deliveryTerms"];
    const result = completeProposalPublicTerms([item], [input]), current = result.items[0];
    expect(current.fields.deliveryTerms).toBe(["Оговорки:", scope, schedule, "Срок действия предложения:", relative].join("\n"));
    expect(result.changes[0].previousValue).toBe(previous); expect(blockers(current, [input])).toEqual([]);
  });
  it("does not change the earlier contract for ordinary single literal delivery or payment text", () => {
    const input = source(); input.fragments!.push({ id: "paragraph-8", locator: "Абзац 8", text: "Поставка оборудования через 12 дней." }, { id: "paragraph-9", locator: "Абзац 9", text: "100% предоплата" });
    const item = card(); item.fields = { deliveryTerms: "Поставка оборудования через 12 дней.", paymentTerms: "100% предоплата" }; item.selectedFields = ["deliveryTerms", "paymentTerms"];
    const report = auditIntelligenceResult([item], [input]); expect(report.fields.find((field) => field.field === "deliveryTerms")?.status).toBe("confirmed"); expect(report.fields.find((field) => field.field === "paymentTerms")?.status).toBe("confirmed");
  });
});
