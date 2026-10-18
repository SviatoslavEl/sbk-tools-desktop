import { describe, expect, it } from "vitest";
import { collectContractProposalFacts } from "./contractProposalFacts";
import { completeContractProposalFields, createContractProposalProver } from "./contractProposalCompletion";
import type { IntelligenceFragment, IntelligenceItem, IntelligenceSource } from "./workbenchTypes";

const introduction = "Если задержка предоставления исходных материалов относительно согласованных сроков превысит 10 рабочих дней, Исполнитель вправе принять одно из следующих решений:";
const agreedResult = "- по соглашению Сторон выдать результат, подготовленный на основе представленных документов. При этом услуги признаются надлежаще оказанными и подлежащими оплате в полном объёме;";
const suspension = "- приостановить оказание услуг, уведомив Заказчика за 3 рабочих дня. Срок возобновления согласовывается дополнительным соглашением. Если согласовать его не удалось, Исполнитель вправе выдать результат по документам, имевшимся на дату паузы, а Заказчик оплачивает фактически выполненные работы.";
const unrelatedBranch = "- дополнительная подпись служит образцом оформления, а не условием оказания услуг.";
const paragraph = (index: number, text: string): IntelligenceFragment => ({ id: `paragraph-${index}`, locator: `Абзац ${index}`, text });
function source(): IntelligenceSource {
  return { id: "conditional-contract", name: "Учебный договор", text: "Не использовать агрегат вместо выбранных фрагментов", coverage: { complete: true, requiresOcr: false }, fragments: [
    "Договор", "1. Предмет договора", "1.1. Исполнитель оказывает комплекс услуг по исследованию учебного контура.",
    "2. Права и обязанности сторон", "2.3.3. Задержка представления материалов автоматически продлевает срок на период задержки.",
    introduction, agreedResult, suspension,
    "2.3.4. Оформление переписки устанавливается отдельно.", unrelatedBranch,
    "3. Состав оказываемых услуг", "3.1. Анализ предоставленной документации.",
  ].map((text, index) => paragraph(index + 1, text)) };
}
const card = (): IntelligenceItem => ({ id: "proposal-qa", destination: "proposals", title: "Коммерческое предложение", fields: {}, selectedFields: [], sourceIds: ["conditional-contract"], evidence: [] });

