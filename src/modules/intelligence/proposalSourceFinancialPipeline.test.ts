import { describe, expect, it } from "vitest";
import { runResponsePreparation } from "./responsePreparationWorker";
import { runEvidenceAudit } from "./evidenceAuditWorker";
import { getBlockingEvidenceFindings } from "./resultEvidence";
import { getItemTaskCompletion } from "./taskCompletion";
import { buildIntelligenceHandoff } from "./workbenchModel";
import { applyProposalSourcePrice, proposalSourcePricingIssues } from "../proposals/sourcePricing";
import { buildProposalPublic, validateProposal } from "../proposals/exportPublic";
import type { IntelligenceItem, IntelligenceSource } from "./workbenchTypes";
import type { ProposalData } from "../proposals/types";

// Entirely synthetic service contract. These are pipeline regressions, not an
// LLM, native GUI, worker-binary or real-user-document acceptance result.
function material(options: { privateQuestions?: boolean } = {}): IntelligenceSource {
  const paragraphs = [
    "Договор № QA-31",
    'Исполнитель: ООО «Учебный аудит»',
    'Заказчик: ООО «Тестовая система»',
    "1. Предмет договора",
    "1.1. Исполнитель оказывает комплекс услуг по проверке учебной информационной системы, состав которых определён в техническом задании.",
    "2. Состав оказываемых услуг",
    "2.1. Анализ архитектурных материалов и описаний интеграций.",
    "2.2. Проверка перечня компонентов и лицензионных ограничений; SBOM при наличии.",
    "2.3. Проверка тестового контура только в согласованных границах и при наличии разрешений.",
    "3. Итоговые материалы и результат оказания услуг",
    "3.1. Общий отчёт с техническими рисками и рекомендациями.",
    "3.2. Лицензионное заключение с перечнем ограничений.",
    "3.3. Результаты передаются в DOCX и PDF; проводится итоговая встреча.",
    "4. Стоимость услуг и порядок расчетов",
    "4.1. Стоимость услуг без НДС: 100 000,00 рублей; НДС 22%: 22 000,00 рублей; итого с НДС: 122 000,00 рублей.",
    options.privateQuestions ? "4.2. Аванс 25 процентов от суммы, указанной в п. 4.1, кроме того НДС; не позднее 4 дней от подписания." : "4.2. Аванс 25% от общей стоимости с учётом НДС в течение 4 календарных дней после подписания договора.",
    "4.3. Окончательный расчет в течение 6 рабочих дней после акта или истечения срока мотивированного отказа.",
    "5. Срок оказания услуг",
    "5.1. Максимальный срок — 16 рабочих дней после полного аванса или всех материалов, в зависимости от того, какое событие наступит позднее.",
    "5.2. Ожидание согласованных доступов продлевает срок на соответствующий период.",
    "6. Входные данные и условия проведения работ",
    "6.1. Заказчик предоставляет документацию, тестовые учётные записи и разрешения; репозиторий при наличии.",
    "7. Допущения и ограничения",
    "7.1. Восстановление архитектуры в объём работ не входит.",
    ...(options.privateQuestions ? [
      "8. Отдельные договорные оговорки",
      "8.1. Стоимость услуг определена только для исполнения настоящего договора и не может служить прецедентом. PRIVATE-PRICE-PRECEDENT-QA.",
      "8.2. Цена является коммерческой тайной, её раскрытие требует письменного согласия другой стороны. PRIVATE-PRICE-CONFIDENTIAL-QA.",
    ] : []),
  ];
  return { id: "synthetic-contract", name: "Учебный договор для сквозной проверки", sha256: "b".repeat(64), text: "AGGREGATE-TEXT-MUST-NOT-BE-USED", coverage: { complete: true, requiresOcr: false },
    fragments: paragraphs.map((text, index) => ({ id: `p-${index + 1}`, locator: `Абзац ${index + 1}`, text })) };
}
const sparseCard = (source: IntelligenceSource) => ({ destination: "proposals", title: "Коммерческое предложение", sourceIds: [source.id], evidence: [], positions: null,
  fields: { title: "Коммерческое предложение", issuerName: null, recipientName: null, introduction: null, conclusion: null, deliveryTerms: null, paymentTerms: null, number: null, documentDate: null, validUntil: null } });
