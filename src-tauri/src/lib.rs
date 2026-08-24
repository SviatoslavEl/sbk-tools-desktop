use chrono::Utc;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use calamine::{open_workbook_auto, Reader};
use fs2::FileExt;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use std::{collections::HashMap, io::BufRead, io::BufReader};
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;
use walkdir::WalkDir;
use zip::write::SimpleFileOptions;
use rust_xlsxwriter::{Format, Workbook};

const SCHEMA_VERSION: i64 = 1;
const MODULES: [&str; 5] = [
    "settings",
    "calculator",
    "scanner",
    "contract-experience",
    "staff",
];
const WORKSPACE_DIRS: [&str; 10] = [
    "settings",
    "calculator",
    "scanner",
    "contract-experience",
    "staff",
    "attachments",
    "backups",
    "logs",
    "runtime-cache",
    "exports",
];

#[derive(Clone)]
struct AppState {
    workspace: Arc<Workspace>,
    scanner_jobs: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

struct Workspace {
    root: PathBuf,
    portable: bool,
    writable: bool,
    _lock: File,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceInfo {
    root: String,
    portable: bool,
    writable: bool,
    schema_version: i64,
    free_space_bytes: u64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredRecord {
    id: String,
    title: String,
    payload: Value,
    archived: bool,
    created_at: String,
    updated_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AttachmentInfo {
    relative_path: String,
    file_name: String,
    size_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BackupInfo {
    path: String,
    file_name: String,
    size_bytes: u64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SpreadsheetData {
    sheet_name: Option<String>,
    rows: Vec<Vec<String>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HistoryEntry {
    action: String,
    created_at: String,
}

fn workspace_pointer_path() -> Result<PathBuf, String> {
    dirs::config_dir()
        .map(|path| path.join("SBKTools").join("workspace.txt"))
        .ok_or_else(|| "Не удалось определить папку настроек системы".to_string())
}

fn adjacent_product_directory() -> Result<PathBuf, String> {
    if let Some(override_path) = std::env::var_os("SBK_TOOLS_WORKSPACE") {
        return Ok(PathBuf::from(override_path));
    }

    let executable = std::env::current_exe()
        .map_err(|error| format!("Не удалось определить расположение приложения: {error}"))?;

    #[cfg(target_os = "macos")]
    {
        if let Some(bundle) = executable
            .ancestors()
            .find(|path| path.extension().is_some_and(|extension| extension == "app"))
        {
            if let Some(parent) = bundle.parent() {
                return Ok(parent.join("ProductData"));
            }
        }
    }

    executable
        .parent()
        .map(|parent| parent.join("ProductData"))
        .ok_or_else(|| "Не удалось определить папку portable-данных".to_string())
}

fn product_directory() -> Result<(PathBuf, bool), String> {
    if let Some(override_path) = std::env::var_os("SBK_TOOLS_WORKSPACE") {
        return Ok((PathBuf::from(override_path), false));
    }
    if let Ok(pointer) = workspace_pointer_path() {
        if let Ok(content) = fs::read_to_string(pointer) {
            let selected = PathBuf::from(content.trim());
            if !content.trim().is_empty() {
                return Ok((selected, false));
            }
        }
    }
    adjacent_product_directory().map(|path| (path, true))
}

fn ensure_workspace(root: &Path) -> Result<(), String> {
    fs::create_dir_all(root)
        .map_err(|error| format!("Не удалось создать рабочую папку {}: {error}", root.display()))?;
    for directory in WORKSPACE_DIRS {
        fs::create_dir_all(root.join(directory))
            .map_err(|error| format!("Не удалось подготовить раздел {directory}: {error}"))?;
    }
    Ok(())
}

fn open_workspace() -> Result<Workspace, String> {
    let (preferred, mut portable) = product_directory()?;
    let mut root = preferred.clone();
    if ensure_workspace(&root).is_err() {
        root = dirs::data_local_dir()
            .ok_or_else(|| format!("Папка {} недоступна, резервное расположение не найдено", preferred.display()))?
            .join("SBKTools")
            .join("ProductData");
        portable = false;
        ensure_workspace(&root)?;
    }
    let probe = root.join(".write-probe");
    let writable = fs::write(&probe, b"ok")
        .and_then(|_| fs::remove_file(&probe))
        .is_ok();
    if !writable {
        return Err(format!(
            "Папка {} недоступна для записи. Переместите приложение в доступное место или задайте SBK_TOOLS_WORKSPACE.",
            root.display()
        ));
    }
    let lock = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .open(root.join(".workspace.lock"))
        .map_err(|error| format!("Не удалось открыть блокировку workspace: {error}"))?;
    lock.try_lock_exclusive().map_err(|_| {
        "Эта рабочая папка уже открыта в другом экземпляре приложения.".to_string()
    })?;
    Ok(Workspace {
        root,
        portable,
        writable,
        _lock: lock,
    })
}

fn validated_module(module: &str) -> Result<&str, String> {
    MODULES
        .iter()
        .find(|candidate| **candidate == module)
        .copied()
        .ok_or_else(|| "Неизвестный раздел данных".to_string())
}

fn database_path(root: &Path, module: &str) -> Result<PathBuf, String> {
    Ok(root.join(validated_module(module)?).join("data.sqlite3"))
}

fn backup_database_before_migration(path: &Path, module: &str) -> Result<(), String> {
    if !path.exists() || fs::metadata(path).map_err(|error| error.to_string())?.len() == 0 {
        return Ok(());
    }
    let workspace = path
        .parent()
        .and_then(Path::parent)
        .ok_or_else(|| "Некорректный путь базы".to_string())?;
    let destination = workspace.join("backups").join(format!(
        "before-migration-{}-{}.sqlite3",
        module,
        Utc::now().format("%Y%m%d-%H%M%S")
    ));
    fs::copy(path, destination)
        .map_err(|error| format!("Не удалось сохранить базу перед миграцией: {error}"))?;
    Ok(())
}

fn open_database(root: &Path, module: &str) -> Result<Connection, String> {
    let path = database_path(root, module)?;
    let existed = path.exists();
    let mut connection = Connection::open(&path)
        .map_err(|error| format!("Не удалось открыть базу раздела {module}: {error}"))?;
    connection
        .pragma_update(None, "journal_mode", "WAL")
        .map_err(|error| format!("Не удалось включить безопасный журнал: {error}"))?;
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .map_err(|error| format!("Не удалось включить связи базы: {error}"))?;
    let current_version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    if current_version > SCHEMA_VERSION {
        return Err(format!(
            "База раздела {module} создана более новой версией приложения."
        ));
    }
    if existed && current_version < SCHEMA_VERSION {
        backup_database_before_migration(&path, module)?;
    }
    if current_version < 1 {
        let transaction = connection.transaction().map_err(|error| error.to_string())?;
        transaction
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS records (
                    id TEXT PRIMARY KEY NOT NULL,
                    title TEXT NOT NULL,
                    payload TEXT NOT NULL,
                    archived INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_records_updated ON records(archived, updated_at DESC);
                CREATE TABLE IF NOT EXISTS history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    record_id TEXT NOT NULL,
                    action TEXT NOT NULL,
                    snapshot TEXT,
                    created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_history_record ON history(record_id, created_at DESC);
                PRAGMA user_version = 1;",
            )
            .map_err(|error| format!("Не удалось создать схему раздела {module}: {error}"))?;
        transaction.commit().map_err(|error| error.to_string())?;
    }
    connection
        .execute_batch("PRAGMA wal_autocheckpoint=1000; PRAGMA busy_timeout=5000;")
        .map_err(|error| error.to_string())?;
    Ok(connection)
}

fn parse_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<StoredRecord> {
    let payload: String = row.get(2)?;
    Ok(StoredRecord {
        id: row.get(0)?,
        title: row.get(1)?,
        payload: serde_json::from_str(&payload).unwrap_or(Value::Null),
        archived: row.get::<_, i64>(3)? != 0,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
    })
}

#[tauri::command]
fn workspace_info(state: State<'_, AppState>) -> Result<WorkspaceInfo, String> {
    Ok(WorkspaceInfo {
        root: state.workspace.root.to_string_lossy().into_owned(),
        portable: state.workspace.portable,
        writable: state.workspace.writable,
        schema_version: SCHEMA_VERSION,
        free_space_bytes: fs2::available_space(&state.workspace.root).unwrap_or(0),
    })
}

#[tauri::command]
fn set_workspace_location(path: String) -> Result<String, String> {
    let selected = PathBuf::from(path.trim());
    if selected.as_os_str().is_empty() {
        return Err("Выберите папку".to_string());
    }
    let root = if selected.file_name().is_some_and(|name| name == "ProductData") {
        selected
    } else {
        selected.join("ProductData")
    };
    ensure_workspace(&root)?;
    let probe = root.join(".write-probe");
    fs::write(&probe, b"ok").and_then(|_| fs::remove_file(&probe))
        .map_err(|error| format!("Выбранная папка недоступна для записи: {error}"))?;
    let pointer = workspace_pointer_path()?;
    if let Some(parent) = pointer.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(&pointer, root.to_string_lossy().as_bytes()).map_err(|error| error.to_string())?;
    Ok(root.to_string_lossy().into_owned())
}

#[tauri::command]
fn read_xlsx(path: String) -> Result<SpreadsheetData, String> {
    let mut workbook = open_workbook_auto(&path)
        .map_err(|error| format!("Не удалось открыть Excel-файл: {error}"))?;
    let sheet_name = workbook.sheet_names().first().cloned()
        .ok_or_else(|| "В книге нет листов".to_string())?;
    let range = workbook.worksheet_range(&sheet_name)
        .map_err(|error| format!("Не удалось прочитать лист: {error}"))?;
    let rows = range.rows().map(|row| row.iter().map(|cell| cell.to_string()).collect()).collect();
    Ok(SpreadsheetData { sheet_name: Some(sheet_name), rows })
}

#[tauri::command]
fn write_xlsx(path: String, data: SpreadsheetData) -> Result<(), String> {
    let mut workbook = Workbook::new();
    let worksheet = workbook.add_worksheet();
    if let Some(name) = data.sheet_name.as_deref() {
        worksheet.set_name(name).map_err(|error| error.to_string())?;
    }
    let header = Format::new().set_bold().set_background_color("#DCEFD8");
    for (row_index, row) in data.rows.iter().enumerate() {
        for (column_index, value) in row.iter().enumerate() {
            let row_number = u32::try_from(row_index).map_err(|_| "Слишком много строк".to_string())?;
            let column_number = u16::try_from(column_index).map_err(|_| "Слишком много колонок".to_string())?;
            if row_index == 0 {
                worksheet.write_string_with_format(row_number, column_number, value, &header)
                    .map_err(|error| error.to_string())?;
            } else {
                worksheet.write_string(row_number, column_number, value)
                    .map_err(|error| error.to_string())?;
            }
        }
    }
    worksheet.autofit();
    workbook.save(path).map_err(|error| format!("Не удалось сохранить Excel-файл: {error}"))
}

#[tauri::command]
fn list_records(
    state: State<'_, AppState>,
    module: String,
    include_archived: Option<bool>,
) -> Result<Vec<StoredRecord>, String> {
    let connection = open_database(&state.workspace.root, &module)?;
    let sql = if include_archived.unwrap_or(false) {
        "SELECT id, title, payload, archived, created_at, updated_at FROM records ORDER BY updated_at DESC"
    } else {
        "SELECT id, title, payload, archived, created_at, updated_at FROM records WHERE archived = 0 ORDER BY updated_at DESC"
    };
    let mut statement = connection.prepare(sql).map_err(|error| error.to_string())?;
    statement
        .query_map([], parse_record)
        .map_err(|error| error.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn get_record(
    state: State<'_, AppState>,
    module: String,
    id: String,
) -> Result<Option<StoredRecord>, String> {
    let connection = open_database(&state.workspace.root, &module)?;
    connection
        .query_row(
            "SELECT id, title, payload, archived, created_at, updated_at FROM records WHERE id = ?1",
            [id],
            parse_record,
        )
        .optional()
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn record_history(state: State<'_, AppState>, module: String, id: String) -> Result<Vec<HistoryEntry>, String> {
    let connection = open_database(&state.workspace.root, &module)?;
    let mut statement = connection.prepare(
        "SELECT action, created_at FROM history WHERE record_id = ?1 ORDER BY created_at DESC LIMIT 100",
    ).map_err(|error| error.to_string())?;
    statement.query_map([id], |row| Ok(HistoryEntry { action: row.get(0)?, created_at: row.get(1)? }))
        .map_err(|error| error.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn upsert_record(
    state: State<'_, AppState>,
    module: String,
    id: Option<String>,
    title: String,
    payload: Value,
) -> Result<StoredRecord, String> {
    if title.trim().is_empty() {
        return Err("Укажите название записи".to_string());
    }
    let mut connection = open_database(&state.workspace.root, &module)?;
    let record_id = id.unwrap_or_else(|| Uuid::new_v4().to_string());
    let now = Utc::now().to_rfc3339();
    let payload_text = serde_json::to_string(&payload).map_err(|error| error.to_string())?;
    let transaction = connection.transaction().map_err(|error| error.to_string())?;
    let previous: Option<String> = transaction
        .query_row("SELECT payload FROM records WHERE id = ?1", [&record_id], |row| row.get(0))
        .optional()
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "INSERT INTO records(id, title, payload, archived, created_at, updated_at)
             VALUES (?1, ?2, ?3, 0, ?4, ?4)
             ON CONFLICT(id) DO UPDATE SET title = excluded.title, payload = excluded.payload,
                 archived = 0, updated_at = excluded.updated_at",
            params![record_id, title.trim(), payload_text, now],
        )
        .map_err(|error| format!("Не удалось сохранить запись: {error}"))?;
    transaction
        .execute(
            "INSERT INTO history(record_id, action, snapshot, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![record_id, if previous.is_some() { "updated" } else { "created" }, previous, now],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    get_record(state, module, record_id)?
        .ok_or_else(|| "Запись не найдена после сохранения".to_string())
}

#[tauri::command]
fn archive_record(
    state: State<'_, AppState>,
    module: String,
    id: String,
    archived: bool,
) -> Result<(), String> {
    let connection = open_database(&state.workspace.root, &module)?;
    let now = Utc::now().to_rfc3339();
    let changed = connection
        .execute(
            "UPDATE records SET archived = ?1, updated_at = ?2 WHERE id = ?3",
            params![archived as i64, now, id],
        )
        .map_err(|error| error.to_string())?;
    if changed == 0 {
        return Err("Запись не найдена".to_string());
    }
    connection
        .execute(
            "INSERT INTO history(record_id, action, snapshot, created_at) VALUES (?1, ?2, NULL, ?3)",
            params![id, if archived { "archived" } else { "restored" }, now],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn safe_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|character| {
            if character.is_alphanumeric() || matches!(character, '.' | '-' | '_' | ' ') {
                character
            } else {
                '_'
            }
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.');
    if trimmed.is_empty() {
        "file".to_string()
    } else {
        trimmed.chars().take(140).collect()
    }
}

#[tauri::command]
fn copy_attachment(
    state: State<'_, AppState>,
    source_path: String,
    module: String,
    record_id: String,
) -> Result<AttachmentInfo, String> {
    validated_module(&module)?;
    let source = PathBuf::from(source_path);
    if !source.is_file() {
        return Err("Выбранный файл не найден".to_string());
    }
    let original_name = source
        .file_name()
        .and_then(|name| name.to_str())
        .map(safe_file_name)
        .unwrap_or_else(|| "file".to_string());
    let relative = PathBuf::from("attachments")
        .join(&module)
        .join(safe_file_name(&record_id))
        .join(format!("{}-{}", Uuid::new_v4(), original_name));
    let destination = state.workspace.root.join(&relative);
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::copy(&source, &destination)
        .map_err(|error| format!("Не удалось скопировать вложение: {error}"))?;
    let size_bytes = fs::metadata(&destination).map_err(|error| error.to_string())?.len();
    Ok(AttachmentInfo {
        relative_path: relative.to_string_lossy().replace('\\', "/"),
        file_name: original_name,
        size_bytes,
    })
}

fn atomic_write(destination: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let temporary = destination.with_extension(format!(
        "{}.part",
        destination.extension().and_then(|part| part.to_str()).unwrap_or("tmp")
    ));
    let result = (|| {
        let mut file = File::create(&temporary).map_err(|error| error.to_string())?;
        file.write_all(bytes).map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        fs::rename(&temporary, destination).map_err(|error| error.to_string())
    })();
    let _ = fs::remove_file(&temporary);
    result
}

#[tauri::command]
fn write_text_file(path: String, content: String) -> Result<(), String> {
    atomic_write(&PathBuf::from(path), content.as_bytes())
}

#[tauri::command]
fn read_text_file(path: String, max_bytes: Option<u64>) -> Result<String, String> {
    let path = PathBuf::from(path);
    let metadata = fs::metadata(&path).map_err(|error| format!("Файл не найден: {error}"))?;
    let limit = max_bytes.unwrap_or(20 * 1024 * 1024);
    if metadata.len() > limit {
        return Err(format!("Файл больше допустимого размера {} МБ", limit / 1024 / 1024));
    }
    fs::read_to_string(path)
        .map_err(|error| format!("Не удалось прочитать текстовый файл: {error}"))
}

#[tauri::command]
fn read_binary_file(path: String, max_bytes: Option<u64>) -> Result<String, String> {
    let path = PathBuf::from(path);
    let metadata = fs::metadata(&path).map_err(|error| format!("Файл не найден: {error}"))?;
    let limit = max_bytes.unwrap_or(24 * 1024 * 1024);
    if metadata.len() > limit {
        return Err(format!("Файл больше допустимого размера {} МБ", limit / 1024 / 1024));
    }
    let bytes = fs::read(&path).map_err(|error| error.to_string())?;
    let mime = match path.extension().and_then(|value| value.to_str()).unwrap_or("").to_ascii_lowercase().as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => "image/png",
    };
    Ok(format!("data:{mime};base64,{}", BASE64.encode(bytes)))
}

fn add_directory_to_zip<W: Write + std::io::Seek>(
    writer: &mut zip::ZipWriter<W>,
    source: &Path,
    prefix: &str,
) -> Result<(), String> {
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    for entry in WalkDir::new(source).follow_links(false) {
        let entry = entry.map_err(|error| error.to_string())?;
        if entry.file_type().is_symlink() || !entry.file_type().is_file() {
            continue;
        }
        let relative = entry.path().strip_prefix(source).map_err(|error| error.to_string())?;
        let name = format!("{}/{}", prefix, relative.to_string_lossy().replace('\\', "/"));
        writer.start_file(name, options).map_err(|error| error.to_string())?;
        let mut input = File::open(entry.path()).map_err(|error| error.to_string())?;
        std::io::copy(&mut input, writer).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn create_backup(state: State<'_, AppState>, module: Option<String>) -> Result<BackupInfo, String> {
    let selected_modules: Vec<&str> = match module.as_deref() {
        Some(name) => vec![validated_module(name)?],
        None => MODULES.to_vec(),
    };
    for name in &selected_modules {
        let connection = open_database(&state.workspace.root, name)?;
        connection
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
            .map_err(|error| error.to_string())?;
    }
    let label = module.as_deref().unwrap_or("all");
    let file_name = format!("sbk-tools-{}-{}.sbkbackup", label, Utc::now().format("%Y%m%d-%H%M%S"));
    let destination = state.workspace.root.join("backups").join(&file_name);
    let temporary = destination.with_extension("sbkbackup.part");
    let file = File::create(&temporary).map_err(|error| error.to_string())?;
    let mut archive = zip::ZipWriter::new(file);
    let manifest = serde_json::json!({
        "product": "sbk-tools-desktop",
        "schemaVersion": SCHEMA_VERSION,
        "createdAt": Utc::now().to_rfc3339(),
        "modules": selected_modules,
    });
    archive
        .start_file("manifest.json", SimpleFileOptions::default())
        .map_err(|error| error.to_string())?;
    archive
        .write_all(manifest.to_string().as_bytes())
        .map_err(|error| error.to_string())?;
    for name in &selected_modules {
        add_directory_to_zip(&mut archive, &state.workspace.root.join(name), name)?;
        let attachments = state.workspace.root.join("attachments").join(name);
        if attachments.exists() {
            add_directory_to_zip(&mut archive, &attachments, &format!("attachments/{name}"))?;
        }
    }
    archive.finish().map_err(|error| error.to_string())?;
    fs::rename(&temporary, &destination).map_err(|error| error.to_string())?;
    let size_bytes = fs::metadata(&destination).map_err(|error| error.to_string())?.len();
    Ok(BackupInfo {
        path: destination.to_string_lossy().into_owned(),
        file_name,
        size_bytes,
    })
}

fn valid_archive_path(path: &Path) -> bool {
    path.components().all(|component| matches!(component, Component::Normal(_)))
        && path.components().next().is_some_and(|component| {
            let first = component.as_os_str().to_string_lossy();
            MODULES.contains(&first.as_ref()) || first == "attachments" || first == "manifest.json"
        })
}

#[tauri::command]
fn restore_backup(state: State<'_, AppState>, path: String) -> Result<(), String> {
    let safety_backup = create_backup(state.clone(), None)?;
    let file = File::open(&path)
        .map_err(|error| format!("Не удалось открыть резервную копию: {error}"))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|_| "Файл не является резервной копией СБК".to_string())?;
    let manifest: Value = {
        let mut manifest_file = archive
            .by_name("manifest.json")
            .map_err(|_| "В резервной копии нет manifest.json".to_string())?;
        let mut text = String::new();
        manifest_file.read_to_string(&mut text).map_err(|error| error.to_string())?;
        serde_json::from_str(&text).map_err(|_| "Manifest резервной копии повреждён".to_string())?
    };
    if manifest.get("product").and_then(Value::as_str) != Some("sbk-tools-desktop") {
        return Err("Выбран файл другого приложения".to_string());
    }
    if manifest.get("schemaVersion").and_then(Value::as_i64).unwrap_or(i64::MAX) > SCHEMA_VERSION {
        return Err("Резервная копия создана более новой версией приложения".to_string());
    }
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|error| error.to_string())?;
        if entry.is_dir() || entry.name() == "manifest.json" {
            continue;
        }
        let enclosed = entry
            .enclosed_name()
            .ok_or_else(|| "Опасный путь внутри архива".to_string())?;
        if !valid_archive_path(&enclosed) {
            return Err("Недопустимый путь внутри резервной копии".to_string());
        }
        let destination = state.workspace.root.join(enclosed);
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let temporary = destination.with_extension("restore-part");
        let mut output = File::create(&temporary).map_err(|error| error.to_string())?;
        std::io::copy(&mut entry, &mut output).map_err(|error| error.to_string())?;
        output.sync_all().map_err(|error| error.to_string())?;
        fs::rename(&temporary, destination).map_err(|error| error.to_string())?;
    }
    let message = format!(
        "{} restore completed; safety backup: {}\n",
        Utc::now().to_rfc3339(), safety_backup.file_name
    );
    let _ = fs::write(state.workspace.root.join("logs").join("restore.log"), message);
    Ok(())
}

fn scanner_worker_command() -> Result<(Command, bool), String> {
    if let Some(path) = std::env::var_os("SBK_SCANNER_WORKER") {
        return Ok((Command::new(path), true));
    }
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let binary_name = if cfg!(windows) { "sbk-scanner-worker.exe" } else { "sbk-scanner-worker" };
    let mut candidates = vec![executable.parent().unwrap_or(Path::new(".")).join(binary_name)];
    #[cfg(target_os = "macos")]
    if let Some(resources) = executable.ancestors().find(|path| path.ends_with("Contents/MacOS")) {
        candidates.push(resources.parent().unwrap_or(resources).join("Resources").join(binary_name));
    }
    if let Some(path) = candidates.into_iter().find(|path| path.is_file()) {
        return Ok((Command::new(path), true));
    }
    let python = if cfg!(windows) { "python" } else { "python3" };
    let mut command = Command::new(python);
    let source = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../scanner-worker/src");
    command.env("PYTHONPATH", source);
    command.arg("-m").arg("scandocument.worker_cli");
    Ok((command, false))
}

fn run_scanner_worker(
    app: AppHandle,
    workspace: Arc<Workspace>,
    jobs: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    job_id: String,
    operation: String,
    mut config: Value,
) -> Result<Value, String> {
    if operation != "preview" && operation != "process" {
        return Err("Неизвестная операция сканера".to_string());
    }
    let input = config.get("inputPath").and_then(Value::as_str)
        .ok_or_else(|| "Не выбран исходный документ".to_string())?;
    if !Path::new(input).is_file() {
        return Err("Исходный документ не найден".to_string());
    }
    if operation == "preview" {
        let preview_dir = workspace.root.join("runtime-cache").join("previews");
        fs::create_dir_all(&preview_dir).map_err(|error| error.to_string())?;
        config["outputPath"] = Value::String(preview_dir.join(format!("{job_id}.png")).to_string_lossy().into_owned());
    } else {
        let output = config.get("outputPath").and_then(Value::as_str)
            .ok_or_else(|| "Не выбран путь итогового PDF".to_string())?;
        if Path::new(input).canonicalize().ok() == Path::new(output).canonicalize().ok() && Path::new(output).exists() {
            return Err("Исходный документ нельзя перезаписать".to_string());
        }
    }
    let config_path = workspace.root.join("runtime-cache").join(format!("scanner-{job_id}.json"));
    atomic_write(&config_path, serde_json::to_string(&config).map_err(|error| error.to_string())?.as_bytes())?;
    let cancellation = Arc::new(AtomicBool::new(false));
    jobs.lock().map_err(|_| "Не удалось зарегистрировать задачу".to_string())?
        .insert(job_id.clone(), cancellation.clone());
    let (mut command, _) = scanner_worker_command()?;
    if let Ok(resource_dir) = app.path().resource_dir() {
        let scanner_runtime = resource_dir.join("scanner-runtime");
        if scanner_runtime.join("resources").is_dir() {
            command.env("SCANDOCUMENT_RESOURCE_ROOT", scanner_runtime);
        }
    }
    command.arg(&operation).arg("--config").arg(&config_path)
        .stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|error| format!("Не удалось запустить локальный модуль обработки: {error}"))?;
    let stdout = child.stdout.take().ok_or_else(|| "Worker не открыл канал прогресса".to_string())?;
    let stderr = child.stderr.take().ok_or_else(|| "Worker не открыл канал ошибок".to_string())?;
    let (sender, receiver) = std::sync::mpsc::channel::<String>();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let _ = sender.send(line);
        }
    });
    let stderr_thread = thread::spawn(move || {
        let mut text = String::new();
        let _ = BufReader::new(stderr).read_to_string(&mut text);
        text
    });
    let mut final_event = None;
    loop {
        while let Ok(line) = receiver.try_recv() {
            if let Ok(event) = serde_json::from_str::<Value>(&line) {
                let _ = app.emit("scanner-progress", serde_json::json!({ "jobId": job_id, "event": event }));
                final_event = Some(event);
            }
        }
        if cancellation.load(Ordering::Relaxed) {
            let _ = child.kill();
            let _ = child.wait();
            jobs.lock().ok().map(|mut map| map.remove(&job_id));
            let _ = fs::remove_file(&config_path);
            return Err("Обработка отменена. Исходный документ не изменён.".to_string());
        }
        if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
            while let Ok(line) = receiver.try_recv() {
                if let Ok(event) = serde_json::from_str::<Value>(&line) { final_event = Some(event); }
            }
            let stderr_text = stderr_thread.join().unwrap_or_default();
            jobs.lock().ok().map(|mut map| map.remove(&job_id));
            let _ = fs::remove_file(&config_path);
            if !status.success() {
                let message = final_event.as_ref().and_then(|event| event.get("message")).and_then(Value::as_str)
                    .map(str::to_string).unwrap_or_else(|| {
                        if stderr_text.trim().is_empty() { "Обработка документа завершилась с ошибкой".to_string() }
                        else { stderr_text.lines().last().unwrap_or("Ошибка worker").to_string() }
                    });
                return Err(message);
            }
            return final_event.ok_or_else(|| "Worker не вернул результат".to_string());
        }
        thread::sleep(Duration::from_millis(60));
    }
}

#[tauri::command]
async fn scanner_run(
    app: AppHandle,
    state: State<'_, AppState>,
    job_id: String,
    operation: String,
    config: Value,
) -> Result<Value, String> {
    let workspace = state.workspace.clone();
    let jobs = state.scanner_jobs.clone();
    tauri::async_runtime::spawn_blocking(move || run_scanner_worker(app, workspace, jobs, job_id, operation, config))
        .await.map_err(|error| error.to_string())?
}

#[tauri::command]
fn scanner_cancel(state: State<'_, AppState>, job_id: String) -> Result<(), String> {
    let jobs = state.scanner_jobs.lock().map_err(|_| "Не удалось открыть список задач".to_string())?;
    let token = jobs.get(&job_id).ok_or_else(|| "Задача уже завершена".to_string())?;
    token.store(true, Ordering::Relaxed);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let workspace = open_workspace().expect("SBK Tools workspace could not be opened");
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            workspace: Arc::new(workspace),
            scanner_jobs: Arc::new(Mutex::new(HashMap::new())),
        })
        .invoke_handler(tauri::generate_handler![
            workspace_info,
            set_workspace_location,
            read_xlsx,
            write_xlsx,
            list_records,
            get_record,
            record_history,
            upsert_record,
            archive_record,
            copy_attachment,
            write_text_file,
            read_text_file,
            read_binary_file,
            create_backup,
            restore_backup,
            scanner_run,
            scanner_cancel,
        ])
        .run(tauri::generate_context!())
        .expect("SBK Tools could not start");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn xlsx_round_trip_preserves_unicode_cells() {
        let path = std::env::temp_dir().join(format!("sbk-tools-{}.xlsx", Uuid::new_v4()));
        write_xlsx(path.to_string_lossy().into_owned(), SpreadsheetData {
            sheet_name: Some("Договоры".to_string()),
            rows: vec![
                vec!["Номер".to_string(), "Заказчик".to_string()],
                vec!["18/24".to_string(), "АО Энергосеть".to_string()],
            ],
        }).expect("xlsx write");
        let restored = read_xlsx(path.to_string_lossy().into_owned()).expect("xlsx read");
        assert_eq!(restored.sheet_name.as_deref(), Some("Договоры"));
        assert_eq!(restored.rows[1][1], "АО Энергосеть");
        let _ = fs::remove_file(path);
    }

    #[test]
    fn databases_are_isolated_by_module() {
        let root = std::env::temp_dir().join(format!("sbk-tools-{}", Uuid::new_v4()));
        ensure_workspace(&root).expect("workspace");
        let calculator = open_database(&root, "calculator").expect("calculator db");
        calculator.execute(
            "INSERT INTO records(id, title, payload, archived, created_at, updated_at) VALUES ('one', 'test', '{}', 0, 'now', 'now')",
            [],
        ).expect("insert");
        let staff = open_database(&root, "staff").expect("staff db");
        let count: i64 = staff.query_row("SELECT COUNT(*) FROM records", [], |row| row.get(0)).expect("count");
        assert_eq!(count, 0);
        drop(calculator);
        drop(staff);
        let _ = fs::remove_dir_all(root);
    }
}
