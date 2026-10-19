import { describe, expect, it } from "vitest";
import { auditIntelligenceResult } from "./resultEvidence";
import { fieldDefinitions, parseIntelligenceResult } from "./workbenchModel";
import type { IntelligenceSource } from "./workbenchTypes";

const conditional = "По согласованию сторон выдать результат на основе представленных материалов. При этом услуги подлежат оплате в полном размере.";
// Synthetic analogue: no private contract text or real model response in repo.
const finalPayment = "7.3. Заказчик перечисляет окончательную оплату в течение 9 рабочих дней с момента подписания акта или истечения срока мотивированного отказа, предусмотренного пунктами 8.2 и 8.5.";
const cases = [
  { id: "agreement-payment", field: "paymentTerms", quote: conditional, short: "Услуги подлежат оплате в полном размере" },
  { id: "agreement-delivery", field: "deliveryTerms", quote: conditional, short: "Услуги подлежат оплате в полном размере" },
  { id: "after-act-payment", field: "paymentTerms", quote: "После подписания акта Услуги подлежат оплате в полном размере.", short: "Услуги подлежат оплате в полном размере" },
  { id: "after-act-delivery", field: "deliveryTerms", quote: "После подписания акта Исполнитель передает результат Заказчику.", short: "Исполнитель передает результат Заказчику" },
  { id: "negative-payment", field: "paymentTerms", quote: "Услуги не подлежат оплате в полном размере.", short: "подлежат оплате в полном размере" },
  { id: "negative-delivery", field: "deliveryTerms", quote: "Исполнитель не передает результат Заказчику.", short: "передает результат Заказчику" },
  { id: "alternative-payment-events", field: "paymentTerms", quote: finalPayment, short: "Заказчик перечисляет окончательную оплату в течение 9 рабочих дней" },
];

function evaluate(testCase: typeof cases[number], value: string) {
  const source: IntelligenceSource = { id: "s", name: "Учебные условия", text: testCase.quote, fragments: [{ id: "clause", locator: "Условие", text: testCase.quote }] };
  // Ordinary current-schema field dictionary, not diagnostic frames and not a
  // manually constructed pre-approved IntelligenceItem. All other fields null.
  const fields = Object.fromEntries(fieldDefinitions.proposals.map(field => [field.key, field.key === testCase.field ? value : null]));
  const raw = JSON.stringify({ items: [{ destination: "proposals", title: "Проверка условий", sourceIds: ["s"], fields, positions: [], evidence: [{ field: testCase.field, sourceId: "s", fragmentId: "clause", quote: testCase.quote }] }] });
  const items = parseIntelligenceResult(raw, ["s"], { editableFields: true, destinations: ["proposals"] });
  const before = structuredClone({ items, source });
  const report = auditIntelligenceResult(items, [source]);
  expect({ items, source }).toEqual(before);
  return report;
}

describe("whole quoted proposal terms, independent of a lexical condition list", () => {
  it.each(cases)("does not confirm lost context: $id", testCase => {
    const report = evaluate(testCase, testCase.short);
    expect(report.fields.find(field => field.field === testCase.field)?.status).toBe("unverified");
    expect(report.findings).toEqual(expect.arrayContaining([expect.objectContaining({ field: testCase.field, severity: "blocking", code: "unverified-value" })]));
  });
  it.each(cases)("keeps complete literal control, not semantic approval: $id", testCase => {
    const report = evaluate(testCase, testCase.quote);
    expect(report.fields.find(field => field.field === testCase.field)?.status).toBe("confirmed");
    expect(report.findings.filter(finding => finding.field === testCase.field && finding.severity === "blocking")).toEqual([]);
  });
});
