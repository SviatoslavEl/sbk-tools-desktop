import { describe, expect, it } from "vitest";
import { applyProposalQuotedText, previewProposalQuotedText, type ProposalQuotedTextField } from "./proposalQuotedText";
import type { IntelligenceEvidence, IntelligenceFragment, IntelligenceItem, IntelligenceSource } from "./workbenchTypes";

const field: ProposalQuotedTextField = "paymentTerms";
const fragment = (id: string, text: string) => ({ id, locator: `Абзац ${id}`, text });
function source(parts: IntelligenceFragment[] = [fragment("p1", "По соглашению сторон результат выдают на предоставленных материалах; только тогда услуги оплачиваются полностью.")], id = "source-a"): IntelligenceSource {
  return { id, name: `Источник ${id}`, text: parts.map((part) => part.text).join("\n"), fragments: parts };
}
const proof = (quote: string, fragmentId: string | undefined = "p1", sourceId = "source-a", key: string = field): IntelligenceEvidence => ({ field: key, sourceId, fragmentId, quote });
function item(input: IntelligenceSource, key: string = field): IntelligenceItem {
  return { id: "card-a", destination: "proposals", title: "Исходный ответ", fields: { [key]: "Общее описание из ответа", unitPrices: ["100"], internalNote: "Не менять" }, selectedFields: ["unitPrices"], sourceIds: [input.id], evidence: [proof(input.fragments![0].text, input.fragments![0].id, input.id, key)] };
}
function freeze<T>(value: T): T { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
const preview = (card: IntelligenceItem, inputs: IntelligenceSource[]) => previewProposalQuotedText(card, field, inputs);

describe("explicit literal proposal text preview and repair", () => {
  it.each<ProposalQuotedTextField>(["introduction", "conclusion", "paymentTerms", "deliveryTerms"])("previews and applies only the explicitly chosen %s with all qualifiers and no model/semantic claim", (key) => {
    const input = source(), card = item(input, key), inputs = [input], before = structuredClone({ input, card }); freeze(input); freeze(card);
    const shown = previewProposalQuotedText(card, key, inputs);
    expect(shown.value).toBe(input.fragments![0].text);
    expect(shown.value).toContain("По соглашению сторон"); expect(shown.value).toContain("только тогда");
    expect(Object.keys(shown).sort()).toEqual(["evidence", "sourceSnapshot", "value"]);
    expect(Object.isFrozen(shown.sourceSnapshot)).toBe(true); expect(Reflect.ownKeys(shown.sourceSnapshot)).toEqual([]);
    expect(JSON.stringify(shown.sourceSnapshot)).toBe("{}");
    expect(shown.evidence).toEqual([{ sourceId: input.id, sourceName: input.name, fragmentId: "p1", locator: "Абзац p1", quote: input.fragments![0].text }]);
    // A generic/mismatched model field does not make an explicit literal human
    // repair automatic extraction or a confirmation of role/completeness.
    const repaired = applyProposalQuotedText(card, key, inputs, { previousValue: card.fields[key] as string, value: shown.value, sourceSnapshot: shown.sourceSnapshot });
    expect(repaired.fields).toEqual({ ...card.fields, [key]: shown.value });
    expect(repaired.selectedFields).toEqual(["unitPrices", key]);
    expect(repaired.evidence).toBe(card.evidence);
    expect(Object.keys(repaired).sort()).toEqual(["evidence", "fields", "selectedFields"]);
    expect({ input, card }).toEqual(before);
  });

  it("sorts by original fragment order and literal offset, not claim order or locator numbers", () => {
    const input = source([fragment("later-label", "  Первый.\t Второй.  "), fragment("earlier-label", "Третий.")]), card = item(input);
    card.evidence = [proof("Третий.", "earlier-label"), proof("Второй.  ", "later-label"), proof("  Первый.", "later-label")];
    const shown = preview(card, [input]);
    expect(shown.value).toBe("  Первый.\n\nВторой.  \n\nТретий.");
    expect(shown.evidence.map((entry) => entry.fragmentId)).toEqual(["later-label", "later-label", "earlier-label"]);
    expect(shown.value).not.toContain("Следовательно");
  });

  it("preserves exact tabs, CRLF, leading/trailing spaces and literal duplicates in different fragments", () => {
    const quote = "  Если\tA,\r\nто B.  ", input = source([fragment("p1", quote), fragment("p2", quote)]), card = item(input);
    card.evidence = [proof(quote, "p2"), proof(quote)];
    expect(preview(card, [input]).value).toBe(`${quote}\n\n${quote}`);
    card.evidence = [proof(quote.replace(/\s+/gu, " "))];
    expect(() => preview(card, [input])).toThrow(/дословно/u);
  });

  it("deduplicates only an identical occurrence in preview, retaining all original evidence on apply", () => {
    const input = source(), card = item(input), inputs = [input]; card.evidence!.push({ ...card.evidence![0] }); freeze(card);
    const shown = preview(card, inputs); expect(shown.evidence).toHaveLength(1);
    const patch = applyProposalQuotedText(card, field, inputs, { previousValue: card.fields[field] as string, value: shown.value, sourceSnapshot: shown.sourceSnapshot });
    expect(patch.evidence).toBe(card.evidence); expect(patch.evidence).toHaveLength(2);
  });

  it.each(["partial", "contained"])("rejects %s overlap without shortening or combining claims", (kind) => {
    const input = source([fragment("p1", "Альфа Бета Гамма")]), card = item(input);
    card.evidence = kind === "partial" ? [proof("Альфа Бета"), proof("Бета Гамма")] : [proof("Альфа Бета Гамма"), proof("Бета")];
    expect(() => preview(card, [input])).toThrow(/перекрываются/u);
  });

  it("rejects a quote with multiple possible occurrences instead of inventing a span", () => {
    const input = source([fragment("p1", "Оплата. Оплата.")]), card = item(input); card.evidence = [proof("Оплата.")];
    expect(() => preview(card, [input])).toThrow(/несколько раз/u);
    card.evidence = [proof("Оплата. Оплата.")]; expect(preview(card, [input]).value).toBe(input.text);
  });

  it("uses only this field's current evidence, never whole-source hydration or evidence from another field", () => {
    const input = source([fragment("p1", "Оговорка до. Цитата. Оговорка после.")]), card = item(input);
    card.evidence = [proof("Цитата."), proof("Оговорка после.", "p1", input.id, "conclusion")];
    expect(preview(card, [input]).value).toBe("Цитата.");
    card.evidence = [proof("Цитата.", "p1", input.id, "conclusion")];
    expect(() => preview(card, [input])).toThrow(/нет текущих цитат/u);
  });

  it("never chooses between or combines documents even when both are selected", () => {
    const first = source(), second = source([fragment("p2", "Другое условие.")], "source-b"), card = item(first);
    card.sourceIds.push(second.id); card.evidence!.push(proof(second.text, "p2", second.id));
    expect(() => preview(card, [second, first])).toThrow(/разные документы/u);
  });

  it("rejects foreign, unselected, missing and duplicated source IDs", () => {
    const input = source(), card = item(input);
    expect(() => preview(card, [source(input.fragments, "foreign")])).toThrow(/не выбран/u);
    card.sourceIds = []; expect(() => preview(card, [input])).toThrow(/не выбран/u);
    card.sourceIds = [input.id]; expect(() => preview(card, [input, structuredClone(input)])).toThrow(/идентификатор/u);
    card.sourceIds.push(input.id); expect(() => preview(card, [input])).toThrow(/карточки/u);
  });

  it("requires real fragment IDs and rejects forged IDs, repeated source IDs and aggregate-only sources", () => {
    const input = source(), card = item(input);
    card.evidence = [{ ...proof(input.text), fragmentId: undefined }]; expect(() => preview(card, [input])).toThrow(/идентификатор/u);
    card.evidence = [proof(input.text, "forged")]; expect(() => preview(card, [input])).toThrow(/Фрагмент/u);
    card.evidence = [proof(input.text)]; const repeated = structuredClone(input); repeated.fragments!.push(fragment("p1", "Не цитируется"));
    expect(() => preview(card, [repeated])).toThrow(/повторяются/u);
    expect(() => preview(card, [{ id: input.id, name: input.name, text: input.text }])).toThrow(/нет однозначных фрагментов/u);
  });

  it("rejects supplied unknown spans rather than treating them as a verified model location", () => {
    const input = source(), card = item(input);
    card.evidence = [{ ...card.evidence![0], start: 0, end: 10 } as IntelligenceEvidence];
    expect(() => preview(card, [input])).toThrow(/неверный формат/u);
  });

  it.each(["hidden", "veryHidden"] as const)("rejects %s fragments unless explicitly opted in, without dropping the source", (state) => {
    const input = source(), card = item(input); input.fragments![0].sheetState = state;
    expect(() => preview(card, [input])).toThrow(/скрытом листе/u);
    input.fragments![0].includedByUser = false; expect(() => preview(card, [input])).toThrow(/скрытом листе/u);
    input.fragments![0].includedByUser = true; expect(preview(card, [input]).value).toBe(input.text);
  });

  it("retains visible default inclusion even with includedByUser false", () => {
    const input = source(), card = item(input); input.fragments![0].sheetState = "visible"; input.fragments![0].includedByUser = false;
    expect(preview(card, [input]).value).toBe(input.text);
  });

  it("recomputes the preview and rejects stale field values, quotes or source visibility", () => {
    const input = source(), card = item(input), inputs = [input], shown = preview(card, inputs), expected = { previousValue: card.fields[field] as string, value: shown.value, sourceSnapshot: shown.sourceSnapshot };
    const changed = structuredClone(card); changed.fields[field] = "Новая ручная правка";
    expect(() => applyProposalQuotedText(changed, field, inputs, expected)).toThrow(/изменились/u);
    const staleSource = structuredClone(input); staleSource.fragments![0].text = "Другой текст";
    expect(() => applyProposalQuotedText(card, field, [staleSource], expected)).toThrow(/дословно/u);
    const staleClaim = structuredClone(card); staleClaim.evidence![0].quote = "только тогда";
    expect(() => applyProposalQuotedText(staleClaim, field, inputs, expected)).toThrow(/изменились/u);
    const hidden = structuredClone(input); hidden.fragments![0].sheetState = "hidden";
    expect(() => applyProposalQuotedText(card, field, [hidden], expected)).toThrow(/скрытом/u);
  });

  it.each(["aggregate", "sha", "other-fragment", "name", "locator"])("rejects changed source %s even when the current quote and replacement text still match", (kind) => {
    const input = source([fragment("p1", "Дословное условие."), fragment("p2", "Соседний контекст.")]), card = item(input);
    input.sha256 = "a".repeat(64);
    const inputs = [input], shown = preview(card, inputs), expected = { previousValue: card.fields[field] as string, value: shown.value, sourceSnapshot: shown.sourceSnapshot };
    const changed = input; // Same array AND source object: fresh serialization is mandatory.
    if (kind === "aggregate") changed.text += "\nНовая оговорка.";
    if (kind === "sha") changed.sha256 = "b".repeat(64);
    if (kind === "other-fragment") changed.fragments![1].text = "Другой соседний контекст.";
    if (kind === "name") changed.name += " изменён";
    if (kind === "locator") changed.fragments![0].locator = "Другое расположение";
    const current = preview(card, inputs); expect(current.value).toBe(shown.value); expect(current.sourceSnapshot).not.toBe(shown.sourceSnapshot);
    expect(() => applyProposalQuotedText(card, field, inputs, expected)).toThrow(/материалы изменились/u);
    expect(card.fields[field]).toBe(expected.previousValue);
  });

  it("requires the exact expected preview and explicitly supplied previous value, including undefined", () => {
    const input = source(), card = item(input), inputs = [input]; delete card.fields[field]; const shown = preview(card, inputs);
    expect(applyProposalQuotedText(card, field, inputs, { previousValue: undefined, value: shown.value, sourceSnapshot: shown.sourceSnapshot }).fields[field]).toBe(shown.value);
    expect(() => applyProposalQuotedText(card, field, inputs, { previousValue: "", value: shown.value, sourceSnapshot: shown.sourceSnapshot })).toThrow(/изменились/u);
    expect(() => applyProposalQuotedText(card, field, inputs, { value: shown.value } as never)).toThrow(/устарел/u);
    expect(() => applyProposalQuotedText(card, field, inputs, { previousValue: undefined, value: shown.value + " ", sourceSnapshot: shown.sourceSnapshot })).toThrow(/изменились/u);
    expect(() => applyProposalQuotedText(card, field, inputs, { previousValue: undefined, value: shown.value } as never)).toThrow(/устарел/u);
  });

  it("does not add selected-field duplicates or change unrelated prices, fields and evidence", () => {
    const input = source(), card = item(input), inputs = [input]; card.selectedFields.push(field); card.evidence!.push(proof("Иная цитата", "other", "foreign", "internalNote"));
    const shown = preview(card, inputs), patch = applyProposalQuotedText(card, field, inputs, { previousValue: card.fields[field] as string, value: shown.value, sourceSnapshot: shown.sourceSnapshot });
    expect(patch.selectedFields).toEqual(card.selectedFields); expect(patch.fields.unitPrices).toBe(card.fields.unitPrices);
    expect(patch.fields.internalNote).toBe(card.fields.internalNote); expect(patch.evidence).toBe(card.evidence);
  });

  it("shares one opaque frozen snapshot token across 400 unchanged previews of the same source array", () => {
    const input = source(), card = item(input), inputs = [input];
    const tokens = Array.from({ length: 400 }, () => preview(card, inputs).sourceSnapshot);
    expect(new Set(tokens).size).toBe(1);
    expect(Object.isFrozen(tokens[0])).toBe(true); expect(Reflect.ownKeys(tokens[0])).toEqual([]);
    expect(JSON.stringify(tokens[0])).toBe("{}");
    expect(String(tokens[0])).not.toContain(input.text);
  });

  it("rejects forged, serialized/cloned and foreign-array tokens rather than rebasing a preview", () => {
    const input = source(), card = item(input), inputs = [input], shown = preview(card, inputs);
    const expected = { previousValue: card.fields[field] as string, value: shown.value, sourceSnapshot: shown.sourceSnapshot };
    for (const token of [Object.freeze({}), structuredClone(shown.sourceSnapshot), JSON.stringify(shown.sourceSnapshot)]) {
      expect(() => applyProposalQuotedText(card, field, inputs, { ...expected, sourceSnapshot: token } as never)).toThrow(/устарел/u);
    }
    const foreign = preview(card, [input]); expect(foreign.value).toBe(shown.value); expect(foreign.sourceSnapshot).not.toBe(shown.sourceSnapshot);
    expect(() => applyProposalQuotedText(card, field, inputs, { ...expected, sourceSnapshot: foreign.sourceSnapshot })).toThrow(/материалы изменились/u);
    expect(() => applyProposalQuotedText(card, field, [input], expected)).toThrow(/материалы изменились/u);
  });

  it("does fresh source validation on apply even when that source-array token was previously cached", () => {
    const input = source(), card = item(input), inputs = [input], shown = preview(card, inputs);
    input.warnings = Array.from({ length: 1001 }, () => "Предупреждение");
    expect(() => applyProposalQuotedText(card, field, inputs, { previousValue: card.fields[field] as string, value: shown.value, sourceSnapshot: shown.sourceSnapshot })).toThrow(/1000/u);
  });

  it("bounds the entire source snapshot rather than silently filtering unreferenced materials", () => {
    const input = source(), card = item(input);
    const tooMany = Array.from({ length: 101 }, (_, index) => source([fragment("p1", "Текст")], `source-${index}`));
    expect(() => preview(card, tooMany)).toThrow(/100 источников/u);
    const malformed = { ...input, fragments: [{ ...input.fragments![0], untrustedExtra: true }] };
    expect(() => preview(card, [malformed])).toThrow(/формат фрагментов/u);
  });

  it("allows at most 500 claims and never truncates an overlong quote", () => {
    const input = source(), card = item(input); card.evidence = Array.from({ length: 500 }, () => ({ ...card.evidence![0] }));
    expect(preview(card, [input]).evidence).toHaveLength(1);
    card.evidence.push({ ...card.evidence[0] }); expect(() => preview(card, [input])).toThrow(/500/u);
    const large = source([fragment("p1", "я".repeat(2001))]); expect(() => preview(item(large), [large])).toThrow(/2000/u);
    const exact = source([fragment("p1", "я".repeat(2000))]); expect(preview(item(exact), [exact]).value).toHaveLength(2000);
  });

  it("enforces 20000 UTF-16 units including separators without cutting quotes", () => {
    const parts = Array.from({ length: 10 }, (_, index) => { const start = `${index}:`; const length = index === 0 ? 2000 : 1998; return fragment(`p${index}`, start + "x".repeat(length - start.length)); });
    const input = source(parts), card = item(input); card.evidence = parts.map((part) => proof(part.text, part.id));
    expect(preview(card, [input]).value).toHaveLength(20000);
    const longer = structuredClone(input); longer.fragments![1].text += "x"; card.evidence[1].quote += "x";
    expect(() => preview(card, [longer])).toThrow(/20000/u);
  });

  it("preserves complete surrogate pairs and rejects split or malformed quotes without Unicode repair", () => {
    const input = source([fragment("p1", "Перед 😀 после")]), card = item(input); card.evidence = [proof("😀")];
    expect(preview(card, [input]).value).toBe("😀");
    for (const quote of ["\ud83d", "\ude00", "😀".repeat(1001)]) {
      card.evidence = [proof(quote)]; expect(() => preview(card, [input])).toThrow();
    }
    const emoji = source([fragment("p1", "😀".repeat(1000))]); expect(preview(item(emoji), [emoji]).value).toHaveLength(2000);
  });

  it("fails closed for unsupported destinations/fields, nontext values and missing claims", () => {
    const input = source(), card = item(input);
    expect(() => previewProposalQuotedText({ ...card, destination: "contracts" }, field, [input])).toThrow(/КП/u);
    expect(() => previewProposalQuotedText(card, "unitPrices", [input])).toThrow(/КП/u);
    card.fields[field] = 1; expect(() => preview(card, [input])).toThrow(/корректный текст/u);
    card.fields[field] = "x".repeat(20001); expect(() => preview(card, [input])).toThrow(/20000/u);
    card.fields[field] = "Прежний текст"; card.evidence = []; expect(() => preview(card, [input])).toThrow(/цитаты/u);
  });
});
