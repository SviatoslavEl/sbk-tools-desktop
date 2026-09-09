import { useEffect, useId, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ConfirmDialog } from "../../components/Dialog";
import type { WorkspaceInfo } from "../../lib/storage";
import { editorStatus } from "../../lib/editorStatus";

interface OwnerInfo {
  editor?: { token: string; owner: NonNullable<WorkspaceInfo["editorOwner"]> };
  editorBusy: boolean;
  editorStateMessage?: string | null;
  events: Array<{ id: number; createdAt: string; actor: string; action: string; reason: string }>;
}
const actionLabels: Record<string, string> = { "owner-setup": "Настройка владельца", "revoke-requested": "Запрошен отзыв редактора", "release-requested": "Просьба освободить редактора" };

export function OwnerPanel({ workspace }: { workspace: WorkspaceInfo | null }) {
  const [expanded, setExpanded] = useState(false);
  const panelId = useId();
  return <section className="owner-panel-disclosure" data-workspace-viewer-allowed aria-label="Администрирование сетевой папки">
    <button type="button" className="owner-panel-toggle" aria-expanded={expanded} aria-controls={panelId} onClick={() => setExpanded((value) => !value)}><span>Администрирование сетевой папки</span><span aria-hidden="true">{expanded ? "−" : "+"}</span></button>
    <div id={panelId} hidden={!expanded}>{expanded && <OwnerPanelContent workspace={workspace} />}</div>
  </section>;
}

