import type { StoredRecord } from "./storage";
import { networkAccessEvent, networkAccessIsPaused } from "./networkDiagnostics";

/** UI-only RAM snapshots. Fresh validation reads must continue using storage directly. */
export interface UiListData<T = unknown, D = unknown> {
  records: StoredRecord<T>[];
  directory?: D | null;
}
export interface UiListSnapshot<T = unknown, D = unknown> {
  data: UiListData<T, D> | null;
  loading: boolean;
  stale: boolean;
  error: string | null;
  updatedAt: number;
}
type Loader = () => Promise<UiListData>;
interface Entry {
  snapshot: UiListSnapshot;
  generation: number;
  flightGeneration: number;
  flight: Promise<UiListData | null> | null;
  loader?: Loader;
  listeners: Set<() => void>;
  refreshQueued: boolean;
}
export const uiListFreshnessMs = 30_000;
const entries = new Map<string, Entry>();
const mutations = new Map<string, number>();
let globalMutations = 0;
let workspaceRoot: string | null = null;
let accessSignature = "";
let paused = networkAccessIsPaused();
let eventTarget: Window | null = null;
let removeEvents: (() => void) | undefined;

function entryFor(module: string): Entry {
  installEvents();
  let entry = entries.get(module);
  if (!entry) {
    entry = { snapshot: { data: null, loading: false, stale: true, error: null, updatedAt: 0 }, generation: 0, flightGeneration: 0, flight: null, listeners: new Set(), refreshQueued: false };
    entries.set(module, entry);
  }
  return entry;
}
function notify(entry: Entry) { entry.listeners.forEach((listener) => listener()); }
function blocked(module: string) { return networkAccessIsPaused() || globalMutations > 0 || (mutations.get(module) || 0) > 0; }
function queueRefresh(module: string, entry: Entry) {
  if (entry.refreshQueued || !entry.listeners.size || !entry.loader || blocked(module)) return;
  entry.refreshQueued = true;
  // One event can invalidate several consumers. Refresh once after every
  // listener has observed the new epoch, never once per mounted component.
  void Promise.resolve().then(() => {
    entry.refreshQueued = false;
    if (entries.get(module) === entry && entry.listeners.size && entry.loader && !blocked(module)) void ensureUiListSnapshot(module, entry.loader);
  });
}
function invalidate(module: string | undefined, clear = false) {
  for (const [key, entry] of entries) {
    if (module !== undefined && key !== module) continue;
    entry.generation++;
    // A refresh invalidates the answer, not the native operation. Keep one
    // physical request in flight and coalesce a trailing refresh. A new root
    // must not remain stuck behind a request to the previous shared folder.
    if (clear) entry.flight = null;
    entry.snapshot = { ...entry.snapshot, ...(clear ? { data: null, updatedAt: 0 } : {}), loading: false, stale: true, error: null };
    notify(entry);
    queueRefresh(key, entry);
  }
}
export function invalidateUiLists(module?: string) { invalidate(module); }

export function setUiListWorkspace(workspace: { root: string; editor: boolean; writable: boolean; accessControlled: boolean; editorCleanupPending?: boolean }) {
  installEvents();
  const signature = JSON.stringify([workspace.editor, workspace.writable, workspace.accessControlled, Boolean(workspace.editorCleanupPending)]);
  const rootChanged = workspaceRoot !== workspace.root;
  const accessChanged = signature !== accessSignature;
  workspaceRoot = workspace.root;
  accessSignature = signature;
  if (rootChanged || accessChanged) invalidate(undefined, rootChanged);
}

