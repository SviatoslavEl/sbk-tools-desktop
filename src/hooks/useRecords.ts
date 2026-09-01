import { useCallback, useEffect, useRef, useState } from "react";
import {
  archiveRecord,
  archiveRecords,
  listRecords,
  saveRecord,
  type ModuleId,
  type StoredRecord,
} from "../lib/storage";

export function useRecords<T>(module: ModuleId) {
  const [records, setRecords] = useState<StoredRecord<T>[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  const reload = useCallback(async () => {
    const currentGeneration = ++generation.current;
    setLoading(true);
    try {
      const next = await listRecords<T>(module);
      if (currentGeneration === generation.current) {
        setRecords(next);
        setError(null);
      }
    } catch (reason) {
      if (currentGeneration === generation.current) setError(String(reason));
    } finally {
      if (currentGeneration === generation.current) setLoading(false);
    }
  }, [module]);

  useEffect(() => {
    void reload();
    const refresh = () => void reload();
    window.addEventListener("sbk-workspace-refresh", refresh);
    return () => window.removeEventListener("sbk-workspace-refresh", refresh);
  }, [reload]);

  const save = useCallback(async (title: string, payload: T, id?: string) => {
    const saved = await saveRecord(module, title, payload, id);
    setRecords((current) => [saved, ...current.filter((record) => record.id !== saved.id)]);
    return saved;
  }, [module]);

  const archive = useCallback(async (id: string) => {
    await archiveRecord(module, id, true);
    setRecords((current) => current.filter((record) => record.id !== id));
  }, [module]);

  const archiveMany = useCallback(async (ids: string[]) => {
    await archiveRecords(module, ids, true);
    const selected = new Set(ids);
    setRecords((current) => current.filter((record) => !selected.has(record.id)));
  }, [module]);

  return { records, loading, error, reload, save, archive, archiveMany };
}
