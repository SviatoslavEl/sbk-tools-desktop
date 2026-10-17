import { useCallback, useEffect, useRef, useState } from "react";
import { activityEvent, getActivities, type ActivityEntry } from "../../lib/activity";
import type { WorkspaceInfo } from "../../lib/storage";
import { readSharedBackupPolicy, type SharedBackupPolicySnapshot } from "../../lib/sharedWorkspace";
import { getWorkspaceHealth, type WorkspaceHealth } from "./health";
import { networkAccessIsPaused, useNetworkAccess } from "../../lib/networkDiagnostics";
import { editorStatus } from "../../lib/editorStatus";
import "./status.css";

export function StatusCenter({ workspace, onSettings }: { workspace: WorkspaceInfo; onSettings: () => void }) {
  const network = useNetworkAccess();
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
    if (running.current || networkAccessIsPaused()) return;
    running.current = true; const token = generation.current; setLoading(true);
    try {
      const [next, backupPolicy] = await Promise.allSettled([getWorkspaceHealth(workspaceRef.current), readSharedBackupPolicy(workspace.root)]);
      if (token === generation.current && !networkAccessIsPaused()) {
        if (next.status === "fulfilled" && next.value.root === workspace.root) { setHealth(next.value); setError(""); }
        else setError(next.status === "rejected" ? String(next.reason) : "Получено состояние другой рабочей папки. Повторите проверку.");
        if (backupPolicy.status === "fulfilled") { setPolicy(backupPolicy.value); setPolicyError(""); }
        else { setPolicy(null); setPolicyError(String(backupPolicy.reason)); }
      }
    }
    catch (reason) { if (token === generation.current) setError(String(reason)); }
    finally { if (token === generation.current) { running.current = false; setLoading(false); } }
  }, [workspace.root]);
  useEffect(() => { if (network.phase !== "connected") { setLoading(false); return; } void refresh(); const timer = window.setInterval(() => void refresh(), 15_000); return () => { window.clearInterval(timer); generation.current++; running.current = false; }; }, [refresh, network.phase]);
  useEffect(() => { const update = () => setActivities(getActivities()); window.addEventListener(activityEvent, update); return () => window.removeEventListener(activityEvent, update); }, []);
  const latest = health?.backup.latest;
  const editorUnknown = network.phase !== "connected" || !health || Boolean(error) || health.issues.some((issue) => issue.code === "editor-state-unknown" || issue.code === "root-unavailable");
  const editor = editorStatus(health ? { editor: health.editor.ownedByThisInstance, editorBusy: health.editor.busy, editorOwner: health.editor.owner ?? undefined, editorStateMessage: editorUnknown ? "Состояние неизвестно" : health.editor.message, writable: health.writable } : null);
  const backupsUnknown = network.phase !== "connected" || !health || Boolean(error) || health.issues.some((issue) => issue.code === "backup-list-unavailable" || issue.code === "root-unavailable" || issue.code === "preview");
  const folderUnknown = network.phase !== "connected" || !health || Boolean(error);
  const owner = health?.editor.owner;
  const ownerLabel = owner?.displayName?.trim() || owner?.userName?.trim() || (health?.editor.busy ? "Пользователь не определён" : "");
  const deviceLabel = !editor.device || !ownerLabel.toLocaleLowerCase().includes(editor.device.toLocaleLowerCase()) ? editor.deviceLabel : "";
  const sessionErrors = activities.filter((entry) => entry.status === "error").length;
  const sessionRunning = activities.filter((entry) => entry.status === "running").length;
  return <div className="module-stack status-center" data-workspace-viewer-allowed>
    <div className="status-toolbar"><p role="status">{network.phase !== "connected" ? "Связь с общей папкой приостановлена" : loading ? "Проверяем состояние…" : health ? `Проверено: ${new Date(health.checkedAt).toLocaleString("ru")}` : "Нет результатов проверки"}</p><button type="button" className="secondary" disabled={loading || network.phase !== "connected"} onClick={() => void refresh()}>Проверить сейчас</button><button type="button" className="secondary" onClick={onSettings}>Настройки и резервные копии</button></div>
    {error && <div className="notice error" role="alert"><strong>Свежая проверка не выполнена.</strong><span>{error}</span><span>Сведения ниже — последние полученные, не подтверждение текущего доступа.</span></div>}
    {health?.issues.map((issue) => <div key={issue.code} className={`notice ${issue.severity === "error" ? "error" : "warning"}`}>{issue.message}</div>)}
    <div className="status-grid">
      <section className="surface"><h2>Рабочая папка</h2><strong>{folderUnknown ? "Состояние неизвестно" : health.available ? "Доступна для чтения" : "Доступ не подтверждён"}</strong><p className="status-next-step">{folderUnknown || !health?.available ? "Проверьте связь с папкой в настройках." : "Можно просматривать последние полученные данные."}</p><details><summary>Путь и проверка доступа</summary><p className="status-path">{workspace.root}</p><p>Ответ папки: {!folderUnknown ? `${health.readLatencyMs} мс` : "—"}</p><p className="help-text">Чтение проверяется без записи. Права записи: {health?.writable ? "ранее подтверждены ОС" : "не подтверждены"}. Это не тест записи и не гарантия доступности сети.</p></details></section>
      <section className="surface"><h2>Редактирование базы</h2><strong>{editorUnknown ? loading && !health ? "Проверяем…" : "Состояние неизвестно" : editor.label}</strong>{!editorUnknown && ownerLabel && <p className="status-owner">{ownerLabel}</p>}<p className="status-next-step">{editorUnknown ? "Обновите проверку перед сменой режима." : health?.editor.ownedByThisInstance ? "Изменения доступны в этом экземпляре." : health?.editor.busy ? "Для изменений обратитесь к текущему редактору." : "Включить режим редактора можно в настройках."}</p>{editor.detail && <p className="help-text">{editor.detail}</p>}<details><summary>Сведения о сеансе</summary>{editorUnknown && ownerLabel && <p>Последняя полученная запись: {ownerLabel}</p>}{deviceLabel && <p>{deviceLabel}</p>}{owner?.startedAt && <p>Сеанс с {new Date(owner.startedAt).toLocaleString("ru")}</p>}<p className="help-text">{health?.editor.message || workspace.accessMessage}</p></details></section>
      <section className="surface"><h2>Резервная копия</h2><strong>{backupsUnknown ? loading && !health ? "Проверяем…" : "Состояние неизвестно" : latest ? `Создана ${new Date(latest.modifiedAt).toLocaleString("ru")}` : "Копий не найдено"}</strong><p className="status-next-step">{backupsUnknown ? "Обновите проверку, чтобы узнать состояние копий." : latest ? "Целостность не подтверждена. Проверьте копию в настройках." : "Создайте резервную копию в настройках."}</p><details><summary>Файл и ограничения проверки</summary>{latest && <><p className="status-path">{latest.fileName}</p><p>{(latest.sizeBytes / 1024 / 1024).toFixed(1)} МБ · {latest.pinned === null ? "Закрепление неизвестно" : latest.pinned ? "Закреплена" : "Не закреплена"}</p></>}<p className="help-text">{health?.backup.verification.message || "Состояние проверки неизвестно"}</p></details></section>
    </div>
    <section className="surface status-backup-policy"><h2>Автоматическое резервирование</h2>{policyError ? <div className="notice error" role="alert">Политику не удалось прочитать: {policyError}. Новые автокопии и автоматическая ротация приостанавливаются до восстановления доступа.</div> : policy ? <><strong>{network.phase !== "connected" ? "Приостановлено до восстановления связи" : policy.policy.backupHours > 0 ? `Каждые ${policy.policy.backupHours} ч` : "Выключено"}</strong><p>Последнее успешное создание: {policy.policy.lastSuccessAt ? new Date(policy.policy.lastSuccessAt).toLocaleString("ru") : "не зафиксировано"}.</p>{policy.policy.lastError && <div className="notice error" role="alert">Последняя ошибка: {policy.policy.lastError}</div>}<details><summary>{policy.source === "shared" ? "Общая политика папки" : "Только локальная настройка"}</summary><p className="help-text">{policy.source === "shared" ? "Настройка сохраняется в общей папке и используется при смене компьютера редактора." : "В настройках можно сохранить общую политику папки."} Изменить частоту и хранение копий можно в настройках резервирования.</p></details></> : <p>{network.phase !== "connected" ? "Общая политика недоступна до восстановления связи." : "Читаем политику…"}</p>}</section>
    <section className="surface"><h2>Операции этого сеанса</h2><p>{sessionRunning ? `Выполняется: ${sessionRunning} · ` : ""}{sessionErrors ? `Ошибок: ${sessionErrors}` : activities.length ? "Ошибок не зафиксировано" : "Зафиксированных операций пока нет."}</p>{activities.length > 0 && <ol className="activity-list">{[...activities].reverse().map((entry) => <li key={entry.id}><span className={`status ${entry.status === "error" ? "danger" : entry.status === "success" ? "success" : "neutral"}`}>{entry.status === "running" ? "Выполняется" : entry.status === "success" ? "Завершено" : "Ошибка"}</span><div><strong>{entry.label}</strong><small>{new Date(entry.startedAt).toLocaleTimeString("ru")}</small>{entry.message && <p>{entry.message}</p>}</div></li>)}</ol>}<details><summary>О журнале операций</summary><p className="help-text">Журнал находится только в памяти этого экземпляра и очищается при смене рабочей папки или перезапуске. Это не общий журнал действий сотрудников.</p></details></section>
  </div>;
}
