import { describe, expect, it } from "vitest";
import { completeSourceTextFields, isOrganizerBeneficiarySupport, SOURCE_TEXT_LIMITS } from "./sourceTextCompletion";
import type { IntelligenceFragment, IntelligenceItem, IntelligenceSource } from "./workbenchTypes";

const paragraph = (row: number, text: string): IntelligenceFragment => ({ id: `paragraph-${row}`, locator: `Абзац ${row}`, text });
const table = (row: number, text: string): IntelligenceFragment => ({ id: `table-row-${row}`, locator: `Таблица, строка ${row}`, text });
const source = (fragments: IntelligenceFragment[], id = "qa-source"): IntelligenceSource => ({ id, name: "Синтетический документ QA", text: "Не восстанавливать исключённые строки из агрегата", fragments });
const card = (destination: IntelligenceItem["destination"], fields: IntelligenceItem["fields"] = {}, id = "qa-card"): IntelligenceItem => ({ id, title: "Коммерческое предложение", destination, fields, sourceIds: ["qa-source"], selectedFields: Object.keys(fields), evidence: [] });
const freeze = <T,>(value: T): T => { if (value && typeof value === "object") { Object.freeze(value); Object.values(value).forEach(freeze); } return value; };
const title = "Аудит информационной системы и подготовка плана развития";
const intro = "Благодарим за возможность представить коммерческое предложение по проекту аудита информационной системы. Подробный подход описан в отдельном техническом предложении.";
const perimeter = "Дополнительные работы вне согласованного периметра проекта могут быть предметом отдельного согласования;";
const team = "Календарные сроки выполнения работ и состав проектной команды уточняются на этапе запуска проекта с учетом доступности участников Заказчика.";
const validity = "90 календарных дней с даты исходящего письма.";
const proposal = () => source([paragraph(1, "Коммерческое предложение"), paragraph(2, title), paragraph(3, intro), paragraph(4, "Оговорки:"), paragraph(5, perimeter), paragraph(6, team), paragraph(7, "Срок действия предложения:"), paragraph(8, validity), paragraph(9, "С уважением,")]);
const procurement = () => source([table(1, "Запрос\tУслуги аудита системы для нужд АО «Контроль QA»"), table(2, "Организатор\tАО «Контроль QA»"), table(3, "Ссылка\thttps://bidzaar.com/app/process/control-qa")]);

