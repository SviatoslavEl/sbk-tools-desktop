import { describe, expect, it } from "vitest";
import { collectContractProposalFacts, CONTRACT_PROPOSAL_LIMITS, priceApplicabilityRestriction } from "./contractProposalFacts";
import type { IntelligenceFragment, IntelligenceSource } from "./workbenchTypes";

export const paragraph = (row: number, text: string): IntelligenceFragment => ({ id: `paragraph-${row}`, locator: `Абзац ${row}`, text });
export const tableRow = (row: number, text: string): IntelligenceFragment => ({ id: `table-1-row-${row}`, locator: `Таблица 1, строка ${row}`, text });
export const contract = (): IntelligenceSource => ({ id: "source-contract", name: "Документ QA", text: "Не использовать агрегат вместо выбранных фрагментов", coverage: { complete: true, requiresOcr: false }, fragments: [
  paragraph(1, "Договор"),
  paragraph(2, 'Общество с ограниченной ответственностью «Тестовые услуги» (ООО «Тестовые услуги»), именуемое в дальнейшем «Исполнитель», и Общество с ограниченной ответственностью «Учебный заказчик» (ООО «Учебный заказчик»), именуемое в дальнейшем «Заказчик», заключили договор.'),
  paragraph(3, "1. Предмет договора"),
  paragraph(4, "1.1. Исполнитель оказывает Заказчику комплекс услуг по исследованию учебной системы, состав которых определён в задании."),
  paragraph(5, "1.2. Объектом проверки является программное обеспечение «Контур QA»."),
  paragraph(6, "2. Состав оказываемых услуг"),
  tableRow(1, "Блок\tЧто проверяем\tСостав действий\tРезультат"),
  tableRow(2, "Техническая проверка\tАрхитектура\tИнтервью и анализ документации\tПеречень технических рисков"),
  tableRow(3, "Лицензионная проверка\tКомпоненты\tПроверка лицензий; SBOM при наличии\tЗаключение об ограничениях"),
  paragraph(7, "3. Итоговые материалы и результат оказания услуг"),
  paragraph(8, "3.1. Итоговый отчёт с перечнем рисков."),
  paragraph(9, "3.2. Презентация руководству."),
  paragraph(10, "3.3. Результаты передаются в DOCX и PDF; проводится встреча."),
  paragraph(11, "4. Стоимость услуг и порядок расчетов"),
  paragraph(12, "4.1. Стоимость услуг составляет 100 000,00 рублей без НДС. Итого с НДС 22% — 122 000,00 рублей."),
  paragraph(13, "4.2. Аванс 20 процентов от суммы, указанной в п. 4.1, кроме того НДС; не позднее 7 (семи) дней от подписания."),
  paragraph(14, "4.3. Окончательный расчет — в течение 6 рабочих дней от акта или истечения срока мотивированного отказа."),
  paragraph(15, "5. Этапы оказания услуг"),
  paragraph(16, "5.1. Услуги оказываются в три последовательных этапа."),
  { ...tableRow(1, "Этап\tСодержание\tСрок\tИтоговые материалы"), id: "table-2-row-1", locator: "Таблица 2, строка 1" },
  { ...tableRow(2, "Этап 1. Анализ\tИсследование\t12 рабочих дней\tОтчёт"), id: "table-2-row-2", locator: "Таблица 2, строка 2" },
  { ...tableRow(3, "Этап 2. Выводы\tСводные материалы\t3 рабочих дня; параллельно с этапом 1\tПрезентация"), id: "table-2-row-3", locator: "Таблица 2, строка 3" },
  paragraph(17, "6. Входные данные и условия проведения работ"),
  paragraph(18, "6.1. Заказчик предоставляет документацию и тестовые учётные записи."),
  paragraph(19, "6.2. Доступ к репозиторию при наличии возможности; разрешение на проверки."),
  paragraph(20, "7. Допущения и ограничения"),
  paragraph(21, "7.1. Восстановление архитектуры в объём работ не входит."),
  paragraph(22, "7.2. Проверки выполняются исключительно в согласованных границах."),
  paragraph(23, "8. Срок оказания услуг"),
  paragraph(24, "8.1. Общий максимальный срок — 18 рабочих дней после полного аванса или всех материалов, в зависимости от того, какое событие наступит позднее."),
  paragraph(25, "8.2. Ожидание доступов автоматически продлевает срок на соответствующий период."),
] });

