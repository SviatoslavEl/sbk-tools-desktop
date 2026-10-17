import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runSourceFacts, type SourceFactsRequest } from "./sourceFactsWorker";
import { sourceFactsTimeoutMilliseconds, useSourceFactsInventory } from "./useSourceFactsInventory";
import type { IntelligenceSource } from "./workbenchTypes";

const hooks = vi.hoisted(() => ({ cursor: 0, changed: false,
  slots: [] as Array<{ value?: unknown; deps?: readonly unknown[]; cleanup?: () => void }>, effects: [] as Array<() => void>,
}));
vi.mock("react", async (original) => {
  const same = (a?: readonly unknown[], b?: readonly unknown[]) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  return { ...await original<typeof import("react")>(),
    useState: (initial: unknown) => { const index = hooks.cursor++; if (!hooks.slots[index]) hooks.slots[index] = { value: initial }; return [hooks.slots[index].value, (next: unknown) => { const value = typeof next === "function" ? next(hooks.slots[index].value) : next; if (!Object.is(value, hooks.slots[index].value)) { hooks.slots[index].value = value; hooks.changed = true; } }]; },
    useRef: (initial: unknown) => { const index = hooks.cursor++; if (!hooks.slots[index]) hooks.slots[index] = { value: { current: initial } }; return hooks.slots[index].value; },
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => { const index = hooks.cursor++, previous = hooks.slots[index]; if (previous && same(previous.deps, deps)) return; hooks.slots[index] = { ...previous, deps }; hooks.effects.push(() => { previous?.cleanup?.(); const cleanup = effect(); hooks.slots[index].cleanup = typeof cleanup === "function" ? cleanup : undefined; }); },
  };
});

class LocalWorker {
  static instances: LocalWorker[] = [];
  static throwConstructor = false;
  static throwPost = false;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessageerror: ((event: Event) => void) | null = null;
  request!: SourceFactsRequest;
  terminated = 0;
  constructor(readonly url: URL, readonly options: unknown) { if (LocalWorker.throwConstructor) throw new Error("constructor failure"); LocalWorker.instances.push(this); }
  postMessage(request: SourceFactsRequest) { if (LocalWorker.throwPost) throw new Error("clone failure"); this.request = structuredClone(request); }
  terminate() { this.terminated++; }
  reply(value: unknown = runSourceFacts(this.request)) { this.onmessage?.({ data: value }); }
}

