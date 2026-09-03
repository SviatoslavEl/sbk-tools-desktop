import { useEffect, useState } from "react";
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

interface AppSettings {
  expiryDays: 30 | 60 | 90;
  collapsedSidebar: boolean;
  historyLimit: 25 | 50 | 100 | 200;
}

export function Settings({
  collapsed,
  onCollapsed,
}: {
  collapsed: boolean;
  onCollapsed: (value: boolean) => void;
}) {
  const workspaceAccess = useWorkspaceAccess();
  const store = useRecords<AppSettings>("settings");
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [message, setMessage] = useState("");
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
  const reloadBackups = () =>
    void listBackups()
      .then(setBackups)
      .catch(() => setBackups([]));
  useEffect(() => {
    void getWorkspaceInfo().then((value) => {
      setWorkspace(value);
      const timers = readAccessTimers(value.root);
      setAccessTimers(timers);
      setRetention(timers.retentionCount);
      setRetentionDays(timers.retentionDays);
    });
    void getIntelligenceProviderStatus().then(setIntelligence);
    reloadBackups();
  }, []);
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
    const next = await getWorkspaceInfo();
    setWorkspace(next);
    window.dispatchEvent(new Event("sbk-workspace-refresh"));
    return next;
  };
  const changeWorkspaceMode = async (editor: boolean) => {
    const validationError = workspacePasswordError(workspacePassword);
    if (validationError) {
      setMessage(`Недопустимый пароль: ${validationError} ${workspacePasswordHint}`);
      return;
    }
    setMessage(editor ? "Проверяем пароль и получаем режим редактирования…" : "Освобождаем режим редактирования…");
    try {
      await switchWorkspaceMode(editor, workspacePassword);
      const next = await refreshWorkspace();
      setWorkspacePassword("");
      setMessage(next.accessMessage);
    } catch (reason) { setMessage(`Ошибка доступа: ${String(reason)}`); }
  };
  const saveWorkspacePassword = async () => {
    const validationError = workspacePasswordError(newWorkspacePassword);
    if (validationError) {
      setMessage(`Недопустимый новый пароль: ${validationError} ${workspacePasswordHint}`);
      return;
    }
    if (workspace?.accessControlled) {
      const currentValidationError = workspacePasswordError(workspacePassword);
      if (currentValidationError) {
        setMessage(`Недопустимый текущий пароль: ${currentValidationError} ${workspacePasswordHint}`);
        return;
      }
    }
    setMessage("Сохраняем пароль рабочей папки…");
    try {
      await setWorkspaceAccessPassword(workspacePassword, newWorkspacePassword);
      const next = await refreshWorkspace();
      setWorkspacePassword(""); setNewWorkspacePassword("");
      setMessage(next.accessMessage);
    } catch (reason) { setMessage(`Ошибка доступа: ${String(reason)}`); }
  };

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
    setMessage("Проверяем manifest, контрольные суммы и базы…");
    try {
      const result = path.endsWith(".enc")
        ? await verifyEncryptedBackup(path, backupPassword)
        : await verifyBackup(path);
      setMessage(
        `Проверка PASS: ${result.files} файлов, ${(result.unpackedBytes / 1024 / 1024).toFixed(1)} МБ, SHA-256 ${result.sha256}.`,
      );
    } catch (reason) {
      setMessage(`Проверка FAIL: ${String(reason)}`);
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
    setRestorePath("");
    setMessage("Восстанавливаем данные…");
    try {
      if (path.endsWith(".enc"))
        await restoreEncryptedBackup(path, backupPassword);
      else await restoreBackup(path);
      setBackupPassword("");
      setMessage("Данные восстановлены. Перезагружаем приложение…");
      window.setTimeout(() => window.location.reload(), 350);
    } catch (reason) {
      setMessage(`Восстановление не выполнено: ${String(reason)}`);
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
    <div className="settings-grid">
      <section className="surface">
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
          {workspace?.editorOwner && <div className="settings-row">
            <span>Текущий редактор</span>
            <strong>
              {workspace.editorOwner.displayName}
              {workspace.editorOwner.startedAt && <small>с {new Date(workspace.editorOwner.startedAt).toLocaleString("ru-RU")}</small>}
            </strong>
          </div>}
          <div className="settings-form workspace-password-controls">
            {workspace?.accessControlled ? <>
              <label>Пароль рабочей папки<input type="password" autoComplete="current-password" aria-invalid={Boolean(currentWorkspacePasswordError)} aria-describedby="workspace-password-hint" value={workspacePassword} onChange={(event) => setWorkspacePassword(event.target.value)} />{currentWorkspacePasswordError && <small className="field-error">{currentWorkspacePasswordError}</small>}</label>
              <p className="help-text" id="workspace-password-hint">{workspacePasswordHint}</p>
              <div className="button-row">
                <button className="primary" type="button" disabled={!workspacePassword} onClick={() => void changeWorkspaceMode(!workspace?.editor)}>{workspace?.editor ? "Перейти в режим просмотра" : "Войти в режим редактирования"}</button>
              </div>
              {workspace?.editor && <><label>Новый пароль<input type="password" autoComplete="new-password" aria-invalid={Boolean(newWorkspacePasswordError)} value={newWorkspacePassword} onChange={(event) => setNewWorkspacePassword(event.target.value)} />{newWorkspacePasswordError && <small className="field-error">{newWorkspacePasswordError}</small>}</label><button className="secondary" type="button" disabled={!workspacePassword || !newWorkspacePassword || Boolean(newWorkspacePasswordError)} onClick={() => void saveWorkspacePassword()}>Сменить пароль</button></>}
            </> : workspace?.editor ? <>
              <label>Новый пароль рабочей папки<input type="password" autoComplete="new-password" aria-invalid={Boolean(newWorkspacePasswordError)} aria-describedby="new-workspace-password-hint" value={newWorkspacePassword} onChange={(event) => setNewWorkspacePassword(event.target.value)} placeholder="От 6 до 128 символов" />{newWorkspacePasswordError && <small className="field-error">{newWorkspacePasswordError}</small>}</label>
              <p className="help-text" id="new-workspace-password-hint">{workspacePasswordHint}</p>
              <button className="primary" type="button" disabled={!newWorkspacePassword || Boolean(newWorkspacePasswordError)} onClick={() => void saveWorkspacePassword()}>Включить вход по паролю</button>
            </> : <div className="notice warning">Сейчас режим редактирования занят другим экземпляром. После его закрытия текущий экземпляр сможет войти в режим редактирования.</div>}
          </div>
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
            редактирует только один пользователь; выход из режима сразу освобождает доступ без перезапуска приложения.
          </p>
          <div className="notice warning">
            <strong>Требование к сетевой папке</strong>
            <span>
              SMB/NFS-хранилище должно поддерживать межмашинные блокировки
              файлов и атомарное переименование. Если администратор отключил эти
              механизмы, прямую общую базу использовать нельзя.
            </span>
          </div>
        </div>
      </section>
      <section className="surface">
        <div className="surface-title">
          <h2>Обновление и архивирование</h2>
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
          <label>
            Автоматически архивировать базу
            <select
              disabled={!workspaceAccess.editor}
              value={accessTimers.backupHours}
              onChange={(event) =>
                updateAccessTimers({
                  ...accessTimers,
                  backupHours: Number(event.target.value),
                })
              }
            >
              <option value="0">выключено</option>
              <option value="6">каждые 6 часов</option>
              <option value="12">каждые 12 часов</option>
              <option value="24">ежедневно</option>
              <option value="168">еженедельно</option>
            </select>
          </label>
          <div className="button-row">
            <button
              className="secondary"
              type="button"
              onClick={() => {
                window.dispatchEvent(new Event("sbk-workspace-refresh"));
                void getWorkspaceInfo().then(setWorkspace);
                reloadBackups();
                setMessage("Данные перечитаны из общей папки.");
              }}
            >
              Обновить сейчас
            </button>
          </div>
          <p className="help-text">
            Автоархивирование работает во всём приложении и выполняется только
            экземпляром-редактором. Копия сначала создаётся во временном файле,
            проверяется и затем атомарно переименовывается.
          </p>
        </div>
      </section>
      <section className="surface" data-workspace-mutation>
        <div className="surface-title">
          <h2>Интерфейс и история</h2>
        </div>
        <div className="surface-body settings-form">
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={collapsed}
              onChange={(event) => {
                onCollapsed(event.target.checked);
                void saveSettings({ collapsedSidebar: event.target.checked });
              }}
            />{" "}
            Сворачивать навигацию до значков
          </label>
          <label>
            Предупреждать об истечении документов
            <select
              value={expiryDays}
              onChange={(event) =>
                void saveSettings({
                  expiryDays: Number(
                    event.target.value,
                  ) as AppSettings["expiryDays"],
                })
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
              onChange={async (event) => {
                const limit = Number(
                  event.target.value,
                ) as AppSettings["historyLimit"];
                await saveSettings({ historyLimit: limit });
                const removed = await pruneHistory(limit);
                setMessage(
                  `Ограничение истории применено: удалено старых версий — ${removed}.`,
                );
              }}
            >
              <option value="25">25</option>
              <option value="50">50</option>
              <option value="100">100</option>
              <option value="200">200</option>
            </select>
          </label>
        </div>
      </section>
      <section className="surface">
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
      <section className="surface">
        <div className="surface-title">
          <h2>Защита резервной копии</h2>
        </div>
        <div className="surface-body settings-form">
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={encryptBackup}
              onChange={(event) => setEncryptBackup(event.target.checked)}
            />{" "}
            Шифровать новую копию (Argon2id + XChaCha20-Poly1305)
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
            копии; запуск приложения пароля не требует.
          </p>
        </div>
      </section>
      <section className="surface backup-surface">
        <div className="surface-title">
          <h2>Резервное копирование</h2>
          <span>{backups.length} копий</span>
        </div>
        <div className="surface-body settings-actions">
          <p>
            Копия содержит отдельные базы всех инструментов и сохранённые
            вложения.
          </p>
          <div className="button-row">
            <button
              className="primary"
              disabled={!workspaceAccess.editor}
              type="button"
              onClick={() => void backup()}
            >
              Создать резервную копию
            </button>
            <button
              className="secondary"
              disabled={!workspaceAccess.editor}
              type="button"
              onClick={() => void selectRestore()}
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
              onClick={async () => {
                const removed = await rotateBackups(retention, retentionDays);
                setMessage(
                  `Ротация завершена: удалено ${removed}. Закреплённые копии сохранены.`,
                );
                reloadBackups();
              }}
            >
              Применить ротацию
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
                    onClick={() => void verify(item.path)}
                  >
                    Проверить
                  </button>
                  <button
                    className="link-button"
                    disabled={!workspaceAccess.editor}
                    type="button"
                    onClick={async () => {
                      await setBackupPinned(item.fileName, !item.pinned);
                      reloadBackups();
                    }}
                  >
                    {item.pinned ? "Открепить" : "Закрепить"}
                  </button>
                  <button
                    className="link-button danger"
                    disabled={!workspaceAccess.editor || item.pinned}
                    type="button"
                    onClick={async () => {
                      if (
                        !window.confirm(
                          `Удалить резервную копию ${item.fileName}?`,
                        )
                      )
                        return;
                      await deleteBackup(item.fileName);
                      reloadBackups();
                    }}
                  >
                    Удалить
                  </button>
                </div>
              </div>
            ))}
          </div>
          {message && (
            <div
              className={`notice ${message.startsWith("Ошибка") || message.startsWith("Восстановление не") || message.startsWith("Проверка FAIL") ? "error" : "success"}`}
            >
              {message}
            </div>
          )}
        </div>
      </section>
      <section className="surface">
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
      <section className="surface">
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
              onClick={() => void checkAttachments(false)}
            >
              Проверить
            </button>
            <button
              className="secondary danger"
              disabled={!workspaceAccess.editor}
              type="button"
              onClick={() => {
                if (
                  window.confirm(
                    "Удалить все неподключённые вложения? Текущие записи и история не изменятся.",
                  )
                )
                  void checkAttachments(true);
              }}
            >
              Очистить неподключённые
            </button>
          </div>
        </div>
      </section>
      {workspaceAccess.editor && restorePath && (
        <ConfirmDialog
          title="Проверить и восстановить данные из копии?"
          message="Перед изменением данных архив будет полностью проверен. Текущее состояние сохранится в страховочную копию."
          confirmLabel="Проверить и восстановить"
          onClose={() => setRestorePath("")}
          onConfirm={() => void restore()}
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
