import { useCallback, useEffect, useRef, useState } from "react";
import { activityEvent, getActivities, type ActivityEntry } from "../../lib/activity";
import type { WorkspaceInfo } from "../../lib/storage";
import { readSharedBackupPolicy, type SharedBackupPolicySnapshot } from "../../lib/sharedWorkspace";
import { getWorkspaceHealth, type WorkspaceHealth } from "./health";
import "./status.css";

export function StatusCenter({ workspace, onSettings }: { workspace: WorkspaceInfo; onSettings: () => void }) {
  const [health, setHealth] = useState<WorkspaceHealth | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [activities, setActivities] = useState<ActivityEntry[]>(getActivities);
  const [policy, setPolicy] = useState<SharedBackupPolicySnapshot | null>(null);
  const [policyError, setPolicyError] = useState("");
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  const generation = useRef(0);
  const running = useRef(false);
  const refresh = useCallback(async () => {
    if (running.current) return;
    running.current = true; const token = generation.current; setLoading(true);
    try {
      const [next, backupPolicy] = await Promise.allSettled([getWorkspaceHealth(workspaceRef.current), readSharedBackupPolicy(workspace.root)]);
      if (token === generation.current) {
        if (next.status === "fulfilled" && next.value.root === workspace.root) { setHealth(next.value); setError(""); }
        else setError(next.status === "rejected" ? String(next.reason) : "Получено состояние другой рабочей папки. Повторите проверку.");
        if (backupPolicy.status === "fulfilled") { setPolicy(backupPolicy.value); setPolicyError(""); }
        else { setPolicy(null); setPolicyError(String(backupPolicy.reason)); }
      }
    }
    catch (reason) { if (token === generation.current) setError(String(reason)); }
    finally { if (token === generation.current) { running.current = false; setLoading(false); } }
  }, [workspace.root]);
  useEffect(() => { void refresh(); const timer = window.setInterval(() => void refresh(), 15_000); return () => { window.clearInterval(timer); generation.current++; running.current = false; }; }, [refresh]);
  useEffect(() => { const update = () => setActivities(getActivities()); window.addEventListener(activityEvent, update); return () => window.removeEventListener(activityEvent, update); }, []);
  const latest = health?.backup.latest;
  const editorUnknown = !health || Boolean(error) || health.issues.some((issue) => issue.code === "editor-state-unknown" || issue.code === "root-unavailable");
  const backupsUnknown = !health || Boolean(error) || health.issues.some((issue) => issue.code === "backup-list-unavailable" || issue.code === "root-unavailable" || issue.code === "preview");
  return <div className="module-stack status-center" data-workspace-viewer-allowed>
    <div className="status-toolbar"><p role="status">{loading ? "Проверяем состояние…" : health ? `Проверено: ${new Date(health.checkedAt).toLocaleString("ru")}` : "Нет результатов проверки"}</p><button type="button" className="secondary" disabled={loading} onClick={() => void refresh()}>Проверить сейчас</button><button type="button" className="secondary" onClick={onSettings}>Настройки и резервные копии</button></div>
    {error && <div className="notice error" role="alert"><strong>Свежая проверка не выполнена.</strong><span>{error}</span><span>Сведения ниже — последние полученные, не подтверждение текущего доступа.</span></div>}
    {health?.issues.map((issue) => <div key={issue.code} className={`notice ${issue.severity === "error" ? "error" : "warning"}`}>{issue.message}</div>)}
    <div className="status-grid">
      <section className="surface"><h2>Рабочая папка</h2><strong>{error ? "Состояние неизвестно" : health?.available ? "Доступна для чтения" : "Не подтверждено"}</strong><p className="status-path">{workspace.root}</p><p>Ответ папки: {health && !error ? `${health.readLatencyMs} мс` : "—"}</p><p className="help-text">Чтение проверяется без записи. Права записи: {health?.writable ? "ранее подтверждены ОС" : "не подтверждены"}. Это не тест записи и не гарантия доступности сети.</p></section>
      <section className="surface"><h2>Редактор общей базы</h2><strong>{editorUnknown ? loading && !health ? "Проверяем…" : "Состояние неизвестно" : health?.editor.ownedByThisInstance ? "Этот экземпляр приложения" : health?.editor.busy ? "Занято другим пользователем" : "Нет активного редактора"}</strong><p>{health?.editor.owner?.displayName || (health?.editor.busy ? "Пользователь не определён" : "—")}</p><p>{health?.editor.owner?.deviceName}</p>{health?.editor.owner?.startedAt && <p>Сессия с {new Date(health.editor.owner.startedAt).toLocaleString("ru")}</p>}<p className="help-text">{health?.editor.message || workspace.accessMessage}</p></section>
      <section className="surface"><h2>Последняя резервная копия</h2><strong>{latest?.fileName || (backupsUnknown ? loading && !health ? "Проверяем…" : "Состояние неизвестно" : "Копий не найдено")}</strong>{latest && <p>{new Date(latest.modifiedAt).toLocaleString("ru")} · {(latest.sizeBytes / 1024 / 1024).toFixed(1)} МБ · {latest.pinned === null ? "Закрепление неизвестно" : latest.pinned ? "Закреплена" : "Не закреплена"}</p>}<p className="help-text">{health?.backup.verification.message || "Состояние проверки неизвестно"}</p><p className="help-text">Наличие файла не означает успешную проверку его целостности. Запустите проверку в настройках резервных копий.</p></section>
    </div>
    <section className="surface"><h2>Автоматическое резервирование</h2>{policyError ? <div className="notice error" role="alert">Политику не удалось прочитать: {policyError}. Новые автокопии и автоматическая ротация приостанавливаются до восстановления доступа.</div> : policy ? <><strong>{policy.policy.backupHours > 0 ? `Каждые ${policy.policy.backupHours} ч` : "Выключено"}</strong><p>{policy.source === "shared" ? "Общая настройка папки — продолжает работать при смене компьютера редактора." : "Пока действует только локальная настройка этого компьютера. В настройках можно сохранить общую политику папки."}</p><p>Последнее успешное создание: {policy.policy.lastSuccessAt ? new Date(policy.policy.lastSuccessAt).toLocaleString("ru") : "не зафиксировано"}. Это не отметка проверки целостности.</p>{policy.policy.lastError && <div className="notice error" role="alert">Последняя ошибка: {policy.policy.lastError}</div>}</> : <p>Читаем политику…</p>}</section>
    <section className="surface"><h2>Операции этого сеанса</h2><p className="help-text">Журнал находится только в памяти этого экземпляра и очищается при смене рабочей папки или перезапуске. Это не общий журнал действий сотрудников.</p>{activities.length === 0 ? <p>Зафиксированных операций пока нет.</p> : <ol className="activity-list">{[...activities].reverse().map((entry) => <li key={entry.id}><span className={`status ${entry.status === "error" ? "danger" : entry.status === "success" ? "success" : "neutral"}`}>{entry.status === "running" ? "Выполняется" : entry.status === "success" ? "Завершено" : "Ошибка"}</span><div><strong>{entry.label}</strong><small>{new Date(entry.startedAt).toLocaleTimeString("ru")}</small>{entry.message && <p>{entry.message}</p>}</div></li>)}</ol>}</section>
  </div>;
}
