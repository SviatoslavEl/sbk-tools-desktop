import { describe, expect, it } from "vitest";
import { extractProposalSourceParties, revalidateProposalSourceParties } from "./proposalSourceParties";
import type { IntelligenceSource } from "./workbenchTypes";

const executor = ["Исполнитель", 'ООО «Услуги QA»', "Юридический адрес: 12345, Учебная область, Учебная улица, 1", "Почтовый адрес: Учебный город, а/я 12", "ОГРН 1234567890123", "ИНН 1234567890 КПП 123456789", "р/с 12345678901234567890", 'АО «Тестовый банк»', "к/с 98765432109876543210", "БИК 123456789", "Телефон: +7 900 000-00-01", "E-mail: executor@example.test"].join("\n");
const customer = ["Заказчик", 'ООО «Клиент QA»', "Адрес в ЕГРЮЛ: 654321, Учебный город, Тестовый проспект, 2", "ИНН: 9876543210", "КПП: 987654321", "ОГРН: 9876543210987", "Расчётный счёт: 98765432101234567890", "Банк: ПАО Банк QA", "БИК банка: 987654321", "Корр. счёт банка: 12345678909876543210", "e.mail: customer@example.test"].join("\n");
const source = (): IntelligenceSource => ({ id: "source-party-qa", name: "Источник QA", sha256: "a".repeat(64), text: "Не использовать исключённый агрегат", coverage: { complete: true, requiresOcr: false }, fragments: [
  { id: "paragraph-1", locator: "Абзац 1", text: "Договор" },
  { id: "paragraph-2", locator: "Абзац 2", text: 'Общество с ограниченной ответственностью «Учебные услуги» (ООО «Услуги QA»), в лице директора Тестова Теста Тестовича, именуемое в дальнейшем «Исполнитель», и Общество с ограниченной ответственностью «Учебный клиент» (ООО «Клиент QA»), в лице директора Примерова Примера Примеровича, именуемое в дальнейшем «Заказчик», заключили договор.' },
  { id: "paragraph-3", locator: "Абзац 3", text: "1. Предмет договора" },
  { id: "paragraph-4", locator: "Абзац 4", text: "Исполнитель оказывает комплекс услуг по анализу учебной системы." },
  { id: "paragraph-5", locator: "Абзац 5", text: "2. Реквизиты сторон" },
  { id: "table-1-row-1", locator: "Таблица 1, строка 1", text: executor + "\t" + customer },
] });

