import { afterEach, describe, expect, it, vi } from "vitest";
import * as automatic from "./automaticConditions";
import { RESPONSE_PREPARATION_LIMITS, runResponsePreparation, validResponsePreparationReply, type ResponsePreparationRequest, type ResponsePreparationResult } from "./responsePreparationWorker";
import type { IntelligenceSource } from "./workbenchTypes";

const source = (text = "1. Сертификат OSCP — не менее 5 специалистов.\n2. Копия доверенности, если подписывает представитель.", id = "source-a"): IntelligenceSource => ({ id, name: "Синтетический источник QA", text, fragments: [{ id: "page-1", locator: "Страница 1", text }] });
const wire = (fields: Record<string, unknown> = { name: "Синтетическая закупка" }, extra: Record<string, unknown> = {}) => ({ destination: "procurement", title: "QA закупка", fields, sourceIds: ["source-a"], ...extra });
const request = (overrides: Partial<ResponsePreparationRequest> = {}): ResponsePreparationRequest => ({ revision: 7, raw: JSON.stringify({ items: [wire()] }), sources: [source()], destinations: ["procurement"], ...overrides });
const freeze = <T,>(value: T): T => { if (value && typeof value === "object") { Object.freeze(value); Object.values(value).forEach(freeze); } return value; };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("atomic local response preparation worker", () => {
  it("parses then supplements scoped certificates/documents without changing raw, sources or calling IO", () => {
    const fetch = vi.fn(), storage = { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() };
    vi.stubGlobal("fetch", fetch); vi.stubGlobal("window", { localStorage: storage, sessionStorage: storage });
    const input = request(), before = structuredClone(input); freeze(input);
    const reply = runResponsePreparation(input);
    expect(validResponsePreparationReply(reply, input.revision)).toBe(true); expect(reply.failed).toBeUndefined(); expect(reply.empty).toBeUndefined();
    expect(reply.prepared!.items).toHaveLength(1); const card = reply.prepared!.items[0];
    expect(card.fields.name).toBe("Синтетическая закупка"); expect(card.fields.requirements).toContain("1. Сертификат OSCP — не менее 5 специалистов.");
    expect(card.fields.requirements).toContain("2. Копия доверенности, если подписывает представитель.");
    expect(reply.prepared!.changes.every((change) => change.requiresReview === true)).toBe(true);
    expect(input).toEqual(before); expect(JSON.parse(input.raw).items[0].fields.requirements).toBeUndefined(); expect(fetch).not.toHaveBeenCalled();
    for (const method of Object.values(storage)) expect(method).not.toHaveBeenCalled();
  });

  it("retains editable invalid dates and model fields instead of silently correcting them", () => {
    const input = request({ raw: JSON.stringify({ items: [wire({ name: "QA", submissionDeadline: "2110-26-16", notes: "null", requirements: ["Ручная строка модели"] })] }) });
    const reply = runResponsePreparation(input); expect(reply.failed).toBeUndefined();
    expect(reply.prepared!.items[0].fields).toMatchObject({ submissionDeadline: "2110-26-16", notes: "null" });
    expect(reply.prepared!.items[0].fields.requirements).toContain("Ручная строка модели"); expect(input.raw).toContain("2110-26-16");
  });

  it("returns empty for a valid zero-card response without invoking completion or manufacturing cards", () => {
    const completion = vi.spyOn(automatic, "completeIntelligenceConditions");
    const reply = runResponsePreparation(request({ raw: "{\"items\":[]}" }));
    expect(reply).toEqual({ revision: 7, empty: true }); expect(validResponsePreparationReply(reply, 7)).toBe(true); expect(completion).not.toHaveBeenCalled();
  });

  it.each([null, undefined, 0, {}, { revision: -1 }, { revision: 1.5 }, { revision: Number.NaN }, { revision: Number.MAX_SAFE_INTEGER + 1 }])("fails closed for malformed revision/envelope %j", (input) => {
    expect(() => runResponsePreparation(input)).not.toThrow(); const reply = runResponsePreparation(input);
    expect(reply.revision).toBe(-1); expect(reply.failed).toBeTypeOf("string"); expect(reply.prepared).toBeUndefined(); expect(reply.empty).toBeUndefined();
    expect(validResponsePreparationReply(reply)).toBe(true); expect(validResponsePreparationReply(reply, 7)).toBe(false);
  });

  it("rejects invalid envelopes and bounds without partial parsed/prepared data", () => {
    const normal = request(), large = "x".repeat(RESPONSE_PREPARATION_LIMITS.snapshotBytes + 1);
    const invalid: unknown[] = [
      { ...normal, raw: null }, { ...normal, raw: "я".repeat(RESPONSE_PREPARATION_LIMITS.rawBytes / 2 + 1) },
      { ...normal, sources: null }, { ...normal, sources: [normal.sources[0], normal.sources[0]] },
      { ...normal, sources: Array(101).fill(normal.sources[0]) }, { ...normal, sources: [{ ...source(), text: large }] },
      { ...normal, sources: [{ ...source(), text: "a", fragments: Array(5001).fill({ text: "a", locator: "QA" }) }] },
      { ...normal, sources: [{ ...source(), id: "bad\nsource" }] }, { ...normal, sources: [{ ...source(), fragments: [null] }] },
      { ...normal, sources: [{ ...source(), fragments: [{ locator: "QA", text: null }] }] },
      { ...normal, sources: [{ ...source(), coverage: { complete: true, requiresOcr: "yes" } }] },
      { ...normal, destinations: [] }, { ...normal, destinations: ["procurement", "procurement"] },
      { ...normal, destinations: ["unknown"] }, { ...normal, destinations: null }, { ...normal, command: "write-database" },
    ];
    const completion = vi.spyOn(automatic, "completeIntelligenceConditions");
    for (const input of invalid) { const reply = runResponsePreparation(input); expect(reply.revision).toBe(7); expect(reply.failed).toBeTypeOf("string"); expect(reply.prepared).toBeUndefined(); expect(reply.empty).toBeUndefined(); }
    expect(completion).not.toHaveBeenCalled();
  });

  it("accepts aggregate/fragment snapshot duplication above 1 MiB without inventing a stricter model-payload limit", () => {
    const text = `${"x".repeat(550_000)}\n1. Сертификат OSCP — не менее 5 специалистов.`;
    const input = request({ sources: [source(text)] }); expect(new TextEncoder().encode(JSON.stringify(input.sources)).byteLength).toBeGreaterThan(1024 * 1024);
    const reply = runResponsePreparation(input); expect(reply.failed).toBeUndefined(); expect(validResponsePreparationReply(reply, 7)).toBe(true);
    // A parser budget is explicitly represented by completion, not erased.
    expect(reply.prepared!.limited).toBe(true);
  });

  it.each([
    "not-json", "{\"items\":[],\"items\":[]}", JSON.stringify({ items: [wire(), { destination: "unknown", title: "QA", fields: {} }] }),
    JSON.stringify({ items: [wire({}, { sourceIds: ["foreign"] })] }),
    JSON.stringify({ items: [wire({}, { destination: "contracts" })] }),
  ])("rejects the complete malformed/wrong-scope response atomically: %s", (raw) => {
    const completion = vi.spyOn(automatic, "completeIntelligenceConditions");
    const reply = runResponsePreparation(request({ raw }));
    expect(reply.failed).toBeTypeOf("string"); expect(reply.prepared).toBeUndefined(); expect(completion).not.toHaveBeenCalled();
  });

  it("preserves explicit source scoping and does not auto-fill a foreign or hidden source", () => {
    const first = source("Название закупки: QA"), foreign = source(undefined, "foreign"), hidden = source(); hidden.fragments![0].sheetState = "hidden";
    const scoped = runResponsePreparation(request({ sources: [first, foreign] }));
    expect(scoped.prepared!.items[0].fields.requirements).toBeUndefined();
    const excluded = runResponsePreparation(request({ sources: [hidden] })); expect(excluded.prepared!.items[0].fields.requirements).toBeUndefined();
  });

  it("fails atomically if completion throws, returns malformed data or exceeds the output budget", () => {
    const completion = vi.spyOn(automatic, "completeIntelligenceConditions");
    completion.mockImplementationOnce(() => { throw new Error("Синтетическая ошибка подготовки"); });
    expect(runResponsePreparation(request())).toEqual({ revision: 7, failed: "Синтетическая ошибка подготовки" });
    completion.mockReturnValueOnce({ items: [], changes: [], skipped: [], limited: false });
    expect(runResponsePreparation(request()).prepared).toBeUndefined();
    const normal = runResponsePreparation(request()).prepared!, tooLarge = structuredClone(normal);
    tooLarge.items = Array.from({ length: 100 }, (_, index) => ({ ...structuredClone(normal.items[0]), id: `card-${index}`, fields: { notes: "x".repeat(100_000) } }));
    tooLarge.changes = []; tooLarge.skipped = [];
    completion.mockReturnValueOnce(tooLarge); const rejected = runResponsePreparation(request());
    expect(rejected.failed).toBeTypeOf("string"); expect(rejected.prepared).toBeUndefined();
  });

  it("validates mutually exclusive reply variants, nested receipt safety and current revision", () => {
    const reply = runResponsePreparation(request()); expect(validResponsePreparationReply(reply, 7)).toBe(true); expect(validResponsePreparationReply(reply, 8)).toBe(false);
    const prepared = reply.prepared!;
    const invalid: unknown[] = [null, {}, { revision: "7", empty: true }, { revision: 7 }, { revision: 7, empty: false }, { revision: 7, failed: "" },
      { revision: 7, empty: true, prepared }, { revision: 7, failed: "QA", prepared }, { revision: 7, prepared: {} }, { revision: 7, empty: true, unknown: true }];
    for (const mutate of [
      (copy: ResponsePreparationResult) => { copy.items[0].sourceIds = ["source-a", "source-a"]; },
      (copy: ResponsePreparationResult) => { copy.items[0].selectedFields = ["unknown"]; },
      (copy: ResponsePreparationResult) => { copy.items[0].fields.name = {} as never; },
      (copy: ResponsePreparationResult) => { copy.changes[0].requiresReview = false as true; },
      (copy: ResponsePreparationResult) => { copy.changes[0].itemId = "foreign-card"; },
      (copy: ResponsePreparationResult) => { copy.changes = Array(RESPONSE_PREPARATION_LIMITS.receipts + 1).fill(copy.changes[0]); },
    ]) { const copy = structuredClone(prepared); mutate(copy); invalid.push({ revision: 7, prepared: copy }); }
    for (const value of invalid) expect(validResponsePreparationReply(value, 7)).toBe(false);
  });

  it("preserves literal exception provenance when a document-specific exception is automatically included", () => {
    const input = request({ sources: [source("Информация и документы могут не включаться в заявку, если находятся в открытом реестре и в заявку включена декларация.")] });
    const reply = runResponsePreparation(input); expect(reply.failed).toBeUndefined(); expect(validResponsePreparationReply(reply, 7)).toBe(true);
    expect(reply.prepared!.items[0].fields.requirements).toContain(input.sources[0].text);
    expect(reply.prepared!.changes.some((change) => change.category === "exception" && change.requiresReview)).toBe(true);
  });

  it("does not install a message handler when imported in a browser Window", async () => {
    const existing = vi.fn(), host = { onmessage: existing, postMessage: vi.fn() }; vi.stubGlobal("self", host); vi.stubGlobal("document", {});
    vi.resetModules(); await import("./responsePreparationWorker"); expect(host.onmessage).toBe(existing); expect(host.postMessage).not.toHaveBeenCalled();
  });

  it("installs the handler in worker scope and reflects each independent revision without stale internal state", async () => {
    const postMessage = vi.fn(), host: { onmessage: ((event: { data: unknown }) => void) | null; postMessage: typeof postMessage } = { onmessage: null, postMessage };
    vi.stubGlobal("self", host); vi.stubGlobal("document", undefined); vi.resetModules(); await import("./responsePreparationWorker");
    host.onmessage!({ data: request({ revision: 11 }) }); host.onmessage!({ data: request({ revision: 12, raw: "{\"items\":[]}" }) });
    expect(postMessage.mock.calls[0][0].revision).toBe(11); expect(validResponsePreparationReply(postMessage.mock.calls[0][0], 11)).toBe(true);
    expect(postMessage.mock.calls[1][0]).toEqual({ revision: 12, empty: true }); expect(validResponsePreparationReply(postMessage.mock.calls[0][0], 12)).toBe(false);
  });
});
