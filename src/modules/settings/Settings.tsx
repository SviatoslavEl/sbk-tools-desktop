import { useEffect, useState } from "react";
import { ConfirmDialog } from "../../components/Dialog";
import { useRecords } from "../../hooks/useRecords";
import packageInfo from "../../../package.json";
import { chooseDirectory, chooseOpenPath } from "../../lib/files";
import { createBackup, deleteBackup, getWorkspaceInfo, listBackups, restoreBackup, rotateBackups, setBackupPinned, setWorkspaceLocation, verifyBackup, type BackupInfo, type BackupListItem, type WorkspaceInfo } from "../../lib/storage";

interface AppSettings { expiryDays: 30 | 60 | 90; collapsedSidebar: boolean }

export function Settings({ collapsed, onCollapsed }: { collapsed: boolean; onCollapsed: (value: boolean) => void }) {
  const store = useRecords<AppSettings>("settings");
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [message, setMessage] = useState("");
  const [restorePath, setRestorePath] = useState("");
  const [backups, setBackups] = useState<BackupListItem[]>([]);
  const [retention, setRetention] = useState(10);
  const expiryDays = store.records.find((record) => record.title === "application")?.payload.expiryDays || 60;
  const reloadBackups = () => void listBackups().then(setBackups).catch(() => setBackups([]));
  useEffect(() => { void getWorkspaceInfo().then(setWorkspace); reloadBackups(); }, []);

  const saveSettings = async (patch: Partial<AppSettings>) => {
    const existing = store.records.find((record) => record.title === "application");
    await store.save("application", { expiryDays, collapsedSidebar: collapsed, ...existing?.payload, ...patch }, existing?.id);
  };
  const backup = async () => {
    setMessage("Создаём резервную копию…");
    try {
      const result: BackupInfo = await createBackup();
      setMessage(`Резервная копия создана: ${result.fileName} (${(result.sizeBytes / 1024 / 1024).toFixed(1)} МБ)`);
      reloadBackups();
    } catch (reason) { setMessage(`Ошибка: ${String(reason)}`); }
  };
  const verify = async (path: string) => { setMessage("Проверяем manifest, контрольные суммы и базы…"); try { const result = await verifyBackup(path); setMessage(`Проверка PASS: ${result.files} файлов, ${(result.unpackedBytes / 1024 / 1024).toFixed(1)} МБ, SHA-256 ${result.sha256}.`); } catch (reason) { setMessage(`Проверка FAIL: ${String(reason)}`); } };
  const selectRestore = async () => {
    const path = await chooseOpenPath("Выберите резервную копию", ["sbkbackup"]);
    if (path) setRestorePath(path);
  };
  const restore = async () => {
    const path = restorePath; setRestorePath(""); setMessage("Восстанавливаем данные…");
    try { await restoreBackup(path); setMessage("Данные восстановлены. Перезагружаем приложение…"); window.setTimeout(() => window.location.reload(), 350); }
    catch (reason) { setMessage(`Восстановление не выполнено: ${String(reason)}`); }
  };
  const selectWorkspace = async () => {
    const path = await chooseDirectory("Выберите папку для переносимых данных");
    if (!path) return;
    try {
      const next = await setWorkspaceLocation(path);
      setMessage(`Новая рабочая папка: ${next}. Перезапустите приложение; текущие данные автоматически не переносятся.`);
    } catch (reason) { setMessage(`Ошибка: ${String(reason)}`); }
  };

  return <div className="settings-grid">
    <section className="surface"><div className="surface-title"><h2>Рабочая папка</h2><span className={`status ${workspace?.writable ? "success" : "danger"}`}>{workspace?.writable ? "✓ Доступна для записи" : "Проверяем…"}</span></div><div className="surface-body"><div className="settings-row"><span>Режим хранения</span><strong>{workspace?.portable ? "Рядом с приложением" : "Выбранная папка"}</strong></div><div className="settings-row path-row"><span>Путь</span><strong>{workspace?.root || "Определяем…"}</strong></div><div className="settings-row"><span>Версия базы</span><strong>{workspace?.schemaVersion || "—"}</strong></div><div className="settings-row"><span>Свободно</span><strong>{workspace?.freeSpaceBytes ? `${(workspace.freeSpaceBytes / 1024 / 1024 / 1024).toFixed(1)} ГБ` : "—"}</strong></div><button className="secondary" type="button" onClick={() => void selectWorkspace()}>Выбрать другую папку</button><p className="help-text">Папку ProductData можно переносить вместе с приложением. Перед сменой расположения создайте резервную копию; переключение произойдёт после перезапуска.</p></div></section>
    <section className="surface"><div className="surface-title"><h2>Интерфейс</h2></div><div className="surface-body settings-form"><label className="checkbox-row"><input type="checkbox" checked={collapsed} onChange={(event) => { onCollapsed(event.target.checked); void saveSettings({ collapsedSidebar: event.target.checked }); }} /> Сворачивать навигацию до значков</label><label>Предупреждать об истечении документов<select value={expiryDays} onChange={(event) => void saveSettings({ expiryDays: Number(event.target.value) as AppSettings["expiryDays"] })}><option value="30">за 30 дней</option><option value="60">за 60 дней</option><option value="90">за 90 дней</option></select></label></div></section>
    <section className="surface backup-surface"><div className="surface-title"><h2>Резервное копирование</h2><span>{backups.length} копий</span></div><div className="surface-body settings-actions"><p>Копия содержит отдельные базы всех инструментов и сохранённые вложения.</p><div className="button-row"><button className="primary" type="button" onClick={() => void backup()}>Создать резервную копию</button><button className="secondary" type="button" onClick={() => void selectRestore()}>Проверить / восстановить файл</button></div><div className="retention-row"><label>Хранить незакреплённых копий<input type="number" min="1" max="100" value={retention} onChange={(event) => setRetention(Number(event.target.value))} /></label><button className="secondary small" type="button" onClick={async () => { const removed = await rotateBackups(retention); setMessage(`Ротация завершена: удалено ${removed}. Закреплённые копии сохранены.`); reloadBackups(); }}>Применить ротацию</button></div><div className="backup-list">{backups.map((item) => <div key={item.fileName}><span><strong>{item.pinned ? "★ " : ""}{item.fileName}</strong><small>{new Date(item.modifiedAt).toLocaleString("ru-RU")} · {(item.sizeBytes / 1024 / 1024).toFixed(1)} МБ</small></span><div className="button-row"><button className="link-button" type="button" onClick={() => void verify(item.path)}>Проверить</button><button className="link-button" type="button" onClick={async () => { await setBackupPinned(item.fileName, !item.pinned); reloadBackups(); }}>{item.pinned ? "Открепить" : "Закрепить"}</button><button className="link-button danger" disabled={item.pinned} type="button" onClick={async () => { if (!window.confirm(`Удалить резервную копию ${item.fileName}?`)) return; await deleteBackup(item.fileName); reloadBackups(); }}>Удалить</button></div></div>)}</div>{message && <div className={`notice ${message.startsWith("Ошибка") || message.startsWith("Восстановление не") || message.startsWith("Проверка FAIL") ? "error" : "success"}`}>{message}</div>}</div></section>
    <section className="surface"><div className="surface-title"><h2>Изоляция данных</h2></div><div className="surface-body"><ul className="plain-list"><li>Калькулятор: отдельная база и экспорт расчётов.</li><li>Сканер: отдельные задания и шаблоны факсимиле.</li><li>Опыт по договорам: самостоятельный реестр.</li><li>Кадры: отдельный реестр и собственные документы.</li><li>Закупки: отдельная база; связи создаются только явным снимком пользователя.</li></ul></div></section>
    {restorePath && <ConfirmDialog title="Проверить и восстановить данные из копии?" message="Перед изменением данных архив будет полностью проверен. Текущее состояние сохранится в страховочную копию." confirmLabel="Проверить и восстановить" onClose={() => setRestorePath("")} onConfirm={() => void restore()} />}
  </div>;
}