describe("contract/TЗ source inventory for useful proposals", () => {
  it.each([
    "10.2. Стоимость услуг по настоящему Договору определена только для исполнения настоящего Договора и не может служить прецедентом при заключении аналогичных договоров в будущем.",
    "Цена услуг действует исключительно для данного проекта.",
    "Согласованная цена работ не является прецедентом для будущих аналогичных договоров.",
  ])("recognizes an explicit source price restriction without changing the general inventory: %s", (quote) => {
    const input = contract(), before = collectContractProposalFacts([input]);
    input.fragments!.push(paragraph(90, "10. Прочие условия"), paragraph(91, quote));
    const original = structuredClone(input), after = collectContractProposalFacts([input]);
    expect(priceApplicabilityRestriction(quote)).toBe(true);
    expect(after).toEqual(before);
    expect(input).toEqual(original);
  });

  it.each([
    "Судебное решение не может служить прецедентом при заключении аналогичных договоров.",
    "Стоимость судебных издержек определена только для исполнения настоящего Договора.",
    "Согласование цены услуг не является прецедентом для будущих договоров.",
    "Цена услуг определена для сравнения предложений.",
    "Цена услуг применяется не только для данного проекта.",
    "Цена услуг указана в приложении. Судебное решение не может служить прецедентом.",
    "Цена услуг указана в договоре, а судебное решение не может служить прецедентом.",
  ])("does not infer a price restriction from unrelated legal wording: %s", (quote) => {
    const input = contract(); input.fragments!.push(paragraph(90, "10. Прочие условия"), paragraph(91, quote));
    expect(priceApplicabilityRestriction(quote)).toBe(false);
    expect(collectContractProposalFacts([input]).facts.some((fact) => fact.quote === quote)).toBe(false);
  });

  it("does not join a price word to a restriction in another paragraph, source or hidden selection", () => {
    const input = contract(); input.fragments!.push(paragraph(90, "10. Прочие условия"), paragraph(91, "Стоимость услуг указана отдельно."), paragraph(92, "Не может служить прецедентом для будущих договоров."));
    input.fragments!.push({ ...paragraph(93, "Цена услуг действует только для данного проекта."), sheetState: "hidden" });
    const other = { id: "foreign-legal", name: "Договор.txt", text: "Цена услуг действует только для данного проекта." };
    expect(collectContractProposalFacts([input, other]).facts.filter((fact) => ["paragraph-91", "paragraph-92", "paragraph-93"].includes(fact.fragmentId || ""))).toEqual([]);
    expect(collectContractProposalFacts([input, other]).facts.some((fact) => fact.sourceId === other.id)).toBe(false);
  });

  it("collects all service blocks, deliverables and whole conditional clauses without hardcoded counts", () => {
    const input = contract(), before = structuredClone(input), inventory = collectContractProposalFacts([input]);
    expect(inventory.limited).toBe(false); expect(inventory.documents).toHaveLength(1);
    expect(inventory.documents[0]).toMatchObject({ eligible: true, complete: true });
    const facts = (role: string) => inventory.facts.filter((fact) => fact.role === role).map((fact) => fact.quote);
    expect(facts("scope")).toEqual(input.fragments!.filter((fragment) => /table-1-row-[23]/u.test(fragment.id || "")).map((fragment) => fragment.text));
    expect(facts("deliverable")).toHaveLength(3);
    expect(facts("payment")).toEqual(input.fragments!.filter((fragment) => /^4\.[23]\./u.test(fragment.text)).map((fragment) => fragment.text));
    expect(facts("schedule").some((text) => /какое событие наступит позднее/u.test(text))).toBe(true);
    expect(facts("dependency").some((text) => /при наличии возможности/u.test(text))).toBe(true);
    expect(facts("exclusion").some((text) => /не входит/u.test(text))).toBe(true);
    expect(inventory.ambiguities.map((entry) => entry.code)).toEqual(expect.arrayContaining(["stage-count", "stage-parallelism", "advance-base", "payment-day-kind"]));
    expect(inventory.documents[0].parties?.executor?.value).toBe('Общество с ограниченной ответственностью «Тестовые услуги»');
    expect(inventory.documents[0].parties?.customer?.value).toBe('Общество с ограниченной ответственностью «Учебный заказчик»');
    expect(input).toEqual(before);
  });

  it("binds an embedded technical task to the one explicit contract, not another source", () => {
    const input = contract(); input.fragments!.splice(5, 0, paragraph(40, "Приложение № 1"), paragraph(41, "к Договору оказания услуг"), paragraph(42, "Техническое задание № 1"));
    const inventory = collectContractProposalFacts([input]);
    expect(inventory.documents).toHaveLength(1); expect(inventory.documents[0].eligible).toBe(true);
    const separate = contract(); separate.id = "separate-source";
    expect(collectContractProposalFacts([input, separate]).documents).toHaveLength(2);
  });

  it.each(["hidden", "ocr", "partial"])("marks %s material incomplete instead of proving a complete source", (variant) => {
    const input = contract();
    if (variant === "hidden") input.fragments![8].sheetState = "hidden";
    if (variant === "ocr") input.coverage!.requiresOcr = true;
    if (variant === "partial") input.coverage!.complete = false;
    const inventory = collectContractProposalFacts([input]);
    expect(inventory.documents[0].complete).toBe(false);
    expect(inventory.ambiguities.some((entry) => entry.code === "incomplete-material")).toBe(true);
  });

  it("rejects repeated identities atomically and never resurrects an explicitly empty fragment selection", () => {
    const input = contract(); expect(collectContractProposalFacts([input, input]).limited).toBe(true);
    input.fragments!.push(structuredClone(input.fragments![0])); expect(collectContractProposalFacts([input]).facts).toEqual([]);
    expect(collectContractProposalFacts([{ ...contract(), fragments: [] }]).documents).toEqual([]);
  });

  it("does not use a filename or an unowned offer's references as a contract", () => {
    expect(collectContractProposalFacts([{ id: "other", name: "Договор с полным составом.docx", text: "Произвольные сведения" }]).documents).toEqual([]);
    const input = contract(); input.fragments![0].text = "Коммерческое предложение"; input.fragments!.splice(2, 0, paragraph(99, "Техническое задание № 1"));
    expect(collectContractProposalFacts([input]).documents).toEqual([]);
  });

  it("keeps multiple primary documents in one source ambiguous, never distributing by order", () => {
    const input = contract(); input.fragments!.push(paragraph(80, "Договор № QA-2"), paragraph(81, "1. Предмет договора"), paragraph(82, "Исполнитель оказывает услуги по другому исследованию."));
    const inventory = collectContractProposalFacts([input]);
    expect(inventory.documents).toHaveLength(2); expect(inventory.documents.every((document) => !document.eligible)).toBe(true);
    expect(inventory.ambiguities.filter((entry) => entry.code === "document-owner")).toHaveLength(2);
  });

  it("does not infer contacts or parties from signatures and unrelated roles", () => {
    const input = contract(); input.fragments![1].text = 'ООО «Тестовые услуги», директор Учебный Тест Тестович. ООО «Учебный заказчик». Подписи.';
    expect(collectContractProposalFacts([input]).documents[0].parties).toBeUndefined();
  });

  it("retains final settlement spelling and alternative events under a combined heading", () => {
    const input = contract(), row = input.fragments!.find((fragment) => /^4\.3\./u.test(fragment.text))!;
    row.text = "4.3. Окончательный расчёт — 5 рабочих дней после акта либо истечения срока мотивированного отказа.";
    expect(collectContractProposalFacts([input]).facts.some((fact) => fact.role === "payment" && fact.quote === row.text)).toBe(true);
  });

  it("keeps payment methods and continuation clauses which have no percentage or deadline", () => {
    const input = contract(), position = input.fragments!.findIndex((fragment) => fragment.text === "5. Этапы оказания услуг");
    const method = "4.4. Все платежи уплачиваются непосредственно на расчётный счёт Исполнителя.";
    const followUp = "При просрочке Исполнитель направляет Заказчику соответствующее уведомление.";
    input.fragments!.splice(position, 0, paragraph(60, method), paragraph(61, followUp));
    expect(collectContractProposalFacts([input]).facts.filter((fact) => fact.role === "payment").map((fact) => fact.quote)).toEqual(expect.arrayContaining([method, followUp]));
  });

  it("supports a closed adjacent full-name/alias role clause without joining arbitrary paragraphs", () => {
    const input = contract();
    input.fragments!.splice(1, 1, paragraph(50, 'Общество с ограниченной ответственностью «Учебные услуги»'), paragraph(51, '(ООО «Учебные услуги»), в лице директора, именуемое в дальнейшем «Исполнитель», заключает договор.'));
    const party = collectContractProposalFacts([input]).documents[0].parties?.executor;
    expect(party?.value).toBe('Общество с ограниченной ответственностью «Учебные услуги»'); expect(party?.evidence).toHaveLength(2);
    input.fragments![2].sheetId = "another-sheet";
    expect(collectContractProposalFacts([input]).documents[0].parties?.executor).toBeUndefined();
  });

  it("keeps the protocol milestone ambiguity distinct from stage numbering and parallelism", () => {
    const input = contract();
    input.fragments!.splice(5, 0, paragraph(70, "Границы проверки фиксируются в Протоколе границ проверки на этапе старта работ."));
    const at = input.fragments!.findIndex((fragment) => fragment.text === "7. Допущения и ограничения");
    input.fragments!.splice(at, 0, paragraph(71, "Перечень доступов фиксируется в Протоколе границ проверки по итогам Этапа 2."));
    const ambiguity = collectContractProposalFacts([input]).ambiguities.find((entry) => entry.code === "scope-protocol-milestone");
    expect(ambiguity?.evidence).toHaveLength(2); expect(ambiguity?.message).toContain("до тестирования");
  });

  it("fails closed at a bounded source budget without returning a partial inventory", () => {
    const input = contract(); input.fragments![8].text = "a".repeat(CONTRACT_PROPOSAL_LIMITS.fragment + 1);
    expect(collectContractProposalFacts([input])).toMatchObject({ limited: true, facts: [], documents: [] });
  });
});
