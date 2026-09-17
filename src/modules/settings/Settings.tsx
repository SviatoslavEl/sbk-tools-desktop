import { useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "../../components/Dialog";
import { useRecords } from "../../hooks/useRecords";
import packageInfo from "../../../package.json";
import { chooseDirectory, chooseOpenPath } from "../../lib/files";
import {
  auditAttachments,
  createBackup,
  createEncryptedBackup,
  deleteBackup,
  getWorkspaceInfo,
  listBackups,
  pruneHistory,
  restoreBackup,
  restoreEncryptedBackup,
  rotateBackups,
  setBackupPinned,
  setWorkspaceLocation,
  setWorkspaceAccessPassword,
  switchWorkspaceMode,
  verifyBackup,
  verifyEncryptedBackup,
  type BackupInfo,
  type BackupListItem,
  type WorkspaceInfo,
} from "../../lib/storage";
import {
  getIntelligenceProviderStatus,
  type IntelligenceProviderStatus,
} from "../intelligence/api";
import {
  readAccessTimers,
  saveAccessTimers,
  type AccessTimers,
} from "../../lib/sharedWorkspace";
import { useWorkspaceAccess } from "../../lib/workspaceAccess";
import { workspacePasswordError, workspacePasswordHint } from "./passwordPolicy";
import { OwnerPanel } from "./OwnerPanel";
import { editorStatus, unavailableWorkspaceInfo } from "../../lib/editorStatus";
import "./settings.css";

interface AppSettings {
  expiryDays: 30 | 60 | 90;
  collapsedSidebar: boolean;
  historyLimit: 25 | 50 | 100 | 200;
}

export function Settings({
  collapsed,
  onCollapsed,
  workspace,
  onWorkspaceChange: setWorkspace,
}: {
  collapsed: boolean;
  onCollapsed: (value: boolean) => void;
  workspace: WorkspaceInfo;
  onWorkspaceChange: (value: WorkspaceInfo) => void;
}) {
  const workspaceAccess = useWorkspaceAccess();
  const store = useRecords<AppSettings>("settings");
  const [accessBusy, setAccessBusy] = useState(false);
  const [section, setSection] = useState("workspace");
  const [backupLoading, setBackupLoading] = useState(true);
  const [backupError, setBackupError] = useState("");
  const [verification, setVerification] = useState<{ path: string; at: string } | null>(null);
  const [maintenanceBusy, setMaintenanceBusy] = useState(false);
  const maintenanceOperation = useRef(false);
  const accessOperation = useRef(false);
  const editor = editorStatus(workspace);
  const [message, setMessage] = useState("");
  const [accessMessage, setAccessMessage] = useState("");
  const [restorePath, setRestorePath] = useState("");
  const [backups, setBackups] = useState<BackupListItem[]>([]);
  const [retention, setRetention] = useState(10);
  const [retentionDays, setRetentionDays] = useState(180);
  const [encryptBackup, setEncryptBackup] = useState(false);
  const [backupPassword, setBackupPassword] = useState("");
  const [workspacePassword, setWorkspacePassword] = useState("");
  const [newWorkspacePassword, setNewWorkspacePassword] = useState("");
  const currentWorkspacePasswordError = workspacePassword
    ? workspacePasswordError(workspacePassword)
    : "";
  const newWorkspacePasswordError = newWorkspacePassword
    ? workspacePasswordError(newWorkspacePassword)
    : "";
  const [intelligence, setIntelligence] =
    useState<IntelligenceProviderStatus | null>(null);
  const [accessTimers, setAccessTimers] =
    useState<AccessTimers>(readAccessTimers);
  const expiryDays =
    store.records.find((record) => record.title === "application")?.payload
      .expiryDays || 60;
  const historyLimit =
    store.records.find((record) => record.title === "application")?.payload
      .historyLimit || 100;
  const reloadBackups = async () => {
    setBackupLoading(true);
    try { setBackups(await listBackups()); setBackupError(""); }
    catch { setBackupError("Не удалось обновить список резервных копий. Показаны последние полученные сведения."); }
    finally { setBackupLoading(false); }
  };
  const latestBackup = [...backups].sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt))[0];
  const runMaintenance = async (action: () => Promise<void>) => {
    if (maintenanceOperation.current) return;
    maintenanceOperation.current = true; setMaintenanceBusy(true);
    try { await action(); }
    catch (reason) { setMessage(`Ошибка: ${String(reason)}`); }
    finally { maintenanceOperation.current = false; setMaintenanceBusy(false); }
  };
  useEffect(() => {
    const timers = readAccessTimers(workspace.root);
    setAccessTimers(timers);
    setRetention(timers.retentionCount);
    setRetentionDays(timers.retentionDays);
    void getIntelligenceProviderStatus().then(setIntelligence).catch(() => setIntelligence(null));
    setVerification(null);
    void reloadBackups();
  }, [workspace.root]);
  useEffect(() => {
    if (!workspace?.root) return;
    const current = readAccessTimers(workspace.root);
    setAccessTimers(
      saveAccessTimers(
        { ...current, retentionCount: retention, retentionDays },
        workspace.root,
      ),
    );
  }, [workspace?.root, retention, retentionDays]);
  const updateAccessTimers = (next: AccessTimers) =>
    setAccessTimers(saveAccessTimers(next, workspace?.root));
  const refreshWorkspace = async () => {
    try {
      const next = await getWorkspaceInfo();
      setWorkspace(next);
      return next;
    } catch (error) {
      setWorkspace(unavailableWorkspaceInfo(workspace));
      throw error;
    }
  };
  const runAccessOperation = async (action: () => Promise<void>) => {
    if (accessOperation.current) return;
    accessOperation.current = true;
    setAccessBusy(true);
    try { await action(); }
    catch (reason) {
      setAccessMessage(`Ошибка доступа: ${String(reason)}`);
      try { await refreshWorkspace(); } catch { /* Keep access blocked until status recovers. */ }
    } finally { accessOperation.current = false; setAccessBusy(false); }
  };
  const changeWorkspaceMode = (toEditor: boolean) => runAccessOperation(async () => {
    const requestedOwnRetry = !toEditor && Boolean(workspace.editorCleanupPending);
    const current = await refreshWorkspace();
    // The status request itself retries pending cleanup. Do not turn its
    // successful result into a spurious "editor changed" failure.
    if (requestedOwnRetry && !current.editor && !current.editorCleanupPending) {
      setWorkspacePassword("");
      setAccessMessage(`Собственный сеанс больше не удерживается этим экземпляром. ${current.accessMessage}`);
      return;
    }
    const currentStatus = editorStatus(current);
    const retryingOwnRelease = !toEditor && Boolean(current.editorCleanupPending);
    if ((!retryingOwnRelease && currentStatus.unknown) || (toEditor && (!currentStatus.canAcquire || current.editorCleanupPending)) || (!toEditor && !current.editor && !retryingOwnRelease)) {
      throw new Error(currentStatus.unknown ? currentStatus.text : "Режим редактора уже занят или изменился. Дождитесь обновления статуса.");
    }
    const validationError = current.accessControlled ? workspacePasswordError(workspacePassword) : "";
    if (validationError) {
      setAccessMessage(`Недопустимый пароль: ${validationError} ${workspacePasswordHint}`);
      return;
    }
    setAccessMessage(toEditor ? "Проверяем пароль и получаем режим редактирования…" : "Освобождаем режим редактирования…");
    await switchWorkspaceMode(toEditor, workspacePassword);
    const next = await refreshWorkspace();
    setWorkspacePassword("");
    setAccessMessage(next.accessMessage);
  });
  const saveWorkspacePassword = () => runAccessOperation(async () => {
    const current = await refreshWorkspace();
    if (!current.editor || editorStatus(current).unknown) throw new Error("Для смены пароля требуется подтверждённый режим редактора.");
    const validationError = workspacePasswordError(newWorkspacePassword);
    if (validationError) {
      setAccessMessage(`Недопустимый новый пароль: ${validationError} ${workspacePasswordHint}`);
      return;
    }
    if (current.accessControlled) {
      const currentValidationError = workspacePasswordError(workspacePassword);
      if (currentValidationError) {
        setAccessMessage(`Недопустимый текущий пароль: ${currentValidationError} ${workspacePasswordHint}`);
        return;
      }
    }
    setAccessMessage("Сохраняем пароль рабочей папки…");
    await setWorkspaceAccessPassword(workspacePassword, newWorkspacePassword);
    const next = await refreshWorkspace();
    setWorkspacePassword(""); setNewWorkspacePassword("");
    setAccessMessage(next.accessMessage);
  });
  const refreshSettings = () => runAccessOperation(async () => {
    setMessage("Обновляем сведения об общей папке…");
    try {
      await refreshWorkspace();
      const nextBackups = await listBackups();
      setBackups(nextBackups);
      window.dispatchEvent(new Event("sbk-workspace-refresh"));
      setMessage("Статус общей папки и список резервных копий обновлены.");
    } catch (error) {
      setMessage("Обновление не завершено. Показаны последние полученные сведения о резервных копиях.");
      throw error;
    }
  });

  const saveSettings = async (patch: Partial<AppSettings>) => {
    const existing = store.records.find(
      (record) => record.title === "application",
    );
    await store.save(
      "application",
      {
        expiryDays,
        historyLimit,
        collapsedSidebar: collapsed,
        ...existing?.payload,
        ...patch,
      },
      existing?.id,
    );
  };
  const backup = async () => {
    setMessage("Создаём резервную копию…");
    try {
      const result: BackupInfo = encryptBackup
        ? await createEncryptedBackup(backupPassword)
        : await createBackup();
      setMessage(
        `Резервная копия создана: ${result.fileName} (${(result.sizeBytes / 1024 / 1024).toFixed(1)} МБ)`,
      );
      setBackupPassword("");
      reloadBackups();
    } catch (reason) {
      setMessage(`Ошибка: ${String(reason)}`);
    }
  };
  const verify = async (path: string) => {
    setMessage("Проверяем целостность файлов и баз в резервной копии…");
    setVerification(null);
    try {
      const result = path.endsWith(".enc")
        ? await verifyEncryptedBackup(path, backupPassword)
        : await verifyBackup(path);
      setMessage(
        `Копия проверена: ${result.files} файлов, ${(result.unpackedBytes / 1024 / 1024).toFixed(1)} МБ. Повреждений не обнаружено.`,
      );
      setVerification({ path, at: new Date().toLocaleString("ru-RU") });
    } catch (reason) {
      setMessage(`Ошибка проверки: ${String(reason)}`);
    }
  };
  const selectRestore = async () => {
    const path = await chooseOpenPath("Выберите резервную копию", [
      "sbkbackup",
      "enc",
    ]);
    if (path) setRestorePath(path);
  };
  const restore = async () => {
    const path = restorePath;
    setMessage("Восстанавливаем данные…");
    try {
      if (path.endsWith(".enc"))
        await restoreEncryptedBackup(path, backupPassword);
      else await restoreBackup(path);
      setBackupPassword("");
      setRestorePath("");
      setMessage("Данные восстановлены. Перезагружаем приложение…");
      window.setTimeout(() => window.location.reload(), 350);
    } catch (reason) {
      setMessage(`Восстановление не выполнено: ${String(reason)}`);
      throw reason;
    }
  };
  const selectWorkspace = async () => {
    const path = await chooseDirectory("Выберите папку для переносимых данных");
    if (!path) return;
    try {
      const next = await setWorkspaceLocation(path);
      setMessage(
        `Новая рабочая папка: ${next}. Перезапустите приложение; текущие данные автоматически не переносятся.`,
      );
    } catch (reason) {
      setMessage(`Ошибка: ${String(reason)}`);
    }
  };
  const checkAttachments = async (remove = false) => {
    setMessage(
      remove
        ? "Удаляем только неподключённые вложения…"
        : "Проверяем вложения…",
    );
    try {
      const result = await auditAttachments(remove);
      setMessage(
        remove
          ? `Очистка завершена: удалено ${result.removedFiles} файлов (${(result.orphanedBytes / 1024 / 1024).toFixed(1)} МБ).`
          : `Проверка завершена: ${result.storedFiles} файлов, неподключённых — ${result.orphanedFiles} (${(result.orphanedBytes / 1024 / 1024).toFixed(1)} МБ).`,
      );
    } catch (reason) {
      setMessage(`Ошибка проверки вложений: ${String(reason)}`);
    }
  };

  return (
    <div className="module-stack settings-module">
      <nav className="settings-sections" aria-label="Разделы настроек">{[["workspace", "Рабочая папка"], ["backups", "Резервные копии"], ["interface", "Интерфейс"], ["advanced", "Обслуживание"]].map(([id, label]) => <button type="button" key={id} aria-pressed={section === id} onClick={() => setSection(id)}>{label}</button>)}</nav>
      {message && <div className={`notice ${/Ошибка|не выполнено|не завершено|Не удалось/.test(message) ? "error" : "neutral"}`} role="status">{message}</div>}
      {store.error && <div className="notice error" role="alert"><span>Настройки не прочитаны: {store.error}. Их изменение остановлено, чтобы не заменить сохранённые значения.</span><button type="button" onClick={() => void store.reload()}>Повторить загрузку настроек</button></div>}
      <div className="settings-grid">
      <section className="surface" hidden={section !== "workspace"}>
        <div className="surface-title">
          <h2>Общая рабочая папка</h2>
          <span
            className={`status ${workspaceAccess.editor ? "success" : "neutral"}`}
          >
            {workspaceAccess.editor ? "✎ Редактор" : "◉ Просмотр"}
          </span>
        </div>
        <div className="surface-body">
          <div className="settings-row">
            <span>Режим хранения</span>
            <strong>
              {workspace?.portable
                ? "Рядом с приложением"
                : "Выбранная или сетевая папка"}
            </strong>
          </div>
          <div className="settings-row path-row">
            <span>Путь</span>
            <strong>{workspace?.root || "Определяем…"}</strong>
          </div>
          <div className="settings-row">
            <span>Доступ</span>
            <strong>
              {workspaceAccess.message ||
                workspace?.accessMessage ||
                "Проверяем…"}
            </strong>
          </div>
          <div className="settings-row editor-presence" aria-live="polite">
            <span>Текущий редактор</span>
            <strong>
              {editor.unknown ? "Статус не подтверждён" : editor.text}
              {editor.device && <small>Компьютер: {editor.device}</small>}
              {workspace.editorOwner?.startedAt && <small>с {new Date(workspace.editorOwner.startedAt).toLocaleString("ru-RU")}</small>}
            </strong>
          </div>
          {workspace.editorCleanupPending && <div className="notice warning" role="alert"><strong>Освобождение своего сеанса не завершено</strong><span>{workspace.editorCleanupMessage || "Запись запрещена. Восстановите подключение к сетевой папке и повторите освобождение. Идентификатор вашего сеанса сохранён для повторной попытки."}</span></div>}
          {!workspace.editor && !workspace.editorCleanupPending && (editor.occupied || editor.unknown) && <p className="notice warning" role="status">{editor.unknown ? editor.text : `Права заняты: ${editor.text}. Попросите редактора перейти в режим просмотра или закрыть программу.`} Ввод пароля не освобождает чужой сеанс. Статус обновляется автоматически.</p>}
          <fieldset className="settings-form workspace-password-controls" aria-busy={accessBusy} disabled={accessBusy || !workspace.writable || (!workspace.editorCleanupPending && (editor.unknown || (!workspace.editor && !editor.canAcquire)))}>
            {workspace?.accessControlled ? <>
              <label>Пароль рабочей папки<input type="password" autoComplete="current-password" aria-invalid={Boolean(currentWorkspacePasswordError)} aria-describedby="workspace-password-hint" value={workspacePassword} onChange={(event) => setWorkspacePassword(event.target.value)} />{currentWorkspacePasswordError && <small className="field-error">{currentWorkspacePasswordError}</small>}</label>
              <p className="help-text" id="workspace-password-hint">{workspacePasswordHint}</p>
              <div className="button-row">
                <button className="primary" type="button" disabled={!workspacePassword || (!workspace.editorCleanupPending && !workspace.editor && Boolean(workspace.editorOwner))} onClick={() => void changeWorkspaceMode(!workspace.editor && !workspace.editorCleanupPending)}>{workspace.editorCleanupPending ? "Повторить освобождение своего сеанса" : workspace.editor ? "Перейти в режим просмотра" : "Войти в режим редактирования"}</button>
              </div>
              {workspace?.editor && <><label>Новый пароль<input type="password" autoComplete="new-password" aria-invalid={Boolean(newWorkspacePasswordError)} value={newWorkspacePassword} onChange={(event) => setNewWorkspacePassword(event.target.value)} />{newWorkspacePasswordError && <small className="field-error">{newWorkspacePasswordError}</small>}</label><button className="secondary" type="button" disabled={!workspacePassword || !newWorkspacePassword || Boolean(newWorkspacePasswordError)} onClick={() => void saveWorkspacePassword()}>Сменить пароль</button></>}
            </> : workspace.editorCleanupPending ? <><p className="help-text">Повторная попытка касается только сеанса этого экземпляра. Чужие права и пароли не меняются.</p><button className="secondary" type="button" onClick={() => void changeWorkspaceMode(false)}>Повторить освобождение своего сеанса</button></> : workspace?.editor ? <>
              <label>Новый пароль рабочей папки<input type="password" autoComplete="new-password" aria-invalid={Boolean(newWorkspacePasswordError)} aria-describedby="new-workspace-password-hint" value={newWorkspacePassword} onChange={(event) => setNewWorkspacePassword(event.target.value)} placeholder="От 6 до 128 символов" />{newWorkspacePasswordError && <small className="field-error">{newWorkspacePasswordError}</small>}</label>
              <p className="help-text" id="new-workspace-password-hint">{workspacePasswordHint}</p>
              <button className="primary" type="button" disabled={!newWorkspacePassword || Boolean(newWorkspacePasswordError)} onClick={() => void saveWorkspacePassword()}>Включить вход по паролю</button>
              <button className="secondary" type="button" onClick={() => void changeWorkspaceMode(false)}>Перейти в режим просмотра</button>
            </> : <><p className="help-text">{editor.canAcquire ? "Редактор свободен. Можно включить редактирование без перезапуска программы." : "Вход станет доступен после подтверждения свободного режима редактора."}</p><button className="primary" type="button" disabled={!editor.canAcquire} onClick={() => void changeWorkspaceMode(true)}>Войти в режим редактирования</button></>}
          </fieldset>
          {accessBusy && <p className="help-text" role="status">Проверяем и обновляем доступ…</p>}
          {accessMessage && <div className="notice" role="status">{accessMessage}</div>}
          <div className="settings-row">
            <span>Версия базы</span>
            <strong>{workspace?.schemaVersion || "—"}</strong>
          </div>
          <div className="settings-row">
            <span>Свободно</span>
            <strong>
              {workspace?.freeSpaceBytes
                ? `${(workspace.freeSpaceBytes / 1024 / 1024 / 1024).toFixed(1)} ГБ`
                : "—"}
            </strong>
          </div>
          <button
            className="secondary"
            type="button"
            onClick={() => void selectWorkspace()}
          >
            Подключить папку
          </button>
          <p className="help-text">
            Каждый экземпляр открывает защищённую общую папку в режиме просмотра.
            Редактирование включается вручную по общему паролю. Одновременно
            редактирует только один пользователь. При сетевой ошибке освобождение может потребовать повторной попытки; до подтверждения запись запрещена.
          </p>
          <details className="settings-technical">
            <summary>Технические требования к сетевой папке</summary>
            <span>
              SMB/NFS-хранилище должно поддерживать межмашинные блокировки
              файлов и атомарное переименование. Если администратор отключил эти
              механизмы, прямую общую базу использовать нельзя.
            </span>
          </details>
        </div>
      </section>
      <section className="surface" hidden={section !== "workspace"}>
        <div className="surface-title">
          <h2>Обновление данных</h2>
        </div>
        <div className="surface-body settings-form">
          <label>
            Обновлять данные из общей папки
            <select
              value={accessTimers.refreshSeconds}
              onChange={(event) =>
                updateAccessTimers({
                  ...accessTimers,
                  refreshSeconds: Number(event.target.value),
                })
              }
            >
              <option value="0">только вручную</option>
              <option value="15">каждые 15 секунд</option>
              <option value="30">каждые 30 секунд</option>
              <option value="60">каждую минуту</option>
              <option value="300">каждые 5 минут</option>
            </select>
          </label>
          <div className="button-row">
            <button
              className="secondary"
              type="button"
              disabled={accessBusy}
              onClick={() => void refreshSettings()}
            >
              Обновить сейчас
            </button>
          </div>
          <p className="help-text">
            Обновление получает изменения коллег из общей папки. Оно не создаёт резервную копию и не меняет режим доступа.
          </p>
        </div>
      </section>
      <section className="surface" data-workspace-mutation hidden={section !== "interface"}>
        <div className="surface-title">
          <h2>Интерфейс и история</h2>
        </div>
        <fieldset className="surface-body settings-form settings-interface-fields" disabled={maintenanceBusy || store.loading || Boolean(store.error)}>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={collapsed}
              onChange={(event) => {
                onCollapsed(event.target.checked);
                void runMaintenance(() => saveSettings({ collapsedSidebar: event.target.checked }));
              }}
            />{" "}
            Сворачивать навигацию до значков
          </label>
          <label>
            Предупреждать об истечении документов
            <select
              value={expiryDays}
              onChange={(event) =>
                void runMaintenance(() => saveSettings({
                  expiryDays: Number(
                    event.target.value,
                  ) as AppSettings["expiryDays"],
                }))
              }
            >
              <option value="30">за 30 дней</option>
              <option value="60">за 60 дней</option>
              <option value="90">за 90 дней</option>
            </select>
          </label>
          <label>
            Версий на одну запись
            <select
              value={historyLimit}
              onChange={(event) => {
                const limit = Number(
                  event.target.value,
                ) as AppSettings["historyLimit"];
                if (!window.confirm(`Хранить не более ${limit} версий на запись? Более старые версии будут удалены. Текущие записи останутся без изменений.`)) return;
                void runMaintenance(async () => {
                await saveSettings({ historyLimit: limit });
                const removed = await pruneHistory(limit);
                setMessage(
                  `Ограничение истории применено: удалено старых версий — ${removed}.`,
                );
                });
              }}
            >
              <option value="25">25</option>
              <option value="50">50</option>
              <option value="100">100</option>
              <option value="200">200</option>
            </select>
          </label>
        </fieldset>
      </section>
      <section className="surface" hidden={section !== "advanced"}>
        <div className="surface-title">
          <h2>Локальный AI-сервер</h2>
          <span className="status neutral">Выключен</span>
        </div>
        <div className="surface-body">
          <p>{intelligence?.message || "Проверяем состояние…"}</p>
          <div className="notice warning">
            <strong>Подключение ещё не активировано.</strong>
            <span>
              Это подготовленный безопасный контур, а не имитация AI. Ручной
              ввод, расчёты и экспорт работают полностью офлайн.
            </span>
          </div>
          <p className="help-text">
            После появления сервера потребуется утверждённый API, HTTPS/mTLS для
            локальной сети и секрет из системного хранилища. WebView не будет
            обращаться к серверу напрямую.
          </p>
        </div>
      </section>
      <section className="surface" hidden={section !== "backups"}>
        <div className="surface-title">
          <h2>Создание и защита копий</h2>
        </div>
        <div className="surface-body settings-form">
          <label>Автоматические резервные копии<select disabled={!workspaceAccess.editor} value={accessTimers.backupHours} onChange={(event) => updateAccessTimers({ ...accessTimers, backupHours: Number(event.target.value) })}><option value="0">выключено</option><option value="6">каждые 6 часов</option><option value="12">каждые 12 часов</option><option value="24">ежедневно</option><option value="168">еженедельно</option></select></label>
          <p className="help-text">Создаются, пока программа открыта в режиме редактора. Это полная копия данных, а не архив отдельных записей. Автоматические копии не шифруются; настройка ниже относится к новой ручной копии.</p>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={encryptBackup}
              onChange={(event) => setEncryptBackup(event.target.checked)}
            />{" "}
            Защитить новую ручную копию паролем
          </label>
          <label>
            Пароль копии
            <input
              type="password"
              minLength={10}
              autoComplete="new-password"
              value={backupPassword}
              onChange={(event) => setBackupPassword(event.target.value)}
              placeholder="Не менее 10 символов"
            />
          </label>
          <p className="help-text">
            Пароль нигде не сохраняется. Он нужен только для зашифрованной
            копии. Это не пароль доступа к рабочей папке. Без пароля восстановить зашифрованную копию нельзя.
          </p>
          <details className="settings-technical"><summary>Как защищена копия</summary><p>Для шифрования используются Argon2id и XChaCha20-Poly1305. Пароль не сохраняется в приложении.</p></details>
        </div>
      </section>
      <section className="surface backup-surface" hidden={section !== "backups"}>
        <div className="surface-title">
          <h2>Резервное копирование</h2>
          <span>{backups.length} копий</span>
        </div>
        <div className="surface-body settings-actions">
          <p>
            Копия содержит отдельные базы всех инструментов и сохранённые
            вложения.
          </p>
          <div className="notice neutral" role="status"><strong>{backupLoading ? "Проверяем список копий…" : backupError ? "Состояние резервных копий не подтверждено" : latestBackup ? `Последняя копия: ${new Date(latestBackup.modifiedAt).toLocaleString("ru-RU")}` : "Резервных копий пока нет"}</strong><span>{verification ? `Проверена в этом сеансе: ${verification.path.split(/[\\/]/).pop()} · ${verification.at}` : "Целостность существующих копий в этом сеансе не проверялась."}</span></div>
          {backupError && <div className="notice error" role="alert"><span>{backupError}</span><button type="button" onClick={() => void reloadBackups()}>Повторить загрузку</button></div>}
          <fieldset disabled={maintenanceBusy} aria-busy={maintenanceBusy} className="settings-actions">
          <div className="button-row">
            <button
              className="primary"
              disabled={!workspaceAccess.editor}
              type="button"
              onClick={() => void runMaintenance(backup)}
            >
              Создать резервную копию
            </button>
            <button
              className="secondary"
              disabled={!workspaceAccess.editor}
              type="button"
              onClick={() => void runMaintenance(selectRestore)}
            >
              Проверить / восстановить файл
            </button>
          </div>
          <div className="retention-row">
            <label>
              Хранить незакреплённых копий
              <input
                disabled={!workspaceAccess.editor}
                type="number"
                min="1"
                max="100"
                value={retention}
                onChange={(event) => setRetention(Number(event.target.value))}
              />
            </label>
            <label>
              Не дольше, дней
              <input
                disabled={!workspaceAccess.editor}
                type="number"
                min="1"
                max="3650"
                value={retentionDays}
                onChange={(event) =>
                  setRetentionDays(Number(event.target.value))
                }
              />
            </label>
            <button
              className="secondary small"
              disabled={!workspaceAccess.editor}
              type="button"
              onClick={() => { if (!window.confirm("Удалить незакреплённые резервные копии сверх выбранного количества и возраста? Закреплённые копии останутся.")) return; void runMaintenance(async () => {
                const removed = await rotateBackups(retention, retentionDays);
                setMessage(
                  `Ротация завершена: удалено ${removed}. Закреплённые копии сохранены.`,
                );
                await reloadBackups();
              }); }}
            >
              Очистить старые копии
            </button>
          </div>
          <div className="backup-list">
            {backups.map((item) => (
              <div key={item.fileName}>
                <span>
                  <strong>
                    {item.pinned ? "★ " : ""}
                    {item.fileName}
                  </strong>
                  <small>
                    {new Date(item.modifiedAt).toLocaleString("ru-RU")} ·{" "}
                    {(item.sizeBytes / 1024 / 1024).toFixed(1)} МБ
                  </small>
                </span>
                <div className="button-row">
                  <button
                    className="link-button"
                    type="button"
                    onClick={() => void runMaintenance(() => verify(item.path))}
                  >
                    Проверить
                  </button>
                  <button
                    className="link-button"
                    disabled={!workspaceAccess.editor}
                    type="button"
                    onClick={() => void runMaintenance(async () => {
                      await setBackupPinned(item.fileName, !item.pinned);
                      await reloadBackups();
                    })}
                  >
                    {item.pinned ? "Открепить" : "Закрепить"}
                  </button>
                  <button
                    className="link-button danger"
                    disabled={!workspaceAccess.editor || item.pinned}
                    type="button"
                    onClick={() => void runMaintenance(async () => {
                      if (
                        !window.confirm(
                          `Удалить резервную копию ${item.fileName}?`,
                        )
                      )
                        return;
                      await deleteBackup(item.fileName);
                      await reloadBackups();
                    })}
                  >
                    Удалить
                  </button>
                </div>
              </div>
            ))}
          </div>
          </fieldset>
        </div>
      </section>
      <section className="surface" hidden={section !== "advanced"}>
        <div className="surface-title">
          <h2>Изоляция данных</h2>
        </div>
        <div className="surface-body">
          <ul className="plain-list">
            <li>Калькулятор: отдельная база и экспорт расчётов.</li>
            <li>Сканер: отдельные задания и шаблоны факсимиле.</li>
            <li>Опыт по договорам: самостоятельный реестр.</li>
            <li>Кадры: отдельный реестр и собственные документы.</li>
            <li>
              Закупки: отдельная база; связи создаются только явным снимком
              пользователя.
            </li>
          </ul>
        </div>
      </section>
      <section className="surface" hidden={section !== "advanced"}>
        <div className="surface-title">
          <h2>Контроль вложений</h2>
        </div>
        <div className="surface-body settings-actions">
          <p>
            Проверка учитывает текущие записи, черновики и историю версий.
            Удаляются только файлы, на которые больше никто не ссылается.
          </p>
          <div className="button-row">
            <button
              className="secondary"
              type="button"
              disabled={maintenanceBusy}
              onClick={() => void runMaintenance(() => checkAttachments(false))}
            >
              Проверить
            </button>
            <button
              className="secondary danger"
              disabled={!workspaceAccess.editor || maintenanceBusy}
              type="button"
              onClick={() => {
                if (
                  window.confirm(
                    "Удалить все неподключённые вложения? Текущие записи и история не изменятся.",
                  )
                )
                  void runMaintenance(() => checkAttachments(true));
              }}
            >
              Очистить неподключённые
            </button>
          </div>
        </div>
      </section>
      </div>
      <OwnerPanel key={workspace.root} workspace={workspace} />
      {workspaceAccess.editor && restorePath && (
        <ConfirmDialog
          title="Проверить и восстановить данные из копии?"
          message="Перед изменением данных архив будет полностью проверен. Текущее состояние сохранится в страховочную копию."
          confirmLabel="Проверить и восстановить"
          onClose={() => setRestorePath("")}
          onConfirm={restore}
        />
      )}
    </div>
  );
}

