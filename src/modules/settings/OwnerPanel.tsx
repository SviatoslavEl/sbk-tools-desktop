import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ConfirmDialog } from "../../components/Dialog";
import type { WorkspaceInfo } from "../../lib/storage";

interface OwnerInfo {
  editor?: { token: string; owner: NonNullable<WorkspaceInfo["editorOwner"]> };
  events: Array<{ id: number; createdAt: string; actor: string; action: string; reason: string }>;
}
const actionLabels: Record<string, string> = { "owner-setup": "Настройка владельца", "revoke-requested": "Запрошен отзыв редактора", "release-requested": "Просьба освободить редактора" };

export function OwnerPanel({ workspace }: { workspace: WorkspaceInfo | null }) {
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [workspacePassword, setWorkspacePassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [info, setInfo] = useState<OwnerInfo | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState<OwnerInfo["editor"]>();
  const [revokePassword, setRevokePassword] = useState("");
  const [authenticatedAt, setAuthenticatedAt] = useState(0);
  const logout = () => { setPassword(""); setRevokePassword(""); setInfo(null); setPending(undefined); setAuthenticatedAt(0); };
  useEffect(() => {
    if (!authenticatedAt) return;
    const timer = window.setTimeout(() => { logout(); setMessage("Вход владельца завершён через 10 минут. Войдите снова."); }, Math.max(0, authenticatedAt + 600_000 - Date.now()));
    return () => window.clearTimeout(timer);
  }, [authenticatedAt]);
  useEffect(() => {
    if (!authenticatedAt || !password) return;
    let cancelled = false;
    void invoke<OwnerInfo>("workspace_owner_info", { password })
      .then((value) => { if (!cancelled) setInfo(value); })
      .catch((error) => { if (!cancelled) { logout(); setMessage(String(error)); } });
    return () => { cancelled = true; };
  }, [workspace?.editorOwner?.startedAt, authenticatedAt, password]);
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setMessage("");
    try { await action(); } catch (error) { setMessage(String(error)); }
    finally { setBusy(false); }
  };
  const login = () => run(async () => {
    setInfo(await invoke<OwnerInfo>("workspace_owner_info", { password }));
    setAuthenticatedAt(Date.now());
  });
  const setup = () => run(async () => {
    if (password !== repeat) throw new Error("Пароли владельца не совпадают");
    await invoke("setup_workspace_owner", { password, workspacePassword, confirmation });
    setPassword(""); setRepeat(""); setWorkspacePassword(""); setConfirmation("");
    setMessage("Владелец настроен. Сохраните пароль в своём менеджере паролей. Теперь войдите в панель.");
    window.dispatchEvent(new Event("sbk-workspace-refresh"));
  });
  const request = () => run(async () => {
    await invoke("request_editor_release", { password: null, targetToken: "", reason, revoke: false });
    setMessage("Просьба отправлена текущему редактору. Его права не изменены.");
  });
  const revoke = () => {
    const target = pending;
    setPending(undefined);
    if (!target) return;
    void run(async () => {
      try {
        await invoke("request_editor_release", { password: revokePassword, targetToken: target.token, reason, revoke: true });
        setMessage("Запрос отзыва записан. Дождитесь освобождения редактора и обновите список. Старые версии не поддерживают отзыв; их потребуется закрыть обычным способом.");
        window.dispatchEvent(new Event("sbk-workspace-refresh"));
      } finally { setRevokePassword(""); }
    });
  };
  const validReason = reason.trim().length >= 3 && reason.trim().length <= 500;
  return <section className="surface owner-panel" data-workspace-viewer-allowed aria-label="Администрирование сетевой папки">
    <h2>Администрирование сетевой папки</h2>
    <p className="help-text">Режим доверенной команды без сервера. Защита действует внутри приложения: сотрудник с прямыми правами записи в файлы может изменить данные вне программы. Владелец не получает системных прав администратора. Для совместного использования обновите все рабочие места.</p>
    {message && <div className="notice" role="status">{message}</div>}
    {!workspace?.ownerConfigured ? <div className="settings-form">
      <p>Первичную настройку выполняет владелец, находясь в режиме редактора. Повторно назначить владельца этим способом нельзя.</p>
      <label>Новый пароль владельца<input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
      <small>12–128 символов, без управляющих символов и пробелов по краям. Выберите уникальную длинную фразу; встроенного пароля нет.</small>
      <label>Повторите пароль владельца<input type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} /></label>
      {workspace?.accessControlled && <label>Текущий пароль рабочей папки<input type="password" autoComplete="current-password" value={workspacePassword} onChange={(e) => setWorkspacePassword(e.target.value)} /></label>}
      <label>Подтверждение: введите НАЗНАЧИТЬ ВЛАДЕЛЬЦА<input value={confirmation} onChange={(e) => setConfirmation(e.target.value)} /></label>
      <button type="button" className="primary" disabled={busy || !workspace?.editor || confirmation !== "НАЗНАЧИТЬ ВЛАДЕЛЬЦА" || !password || password !== repeat} onClick={() => void setup()}>Настроить владельца</button>
    </div> : <>
      {!info ? <div className="settings-form"><label>Пароль владельца<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label><button type="button" className="primary" disabled={busy || !password} onClick={() => void login()}>Войти как владелец</button></div> : <>
        <p>Вход владельца активен до {new Date(authenticatedAt + 600_000).toLocaleTimeString("ru-RU")}. Закрытие настроек завершает вход.</p>
        <div className="button-row"><button type="button" className="secondary" disabled={busy} onClick={() => void login()}>Обновить редактора и журнал</button><button type="button" className="secondary" onClick={logout}>Выйти из панели владельца</button></div>
        <p>{info.editor ? `Текущий редактор: ${info.editor.owner.displayName}. Вход: ${new Date(info.editor.owner.startedAt).toLocaleString("ru-RU")}` : "Редактор свободен. Для работы войдите в обычный режим редактирования выше."}</p>
        <label>Повторите пароль владельца для отзыва<input type="password" autoComplete="current-password" value={revokePassword} onChange={(e) => setRevokePassword(e.target.value)} /></label>
      </>}
      <label>Причина запроса / отзыва<textarea rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="От 3 до 500 символов" /></label>
      <div className="button-row">
        <button type="button" className="secondary" disabled={busy || !workspace?.editorOwner || !validReason || !workspace.writable} onClick={() => void request()}>Попросить освободить редактора</button>
        {info && <button type="button" className="danger-button" disabled={busy || !info.editor || !revokePassword || !validReason} onClick={() => setPending(info.editor)}>Отозвать текущего редактора…</button>}
      </div>
      {info && <details><summary>Журнал администрирования · последние {info.events.length}</summary><div className="table-scroll"><table><thead><tr><th>Когда</th><th>Кто</th><th>Действие</th><th>Причина</th></tr></thead><tbody>{info.events.map((entry) => <tr key={entry.id}><td>{new Date(entry.createdAt).toLocaleString("ru-RU")}</td><td>{entry.actor}</td><td>{actionLabels[entry.action] || entry.action}</td><td>{entry.reason}</td></tr>)}</tbody></table></div></details>}
    </>}
    <p className="help-text">Отзыв касается только выбранного текущего сеанса. Он не блокирует учётную запись навсегда и не передаёт права автоматически: следующий редактор входит с обычным паролем рабочей папки. Удаление базы в этой панели отсутствует. Служебное хранилище владельца хранится отдельно от модульных резервных копий; резервируйте его вместе с сетевой папкой при закрытых приложениях.</p>
    {pending && <ConfirmDialog title="Отозвать режим редактора?" message={`Редактор: ${pending.owner.displayName}. Причина: ${reason}. Текущая операция записи должна завершиться, затем поддерживающая эту функцию версия перейдёт в просмотр. Несохранённые изменения не будут автоматически записаны. Подтверждаете?`} confirmLabel="Отозвать этот сеанс" onClose={() => setPending(undefined)} onConfirm={revoke} />}
  </section>;
}
