import { describe, expect, it } from "vitest";
import { collectContractProposalFacts } from "./contractProposalFacts";
import { extractProposalSourceFinancials } from "./proposalSourceFinancials";
import { canTransferPreparedItem, evaluateTaskCompletion, getItemTaskCompletion, TASK_COMPLETION_LIMITS, type TaskCompletionObligation } from "./taskCompletion";
import type { IntelligenceDestination, IntelligenceFieldValue, IntelligenceItem, IntelligenceSource } from "./workbenchTypes";

// Generic service examples only; no original user document or model response.
const source = (id: string, rows: string[]): IntelligenceSource => ({ id, name: `${id}.docx`, text: rows.join("\n"), fragments: rows.map((text, index) => ({ id: `paragraph-${index + 1}`, locator: `Абзац ${index + 1}`, text })) });
const item = (id: string, destination: IntelligenceDestination, sourceIds: string[], fields: Record<string, IntelligenceFieldValue>, selectedFields = Object.keys(fields)): IntelligenceItem => ({ id, destination, title: destination === "proposals" ? "Проверка информационной системы" : "Осмысленный результат", fields, selectedFields, sourceIds });
const contract = () => source("service-contract", [
  "Договор № 12",
  "1. Предмет договора",
  "Исполнитель оказывает комплекс услуг по независимой проверке информационной системы «Север».",
  "2. Состав работ",
  "2.1. Анализ архитектуры, исходного кода и подтверждённых зависимостей.",
  "2.2. Проверка безопасности в согласованных границах испытательной среды.",
  "3. Результаты работ",
  "3.1. Технический отчёт, перечень рисков и рекомендации в DOCX и PDF.",
  "4. Условия оплаты",
  "Аванс 25% перечисляется в течение 3 рабочих дней после подписания договора.",
  "Окончательный расчёт — 5 рабочих дней после акта либо истечения срока мотивированного отказа.",
  "5. Сроки выполнения работ",
  "Начало работ — после полного аванса и передачи всех документов, в зависимости от более позднего события.",
  "Общий срок не более 30 рабочих дней. Ожидание согласованных доступов продлевает срок.",
  "6. Входные материалы",
  "Заказчик предоставляет репозиторий и SBOM при наличии.",
  "7. Ограничения",
  "Разработка исправлений не входит в состав работ.",
]);
const technicalTask = () => source("technical-task", contract().fragments!.map((fragment, index) => index === 0 ? "Техническое задание" : fragment.text));
function completeProposal(document: IntelligenceSource, id = "proposal"): IntelligenceItem {
  const inventory = collectContractProposalFacts([document]);
  const byRole = (roles: string[]) => inventory.facts.filter((fact) => roles.includes(fact.role)).map((fact) => fact.quote).join("\n");
  return item(id, "proposals", [document.id], {
    title: "Проверка информационной системы «Север»", lines: ["Независимая проверка информационной системы"],
    lineDescriptions: [byRole(["scope", "deliverable"])], introduction: byRole(["subject", "aggregate-price"]),
    paymentTerms: byRole(["payment"]), deliveryTerms: byRole(["schedule", "dependency", "exclusion"]),
  });
}
const evaluate = (items: IntelligenceItem[], sources: IntelligenceSource[], destinations: IntelligenceDestination[] = ["proposals"], obligations?: TaskCompletionObligation[]) => evaluateTaskCompletion(items, sources, { destinations, ...(obligations ? { obligations } : {}) });