function OwnerPanelContent({ workspace }: { workspace: WorkspaceInfo | null }) {
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [workspacePassword, setWorkspacePassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [info, setInfo] = useState<OwnerInfo | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const operation = useRef(false);
  const authenticationGeneration = useRef(0);
  const [infoError, setInfoError] = useState("");
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState<OwnerInfo["editor"]>();
  const [revokePassword, setRevokePassword] = useState("");
  const [authenticatedAt, setAuthenticatedAt] = useState(0);
  const logout = () => { authenticationGeneration.current += 1; setPassword(""); setRevokePassword(""); setInfo(null); setPending(undefined); setAuthenticatedAt(0); setInfoError(""); };
  useEffect(() => () => { authenticationGeneration.current += 1; }, []);
  useEffect(() => {
    if (!authenticatedAt) return;
    const timer = window.setTimeout(() => { logout(); setMessage("Вход владельца завершён через 10 минут. Войдите снова."); }, Math.max(0, authenticatedAt + 600_000 - Date.now()));
    return () => window.clearTimeout(timer);
  }, [authenticatedAt]);
  useEffect(() => {
    if (!authenticatedAt || !password) return;
    let cancelled = false;
    let refreshing = false;
    const refresh = async () => {
      if (refreshing || operation.current) return;
      refreshing = true;
      try {
        const value = await invoke<OwnerInfo>("workspace_owner_info", { password });
        if (!cancelled) { setInfo(value); setInfoError(""); }
      } catch {
        if (!cancelled) { setInfoError("Не удалось обновить сеанс. Действия недоступны до восстановления связи."); setPending(undefined); }
      } finally { refreshing = false; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    window.addEventListener("focus", refresh);
    return () => { cancelled = true; window.clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, [authenticatedAt, password]);
  const run = async (action: () => Promise<void>) => {
    if (operation.current) return;
    operation.current = true;
    setBusy(true); setMessage("");
    try { await action(); } catch (error) { setMessage(String(error)); }
    finally { operation.current = false; setBusy(false); }
  };
  const login = () => run(async () => {
    const generation = authenticationGeneration.current;
    const value = await invoke<OwnerInfo>("workspace_owner_info", { password });
    if (generation !== authenticationGeneration.current) return;
    setInfo(value);
    setInfoError("");
    setAuthenticatedAt(Date.now());
  });
  const refreshNow = () => run(async () => {
    const generation = authenticationGeneration.current;
    try {
      const value = await invoke<OwnerInfo>("workspace_owner_info", { password });
      if (generation !== authenticationGeneration.current) return;
      setInfo(value); setInfoError("");
    } catch (error) {
      if (generation !== authenticationGeneration.current) return;
      setInfoError("Не удалось обновить сеанс. Действия недоступны до восстановления связи.");
      throw error;
    }
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
  const status = editorStatus(info ? { editor: false, editorBusy: info.editorBusy, editorStateMessage: infoError || info.editorStateMessage, editorOwner: info.editor?.owner, writable: Boolean(workspace?.writable) } : workspace);
  const knownEditor = info ? info.editor?.owner : workspace?.editorOwner;
  const canRequest = !busy && !status.unknown && status.occupied && Boolean(knownEditor) && validReason && Boolean(workspace?.writable);
  return <div className="owner-panel" aria-busy={busy}>
    <div className="editor-presence" aria-live="polite"><strong>Текущий редактор: {status.text}</strong>{status.device && <small>Компьютер: {status.device}</small>}</div>
    {status.occupied && !status.unknown && !knownEditor && <p className="help-text">Режим занят, но адресат неизвестен. Запрос станет доступен после получения сведений о редакторе.</p>}
    {message && <div className="notice" role="status">{message}</div>}
    {!workspace ? <p role="status">Загружаем сведения об общей папке…</p> : !workspace.ownerConfigured ? <fieldset className="settings-form" disabled={busy || !workspace.editor || status.unknown}>
      <p>Первичную настройку выполняет владелец, находясь в режиме редактора. Повторно назначить владельца этим способом нельзя.</p>
      <label>Новый пароль владельца<input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
      <small>12–128 символов, без управляющих символов и пробелов по краям. Выберите уникальную длинную фразу; встроенного пароля нет.</small>
      <label>Повторите пароль владельца<input type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} /></label>
      {workspace?.accessControlled && <label>Текущий пароль рабочей папки<input type="password" autoComplete="current-password" value={workspacePassword} onChange={(e) => setWorkspacePassword(e.target.value)} /></label>}
      <label>Подтверждение: введите НАЗНАЧИТЬ ВЛАДЕЛЬЦА<input value={confirmation} onChange={(e) => setConfirmation(e.target.value)} /></label>
      <button type="button" className="primary" disabled={busy || !workspace?.editor || confirmation !== "НАЗНАЧИТЬ ВЛАДЕЛЬЦА" || !password || password !== repeat} onClick={() => void setup()}>Настроить владельца</button>
    </fieldset> : <>
      {!info ? <fieldset className="settings-form" disabled={busy}><label>Пароль владельца<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && password) void login(); }} /></label><button type="button" className="primary" disabled={!password} onClick={() => void login()}>Войти как владелец</button></fieldset> : <>
        <p className="help-text">Вход до {new Date(authenticatedAt + 600_000).toLocaleTimeString("ru-RU")}. Сворачивание панели завершает вход.</p>
        <div className="button-row"><button type="button" className="secondary" disabled={busy} onClick={() => void refreshNow()}>Обновить статус</button><button type="button" className="secondary" disabled={busy} onClick={logout}>Выйти</button></div>
        <label>Повторите пароль владельца для отзыва<input type="password" autoComplete="current-password" disabled={busy || status.unknown || !info.editor} value={revokePassword} onChange={(e) => setRevokePassword(e.target.value)} /></label>
      </>}
      <label>Причина запроса / отзыва<textarea rows={2} maxLength={500} disabled={busy || status.unknown || !status.occupied || !knownEditor} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="От 3 до 500 символов" /></label>
      <div className="button-row">
        <button type="button" className="secondary" disabled={!canRequest} onClick={() => void request()}>Попросить освободить редактора</button>
        {info && <button type="button" className="danger-button" disabled={!canRequest || !info.editor || !revokePassword} onClick={() => setPending(info.editor)}>Отозвать текущего редактора…</button>}
      </div>
      {info && <details><summary>Журнал администрирования · последние {info.events.length}</summary><div className="table-scroll"><table><thead><tr><th>Когда</th><th>Кто</th><th>Действие</th><th>Причина</th></tr></thead><tbody>{info.events.map((entry) => <tr key={entry.id}><td>{new Date(entry.createdAt).toLocaleString("ru-RU")}</td><td>{entry.actor}</td><td>{actionLabels[entry.action] || entry.action}</td><td>{entry.reason}</td></tr>)}</tbody></table></div></details>}
    </>}
    <details className="owner-panel-help"><summary>Как устроены права и резервирование</summary><p>Защита действует внутри приложения. Прямые права записи в сетевую папку позволяют менять файлы вне программы. Обновите все рабочие места.</p><p>Отзыв касается только выбранного сеанса. Он не передаёт права автоматически: следующий редактор входит с обычным паролем рабочей папки. Удаления базы здесь нет. Служебное хранилище владельца резервируйте вместе с сетевой папкой при закрытых приложениях.</p></details>
    {pending && <ConfirmDialog title="Отозвать режим редактора?" message={`Редактор: ${pending.owner.displayName}. Причина: ${reason}. Текущая операция записи должна завершиться, затем поддерживающая эту функцию версия перейдёт в просмотр. Несохранённые изменения не будут автоматически записаны. Подтверждаете?`} confirmLabel="Отозвать этот сеанс" onClose={() => setPending(undefined)} onConfirm={revoke} />}
  </div>;
}
