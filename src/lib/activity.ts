export interface ActivityEntry {
  id: string; label: string; startedAt: string; finishedAt?: string;
  status: "running" | "success" | "error"; message?: string;
}
export const activityEvent = "sbk-activity-changed";
let entries: ActivityEntry[] = [];
let generation = 0;
const notify = () => { if (typeof window !== "undefined") window.dispatchEvent?.(new Event(activityEvent)); };
export const getActivities = () => entries;
export function clearActivities() { generation++; entries = []; notify(); }
export function startActivity(label: string): (error?: unknown) => void {
  const epoch = generation;
  const entry: ActivityEntry = { id: crypto.randomUUID(), label, startedAt: new Date().toISOString(), status: "running" };
  entries = [...entries.filter((item) => item.status === "running"), ...entries.filter((item) => item.status !== "running").slice(-29), entry];
  notify();
  return (error) => {
    if (epoch !== generation) return;
    entries = entries.map((item) => item.id === entry.id ? { ...item, status: error === undefined ? "success" : "error", finishedAt: new Date().toISOString(), message: error === undefined ? undefined : String(error) } : item);
    notify();
  };
}
export async function trackedOperation<T>(label: string, action: () => Promise<T>): Promise<T> {
  const finish = startActivity(label);
  try { const result = await action(); finish(); return result; }
  catch (error) { finish(error); throw error; }
}
