import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "../../components/Dialog";
import { IntelligenceWorkbench, evidenceAuditTimeoutMilliseconds } from "./IntelligenceWorkbench";
import { SourceFactsDesk } from "./SourceFactsDesk";
import { repairDateFromSource } from "./sourceRepairs";
import { AutomaticConditionsSummary } from "./AutomaticConditionsSummary";
import { runResponsePreparation, type ResponsePreparationRequest } from "./responsePreparationWorker";
import { runEvidenceAudit, type EvidenceAuditRequest, type EvidenceAuditReply } from "./evidenceAuditWorker";
import type { IntelligenceHandoff } from "./workbenchTypes";

// Exercise the real component's state, effects and callbacks. Native IO and
// inference are mocked boundaries; the response schema and handoff model are real.
const runtime = vi.hoisted(() => ({ cursor: 0, changed: false,
  slots: [] as Array<{ value?: unknown; deps?: readonly unknown[]; cleanup?: () => void }>, effects: [] as Array<() => void>,
  editor: true, phase: "connected", chooseOpen: vi.fn(), invoke: vi.fn(), workspace: vi.fn(), testConnection: vi.fn(), analyze: vi.fn(), cancel: vi.fn(),
}));
vi.mock("react", async (original) => {
  const same = (a?: readonly unknown[], b?: readonly unknown[]) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const memo = (factory: () => unknown, deps?: readonly unknown[]) => { const index = runtime.cursor++; if (!runtime.slots[index] || !same(runtime.slots[index].deps, deps)) runtime.slots[index] = { value: factory(), deps }; return runtime.slots[index].value; };
  return { ...await original<typeof import("react")>(),
    useState: (initial: unknown) => { const index = runtime.cursor++; if (!runtime.slots[index]) runtime.slots[index] = { value: typeof initial === "function" ? initial() : initial }; return [runtime.slots[index].value, (next: unknown) => { const value = typeof next === "function" ? next(runtime.slots[index].value) : next; if (!Object.is(value, runtime.slots[index].value)) { runtime.slots[index].value = value; runtime.changed = true; } }]; },
    useRef: (initial: unknown) => { const index = runtime.cursor++; if (!runtime.slots[index]) runtime.slots[index] = { value: { current: initial } }; return runtime.slots[index].value; }, useMemo: memo,
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => { const index = runtime.cursor++; const previous = runtime.slots[index]; if (previous && same(previous.deps, deps)) return; runtime.slots[index] = { ...previous, deps }; runtime.effects.push(() => { previous?.cleanup?.(); const cleanup = effect(); runtime.slots[index].cleanup = typeof cleanup === "function" ? cleanup : undefined; }); },
  };
});
vi.mock("../../lib/workspaceAccess", () => ({ useWorkspaceAccess: () => ({ editor: runtime.editor, message: "Тестовый режим" }) }));
vi.mock("../../lib/networkDiagnostics", () => ({ useNetworkAccess: () => ({ phase: runtime.phase }), networkAccessIsPaused: () => runtime.phase !== "connected", invoke: runtime.invoke }));
vi.mock("../../lib/files", () => ({ chooseOpenPath: runtime.chooseOpen }));
vi.mock("../../lib/storage", () => ({ getWorkspaceInfo: runtime.workspace }));
vi.mock("./connectionApi", async (original) => ({ ...await original<typeof import("./connectionApi")>(), testIntelligenceConnection: runtime.testConnection, runIntelligenceAnalysis: runtime.analyze, cancelIntelligenceRequest: runtime.cancel }));

