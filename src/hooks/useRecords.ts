import { useCallback, useEffect, useState } from "react";
import { networkAccessIsPaused } from "../lib/networkDiagnostics";
import { ensureUiListSnapshot, getUiListSnapshot, subscribeUiListSnapshot, type UiListData } from "../lib/uiListCache";
import {
  archiveRecord,
  archiveRecords,
  listRecords,
  readContractWorkspace,
  saveRecord,
  type ModuleId,
  type StoredRecord,
} from "../lib/storage";
const emptyRecords: StoredRecord<never>[] = [];

/** Only displayed lists use RAM snapshots. Storage validation reads remain fresh. */
export function useUiListSnapshot<T, D = unknown>(module: ModuleId) {
  const loader = useCallback(async (): Promise<UiListData<T, D>> => module === "contract-experience"
    ? readContractWorkspace<T, D>()
    : { records: await listRecords<T>(module) }, [module]);
  const [current, setCurrent] = useState(() => ({ module, snapshot: getUiListSnapshot<T, D>(module) }));
  const snapshot = current.module === module ? current.snapshot : getUiListSnapshot<T, D>(module);
  useEffect(() => {
    const update = () => setCurrent({ module, snapshot: getUiListSnapshot<T, D>(module) });
    const unsubscribe = subscribeUiListSnapshot(module, loader, update);
    update();
    return unsubscribe;
  }, [module, loader]);
  const reload = useCallback(async () => { await ensureUiListSnapshot(module, loader, true); }, [module, loader]);
  const cached = snapshot.data !== null;
  const refreshing = cached && snapshot.loading;
  const cacheNotice = !cached ? "" : snapshot.stale || networkAccessIsPaused()
    ? refreshing ? "Обновляем данные; показан предыдущий снимок." : "Показан последний снимок; данные могут быть неактуальны."
    : `Снимок данных: ${new Date(snapshot.updatedAt).toLocaleTimeString("ru-RU")}`;
  return { ...snapshot, loading: !cached && !snapshot.error && !networkAccessIsPaused(), refreshing, cacheNotice, reload };
}

export function useRecords<T>(module: ModuleId) {
  const snapshot = useUiListSnapshot<T>(module);
  const save = useCallback(async (title: string, payload: T, id?: string) => saveRecord(module, title, payload, id), [module]);
  const archive = useCallback(async (id: string) => { await archiveRecord(module, id, true); }, [module]);
  const archiveMany = useCallback(async (ids: string[]) => { await archiveRecords(module, ids, true); }, [module]);
  return { records: snapshot.data?.records || emptyRecords, loading: snapshot.loading, refreshing: snapshot.refreshing, stale: snapshot.stale,
    error: snapshot.error, cacheNotice: snapshot.cacheNotice, reload: snapshot.reload, save, archive, archiveMany };
}