export function About() {
  const version = packageInfo.version;
  return (
    <div className="about-layout">
      <section className="surface about-hero">
        <div className="surface-body">
          <div className="brand-mark large">СБК</div>
          <h2>СБК Инструменты</h2>
          <p>
            Открытый набор независимых настольных инструментов для расчётов,
            документов, договорного опыта и кадров.
          </p>
          <div className="about-badges">
            <span>Версия {version}</span>
            <span>GPL-3.0</span>
            <span>Windows · macOS</span>
          </div>
          <p>Издатель: СБК · Автор: {packageInfo.author}</p>
        </div>
      </section>
      <section className="surface">
        <div className="surface-title">
          <h2>Приватность</h2>
        </div>
        <div className="surface-body">
          <p>
            Приложение работает офлайн. Расчёты, реестры, документы и OCR не
            отправляются в облако. Сетевой сервис для обработки файлов не
            запускается.
          </p>
        </div>
      </section>
      <section className="surface">
        <div className="surface-title">
          <h2>Компоненты и лицензии</h2>
        </div>
        <div className="surface-body">
          <dl className="license-list">
            <div>
              <dt>СБК Инструменты и ScanDocument worker</dt>
              <dd>GNU GPL 3.0 only</dd>
            </div>
            <div>
              <dt>Tauri</dt>
              <dd>Apache-2.0 / MIT</dd>
            </div>
            <div>
              <dt>React</dt>
              <dd>MIT</dd>
            </div>
            <div>
              <dt>Python</dt>
              <dd>PSF License</dd>
            </div>
            <div>
              <dt>Tesseract OCR</dt>
              <dd>Apache-2.0</dd>
            </div>
            <div>
              <dt>LibreOffice</dt>
              <dd>MPL-2.0 / LGPLv3+</dd>
            </div>
            <div>
              <dt>PDFium и Python-библиотеки</dt>
              <dd>См. THIRD_PARTY_LICENSES в поставке</dd>
            </div>
          </dl>
        </div>
      </section>
    </div>
  );
}
