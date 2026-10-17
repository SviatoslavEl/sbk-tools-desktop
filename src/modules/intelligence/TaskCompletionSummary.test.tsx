import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ItemTaskCompletionSummary, TaskCompletionSummary } from "./TaskCompletionSummary";
import type { ItemTaskCompletion, TaskCompletionEvidence, TaskCompletionIssue, TaskCompletionReport } from "./taskCompletion";

const proof = (quote: string, sourceId = "source-a"): TaskCompletionEvidence => ({ sourceId, sourceName: `${sourceId}.docx`, fragmentId: "paragraph-2", locator: "Абзац 2", quote });
const issue = (id: string, evidence: TaskCompletionEvidence[], patch: Partial<TaskCompletionIssue> = {}): TaskCompletionIssue => ({ id, code: "missing-source-content", severity: "missing", destination: "proposals", itemIds: ["card"], message: "Сохраните полное условие выполнения работ.", evidence, ...patch });
const card = (issues: TaskCompletionIssue[]): ItemTaskCompletion => ({ itemId: "card", destination: "proposals", status: "insufficient", canTransferPrepared: false, canOpenIncompleteDraft: true, priceReviewRequired: false, issueIds: issues.map((entry) => entry.id), missingCore: [] });
const report = (issues: TaskCompletionIssue[]): TaskCompletionReport => ({ status: "insufficient", snapshotKey: "immutable-source-and-result", limited: false, items: [card(issues)], checks: [], issues, destinations: [], counts: { assessed: 0, covered: 0, missing: issues.filter((entry) => entry.severity === "missing").length, ambiguous: 0, notAssessed: issues.filter((entry) => entry.severity === "not-assessed").length, questions: issues.filter((entry) => entry.severity === "question").length } });
function freeze<T>(value: T): T { if (value && typeof value === "object") { Object.freeze(value); Object.values(value).forEach(freeze); } return value; }
const renderItem = (value: TaskCompletionReport, item = value.items[0]) => renderToStaticMarkup(<ItemTaskCompletionSummary report={value} item={item} />);
const occurrences = (value: string, part: string) => value.split(part).length - 1;

describe("task completion presentation grouping", () => {
  it("groups identical messages while keeping the original issue count and every distinct quote", () => {
    const value = report([issue("one", [proof("Срок — 3 рабочих дня после аванса.")]), issue("two", [proof("Материалы передаются в DOCX и PDF.")])]);
    const html = renderItem(value);
    expect(occurrences(html, "Сохраните полное условие выполнения работ.")).toBe(1);
    expect(html).toContain("Что осталось проверить (1)");
    expect(html).toContain("Исходных условий: 2.");
    expect(html).toContain("Срок — 3 рабочих дня после аванса.");
    expect(html).toContain("Материалы передаются в DOCX и PDF.");
    expect(occurrences(html, "<blockquote>")).toBe(2);
  });

  it("deduplicates an exact proof but never merges another source, locator or changed condition", () => {
    const shared = proof("Работы выполняются только в согласованных границах.");
    const value = report([
      issue("one", [shared, { ...shared }]),
      issue("two", [{ ...shared }, proof(shared.quote, "source-b"), { ...shared, locator: "Абзац 3", fragmentId: "paragraph-3", quote: "Работы выполняются только в согласованных границах при наличии разрешения." }]),
    ]);
    const html = renderItem(value);
    expect(occurrences(html, "<blockquote>")).toBe(3);
    expect(html).toContain("source-a.docx"); expect(html).toContain("source-b.docx");
    expect(html).toContain("Абзац 3");
    expect(html).toContain("при наличии разрешения.");
  });

  it("does not collapse different severities into the severity of the first message", () => {
    const value = report([
      issue("missing", [proof("Срок не перенесён.")]),
      issue("unassessed", [proof("Вторая страница требует OCR.")], { severity: "not-assessed" }),
    ]);
    const html = renderItem(value);
    expect(occurrences(html, "Сохраните полное условие выполнения работ.")).toBe(2);
    expect(html).toContain('class="iw-task-issue missing"');
    expect(html).toContain('class="iw-task-issue not-assessed"');
    expect(html).toContain("Что осталось проверить (2)");
    expect(html).not.toContain("Исходных условий: 2.");
  });

  it("keeps global problems of different destinations as separate groups", () => {
    const value = report([
      issue("proposal", [proof("Состав предложения.")], { itemIds: [], destination: "proposals" }),
      issue("contract", [proof("Предмет договора.")], { itemIds: [], destination: "contracts" }),
    ]);
    const html = renderToStaticMarkup(<TaskCompletionSummary report={value} />);
    expect(occurrences(html, "Сохраните полное условие выполнения работ.")).toBe(2);
    expect(html).toContain("Состав предложения."); expect(html).toContain("Предмет договора.");
    expect(html).not.toContain("Исходных условий: 2.");
  });

  it("groups global duplicates without leaking an issue already assigned to another card", () => {
    const value = report([
      issue("global-one", [proof("Первое отсутствующее условие.")], { itemIds: [] }),
      issue("global-two", [proof("Второе отсутствующее условие.")], { itemIds: [] }),
      issue("bound", [proof("Отдельное замечание другой карточки.")], { itemIds: ["another-card"] }),
    ]);
    const html = renderToStaticMarkup(<TaskCompletionSummary report={value} />);
    expect(html).toContain("Исходных условий: 2.");
    expect(html).toContain("Показать источники (2)");
    expect(html).not.toContain("Отдельное замечание другой карточки.");
    const itemHtml = renderItem(value, { ...card(value.issues), issueIds: ["global-one"] });
    expect(itemHtml).toContain("Первое отсутствующее условие.");
    expect(itemHtml).not.toContain("Второе отсутствующее условие.");
  });

  it("never changes underlying blocking, readiness, identifiers or source evidence while rendering", () => {
    const value = report([issue("one", [proof("Срок — 3 дня.")]), issue("two", [proof("Срок — 5 дней.")])]);
    value.status = "not-assessed"; value.items[0].status = "not-assessed"; value.items[0].canOpenIncompleteDraft = false;
    const before = structuredClone(value); freeze(value);
    const html = renderItem(value);
    expect(html).toContain("Полнота не установлена");
    expect(value).toEqual(before);
    expect(value.items[0].canTransferPrepared).toBe(false);
    expect(value.items[0].canOpenIncompleteDraft).toBe(false);
    expect(value.items[0].issueIds).toEqual(["one", "two"]);
    expect(value.issues).toHaveLength(2);
  });

  it("retains the previous-attempt label and does not invent content for absent reports", () => {
    const value = report([issue("one", [proof("Необработанный раздел.")], { itemIds: [] })]);
    const html = renderToStaticMarkup(<TaskCompletionSummary report={value} previous />);
    expect(html).toContain("Предыдущий результат · Результат подготовлен не полностью");
    expect(renderToStaticMarkup(<TaskCompletionSummary />)).toBe("");
    expect(renderToStaticMarkup(<ItemTaskCompletionSummary report={value} />)).toBe("");
  });
});