let sources: IntelligenceSource[], enabled: boolean, result: ReturnType<typeof useSourceFactsInventory>;
function render(next = sources, active = enabled, effects = true) { sources = next; enabled = active; hooks.cursor = 0; hooks.changed = false; result = useSourceFactsInventory(sources, enabled); if (effects) for (const effect of hooks.effects.splice(0)) effect(); }
async function flush() { for (let index = 0; index < 20; index++) { await Promise.resolve(); if (hooks.changed) render(); } }
function unmount() { for (const slot of hooks.slots) slot.cleanup?.(); hooks.slots = []; hooks.effects = []; hooks.cursor = 0; hooks.changed = false; }
beforeEach(() => {
  hooks.cursor = 0; hooks.changed = false; hooks.slots = []; hooks.effects = [];
  LocalWorker.instances = []; LocalWorker.throwConstructor = false; LocalWorker.throwPost = false;
  vi.stubGlobal("Worker", LocalWorker);
  sources = [{ id: "qa", name: "Синтетический источник QA", text: "Срок подачи: 03.08.2039 11:45 MSK" }]; enabled = false;
});
afterEach(() => { unmount(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("one lazy shared source-fact inventory per workbench", () => {
  it("does nothing before explicit enable, then shares one job across rerenders/cards", async () => {
    render(); await flush(); expect(LocalWorker.instances).toHaveLength(0);
    expect(result).toMatchObject({ pending: false, failed: false, inventory: undefined });
    render(sources, true); await flush(); expect(result.pending).toBe(true);
    for (let index = 0; index < 100; index++) render();
    expect(LocalWorker.instances).toHaveLength(1);
    expect(LocalWorker.instances[0].url.pathname).toMatch(/sourceFactsWorker\.ts$/u);
    expect(LocalWorker.instances[0].options).toEqual({ type: "module" });
    LocalWorker.instances[0].reply(); await flush();
    expect(result.inventory?.dates.facts).toHaveLength(1); expect(result.pending).toBe(false);
    expect(LocalWorker.instances[0].terminated).toBe(1);
    render(); await flush(); expect(LocalWorker.instances).toHaveLength(1);
  });
  it("rejects an earlier revision, replaces changed source identity, and ignores retained old callbacks", async () => {
    render(sources, true); await flush(); const old = LocalWorker.instances[0], stale = old.onmessage!;
    old.reply({ ...runSourceFacts(old.request), revision: old.request.revision + 1 }); await flush();
    expect(result.pending).toBe(true); expect(old.terminated).toBe(0);
    const next = [{ ...sources[0], text: "Срок подачи: 04.08.2039 11:45 MSK" }];
    render(next); await flush(); expect(old.terminated).toBe(1);
    stale({ data: runSourceFacts(old.request) }); await flush(); expect(result.inventory).toBeUndefined();
    LocalWorker.instances[1].reply(); await flush();
    expect(result.inventory!.dates.facts[0].iso).toBe("2039-08-04");
  });
  it("does not expose an old inventory during render before the new effect is committed", async () => {
    render(sources, true); await flush(); LocalWorker.instances[0].reply(); await flush();
    const next = [{ ...sources[0], text: "Срок подачи: 04.08.2039 11:45 MSK" }];
    render(next, true, false); expect(result.inventory).toBeUndefined(); expect(result.pending).toBe(true);
    for (const effect of hooks.effects.splice(0)) effect(); await flush();
  });
  it.each(["onerror", "onmessageerror"] as const)("terminates on %s, keeps failure terminal and retries only explicitly", async (kind) => {
    render(sources, true); await flush(); const old = LocalWorker.instances[0], stale = old.onmessage!;
    old[kind]!(new Event("error")); await flush();
    expect(old.terminated).toBe(1); expect(result).toMatchObject({ failed: true, pending: false, inventory: undefined });
    stale({ data: runSourceFacts(old.request) }); await flush(); expect(result.failed).toBe(true);
    render(); await flush(); expect(LocalWorker.instances).toHaveLength(1);
    result.retry(); await flush(); expect(LocalWorker.instances).toHaveLength(2);
    LocalWorker.instances[1].reply(); await flush(); expect(result.failed).toBe(false); expect(result.inventory).toBeDefined();
  });
  it.each([null, {}, { revision: "wrong" }, { inventory: {} }])("fails closed for a malformed reply without leaving a permanent pending state: %j", async (value) => {
    render(sources, true); await flush(); const worker = LocalWorker.instances[0];
    worker.reply(value); await flush(); expect(worker.terminated).toBe(1);
    expect(result).toMatchObject({ failed: true, pending: false, inventory: undefined });
  });
  it("never exposes an inventory alongside failed=true or accepts malformed nested arrays", async () => {
    render(sources, true); await flush();
    LocalWorker.instances[0].reply({ ...runSourceFacts(LocalWorker.instances[0].request), failed: true }); await flush();
    expect(result.inventory).toBeUndefined(); expect(result.failed).toBe(true);
    result.retry(); await flush(); const current = LocalWorker.instances[1];
    const reply = runSourceFacts(current.request); const inventory = reply.inventory!; inventory.dates.facts = [null] as unknown as typeof inventory.dates.facts;
    current.reply(reply); await flush(); expect(result.failed).toBe(true); expect(current.terminated).toBe(1);
  });
  it.each(["constructor", "post"] as const)("recovers through retry after a %s exception", async (kind) => {
    LocalWorker.throwConstructor = kind === "constructor"; LocalWorker.throwPost = kind === "post";
    render(sources, true); await flush(); expect(result.failed).toBe(true);
    if (kind === "post") expect(LocalWorker.instances[0].terminated).toBe(1);
    LocalWorker.throwConstructor = false; LocalWorker.throwPost = false;
    result.retry(); await flush(); const current = LocalWorker.instances[LocalWorker.instances.length - 1];
    current.reply(); await flush(); expect(result.inventory).toBeDefined(); expect(result.failed).toBe(false);
  });
  it("hides and releases disabled/unmounted jobs and ignores their late callbacks", async () => {
    render(sources, true); await flush(); const first = LocalWorker.instances[0], stale = first.onmessage!;
    render(sources, false, false); expect(result.inventory).toBeUndefined(); expect(result.pending).toBe(false);
    for (const effect of hooks.effects.splice(0)) effect(); await flush(); expect(first.terminated).toBe(1);
    stale({ data: runSourceFacts(first.request) }); await flush(); expect(result.inventory).toBeUndefined();
    render(sources, true); await flush(); const second = LocalWorker.instances[1], late = second.onmessage!;
    unmount(); expect(second.terminated).toBe(1); late({ data: runSourceFacts(second.request) }); expect(hooks.changed).toBe(false);
  });
  it("turns a silent worker into a retryable error after a bounded local timeout", async () => {
    vi.useFakeTimers(); render(sources, true); await flush();
    vi.advanceTimersByTime(sourceFactsTimeoutMilliseconds); await flush();
    expect(result).toMatchObject({ failed: true, pending: false }); expect(LocalWorker.instances[0].terminated).toBe(1);
    result.retry(); await flush(); LocalWorker.instances[1].reply(); await flush();
    expect(result.inventory).toBeDefined(); expect(vi.getTimerCount()).toBe(0);
  });
  it("uses a bounded pure fallback only after enable when Worker is unavailable", async () => {
    vi.stubGlobal("Worker", undefined); const snapshot = structuredClone(sources);
    render(); await flush(); expect(result.inventory).toBeUndefined();
    render(sources, true); await flush(); expect(result.inventory!.dates.facts[0].iso).toBe("2039-08-03");
    expect(result.pending).toBe(false); expect(result.failed).toBe(false); expect(sources).toEqual(snapshot);
  });
});