export function About() {
  const version = packageInfo.version;
  return <div className="about-layout"><section className="surface about-hero"><div className="surface-body"><div className="brand-mark large">СБК</div><h2>СБК Инструменты</h2><p>Открытый набор независимых настольных инструментов для расчётов, документов, договорного опыта и кадров.</p><div className="about-badges"><span>Версия {version}</span><span>GPL-3.0</span><span>Windows · macOS</span></div></div></section><section className="surface"><div className="surface-title"><h2>Приватность</h2></div><div className="surface-body"><p>Приложение работает офлайн. Расчёты, реестры, документы и OCR не отправляются в облако. Сетевой сервис для обработки файлов не запускается.</p></div></section><section className="surface"><div className="surface-title"><h2>Компоненты и лицензии</h2></div><div className="surface-body"><dl className="license-list"><div><dt>СБК Инструменты и ScanDocument worker</dt><dd>GNU GPL 3.0 only</dd></div><div><dt>Tauri</dt><dd>Apache-2.0 / MIT</dd></div><div><dt>React</dt><dd>MIT</dd></div><div><dt>Python</dt><dd>PSF License</dd></div><div><dt>Tesseract OCR</dt><dd>Apache-2.0</dd></div><div><dt>LibreOffice</dt><dd>MPL-2.0 / LGPLv3+</dd></div><div><dt>PDFium и Python-библиотеки</dt><dd>См. THIRD_PARTY_LICENSES в поставке</dd></div></dl></div></section></div>;
}