describe("bounded source-first literal text completion", () => {
  it("fills explicit procurement basic roles without guessing dates, NMC or a company from a filename", () => {
    const input = procurement(), item = card("procurement"), before = structuredClone({ input, item }); freeze(input); freeze(item);
    const result = completeSourceTextFields([item], [input]);
    expect(result.items[0].fields).toEqual({ name: "Услуги аудита системы для нужд АО «Контроль QA»", subject: "Услуги аудита системы для нужд АО «Контроль QA»", customer: "АО «Контроль QA»", platform: "bidzaar.com" });
    expect(result.changes).toHaveLength(4); expect(result.limited).toBe(false);
    expect(result.items[0].evidence!.filter((claim) => claim.field === "customer").map((claim) => claim.quote)).toEqual(input.fragments!.slice(0, 2).map((part) => part.text));
    expect(result.items[0].evidence!.every((claim) => input.fragments!.some((part) => part.id === claim.fragmentId && part.text === claim.quote))).toBe(true);
    expect(result.changes.every((change) => change.requiresReview)).toBe(true); expect({ input, item }).toEqual(before);
  });

  it("recovers the literal proposal service/intro and public execution caveats without exposing the private note or computing expiry", () => {
    const input = proposal(), item = card("proposals", { title: "Коммерческое предложение", internalNote: "Сохранённая исходная заметка" }), before = structuredClone({ input, item }); freeze(input); freeze(item);
    const result = completeSourceTextFields([item], [input]), current = result.items[0];
    expect(current.fields.title).toBe(title); expect(current.title).toBe(title); expect(current.fields.introduction).toBe(intro);
    expect(current.fields.internalNote).toBe("Сохранённая исходная заметка");
    expect(current.fields.validUntil).toBeUndefined(); expect(current.fields.deliveryTerms).toBe(["Оговорки:", perimeter, team, "Срок действия предложения:", validity].join("\n"));
    expect(current.evidence!.filter((entry) => entry.field === "deliveryTerms").every((entry) => input.fragments!.some((part) => part.id === entry.fragmentId && part.text === entry.quote))).toBe(true);
    expect({ input, item }).toEqual(before);
    expect(completeSourceTextFields(result.items, [input]).items).toEqual(result.items); expect(completeSourceTextFields(result.items, [input]).changes).toEqual([]);
  });

  it("does not replace meaningful old fields, silently remove old values, files or selected choices", () => {
    const item = card("procurement", { customer: "Другой выбранный заказчик", name: "Модель сохранила название", nmc: 123 }); item.selectedFields = ["nmc"];
    const result = completeSourceTextFields([item], [procurement()]);
    expect(result.items[0].fields.customer).toBe(item.fields.customer); expect(result.items[0].fields.name).toBe(item.fields.name);
    expect(result.items[0].selectedFields).not.toContain("customer"); expect(result.items[0].selectedFields).not.toContain("name");
    expect(result.items[0].fields.nmc).toBe(123); expect(item.selectedFields).toEqual(["nmc"]);
  });

  it.each(["open-eof", "unknown-terminator"])("keeps legacy literal review information private when the public section is %s", (variant) => {
    const input = proposal(), item = card("proposals", { internalNote: "PRIVATE QA" });
    if (variant === "open-eof") input.fragments!.pop();
    else input.fragments![8].text = "Неизвестный раздел:";
    const before = structuredClone({ input, item }), result = completeSourceTextFields([item], [input]), current = result.items[0];
    expect(current.fields.deliveryTerms).toBeUndefined(); expect(current.fields.validUntil).toBeUndefined();
    expect(current.fields.internalNote).toBe(["PRIVATE QA", "Оговорки:", perimeter, team, "Срок действия предложения:", validity].join("\n"));
    expect(result.skipped.some((entry) => entry.reason === "proposal-public-terms-review" && entry.field === "deliveryTerms")).toBe(true);
    expect({ input, item }).toEqual(before); expect(current).not.toHaveProperty("reviewedFindings");
  });

  it("does not create cards or distribute one source across cards, lots or another destination", () => {
    expect(completeSourceTextFields([], [procurement()]).items).toEqual([]);
    const item = card("procurement"), other = { ...item, id: "other" };
    expect(completeSourceTextFields([item, other], [procurement()]).items).toEqual([item, other]);
    const input = procurement(); input.fragments!.unshift(paragraph(1, "Лот А: аудит\nЛот Б: услуги"));
    expect(completeSourceTextFields([item], [input]).items).toEqual([item]);
    expect(completeSourceTextFields([card("staff")], [procurement()]).changes).toEqual([]);
    expect(completeSourceTextFields([{ ...item, sourceIds: ["foreign"] }], [procurement()]).changes).toEqual([]);
  });

  it("does not restore hidden, duplicate, discarded or differently owned material", () => {
    const item = card("procurement"), input = procurement(); input.fragments![0].sheetState = "hidden"; input.fragments![0].includedByUser = true;
    const result = completeSourceTextFields([item], [input]); expect(result.items[0].fields.name).toBeUndefined(); expect(result.items[0].fields.subject).toBeUndefined();
    expect(completeSourceTextFields([item], [{ ...input, fragments: [] }]).changes).toEqual([]);
    expect(completeSourceTextFields([item], [input, input]).changes).toEqual([]);
    const duplicate = procurement(); duplicate.fragments!.push(structuredClone(duplicate.fragments![0]));
    expect(completeSourceTextFields([item], [duplicate]).items[0].fields.name).toBeUndefined();
  });

  it.each(["hidden", "gap", "table", "sheet", "duplicate-heading"])("does not inherit proposal header/section ownership through %s", (change) => {
    const input = proposal();
    if (change === "hidden") input.fragments![0].sheetState = "hidden";
    if (change === "gap") { input.fragments![1].id = "paragraph-20"; input.fragments![1].locator = "Абзац 20"; }
    if (change === "table") input.fragments![1] = table(2, title);
    if (change === "sheet") input.fragments![1].sheetId = "other";
    if (change === "duplicate-heading") input.fragments!.push(paragraph(10, "Коммерческое предложение"));
    expect(completeSourceTextFields([card("proposals")], [input]).items[0].fields.title).toBeUndefined();
  });

  it("does not infer a URL platform from an arbitrary website or unlabelled company mentions", () => {
    const item = card("procurement"), input = source([table(1, "Сайт\thttps://bidzaar.com/"), table(2, "Ссылка\thttps://example.test/platform"), table(3, "Примечание\tДля АО Заказчик"), paragraph(1, "Документ назван Закупка_Компания.pdf")]);
    expect(completeSourceTextFields([item], [input]).changes).toEqual([]);
  });

  it("does not mistake a separate organizer or operator for the customer's company", () => {
    const item = card("procurement"), input = source([table(1, "Запрос\tУслуги для нужд АО «Заказчик QA»"), table(2, "Организатор\tАО «Оператор QA»")]);
    expect(completeSourceTextFields([item], [input]).items[0].fields.customer).toBeUndefined();
    input.fragments!.push(table(3, "Запрос\tУслуги для нужд АО «Оператор QA»"));
    expect(completeSourceTextFields([item], [input]).items[0].fields.customer).toBeUndefined();
  });

  it("uses a literal short organizer prefix only when the one request names that company as beneficiary", () => {
    const item = card("procurement"), input = source([table(1, "Запрос\tАудит для нужд АО «ГСК «Контроль QA»"), table(2, "Организатор\tГСК КОНТРОЛЬ QA (АКЦИОНЕРНОЕ ОБЩЕСТВО «Группа компаний Контроль QA»)")]);
    expect(completeSourceTextFields([item], [input]).items[0].fields.customer).toBe(input.fragments![1].text.split("\t")[1]);
    input.fragments![0].text = "Запрос\tУслуги без указания для кого";
    expect(completeSourceTextFields([item], [input]).items[0].fields.customer).toBeUndefined();
  });

  it("retains an explicit Customer label independently from an organizer or request", () => {
    const item = card("procurement"), input = source([table(1, "Заказчик\tАО «Заказчик QA»"), table(2, "Организатор\tАО «Оператор QA»")]);
    expect(completeSourceTextFields([item], [input]).items[0].fields.customer).toBe("АО «Заказчик QA»");
  });

  it("recognizes only the complete current literal request/organizer support pair without mutating it", () => {
    const input = procurement(), prepared = completeSourceTextFields([card("procurement")], [input]).items[0];
    const claims = prepared.evidence!.filter((claim) => claim.field === "customer"), before = structuredClone({ input, prepared }); freeze(input); freeze(prepared);
    expect(isOrganizerBeneficiarySupport(String(prepared.fields.customer), input, claims[0], claims)).toBe(true);
    expect(isOrganizerBeneficiarySupport(String(prepared.fields.customer), input, claims[1], claims)).toBe(false);
    expect({ input, prepared }).toEqual(before);
  });

  it.each(["foreign", "hidden", "gap", "edited-beneficiary", "conflicting-organizer", "not-literal", "missing-organizer-proof", "changed-value", "duplicate-fragment"])("does not treat %s as collective customer-role support", (variant) => {
    const input = procurement(), prepared = completeSourceTextFields([card("procurement")], [input]).items[0];
    const claims = prepared.evidence!.filter((claim) => claim.field === "customer"), claim = claims[0];
    let value = String(prepared.fields.customer);
    if (variant === "foreign") input.id = "foreign";
    if (variant === "hidden") { input.fragments![0].sheetState = "hidden"; input.fragments![0].includedByUser = true; }
    if (variant === "gap") input.fragments![1].id = "table-row-5";
    if (variant === "edited-beneficiary") input.fragments![0].text = "Запрос\tУслуги для нужд АО «Другой QA»";
    if (variant === "conflicting-organizer") input.fragments!.push(table(4, "Организатор\tАО «Другой QA»"));
    if (variant === "not-literal") claim.quote += " (пересказ)";
    if (variant === "missing-organizer-proof") claims.pop();
    if (variant === "changed-value") value = "АО «Другой QA»";
    if (variant === "duplicate-fragment") input.fragments!.push(structuredClone(input.fragments![0]));
    expect(isOrganizerBeneficiarySupport(value, input, claim, claims)).toBe(false);
  });

  it("does not choose among contradictory sources or mix proposal versions in one note", () => {
    const input = procurement(), other = procurement(); other.id = "other"; other.fragments![0].text = "Запрос\tУслуги для нужд АО «Другой QA»"; other.fragments![1].text = "Организатор\tАО «Другой QA»";
    const item = card("procurement"); item.sourceIds.push("other");
    const result = completeSourceTextFields([item], [input, other]); expect(result.items[0].fields.customer).toBeUndefined(); expect(result.skipped.some((entry) => entry.field === "customer")).toBe(true);
    const cp = proposal(), second = proposal(); second.id = "other"; const cpCard = card("proposals"); cpCard.sourceIds.push("other");
    expect(completeSourceTextFields([cpCard], [cp, second]).items[0].fields.internalNote).toBeUndefined();
  });

  it("rolls back the whole affected card for proof/field/evidence limits and the whole inventory for source limits", () => {
    const item = card("procurement"), input = procurement(); input.fragments![1].text = `Заказчик\t${"A".repeat(2001)}`;
    const result = completeSourceTextFields([item], [input]); expect(result.items).toEqual([item]); expect(result.limited).toBe(true); expect(result.changes).toEqual([]);
    const large = procurement(); large.fragments!.push(paragraph(1, "X".repeat(SOURCE_TEXT_LIMITS.fragment + 1)));
    expect(completeSourceTextFields([item], [large]).items).toEqual([item]); expect(completeSourceTextFields([item], [large]).limited).toBe(true);
    const crowded = card("procurement"); crowded.evidence = Array.from({ length: 500 }, (_, index) => ({ field: "notes", sourceId: "qa-source", quote: `Имеющееся подтверждение ${index}` }));
    expect(completeSourceTextFields([crowded], [procurement()]).items).toEqual([crowded]);
  });
});
