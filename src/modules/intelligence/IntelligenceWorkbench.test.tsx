import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "../../components/Dialog";
import { IntelligenceWorkbench } from "./IntelligenceWorkbench";
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

interface NodeProps { children?: ReactNode; value?: unknown; checked?: boolean; id?: string; type?: string; disabled?: boolean; className?: string; open?: boolean; "aria-label"?: string; onClick?: () => unknown; onChange?: (event: { target: { value: string; checked: boolean } }) => unknown; onConfirm?: () => unknown; onClose?: () => void; }
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
afterEach(() => { for (const slot of runtime.slots) slot.cleanup?.(); vi.unstubAllGlobals(); });

describe("unified intelligence workflow", () => {
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
    expect(text()).toContain("распознавание в сканере"); expect(runtime.workspace).not.toHaveBeenCalled();
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
  it("shows worker progress and failure, retries, and ignores terminated worker replies", async () => {
    const workers: Array<{ request?: EvidenceAuditRequest; onmessage?: (event: { data: EvidenceAuditReply }) => void; onerror?: () => void; terminated: boolean }> = [];
    class WorkerStub {
      request?: EvidenceAuditRequest; onmessage?: (event: { data: EvidenceAuditReply }) => void; onerror?: () => void; terminated = false;
      constructor() { workers.push(this); }
      postMessage(request: EvidenceAuditRequest) { this.request = request; }
      terminate() { this.terminated = true; }
    }
    vi.stubGlobal("Worker", WorkerStub); await paste(); expect(text()).toContain("Проверяем значения и обязательные условия");
    button("Открыть черновик: Закупки").props.onClick!(); await flush(); expect(runtime.workspace).not.toHaveBeenCalled();
    workers[0].onerror!(); await flush(); expect(text()).toContain("Локальную проверку фактов не удалось завершить");
    await click("Повторить проверку фактов"); expect(workers[0].terminated).toBe(true); expect(workers).toHaveLength(2);
    workers[1].onmessage!({ data: runEvidenceAudit(workers[1].request!) }); await flush(); await reviewVisibleFindings();
    expect(button("Открыть черновик: Закупки").props.disabled).toBe(false);
    field("name").props.onChange!({ target: { value: "Новая карточка", checked: false } }); await flush(); expect(workers).toHaveLength(3);
    workers[1].onmessage!({ data: runEvidenceAudit(workers[1].request!) }); await flush();
    expect(text()).toContain("Проверяем значения и обязательные условия"); expect(button("Открыть черновик: Закупки").props.disabled).toBe(true);
    workers[2].onmessage!({ data: runEvidenceAudit(workers[2].request!) }); await flush(); expect(field("name").props.value).toBe("Новая карточка");
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
    expect(field("notes").props.value).toBe(""); expect(button("Открыть черновик: Закупки").props.disabled).toBe(true);
    await click("Добавить время в примечания"); expect(field("notes").props.value).toContain("16:00 МСК"); expect(text()).toContain("Сопоставление обязательных условий: 1 из 1 найдено");
    expect(button("Открыть черновик: Закупки").props.disabled).toBe(false);
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