interface NodeProps { children?: ReactNode; value?: unknown; checked?: boolean; id?: string; type?: string; disabled?: boolean; className?: string; open?: boolean; readOnly?: boolean; ref?: { current: { focus: () => void } | null }; "aria-label"?: string; onClick?: () => unknown; onChange?: (event: { target: { value: string; checked: boolean } }) => unknown; onConfirm?: () => unknown; onClose?: () => void; }
let tree: ReactNode;
let props: Parameters<typeof IntelligenceWorkbench>[0];
let localValues: Map<string, string>;
let transfer: ReturnType<typeof vi.fn<(handoff: IntelligenceHandoff) => void>>;
function render(next = props) { props = next; runtime.cursor = 0; runtime.changed = false; tree = IntelligenceWorkbench(props); for (const effect of runtime.effects.splice(0)) effect(); }
async function flush() { for (let i = 0; i < 30; i++) { await Promise.resolve(); if (runtime.changed) render(); } }
function nodes(node: ReactNode = tree): ReactElement<NodeProps>[] { if (Array.isArray(node)) return node.flatMap((child) => nodes(child ?? null)); if (!isValidElement<NodeProps>(node)) return []; return [node, ...nodes(node.props.children ?? null)]; }
function text(node: ReactNode = tree): string { if (Array.isArray(node)) return node.map((child) => text(child ?? null)).join(""); if (isValidElement<NodeProps>(node)) return text(node.props.children ?? null); return typeof node === "string" || typeof node === "number" ? String(node) : ""; }
function button(label: string) { const found = nodes().find((node) => node.type === "button" && text(node.props.children) === label); if (!found) throw new Error(`Кнопка не найдена: ${label}`); return found; }
function control(id: string) { const found = nodes().find((node) => node.props.id === id); if (!found) throw new Error(`Поле не найдено: ${id}`); return found; }
function labeled(label: string) { const found = nodes().find((node) => node.props["aria-label"] === label); if (!found) throw new Error(`Элемент не найден: ${label}`); return found; }
function sourceId(name: string) { const found = nodes().find((node) => node.type === "li" && text(node.props.children).includes(name)); if (!found?.key) throw new Error(`Источник не найден: ${name}`); return String(found.key); }
function field(key: string) { const found = nodes().find((node) => typeof node.props.id === "string" && /^iw-[0-9a-f]{8}-/.test(node.props.id) && node.props.id.endsWith(`-${key}`)); if (!found) throw new Error(`Поле карточки не найдено: ${key}`); return found; }
async function click(label: string) { button(label).props.onClick!(); await flush(); }
async function edit(id: string, value: string) { control(id).props.onChange!({ target: { value, checked: false } }); await flush(); }
async function editLabeled(label: string, value: string) { labeled(label).props.onChange!({ target: { value, checked: false } }); await flush(); }
async function toggle(label: string, checked: boolean) { const found = nodes().find((node) => node.props["aria-label"] === label); if (!found) throw new Error(`Чекбокс не найден: ${label}`); found.props.onChange!({ target: { value: "", checked } }); await flush(); }
async function reviewVisibleFindings(resultIndex?: number) { const checks = nodes().filter((node) => /^Проверено замечание /.test(node.props["aria-label"] || "") && (resultIndex === undefined || node.props["aria-label"]?.endsWith(`результата ${resultIndex}`))); for (const check of checks) check.props.onChange!({ target: { value: "", checked: true } }); await flush(); }
async function confirm() { nodes().find((node) => node.type === ConfirmDialog)!.props.onConfirm!(); await flush(); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((yes) => { resolve = yes; }); return { promise, resolve }; }
const result = (items: unknown[]) => JSON.stringify({ items });
const procurement = { destination: "procurement", title: "Тендер", fields: { name: "Тестовая закупка", customer: "Заказчик", nmc: 1000 } };
async function addText(name = "ТЗ", value = "Открытый текст закупки") { await edit("iw-source-name", name); await edit("iw-source-text", value); await click("Добавить текст"); }
async function paste(items: unknown[] = [procurement]) { await edit("iw-response", result(items)); await click("Разобрать ответ"); }
async function configureModel() { if (!nodes().some((node) => node.props.id === "iw-model")) await click("Настроить подключение"); await edit("iw-model", "qa-model"); }
function holdPreparations() {
  const preparations: PreparationWorker[] = [];
  class PreparationWorker {
    request!: ResponsePreparationRequest;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    onmessageerror: ((event: Event) => void) | null = null;
    terminated = false;
    constructor(readonly url: URL) {}
    postMessage(request: ResponsePreparationRequest | EvidenceAuditRequest) {
      if (this.url.pathname.endsWith("responsePreparationWorker.ts")) { this.request = request as ResponsePreparationRequest; preparations.push(this); }
      else this.onmessage?.({ data: runEvidenceAudit(request as EvidenceAuditRequest) });
    }
    terminate() { this.terminated = true; }
    reply(value: unknown = runResponsePreparation(this.request)) { this.onmessage?.({ data: value }); }
  }
  vi.stubGlobal("Worker", PreparationWorker);
  return preparations;
}
function holdAudits() {
  const audits: AuditWorker[] = [];
  class AuditWorker {
    request!: EvidenceAuditRequest;
    onmessage: ((event: { data: EvidenceAuditReply | ReturnType<typeof runResponsePreparation> }) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    onmessageerror: ((event: Event) => void) | null = null;
    terminated = false;
    constructor(readonly url: URL) { if (url.pathname.endsWith("evidenceAuditWorker.ts")) audits.push(this); }
    postMessage(request: EvidenceAuditRequest | ResponsePreparationRequest) {
      if (this.url.pathname.endsWith("responsePreparationWorker.ts")) this.onmessage?.({ data: runResponsePreparation(request) });
      else this.request = request as EvidenceAuditRequest;
    }
    terminate() { this.terminated = true; }
  }
  vi.stubGlobal("Worker", AuditWorker);
  return audits;
}

beforeEach(() => {
  runtime.cursor = 0; runtime.changed = false; runtime.slots = []; runtime.effects = []; runtime.editor = true; runtime.phase = "connected";
  for (const mock of [runtime.chooseOpen, runtime.invoke, runtime.workspace, runtime.testConnection, runtime.analyze, runtime.cancel]) mock.mockReset();
  runtime.workspace.mockResolvedValue({ root: "/qa-workspace", editor: true }); runtime.cancel.mockResolvedValue(undefined); runtime.chooseOpen.mockResolvedValue("/qa/source.pdf");
  runtime.invoke.mockResolvedValue({ fileName: "ТЗ.pdf", extractedText: "Документ закупки", sha256: "a".repeat(64), fragments: [{ locator: "Страница 1", text: "Документ закупки" }], warnings: [] });
  runtime.testConnection.mockResolvedValue({ models: ["qa-model"], message: "Соединение установлено" }); runtime.analyze.mockResolvedValue({ text: result([procurement]), model: "qa-model" });
  localValues = new Map();
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {}, localStorage: { getItem: (key: string) => localValues.get(key) ?? null, setItem: (key: string, value: string) => localValues.set(key, value) } });
  transfer = vi.fn(); props = { workspaceRoot: "/qa-workspace", onTransfer: transfer }; render();
});
afterEach(() => { for (const slot of runtime.slots) slot.cleanup?.(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("unified intelligence workflow", () => {
  it("inflects source, character and fragment counters without changing the counts", async () => {
    runtime.invoke.mockResolvedValueOnce({ fileName: "QA.pdf", extractedText: "a", sha256: "a".repeat(64), fragments: [{ id: "page-1", locator: "Страница 1", text: "a" }], warnings: [] });
    await click("Добавить PDF, DOCX или XLSX");
    expect(text()).toContain("1 символ · 1 фрагмент");
    expect(text()).toContain("К отправке: 1 источник · 1 символ");
    await addText("Заметка", "b");
    expect(text()).toContain("К отправке: 2 источника · 2 символа");
    expect(text()).not.toContain("1 источников");
    expect(text()).not.toContain("1 фрагментов");
  });
  it("automatically includes all nine certificates and eight application documents when accepting the actual model boundary response", async () => {
    const certificates = [["OSCP", 5], ["OSEP", 2], ["BSCP", 3], ["OSWE", 3], ["OSWP", 3], ["KLCP", 1], ["eJPT", 1], ["CompTIA Pentest+", 1], ["HTB CPTS", 3]].map(([label, minimum]) => `o\tСертификат ${label} — не менее ${minimum};`);
    const documents = Array.from({ length: 8 }, (_, index) => `${index + 1}. Копия документа заявки ${index + 1}, если применимо.`);
    await configureModel(); await click("Закупка"); await addText("Извещение QA", ["Закупка QA", ...certificates, ...documents].join("\n"));
    const raw = result([{ destination: "procurement", title: "Закупка QA", fields: { name: "Закупка QA", requirements: [] } }]);
    runtime.analyze.mockResolvedValueOnce({ text: raw, model: "qa-model" }); await click("Отправить выбранные источники");
    expect(field("requirements").props.value).toBe([...certificates, ...documents].join("\n"));
    expect(text()).toContain("Из источников автоматически добавлено пунктов: 17"); expect(control("iw-response").props.value).toBe(raw);
    const receipt = nodes().find((node) => node.type === AutomaticConditionsSummary)!.props as unknown as Parameters<typeof AutomaticConditionsSummary>[0];
    expect(receipt.receipt?.changes).toHaveLength(17); expect(receipt.receipt?.skipped).toHaveLength(0);
    expect(nodes().some((node) => node.type === "input" && /^Проверено замечание /.test(node.props["aria-label"] || "") && node.props.checked)).toBe(false);
    expect(runtime.analyze).toHaveBeenCalledTimes(1); expect(runtime.invoke).not.toHaveBeenCalled(); expect(transfer).not.toHaveBeenCalled();
    await reviewVisibleFindings(); await click("Открыть черновик: Закупки");
    const handoff = transfer.mock.calls[0][0]; expect(handoff.destination).toBe("procurement");
    if (handoff.destination === "procurement") { expect(handoff.data.requirements).toHaveLength(17); expect(handoff.data.requirements.every((entry) => !entry.mandatory && entry.status === "Не подтверждено")).toBe(true); }
  });
  it("never refills automatically added requirements after a manual edit or field deselection", async () => {
    await addText("Извещение", "Закупка QA\nСертификат OSCP — не менее 5;");
    await paste([{ destination: "procurement", title: "QA", fields: { name: "Закупка QA", requirements: [] } }]);
    expect(field("requirements").props.value).toContain("OSCP");
    field("requirements").props.onChange!({ target: { value: "Ручная формулировка", checked: false } }); await flush();
    await toggle("Передать поле Требования результата 1", false); render({ ...props, active: false }); await flush(); render({ ...props, active: true }); await flush();
    expect(field("requirements").props.value).toBe("Ручная формулировка"); expect(labeled("Передать поле Требования результата 1").props.checked).toBe(false);
    expect(runtime.analyze).not.toHaveBeenCalled(); expect(runtime.workspace).not.toHaveBeenCalled();
  });
  it("keeps old cards and decisions until local preparation completes, and rejects its late reply after cancellation", async () => {
    await addText(); await paste(); await reviewVisibleFindings(); const oldName = field("name").props.value;
    const jobs = holdPreparations(); await edit("iw-response", result([{ ...procurement, title: "Новый ответ", fields: { name: "Новый ответ" } }])); await click("Разобрать ответ"); await confirm();
    expect(jobs).toHaveLength(1); expect(text()).toContain("Подготавливаем карточки, сертификаты и условия"); expect(field("name").props.value).toBe(oldName);
    expect(button("Открыть черновик: Закупки").props.disabled).toBe(true); button("Открыть черновик: Закупки").props.onClick!(); await flush(); expect(runtime.workspace).not.toHaveBeenCalled();
    const stale = jobs[0].onmessage!; await click("Остановить разбор"); expect(jobs[0].terminated).toBe(true);
    stale({ data: runResponsePreparation(jobs[0].request) }); await flush(); expect(field("name").props.value).toBe(oldName);
    expect(text()).not.toContain("Подготавливаем карточки, сертификаты и условия из источников…");
  });
  it.each(["failure", "empty", "malformed"] as const)("preserves the previous accepted result when local preparation returns %s", async (kind) => {
    await addText(); await paste(); await reviewVisibleFindings(); const oldName = field("name").props.value;
    const oldReceipt = (nodes().find((node) => node.type === AutomaticConditionsSummary)!.props as unknown as Parameters<typeof AutomaticConditionsSummary>[0]).receipt;
    const jobs = holdPreparations(); await edit("iw-response", result([procurement])); await click("Разобрать ответ"); await confirm();
    const revision = jobs[0].request.revision;
    jobs[0].reply(kind === "failure" ? { revision, failed: "Не удалось извлечь данные" } : kind === "empty" ? { revision, empty: true } : null); await flush();
    expect(field("name").props.value).toBe(oldName);
    expect((nodes().find((node) => node.type === AutomaticConditionsSummary)!.props as unknown as Parameters<typeof AutomaticConditionsSummary>[0]).receipt).toBe(oldReceipt);
    expect(jobs[0].terminated).toBe(true); expect(runtime.workspace).not.toHaveBeenCalled(); expect(transfer).not.toHaveBeenCalled();
    expect(text()).toContain(kind === "failure" ? "Не удалось извлечь данные" : kind === "empty" ? "Модель не подготовила ни одной карточки" : "некорректный результат");
  });
  it("ignores a pending prepared result after its source or workspace changes", async () => {
    await addText(); const jobs = holdPreparations(); await paste(); const first = jobs[0], stale = first.onmessage!;
    await editLabeled("Текст источника ТЗ", "Исправленный источник"); stale({ data: runResponsePreparation(first.request) }); await flush();
    expect(nodes().filter((node) => node.props.className === "iw-card")).toHaveLength(0); expect(first.terminated).toBe(true);
    await click("Разобрать ответ"); const second = jobs[1]; render({ ...props, workspaceRoot: "/other-workspace" }); await flush(); second.reply(); await flush();
    expect(nodes().filter((node) => node.props.className === "iw-card")).toHaveLength(0); expect(runtime.workspace).not.toHaveBeenCalled();
  });
  it("lazily shares local source facts and applies a date only to the current draft, preserving the raw answer and resetting decisions", async () => {
    await addText("Извещение", "Дата окончания подачи заявок: 21.10.2026 16:00 МСК.");
    await paste([{ ...procurement, fields: { name: "Закупка", submissionDeadline: "2110-26-16" }, sourceIds: [sourceId("Извещение")] }]);
    await reviewVisibleFindings();
    const desk = () => nodes().find((node) => node.type === SourceFactsDesk)!.props as unknown as Parameters<typeof SourceFactsDesk>[0];
    expect(desk().inventory).toBeUndefined(); expect(runtime.analyze).not.toHaveBeenCalled();
    const originalRaw = control("iw-response").props.value;
    desk().onRequest(); await flush();
    const current = desk(), fact = current.inventory!.dates.facts.find((entry) => entry.event === "submission-end")!;
    expect(fact.iso).toBe("2026-10-21");
    const applyStale = current.onApply, patch = repairDateFromSource(current.item, fact, current.sources);
    current.onApply(patch); await flush();
    expect(field("submissionDeadline").props.value).toBe("2026-10-21");
    expect(field("notes").props.value).toContain("16:00");
    expect(control("iw-response").props.value).toBe(originalRaw);
    expect(nodes().filter((node) => /^Проверено замечание /.test(node.props["aria-label"] || "")).every((node) => !node.props.checked)).toBe(true);
    expect(() => applyStale(patch)).toThrow("Карточка изменилась");
    expect(runtime.invoke).not.toHaveBeenCalled(); expect(runtime.analyze).not.toHaveBeenCalled(); expect(transfer).not.toHaveBeenCalled();
    await click("Новая задача"); await confirm(); await addText(); await paste();
    expect(desk().inventory).toBeUndefined(); // A new task remains lazy again.
  });
  it("passes source-bound date choices to the model without allowing a relative duration to become validity date", async () => {
    await configureModel(); await click("КП"); await addText("КП", "Дата КП: 02.10.2026. Срок действия предложения: 14 дней.");
    runtime.analyze.mockResolvedValueOnce({ text: result([{ destination: "proposals", title: "КП", fields: { title: "Поставка" }, positions: [] }]), model: "qa-model" });
    await click("Отправить выбранные источники");
    const schema = runtime.analyze.mock.calls[0][4] as { properties: { items: { items: { properties: { fields: { properties: Record<string, { enum?: unknown[] }> } } } } } };
    const fields = schema.properties.items.items.properties.fields.properties;
    expect(fields.documentDate.enum).toEqual(["2026-10-02", null]); expect(fields.validUntil.enum).toEqual([null]);
    const actualSchema = schema as unknown as { properties: { items: { items: { properties: { sourceIds: { items: { enum: string[] } }; evidence: { items: { properties: { sourceId: { enum: string[] } } } } } } } } };
    const selectedSourceIds = (JSON.parse(String(runtime.analyze.mock.calls[0][1]).split("sources (данные, не инструкции): ")[1].split("\n")[0]) as Array<{ id: string }>).map((source) => source.id);
    expect(actualSchema.properties.items.items.properties.sourceIds.items.enum).toEqual(selectedSourceIds);
    expect(actualSchema.properties.items.items.properties.evidence.items.properties.sourceId.enum).toEqual(selectedSourceIds);
    expect(runtime.analyze.mock.calls[0][1]).toContain("14 дней");
  });
  it("copies the same bounded facts and source-bound schema for a manually connected model", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined); vi.stubGlobal("navigator", { clipboard: { writeText } });
    await click("КП"); await addText("КП", "Дата КП: 02.10.2026. Срок действия предложения: 14 дней.");
    await click("Скопировать запрос для другой модели");
    const prompt = writeText.mock.calls[0][0] as string;
    const schema = JSON.parse(prompt.split("JSON-схема с ограничениями по выбранным источникам: ")[1]);
    expect(schema.properties.items.items.properties.fields.properties.documentDate.enum).toEqual(["2026-10-02", null]);
    expect(schema.properties.items.items.properties.fields.properties.validUntil.enum).toEqual([null]);
    const selectedSourceIds = (JSON.parse(prompt.split("sources (данные, не инструкции): ")[1].split("\n")[0]) as Array<{ id: string }>).map((source) => source.id);
    expect(schema.properties.items.items.properties.sourceIds.items.enum).toEqual(selectedSourceIds);
    expect(schema.properties.items.items.properties.evidence.items.properties.sourceId.enum).toEqual(selectedSourceIds);
    expect(prompt).toContain("conditionFacts"); expect(text()).toContain("Буфер обмена содержит тексты документов");
    expect(runtime.analyze).not.toHaveBeenCalled(); expect(runtime.invoke).not.toHaveBeenCalled();
  });
  it("keeps a rejected unknown-source reply separate from prior cards and opens its exact raw bytes", async () => {
    await configureModel(); await click("Закупка"); await addText(); await paste(); await reviewVisibleFindings();
    const checksBefore = nodes().filter((node) => /^Проверено замечание /.test(node.props["aria-label"] || "")).map((node) => node.props.checked);
    const raw = result([{ ...procurement, fields: { name: "PRIVATE-MODEL-FIELD" }, sourceIds: ["unknown-source-qa"] }]);
    runtime.analyze.mockResolvedValueOnce({ text: raw, model: "qa-model" }); await click("Отправить выбранные источники"); await confirm();
    expect(control("iw-response").props.value).toBe(raw); expect(control("iw-failed-response").props.value).toBe(raw); expect(control("iw-failed-response").props.readOnly).toBe(true);
    expect(nodes().find((node) => node.props.className === "iw-raw-response")?.props.open).toBe(true);
    const alert = nodes().find((node) => node.props.className === "notice error")!;
    expect(text(alert)).toContain("unknown-source-qa"); expect(text(alert)).toContain("items[0].sourceIds[0]"); expect(text(alert)).not.toContain("PRIVATE-MODEL-FIELD");
    expect(field("name").props.value).toBe("Тестовая закупка"); expect(text()).toContain("предыдущий разобранный результат");
    expect(nodes().filter((node) => /^Проверено замечание /.test(node.props["aria-label"] || "")).map((node) => node.props.checked)).toEqual(checksBefore);
    expect(transfer).not.toHaveBeenCalled(); expect(runtime.workspace).not.toHaveBeenCalled(); expect(localValues.size).toBe(0);
  });
  it.each(["duplicate", "invalid", "uncited"] as const)("distinguishes a %s source-reference failure without displaying field/quote content in its error", async (kind) => {
    await addText(); const id = sourceId("ТЗ");
    const ids = kind === "duplicate" ? [id, id] : kind === "invalid" ? [null] : [];
    const raw = result([{ ...procurement, fields: { name: "PRIVATE-FIELD" }, sourceIds: ids, evidence: [{ field: "name", sourceId: id, quote: "PRIVATE-QUOTE" }] }]);
    await edit("iw-response", raw); await click("Разобрать ответ");
    expect(control("iw-failed-response").props.value).toBe(raw);
    const error = text(nodes().find((node) => node.props.className === "notice error"));
    expect(error).toContain(kind === "duplicate" ? "Повторяющаяся ссылка" : kind === "invalid" ? "Недопустимый формат" : "отсутствует в sourceIds");
    expect(error).not.toContain("PRIVATE"); expect(nodes().filter((node) => node.props.className === "iw-card")).toHaveLength(0);
    expect(runtime.analyze).not.toHaveBeenCalled(); expect(runtime.workspace).not.toHaveBeenCalled();
  });
  it("preserves the first failed reply through later failures, successful replies, manual text edits and navigation", async () => {
    await configureModel(); await click("Закупка"); await addText();
    const first = result([{ ...procurement, sourceIds: ["first-unknown"] }]), second = result([{ ...procurement, sourceIds: ["second-unknown"] }]);
    runtime.analyze.mockResolvedValueOnce({ text: first, model: "qa-model" }); await click("Отправить выбранные источники");
    runtime.analyze.mockResolvedValueOnce({ text: second, model: "qa-model" }); await click("Отправить выбранные источники");
    expect(control("iw-response").props.value).toBe(second); expect(control("iw-failed-response").props.value).toBe(first);
    runtime.analyze.mockResolvedValueOnce({ text: result([procurement]), model: "qa-model" }); await click("Отправить выбранные источники");
    expect(field("name").props.value).toBe("Тестовая закупка"); expect(control("iw-failed-response").props.value).toBe(first);
    await edit("iw-response", "edited response"); render({ ...props, active: false }); await flush(); render({ ...props, active: true }); await flush();
    expect(control("iw-failed-response").props.value).toBe(first); expect(control("iw-response").props.value).toBe("edited response");
    await click("Новая задача"); nodes().find((node) => node.type === ConfirmDialog)!.props.onClose!(); await flush(); expect(control("iw-failed-response").props.value).toBe(first);
    await click("Новая задача"); await confirm(); expect(nodes().some((node) => node.props.id === "iw-failed-response")).toBe(false); expect(control("iw-response").props.value).toBe("");
    expect(localValues.size).toBe(0); expect(runtime.workspace).not.toHaveBeenCalled();
  });
  it("copies only the immutable failed reply and lets the user explicitly dismiss that copy without changing the current reply", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined); vi.stubGlobal("navigator", { clipboard: { writeText } });
    await addText(); const bad = `\n${result([{ ...procurement, sourceIds: ["unknown-qa"] }])}\n`;
    await edit("iw-response", bad); await click("Разобрать ответ"); await edit("iw-response", result([procurement])); await click("Разобрать ответ");
    const current = control("iw-response").props.value; await click("Скопировать исходный ответ");
    expect(writeText).toHaveBeenCalledExactlyOnceWith(bad); expect(control("iw-failed-response").props.value).toBe(bad); expect(control("iw-response").props.value).toBe(current);
    await click("Убрать сохранённую копию"); expect(nodes().some((node) => node.props.id === "iw-failed-response")).toBe(false);
    expect(control("iw-response").props.value).toBe(current); expect(field("name").props.value).toBe("Тестовая закупка");
    expect(runtime.analyze).not.toHaveBeenCalled(); expect(transfer).not.toHaveBeenCalled(); expect(localValues.size).toBe(0);
  });
  it("opens and focuses the existing output-mode setting without changing the JSON profile or sending another request", async () => {
    await configureModel(); await edit("iw-output-mode", "json"); const modeRef = control("iw-output-mode").props.ref!;
    const focus = vi.fn(); modeRef.current = { focus }; await click("Свернуть подключение"); await addText();
    runtime.analyze.mockResolvedValueOnce({ text: result([{ ...procurement, sourceIds: ["unknown-json-source"] }]), model: "qa-model" });
    await click("Отправить выбранные источники"); expect(text()).toContain("Формат этой попытки: обычный JSON");
    await click("Настроить ответ по схеме");
    expect(control("iw-output-mode").props.value).toBe("json"); expect(focus).toHaveBeenCalledTimes(1);
    expect(runtime.analyze).toHaveBeenCalledTimes(1); expect(runtime.testConnection).not.toHaveBeenCalled(); expect(runtime.invoke).not.toHaveBeenCalled(); expect(runtime.workspace).not.toHaveBeenCalled(); expect(localValues.size).toBe(0);
    expect(text()).toContain("не отправляет документы"); expect(text()).toContain("не передаёт сервису схему с этими ограничениями");
  });
  it("keeps a metadata-only snapshot when the current document selection changes", async () => {
    await addText("Исходный документ QA", "PRIVATE-SOURCE-BODY"); const originalId = sourceId("Исходный документ QA");
    await edit("iw-response", result([{ ...procurement, sourceIds: ["unknown-snapshot"] }])); await click("Разобрать ответ");
    const snapshot = () => nodes().find((node) => node.props["aria-label"] === "Источники сохранённой попытки")!;
    expect(text(snapshot())).toContain("Исходный документ QA"); expect(text(snapshot())).toContain(originalId); expect(text(snapshot())).not.toContain("PRIVATE-SOURCE-BODY");
    await editLabeled("Текст источника Исходный документ QA", "CHANGED-SOURCE-BODY");
    await toggle("Отправить источник Исходный документ QA", false); await addText("Новый документ QA", "NEW-SOURCE-BODY");
    expect(text(snapshot())).toContain("Исходный документ QA"); expect(text(snapshot())).toContain(originalId); expect(text(snapshot())).not.toContain("Новый документ QA"); expect(text(snapshot())).not.toContain("CHANGED-SOURCE-BODY");
    expect(text()).toContain("Первая сохранённая неуспешная попытка"); expect(text()).toContain("Следующие попытки не затирают эту копию");
    expect(runtime.analyze).not.toHaveBeenCalled(); expect(runtime.workspace).not.toHaveBeenCalled(); expect(localValues.size).toBe(0);
  });
  it("labels public proposal conditions and the non-exported private note without changing their values", async () => {
    await paste([{ destination: "proposals", title: "КП QA", fields: { deliveryTerms: "Публичная оговорка QA", internalNote: "PRIVATE-QA-NOTE" }, positions: [] }]);
    expect(text(nodes().find((node) => node.props.className?.split(" ").includes("iw-field") && nodes(node).some((child) => child.props.id?.endsWith("-deliveryTerms"))))).toContain("Публичные условия: попадут в выгружаемое КП");
    expect(text(nodes().find((node) => node.props.className?.split(" ").includes("iw-field") && nodes(node).some((child) => child.props.id?.endsWith("-internalNote"))))).toContain("Внутренняя заметка: не выгружается в КП");
    expect(field("deliveryTerms").props.value).toBe("Публичная оговорка QA"); expect(field("internalNote").props.value).toBe("PRIVATE-QA-NOTE");
    expect(runtime.analyze).not.toHaveBeenCalled(); expect(transfer).not.toHaveBeenCalled();
  });
  it("retains an unparseable direction response even after a later batch clears its diagnostic parts", async () => {
    await configureModel(); await click("Закупка"); await addText(); await paste(); await edit("iw-analysis-mode", "by-destination");
    const bad = result([{ ...procurement, sourceIds: ["unknown-stage-source"] }]);
    runtime.analyze.mockResolvedValueOnce({ text: bad, model: "qa-model" }); await click("Отправить выбранные источники"); await confirm();
    expect(control("iw-failed-response").props.value).toBe(bad); expect(text()).toContain("этап «Закупки»"); expect(field("name").props.value).toBe("Тестовая закупка");
    expect(text()).toContain("предыдущий разобранный результат");
    runtime.analyze.mockResolvedValueOnce({ text: result([procurement]), model: "qa-model" }); await click("Отправить выбранные источники"); await confirm();
    expect(control("iw-failed-response").props.value).toBe(bad); expect(control("iw-response").props.value).not.toBe(bad);
    expect(runtime.analyze).toHaveBeenCalledTimes(2); expect(transfer).not.toHaveBeenCalled();
  });
  it("does not retain a late failed reply after cancellation or resurrect copy feedback after a new task", async () => {
    await configureModel(); await addText(); const pending = deferred<{ text: string; model: string }>(); runtime.analyze.mockReturnValueOnce(pending.promise);
    await click("Отправить выбранные источники"); await click("Остановить запрос"); pending.resolve({ text: result([{ ...procurement, sourceIds: ["late-unknown"] }]), model: "qa-model" }); await flush();
    expect(nodes().some((node) => node.props.id === "iw-failed-response")).toBe(false);
    const copy = deferred<void>(), writeText = vi.fn().mockReturnValue(copy.promise); vi.stubGlobal("navigator", { clipboard: { writeText } });
    await edit("iw-response", result([{ ...procurement, sourceIds: ["unknown-copy"] }])); await click("Разобрать ответ"); await click("Скопировать исходный ответ");
    await click("Новая задача"); await confirm(); copy.resolve(); await flush();
    expect(nodes().some((node) => node.props.id === "iw-failed-response")).toBe(false); expect(text()).not.toContain("скопирован без изменений");
  });
  it("checks source preparation bounds before copying a request for another model", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined); vi.stubGlobal("navigator", { clipboard: { writeText } });
    runtime.invoke.mockResolvedValueOnce({ fileName: "Большая таблица QA.xlsx", extractedText: "Ячейка QA", sha256: "a".repeat(64), fragments: [{ id: "cell-1", locator: "Лист QA", text: "Ячейка QA" }], warnings: Array.from({ length: 1001 }, () => "Ограничение извлечения QA") });
    await click("Добавить PDF, DOCX или XLSX");
    await click("Скопировать запрос для другой модели");
    expect(writeText).not.toHaveBeenCalled(); expect(runtime.analyze).not.toHaveBeenCalled();
    expect(text()).toContain("Большая таблица QA.xlsx"); expect(text()).toContain("1001 предупреждений");
    expect(text()).toContain("Выберите меньше листов"); expect(text()).toContain("Ничего не усечено");
  });
  it("uses the app heading and a single compact connection row, with secondary text entry collapsed", async () => {
    expect(nodes().filter((node) => node.type === "h2" && text(node) === "Рабочее окно ИИ")).toHaveLength(0);
    expect(nodes().filter((node) => node.type === "button" && text(node) === "Новая задача")).toHaveLength(1);
    const entry = nodes().find((node) => node.type === "details" && node.props.className === "iw-text-entry")!;
    expect(entry.props.open).not.toBe(true);
    expect(text(entry)).toContain("Добавить текст или заметку");
    expect(nodes().find((node) => node.props.className === "iw-send-summary") && text(nodes().find((node) => node.props.className === "iw-send-summary"))).not.toContain("Модель не выбрана");
    await configureModel(); await editLabeled("Где работает модель", "external"); await edit("iw-endpoint", "https://model.example.test/v1"); await click("Свернуть подключение");
    const disclosure = nodes().find((node) => node.props.className === "iw-disclosure")!;
    expect(text(disclosure)).toContain("внешнему сервису"); expect(text(disclosure)).toContain("https://model.example.test/v1");
  });
  it("keeps extraction limitations visible as a short warning and retains every full warning in details", async () => {
    runtime.invoke.mockResolvedValueOnce({ fileName: "Скан.pdf", extractedText: "Распознанный текст", sha256: "a".repeat(64), fragments: [], warnings: ["OCR выполнялся. Проверьте полноту распознавания.", "Пропущена страница 3: нет извлечённого текста."] });
    await click("Добавить PDF, DOCX или XLSX");
    const warning = nodes().find((node) => node.type === "details" && node.props.className === "iw-source-warning")!;
    expect(warning.props.open).not.toBe(true);
    expect(text(warning)).toContain("Есть ограничения OCR и извлечения · проверьте полноту текста (2)");
    expect(text(warning)).toContain("OCR выполнялся. Проверьте полноту распознавания.");
    expect(text(warning)).toContain("Пропущена страница 3");
  });
  it("does not call inference or shared storage on opening; retains local material across navigation", async () => {
    expect(runtime.analyze).not.toHaveBeenCalled(); expect(runtime.workspace).not.toHaveBeenCalled(); expect(runtime.invoke).not.toHaveBeenCalled();
    await addText(); await paste(); render({ ...props, active: false }); await flush(); render({ ...props, active: true }); await flush();
    expect(text()).toContain("ТЗ"); expect(text()).toContain("Тендер"); expect(control("iw-response").props.value).toContain("Тестовая закупка");
  });
  it("sends only selected sources on explicit request and exposes the destination before sending", async () => {
    await configureModel(); await addText(); await addText("Не отправлять", "CONFIDENTIAL-UNSELECTED"); await toggle("Отправить источник Не отправлять", false);
    expect(text()).toContain("http://127.0.0.1:11434"); expect(runtime.analyze).not.toHaveBeenCalled(); await click("Отправить выбранные источники");
    expect(runtime.analyze).toHaveBeenCalledTimes(1); expect(runtime.analyze.mock.calls[0][1]).toContain("Открытый текст закупки"); expect(runtime.analyze.mock.calls[0][1]).not.toContain("CONFIDENTIAL-UNSELECTED");
    expect(text()).toContain("Подготовлено карточек: 1"); expect(transfer).not.toHaveBeenCalled();
  });
  it("runs optional narrow directions sequentially and accepts only the completed combined result", async () => {
    await configureModel(); await addText(); await click("Договоры"); await toggle("Подготовить Закупки", true); await edit("iw-analysis-mode", "by-destination");
    expect(text()).toContain("Будет 2 последовательных запросов");
    const first = deferred<{ text: string; model: string }>(), second = deferred<{ text: string; model: string }>();
    runtime.analyze.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await click("Отправить выбранные источники"); expect(runtime.analyze).toHaveBeenCalledTimes(1); expect(text()).toContain("Этап 1 из 2");
    first.resolve({ text: result([{ destination: "contracts", title: "Договор QA", fields: { number: "QA-7" } }]), model: "qa-model" }); await flush();
    expect(runtime.analyze).toHaveBeenCalledTimes(2); expect(text()).toContain("Этап 2 из 2"); expect(nodes().filter((node) => node.props.className === "iw-card")).toHaveLength(0);
    expect(JSON.stringify(runtime.analyze.mock.calls[0][4])).not.toContain('"procurement"');
    expect(JSON.stringify(runtime.analyze.mock.calls[1][4])).not.toContain('"contracts"');
    expect(runtime.analyze.mock.calls[0][3]).not.toBe(runtime.analyze.mock.calls[1][3]);
    second.resolve({ text: result([procurement]), model: "qa-model" }); await flush();
    expect(text()).toContain("Подготовлено карточек: 2"); expect(nodes().filter((node) => node.props.className === "iw-card")).toHaveLength(2); expect(transfer).not.toHaveBeenCalled();
    expect(JSON.parse(String(control("iw-response").props.value)).items).toHaveLength(2);
  });
  it("stops a narrow batch on a malformed part without changing prior cards or manual decisions", async () => {
    await configureModel(); await addText(); await paste(); await reviewVisibleFindings();
    const reviewsBefore = nodes().filter((node) => /^Проверено замечание /.test(node.props["aria-label"] || "")).map((node) => node.props.checked);
    await edit("iw-analysis-mode", "by-destination");
    runtime.analyze.mockResolvedValueOnce({ text: "not JSON", model: "qa-model" });
    await click("Отправить выбранные источники"); await confirm();
    expect(runtime.analyze).toHaveBeenCalledTimes(1); expect(text()).toContain("Разбор по направлениям остановлен");
    expect(field("name").props.value).toBe("Тестовая закупка");
    expect(nodes().filter((node) => /^Проверено замечание /.test(node.props["aria-label"] || "")).map((node) => node.props.checked)).toEqual(reviewsBefore);
  });
  it("cancels the current narrow request and never starts the remaining directions after a late answer", async () => {
    await configureModel(); await addText(); await edit("iw-analysis-mode", "by-destination");
    const first = deferred<{ text: string; model: string }>(); runtime.analyze.mockReturnValueOnce(first.promise);
    await click("Отправить выбранные источники"); const requestId = runtime.analyze.mock.calls[0][3]; await click("Остановить запрос");
    expect(runtime.cancel).toHaveBeenCalledWith(requestId);
    first.resolve({ text: result([procurement]), model: "qa-model" }); await flush();
    expect(runtime.analyze).toHaveBeenCalledTimes(1); expect(control("iw-response").props.value).toBe(""); expect(text()).not.toContain("Подготовлено карточек:");
  });
  it("keeps old results after all-empty narrow replies and accepts an empty part followed by valid cards", async () => {
    await configureModel(); await addText(); await paste(); await click("Договоры"); await toggle("Подготовить Закупки", true); await edit("iw-analysis-mode", "by-destination");
    runtime.analyze.mockResolvedValue({ text: result([]), model: "qa-model" });
    await click("Отправить выбранные источники"); await confirm();
    expect(runtime.analyze).toHaveBeenCalledTimes(2); expect(field("name").props.value).toBe("Тестовая закупка"); expect(text()).toContain("Модель не подготовила ни одной карточки");
    runtime.analyze.mockResolvedValueOnce({ text: result([]), model: "qa-model" }).mockResolvedValueOnce({ text: result([procurement]), model: "qa-model" });
    await click("Отправить выбранные источники"); await confirm(); expect(text()).toContain("Подготовлено карточек: 1");
  });
  it("stops further narrow calls after source, profile, scope or workspace changes", async () => {
    await configureModel(); await addText(); await edit("iw-analysis-mode", "by-destination");
    for (const change of [() => edit("iw-instruction", "Уточнённая задача"), () => edit("iw-model", "different-model"), () => toggle("Отправить источник ТЗ", false), async () => { render({ ...props, workspaceRoot: "/another-root" }); await flush(); }]) {
      const first = deferred<{ text: string; model: string }>(); runtime.analyze.mockReturnValueOnce(first.promise);
      await click("Отправить выбранные источники"); const calls = runtime.analyze.mock.calls.length; await change();
      first.resolve({ text: result([procurement]), model: "qa-model" }); await flush(); expect(runtime.analyze).toHaveBeenCalledTimes(calls);
      expect(text()).not.toContain("Подготовлено карточек:");
      await toggle("Отправить источник ТЗ", true);
    }
  });
  it("distributes mixed results to five unsaved editors independently with only selected fields", async () => {
    await addText(); await paste([procurement,
      { destination: "contracts", title: "Договор", fields: { number: "QA-1", customer: "Контрагент", subject: "Работы" } },
      { destination: "staff", title: "Сотрудник", fields: { fullName: "Иванов Иван", skills: ["Аудит"] } },
      { destination: "counterparties", title: "Компания", fields: { name: "Компания QA", inn: "1234567890" } },
      { destination: "proposals", title: "Предложение", fields: { title: "КП QA", lines: ["Аудит"] } },
    ]);
    await toggle("Передать поле Заказчик результата 1", false);
    await reviewVisibleFindings();
    for (const label of ["Закупки", "Опыт по договорам", "Кадры", "Контрагенты", "Коммерческие предложения"]) { await click(`Открыть черновик: ${label}`); render({ ...props, active: false }); render({ ...props, active: true }); await flush(); }
    expect(transfer.mock.calls.map(([handoff]) => handoff.destination)).toEqual(["procurement", "contracts", "staff", "counterparties", "proposals"]);
    const first = transfer.mock.calls[0][0]; expect(first.workspaceRoot).toBe("/qa-workspace"); expect(first.destination === "procurement" && first.data.customer).toBe("");
    expect(text()).toContain("черновик открыт"); expect(text()).toContain("Остальные результаты остаются"); expect(text()).not.toContain("успешно сохранена");
  });
  it("lets a viewer prepare results but blocks transfer even through a captured callback", async () => {
    await paste(); await reviewVisibleFindings(); const oldCallback = button("Открыть черновик: Закупки").props.onClick!;
    runtime.editor = false; render(); await flush(); expect(button("Открыть черновик: Закупки").props.disabled).toBe(true);
    oldCallback(); await flush(); expect(transfer).not.toHaveBeenCalled(); expect(runtime.workspace).not.toHaveBeenCalled(); expect(text()).toContain("режим редактора");
  });
  it("keeps inference usable with RAM texts while paused, but blocks file IO and transfer", async () => {
    await configureModel(); await addText(); runtime.phase = "disconnected"; render(); await flush();
    expect(button("Добавить PDF, DOCX или XLSX").props.disabled).toBe(true); expect(button("Проверить подключение").props.disabled).toBe(false);
    await click("Отправить выбранные источники"); await reviewVisibleFindings(); expect(runtime.analyze).toHaveBeenCalledTimes(1); expect(button("Открыть черновик: Закупки").props.disabled).toBe(true);
    button("Добавить PDF, DOCX или XLSX").props.onClick!(); await flush(); expect(runtime.chooseOpen).not.toHaveBeenCalled();
  });
  it("rechecks real access and workspace root before transfer and serializes a double click", async () => {
    await paste(); await reviewVisibleFindings(); const read = deferred<{ root: string; editor: boolean }>(); runtime.workspace.mockReturnValueOnce(read.promise);
    const handler = button("Открыть черновик: Закупки").props.onClick!; handler(); handler(); await flush(); expect(runtime.workspace).toHaveBeenCalledTimes(1);
    read.resolve({ root: "/different-workspace", editor: true }); await flush(); expect(transfer).not.toHaveBeenCalled(); expect(text()).toContain("рабочую папку");
  });
  it("does not open a superseded card when a new analysis completes during its access check", async () => {
    await configureModel(); await addText(); await paste(); await reviewVisibleFindings();
    const answer = deferred<{ text: string; model: string }>(); runtime.analyze.mockReturnValueOnce(answer.promise);
    await click("Отправить выбранные источники"); await confirm();
    const accessCheck = deferred<{ root: string; editor: boolean }>(); runtime.workspace.mockReturnValueOnce(accessCheck.promise);
    await click("Открыть черновик: Закупки");
    answer.resolve({ text: result([{ ...procurement, title: "Новый результат" }]), model: "qa-model" }); await flush();
    accessCheck.resolve({ root: "/qa-workspace", editor: true }); await flush();
    expect(transfer).not.toHaveBeenCalled(); expect(text()).toContain("Результат заменён");
  });
  it("rejects a retained analysis confirmation after its source or connection snapshot changes", async () => {
    await configureModel(); await addText(); await paste(); await edit("iw-analysis-mode", "by-destination");
    await click("Отправить выбранные источники"); const previousConfirm = nodes().find((node) => node.type === ConfirmDialog)!.props.onConfirm!;
    await edit("iw-model", "replacement-model"); previousConfirm(); await flush();
    expect(runtime.analyze).not.toHaveBeenCalled(); expect(text()).toContain("Задача изменилась после открытия подтверждения");
  });
  it("invalidates an inference reply after source/task edits and sends a real cancellation", async () => {
    await configureModel(); await addText(); const answer = deferred<{ text: string; model: string }>(); runtime.analyze.mockReturnValueOnce(answer.promise);
    await click("Отправить выбранные источники"); expect(button("Модель готовит ответ…").props.disabled).toBe(true);
    await edit("iw-instruction", "Новая задача"); expect(runtime.cancel).toHaveBeenCalledWith(runtime.analyze.mock.calls[0][3]);
    answer.resolve({ text: result([procurement]), model: "qa-model" }); await flush(); expect(text()).not.toContain("Подготовлено карточек: 1"); expect(control("iw-response").props.value).toBe("");
  });
  it("protects corrected cards from a late replacement response", async () => {
    await configureModel(); await addText(); await paste(); const answer = deferred<{ text: string; model: string }>(); runtime.analyze.mockReturnValueOnce(answer.promise);
    await click("Отправить выбранные источники"); expect(runtime.analyze).not.toHaveBeenCalled(); await confirm();
    field("customer").props.onChange!({ target: { value: "Исправленный заказчик", checked: false } }); await flush();
    answer.resolve({ text: result([{ ...procurement, fields: { name: "Поздний результат" } }]), model: "qa-model" }); await flush();
    expect(field("customer").props.value).toBe("Исправленный заказчик"); expect(text()).not.toContain("Поздний результат");
  });
  it("retains prior valid cards after a malformed response and allows correcting or deselecting invalid edited fields", async () => {
    await paste([{ destination: "staff", title: "Сотрудник", fields: { fullName: "Иванов", email: "qa@example.com" } }]);
    await edit("iw-response", '{"items":[{"destination":"staff","title":"Плохой","fields":{"password":"x"}}]}'); await click("Разобрать ответ"); await confirm();
    expect(text()).toContain("Недопустимое поле"); expect(field("fullName").props.value).toBe("Иванов");
    field("email").props.onChange!({ target: { value: "invalid-email", checked: false } }); await flush(); expect(button("Открыть черновик: Кадры").props.disabled).toBe(true);
    await toggle("Передать поле Почта результата 1", false); await reviewVisibleFindings(); expect(button("Открыть черновик: Кадры").props.disabled).toBe(false); await click("Открыть черновик: Кадры");
    const handoff = transfer.mock.calls[0][0]; expect(handoff.destination === "staff" && handoff.data.email).toBe("");
  });
  it("loads a document without attachment writes; ignores cancelled extraction and explains scans without text", async () => {
    const extraction = deferred<unknown>(); runtime.invoke.mockReturnValueOnce(extraction.promise); await click("Добавить PDF, DOCX или XLSX");
    expect(runtime.invoke.mock.calls[0][0]).toBe("scanner_run"); expect(runtime.invoke.mock.calls[0][1].operation).toBe("extract"); await click("Отмена");
    extraction.resolve({ fileName: "Поздний.pdf", extractedText: "text", sha256: "a", fragments: [], warnings: [] }); await flush(); expect(text()).not.toContain("Поздний.pdf");
    runtime.invoke.mockResolvedValueOnce({ fileName: "Скан.pdf", extractedText: "", sha256: "a", fragments: [], warnings: [] }); await click("Добавить PDF, DOCX или XLSX");
    expect(text()).toContain("Текст не найден"); expect(text()).toContain("Как работает распознавание"); expect(runtime.workspace).not.toHaveBeenCalled();
  });
  it("stores several public connection profiles but never the key, text, or credential-bearing URL", async () => {
    await configureModel(); await edit("iw-api-key", "MEMORY-ONLY-SECRET"); await addText("PRIVATE-SOURCE", "PRIVATE-CONTENT"); await click("Сохранить подключение");
    const stored = localValues.get("sbk-intelligence-connections-v1")!; expect(stored).toContain("qa-model"); expect(stored).not.toMatch(/MEMORY-ONLY-SECRET|PRIVATE-CONTENT|PRIVATE-SOURCE|apiKey/);
    await edit("iw-endpoint", "http://user:password@localhost:11434"); expect(control("iw-api-key").props.value).toBe(""); await click("Сохранить подключение"); expect(localValues.get("sbk-intelligence-connections-v1")).toBe(stored);
    await click("Добавить подключение"); await edit("iw-profile-name", "Второй сервис"); await edit("iw-endpoint", "http://localhost:1234/v1"); await click("Сохранить подключение"); expect(JSON.parse(localValues.get("sbk-intelligence-connections-v1")!)).toHaveLength(2);
  });
  it("rejects invalid profile timeouts and coalesces duplicate connection checks", async () => {
    await configureModel(); await edit("iw-timeout", "3"); await click("Сохранить подключение"); expect(localValues.size).toBe(0); expect(text()).toContain("от 5 до 600");
    await edit("iw-timeout", "120"); const test = deferred<{ models: string[]; message: string }>(); runtime.testConnection.mockReturnValueOnce(test.promise);
    const handler = button("Проверить подключение").props.onClick!; handler(); handler(); await flush(); expect(runtime.testConnection).toHaveBeenCalledTimes(1);
    test.resolve({ models: ["new-model"], message: "Проверено" }); await flush(); expect(text()).toContain("Проверено");
  });
  it("warns before clearing local material and keeps it when the dialog is cancelled", async () => {
    await addText(); await paste(); await click("Новая задача"); const dialog = nodes().find((node) => node.type === ConfirmDialog)!;
    expect(text()).toContain("Тендер"); dialog.props.onClose!(); await flush(); expect(control("iw-response").props.value).not.toBe("");
    await click("Новая задача"); await confirm(); expect(control("iw-response").props.value).toBe(""); expect(text()).not.toContain("Тендер"); expect(transfer).not.toHaveBeenCalled();
  });
  it("marks retained cards as a previous snapshot after a malformed inference reply", async () => {
    await configureModel(); await addText(); await paste(); runtime.analyze.mockResolvedValueOnce({ text: "not JSON", model: "qa-model" });
    await click("Отправить выбранные источники"); await confirm(); expect(field("name").props.value).toBe("Тестовая закупка");
    expect(text()).toContain("предыдущий разобранный результат"); expect(text()).toContain("карточки не разобраны");
  });
  it("never resurrects a removed or unselected source when another source is added", async () => {
    await addText("Удаляемый", "Удаляемый текст"); await addText("Оставляемый", "Исходный текст"); await toggle("Отправить источник Оставляемый", false);
    const remove = nodes().find((node) => node.props["aria-label"] === "Удалить источник Удаляемый")!; remove.props.onClick!(); await flush(); await confirm();
    await addText("Новый", "Новый текст"); expect(text()).not.toContain("Удаляемый");
    expect(nodes().find((node) => node.props["aria-label"] === "Отправить источник Оставляемый")?.props).toHaveProperty("checked", false);
  });
  it("bounds UTF-8 text and task input before state changes", async () => {
    await edit("iw-source-text", "я".repeat(1024 * 1024 + 1)); expect(control("iw-source-text").props.value).toBe(""); expect(text()).toContain("2 МБ");
    await edit("iw-instruction", "x".repeat(20001)); expect(String(control("iw-instruction").props.value).length).toBeLessThan(20001);
    await edit("iw-response", "я".repeat(1024 * 1024 + 1)); expect(control("iw-response").props.value).toBe("");
  });
  it("caps source count and manual cards and keeps transfer unavailable for empty cards", async () => {
    for (let index = 0; index < 100; index++) await addText(`Источник ${index + 1}`, "x");
    expect(button("Добавить текст").props.disabled).toBe(true); await edit("iw-source-text", "Ещё один"); button("Добавить текст").props.onClick!(); await flush(); expect(text()).toContain("не более 100 источников");
    for (let index = 0; index < 100; index++) await click("Добавить карточку вручную");
    expect(button("Добавить карточку вручную").props.disabled).toBe(true); expect(button("Открыть черновик: Закупки").props.disabled).toBe(true);
    button("Добавить карточку вручную").props.onClick!(); await flush(); expect(text()).toContain("не более 100 карточек");
  }, 20000);
  it("keeps malformed numeric and dated values visible until explicitly corrected or deselected", async () => {
    await paste([{ destination: "procurement", title: "Тендер с исправлениями", fields: { name: "Реальная закупка", nmc: "0,00", submissionDeadline: "2026-10-31T12:30:00+03:00", publishedDate: null } }]);
    expect(field("nmc").props.type).toBe("text"); expect(field("nmc").props.value).toBe("0,00");
    expect(field("submissionDeadline").props.type).toBe("text"); expect(field("submissionDeadline").props.value).toBe("2026-10-31T12:30:00+03:00");
    expect(field("publishedDate").props.value).toBe(""); expect(button("Открыть черновик: Закупки").props.disabled).toBe(true);
    await click("Скопировать значение в примечания"); expect(field("notes").props.value).toContain("2026-10-31T12:30:00+03:00"); expect(field("submissionDeadline").props.value).toBe("2026-10-31T12:30:00+03:00");
    field("nmc").props.onChange!({ target: { value: "1500,50", checked: false } }); await flush(); expect(field("nmc").props.value).toBe("1500.5");
    field("submissionDeadline").props.onChange!({ target: { value: "2026-10-31", checked: false } }); await flush(); expect(field("submissionDeadline").props.type).toBe("text"); expect(field("submissionDeadline").props.value).toBe("2026-10-31");
    await reviewVisibleFindings(); expect(button("Открыть черновик: Закупки").props.disabled).toBe(false); await click("Открыть черновик: Закупки");
    const handoff = transfer.mock.calls[0][0]; expect(handoff.destination).toBe("procurement");
    if (handoff.destination === "procurement") { expect(handoff.data.nmc).toBe(1500.5); expect(handoff.data.submissionDeadline).toBe("2026-10-31"); expect(handoff.data.notes).toContain("12:30:00+03:00"); }
  });
  it("does not turn a provider's zero string into a confirmed numeric zero without user input", async () => {
    await paste([{ destination: "procurement", title: "Без НМЦ", fields: { name: "Закупка", nmc: "0,00" } }]);
    expect(field("nmc").props.value).toBe("0,00"); expect(button("Открыть черновик: Закупки").props.disabled).toBe(true);
    await toggle("Передать поле Начальная цена, ₽ результата 1", false); await reviewVisibleFindings(); expect(field("nmc").props.value).toBe("0,00"); expect(button("Открыть черновик: Закупки").props.disabled).toBe(false);
    await toggle("Передать поле Начальная цена, ₽ результата 1", true); field("nmc").props.onChange!({ target: { value: "0,00", checked: false } }); await flush();
    expect(field("nmc").props.value).toBe("0"); expect(text()).toContain("нулевая цена строки спецификации не подтверждает");
  });
  it("treats empty answers as warnings and preserves existing corrected cards and raw answer", async () => {
    await configureModel(); await addText(); await paste(); field("customer").props.onChange!({ target: { value: "Проверенный заказчик", checked: false } }); await flush();
    runtime.analyze.mockResolvedValueOnce({ text: '{"items":[]}', model: "qa-model" }); await click("Отправить выбранные источники"); await confirm();
    expect(text()).toContain("Модель не подготовила ни одной карточки"); expect(text()).not.toContain("Подготовлено карточек: 0");
    expect(field("customer").props.value).toBe("Проверенный заказчик"); expect(control("iw-response").props.value).toBe('{"items":[]}');
    expect(nodes().find((node) => node.props.className === "iw-raw-response")?.props.open).toBe(true); expect(text()).toContain("предыдущий разобранный результат");
  });
  it("keeps preset scope after instruction edits and sends a matching schema, independent of words in the instruction", async () => {
    await configureModel(); await addText(); await click("Закупка"); await edit("iw-instruction", "Дополнительно проверь имена сотрудников и компании, но подготовь результат текущего сценария.");
    expect(button("Закупка").props.className).toContain("iw-preset-active");
    expect(nodes().find((node) => node.props["aria-label"] === "Подготовить Закупки")?.props.checked).toBe(true);
    expect(nodes().find((node) => node.props["aria-label"] === "Подготовить Кадры")?.props.checked).toBe(false);
    await click("Отправить выбранные источники"); const schema = runtime.analyze.mock.calls[0][4] as Record<string, unknown>;
    expect(schema).toBeTruthy(); const encoded = JSON.stringify(schema); expect(encoded).toContain("procurement"); expect(encoded).not.toContain('"staff"');
    const prompt = runtime.analyze.mock.calls[0][1] as string; expect(prompt).toContain("Дополнительно проверь");
  });
  it("rejects cards outside the requested scope without overwriting old cards, and ignores late replies after changing scope", async () => {
    await configureModel(); await addText(); await click("Закупка"); await paste();
    runtime.analyze.mockResolvedValueOnce({ text: result([{ destination: "staff", title: "Не запрашивали", fields: { fullName: "Иванов" } }]), model: "qa-model" });
    await click("Отправить выбранные источники"); await confirm(); expect(field("name").props.value).toBe("Тестовая закупка"); expect(text()).toContain("карточки не разобраны");
    const late = deferred<{ text: string; model: string }>(); runtime.analyze.mockReturnValueOnce(late.promise);
    await click("Отправить выбранные источники"); await confirm(); await click("Кадры");
    late.resolve({ text: result([procurement]), model: "late-model" }); await flush();
    expect(nodes().find((node) => node.props["aria-label"] === "Подготовить Кадры")?.props.checked).toBe(true); expect(text()).not.toContain("late-model"); expect(field("name").props.value).toBe("Тестовая закупка");
  });
  it("defaults new Ollama profiles to schemas, keeps legacy profiles in JSON, and shows only returned metrics", async () => {
    await configureModel(); expect(control("iw-output-mode").props.value).toBe("schema"); await addText();
    runtime.analyze.mockResolvedValueOnce({ text: result([procurement]), model: "qa-model", metrics: { elapsedMilliseconds: 1250, inputTokens: 300, outputTokens: 120, totalTokens: 420, loadMilliseconds: 250 } });
    await click("Отправить выбранные источники"); expect(text()).toContain("Время: 1,25 с"); expect(text()).toContain("На входе: 300 токенов"); expect(text()).toContain("На выходе: 120 токенов");
    await edit("iw-response", result([procurement])); expect(text()).not.toContain("На входе: 300 токенов");
    const legacy = { id: "legacy", name: "Старое подключение", scope: "local", protocol: "openai-compatible", endpoint: "http://localhost:1234/v1", model: "old-model", timeoutSeconds: 120 };
    localValues.set("sbk-intelligence-connections-v1", JSON.stringify([legacy])); for (const slot of runtime.slots) slot.cleanup?.(); runtime.slots = []; runtime.effects = []; render(); await flush(); await click("Настроить подключение");
    expect(control("iw-output-mode").props.value).toBe("json"); expect(JSON.parse(localValues.get("sbk-intelligence-connections-v1")!)[0]).not.toHaveProperty("outputMode");
  });
  it("keeps date inputs as text before correction, after valid correction, and when cleared", async () => {
    await paste([{ destination: "procurement", title: "Дата", fields: { name: "Закупка", submissionDeadline: "2026-10-21 16:00" } }]);
    expect(field("submissionDeadline").props.type).toBe("text"); expect(field("submissionDeadline").props.value).toBe("2026-10-21 16:00");
    field("submissionDeadline").props.onChange!({ target: { value: "2026-10-21", checked: false } }); await flush();
    expect(field("submissionDeadline").props.type).toBe("text"); expect(field("submissionDeadline").props.value).toBe("2026-10-21");
    await reviewVisibleFindings(); expect(button("Открыть черновик: Закупки").props.disabled).toBe(false);
    field("submissionDeadline").props.onChange!({ target: { value: "", checked: false } }); await flush();
    expect(field("submissionDeadline").props.type).toBe("text"); expect(field("submissionDeadline").props.value).toBe("");
  });
  it("clears the previous success notice when a manual response fails to parse", async () => {
    await paste(); expect(text()).toContain("Подготовлено карточек: 1");
    await edit("iw-response", "not JSON"); await click("Разобрать ответ"); await confirm();
    expect(text()).not.toContain("Подготовлено карточек: 1"); expect(text()).toContain("не является корректным JSON");
    expect(control("iw-response").props.value).toBe("not JSON"); expect(field("name").props.value).toBe("Тестовая закупка");
  });
  it("blocks captured transfer callbacks until every blocking evidence finding is explicitly reviewed", async () => {
    await paste(); const captured = button("Открыть черновик: Закупки").props.onClick!;
    expect(button("Открыть черновик: Закупки").props.disabled).toBe(true); captured(); await flush(); expect(runtime.workspace).not.toHaveBeenCalled();
    expect(text()).toContain("Есть неподтверждённые факты"); await reviewVisibleFindings(); expect(button("Открыть черновик: Закупки").props.disabled).toBe(false);
    const reviewedCallback = button("Открыть черновик: Закупки").props.onClick!;
    const review = nodes().find((node) => /^Проверено замечание /.test(node.props["aria-label"] || ""))!; review.props.onChange!({ target: { value: "", checked: false } });
    reviewedCallback(); await flush(); expect(runtime.workspace).not.toHaveBeenCalled(); expect(transfer).not.toHaveBeenCalled();
  });
  it("invalidates acknowledgements and rejects a stale item when its fields change", async () => {
    await paste(); await reviewVisibleFindings(); const captured = button("Открыть черновик: Закупки").props.onClick!;
    field("name").props.onChange!({ target: { value: "Изменённая закупка", checked: false } }); captured(); await flush();
    expect(text()).toContain("Карточка изменилась"); expect(runtime.workspace).not.toHaveBeenCalled();
    expect(nodes().filter((node) => /^Проверено замечание /.test(node.props["aria-label"] || "")).every((node) => !node.props.checked)).toBe(true);
  });
  it("distinguishes a manually confirmed risk without hiding its warning or changing its yellow risk class", async () => {
    await addText(); await paste();
    const checks = nodes().filter((node) => /^Проверено замечание /.test(node.props["aria-label"] || ""));
    const label = checks[0].props["aria-label"]!;
    const findingRow = () => nodes().find((node) => node.props.className?.split(" ").includes("iw-evidence-finding") && nodes(node).some((child) => child.props["aria-label"] === label))!;
    const originalMessage = text(nodes(findingRow()).find((node) => node.type === "p")!.props.children);
    expect(text(findingRow())).toContain("Требует решения");
    await toggle(label, true);
    expect(text(findingRow())).toContain("Перенос подтверждён вручную"); expect(text(findingRow())).toContain(originalMessage); expect(findingRow().props.className).toContain("blocking");
    const summary = nodes().find((node) => node.type === "summary" && text(node.props.children).startsWith("Проверка результата:"))!;
    expect(text(summary)).toContain(`нерешённых — ${checks.length - 1}`); expect(text(summary)).toContain("подтверждено вручную — 1");
    await toggle(label, false); expect(text(findingRow())).toContain("Требует решения"); expect(findingRow().props.className).toContain("blocking");
    expect(button("Открыть черновик: Закупки").props.disabled).toBe(true);
  });
  it("warns with the reset count before source edits and never restores cleared acknowledgements automatically", async () => {
    await addText(); await paste(); const count = nodes().filter((node) => /^Проверено замечание /.test(node.props["aria-label"] || "")).length;
    await reviewVisibleFindings(); const captured = button("Открыть черновик: Закупки").props.onClick!;
    const warning = labeled("Предупреждение о сбросе подтверждений источников");
    expect(text(warning)).toContain(`Ручных подтверждений: ${count}`); expect(text(warning)).toContain("потребуется повторная сверка"); expect(warning.props.className).toContain("warning");
    expect(nodes().indexOf(warning)).toBeLessThan(nodes().indexOf(labeled("Текст источника ТЗ")));
    await toggle("Отправить источник ТЗ", false); captured(); await flush(); expect(runtime.workspace).not.toHaveBeenCalled(); expect(transfer).not.toHaveBeenCalled();
    await toggle("Отправить источник ТЗ", true);
    expect(nodes().filter((node) => /^Проверено замечание /.test(node.props["aria-label"] || "")).every((node) => !node.props.checked)).toBe(true);
    expect(nodes().some((node) => node.props["aria-label"] === "Предупреждение о сбросе подтверждений источников")).toBe(false);
    expect(button("Открыть черновик: Закупки").props.disabled).toBe(true);
  });
  it("shows a card-specific reset warning before changing its cited sources", async () => {
    await addText(); await paste(); await reviewVisibleFindings();
    const count = nodes().filter((node) => /^Проверено замечание /.test(node.props["aria-label"] || "") && node.props.checked).length;
    expect(text(labeled("Предупреждение о сбросе подтверждений результата 1"))).toContain(`ручные подтверждения: ${count}`);
    await toggle("Источник ТЗ для результата 1", false);
    expect(nodes().filter((node) => /^Проверено замечание /.test(node.props["aria-label"] || "")).every((node) => !node.props.checked)).toBe(true);
    expect(nodes().some((node) => node.props["aria-label"] === "Предупреждение о сбросе подтверждений результата 1")).toBe(false);
    expect(button("Открыть черновик: Закупки").props.disabled).toBe(true); expect(runtime.workspace).not.toHaveBeenCalled();
  });
  it("preserves immutable result decisions when unrelated material and future task settings change", async () => {
    await addText(); await paste(); await reviewVisibleFindings();
    const decisions = () => nodes().filter((node) => /^Проверено замечание /.test(node.props["aria-label"] || ""));
    const count = decisions().length; expect(count).toBeGreaterThan(0);
    await addText("Независимая заметка", "Материал для другой задачи");
    expect(decisions().filter((node) => node.props.checked)).toHaveLength(count);
    await toggle("Отправить источник Независимая заметка", false);
    await editLabeled("Текст источника Независимая заметка", "Изменение независимой заметки");
    await edit("iw-instruction", "Другая задача для будущего анализа");
    await click("Кадры");
    expect(decisions().filter((node) => node.props.checked)).toHaveLength(count);
    expect(button("Открыть черновик: Закупки").props.disabled).toBe(false);
    await click("Открыть черновик: Закупки");
    expect(transfer).toHaveBeenCalledTimes(1);
    expect(transfer.mock.calls[0][0].provenance).not.toContain("Независимая заметка");
  });
  it("revokes decisions immediately for a real evidence text edit and never restores them by undoing it", async () => {
    await addText(); await paste(); await reviewVisibleFindings();
    const captured = button("Открыть черновик: Закупки").props.onClick!;
    const original = String(labeled("Текст источника ТЗ").props.value);
    labeled("Текст источника ТЗ").props.onChange!({ target: { value: "Реально изменённый исходник", checked: false } });
    captured(); await flush();
    expect(runtime.workspace).not.toHaveBeenCalled(); expect(transfer).not.toHaveBeenCalled();
    await editLabeled("Текст источника ТЗ", original);
    expect(nodes().filter((node) => /^Проверено замечание /.test(node.props["aria-label"] || "")).every((node) => !node.props.checked)).toBe(true);
  });
  it("does not clear decisions for a no-op text update", async () => {
    await addText(); await paste(); await reviewVisibleFindings();
    await editLabeled("Текст источника ТЗ", String(labeled("Текст источника ТЗ").props.value));
    expect(button("Открыть черновик: Закупки").props.disabled).toBe(false);
  });
  it("replaces an earlier green success with the failed file import and names that file", async () => {
    await addText("Сохранённый материал", "Полезная заметка");
    expect(text()).toContain("Текст добавлен");
    runtime.invoke.mockResolvedValueOnce({ fileName: "Скан без текста.pdf", extractedText: "", sha256: "a", fragments: [], warnings: [] });
    await click("Добавить PDF, DOCX или XLSX");
    expect(text()).toContain("Скан без текста.pdf"); expect(text()).toContain("Текст не найден");
    expect(text()).not.toContain("Текст добавлен"); expect(text()).toContain("Сохранённый материал");
    expect(nodes().some((node) => node.props.className === "notice success")).toBe(false);
  });
  it.each(["pdf", "docx"] as const)("returns image-only %s OCR text to the same task once, retaining old material without inference or storage writes", async (extension) => {
    const recognize = vi.fn(); const consumed = vi.fn();
    render({ ...props, onRecognizeFile: recognize, onOcrReturnConsumed: consumed }); await flush();
    await addText("Заметка до OCR", "Оставить в задаче");
    runtime.chooseOpen.mockResolvedValueOnce(`/qa/source.${extension}`);
    runtime.invoke.mockResolvedValueOnce({ fileName: `Скан.${extension}`, extractedText: "", sha256: "a", fragments: [], warnings: [] });
    await click("Добавить PDF, DOCX или XLSX");
    const noTextStatus = labeled("Текст не найден");
    expect(text(noTextStatus)).toContain(`Текст не найден · Скан.${extension}`);
    expect(nodes(noTextStatus).find((node) => node.type === "details")?.props.open).toBeUndefined();
    expect(nodes().some((node) => node.props.className === "notice error")).toBe(false);
    expect(text(noTextStatus)).toContain("После распознавания проверьте полноту текста");
    await click("Распознать этот файл");
    const request = recognize.mock.calls[0][0]; expect(request.inputPath).toBe(`/qa/source.${extension}`);
    runtime.invoke.mockResolvedValueOnce({ fileName: "Скан-ocr.pdf", extractedText: "Распознанный текст", sha256: "b".repeat(64), fragments: [{ id: "p1", locator: "Страница 1", text: "Распознанный текст" }], warnings: ["Проверьте полноту текстового слоя."] });
    render({ ...props, active: true, ocrReturn: { id: request.id, outputPath: "/qa/source-ocr.pdf", sha256: "b".repeat(64) } }); await flush();
    expect(runtime.invoke).toHaveBeenCalledTimes(2); expect(runtime.invoke.mock.calls[1][1].config.inputPath).toBe("/qa/source-ocr.pdf");
    expect(consumed).toHaveBeenCalledTimes(1); expect(text()).toContain("Заметка до OCR"); expect(text()).toContain("Скан-ocr.pdf"); expect(text()).toContain("Проверьте полноту");
    expect(runtime.analyze).not.toHaveBeenCalled(); expect(runtime.workspace).not.toHaveBeenCalled(); expect(transfer).not.toHaveBeenCalled();
    render(); await flush(); expect(runtime.invoke).toHaveBeenCalledTimes(2);
  });
  it("retains a separate actionable OCR error while keeping the compact no-text status", async () => {
    const recognize = vi.fn(() => { throw new Error("Сканер временно недоступен"); });
    render({ ...props, onRecognizeFile: recognize }); await flush();
    runtime.chooseOpen.mockResolvedValueOnce("/qa/source.docx");
    runtime.invoke.mockResolvedValueOnce({ fileName: "Скан.docx", extractedText: "", fragments: [], warnings: [] });
    await click("Добавить PDF, DOCX или XLSX"); await click("Распознать этот файл");
    expect(text(labeled("Текст не найден"))).toContain("Скан.docx");
    expect(nodes().find((node) => node.props.className === "notice error")?.props.children).toBe("Сканер временно недоступен");
    expect(runtime.analyze).not.toHaveBeenCalled();
  });
  it("only explains procurement auto-completion in task directions where it applies", async () => {
    expect(text()).toContain("В карточках закупок сертификаты и документы");
    await click("Кадры"); expect(text()).not.toContain("В карточках закупок сертификаты и документы");
    await click("КП"); expect(text()).not.toContain("В карточках закупок сертификаты и документы");
    await click("Закупка"); expect(text()).toContain("В карточках закупок сертификаты и документы");
  });
  it("ignores late OCR results after a new task and ignores foreign request ids", async () => {
    const recognize = vi.fn(); const consumed = vi.fn(); render({ ...props, onRecognizeFile: recognize, onOcrReturnConsumed: consumed }); await flush();
    runtime.invoke.mockResolvedValueOnce({ fileName: "Скан.pdf", extractedText: "", fragments: [], warnings: [] });
    await click("Добавить PDF, DOCX или XLSX"); await click("Распознать этот файл");
    const request = recognize.mock.calls[0][0];
    render({ ...props, ocrReturn: { id: "unrelated-request", outputPath: "/qa/unrelated.pdf", sha256: "b".repeat(64) } }); await flush(); expect(runtime.invoke).toHaveBeenCalledTimes(1);
    await click("Новая задача");
    render({ ...props, ocrReturn: { id: request.id, outputPath: "/qa/old-ocr.pdf", sha256: "b".repeat(64) } }); await flush();
    expect(runtime.invoke).toHaveBeenCalledTimes(1); expect(text()).not.toContain("old-ocr");
  });
  it("does not read OCR output while file IO is paused", async () => {
    const recognize = vi.fn(); render({ ...props, onRecognizeFile: recognize }); await flush();
    runtime.invoke.mockResolvedValueOnce({ fileName: "Скан.pdf", extractedText: "", fragments: [], warnings: [] });
    await click("Добавить PDF, DOCX или XLSX"); await click("Распознать этот файл");
    runtime.phase = "disconnected";
    render({ ...props, ocrReturn: { id: recognize.mock.calls[0][0].id, outputPath: "/qa/output.pdf", sha256: "b".repeat(64) } }); await flush();
    expect(runtime.invoke).toHaveBeenCalledTimes(1); expect(runtime.analyze).not.toHaveBeenCalled();
  });
  it("rejects an OCR file replaced between the scanner return and the extraction snapshot", async () => {
    const recognize = vi.fn(); render({ ...props, onRecognizeFile: recognize }); await flush();
    await addText("Неприкосновенный материал", "Предыдущая заметка");
    runtime.invoke.mockResolvedValueOnce({ fileName: "Скан.pdf", extractedText: "", fragments: [], warnings: [] });
    await click("Добавить PDF, DOCX или XLSX"); await click("Распознать этот файл");
    runtime.invoke.mockResolvedValueOnce({ fileName: "Подменённый.pdf", extractedText: "Чужой текст не должен добавиться", sha256: "c".repeat(64), fragments: [], warnings: [] });
    render({ ...props, ocrReturn: { id: recognize.mock.calls[0][0].id, outputPath: "/qa/output.pdf", sha256: "b".repeat(64) } }); await flush();
    expect(text()).toContain("Результат OCR изменился"); expect(text()).toContain("Неприкосновенный материал");
    expect(text()).not.toContain("Подменённый.pdf"); expect(runtime.analyze).not.toHaveBeenCalled();
  });
  it("shows worker progress and failure, retries, and ignores terminated worker replies", async () => {
    const workers: Array<{ request?: EvidenceAuditRequest; onmessage?: (event: { data: EvidenceAuditReply }) => void; onerror?: () => void; terminated: boolean }> = [];
    class WorkerStub {
      request?: EvidenceAuditRequest; onmessage?: (event: { data: EvidenceAuditReply | ReturnType<typeof runResponsePreparation> }) => void; onerror?: () => void; terminated = false;
      constructor(readonly url: URL) { if (!url.pathname.endsWith("responsePreparationWorker.ts")) workers.push(this); }
      postMessage(request: EvidenceAuditRequest | ResponsePreparationRequest) { if (this.url.pathname.endsWith("responsePreparationWorker.ts")) this.onmessage?.({ data: runResponsePreparation(request) }); else this.request = request as EvidenceAuditRequest; }
      terminate() { this.terminated = true; }
    }
    vi.stubGlobal("Worker", WorkerStub); await paste(); expect(text()).toContain("Проверяем значения и обязательные условия");
    button("Открыть черновик: Закупки").props.onClick!(); await flush(); expect(runtime.workspace).not.toHaveBeenCalled();
    workers[0].onerror!(); await flush(); expect(text()).toContain("Локальную проверку фактов не удалось завершить");
    await click("Повторить проверку фактов"); expect(workers[0].terminated).toBe(true); expect(workers).toHaveLength(2);
    const previousReply = workers[1].onmessage!;
    previousReply({ data: runEvidenceAudit(workers[1].request!) }); await flush(); await reviewVisibleFindings();
    expect(button("Открыть черновик: Закупки").props.disabled).toBe(false);
    field("name").props.onChange!({ target: { value: "Новая карточка", checked: false } }); await flush(); expect(workers).toHaveLength(3);
    previousReply({ data: runEvidenceAudit(workers[1].request!) }); await flush();
    expect(text()).toContain("Проверяем значения и обязательные условия"); expect(button("Открыть черновик: Закупки").props.disabled).toBe(true);
    workers[2].onmessage!({ data: runEvidenceAudit(workers[2].request!) }); await flush(); expect(field("name").props.value).toBe("Новая карточка");
  });
  it.each(["timeout", "messageerror"] as const)("makes audit %s retryable without replacing the accepted card or accepting a late reply", async (kind) => {
    vi.useFakeTimers(); const audits = holdAudits();
    await addText("Извещение QA", "Синтетическая закупка QA");
    await paste([{ destination: "procurement", title: "Синтетическая закупка QA", fields: { name: "Синтетическая закупка QA" } }]);
    const originalRaw = control("iw-response").props.value, first = audits[0], retainedReply = first.onmessage!;
    expect(text()).toContain("Проверяем значения и обязательные условия"); expect(button("Открыть черновик: Закупки").props.disabled).toBe(true);
    if (kind === "timeout") await vi.advanceTimersByTimeAsync(evidenceAuditTimeoutMilliseconds);
    else { expect(first.onmessageerror).toBeTypeOf("function"); first.onmessageerror!(new Event("messageerror")); }
    await flush();
    expect(text()).toContain("Локальную проверку фактов не удалось завершить"); expect(first.terminated).toBe(true);
    expect(first.onmessage).toBeNull(); expect(first.onerror).toBeNull(); expect(first.onmessageerror).toBeNull();
    expect(field("name").props.value).toBe("Синтетическая закупка QA"); expect(control("iw-response").props.value).toBe(originalRaw);
    retainedReply({ data: runEvidenceAudit(first.request) }); await flush();
    expect(text()).toContain("Локальную проверку фактов не удалось завершить"); expect(button("Открыть черновик: Закупки").props.disabled).toBe(true);
    await click("Повторить проверку фактов"); expect(audits).toHaveLength(2);
    retainedReply({ data: runEvidenceAudit(first.request) }); await flush();
    expect(text()).toContain("Проверяем значения и обязательные условия");
    audits[1].onmessage!({ data: runEvidenceAudit(audits[1].request) }); await flush();
    expect(audits[1].terminated).toBe(true); expect(button("Открыть черновик: Закупки").props.disabled).toBe(false);
    expect(vi.getTimerCount()).toBe(0); expect(runtime.analyze).not.toHaveBeenCalled(); expect(runtime.workspace).not.toHaveBeenCalled(); expect(transfer).not.toHaveBeenCalled();
  });
  it("shows quoted missing conditions and adds the exact source text only on user action", async () => {
    runtime.invoke.mockResolvedValueOnce({ fileName: "Условия.pdf", sha256: "a".repeat(64), extractedText: "Закупка QA\nOSCP — не менее 5 специалистов", fragments: [{ id: "f1", locator: "Страница 1", text: "Закупка QA\nOSCP — не менее 5 специалистов" }], warnings: [] });
    await click("Добавить PDF, DOCX или XLSX"); await paste([{ destination: "procurement", title: "Закупка QA", fields: { name: "Закупка QA", requirements: [] }, sourceIds: [] }]);
    expect(field("requirements").props.value).toBe(""); expect(text()).toContain("Страница 1"); expect(text()).toContain("OSCP — не менее 5 специалистов"); expect(text()).toContain("Не найдено в переносимых данных");
    await click("Добавить точное условие в требования"); expect(field("requirements").props.value).toBe("OSCP — не менее 5 специалистов");
    expect(labeled("Источник Условия.pdf для результата 1").props.checked).toBe(true); expect(text()).toContain("Сопоставление обязательных условий: 1 из 1 найдено");
    expect(button("Открыть черновик: Закупки").props.disabled).toBe(false); await click("Открыть черновик: Закупки");
    const handoff = transfer.mock.calls[0][0]; if (handoff.destination === "procurement") expect(handoff.data.requirements[0].text).toBe("OSCP — не менее 5 специалистов");
  });
  it("adds deadline time and timezone explicitly and binds the note to its source", async () => {
    await addText("Сроки", "Закупка QA\nСрок подачи заявок: 21.10.2026 16:00 МСК");
    await paste([{ destination: "procurement", title: "Закупка QA", fields: { name: "Закупка QA", submissionDeadline: "2026-10-21" } }]);
    expect(field("notes").props.value).toContain("16:00 МСК");
    field("notes").props.onChange!({ target: { value: "", checked: false } }); await flush();
    expect(button("Открыть черновик: Закупки").props.disabled).toBe(true);
    await click("Добавить время в примечания"); expect(field("notes").props.value).toContain("16:00 МСК"); expect(text()).toContain("Сопоставление обязательных условий: 1 из 1 найдено");
    expect(button("Открыть черновик: Закупки").props.disabled).toBe(false);
  });
  it("keeps a source-wide MSK declaration and both quote locators when adding deadline time", async () => {
    const zone = "Время в настоящем документе указано в MSK.";
    const deadline = "Приём предложений до 21.10.2026, 16:00.";
    runtime.invoke.mockResolvedValueOnce({ fileName: "Извещение QA.docx", sha256: "a".repeat(64), extractedText: `Закупка QA\n${zone}\n${deadline}`,
      fragments: [{ id: "intro", locator: "Абзац 1", text: `Закупка QA\n${zone}` }, { id: "deadline", locator: "Абзац 8", text: deadline }], warnings: [] });
    await click("Добавить PDF, DOCX или XLSX"); await paste([{ destination: "procurement", title: "Закупка QA", fields: { name: "Закупка QA", submissionDeadline: "2026-10-21" } }]);
    expect(field("notes").props.value).toContain(zone); expect(text()).toContain("Абзац 1"); expect(text()).toContain("Абзац 8");
    field("notes").props.onChange!({ target: { value: "", checked: false } }); await flush();
    const add = button("Добавить время в примечания").props.onClick!; add(); add(); await flush();
    const note = String(field("notes").props.value); expect(note).toContain("16:00 MSK"); expect(note).toContain(zone); expect(note).toContain(deadline);
    expect(note.split(zone)).toHaveLength(2); expect(note.split(deadline)).toHaveLength(2);
    expect(text()).toContain("Сопоставление обязательных условий: 1 из 1 найдено"); expect(text()).not.toContain("Цитата есть в источнике, но не содержит");
    expect(button("Открыть черновик: Закупки").props.disabled).toBe(false); await click("Открыть черновик: Закупки");
    const handoff = transfer.mock.calls[0][0]; if (handoff.destination === "procurement") { expect(handoff.data.notes.startsWith(`${note}\n\n`)).toBe(true); expect(handoff.provenance).toContain("Абзац 1"); expect(handoff.provenance).toContain("Абзац 8"); }
  });
  it("keeps a glued document timezone after a revision prefix in a manual source and rejects the wrong following day", async () => {
    const zone = "Редакция извещения от 12.10.2026,14:35, время в документе указано в часовом поясеMSK";
    const deadline = "Приём предложений до 21.10.2026,16:00.";
    await addText("Синтетический контроль времени QA83", `Название закупки: Тестирование QA83.\nЗаказчик: ООО «Тест».\n${zone}\n${deadline}`);
    await paste([{ destination: "procurement", title: "Тестирование QA83", fields: { name: "Тестирование QA83", customer: "ООО «Тест»", submissionDeadline: "2026-10-21", notes: "Подача 16:00 MSK 22.10.2026" } }]);
    expect(text()).toContain("Подача: 2026-10-21 16:00 MSK");
    expect(text()).toContain("Сопоставление обязательных условий: 1 из 1 найдено");
    expect(button("Открыть черновик: Закупки").props.disabled).toBe(true);
    field("notes").props.onChange!({ target: { value: "", checked: false } }); await flush(); await click("Добавить время в примечания");
    expect(field("notes").props.value).toContain("16:00 MSK"); expect(field("notes").props.value).toContain(zone); expect(field("notes").props.value).toContain(deadline);
    expect(text()).toContain("Сопоставление обязательных условий: 1 из 1 найдено");
    expect(button("Открыть черновик: Закупки").props.disabled).toBe(false);
    expect(runtime.analyze).not.toHaveBeenCalled();
  });
  it("adds only the missing inherited zone when the original deadline quote is already in notes", async () => {
    const zone = "Все даты и время в документе указаны в MSK.";
    const deadline = "Срок подачи заявок: 21.10.2026 16:00.";
    await addText("Сроки QA", `Закупка QA\n${zone}\n${deadline}`);
    await paste([{ destination: "procurement", title: "Закупка QA", fields: { name: "Закупка QA", submissionDeadline: "2026-10-21", notes: deadline } }]);
    expect(field("notes").props.value).toBe(`${deadline}\n${zone}`);
    field("notes").props.onChange!({ target: { value: deadline, checked: false } }); await flush();
    await click("Добавить время в примечания");
    const note = String(field("notes").props.value); expect(note).toBe(`${deadline}\n${zone}`); expect(note.split(deadline)).toHaveLength(2);
    expect(text()).toContain("Сопоставление обязательных условий: 1 из 1 найдено");
  });
  it("keeps a manual paraphrase while adding the literal proof required by its evidence claim", async () => {
    const zone = "Время в настоящем документе указано в MSK.";
    const deadline = "Срок подачи заявок: 21.10.2026 16:00.";
    const manual = "срок подачи заявок: 21.10.2026 16:00";
    await addText("Сроки QA", `Закупка QA\n${zone}\n${deadline}`);
    await paste([{ destination: "procurement", title: "Закупка QA", fields: { name: "Закупка QA", submissionDeadline: "2026-10-21", notes: manual } }]);
    expect(field("notes").props.value).toContain(deadline);
    field("notes").props.onChange!({ target: { value: manual, checked: false } }); await flush();
    await click("Добавить время в примечания");
    expect(String(field("notes").props.value).startsWith(`${manual}\n`)).toBe(true); expect(field("notes").props.value).toContain(deadline); expect(field("notes").props.value).toContain(zone);
    expect(text()).not.toContain("Цитата есть в источнике, но не содержит"); expect(button("Открыть черновик: Закупки").props.disabled).toBe(false);
  });
  it("does not borrow MSK from another selected document", async () => {
    await addText("Пояс другого документа", "Время в настоящем документе указано в MSK.");
    await addText("Сроки без пояса", "Закупка QA\nСрок подачи заявок: 21.10.2026 16:00.");
    await paste([{ destination: "procurement", title: "Закупка QA", fields: { name: "Закупка QA", submissionDeadline: "2026-10-21" }, sourceIds: [sourceId("Сроки без пояса")] }]);
    expect(field("notes").props.value).toContain("16:00"); expect(field("notes").props.value).not.toMatch(/MSK|МСК|UTC/u);
    field("notes").props.onChange!({ target: { value: "", checked: false } }); await flush();
    await click("Добавить время в примечания");
    expect(field("notes").props.value).toContain("16:00"); expect(field("notes").props.value).not.toMatch(/MSK|МСК|UTC/u);
  });
  it("does not choose a timezone between conflicting declarations in one source", async () => {
    const deadline = "Срок подачи заявок: 21.10.2026 16:00.";
    await addText("Противоречивые сроки", `Закупка QA\nВремя в настоящем документе указано в MSK.\nВремя в настоящем документе указано в UTC.\n${deadline}`);
    await paste([{ destination: "procurement", title: "Закупка QA", fields: { name: "Закупка QA", submissionDeadline: "2026-10-21", notes: deadline } }]);
    await click("Добавить время в примечания");
    const note = String(field("notes").props.value);
    expect(note).toContain(deadline); expect(note).toContain("Время в настоящем документе указано в MSK."); expect(note).toContain("Время в настоящем документе указано в UTC.");
    const label = note.split("\n").find((line) => line.startsWith("Подача:")); expect(label).toContain("часовой пояс требует уточнения"); expect(label).not.toMatch(/MSK|МСК|UTC/u);
    expect(text()).toContain("Нужна проверка"); expect(button("Открыть черновик: Закупки").props.disabled).toBe(true);
  });
  it("does not duplicate a numbered condition or overwrite later manual requirements through a retained action", async () => {
    const existing = "КНД 1120101 об отсутствии налоговой задолженности";
    await addText("Документы QA", `Закупка QA\n8. ${existing}.`);
    await paste([{ destination: "procurement", title: "Закупка QA", fields: { name: "Закупка QA", requirements: [] } }]);
    expect(field("requirements").props.value).toBe(`8. ${existing}.`);
    field("requirements").props.onChange!({ target: { value: "", checked: false } }); await flush();
    const add = button("Добавить точное условие в требования").props.onClick!;
    field("requirements").props.onChange!({ target: { value: `${existing}\nРучное условие: срок 14 рабочих дней`, checked: false } }); await flush();
    add(); add(); await flush();
    expect(field("requirements").props.value).toBe(`${existing}\nРучное условие: срок 14 рабочих дней`);
    expect(text()).toContain("Эквивалентное условие уже есть"); expect(String(field("requirements").props.value).match(/1120101/gu)).toHaveLength(1);
    expect(runtime.workspace).not.toHaveBeenCalled(); expect(transfer).not.toHaveBeenCalled();
  });
  it("preserves different business counts rather than deduplicating their common certificate name", async () => {
    await addText("Сертификаты QA", "Закупка QA\n1. OSCP — не менее 5 специалистов.\n2. OSCP — не менее 7 специалистов.");
    await paste([{ destination: "procurement", title: "Закупка QA", fields: { name: "Закупка QA", requirements: ["OSCP — не менее 5 специалистов"] } }]);
    expect(text()).toContain("Из источников автоматически добавлено пунктов: 1");
    expect(String(field("requirements").props.value).split("\n")).toHaveLength(2);
    expect(field("requirements").props.value).toContain("не менее 5"); expect(field("requirements").props.value).toContain("не менее 7");
  });
  it("keeps an invalid original note instead of discarding it when adding source context", async () => {
    await addText("Сроки QA", "Закупка QA\nСрок подачи заявок: 21.10.2026 16:00 МСК");
    await paste([{ destination: "procurement", title: "Закупка QA", fields: { name: "Закупка QA", notes: 42 } }]);
    await click("Добавить время в примечания"); expect(field("notes").props.value).toBe("42"); expect(text()).toContain("Исходное значение сохранено");
  });
  it("links price facts to the selected pricing source instead of borrowing unrelated document values", async () => {
    await addText("Техническое задание", "Поставка оборудования"); const technicalId = sourceId("Техническое задание");
    await addText("Расчёт цены", "Итого НМЦ договора: 2 000 руб.");
    await paste([{ destination: "procurement", title: "Поставка оборудования", fields: { name: "Поставка оборудования", nmc: 2000 }, sourceIds: [technicalId] }]);
    expect(labeled("Источник Расчёт цены для результата 1").props.checked).toBe(false); expect(button("Открыть черновик: Закупки").props.disabled).toBe(true);
    await toggle("Источник Расчёт цены для результата 1", true); expect(button("Открыть черновик: Закупки").props.disabled).toBe(false); await click("Открыть черновик: Закупки");
    expect(transfer.mock.calls[0][0].provenance).toContain("Расчёт цены");
  });
  it("keeps manual proposal positions separate with multiline and empty descriptions and paired reordering", async () => {
    await edit("iw-new-destination", "proposals"); await click("Добавить карточку вручную"); field("title").props.onChange!({ target: { value: "Ручное КП", checked: false } }); await flush();
    await click("Добавить позицию КП"); await editLabeled("Наименование позиции 1 результата 1", "Сервер A"); await editLabeled("Описание позиции 1 результата 1", "Процессор A\nПамять A\nНакопитель A");
    await click("Добавить позицию КП"); await editLabeled("Наименование позиции 2 результата 1", "Сервер B");
    expect(labeled("Описание позиции 2 результата 1").props.value).toBe("");
    labeled("Переместить позицию 1 вниз результата 1").props.onClick!(); await flush();
    expect(labeled("Наименование позиции 1 результата 1").props.value).toBe("Сервер B"); expect(labeled("Описание позиции 1 результата 1").props.value).toBe("");
    expect(labeled("Описание позиции 2 результата 1").props.value).toBe("Процессор A\nПамять A\nНакопитель A");
    expect(text()).toContain("Ручная карточка"); expect(nodes().filter((node) => /^Проверено замечание /.test(node.props["aria-label"] || ""))).toHaveLength(0);
    expect(button("Открыть черновик: Коммерческие предложения").props.disabled).toBe(false); await click("Открыть черновик: Коммерческие предложения");
    const handoff = transfer.mock.calls[0][0]; if (handoff.destination === "proposals") { expect(handoff.data.lines).toHaveLength(2); expect(handoff.data.lines[0].description).toBe(""); expect(handoff.data.lines[1].description).toBe("Процессор A\nПамять A\nНакопитель A"); expect(handoff.data.lines.every((line) => line.quantity === "" && line.unitPrice === "")).toBe(true); }
  });
  it("recovers one invalid scalar description as one multiline description rather than splitting lines", async () => {
    await paste([{ destination: "proposals", title: "КП", fields: { title: "КП", lines: ["Сервер"], lineDescriptions: "Процессор\nПамять\nНакопитель" } }]);
    expect(field("lineDescriptions").props.value).toBe("Процессор\nПамять\nНакопитель"); await click("Использовать текст как одно описание");
    expect(labeled("Описание позиции 1 результата 1").props.value).toBe("Процессор\nПамять\nНакопитель");
    await reviewVisibleFindings(); await click("Открыть черновик: Коммерческие предложения"); const handoff = transfer.mock.calls[0][0];
    if (handoff.destination === "proposals") { expect(handoff.data.lines).toHaveLength(1); expect(handoff.data.lines[0].description).toBe("Процессор\nПамять\nНакопитель"); }
  });
  it("keeps hidden worksheets excluded by default and transmits warnings with selected material", async () => {
    await configureModel(); runtime.invoke.mockResolvedValueOnce({ fileName: "Расчёт.xlsx", sha256: "a".repeat(64), extractedText: "Текущая закупка", fragments: [{ id: "visible", locator: "Текущий лист", sheetId: "v", sheetState: "visible", text: "Текущая закупка" }], sheets: [{ id: "v", name: "Текущий", state: "visible", included: true }, { id: "h", name: "История", state: "hidden", included: false }], warnings: ["Скрытый лист исключён по умолчанию"] });
    await click("Добавить PDF, DOCX или XLSX"); expect(labeled("Лист История источника Расчёт.xlsx").props.checked).toBe(false);
    await click("Отправить выбранные источники"); const prompt = runtime.analyze.mock.calls[0][1] as string; expect(prompt).toContain("Скрытый лист исключён по умолчанию"); expect(prompt).toContain("Текущая закупка"); expect(prompt).not.toContain("Старый заказчик");
  });
  it("includes hidden worksheets only after explicit selection and ignores a late reread after manual text edits", async () => {
    const initial = { fileName: "Расчёт.xlsx", sha256: "a".repeat(64), extractedText: "Текущая закупка", fragments: [{ id: "visible", locator: "Текущий лист", sheetId: "v", sheetState: "visible", text: "Текущая закупка" }], sheets: [{ id: "v", name: "Текущий", state: "visible", included: true }, { id: "h", name: "История", state: "hidden", included: false }], warnings: [] };
    runtime.invoke.mockResolvedValueOnce(initial); await click("Добавить PDF, DOCX или XLSX");
    runtime.invoke.mockResolvedValueOnce({ ...initial, extractedText: "Текущая закупка\nСтарый заказчик", sheets: initial.sheets.map((sheet) => ({ ...sheet, included: true })), fragments: [...initial.fragments, { id: "history", locator: "История", sheetId: "h", sheetState: "hidden", includedByUser: true, text: "Старый заказчик" }], warnings: ["Скрытый лист включён пользователем"] });
    await toggle("Лист История источника Расчёт.xlsx", true);
    expect(runtime.invoke.mock.calls[1][1].config).toMatchObject({ selectedSheets: ["v", "h"], includeHiddenSheets: true }); expect(labeled("Текст источника Расчёт.xlsx").props.value).toContain("Старый заказчик");
    const late = deferred<unknown>(); runtime.invoke.mockReturnValueOnce(late.promise); await toggle("Лист История источника Расчёт.xlsx", false);
    await editLabeled("Текст источника Расчёт.xlsx", "Ручной текст"); late.resolve({ ...initial, extractedText: "Поздний ответ", sha256: "b".repeat(64) }); await flush();
    expect(labeled("Текст источника Расчёт.xlsx").props.value).toBe("Ручной текст"); expect(text()).not.toContain("Поздний ответ");
    expect(nodes().some((node) => node.props["aria-label"] === "Лист История источника Расчёт.xlsx")).toBe(false);
  });
});
