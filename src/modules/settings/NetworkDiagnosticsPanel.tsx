import { useEffect, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { getWorkspaceInfo, switchWorkspaceMode, type WorkspaceInfo } from "../../lib/storage";
import { editorStatus } from "../../lib/editorStatus";
import {
  disconnectWorkspaceNetwork, exportDiagnosticBundle, getDiagnosticStatus,
  isDesktopRuntime, networkAccessIsPaused, networkDiagnosticsShortcutLabel, networkPausedMessage, openNetworkDiagnosticsEvent,
  reconnectWorkspaceNetwork, setDiagnosticLogging, useNetworkAccess,
  type DiagnosticStatus, type NetworkPhase,
} from "../../lib/networkDiagnostics";

export const networkPhaseLabels: Record<NetworkPhase, string> = {
  connected: "Подключено", disconnecting: "Завершаем текущие операции…",
  disconnected: "Отключено на этом компьютере", disconnectFailed: "Отключение не завершено",
  reconnecting: "Подключаемся в режиме просмотра…",
};

export function NetworkOfflineNotice({ overlay = false }: { overlay?: boolean }) {
  const network = useNetworkAccess();
  if (network.phase === "connected") return overlay ? <div className="network-overlay-access" data-network-offline-allowed><button className="secondary" type="button" title="Открыть диагностику, не закрывая карточку" onClick={() => window.dispatchEvent(new Event(openNetworkDiagnosticsEvent))}>Связь и диагностика</button></div> : null;
  return <div className="network-offline-notice notice warning" role="status" data-network-offline-allowed>
    <div><strong>{networkPhaseLabels[network.phase]}</strong><span>{networkPausedMessage}</span></div>
    <button className="secondary" type="button" onClick={() => window.dispatchEvent(new Event(openNetworkDiagnosticsEvent))}>Связь и диагностика</button>
  </div>;
}

export function NetworkDiagnosticsPanel({ ownerConfigured = false }: { ownerConfigured?: boolean }) {
  const network = useNetworkAccess();
  const native = isDesktopRuntime();
  const [password, setPassword] = useState("");
  const [workspacePassword, setWorkspacePassword] = useState("");
  const [showEditorAccess, setShowEditorAccess] = useState(false);
  const [editorWorkspace, setEditorWorkspace] = useState<WorkspaceInfo | null>(null);
  const [editorError, setEditorError] = useState("");
  const [diagnostics, setDiagnostics] = useState<DiagnosticStatus | null>(null);
  const [diagnosticError, setDiagnosticError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const operationGeneration = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (network.phase !== "connected") { setWorkspacePassword(""); setEditorWorkspace(null); setShowEditorAccess(false); setEditorError(""); }
  }, [network.phase]);
  useEffect(() => {
    if (!native) return;
    let cancelled = false;
    let reading = false;
    const refresh = async () => {
      if (reading || inFlight.current) return;
      reading = true;
      const generation = operationGeneration.current;
      try { const next = await getDiagnosticStatus(); if (!cancelled && generation === operationGeneration.current) { setDiagnostics(next); setDiagnosticError(""); } }
      catch { if (!cancelled) setDiagnosticError("Не удалось прочитать локальное состояние диагностики."); }
      finally { reading = false; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [native]);
  const run = async (action: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true; operationGeneration.current++; setBusy(true); setMessage("");
    try { await action(); } catch (error) { if (mounted.current) setMessage(String(error)); }
    finally { inFlight.current = false; if (mounted.current) setBusy(false); }
  };
  const disconnect = () => run(async () => {
    try { await disconnectWorkspaceNetwork(password); }
    finally { if (mounted.current) setPassword(""); }
  });
  const refreshEditorAccess = async () => {
    if (networkAccessIsPaused()) return null;
    if (mounted.current) { setShowEditorAccess(true); setEditorError(""); }
    try {
      const fresh = await getWorkspaceInfo();
      if (mounted.current && !networkAccessIsPaused()) setEditorWorkspace(fresh);
      return fresh;
    } catch (error) {
      if (mounted.current) { setEditorWorkspace(null); setEditorError(`Не удалось проверить редактора: ${String(error)}`); }
      return null;
    }
  };
  const reconnect = () => run(async () => {
    const result = await reconnectWorkspaceNetwork();
    if (mounted.current && result.phase === "connected") {
      setMessage("Подключение восстановлено в режиме просмотра. Для редактирования потребуется отдельный обычный вход.");
      await refreshEditorAccess();
    }
  });
  const enterEditor = () => run(async () => {
    try {
      const fresh = await refreshEditorAccess();
      if (!fresh || networkAccessIsPaused()) return;
      if (fresh.editor) { if (mounted.current) setMessage("Обычный режим редактора уже активен на этом компьютере."); return; }
      const status = editorStatus(fresh);
      if (!status.canAcquire) throw new Error(status.unknown ? "Доступ редактора не подтверждён. Обновите сведения." : `Вход недоступен: ${status.text}. Чужой сеанс не изменён.`);
      if (fresh.accessControlled && !workspacePassword) throw new Error("Введите обычный пароль рабочей папки, не пароль владельца.");
      // This is the ordinary editor login. Reconnect never calls it implicitly,
      // and the owner credential is never passed through this path.
      await switchWorkspaceMode(true, fresh.accessControlled ? workspacePassword : "");
      const confirmed = await getWorkspaceInfo();
      if (mounted.current && !networkAccessIsPaused()) setEditorWorkspace(confirmed);
      if (!confirmed.editor || networkAccessIsPaused()) throw new Error("Вход редактора не подтверждён. Несохранённые поля остались в карточке.");
      if (mounted.current) setMessage("Обычный вход редактора выполнен. Закройте только окно диагностики и сохраните изменения в оставшейся открытой карточке.");
    } finally { if (mounted.current) setWorkspacePassword(""); }
  });
  const toggleLogging = () => run(async () => {
    const next = await setDiagnosticLogging(!diagnostics?.enabled);
    if (mounted.current) { setDiagnostics(next); setDiagnosticError(""); }
  });
  const exportLogs = () => run(async () => {
    const path = await save({ title: "Сохранить диагностику на локальный диск (не в общую папку)", defaultPath: `SBK-diagnostics-${new Date().toISOString().replace(/[:.]/g, "-")}.zip`, filters: [{ name: "Диагностический архив", extensions: ["zip"] }] });
    if (!path) return;
    await exportDiagnosticBundle(path);
    if (mounted.current) setMessage("Диагностический ZIP сохранён. Он никуда не отправлен. При необходимости отправьте файл вручную.");
  });
  const transitioning = network.phase === "disconnecting" || network.phase === "reconnecting";
  const ordinaryAccess = editorStatus(editorWorkspace);
  return <section className="network-diagnostics-panel" aria-label="Связь и диагностика" data-workspace-viewer-allowed data-network-offline-allowed>
    <div className="inline-heading"><h3>Связь с общей базой на этом компьютере</h3><span className={`status ${network.phase === "connected" ? "neutral" : "warning"}`}>{networkPhaseLabels[network.phase]}</span></div>
    <p className="help-text">В открытой карточке используйте кнопку «Связь и диагностика»: форма не закрывается, введённое не сохраняется автоматически. Быстрая клавиша {networkDiagnosticsShortcutLabel} доступна, если сочетание не занято системой.</p>
    {!native && <p className="notice warning">Предпросмотр интерфейса: подключение и диагностика доступны только в установленном приложении. Здесь действия не выполняются.</p>}
    <p className="help-text">Отключение действует до перезапуска СБК. Обычный запуск снова подключится. Другие компьютеры не отключаются. Открытые формы остаются в памяти, но не сохраняются автоматически.</p>
    {network.phase !== "connected" && <p className="help-text">{networkPausedMessage} Не закрывайте программу и несохранённые карточки, если хотите сохранить введённое после подключения.</p>}
    {network.error && <p className="field-error" role="alert">{network.error}</p>}
    {transitioning && <p role="status">Активных операций: {network.activeOperations}. Ожидаем подтверждения от приложения; пока отключение не подтверждено, файловые операции могут ещё завершаться.</p>}
    {(network.phase === "connected" || network.phase === "disconnectFailed") && <>
      {ownerConfigured ? <label>Пароль владельца для отключения<input type="password" autoComplete="current-password" value={password} disabled={!native || busy || transitioning} onChange={(event) => setPassword(event.target.value)} /></label> : <p className="help-text">Для отключения требуется ранее настроенный владелец общей папки. Локальная диагностика ниже доступна без входа владельца.</p>}
      <button className="secondary" type="button" disabled={!native || busy || !ownerConfigured || !password || transitioning} onClick={() => void disconnect()}>{network.phase === "disconnectFailed" ? "Повторить завершение отключения" : "Отключить связь на этом компьютере"}</button>
    </>}
    {network.phase !== "connected" && <button className="secondary" type="button" disabled={!native || busy || transitioning} onClick={() => void reconnect()}>Подключить в режиме просмотра</button>}
    {network.phase === "connected" && <div className="network-diagnostics-logging">
      {!showEditorAccess ? <button className="secondary" type="button" disabled={!native || busy} onClick={() => void run(async () => { await refreshEditorAccess(); })}>Вернуться к редактированию</button> : <>
        <h3>Вернуться к редактированию</h3>
        <p className="help-text">Это отдельный обычный вход в общую папку, без передачи прав владельца и без перехвата занятого сеанса. Открытая карточка остаётся на месте.</p>
        <p role="status">{editorWorkspace?.editor ? "Режим редактора активен" : ordinaryAccess.unknown ? "Доступ редактора не подтверждён" : ordinaryAccess.text}</p>
        {editorError && <p className="field-error" role="alert">{editorError}</p>}
        {editorWorkspace?.accessControlled && !editorWorkspace.editor && <label>Обычный пароль рабочей папки<input type="password" autoComplete="current-password" value={workspacePassword} disabled={!native || busy || !ordinaryAccess.canAcquire} onChange={(event) => setWorkspacePassword(event.target.value)} /></label>}
        {editorWorkspace && !editorWorkspace.accessControlled && !editorWorkspace.editor && <p className="help-text">Для этой папки обычный пароль не настроен. Вход всё равно требует отдельного нажатия и свободного сеанса редактора.</p>}
        <div className="button-row"><button className="secondary" type="button" disabled={!native || busy} onClick={() => void run(async () => { await refreshEditorAccess(); })}>Обновить доступ редактора</button>{!editorWorkspace?.editor && <button className="primary" type="button" disabled={!native || busy || !ordinaryAccess.canAcquire || Boolean(editorWorkspace?.accessControlled && !workspacePassword)} onClick={() => void enterEditor()}>Войти в обычный режим редактора</button>}</div>
      </>}
    </div>}
    <div className="network-diagnostics-logging">
      <h3>Локальный журнал диагностики</h3>
      <p className="help-text">Без паролей, содержимого документов и автоматической отправки. Сохраняются технические события и длительность операций. Экспорт — только в новый ZIP на локальном диске.</p>
      <p className="help-text">Для записи запуска включите журнал и перезапустите программу. Настройка сохраняется на этом компьютере; переключатель действует на текущий экземпляр.</p>
      <p role="status">{diagnostics ? diagnostics.enabled ? "Журналирование включено" : "Журналирование выключено" : native ? "Читаем локальное состояние…" : "Состояние недоступно в предпросмотре"}</p>
      {diagnosticError && <p className="field-error" role="alert">{diagnosticError}</p>}
      {diagnostics && (!diagnostics.available || diagnostics.writeFailures > 0 || diagnostics.droppedEvents > 0) && <p className="notice warning">Журнал может быть неполным: ошибок записи {diagnostics.writeFailures}, пропущено событий {diagnostics.droppedEvents}.{!diagnostics.available && " Локальное хранилище журнала недоступно."}</p>}
      <div className="button-row"><button className="secondary" type="button" disabled={!native || busy || !diagnostics} onClick={() => void toggleLogging()}>{diagnostics?.enabled ? "Выключить журналирование" : "Включить журналирование"}</button><button className="secondary" type="button" disabled={!native || busy || !diagnostics?.available} onClick={() => void exportLogs()}>Экспорт диагностики…</button></div>
    </div>
    {message && <p className="notice" role="status">{message}</p>}
    {busy && <p role="status">Выполняем действие…</p>}
  </section>;
}
