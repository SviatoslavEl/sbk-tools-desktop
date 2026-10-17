import { describe, expect, it } from "vitest";
import { buildProposalPublic } from "../proposals/exportPublic";
import type { ProposalData } from "../proposals/types";
import { auditIntelligenceResult, getBlockingEvidenceFindings } from "./resultEvidence";
import { runResponsePreparation, validResponsePreparationReply, type ResponsePreparationRequest } from "./responsePreparationWorker";
import { buildIntelligenceHandoff } from "./workbenchModel";
import type { IntelligenceFragment, IntelligenceSource } from "./workbenchTypes";

const sourceId = "public-terms-source-qa";
const title = "Аудит информационной системы и подготовка плана развития";
const perimeter = "Дополнительные работы вне согласованного периметра проекта могут быть предметом отдельного согласования;";
const team = "Календарные сроки выполнения работ и состав проектной команды уточняются на этапе запуска проекта с учетом доступности участников Заказчика.";
const validity = "90 календарных дней с даты исходящего письма.";
const advance = "Авансовый платеж — 50% от стоимости услуг в течение 5 календарных дней с даты подписания договора;";
const final = "Окончательный расчет — 50% в течение 5 календарных дней с даты подписания акта либо истечения срока мотивированного отказа.";
const publicTerms = ["Оговорки:", perimeter, team, "Срок действия предложения:", validity].join("\n");
const privateNote = "PRIVATE_INTERNAL_NOTE_QA";
const privateSourceName = "PRIVATE_PROVENANCE_SOURCE_QA.docx";
const paragraph = (n: number, text: string): IntelligenceFragment => ({ id: `paragraph-${n}`, locator: `Абзац ${n}`, text });
const freeze = <T,>(value: T): T => { if (value && typeof value === "object") { Object.freeze(value); Object.values(value).forEach(freeze); } return value; };

function source(): IntelligenceSource {
  return {
    id: sourceId, name: privateSourceName,
    // Explicit selected fragments, not the aggregate, own every public clause.
    text: "PRIVATE_UNSELECTED_AGGREGATE_QA",
    coverage: { complete: true, requiresOcr: false },
    fragments: [
      paragraph(1, "Коммерческое предложение"), paragraph(2, title),
      paragraph(3, "Благодарим за возможность представить коммерческое предложение по проекту аудита информационной системы."),
      paragraph(4, "Условия оплаты:"), paragraph(5, advance), paragraph(6, final),
      paragraph(7, "Оговорки:"), paragraph(8, perimeter), paragraph(9, team),
      paragraph(10, "Срок действия предложения:"), paragraph(11, validity),
      paragraph(12, "Контакты:"), paragraph(13, "PRIVATE_SOURCE_CONTACT_QA"),
    ],
  };
}

function request(extraFields: Record<string, unknown> = {}): ResponsePreparationRequest {
  return {
    revision: 83, sources: [source()], destinations: ["proposals"],
    raw: JSON.stringify({ items: [{
      destination: "proposals", title, sourceIds: [sourceId],
      fields: { title, issuerName: "Неподтверждённый исполнитель QA", paymentTerms: `${advance}\n${final}`, internalNote: privateNote, ...extraFields },
      positions: [{ name: title, description: "" }],
    }] }),
  };
}

function prepare(input = request()) {
  const reply = runResponsePreparation(input);
  expect(validResponsePreparationReply(reply, input.revision)).toBe(true);
  expect(reply.failed).toBeUndefined(); expect(reply.empty).toBeUndefined();
  expect(reply.prepared!.items).toHaveLength(1);
  return { prepared: reply.prepared!, item: reply.prepared!.items[0] };
}

function handoff(input: ResponsePreparationRequest, item = prepare(input).item) {
  const draft = buildIntelligenceHandoff(item, input.sources, "/synthetic/private-workspace-qa");
  if (draft.destination !== "proposals") throw new Error("Wrong handoff destination");
  return draft;
}

/** A separate, explicit reviewer step: preparation must not invent any of
 * these required export values from a relative validity clause. */