describe("closed conditional alternatives preserve every source branch", () => {
  it("collects both complete alternatives with their own condition, without substituting full payment for actual work", () => {
    const input = source(), before = structuredClone(input), inventory = collectContractProposalFacts([input]);
    const choices = inventory.facts.filter((fact) => fact.role === "schedule" && [agreedResult, suspension].includes(fact.quote));
    expect(choices.map((fact) => fact.quote)).toEqual([agreedResult, suspension]);
    for (const fact of choices) {
      expect(fact.sourceId).toBe(input.id); expect(fact.documentId).toBe(inventory.documents[0].documentId);
      expect(fact.supportingEvidence).toEqual(expect.arrayContaining([
        expect.objectContaining({ sourceId: input.id, fragmentId: "paragraph-1", quote: "Договор" }),
        expect.objectContaining({ sourceId: input.id, fragmentId: "paragraph-6", quote: introduction }),
      ]));
    }
    expect(choices[0].quote).toContain("по соглашению Сторон"); expect(choices[0].quote).toContain("в полном объёме");
    expect(choices[1].quote).toContain("Если согласовать его не удалось"); expect(choices[1].quote).toContain("фактически выполненные работы");
    expect(inventory.facts.some((fact) => fact.quote === unrelatedBranch)).toBe(false);
    expect(input).toEqual(before);
  });

  it("carries both literal alternatives into public terms and proves only the whole canonical value", () => {
    const input = source(), seed = card(), prepared = completeContractProposalFields([seed], [input], ["proposals"]), item = prepared.items[0];
    expect(prepared.limited).toBe(false);
    const delivery = item.fields.deliveryTerms as string;
    expect(delivery).toContain(introduction); expect(delivery).toContain(agreedResult); expect(delivery).toContain(suspension);
    expect(delivery.indexOf(introduction)).toBeLessThan(delivery.indexOf(agreedResult));
    expect(delivery.indexOf(agreedResult)).toBeLessThan(delivery.indexOf(suspension));
    expect(delivery).not.toContain(unrelatedBranch);
    for (const [fragmentId, quote] of [["paragraph-6", introduction], ["paragraph-7", agreedResult], ["paragraph-8", suspension]]) {
      expect(item.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ field: "deliveryTerms", sourceId: input.id, fragmentId, quote })]));
    }
    const prover = createContractProposalProver([input]);
    expect(prover.prove(item, [item])?.fields.get("deliveryTerms")?.evidence.some((entry) => entry.quote === agreedResult)).toBe(true);
    const missingBranch = { ...item, fields: { ...item.fields, deliveryTerms: delivery.replace(agreedResult, "") } };
    expect(prover.prove(missingBranch, [missingBranch])?.fields.has("deliveryTerms")).toBe(false);
    const missingConditionProof = { ...item, evidence: item.evidence?.filter((claim) => claim.field !== "deliveryTerms" || claim.quote !== introduction) };
    expect(prover.prove(missingConditionProof, [missingConditionProof])?.fields.has("deliveryTerms")).toBe(false);
    const staleSource = structuredClone(input); staleSource.fragments![6].text = agreedResult.replace("в полном объёме", "в согласованном размере");
    expect(createContractProposalProver([staleSource]).prove(item, [item])?.fields.has("deliveryTerms")).toBe(false);
    const priorPartial = card(); priorPartial.fields.deliveryTerms = [input.fragments![4].text, introduction, suspension].join("\n\n"); priorPartial.selectedFields = ["deliveryTerms"];
    const repaired = completeContractProposalFields([priorPartial], [input], ["proposals"]).items[0];
    expect(repaired.fields.deliveryTerms).toContain(agreedResult); expect(repaired.fields.deliveryTerms).toContain(suspension);
    expect(completeContractProposalFields([item], [input], ["proposals"]).items).toEqual([item]);
  });

  it.each(["next-number", "numeric-marker", "unrelated-paragraph", "empty-gap", "hidden-gap", "sheet", "table", "new-heading", "appendix", "new-document"] as const)("does not carry a role past %s", (boundary) => {
    const input = source(); input.fragments!.splice(6);
    if (boundary === "next-number") input.fragments!.push(paragraph(20, "2.3.4. Оформление переписки устанавливается отдельно."));
    if (boundary === "numeric-marker") input.fragments!.push(paragraph(20, "3) Оформление переписки устанавливается отдельно."));
    if (boundary === "unrelated-paragraph") input.fragments!.push(paragraph(20, "Образцы оформления документов представлены отдельно."));
    if (boundary === "empty-gap") input.fragments!.push(paragraph(20, ""));
    if (boundary === "hidden-gap") input.fragments!.push({ ...paragraph(20, "Скрытая строка"), sheetState: "hidden" });
    if (boundary === "new-heading") input.fragments!.push(paragraph(20, "3. Итоговые материалы и результат оказания услуг"));
    if (boundary === "appendix") input.fragments!.push(paragraph(20, "Приложение № 2"));
    if (boundary === "new-document") input.fragments!.push(paragraph(20, "Договор № QA-2"));
    const candidate = paragraph(21, agreedResult);
    if (boundary === "sheet") candidate.sheetId = "different-sheet";
    if (boundary === "table") candidate.id = "table-1-row-1";
    input.fragments!.push(candidate);
    const matching = collectContractProposalFacts([input]).facts.filter((fact) => fact.quote === agreedResult);
    // A newly explicit section can legitimately classify its own rows, but
    // cannot borrow the earlier condition or its schedule role.
    expect(matching.some((fact) => fact.role === "schedule" || fact.supportingEvidence.some((entry) => entry.quote === introduction))).toBe(false);
  });

  it("does not attach another source's branches or inherit from an unrecognized standalone introducer", () => {
    const first = source(); first.fragments!.splice(6);
    const second = source(); second.id = "other-source"; second.fragments!.splice(4, 2);
    const inventory = collectContractProposalFacts([first, second]);
    expect(inventory.facts.some((fact) => fact.sourceId === second.id && fact.quote === agreedResult)).toBe(false);
    const noRole = source(); noRole.fragments!.splice(4, 2, paragraph(20, "Исполнитель может выбрать одно из следующих решений:"));
    expect(collectContractProposalFacts([noRole]).facts.some((fact) => fact.quote === agreedResult)).toBe(false);
  });
});
