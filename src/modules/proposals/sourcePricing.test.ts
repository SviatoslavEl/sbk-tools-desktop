import { describe, expect, it } from "vitest";
import { cloneProposal, createProposal, createProposalLine } from "./defaults";
import { buildProposalPublic } from "./exportPublic";
import { priceProposal } from "./pricing";
import { commercialFingerprint, commercialQuestionSourceFingerprint, type CommercialSectionKind, type ProposalCommercialDocumentV1 } from "./commercialDocument";
import { applyTermDecision, validateTermAnswer } from "./commercialDecisions";
import { applyProposalSourcePrice, createProposalSourceFinancials, dismissProposalSourcePricing, normalizeProposalSourceCandidate, proposalSourcePricingIssues, type ProposalSourceFinancialCandidate } from "./sourcePricing";

const candidate = (patch: Partial<ProposalSourceFinancialCandidate> = {}): ProposalSourceFinancialCandidate => ({ id: "price-a", sourceId: "doc-a", sourceName: "Исходный договор", fragmentId: "p3", locator: "Абзац 3", quote: "Стоимость всего комплекса 1220 рублей с НДС 22%", sourceKind: "contract", scope: "aggregate", currency: "RUB", net: "1000", vatAmount: "220", gross: "1220", tax: { kind: "vat", rate: 22 }, issues: [], ...patch });
function proposal(patch: Partial<ProposalSourceFinancialCandidate> = {}) {
  const data = createProposal(new Date(2035, 0, 1)); data.title = "Проверка системы"; data.issuer.name = "Исполнитель"; data.recipient.name = "Заказчик";
  data.lines = [{ ...createProposalLine(), title: "Анализ", description: "Проверить исходники" }, { ...createProposalLine(), title: "Отчёт", description: "Результат DOCX/PDF" }];
  data.sourceFinancials = createProposalSourceFinancials([candidate(patch)]); return data;
}
const confirmed = { sameProject: true, aggregateAsSingleLine: true };
const sortedObjectRoundTrip = <T,>(value: T): T => JSON.parse(JSON.stringify(value, (_property, entry: unknown) => entry && typeof entry === "object" && !Array.isArray(entry)
  ? Object.fromEntries(Object.entries(entry).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) : entry)) as T;
function commercialDocument(): ProposalCommercialDocumentV1 {
  const kinds: CommercialSectionKind[] = ["summary", "subject", "scope", "perimeter", "deliverables", "exclusions", "customer-inputs", "schedule", "acceptance", "other", "payment", "definitions", "requisites"];
  return { version: 1, revision: 1, body: { version: 1, sections: kinds.map((kind) => ({ id: `section-${kind}`, kind, title: `Раздел ${kind}`,
    blocks: [{ id: `block-${kind}`, kind: "paragraph", style: "body", content: [{ kind: "text", text: `Исходное условие ${kind}` }] }] })) },
    privateAppendix: { version: 1, sourceSnapshotKey: `sha256:${"a".repeat(64)}`, documentId: "source-document", extraction: { complete: true, requiresOcr: false, visualAssessment: "unassessed" }, containers: [], clauses: [], references: [], coverage: [] }, questions: [], decisions: [] };
}