function reviewerCompletedExportCopy(data: ProposalData): ProposalData {
  const reviewed = structuredClone(data);
  reviewed.number = "MANUAL-REVIEW-QA-1";
  reviewed.documentDate = "2035-05-01";
  reviewed.validUntil = "2035-07-30";
  reviewed.issuer.name = "Исполнитель, выбранный проверяющим QA";
  reviewed.recipient.name = "Заказчик, выбранный проверяющим QA";
  reviewed.lines = reviewed.lines.map((line) => ({ ...line, unit: "усл.", quantity: "1", unitPrice: "1000" }));
  return reviewed;
}

describe("source public proposal terms through preparation, draft handoff and public export", () => {
  it("keeps every full public caveat in delivery terms while private notes and provenance stay outside the public document", () => {
    const input = request(), before = structuredClone(input); freeze(input);
    const { prepared, item } = prepare(input);
    expect(item.fields.deliveryTerms).toBe(publicTerms);
    expect(item.selectedFields).toContain("deliveryTerms");
    expect(item.fields.internalNote).toBe(privateNote);
    const claims = item.evidence!.filter((claim) => claim.field === "deliveryTerms");
    for (const n of [1, 7, 8, 9, 10, 11]) {
      const row = input.sources[0].fragments!.find((fragment) => fragment.id === `paragraph-${n}`)!;
      expect(claims).toContainEqual({ field: "deliveryTerms", sourceId, fragmentId: row.id, quote: row.text });
    }
    expect(prepared.sourcePreparation!.changes.some((change) => change.field === "deliveryTerms" && change.requiresReview)).toBe(true);
    const draft = handoff(input, item);
    expect(draft.data.deliveryTerms).toBe(publicTerms);
    expect(draft.data.internalNote).toContain(privateNote);
    expect(draft.data.internalNote).toContain(privateSourceName);
    const publicDocument = buildProposalPublic(reviewerCompletedExportCopy(draft.data));
    expect(publicDocument.terms.delivery).toBe(publicTerms);
    expect(publicDocument.terms.payment).toBe(`${advance}\n${final}`);
    const printed = JSON.stringify(publicDocument);
    for (const secret of [privateNote, privateSourceName, sourceId, "PRIVATE_UNSELECTED_AGGREGATE_QA", "PRIVATE_SOURCE_CONTACT_QA", "/synthetic/private-workspace-qa"]) expect(printed).not.toContain(secret);
    for (const key of ["internalNote", "provenance", "evidence", "sourceIds", "selectedFields"]) expect(publicDocument).not.toHaveProperty(key);
    expect(input).toEqual(before);
    expect(JSON.parse(input.raw).items[0].fields.deliveryTerms).toBeUndefined();
  });

  it("does not turn relative validity into an ISO date and still requires explicit completion before export", () => {
    const input = request(), draft = handoff(input);
    expect(draft.data.deliveryTerms).toContain(validity);
    expect(draft.data.validUntil).toBe("");
    expect(draft.data.documentDate).toBe("");
    expect(draft.data.number).toBe("");
    expect(() => buildProposalPublic(draft.data)).toThrow();
    const reviewed = reviewerCompletedExportCopy(draft.data);
    expect(buildProposalPublic(reviewed).validUntil).toBe("2035-07-30");
    expect(draft.data.validUntil).toBe("");
  });

  it("canonicalizes complete literal model clauses without headings before handoff and export, without duplicating or acknowledging them", () => {
    const plain = [perimeter, team, validity].join("\n"), input = request({ deliveryTerms: plain });
    const before = structuredClone(input); freeze(input);
    const { prepared, item } = prepare(input);
    expect(item.fields.deliveryTerms).toBe(publicTerms);
    for (const clause of [perimeter, team, validity]) expect(String(item.fields.deliveryTerms).split(clause)).toHaveLength(2);
    const draft = handoff(input, item);
    expect(draft.data.deliveryTerms).toBe(publicTerms);
    expect(draft.data.validUntil).toBe("");
    expect(buildProposalPublic(reviewerCompletedExportCopy(draft.data)).terms.delivery).toBe(publicTerms);
    const report = auditIntelligenceResult(prepared.items, input.sources);
    expect(report.fields.find((field) => field.itemId === item.id && field.field === "deliveryTerms")?.status).toBe("confirmed");
    expect(getBlockingEvidenceFindings(report, item).some((finding) => finding.field === "deliveryTerms")).toBe(false);
    expect(getBlockingEvidenceFindings(report, item).some((finding) => finding.field === "issuerName")).toBe(true);
    expect(prepared).not.toHaveProperty("reviewedFindingIds");
    expect(input).toEqual(before);
    expect(JSON.parse(input.raw).items[0].fields.deliveryTerms).toBe(plain);
  });

  it("confirms only the literal public terms, without manufacturing acknowledgements for an unknown issuer", () => {
    const input = request(), { prepared, item } = prepare(input), reviewedFindingIds: readonly string[] = Object.freeze([]);
    const report = auditIntelligenceResult(prepared.items, input.sources);
    expect(report.fields.find((field) => field.itemId === item.id && field.field === "deliveryTerms")?.status).toBe("confirmed");
    expect(getBlockingEvidenceFindings(report, item, reviewedFindingIds).some((finding) => finding.field === "deliveryTerms")).toBe(false);
    expect(getBlockingEvidenceFindings(report, item, reviewedFindingIds).some((finding) => finding.field === "issuerName")).toBe(true);
    expect(item.selectedFields).toContain("issuerName");
    expect(reviewedFindingIds).toEqual([]);
    expect(prepared).not.toHaveProperty("reviewedFindingIds");
    expect(item).not.toHaveProperty("reviewedFindingIds");
  });

  it("preserves an existing unproven public prefix and does not greenlight the combined delivery field", () => {
    const prefix = "Все работы завершаются за один день без дополнительного согласования.";
    const input = request({ deliveryTerms: prefix }), { prepared, item } = prepare(input);
    expect(item.fields.deliveryTerms).toBe(`${prefix}\n${publicTerms}`);
    const report = auditIntelligenceResult(prepared.items, input.sources);
    expect(report.fields.find((field) => field.itemId === item.id && field.field === "deliveryTerms")?.status).not.toBe("confirmed");
    expect(getBlockingEvidenceFindings(report, item).some((finding) => finding.field === "deliveryTerms")).toBe(true);
    expect(JSON.parse(input.raw).items[0].fields.deliveryTerms).toBe(prefix);
  });

  it("never restores a hidden public clause from aggregate text into the handoff or export", () => {
    const input = request(), row = input.sources[0].fragments!.find((fragment) => fragment.id === "paragraph-8")!;
    row.sheetState = "hidden"; row.includedByUser = true;
    input.sources[0].text = ["Коммерческое предложение", publicTerms].join("\n");
    const { item } = prepare(input), draft = handoff(input, item);
    expect(String(item.fields.deliveryTerms || "")).not.toContain(perimeter);
    expect(item.evidence!.filter((claim) => claim.field === "deliveryTerms").some((claim) => claim.fragmentId === row.id)).toBe(false);
    expect(buildProposalPublic(reviewerCompletedExportCopy(draft.data)).terms.delivery).not.toContain(perimeter);
  });

  it("does not distribute one proposal source's public caveats among two cards", () => {
    const input = request(), wire = JSON.parse(input.raw);
    wire.items.push({ ...structuredClone(wire.items[0]), title: "Второе КП QA" });
    input.raw = JSON.stringify(wire);
    const reply = runResponsePreparation(input);
    expect(validResponsePreparationReply(reply, input.revision)).toBe(true);
    expect(reply.failed).toBeUndefined(); expect(reply.prepared!.items).toHaveLength(2);
    for (const item of reply.prepared!.items) {
      expect(item.fields.deliveryTerms).toBeUndefined();
      expect(item.selectedFields).not.toContain("deliveryTerms");
      expect((item.evidence || []).some((claim) => claim.field === "deliveryTerms")).toBe(false);
    }
  });
});