function prepare(source = material(), cards: unknown[] = [sparseCard(source)]) {
  const raw = JSON.stringify({ items: cards }), before = structuredClone(source);
  const reply = runResponsePreparation({ revision: 31, raw, sources: [source], destinations: ["proposals"] });
  if (!reply.prepared) throw new Error(reply.failed || "Prepared result missing");
  expect(source).toEqual(before);
  return { source, raw, prepared: reply.prepared, item: reply.prepared.items[0] };
}
function handoff(item: IntelligenceItem, source: IntelligenceSource): ProposalData {
  const value = buildIntelligenceHandoff(item, [source], "synthetic-workspace");
  if (value.destination !== "proposals") throw new Error("Wrong destination");
  return value.data;
}
function reviewerCompletedDates(data: ProposalData): ProposalData {
  // These are deliberate human editor entries, not inferred contract dates or
  // a default validity promise attributed to the model/source.
  return { ...data, number: "КП-QA-2035-1", documentDate: "2035-01-10", validUntil: "2035-01-31" };
}

describe("source contract → substantive proposal → explicitly reviewed pricing pipeline", () => {
  it("recovers a sparse response, preserves every service/result/conditional clause and exports exact reviewed totals", () => {
    const { item, source, prepared } = prepare();
    expect(prepared.sourcePreparation?.limited).toBe(false);
    expect(prepared.sourcePreparation?.changes.some((change) => change.field === "lineDescriptions")).toBe(true);
    expect(item.fields.lines).toHaveLength(1);
    const scope = (item.fields.lineDescriptions as string[])[0];
    for (const part of ["2.1. Анализ архитектурных", "2.2. Проверка перечня компонентов", "2.3. Проверка тестового контура", "SBOM при наличии", "3.1. Общий отчёт", "3.2. Лицензионное заключение", "DOCX и PDF"]) expect(scope).toContain(part);
    expect(item.fields.paymentTerms).toContain("или истечения срока мотивированного отказа");
    expect(item.fields.deliveryTerms).toContain("какое событие наступит позднее"); expect(item.fields.deliveryTerms).toContain("продлевает срок"); expect(item.fields.deliveryTerms).toContain("в объём работ не входит");
    expect(item.proposalSourceFinancials).toHaveLength(1); expect(item.proposalSourceFinancials![0]).toMatchObject({ scope: "aggregate", sourceKind: "contract", net: "100000", vatAmount: "22000", gross: "122000", currency: "RUB", tax: { kind: "vat", rate: 22 }, issues: [] });
    expect(JSON.stringify(item.fields)).not.toContain("122 000,00");
    const audit = runEvidenceAudit({ revision: 31, items: [item], sources: [source], destinations: ["proposals"] });
    expect(audit.failed).not.toBe(true); expect(audit.report).toBeDefined(); expect(audit.completion).toBeDefined();
    expect(getBlockingEvidenceFindings(audit.report!, item)).toEqual([]);
    const completion = getItemTaskCompletion(audit.completion!, item.id)!;
    expect(completion).toMatchObject({ canTransferPrepared: false, canOpenIncompleteDraft: true, priceReviewRequired: true });
    expect(audit.completion!.checks.every((check) => check.status === "covered")).toBe(true);
    const draft = reviewerCompletedDates(handoff(item, source));
    expect(draft.lines.every((line) => line.quantity === "" && line.unitPrice === "")).toBe(true);
    expect(proposalSourcePricingIssues(draft)).not.toEqual([]); expect(() => buildProposalPublic(draft)).toThrow();
    expect(() => applyProposalSourcePrice(draft, item.proposalSourceFinancials![0].id, { sameProject: false, aggregateAsSingleLine: true })).toThrow();
    const priced = applyProposalSourcePrice(draft, item.proposalSourceFinancials![0].id, { sameProject: true, aggregateAsSingleLine: true });
    expect(validateProposal(priced).filter((issue) => issue.severity === "error")).toEqual([]);
    const output = buildProposalPublic(priced);
    expect(output.lines).toHaveLength(1); expect(output.lines[0]).toMatchObject({ quantity: "1", unit: "комплекс", unitPrice: "122000", priceBasis: "gross" });
    expect(output.totals).toMatchObject({ netMinor: "10000000", vatMinor: "2200000", grossMinor: "12200000" });
    expect(output.lines[0].description).toContain(scope); expect(output.terms.payment).toContain("или истечения срока мотивированного отказа");
    expect(output.terms.delivery).toContain("какое событие наступит позднее"); expect(output).not.toHaveProperty("sourceFinancials"); expect(output).not.toHaveProperty("sourceQuestions");
    expect(JSON.stringify(output)).not.toContain(source.sha256); expect(JSON.stringify(output)).not.toContain(source.name);
  });

  it("rejects altered or stale financial evidence before opening a receiving draft", () => {
    const { item, source } = prepare();
    for (const mutate of [
      (copy: IntelligenceItem) => { copy.proposalSourceFinancials![0].gross = "999999"; },
      (copy: IntelligenceItem) => { copy.proposalSourceFinancials![0].sourceKind = "offer"; },
      (copy: IntelligenceItem) => { copy.proposalSourceFinancials![0].quote = "Invented price quote"; },
    ]) { const changed = structuredClone(item); mutate(changed); expect(() => handoff(changed, source)).toThrow(/не подтверждается/u); }
    const changedSource = structuredClone(source); changedSource.fragments!.find((fragment) => fragment.text.startsWith("4.1."))!.text = "4.1. Стоимость услуг составляет 500 рублей без НДС.";
    expect(() => handoff(item, changedSource)).toThrow(/не подтверждается/u);
    expect(() => handoff(item, { ...source, fragments: [] })).toThrow(/не подтвержда/iu);
    const audit = runEvidenceAudit({ revision: 32, items: [item], sources: [changedSource], destinations: ["proposals"] });
    expect(getItemTaskCompletion(audit.completion!, item.id)?.canTransferPrepared).toBe(false);
  });

  it("does not offer one aggregate source price to two independent proposal cards", () => {
    const source = material(), first = sparseCard(source), second = { ...sparseCard(source), title: "Другое предложение", fields: { title: "Другой проект", lines: ["Другая услуга"], lineDescriptions: ["Другой состав"] }, positions: undefined };
    const { prepared } = prepare(source, [first, second]);
    expect(prepared.items).toHaveLength(2); expect(prepared.items.every((item) => !item.proposalSourceFinancials?.length)).toBe(true);
    expect(prepared.sourcePreparation?.skipped.some((entry) => entry.reason === "financial-owner-ambiguous")).toBe(true);
    const audit = runEvidenceAudit({ revision: 33, items: prepared.items, sources: [source], destinations: ["proposals"] });
    expect(audit.completion!.items.every((item) => !item.canTransferPrepared)).toBe(true);
  });

  it("rejects model-injected financial facts or approvals rather than trusting their format", () => {
    const source = material();
    for (const injection of [{ proposalSourceFinancials: [] }, { sourceFinancials: { version: 1, candidates: [], decision: { kind: "applied", fingerprint: "model-approved" } } }, { confirmed: true }]) {
      const reply = runResponsePreparation({ revision: 34, sources: [source], destinations: ["proposals"], raw: JSON.stringify({ items: [{ ...sparseCard(source), ...injection }] }) });
      expect(reply.prepared).toBeUndefined(); expect(reply.failed).toMatch(/недопустимые поля/iu);
    }
  });

  it("keeps ambiguity questions, confidentiality evidence and preparation receipts private after explicit pricing", () => {
    const { item, source, prepared } = prepare(material({ privateQuestions: true }));
    const draft = reviewerCompletedDates(handoff(item, source));
    expect(draft.sourceQuestions?.some((question) => /аванс/iu.test(question.message))).toBe(true);
    expect(draft.sourceQuestions?.some((question) => /прецедент/iu.test(question.message))).toBe(true);
    expect(draft.sourceQuestions?.some((question) => /конфиденциал/iu.test(question.message))).toBe(true);
    expect(prepared.sourcePreparation?.changes.length).toBeGreaterThan(5);
    const priced = applyProposalSourcePrice(draft, item.proposalSourceFinancials![0].id, { sameProject: true, aggregateAsSingleLine: true });
    expect(validateProposal(priced).some((issue) => issue.field === "sourceQuestions" && issue.severity === "warning")).toBe(true);
    const publicText = JSON.stringify(buildProposalPublic(priced));
    for (const marker of ["sourceQuestions", "sourceFinancials", "sourcePreparation", "requiresReview", "PRIVATE-PRICE-PRECEDENT-QA", "PRIVATE-PRICE-CONFIDENTIAL-QA", "source-price-"]) expect(publicText).not.toContain(marker);
    // Source questions remain visible in the draft; this test does not claim
    // that pricing approval resolves them or authorizes external disclosure.
    expect(priced.sourceQuestions).toEqual(draft.sourceQuestions);
  });
});