describe("task completion independent from field trust", () => {
  it("rejects a formally valid three-field proposal with only a generic title and parties", () => {
    const document = contract();
    const result = item("empty-proposal", "proposals", [document.id], { title: "Коммерческое предложение", issuerName: "ООО «Исполнитель»", recipientName: "ООО «Заказчик»" });
    const before = JSON.stringify([result, document]);
    const report = evaluate([result], [document]);
    expect(report.status).toBe("insufficient");
    expect(report.counts.missing).toBeGreaterThan(5);
    expect(report.issues.some((issue) => issue.code === "missing-core")).toBe(true);
    expect(canTransferPreparedItem(report, result.id)).toBe(false);
    expect(getItemTaskCompletion(report, result.id)?.canOpenIncompleteDraft).toBe(false);
    expect(JSON.stringify([result, document])).toBe(before);
  });

  it("recognizes a complete service scope without SKU, calendar promises or fabricated dates", () => {
    const document = contract(), result = completeProposal(document);
    const report = evaluate([result], [document]);
    expect(report.checks.length).toBeGreaterThan(5);
    expect(report.checks.every((check) => check.status === "covered")).toBe(true);
    expect(report.status).toBe("review-ready");
    expect(report.issues).toEqual([]);
    expect(canTransferPreparedItem(report, result.id)).toBe(true);
    expect(result.fields.documentDate).toBeUndefined();
    expect(result.fields.validUntil).toBeUndefined();
    expect(result.fields.deliveryTerms).toContain("более позднего события");
  });

  it("does not let the name of the service replace its full source-backed description", () => {
    const document = contract(), result = completeProposal(document);
    result.fields.lineDescriptions = ["Проверка безопасности"];
    const report = evaluate([result], [document]);
    expect(report.status).toBe("insufficient");
    expect(report.checks.some((check) => check.status === "missing" && check.label === "Состав работ")).toBe(true);
    expect(getItemTaskCompletion(report, result.id)?.canOpenIncompleteDraft).toBe(true);
  });

  it("cannot hide an omission by unchecking a field or by copying public content to a private note", () => {
    const document = contract(), result = completeProposal(document);
    result.fields.internalNote = String(result.fields.paymentTerms);
    result.selectedFields = result.selectedFields.filter((field) => field !== "paymentTerms");
    const report = evaluate([result], [document]);
    const missing = report.issues.filter((issue) => issue.code === "missing-source-content" && issue.message.includes("Условия и этапы оплаты"));
    expect(missing.length).toBe(2);
    expect(missing.every((issue) => !Object.prototype.hasOwnProperty.call(issue, "field"))).toBe(true);
    expect(canTransferPreparedItem(report, result.id)).toBe(false);
  });

  it("distinguishes a missing known price from an unknown price without manufacturing money", () => {
    const document = contract();
    const priceRow = "Стоимость услуг без НДС: 100 000,00 рублей; НДС 22%: 22 000,00 рублей; итого с НДС: 122 000,00 рублей.";
    const priced = source(document.id, [...document.fragments!.slice(0, 8).map((fragment) => fragment.text), "Стоимость услуг и порядок расчётов", priceRow, ...document.fragments!.slice(8).map((fragment) => fragment.text)]);
    const result = completeProposal(priced);
    result.fields.introduction = collectContractProposalFacts([priced]).facts.filter((fact) => fact.role === "subject").map((fact) => fact.quote).join("\n");
    const report = evaluate([result], [priced]);
    expect(report.checks.some((check) => check.label === "Общая исходная цена и НДС" && check.status === "missing")).toBe(true);
    expect(result.fields.amount).toBeUndefined();
    expect(result.fields.unitPrice).toBeUndefined();
    const unpriced = evaluate([completeProposal(document)], [document]);
    expect(unpriced.checks.some((check) => check.label === "Общая исходная цена и НДС")).toBe(false);
  });

  it("counts a freshly extracted private price candidate as extracted, not as approved new-CP pricing", () => {
    const document = source("priced-contract", ["Договор № 21", "1. Предмет договора", "Исполнитель оказывает комплекс услуг по анализу программного обеспечения.", "2. Состав работ", "2.1. Проверка модулей и подготовка технического заключения.", "3. Стоимость услуг", "Стоимость услуг без НДС: 100 000,00 рублей; НДС 22%: 22 000,00 рублей; итого с НДС: 122 000,00 рублей."]);
    const result = completeProposal(document);
    result.fields.introduction = "Исполнитель оказывает комплекс услуг по анализу программного обеспечения.";
    const candidates = extractProposalSourceFinancials([document]).candidates;
    expect(candidates).toHaveLength(1);
    const pricedResult = { ...result, proposalSourceFinancials: candidates };
    const report = evaluate([pricedResult], [document]);
    expect(report.checks.find((check) => check.label === "Общая исходная цена и НДС")?.status).toBe("covered");
    expect(report.status).toBe("partial");
    expect(getItemTaskCompletion(report, result.id)).toMatchObject({ priceReviewRequired: true, canTransferPrepared: false, canOpenIncompleteDraft: true });
    expect(report.issues.some((issue) => /не применена к новому КП/u.test(issue.message))).toBe(true);
    expect(result.fields.unitPrice).toBeUndefined();
  });

  it("does not trust a price candidate after its source changed", () => {
    const document = source("priced-contract", ["Договор № 21", "1. Предмет договора", "Исполнитель оказывает комплекс услуг по анализу программного обеспечения.", "2. Состав работ", "2.1. Проверка модулей и подготовка технического заключения.", "3. Стоимость услуг", "Стоимость услуг без НДС: 100 000,00 рублей; НДС не облагается."]);
    const result = { ...completeProposal(document), proposalSourceFinancials: extractProposalSourceFinancials([document]).candidates };
    const changed = structuredClone(document);
    changed.fragments![6].text = "Стоимость услуг без НДС: 200 000,00 рублей; НДС не облагается.";
    const report = evaluate([result], [changed]);
    expect(report.status).toBe("not-assessed");
    expect(canTransferPreparedItem(report, result.id)).toBe(false);
  });

  it("does not treat a copied monetary source quote as an approved price for a new offer", () => {
    const document = source("quoted-price", ["Договор № 21", "1. Предмет договора", "Исполнитель оказывает комплекс услуг по анализу программного обеспечения.", "2. Состав работ", "2.1. Проверка модулей и подготовка технического заключения.", "3. Стоимость услуг", "Стоимость услуг без НДС: 100 000,00 рублей; НДС 22%: 22 000,00 рублей; итого с НДС: 122 000,00 рублей."]);
    const result = completeProposal(document), report = evaluate([result], [document]);
    expect(report.checks.find((check) => check.label === "Общая исходная цена и НДС")?.status).toBe("covered");
    expect(report.status).toBe("partial");
    expect(getItemTaskCompletion(report, result.id)).toMatchObject({ priceReviewRequired: true, canTransferPrepared: false });
    expect(report.issues.some((issue) => /денежной цитаты не заменяет/u.test(issue.message))).toBe(true);
  });

  it("never promotes a source ambiguity by an ACK-shaped option", () => {
    const document = source("ambiguous-contract", ["Договор № 22", "1. Предмет договора", "Исполнитель оказывает комплекс услуг по анализу инфраструктуры.", "2. Состав работ", "2.1. Инвентаризация и оценка рисков.", "3. Сроки выполнения работ", "Работы выполняются в пять последовательных этапов за 30 рабочих дней.", "Этапы могут выполняться параллельно при наличии всех доступов."]);
    const result = completeProposal(document);
    const report = evaluateTaskCompletion([result], [document], { destinations: ["proposals"], reviewedFindingIds: ["everything"] } as unknown as Parameters<typeof evaluateTaskCompletion>[2]);
    expect(report.status).toBe("partial");
    expect(report.issues.some((issue) => /последовательность/u.test(issue.message))).toBe(true);
    expect(canTransferPreparedItem(report, result.id)).toBe(false);
  });

  it("keeps zero-card attempts visibly insufficient and reports source-backed omissions globally", () => {
    const report = evaluate([], [contract()]);
    expect(report.status).toBe("insufficient");
    expect(report.items).toEqual([]);
    expect(report.destinations[0].status).toBe("insufficient");
    expect(report.issues.some((issue) => issue.severity === "missing" && issue.itemIds.length === 0)).toBe(true);
    expect(evaluate([], [source("empty", ["Сведения не предоставлены."])]).status).toBe("insufficient");
  });

  it("marks unsupported source coverage as partial rather than asserting full extraction from field counts", () => {
    const document = source("unclassified", ["Неструктурированные данные для самостоятельной проверки."]);
    const result = item("manual-like", "staff", [document.id], { fullName: "Петров Пётр Петрович", role: "Аналитик" });
    const report = evaluate([result], [document], ["staff"]);
    expect(report.status).toBe("partial");
    expect(report.counts.assessed).toBe(0);
    expect(report.issues[0].code).toBe("unknown-value");
    expect(getItemTaskCompletion(report, result.id)?.canOpenIncompleteDraft).toBe(true);
  });
});

