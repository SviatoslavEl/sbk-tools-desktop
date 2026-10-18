import { isValidElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CommercialDocumentView } from "./CommercialDocumentView";
import { commercialFingerprint, type ProposalCommercialDocumentV1 } from "./commercialDocument";

const hooks = vi.hoisted(() => ({ index: 0, values: [] as unknown[] }));
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(), useState: (initial: unknown) => {
  const index = hooks.index++;
  if (!(index in hooks.values)) hooks.values[index] = initial;
  return [hooks.values[index], (next: unknown) => { hooks.values[index] = typeof next === "function" ? next(hooks.values[index]) : next; }];
} }));
type Props = { children?: ReactNode; disabled?: boolean; value?: unknown; href?: string; id?: string; "data-question-id"?: string; "aria-label"?: string; role?: string; onClick?: () => void; onChange?: (event: { target: { value: string } }) => void };
const text = (node: ReactNode): string => Array.isArray(node) ? node.map(text).join("") : isValidElement<Props>(node) ? text(node.props.children) : typeof node === "string" || typeof node === "number" ? String(node) : "";
function find(node: ReactNode, check: (type: unknown, props: Props) => boolean): Props | undefined {
  if (Array.isArray(node)) { for (const child of node) { const result = find(child, check); if (result) return result; } }
  else if (isValidElement<Props>(node)) { if (check(node.type, node.props)) return node.props; return find(node.props.children, check); }
}
beforeEach(() => { hooks.index = 0; hooks.values = []; });
async function fixture(): Promise<ProposalCommercialDocumentV1> {
  const quote = "Анализ по предоставленным материалам.";
  return {
    version: 1, revision: 3,
    body: { version: 1, sections: [{ id: "scope", kind: "scope", title: "Состав работ", blocks: [
      { id: "intro", kind: "paragraph", style: "body", content: [{ kind: "text", text: quote }, { kind: "local-ref", targetId: "table" }] },
      { id: "list", kind: "list", style: "bullet", items: [[{ kind: "text", text: "Доступ к материалам" }], [{ kind: "text", text: "Без вмешательства" }]] },
      { id: "table", kind: "table", columns: ["Этап", "Результат"], rows: [[[{ kind: "text", text: "Анализ" }], [{ kind: "text", text: "Отчёт" }]], [[{ kind: "text", text: "Обсуждение" }], [{ kind: "text", text: "Протокол" }]]] },
    ] }] },
    privateAppendix: { version: 1, sourceSnapshotKey: await commercialFingerprint("snapshot"), documentId: "source-document", extraction: { complete: true, requiresOcr: false, visualAssessment: "unassessed" }, containers: [{ id: "contract", sourceId: "source", kind: "contract", heading: "Договор" }], clauses: [{ id: "clause", containerId: "contract", sourceId: "source", sourceName: "Источник", locator: "Абзац 1", quote, quoteHash: await commercialFingerprint(quote), roles: ["scope"], classification: "commercial" }], references: [], coverage: [{ sourceClauseId: "clause", kind: "literal", targetBlockIds: ["intro"] }] },
    questions: [], decisions: [],
  };
}
async function setup() {
  let value = await fixture(), readOnly = false;
  const onChange = vi.fn((next: ProposalCommercialDocumentV1) => { value = next; return true; });
  const render = () => { hooks.index = 0; return CommercialDocumentView({ value, onChange, readOnly }); };
  const field = (label: string) => find(render(), (_type, props) => props["aria-label"] === label)!;
  const button = (label: string) => find(render(), (type, props) => type === "button" && text(props.children) === label)!;
  const begin = (ordinal = "1.1") => field(`Изменить текст пункта ${ordinal}`).onClick!();
  const change = (label: string, next: string) => field(label).onChange!({ target: { value: next } });
  return { get value() { return value; }, set value(next: ProposalCommercialDocumentV1) { value = next; }, set readOnly(next: boolean) { readOnly = next; }, render, field, button, begin, change, onChange };
}