function installEvents() {
  if (typeof window === "undefined" || eventTarget === window) return;
  removeEvents?.();
  eventTarget = window;
  paused = networkAccessIsPaused();
  const target = window;
  const refresh = () => invalidateUiLists();
  const status = (event: Event) => {
    const workspace = (event as CustomEvent<Parameters<typeof setUiListWorkspace>[0]>).detail;
    if (workspace?.root) setUiListWorkspace(workspace);
  };
  const network = () => {
    const next = networkAccessIsPaused();
    if (next === paused) return;
    paused = next;
    invalidateUiLists();
  };
  target.addEventListener("sbk-workspace-refresh", refresh);
  target.addEventListener("sbk-workspace-access-invalidated", refresh);
  target.addEventListener("sbk-workspace-access-status", status);
  target.addEventListener(networkAccessEvent, network);
  removeEvents = () => {
    target.removeEventListener("sbk-workspace-refresh", refresh);
    target.removeEventListener("sbk-workspace-access-invalidated", refresh);
    target.removeEventListener("sbk-workspace-access-status", status);
    target.removeEventListener(networkAccessEvent, network);
  };
}

export function getUiListSnapshot<T = unknown, D = unknown>(module: string): UiListSnapshot<T, D> {
  const entry = entryFor(module);
  if (entry.snapshot.data && !entry.snapshot.stale && Date.now() - entry.snapshot.updatedAt >= uiListFreshnessMs) entry.snapshot = { ...entry.snapshot, stale: true };
  return entry.snapshot as UiListSnapshot<T, D>;
}

export function ensureUiListSnapshot<T = unknown, D = unknown>(module: string, loader: () => Promise<UiListData<T, D>>, force = false): Promise<UiListData<T, D> | null> {
  const entry = entryFor(module);
  entry.loader = loader as Loader;
  if (blocked(module)) return Promise.resolve(entry.snapshot.data as UiListData<T, D> | null);
  if (entry.flight) {
    if (entry.flightGeneration === entry.generation) return entry.flight as Promise<UiListData<T, D> | null>;
    return entry.flight.then(() => ensureUiListSnapshot(module, loader));
  }
  const snapshot = getUiListSnapshot<T, D>(module);
  if (!force && snapshot.data && !snapshot.stale) return Promise.resolve(snapshot.data);
  const generation = ++entry.generation;
  entry.flightGeneration = generation;
  entry.snapshot = { ...entry.snapshot, loading: true, stale: Boolean(entry.snapshot.data), error: null };
  const flight = Promise.resolve().then(loader).then((data) => {
    if (entries.get(module) === entry && generation === entry.generation && !blocked(module)) {
      entry.snapshot = { data: data as UiListData, loading: false, stale: false, error: null, updatedAt: Date.now() };
    }
    return entry.snapshot.data as UiListData<T, D> | null;
  }, (reason: unknown) => {
    if (entries.get(module) === entry && generation === entry.generation && !blocked(module)) entry.snapshot = { ...entry.snapshot, loading: false, stale: true, error: String(reason) };
    return entry.snapshot.data as UiListData<T, D> | null;
  }).finally(() => {
    if (entries.get(module) === entry && entry.flight === flight) {
      entry.flight = null;
      notify(entry);
      if (generation !== entry.generation) queueRefresh(module, entry);
    }
  });
  entry.flight = flight as Promise<UiListData | null>;
  notify(entry);
  return flight;
}

export function subscribeUiListSnapshot<T = unknown, D = unknown>(module: string, loader: () => Promise<UiListData<T, D>>, listener: () => void): () => void {
  const entry = entryFor(module);
  entry.loader = loader as Loader;
  entry.listeners.add(listener);
  void ensureUiListSnapshot(module, loader);
  return () => { entry.listeners.delete(listener); };
}

/** Prevent a pre-write request from populating RAM, and do not race a fresh read against the write. */
export function beginUiListMutation(module?: string): () => void {
  if (module === undefined) globalMutations++;
  else mutations.set(module, (mutations.get(module) || 0) + 1);
  invalidateUiLists(module);
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    if (module === undefined) globalMutations--;
    else mutations.set(module, Math.max(0, (mutations.get(module) || 0) - 1));
    invalidateUiLists(module);
  };
}

export function resetUiListCacheForTests() {
  removeEvents?.(); removeEvents = undefined; eventTarget = null;
  entries.clear(); mutations.clear(); globalMutations = 0; workspaceRoot = null; accessSignature = "";
  paused = networkAccessIsPaused();
}
