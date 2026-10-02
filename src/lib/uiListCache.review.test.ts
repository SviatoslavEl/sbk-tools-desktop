import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginUiListMutation,
  ensureUiListSnapshot,
  getUiListSnapshot,
  invalidateUiLists,
  resetUiListCacheForTests,
  setUiListWorkspace,
  subscribeUiListSnapshot,
  type UiListData,
} from "./uiListCache";

const network = vi.hoisted(() => ({ paused: false }));
vi.mock("./networkDiagnostics", () => ({
  networkAccessEvent: "sbk-network-access-changed",
  networkAccessIsPaused: () => network.paused,
}));

type Data = UiListData<{ value: string }, { revision: string }>;
const module = "contract-experience";
const workspace = (root = "synthetic-share-A", editor = true) => ({
  root, editor, writable: true, accessControlled: true, editorCleanupPending: false,
});
function data(value: string): Data {
  return {
    records: [{ id: value, title: value, payload: { value }, archived: false,
      createdAt: "2026-10-02T10:00:00Z", updatedAt: "2026-10-02T10:00:00Z" }],
    directory: { revision: value },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}
const flush = async () => { for (let index = 0; index < 16; index++) await Promise.resolve(); };
const ids = () => getUiListSnapshot(module).data?.records.map((record) => record.id);
const changeNetwork = (paused: boolean) => {
  network.paused = paused;
  window.dispatchEvent(new Event("sbk-network-access-changed"));
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-02T10:00:00Z"));
  network.paused = false;
  const events = new EventTarget();
  vi.stubGlobal("window", {
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
  });
  resetUiListCacheForTests();
  setUiListWorkspace(workspace());
});
afterEach(() => {
  resetUiListCacheForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("independent delayed shared-folder UI cache regressions", () => {
  it("joins three 2500ms consumers and reuses one confirmed snapshot on remount", async () => {
    const loader = vi.fn(() => new Promise<Data>((resolve) => setTimeout(() => resolve(data("first")), 2500)));
    const listeners = [vi.fn(), vi.fn(), vi.fn()];
    const disposers = listeners.map((listener) => subscribeUiListSnapshot(module, loader, listener));
    const waiter = ensureUiListSnapshot(module, loader);
    await flush();
    expect(loader).toHaveBeenCalledTimes(1);
    expect(getUiListSnapshot(module)).toMatchObject({ data: null, loading: true });
    await vi.advanceTimersByTimeAsync(2499);
    expect(ids()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(await waiter).toEqual(data("first"));
    expect(getUiListSnapshot(module)).toMatchObject({ data: data("first"), loading: false, stale: false });
    disposers.forEach((dispose) => dispose());
    const remount = subscribeUiListSnapshot(module, loader, vi.fn());
    await flush();
    expect(ids()).toEqual(["first"]);
    expect(loader).toHaveBeenCalledTimes(1);
    remount();
  });

  it("coalesces refresh storms during slow I/O into one trailing fresh request", async () => {
    const old = deferred<Data>();
    const fresh = deferred<Data>();
    const loader = vi.fn<() => Promise<Data>>()
      .mockImplementationOnce(() => old.promise)
      .mockImplementation(() => fresh.promise);
    const observed: string[] = [];
    const dispose = subscribeUiListSnapshot(module, loader, () => { observed.push(...(ids() || [])); });
    await flush();
    for (let i = 0; i < 5; i++) {
      window.dispatchEvent(new Event("sbk-workspace-refresh"));
      await flush();
    }
    expect(loader).toHaveBeenCalledTimes(1);
    old.resolve(data("obsolete"));
    await flush();
    expect(observed).not.toContain("obsolete");
    expect(loader).toHaveBeenCalledTimes(2);
    fresh.resolve(data("fresh"));
    await flush();
    expect(ids()).toEqual(["fresh"]);
    expect(loader).toHaveBeenCalledTimes(2);
    dispose();
  });

  it("keeps writes exclusive from UI reload and discards pre-mutation late replies", async () => {
    const oldRead = deferred<Data>();
    const newRead = deferred<Data>();
    const loader = vi.fn<() => Promise<Data>>()
      .mockResolvedValueOnce(data("seed"))
      .mockImplementationOnce(() => oldRead.promise)
      .mockImplementation(() => newRead.promise);
    const dispose = subscribeUiListSnapshot(module, loader, vi.fn());
    await flush();
    expect(ids()).toEqual(["seed"]);
    void ensureUiListSnapshot(module, loader, true);
    await flush();
    const endWrite = beginUiListMutation(module);
    for (let i = 0; i < 3; i++) void ensureUiListSnapshot(module, loader, true);
    await flush();
    expect(loader).toHaveBeenCalledTimes(2);
    oldRead.resolve(data("pre-write"));
    await flush();
    expect(ids()).toEqual(["seed"]);
    expect(getUiListSnapshot(module).stale).toBe(true);
    expect(loader).toHaveBeenCalledTimes(2);
    endWrite();
    endWrite(); // Ending an operation twice cannot underflow the mutation guard.
    await flush();
    expect(loader).toHaveBeenCalledTimes(3);
    newRead.resolve(data("post-write"));
    await flush();
    expect(ids()).toEqual(["post-write"]);
    dispose();
  });

  it("does not mix data during workspace A to B to A or accept a late old-A response", async () => {
    const oldA = deferred<Data>();
    const loadOldA = vi.fn(() => oldA.promise);
    const first = ensureUiListSnapshot(module, loadOldA);
    await flush();
    setUiListWorkspace(workspace("synthetic-share-B"));
    const loadB = vi.fn(async () => data("B"));
    await ensureUiListSnapshot(module, loadB);
    expect(ids()).toEqual(["B"]);
    setUiListWorkspace(workspace());
    expect(getUiListSnapshot(module).data).toBeNull();
    const loadNewA = vi.fn(async () => data("new-A"));
    await ensureUiListSnapshot(module, loadNewA);
    oldA.resolve(data("old-A"));
    await first;
    await flush();
    expect(ids()).toEqual(["new-A"]);
    expect(getUiListSnapshot<Data>(module).data?.directory).toEqual({ revision: "new-A" });
    expect(loadOldA).toHaveBeenCalledTimes(1);
    expect(loadB).toHaveBeenCalledTimes(1);
    expect(loadNewA).toHaveBeenCalledTimes(1);
  });

  it("retains labelled stale rows while paused, ignores late replies and refreshes after reconnect", async () => {
    const pending = deferred<Data>();
    const loader = vi.fn<() => Promise<Data>>()
      .mockResolvedValueOnce(data("seed"))
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValue(data("after-reconnect"));
    const dispose = subscribeUiListSnapshot(module, loader, vi.fn());
    await flush();
    void ensureUiListSnapshot(module, loader, true);
    await flush();
    changeNetwork(true);
    setUiListWorkspace(workspace("synthetic-share-A", false));
    pending.resolve(data("late-while-paused"));
    await flush();
    await ensureUiListSnapshot(module, loader, true);
    expect(loader).toHaveBeenCalledTimes(2);
    expect(ids()).toEqual(["seed"]);
    expect(getUiListSnapshot(module).stale).toBe(true);
    changeNetwork(false);
    // Real reconnect also emits a workspace-refresh; both must deduplicate.
    window.dispatchEvent(new Event("sbk-workspace-refresh"));
    await flush();
    expect(loader).toHaveBeenCalledTimes(3);
    expect(ids()).toEqual(["after-reconnect"]);
    for (let i = 0; i < 10; i++) {
      changeNetwork(false);
      setUiListWorkspace(workspace("synthetic-share-A", false));
      await flush();
    }
    expect(loader).toHaveBeenCalledTimes(3);
    dispose();
  });

  it("rejects a pre-demotion response without treating unchanged status polls as invalidation", async () => {
    const pending = deferred<Data>();
    const loader = vi.fn<() => Promise<Data>>()
      .mockResolvedValueOnce(data("seed"))
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValue(data("read-only-refresh"));
    const observed: string[] = [];
    const dispose = subscribeUiListSnapshot(module, loader, () => { observed.push(...(ids() || [])); });
    await flush();
    for (let i = 0; i < 5; i++) setUiListWorkspace(workspace());
    await flush();
    expect(loader).toHaveBeenCalledTimes(1);
    void ensureUiListSnapshot(module, loader, true);
    await flush();
    setUiListWorkspace(workspace("synthetic-share-A", false));
    pending.resolve(data("before-demotion"));
    await flush();
    expect(observed).not.toContain("before-demotion");
    expect(ids()).toEqual(["read-only-refresh"]);
    expect(loader).toHaveBeenCalledTimes(3);
    dispose();
  });

  it("respects TTL and manual refresh without turning cached rows into validation reads", async () => {
    const loader = vi.fn(async () => data("snapshot"));
    await ensureUiListSnapshot(module, loader);
    await vi.advanceTimersByTimeAsync(29_999);
    await ensureUiListSnapshot(module, loader);
    expect(loader).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(getUiListSnapshot(module).stale).toBe(true);
    await ensureUiListSnapshot(module, loader);
    expect(loader).toHaveBeenCalledTimes(2);
    await ensureUiListSnapshot(module, loader, true);
    expect(loader).toHaveBeenCalledTimes(3);
    invalidateUiLists("staff");
    await ensureUiListSnapshot(module, loader);
    expect(loader).toHaveBeenCalledTimes(3);
  });

  it("retains the last snapshot on refresh failure without publishing a fresh timestamp", async () => {
    const failure = deferred<Data>();
    const loader = vi.fn<() => Promise<Data>>()
      .mockResolvedValueOnce(data("seed"))
      .mockImplementationOnce(() => failure.promise)
      .mockResolvedValue(data("recovered"));
    await ensureUiListSnapshot(module, loader);
    const confirmedAt = getUiListSnapshot(module).updatedAt;
    await vi.advanceTimersByTimeAsync(2500);
    const refresh = ensureUiListSnapshot(module, loader, true);
    await flush();
    failure.reject(new Error("Synthetic SMB temporarily unavailable"));
    await refresh;
    expect(getUiListSnapshot(module)).toMatchObject({ data: data("seed"), stale: true, updatedAt: confirmedAt });
    expect(getUiListSnapshot(module).error).toContain("temporarily unavailable");
    await ensureUiListSnapshot(module, loader, true);
    expect(ids()).toEqual(["recovered"]);
    expect(getUiListSnapshot(module).updatedAt).toBeGreaterThan(confirmedAt);
  });
});