describe("fresh source-derived party snapshots", () => {
  it("extracts complete separately owned requisites and preserves a literal unusual postal index", () => {
    const input = source(), before = structuredClone(input), result = extractProposalSourceParties([input]);
    expect(result.limited).toBe(false); expect(result.candidates).toHaveLength(2);
    const issuer = result.candidates.find((candidate) => candidate.role === "issuer")!, recipient = result.candidates.find((candidate) => candidate.role === "recipient")!;
    expect(issuer.snapshot).toMatchObject({ name: 'Общество с ограниченной ответственностью «Учебные услуги»', shortName: 'ООО «Услуги QA»', inn: "1234567890", kpp: "123456789", ogrn: "1234567890123" });
    expect(issuer.snapshot.address).toContain("12345, Учебная область"); expect(issuer.snapshot.address).toContain("а/я 12");
    expect(issuer.snapshot.contact).toContain("executor@example.test"); expect(issuer.snapshot.contact).not.toContain("Тестов");
    expect(issuer.snapshot.paymentDetails).toContain("12345678901234567890"); expect(issuer.snapshot.paymentDetails).toContain('АО «Тестовый банк»');
    expect(recipient.snapshot).toMatchObject({ name: 'Общество с ограниченной ответственностью «Учебный клиент»', shortName: 'ООО «Клиент QA»', inn: "9876543210", kpp: "987654321", ogrn: "9876543210987" });
    expect(recipient.snapshot.paymentDetails).toContain("98765432101234567890"); expect(recipient.snapshot.contact).toBe("e.mail: customer@example.test");
    expect(issuer.evidence.some((entry) => entry.quote === executor)).toBe(true); expect(recipient.evidence.some((entry) => entry.quote === customer)).toBe(true);
    expect(input).toEqual(before);
    expect(revalidateProposalSourceParties(result.candidates, [input], [input.id])).toEqual(result.candidates);
  });

  it("supports explicit adjacent two-column role headers, not headerless side-by-side names", () => {
    const input = source(); input.fragments![5].text = "Исполнитель\tЗаказчик";
    input.fragments!.push({ id: "table-1-row-2", locator: "Таблица 1, строка 2", text: executor.split("\n").slice(1).join("\n") + "\t" + customer.split("\n").slice(1).join("\n") });
    expect(extractProposalSourceParties([input]).candidates.map((candidate) => candidate.snapshot.inn)).toEqual(["1234567890", "9876543210"]);
    input.fragments![5].text = "Сторона А\tСторона Б";
    expect(extractProposalSourceParties([input]).candidates.map((candidate) => candidate.snapshot.inn)).toEqual(["", ""]);
  });

  it("does not borrow a different company's bank details into a known party's role", () => {
    const input = source(); input.fragments![5].text = executor.replace('ООО «Услуги QA»', 'ООО «Другой исполнитель»') + "\t" + customer;
    const issuer = extractProposalSourceParties([input]).candidates.find((candidate) => candidate.role === "issuer")!;
    expect(issuer.snapshot.name).toBe('Общество с ограниченной ответственностью «Учебные услуги»');
    expect(issuer.snapshot.inn).toBe(""); expect(issuer.snapshot.paymentDetails).toBe("");
  });

  it("keeps repeated inconsistent field values unresolved instead of taking a plausible first one", () => {
    const input = source(); input.fragments![5].text = executor + "\nИНН 1111111111\t" + customer;
    const issuer = extractProposalSourceParties([input]).candidates.find((candidate) => candidate.role === "issuer")!;
    expect(issuer.snapshot.inn).toBe(""); expect(issuer.issues.join(" ")).toContain("несколько значений ИНН");
  });

  it.each(["changed-account", "changed-role", "changed-quote", "foreign-source", "duplicate"])("rejects %s candidates on fresh revalidation", (variant) => {
    const input = source(), candidates = extractProposalSourceParties([input]).candidates;
    if (variant === "changed-account") input.fragments![5].text = input.fragments![5].text.replace("12345678901234567890", "22222222222222222222");
    if (variant === "changed-role") candidates[0].role = "recipient";
    if (variant === "changed-quote") candidates[0].evidence[0].quote += " выдумано";
    if (variant === "foreign-source") candidates[0].sourceId = "other";
    if (variant === "duplicate") candidates.push(structuredClone(candidates[0]));
    expect(() => revalidateProposalSourceParties(candidates, [input], [input.id])).toThrow();
  });

  it.each(["hidden", "ocr", "discarded"])("does not revive %s party details from aggregate text", (variant) => {
    const input = source();
    if (variant === "hidden") { input.fragments![5].sheetState = "hidden"; input.fragments![5].includedByUser = true; }
    if (variant === "ocr") input.coverage!.requiresOcr = true;
    if (variant === "discarded") input.fragments = [];
    expect(extractProposalSourceParties([input]).candidates).toEqual([]);
  });

  it("rejects duplicate source identities atomically and keeps inferred person contacts absent", () => {
    const input = source(); expect(extractProposalSourceParties([input, input])).toMatchObject({ limited: true, candidates: [] });
    const candidate = extractProposalSourceParties([input]).candidates[0];
    expect(Object.keys(candidate.snapshot)).toEqual(["name", "shortName", "inn", "kpp", "ogrn", "address", "contact", "paymentDetails"]);
  });
});