describe("controlled working commercial document", () => {
  it("keeps distinct questions with identical wording addressable beside their original section", async () => {
    const ui = await setup(), fingerprint = ui.value.privateAppendix.sourceSnapshotKey;
    ui.value.questions = ["intro", "list"].map((blockId, index) => ({ id: `question-source-reference-${index}`, kind: "source-reference", sectionId: "scope", targetBlockIds: [blockId], sourceClauseIds: ["clause"], sourceReferenceIds: [], message: "Нужно проверить исходную ссылку.", material: true, dependencyFingerprint: fingerprint }));
    const original = structuredClone(ui.value), rendered = ui.render();
    expect(text(rendered)).toContain("Вопросы по разделу: 2"); expect(text(rendered).match(/Нужно проверить исходную ссылку\./g)).toHaveLength(2);
    for (const question of ui.value.questions) expect(find(rendered, (_type, props) => props.id === `commercial-question-${question.id}`)?.["data-question-id"]).toBe(question.id);
    expect(text(rendered)).not.toContain("question-source-reference-"); expect(ui.value).toEqual(original); expect(ui.onChange).not.toHaveBeenCalled();
  });
  it("edits inline text only after Apply and keeps the source, siblings, history and local reference intact", async () => {
    const ui = await setup(), original = structuredClone(ui.value);
    ui.begin(); ui.change("Текст пункта 1.1, группа 1, фрагмент 1", "Согласованный анализ.");
    expect(ui.onChange).not.toHaveBeenCalled(); expect(ui.value).toEqual(original);
    ui.button("Применить текст").onClick!();
    expect(ui.onChange).toHaveBeenCalledOnce(); expect(ui.value.revision).toBe(4);
    const block = ui.value.body.sections[0].blocks[0];
    expect(block.kind === "paragraph" && block.content).toEqual([{ kind: "text", text: "Согласованный анализ." }, { kind: "local-ref", targetId: "table" }]);
    expect(ui.value.privateAppendix).toEqual(original.privateAppendix); expect(ui.value.decisions).toEqual(original.decisions);
    expect(ui.value.body.sections[0].blocks.slice(1)).toEqual(original.body.sections[0].blocks.slice(1));
    expect(find(ui.render(), (type, props) => type === "a" && props.href === "#commercial-table")).toBeDefined();
    expect(text(ui.render())).toContain("может сделать прежние решения неактуальными");
  });
  it("cancels an unapplied draft without changing the controlled document", async () => {
    const ui = await setup(), original = structuredClone(ui.value);
    ui.begin(); ui.change("Текст пункта 1.1, группа 1, фрагмент 1", "Не применять"); ui.button("Отменить правки").onClick!();
    expect(ui.value).toEqual(original); expect(ui.onChange).not.toHaveBeenCalled(); expect(find(ui.render(), (type) => type === "textarea")).toBeUndefined();
  });
  it("does not reset an unapplied draft on a repeated Begin click and allows only one active block", async () => {
    const ui = await setup(); ui.begin(); ui.change("Текст пункта 1.1, группа 1, фрагмент 1", "Моя правка"); ui.begin();
    expect(ui.field("Текст пункта 1.1, группа 1, фрагмент 1").value).toBe("Моя правка");
    expect(ui.field("Изменить текст пункта 1.2").disabled).toBe(true); ui.begin("1.2");
    expect(ui.field("Текст пункта 1.1, группа 1, фрагмент 1").value).toBe("Моя правка"); expect(text(ui.render())).toContain("Они не потеряны");
  });
  it("refuses to overwrite a newer document but keeps the old draft available for recovery", async () => {
    const ui = await setup(); ui.begin(); ui.change("Текст пункта 1.1, группа 1, фрагмент 1", "Моя правка");
    ui.value = { ...structuredClone(ui.value), revision: 4 }; ui.button("Применить текст").onClick!();
    expect(ui.onChange).not.toHaveBeenCalled(); expect(text(ui.render())).toContain("Документ изменился");
    expect(ui.field("Текст пункта 1.1, группа 1, фрагмент 1").value).toBe("Моя правка");
  });
  it("does not grant write access when the controlled receiver becomes read-only", async () => {
    const ui = await setup(); ui.readOnly = true;
    expect(find(ui.render(), (_type, props) => props["aria-label"] === "Изменить текст пункта 1.1")).toBeUndefined();
    ui.readOnly = false; ui.begin(); ui.readOnly = true;
    expect(ui.field("Текст пункта 1.1, группа 1, фрагмент 1").disabled).toBe(true); expect(ui.button("Применить текст").disabled).toBe(true);
    ui.change("Текст пункта 1.1, группа 1, фрагмент 1", "Нельзя"); ui.button("Применить текст").onClick!(); expect(ui.onChange).not.toHaveBeenCalled();
    ui.button("Отменить правки").onClick!(); expect(find(ui.render(), (type) => type === "textarea")).toBeUndefined();
  });
  it("keeps a detached draft recoverable when another document has entirely different block IDs", async () => {
    const ui = await setup(); ui.begin(); ui.change("Текст пункта 1.1, группа 1, фрагмент 1", "Не потерять при переключении");
    const next = await fixture(); next.privateAppendix.documentId = "other-document";
    for (const section of next.body.sections) for (const block of section.blocks) block.id = `other-${block.id}`;
    ui.value = next;
    expect(ui.field("Текст пункта 1.1, группа 1, фрагмент 1").value).toBe("Не потерять при переключении");
    expect(find(ui.render(), (_type, props) => props["aria-label"] === "Неприменённые правки предыдущего документа")).toBeDefined();
    expect(ui.button("Применить текст").disabled).toBe(true); ui.button("Применить текст").onClick!(); expect(ui.onChange).not.toHaveBeenCalled();
    ui.button("Отменить правки").onClick!(); expect(ui.field("Изменить текст пункта 1.1").disabled).toBe(false);
  });
  it("edits independent list entries and table cells without changing their structure or siblings", async () => {
    const ui = await setup(); ui.begin("1.2"); ui.change("Текст пункта 1.2, группа 2, фрагмент 1", "Без разрушительных тестов"); ui.button("Применить текст").onClick!();
    expect(ui.value.body.sections[0].blocks[1]).toMatchObject({ kind: "list", items: [[{ text: "Доступ к материалам" }], [{ text: "Без разрушительных тестов" }]] });
    ui.begin("1.3"); ui.change("Текст пункта 1.3, группа 4, фрагмент 1", "Протокол согласования"); ui.button("Применить текст").onClick!();
    expect(ui.value.body.sections[0].blocks[2]).toMatchObject({ kind: "table", columns: ["Этап", "Результат"], rows: [[[{ text: "Анализ" }], [{ text: "Отчёт" }]], [[{ text: "Обсуждение" }], [{ text: "Протокол согласования" }]]] }); expect(ui.value.revision).toBe(5);
  });
  it("retains text and reports validation errors instead of silently truncating it", async () => {
    const ui = await setup(); ui.begin(); const tooLong = "я".repeat(20001); ui.change("Текст пункта 1.1, группа 1, фрагмент 1", tooLong); ui.button("Применить текст").onClick!();
    expect(ui.onChange).not.toHaveBeenCalled(); expect(ui.field("Текст пункта 1.1, группа 1, фрагмент 1").value).toBe(tooLong); expect(find(ui.render(), (_type, props) => props.role === "alert")).toBeDefined();
  });
  it("keeps an unapplied draft when the parent refuses the update", async () => {
    const ui = await setup(); ui.onChange.mockImplementationOnce(() => { throw new Error("Сессия изменилась"); }); ui.begin(); ui.change("Текст пункта 1.1, группа 1, фрагмент 1", "Сохранить для переноса"); ui.button("Применить текст").onClick!();
    expect(ui.value.revision).toBe(3); expect(ui.field("Текст пункта 1.1, группа 1, фрагмент 1").value).toBe("Сохранить для переноса"); expect(text(ui.render())).toContain("Сессия изменилась");
  });
  it("does not discard a draft after a silent owner rejection", async () => {
    const ui = await setup(); ui.onChange.mockImplementationOnce(() => false); ui.begin(); ui.change("Текст пункта 1.1, группа 1, фрагмент 1", "Непринятый текст"); ui.button("Применить текст").onClick!();
    expect(ui.value.revision).toBe(3); expect(ui.field("Текст пункта 1.1, группа 1, фрагмент 1").value).toBe("Непринятый текст"); expect(text(ui.render())).toContain("Редактор не принял изменение");
  });
  it("refuses an in-place mutation of the base object as well as a replaced controlled value", async () => {
    const ui = await setup(); ui.begin(); ui.change("Текст пункта 1.1, группа 1, фрагмент 1", "Устаревшая правка");
    ui.value.revision++; const block = ui.value.body.sections[0].blocks[0]; if (block.kind === "paragraph") block.content[0] = { kind: "text", text: "Новая редакция" };
    ui.button("Применить текст").onClick!(); expect(ui.onChange).not.toHaveBeenCalled(); expect(ui.value.revision).toBe(4); expect(text(ui.render())).toContain("Документ изменился");
  });
  it("never advances an unsafe revision", async () => {
    const ui = await setup(); ui.value = { ...ui.value, revision: Number.MAX_SAFE_INTEGER }; ui.begin(); ui.button("Применить текст").onClick!(); expect(ui.onChange).not.toHaveBeenCalled(); expect(text(ui.render())).toContain("предел редакций");
  });
});