describe("explicit private source price application", () => {
  it("uses one aggregate without inventing five prices, preserving every scope block and original data", () => {
    const data = proposal(), before = structuredClone(data), next = applyProposalSourcePrice(data, "price-a", confirmed);
    expect(next.lines).toHaveLength(1); expect(next.lines[0]).toMatchObject({ title: "Проверка системы", unit: "комплекс", quantity: "1", unitPrice: "1220", priceBasis: "gross", tax: { kind: "vat", rate: 22 }, description: "Анализ\nПроверить исходники\n\nОтчёт\nРезультат DOCX/PDF" });
    expect(priceProposal(next.lines).totals).toMatchObject({ netMinor: "100000", vatMinor: "22000", grossMinor: "122000" });
    expect(proposalSourcePricingIssues(next)).toEqual([]); expect(data).toEqual(before);
  });
  it("preserves the explicit single source-derived service title and exact raw scope instead of naming the priced row after the КП heading", () => {
    const data = proposal({ quote: "Стоимость услуг составляет 1220 рублей, включая НДС 22% — 220 рублей." });
    data.title = "КП по проверке учебной системы";
    const title = "Услуги по проверке учебной системы", rawScope = "  Состав работ по исходному документу:\nПроверка двух модулей.\n\nРезультаты по исходному документу:\nОтчёт в DOCX и PDF.\n";
    data.lines = [{ ...createProposalLine(), title, description: rawScope, quantity: "", unit: "" }];
    const before = structuredClone(data), next = applyProposalSourcePrice(data, "price-a", confirmed);
    expect(next.title).toBe(data.title); expect(next.lines).toHaveLength(1);
    expect(next.lines[0]).toMatchObject({ title, description: rawScope, quantity: "1", unit: "комплекс", unitPrice: "1220", priceBasis: "gross", tax: { kind: "vat", rate: 22 } });
    expect(priceProposal(next.lines).totals).toMatchObject({ netMinor: "100000", vatMinor: "22000", grossMinor: "122000" });
    expect(proposalSourcePricingIssues(sortedObjectRoundTrip(next))).toEqual([]); expect(data).toEqual(before);
    const reapplied = applyProposalSourcePrice(next, "price-a", { ...confirmed, replaceExistingPrices: true });
    expect(reapplied.lines[0].title).toBe(title); expect(reapplied.lines[0].description).toBe(rawScope); expect(proposalSourcePricingIssues(reapplied)).toEqual([]);
    const edited = structuredClone(next); edited.lines[0].title += " и новые работы"; expect(proposalSourcePricingIssues(edited)).not.toEqual([]);
  });
  it("does not infer service naming for goods, unrelated titles or multi-position aggregates", () => {
    for (const [heading, lineTitle, quote] of [
      ["КП по поставке оборудования", "Оборудование учебное", "Стоимость оборудования составляет 1220 рублей с НДС 22%."],
      ["КП по проверке учебной системы", "Услуги по другой системе", "Стоимость услуг составляет 1220 рублей с НДС 22%."],
      ["Проверка учебной системы", "Услуги по проверке учебной системы", "Стоимость услуг составляет 1220 рублей с НДС 22%."],
    ]) {
      const data = proposal({ quote }); data.title = heading; data.lines = [{ ...createProposalLine(), title: lineTitle, description: "Полный исходный состав" }];
      const next = applyProposalSourcePrice(data, "price-a", confirmed);
      expect(next.lines[0].title).toBe(heading); expect(next.lines[0].description).toBe(`${lineTitle}\nПолный исходный состав`);
    }
    const multiple = proposal({ quote: "Стоимость услуг составляет 1220 рублей с НДС 22%." }); multiple.title = "КП по проверке учебной системы"; multiple.lines[0].title = "Услуги по проверке учебной системы";
    const next = applyProposalSourcePrice(multiple, "price-a", confirmed); expect(next.lines[0].title).toBe(multiple.title); expect(next.lines[0].description).toContain("Отчёт\nРезультат DOCX/PDF");
  });
  it("requires same-project, one-complex and replacement confirmations independently", () => {
    const data = proposal(); expect(() => applyProposalSourcePrice(data, "price-a", { sameProject: false, aggregateAsSingleLine: true })).toThrow(/тому же проекту/u);
    expect(() => applyProposalSourcePrice(data, "price-a", { sameProject: true })).toThrow(/сводную/u);
    data.lines[0].unitPrice = "5"; expect(() => applyProposalSourcePrice(data, "price-a", confirmed)).toThrow(/уже введены/u);
    expect(applyProposalSourcePrice(data, "price-a", { ...confirmed, replaceExistingPrices: true }).lines[0].unitPrice).toBe("1220");
  });
  it.each([{ tax: { kind: "unknown" } }, { currency: "USD" }, { sourceKind: "procurementLimit" }, { gross: "1230" }, { issues: ["Уточните объём"] }] as Partial<ProposalSourceFinancialCandidate>[]) ("does not apply uncertain source pricing %j", (patch) => expect(() => applyProposalSourcePrice(proposal(patch), "price-a", confirmed)).toThrow());
  it("does not lose conditions by truncating a long scope or pricing an empty scope", () => {
    const data = proposal(); data.lines = []; expect(() => applyProposalSourcePrice(data, "price-a", confirmed)).toThrow(/состав/u);
    data.lines = [{ ...createProposalLine(), title: "Комплекс", description: "X".repeat(20_001) }]; expect(() => applyProposalSourcePrice(data, "price-a", confirmed)).toThrow(/не помещается/u);
  });
  it("applies a true position only by unique unchanged name, preserving exact source quantity and unit", () => {
    const data = proposal({ scope: "position", positionName: "Анализ", quantity: "2", unit: "час", unitPrice: "610", priceBasis: "gross" });
    const next = applyProposalSourcePrice(data, "price-a", { sameProject: true });
    expect(next.lines[0]).toMatchObject({ unitPrice: "610", quantity: "2", unit: "час", title: "Анализ" }); expect(next.lines[1].unitPrice).toBe("");
    data.lines[1].title = "Анализ"; expect(() => applyProposalSourcePrice(data, "price-a", confirmed)).toThrow(/единственной/u);
    data.lines[0].title = "Изменено"; data.lines[1].title = "Отчёт"; expect(() => applyProposalSourcePrice(data, "price-a", confirmed)).toThrow();
  });
  it("invalidates old applicability when project, scope, price, party or source candidate changes", () => {
    const next = applyProposalSourcePrice(proposal(), "price-a", confirmed);
    for (const change of [(data: typeof next) => { data.title += " новая"; }, (data: typeof next) => { data.recipient.name = "Другой"; }, (data: typeof next) => { data.recipient.inn = "1234567890"; }, (data: typeof next) => { data.deliveryTerms = "Иной объём"; }, (data: typeof next) => { data.paymentTerms = "Другой порядок оплаты"; }, (data: typeof next) => { data.lines[0].description += " новые работы"; }, (data: typeof next) => { data.lines[0].unitPrice = "2"; }, (data: typeof next) => { data.sourceFinancials!.candidates[0].gross = "2"; }]) {
      const edited = structuredClone(next); change(edited); expect(proposalSourcePricingIssues(edited)).not.toEqual([]);
    }
    expect(cloneProposal(next).sourceFinancials?.decision).toBeUndefined(); expect(proposalSourcePricingIssues(cloneProposal(next))).not.toEqual([]);
    const reapplied = applyProposalSourcePrice(next, "price-a", { ...confirmed, replaceExistingPrices: true }); expect(reapplied.lines[0].description).toBe(next.lines[0].description);
  });
  it("preserves applied and rejected decisions across recursively key-sorted storage save/reopen", () => {
    for (const reviewed of [applyProposalSourcePrice(proposal(), "price-a", confirmed), dismissProposalSourcePricing(proposal())]) {
      const persisted = sortedObjectRoundTrip(reviewed);
      expect(Object.keys(persisted.sourceFinancials!.candidates[0])).not.toEqual(Object.keys(reviewed.sourceFinancials!.candidates[0]));
      expect(proposalSourcePricingIssues(persisted)).toEqual([]);
      expect(persisted.sourceFinancials!.decision!.fingerprint).toBe(reviewed.sourceFinancials!.decision!.fingerprint);
    }
  });
  it("accepts exact legacy insertion-ordered decisions after sorted storage without migrating or weakening the binding", () => {
    const reviewed = applyProposalSourcePrice(proposal(), "price-a", confirmed);
    const legacyProjection = [reviewed.familyId, reviewed.title, [reviewed.issuer.name, reviewed.issuer.inn, reviewed.issuer.kpp], [reviewed.recipient.name, reviewed.recipient.inn, reviewed.recipient.kpp],
      reviewed.introduction, reviewed.deliveryTerms, reviewed.paymentTerms, reviewed.conclusion,
      reviewed.lines.map(({ id, title, description, unit, quantity, unitPrice, priceBasis, discountPercent, tax }) => ({ id, title, description, unit, quantity, unitPrice, priceBasis, discountPercent, tax })), reviewed.sourceFinancials!.candidates];
    reviewed.sourceFinancials!.decision!.fingerprint = JSON.stringify(legacyProjection);
    const persisted = sortedObjectRoundTrip(reviewed), before = structuredClone(persisted);
    expect(proposalSourcePricingIssues(persisted)).toEqual([]); expect(persisted).toEqual(before);
    persisted.sourceFinancials!.candidates[0].quote += " Изменённое условие";
    expect(proposalSourcePricingIssues(persisted)).not.toEqual([]);
  });
  it("binds an active AST's material subject, scope, schedule and other semantic sections", () => {
    const data = proposal(); data.commercialDocument = commercialDocument();
    const reviewed = applyProposalSourcePrice(data, "price-a", confirmed);
    expect(proposalSourcePricingIssues(reviewed)).toEqual([]);
    for (const kind of ["summary", "subject", "scope", "perimeter", "deliverables", "exclusions", "customer-inputs", "schedule", "acceptance", "other"]) {
      const edited = structuredClone(reviewed), block = edited.commercialDocument!.body.sections.find((section) => section.kind === kind)!.blocks[0];
      if (block.kind !== "paragraph" || block.content[0].kind !== "text") throw new Error("fixture");
      block.content[0].text += " Новое материальное условие";
      expect(proposalSourcePricingIssues(edited), kind).not.toEqual([]);
    }
    const reordered = structuredClone(reviewed); reordered.commercialDocument!.body.sections.reverse();
    expect(proposalSourcePricingIssues(reordered)).not.toEqual([]);
  });
  it("does not bind inactive flat terms, contacts, private metadata or payment/definition decisions to the AST price receipt", () => {
    const data = proposal(); data.commercialDocument = commercialDocument();
    for (const reviewed of [applyProposalSourcePrice(data, "price-a", confirmed), dismissProposalSourcePricing(data)]) {
      const edited = structuredClone(reviewed);
      edited.introduction = "Неактивное старое введение"; edited.deliveryTerms = "Неактивный старый срок";
      edited.paymentTerms = "Неактивный старый платёж"; edited.conclusion = "Неактивное старое заключение";
      edited.contact.fullName = "Другой контакт"; edited.issuer.contact = "Обновлённая почта"; edited.recipient.address = "Новый адрес";
      edited.commercialDocument!.revision += 1;
      edited.commercialDocument!.privateAppendix.sourceSnapshotKey = `sha256:${"b".repeat(64)}`;
      edited.commercialDocument!.privateAppendix.extraction.visualAssessment = "reviewed-by-user";
      for (const kind of ["payment", "definitions", "requisites"]) {
        const block = edited.commercialDocument!.body.sections.find((section) => section.kind === kind)!.blocks[0];
        if (block.kind !== "paragraph" || block.content[0].kind !== "text") throw new Error("fixture");
        block.content[0].text += " Явное согласованное условие";
      }
      edited.commercialDocument!.decisions.push({ version: 1, id: "payment-decision", questionId: "payment-question", answer: { kind: "advance-days", dayKind: "calendar" }, origin: "user", appliedAt: "2035-01-01T12:00:00Z",
        sourceSnapshotKey: `sha256:${"b".repeat(64)}`, dependencyFingerprint: `sha256:${"c".repeat(64)}`, sourceClauseIds: [], changedBlockIds: ["block-payment"], beforeFingerprint: `sha256:${"d".repeat(64)}`, afterFingerprint: `sha256:${"e".repeat(64)}` });
      expect(proposalSourcePricingIssues(edited)).toEqual([]);
    }
  });
  it("keeps AST price bindings stable after recursively sorted storage while preserving material invalidation", () => {
    const data = proposal(); data.commercialDocument = commercialDocument();
    const reviewed = applyProposalSourcePrice(data, "price-a", confirmed), persisted = sortedObjectRoundTrip(reviewed);
    expect(proposalSourcePricingIssues(persisted)).toEqual([]);
    expect(persisted.sourceFinancials!.decision!.fingerprint).toBe(reviewed.sourceFinancials!.decision!.fingerprint);
    const block = persisted.commercialDocument!.body.sections.find((section) => section.kind === "scope")!.blocks[0];
    if (block.kind !== "paragraph" || block.content[0].kind !== "text") throw new Error("fixture");
    block.content[0].text += " Дополнительная система";
    expect(proposalSourcePricingIssues(persisted)).not.toEqual([]);
  });
  it("keeps an actual explicit payment-day Apply from invalidating its already confirmed source price", async () => {
    const data = proposal(), document = commercialDocument(), payment = document.body.sections.find((section) => section.kind === "payment")!;
    const quote = "Аванс перечисляется не позднее 5 дней с момента подписания договора.";
    payment.blocks = [{ id: "block-payment", kind: "paragraph", style: "body", content: [{ kind: "text", text: quote }] }];
    document.privateAppendix.containers = [{ id: "container", sourceId: "source", kind: "contract", heading: "Договор" }];
    document.privateAppendix.clauses = [{ id: "payment-clause", sourceId: "source", sourceName: "Синтетический договор", containerId: "container", locator: "Оплата", quote, quoteHash: await commercialFingerprint(quote), roles: ["payment"], classification: "commercial" }];
    document.privateAppendix.coverage = [{ sourceClauseId: "payment-clause", kind: "literal", targetBlockIds: ["block-payment"] }];
    const identity = { kind: "advance-days" as const, sourceClauseIds: ["payment-clause"], sourceReferenceIds: [] };
    document.questions = [{ ...identity, id: "payment-question", sectionId: payment.id, targetBlockIds: ["block-payment"], message: "Уточнить вид дней", material: true,
      dependencyFingerprint: await commercialQuestionSourceFingerprint(document.privateAppendix, identity) }];
    data.commercialDocument = document;
    const reviewed = applyProposalSourcePrice(data, "price-a", confirmed), answer = { kind: "advance-days" as const, dayKind: "business" as const };
    const validation = await validateTermAnswer(reviewed.commercialDocument!, "payment-question", answer, { pricing: reviewed });
    expect(validation.valid).toBe(true);
    const applied = await applyTermDecision(reviewed.commercialDocument!, { questionId: "payment-question", answer, decisionId: "payment-applied", appliedAt: "2035-01-01T12:00:00Z",
      expectedRevision: reviewed.commercialDocument!.revision, expectedDependencyFingerprint: validation.dependencyFingerprint }, { pricing: reviewed });
    expect(JSON.stringify(applied.document.body)).toContain("5 рабочих дней");
    expect(applied.document.decisions).toHaveLength(1);
    expect(proposalSourcePricingIssues({ ...reviewed, commercialDocument: applied.document })).toEqual([]);
    expect(priceProposal(reviewed.lines).totals).toMatchObject({ grossMinor: "122000", vatMinor: "22000" });
  });
  it("never reuses a legacy-only applicability receipt when an AST is present, or an AST receipt after it is removed", () => {
    const legacy = applyProposalSourcePrice(proposal(), "price-a", confirmed), legacyFingerprint = legacy.sourceFinancials!.decision!.fingerprint;
    const withAst = { ...legacy, commercialDocument: commercialDocument() };
    expect(proposalSourcePricingIssues(withAst)).not.toEqual([]);
    expect(legacy.sourceFinancials!.decision!.fingerprint).toBe(legacyFingerprint);
    const reapplied = applyProposalSourcePrice(withAst, "price-a", { ...confirmed, replaceExistingPrices: true });
    expect(proposalSourcePricingIssues(reapplied)).toEqual([]);
    expect(reapplied.sourceFinancials!.decision!.fingerprint).not.toBe(legacyFingerprint);
    const removed = structuredClone(reapplied); delete removed.commercialDocument;
    expect(proposalSourcePricingIssues(removed)).not.toEqual([]);
  });
  it("fails closed for a present but structurally invalid AST rather than falling back to a legacy receipt", () => {
    const reviewed = applyProposalSourcePrice(proposal(), "price-a", confirmed);
    for (const malformed of [null, {}, { version: 1, body: { version: 1, sections: "not-an-array" } }]) {
      const data = { ...reviewed, commercialDocument: malformed } as unknown as typeof reviewed;
      expect(proposalSourcePricingIssues(data)).not.toEqual([]);
      expect(() => applyProposalSourcePrice(data, "price-a", { ...confirmed, replaceExistingPrices: true })).toThrow(/состав КП повреждён/);
    }
  });
  it("keeps all scalar changes and ordering of lines, candidates and issue arrays bound after key-sorted storage", () => {
    const data = proposal({ scope: "position", positionName: "Анализ", quantity: "2", unit: "час", unitPrice: "610", priceBasis: "gross" });
    data.sourceFinancials!.candidates.push(candidate({ id: "price-b", issues: ["Первый вопрос", "Второй вопрос"] }));
    const persisted = sortedObjectRoundTrip(applyProposalSourcePrice(data, "price-a", { sameProject: true }));
    expect(proposalSourcePricingIssues(persisted)).toEqual([]);
    for (const change of [
      (copy: typeof persisted) => { copy.lines.reverse(); },
      (copy: typeof persisted) => { copy.sourceFinancials!.candidates.reverse(); },
      (copy: typeof persisted) => { copy.sourceFinancials!.candidates[1].issues.reverse(); },
      (copy: typeof persisted) => { copy.lines[0].tax = { kind: "vat", rate: 20 }; },
      (copy: typeof persisted) => { copy.lines[0].quantity = "2.0"; },
      (copy: typeof persisted) => { copy.sourceFinancials!.candidates[0].net = "999"; },
      (copy: typeof persisted) => { copy.sourceFinancials!.candidates[0].sourceId = "different-source"; },
    ]) { const edited = structuredClone(persisted); change(edited); expect(proposalSourcePricingIssues(edited)).not.toEqual([]); }
    persisted.sourceFinancials!.decision!.fingerprint = "not json"; expect(proposalSourcePricingIssues(persisted)).not.toEqual([]);
  });
  it("lets a reviewer reject source pricing, keeps legacy proposals unaffected, and excludes private source evidence from public output", () => {
    const data = proposal(), rejected = dismissProposalSourcePricing(data); expect(proposalSourcePricingIssues(rejected)).toEqual([]); expect(rejected.lines[0].unitPrice).toBe("");
    const next = applyProposalSourcePrice(data, "price-a", confirmed); const output = buildProposalPublic(next);
    expect(output.totals.grossMinor).toBe("122000"); expect(JSON.stringify(output)).not.toContain("Исходный договор"); expect(output).not.toHaveProperty("sourceFinancials");
    delete data.sourceFinancials; expect(proposalSourcePricingIssues(data)).toEqual([]);
  });
  it("normalizes decimals but rejects number coercion, unsupported tax and unsafe candidates", () => {
    expect(normalizeProposalSourceCandidate(candidate({ gross: "1 220,00" })).gross).toBe("1220");
    for (const patch of [{ gross: 1220 }, { gross: "1e3" }, { tax: { kind: "vat", rate: 99 } }, { quote: "\u0000" }, { sourceSha256: "not-a-hash" }]) expect(() => normalizeProposalSourceCandidate(candidate(patch as any))).toThrow();
  });
});
