import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startResponsePreparation, ResponsePreparationCancelled, responsePreparationTimeoutMilliseconds } from "./responsePreparation";
import { runResponsePreparation, type ResponsePreparationRequest } from "./responsePreparationWorker";

const request = (): ResponsePreparationRequest => ({ revision: 1, raw: JSON.stringify({ items: [{ destination: "procurement", title: "QA", fields: { name: "QA" } }] }), sources: [{ id: "source", name: "QA", text: "Сертификат OSCP — не менее 5;" }], destinations: ["procurement"] });
class LocalWorker {
  static instances: LocalWorker[] = [];
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessageerror: ((event: Event) => void) | null = null;
  terminated = 0;
  request!: ResponsePreparationRequest;
  constructor(readonly url: URL, readonly options: WorkerOptions) { LocalWorker.instances.push(this); }
  postMessage(value: ResponsePreparationRequest) { this.request = value; }
  terminate() { this.terminated++; }
  reply(value: unknown = runResponsePreparation(this.request)) { this.onmessage?.({ data: value } as MessageEvent<unknown>); }
}
beforeEach(() => { LocalWorker.instances = []; vi.stubGlobal("Worker", LocalWorker); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("atomic response preparation bridge", () => {
  it("runs once in a local module worker and terminates after returning a validated result", async () => {
    const task = startResponsePreparation(request()), worker = LocalWorker.instances[0];
    expect(worker.url.pathname).toMatch(/responsePreparationWorker\.ts$/u); expect(worker.options).toEqual({ type: "module" });
    worker.reply(); const reply = await task.promise;
    expect(reply.prepared?.items[0].fields.requirements).toEqual(["Сертификат OSCP — не менее 5;"]);
    expect(worker.terminated).toBe(1); expect(worker.onmessage).toBeNull();
    task.cancel(); expect(worker.terminated).toBe(1);
  });
  it("rejects cancellation and ignores a retained old callback", async () => {
    const task = startResponsePreparation(request()), worker = LocalWorker.instances[0], stale = worker.onmessage!;
    const rejection = expect(task.promise).rejects.toBeInstanceOf(ResponsePreparationCancelled);
    task.cancel(); stale({ data: runResponsePreparation(worker.request) } as MessageEvent<unknown>);
    await rejection; expect(worker.terminated).toBe(1);
  });
  it("ignores another revision but never accepts malformed replies", async () => {
    const task = startResponsePreparation(request()), worker = LocalWorker.instances[0];
    worker.reply({ ...runResponsePreparation(worker.request), revision: 2 }); expect(worker.terminated).toBe(0);
    worker.reply(null); await expect(task.promise).rejects.toThrow("некорректный"); expect(worker.terminated).toBe(1);
  });
  it.each(["onerror", "onmessageerror"] as const)("makes %s terminal and releases resources", async (kind) => {
    const task = startResponsePreparation(request()), worker = LocalWorker.instances[0], stale = worker.onmessage!;
    const rejection = expect(task.promise).rejects.toThrow("локальное извлечение"); worker[kind]!(new Event("error"));
    stale({ data: runResponsePreparation(worker.request) } as MessageEvent<unknown>); await rejection; expect(worker.terminated).toBe(1);
  });
  it("times out without auto-retrying or leaving a worker running", async () => {
    vi.useFakeTimers(); const task = startResponsePreparation(request());
    const rejection = expect(task.promise).rejects.toThrow("60 секунд"); await vi.advanceTimersByTimeAsync(responsePreparationTimeoutMilliseconds);
    await rejection; expect(LocalWorker.instances).toHaveLength(1); expect(LocalWorker.instances[0].terminated).toBe(1);
  });
  it("passes a worker failure without ever inventing prepared cards", async () => {
    const task = startResponsePreparation(request()); LocalWorker.instances[0].reply({ revision: 1, failed: "Некорректный JSON" });
    expect(await task.promise).toEqual({ revision: 1, failed: "Некорректный JSON" });
  });
  it("supports the pure non-browser regression path without changing the raw input", async () => {
    vi.stubGlobal("Worker", undefined); const input = request(), before = structuredClone(input);
    const reply = await startResponsePreparation(input).promise;
    expect(reply.prepared?.changes.some((change) => change.kind === "added")).toBe(true); expect(input).toEqual(before);
  });
  it("rejects an oversized snapshot before allocating a worker or cloning data, with the pure-parse reason", async () => {
    const input = request(); input.sources[0].name = "Контрольная форма XLSX"; input.sources[0].warnings = Array(5172).fill("Предупреждение");
    const before = structuredClone(input), expected = runResponsePreparation(input);
    expect(await startResponsePreparation(input).promise).toEqual(expected);
    expect(expected.failed).toContain("5172"); expect(expected.failed).toContain("Контрольная форма XLSX");
    expect(LocalWorker.instances).toHaveLength(0); expect(input).toEqual(before);
  });
});