describe("all destinations and independent entity coverage", () => {
  it("evaluates all five requested destinations, not just the ones the model returned", () => {
    const documents = [source("purchase", ["Предмет закупки: Испытания серверного оборудования"]), source("experience", ["Предмет договора: Анализ лицензионных рисков"]), source("people", ["Сотрудник: Петров Пётр Петрович", "Должность: Аналитик", "Сертификат: Security Auditor"]), source("companies", ["Наименование компании: ООО «Север»", "ИНН: 1234567890", "Адрес: Москва, улица Первая, дом 1"]), technicalTask()];
    const results = [item("procurement", "procurement", ["purchase"], { subject: "Испытания серверного оборудования" }), item("contracts", "contracts", ["experience"], { subject: "Анализ лицензионных рисков" }), item("staff", "staff", ["people"], { fullName: "Петров Пётр Петрович", role: "Аналитик", certificates: ["Security Auditor"] }), item("counterparties", "counterparties", ["companies"], { name: "ООО «Север»", inn: "1234567890", address: "Москва, улица Первая, дом 1" }), completeProposal(documents[4])];
    const requested: IntelligenceDestination[] = ["procurement", "contracts", "staff", "counterparties", "proposals"];
    const report = evaluate(results, documents, requested);
    expect(report.status).toBe("review-ready");
    expect(report.destinations.map((entry) => entry.destination)).toEqual(requested);
    expect(report.items.every((entry) => entry.canTransferPrepared)).toBe(true);
    const omitted = evaluate(results.filter((result) => result.destination !== "counterparties"), documents, requested);
    expect(omitted.destinations.find((entry) => entry.destination === "counterparties")?.status).toBe("insufficient");
    expect(omitted.checks.some((check) => check.destination === "counterparties" && check.status === "missing" && check.itemIds.length === 0)).toBe(true);
  });

  it("does not invent cards for unrelated requested directions", () => {
    const document = technicalTask();
    const report = evaluate([completeProposal(document)], [document], ["procurement", "contracts", "staff", "counterparties", "proposals"]);
    expect(report.status).toBe("review-ready");
    expect(report.destinations.filter((entry) => entry.destination !== "proposals").every((entry) => entry.status === "no-applicable-data")).toBe(true);
    expect(report.items).toHaveLength(1);
  });

  it("does not confuse a proposal with the separately requested source contract and its parties", () => {
    const document = source("with-parties", ["Договор № 52", 'ООО «Север», именуемое в дальнейшем «Исполнитель», и ООО «Юг», именуемое в дальнейшем «Заказчик», заключили договор.', "1. Предмет договора", "Исполнитель оказывает комплекс услуг по независимому анализу информационной системы.", "2. Состав работ", "2.1. Анализ архитектуры, техническое обследование и подготовка отчёта."]);
    const result = completeProposal(document);
    const report = evaluate([result], [document], ["proposals", "contracts", "counterparties", "staff", "procurement"]);
    expect(report.destinations.find((entry) => entry.destination === "contracts")?.status).toBe("insufficient");
    expect(report.destinations.find((entry) => entry.destination === "counterparties")?.status).toBe("insufficient");
    expect(report.checks.filter((check) => check.destination === "counterparties")).toHaveLength(2);
    expect(report.destinations.find((entry) => entry.destination === "staff")?.status).toBe("no-applicable-data");
    expect(report.issues.some((issue) => issue.itemIds.length === 0 && issue.destination === "contracts")).toBe(true);
  });

  it("keeps a missing second company separate from a complete first company", () => {
    const document = source("two-companies", ["Наименование компании: ООО «Север»", "ИНН: 1234567890", "Наименование компании: ООО «Юг»", "ИНН: 9876543210"]);
    const north = item("north", "counterparties", [document.id], { name: "ООО «Север»", inn: "1234567890" });
    const report = evaluate([north], [document], ["counterparties"]);
    expect(report.status).toBe("insufficient");
    expect(report.checks.filter((check) => check.status === "missing")).toHaveLength(2);
    expect(getItemTaskCompletion(report, north.id)?.status).toBe("insufficient");
    const south = item("south", "counterparties", [document.id], { name: "ООО «Юг»", inn: "9876543210" });
    const complete = evaluate([north, south], [document], ["counterparties"]);
    expect(complete.status).toBe("review-ready");
    expect(complete.checks.every((check) => check.matchedItemIds.length === 1)).toBe(true);
  });

  it("does not let the certificate of another named employee cover a missing certificate", () => {
    const document = source("two-people", ["Сотрудник: Петров Пётр Петрович", "Должность: Аналитик", "Сертификат: Security Auditor", "Сотрудник: Иванов Иван Иванович", "Должность: Инженер", "Сертификат: Platform Expert"]);
    const wrong = item("wrong", "staff", [document.id], { fullName: "Петров Пётр Петрович", role: "Аналитик", certificates: ["Security Auditor", "Platform Expert"] });
    const report = evaluate([wrong], [document], ["staff"]);
    expect(report.checks.find((check) => check.label.includes("Platform Expert"))?.status).toBe("missing");
    expect(report.status).toBe("insufficient");
  });

  it("does not pool partial proposals into a supposedly complete one", () => {
    const document = contract(), first = completeProposal(document, "first"), second = completeProposal(document, "second");
    delete first.fields.paymentTerms; first.selectedFields = first.selectedFields.filter((field) => field !== "paymentTerms");
    delete second.fields.deliveryTerms; second.selectedFields = second.selectedFields.filter((field) => field !== "deliveryTerms");
    const report = evaluate([first, second], [document]);
    expect(report.checks.every((check) => check.status === "ambiguous")).toBe(true);
    expect(report.items.every((entry) => !entry.canTransferPrepared)).toBe(true);
  });

  it("does not silently combine standalone source contracts into one project", () => {
    const first = contract(), second = source("other-project", first.fragments!.map((fragment) => fragment.text.replace("№ 12", "№ 13").split("«Север»").join("«Юг»")));
    const result = completeProposal(first);
    result.sourceIds.push(second.id);
    const other = completeProposal(second);
    for (const key of ["lineDescriptions", "introduction", "deliveryTerms", "paymentTerms"] as const) result.fields[key] = key === "lineDescriptions" ? [String(result.fields[key]) + "\n" + String(other.fields[key])] : String(result.fields[key]) + "\n" + String(other.fields[key]);
    const report = evaluate([result], [first, second]);
    expect(report.status).toBe("partial");
    expect(report.issues.some((issue) => /несколько самостоятельных договоров/u.test(issue.message))).toBe(true);
    expect(canTransferPreparedItem(report, result.id)).toBe(false);
  });

  it("uses the same completion criteria for combined and per-destination response batches", () => {
    const first = source("purchase", ["Предмет закупки: Проверка серверной платформы"]), second = source("people", ["Сотрудник: Петров Пётр Петрович", "Должность: Аналитик"]);
    const purchase = item("purchase-card", "procurement", [first.id], { subject: "Проверка серверной платформы" }), staff = item("staff-card", "staff", [second.id], { fullName: "Петров Пётр Петрович", role: "Аналитик" });
    const combined = evaluate([purchase, staff], [first, second], ["procurement", "staff"]);
    const separate = [evaluate([purchase], [first, second], ["procurement"]), evaluate([staff], [first, second], ["staff"])];
    expect(combined.items.map((entry) => entry.status)).toEqual(separate.map((report) => report.items[0].status));
    expect(combined.checks.map((check) => [check.id, check.status])).toEqual(separate.flatMap((report) => report.checks.map((check) => [check.id, check.status])));
  });

  it.each<IntelligenceDestination>(["procurement", "contracts", "staff", "counterparties", "proposals"])("supports independently grounded obligations for %s without changing field values", (destination) => {
    const document = source("additional", ["Специальное условие: передача документов только после проверки."]);
    const fields: Record<IntelligenceDestination, Record<string, IntelligenceFieldValue>> = { procurement: { subject: "Проверка системы", notes: document.fragments![0].text }, contracts: { subject: "Проверка системы", notes: document.fragments![0].text }, staff: { fullName: "Петров Пётр Петрович", role: "Аналитик", notes: document.fragments![0].text }, counterparties: { name: "ООО «Север»", notes: document.fragments![0].text }, proposals: { lines: ["Проверка системы"], lineDescriptions: ["Проверка системы и передача документов"], deliveryTerms: document.fragments![0].text } };
    const result = item("additional-card", destination, [document.id], fields[destination]);
    const target = destination === "proposals" ? "deliveryTerms" : "notes";
    const obligation: TaskCompletionObligation = { id: "extra", destination, label: "Особый порядок передачи", targetFields: [target], expectedValue: document.fragments![0].text, evidence: [{ sourceId: document.id, sourceName: document.name, fragmentId: "paragraph-1", locator: "Абзац 1", quote: document.fragments![0].text }] };
    expect(evaluate([result], [document], [destination], [obligation]).checks[0].status).toBe("covered");
    const before = JSON.stringify(result);
    const unchecked = { ...result, selectedFields: result.selectedFields.filter((field) => field !== target) };
    expect(evaluate([unchecked], [document], [destination], [obligation]).checks[0].status).toBe("missing");
    expect(JSON.stringify(result)).toBe(before);
  });
});

