import { useEffect, useState } from "react";
import { ConfirmDialog } from "../../components/Dialog";
import { useRecords } from "../../hooks/useRecords";
import packageInfo from "../../../package.json";
import { chooseDirectory, chooseOpenPath } from "../../lib/files";
import { createBackup, getWorkspaceInfo, restoreBackup, setWorkspaceLocation, type BackupInfo, type WorkspaceInfo } from "../../lib/storage";

interface AppSettings { expiryDays: 30 | 60 | 90; collapsedSidebar: boolean }

export function Settings({ collapsed, onCollapsed }: { collapsed: boolean; onCollapsed: (value: boolean) => void }) {
  const store = useRecords<AppSettings>("settings");
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [message, setMessage] = useState("");
  const [restorePath, setRestorePath] = useState("");
  const expiryDays = store.records.find((record) => record.title === "application")?.payload.expiryDays || 60;
  useEffect(() => { void getWorkspaceInfo().then(setWorkspace); }, []);

  const saveSettings = async (patch: Partial<AppSettings>) => {
    const existing = store.records.find((record) => record.title === "application");
    await store.save("application", { expiryDays, collapsedSidebar: collapsed, ...existing?.payload, ...patch }, existing?.id);
  };
  const backup = async () => {
    setMessage("Создаём резервную копию…");
    try {
      const result: BackupInfo = await createBackup();
      setMessage(`Резервная копия создана: ${result.fileName} (${(result.sizeBytes / 1024 / 1024).toFixed(1)} МБ)`);
    } catch (reason) { setMessage(`Ошибка: ${String(reason)}`); }
  };
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
    <section className="surface"><div className="surface-title"><h2>Резервное копирование</h2></div><div className="surface-body settings-actions"><p>Копия содержит отдельные базы всех инструментов и сохранённые вложения.</p><button className="primary" type="button" onClick={() => void backup()}>Создать резервную копию</button><button className="secondary" type="button" onClick={() => void selectRestore()}>Восстановить из копии</button>{message && <div className={`notice ${message.startsWith("Ошибка") || message.startsWith("Восстановление не") ? "error" : "success"}`}>{message}</div>}</div></section>
    <section className="surface"><div className="surface-title"><h2>Изоляция данных</h2></div><div className="surface-body"><ul className="plain-list"><li>Калькулятор: отдельная база и экспорт расчётов.</li><li>Сканер: отдельные задания и шаблоны факсимиле.</li><li>Опыт по договорам: самостоятельный реестр без вложений.</li><li>Кадры: отдельный реестр и собственные документы.</li></ul></div></section>
    {restorePath && <ConfirmDialog title="Восстановить данные из копии?" message="Текущее состояние сначала будет сохранено в страховочную резервную копию, затем данные выбранного архива заменят записи приложения." confirmLabel="Восстановить" onClose={() => setRestorePath("")} onConfirm={() => void restore()} />}
  </div>;
}

export function About() {
  const version = packageInfo.version;
  return <div className="about-layout"><section className="surface about-hero"><div className="surface-body"><div className="brand-mark large">СБК</div><h2>СБК Инструменты</h2><p>Открытый набор независимых настольных инструментов для расчётов, документов, договорного опыта и кадров.</p><div className="about-badges"><span>Версия {version}</span><span>GPL-3.0</span><span>Windows · macOS</span></div></div></section><section className="surface"><div className="surface-title"><h2>Приватность</h2></div><div className="surface-body"><p>Приложение работает офлайн. Расчёты, реестры, документы и OCR не отправляются в облако. Сетевой сервис для обработки файлов не запускается.</p></div></section><section className="surface"><div className="surface-title"><h2>Компоненты и лицензии</h2></div><div className="surface-body"><dl className="license-list"><div><dt>СБК Инструменты и ScanDocument worker</dt><dd>GNU GPL 3.0 only</dd></div><div><dt>Tauri</dt><dd>Apache-2.0 / MIT</dd></div><div><dt>React</dt><dd>MIT</dd></div><div><dt>Python</dt><dd>PSF License</dd></div><div><dt>Tesseract OCR</dt><dd>Apache-2.0</dd></div><div><dt>LibreOffice</dt><dd>MPL-2.0 / LGPLv3+</dd></div><div><dt>PDFium и Python-библиотеки</dt><dd>См. THIRD_PARTY_LICENSES в поставке</dd></div></dl></div></section></div>;
}
