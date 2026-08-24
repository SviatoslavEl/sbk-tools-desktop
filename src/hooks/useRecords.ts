import { useCallback, useEffect, useState } from "react";
import {
  archiveRecord,
  listRecords,
  saveRecord,
  type ModuleId,
  type StoredRecord,
} from "../lib/storage";

export function useRecords<T>(module: ModuleId) {
  const [records, setRecords] = useState<StoredRecord<T>[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setRecords(await listRecords<T>(module));
      setError(null);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setLoading(false);
    }
  }, [module]);

  useEffect(() => {
    void reload();
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

  return { records, loading, error, reload, save, archive };
}
