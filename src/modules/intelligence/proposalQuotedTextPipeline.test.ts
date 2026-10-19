import { describe, expect, it } from "vitest";
import { buildProposalPublic } from "../proposals/exportPublic";
import { auditIntelligenceResult } from "./resultEvidence";
import { applyProposalQuotedText, previewProposalQuotedText } from "./proposalQuotedText";
import { runResponsePreparation } from "./responsePreparationWorker";
import { buildIntelligenceHandoff } from "./workbenchModel";
import type { IntelligenceSource } from "./workbenchTypes";

// Synthetic production-schema response, NOT a conversion of the diagnostic
// frames, an actual model call, native Save/reopen or rendered DOCX/PDF proof.
const quote = "По согласованию сторон выдать результат на основе представленных материалов. При этом услуги оплачиваются в полном размере.";
const short = "Услуги оплачиваются в полном размере";

describe("explicit quotation adoption through the ordinary proposal pipeline", () => {
  it.each(["paymentTerms", "deliveryTerms"])("retains full %s through preparation, human repair, draft serialization and public DTO, without rewriting raw", field => {
    const sources: IntelligenceSource[] = [{ id: "s", name: "PRIVATE_SOURCE_CANARY", text: quote, fragments: [{ id: "condition", locator: "Условие", text: quote }] }];
    const raw = JSON.stringify({ items: [{ destination: "proposals", title: "Исследование системы", sourceIds: ["s"], fields: { title: "Исследование системы", [field]: short }, positions: [{ name: "Исследование системы", description: "Проверка выбранного периметра" }], evidence: [{ field, sourceId: "s", fragmentId: "condition", quote }] }] });
    const before = structuredClone({ raw, sources });
    const reply = runResponsePreparation({ revision: 1, raw, sources, destinations: ["proposals"] });
    expect(reply.failed).toBeUndefined(); const item = reply.prepared!.items[0];
    expect(item.fields[field]).toBe(short);
    expect(auditIntelligenceResult([item], sources).fields.find(entry => entry.field === field)?.status).toBe("unverified");
    const contribution = structuredClone(reply.modelContribution);
    const preview = previewProposalQuotedText(item, field, sources);
    const patch = applyProposalQuotedText(item, field, sources, { previousValue: short, value: preview.value, sourceSnapshot: preview.sourceSnapshot });
    const repaired = { ...item, ...patch };
    expect(repaired.fields[field]).toBe(quote); expect(item.fields[field]).toBe(short);
    expect(reply.modelContribution).toEqual(contribution); // Not model semantic PASS.
    const draft = buildIntelligenceHandoff(repaired, sources, "/private/synthetic-workspace");
    if (draft.destination !== "proposals") throw new Error("Unexpected receiver");
    const reopened = JSON.parse(JSON.stringify(draft.data));
    expect(reopened[field]).toBe(quote);
    // Explicit synthetic reviewer values, never supplied by quotation repair.
    const reviewed = { ...reopened, number: "QA-1", documentDate: "2099-01-01", validUntil: "2099-02-01", issuer: { ...reopened.issuer, name: "Исполнитель QA" }, recipient: { ...reopened.recipient, name: "Заказчик QA" }, lines: reopened.lines.map((line: Record<string, unknown>) => ({ ...line, unit: "усл.", quantity: "1", unitPrice: "100" })) };
    const publicData = buildProposalPublic(reviewed);
    expect(publicData.terms[field === "paymentTerms" ? "payment" : "delivery"]).toBe(quote);
    expect(JSON.stringify(publicData)).not.toContain("PRIVATE_SOURCE_CANARY");
    expect(JSON.stringify(publicData)).not.toContain("/private/synthetic-workspace");
    expect({ raw, sources }).toEqual(before);
    expect(JSON.parse(raw).items[0].fields[field]).toBe(short);
  });
});