describe("snapshot, selection and resource guards", () => {
  it("invalidates source-backed checks and snapshot keys after edits", () => {
    const document = contract(), result = completeProposal(document), original = evaluate([result], [document]);
    const edited = { ...result, selectedFields: result.selectedFields.filter((field) => field !== "paymentTerms") };
    const current = evaluate([edited], [document]);
    expect(current.snapshotKey).not.toBe(original.snapshotKey);
    expect(current.status).toBe("insufficient");
    expect(original.status).toBe("review-ready");
    const changed = structuredClone(document); changed.fragments![4].text += " Дополнительная независимая проверка лицензий.";
    expect(evaluateTaskCompletion([result], [changed], { destinations: ["proposals"], contractProposalInventory: collectContractProposalFacts([document]) }).status).toBe("not-assessed");
  });

  it("rejects stale or hidden evidence instead of reviving aggregate source text", () => {
    const document = source("selection", ["Предмет закупки: Проверка системы", "Сроки: поставка в течение 2 дней."]);
    const result = item("purchase", "procurement", [document.id], { subject: "Проверка системы", notes: document.fragments![1].text });
    const obligation: TaskCompletionObligation = { id: "selected-delivery", destination: "procurement", label: "Срок поставки", targetFields: ["notes"], expectedValue: document.fragments![1].text, evidence: [{ sourceId: document.id, sourceName: document.name, fragmentId: "paragraph-2", locator: "Абзац 2", quote: document.fragments![1].text }] };
    const hidden = structuredClone(document); hidden.fragments![1].sheetState = "hidden";
    expect(evaluate([result], [hidden], ["procurement"], [obligation]).checks.find((check) => check.id === obligation.id)?.status).toBe("not-assessed");
    hidden.fragments![1].includedByUser = true;
    expect(evaluate([result], [hidden], ["procurement"], [obligation]).checks.find((check) => check.id === obligation.id)?.status).toBe("covered");
    const empty = { ...document, fragments: [] };
    expect(evaluate([result], [empty], ["procurement"], [obligation]).status).toBe("not-assessed");
  });

  it("does not inherit a company through a hidden gap or a new party heading", () => {
    const document = source("gapped", ["Наименование компании: ООО «Север»", "Скрытая строка", "ИНН: 1234567890", "Заказчик:", "ИНН: 9876543210"]);
    document.fragments![1].sheetState = "hidden";
    const result = item("company", "counterparties", [document.id], { name: "ООО «Север»" });
    const report = evaluate([result], [document], ["counterparties"]);
    expect(report.checks.every((check) => !check.label.includes("1234567890") && !check.label.includes("9876543210"))).toBe(true);
  });

  it("marks incomplete OCR as unassessed even when the selected text matches", () => {
    const document = contract(); document.coverage = { complete: false, requiresOcr: true, pagesWithoutText: [2] };
    const result = completeProposal(document), report = evaluate([result], [document]);
    expect(report.status).toBe("not-assessed");
    expect(getItemTaskCompletion(report, result.id)?.canOpenIncompleteDraft).toBe(false);
  });

  it("accepts authoritative plain text lines without requiring fragments or file paths", () => {
    const document = contract(); delete document.fragments;
    const result = completeProposal(document);
    expect(evaluate([result], [document]).status).toBe("review-ready");
  });

  it("fails closed for budgets and malformed snapshots without throwing or accepting a prefix", () => {
    const document = contract(), result = completeProposal(document);
    const oversized = source("large", ["x".repeat(TASK_COMPLETION_LIMITS.fragmentCharacters + 1)]);
    expect(evaluate([result], [oversized]).status).toBe("not-assessed");
    expect(evaluate(Array.from({ length: TASK_COMPLETION_LIMITS.items + 1 }, (_, index) => ({ ...result, id: String(index) })), [document]).status).toBe("not-assessed");
    const duplicates = structuredClone(document); duplicates.fragments![1].id = duplicates.fragments![0].id;
    expect(evaluate([result], [duplicates]).status).toBe("not-assessed");
    const malformed = [{ id: "bad", destination: "proposals" }] as IntelligenceItem[];
    expect(() => evaluate(malformed, [document])).not.toThrow();
    expect(evaluate(malformed, [document]).status).toBe("not-assessed");
    expect(evaluateTaskCompletion([result], [document], { destinations: ["proposals", "proposals"] }).status).toBe("not-assessed");
  });
});
