use argon2::Argon2;
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use calamine::{Reader, open_workbook_auto};
use chacha20poly1305::{
    XChaCha20Poly1305, XNonce,
    aead::{Aead, KeyInit, Payload},
};
use chrono::Utc;
use rusqlite::{Connection, DatabaseName, OptionalExtension, params};
use rust_xlsxwriter::{Format, Workbook};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};
use std::{collections::HashMap, io::BufRead, io::BufReader};
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;
use walkdir::WalkDir;
use zeroize::Zeroizing;
use zip::write::SimpleFileOptions;

mod attachments;
mod database;
mod workspace;
use attachments::AttachmentAudit;
use database::{MODULES, SCHEMA_VERSION, open_database, validated_module};
use workspace::{Workspace, ensure_workspace, open_workspace, workspace_pointer_path};

#[derive(Clone)]
struct AppState {
    workspace: Arc<Workspace>,
    scanner_jobs: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    maintenance: Arc<Mutex<()>>,
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportRecord {
    id: String,
    title: String,
    payload: Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AttachmentInfo {
    relative_path: String,
    file_name: String,
    size_bytes: u64,
    sha256: String,
    mime_type: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BackupInfo {
    path: String,
    file_name: String,
    size_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BackupListItem {
    path: String,
    file_name: String,
    size_bytes: u64,
    modified_at: String,
    pinned: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BackupVerification {
    sha256: String,
    created_at: String,
    modules: Vec<String>,
    files: usize,
    unpacked_bytes: u64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupFileMeta {
    size_bytes: u64,
    sha256: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupManifest {
    product: String,
    backup_format_version: u32,
    schema_version: i64,
    created_at: String,
    modules: Vec<String>,
    files: BTreeMap<String, BackupFileMeta>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeFileMeta {
    size_bytes: u64,
    sha256: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeManifest {
    schema_version: u32,
    worker: RuntimeFileMeta,
    resources: BTreeMap<String, RuntimeFileMeta>,
}

const TRUSTED_RUNTIME_MANIFEST: &str =
    include_str!(concat!(env!("OUT_DIR"), "/trusted-runtime-manifest.json"));
static RUNTIME_VERIFICATION: OnceLock<Result<(), String>> = OnceLock::new();

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SpreadsheetData {
    sheet_name: Option<String>,
    rows: Vec<Vec<String>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HistoryEntry {
    id: i64,
    action: String,
    created_at: String,
    snapshot: Option<Value>,
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
    let root = if selected
        .file_name()
        .is_some_and(|name| name == "ProductData")
    {
        selected
    } else {
        selected.join("ProductData")
    };
    ensure_workspace(&root)?;
    let probe = root.join(".write-probe");
    fs::write(&probe, b"ok")
        .and_then(|_| fs::remove_file(&probe))
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
    let sheet_name = workbook
        .sheet_names()
        .first()
        .cloned()
        .ok_or_else(|| "В книге нет листов".to_string())?;
    let range = workbook
        .worksheet_range(&sheet_name)
        .map_err(|error| format!("Не удалось прочитать лист: {error}"))?;
    let rows = range
        .rows()
        .map(|row| row.iter().map(|cell| cell.to_string()).collect())
        .collect();
    Ok(SpreadsheetData {
        sheet_name: Some(sheet_name),
        rows,
    })
}

#[tauri::command]
fn write_xlsx(path: String, data: SpreadsheetData) -> Result<(), String> {
    let mut workbook = Workbook::new();
    let worksheet = workbook.add_worksheet();
    if let Some(name) = data.sheet_name.as_deref() {
        worksheet
            .set_name(name)
            .map_err(|error| error.to_string())?;
    }
    let header = Format::new().set_bold().set_background_color("#DCEFD8");
    for (row_index, row) in data.rows.iter().enumerate() {
        for (column_index, value) in row.iter().enumerate() {
            let row_number =
                u32::try_from(row_index).map_err(|_| "Слишком много строк".to_string())?;
            let column_number =
                u16::try_from(column_index).map_err(|_| "Слишком много колонок".to_string())?;
            if row_index == 0 {
                worksheet
                    .write_string_with_format(row_number, column_number, value, &header)
                    .map_err(|error| error.to_string())?;
            } else {
                worksheet
                    .write_string(row_number, column_number, value)
                    .map_err(|error| error.to_string())?;
            }
        }
    }
    worksheet.autofit();
    workbook
        .save(path)
        .map_err(|error| format!("Не удалось сохранить Excel-файл: {error}"))
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
fn record_history(
    state: State<'_, AppState>,
    module: String,
    id: String,
) -> Result<Vec<HistoryEntry>, String> {
    let connection = open_database(&state.workspace.root, &module)?;
    let mut statement = connection.prepare(
        "SELECT id, action, created_at, snapshot FROM history WHERE record_id = ?1 ORDER BY created_at DESC LIMIT 100",
    ).map_err(|error| error.to_string())?;
    statement
        .query_map([id], |row| {
            Ok(HistoryEntry {
                id: row.get(0)?,
                action: row.get(1)?,
                created_at: row.get(2)?,
                snapshot: row
                    .get::<_, Option<String>>(3)?
                    .and_then(|text| serde_json::from_str(&text).ok()),
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn restore_history_version(
    state: State<'_, AppState>,
    module: String,
    id: String,
    history_id: i64,
) -> Result<StoredRecord, String> {
    let _maintenance = state
        .maintenance
        .lock()
        .map_err(|_| "Хранилище временно недоступно".to_string())?;
    let mut connection = open_database(&state.workspace.root, &module)?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let snapshot: String = transaction.query_row(
        "SELECT snapshot FROM history WHERE id = ?1 AND record_id = ?2 AND snapshot IS NOT NULL",
        params![history_id, id],
        |row| row.get(0),
    ).map_err(|_| "Выбранная версия не содержит снимка для восстановления".to_string())?;
    let current: String = transaction
        .query_row("SELECT payload FROM records WHERE id = ?1", [&id], |row| {
            row.get(0)
        })
        .map_err(|_| "Запись не найдена".to_string())?;
    let now = Utc::now().to_rfc3339();
    transaction
        .execute(
            "UPDATE records SET payload = ?1, updated_at = ?2 WHERE id = ?3",
            params![snapshot, now, id],
        )
        .map_err(|error| error.to_string())?;
    transaction.execute(
        "INSERT INTO history(record_id, action, snapshot, created_at) VALUES (?1, 'version-restored', ?2, ?3)",
        params![id, current, now],
    ).map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    drop(_maintenance);
    get_record(state, module, id)?
        .ok_or_else(|| "Запись не найдена после восстановления".to_string())
}

#[tauri::command]
fn upsert_record(
    state: State<'_, AppState>,
    module: String,
    id: Option<String>,
    title: String,
    mut payload: Value,
) -> Result<StoredRecord, String> {
    let _maintenance = state
        .maintenance
        .lock()
        .map_err(|_| "Хранилище временно недоступно".to_string())?;
    if title.trim().is_empty() {
        return Err("Укажите название записи".to_string());
    }
    let history_limit = configured_history_limit(&state.workspace.root);
    let mut connection = open_database(&state.workspace.root, &module)?;
    let record_id = id.unwrap_or_else(|| Uuid::new_v4().to_string());
    let now = Utc::now().to_rfc3339();
    let mut attachment_moves = Vec::new();
    finalize_staged_attachments(
        &mut payload,
        &state.workspace.root,
        &module,
        &record_id,
        &mut attachment_moves,
    )?;
    let result = (|| {
        let payload_text = serde_json::to_string(&payload).map_err(|error| error.to_string())?;
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        let previous: Option<String> = transaction
            .query_row(
                "SELECT payload FROM records WHERE id = ?1",
                [&record_id],
                |row| row.get(0),
            )
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
        transaction
            .execute(
                "DELETE FROM history WHERE record_id = ?1 AND id NOT IN
                 (SELECT id FROM history WHERE record_id = ?1 ORDER BY id DESC LIMIT ?2)",
                params![record_id, history_limit],
            )
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())
    })();
    if let Err(error) = result {
        rollback_attachment_moves(&attachment_moves);
        return Err(error);
    }
    let staging_session = state
        .workspace
        .root
        .join("attachment-staging")
        .join(&module)
        .join(safe_file_name(&record_id));
    if staging_session.is_dir() {
        // The database transaction is already committed. A cleanup failure must
        // not be reported as a failed save; startup orphan cleanup will retry it.
        let _ = fs::remove_dir_all(staging_session);
    }
    drop(_maintenance);
    get_record(state, module, record_id)?
        .ok_or_else(|| "Запись не найдена после сохранения".to_string())
}

fn finalize_staged_attachments(
    value: &mut Value,
    root: &Path,
    module: &str,
    record_id: &str,
    moves: &mut Vec<(PathBuf, PathBuf)>,
) -> Result<(), String> {
    match value {
        Value::String(text) if text.starts_with("attachment-staging/") => {
            let relative = Path::new(text);
            let parts: Vec<_> = relative.components().collect();
            let expected_record = safe_file_name(record_id);
            if parts.len() != 4
                || !matches!(parts.first(), Some(Component::Normal(value)) if *value == "attachment-staging")
                || !matches!(parts.get(1), Some(Component::Normal(value)) if *value == module)
                || !matches!(parts.get(2), Some(Component::Normal(value)) if *value == Path::new(&expected_record).as_os_str())
                || parts
                    .iter()
                    .any(|part| !matches!(part, Component::Normal(_)))
            {
                return Err("Некорректная ссылка на временное вложение".to_string());
            }
            let source = root.join(relative);
            if !source.is_file() {
                return Err("Временное вложение не найдено. Добавьте файл повторно.".to_string());
            }
            let file_name = source
                .file_name()
                .ok_or_else(|| "Некорректное имя вложения".to_string())?;
            let final_relative = PathBuf::from("attachments")
                .join(module)
                .join(&expected_record)
                .join(file_name);
            let destination = root.join(&final_relative);
            if let Some(parent) = destination.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            fs::rename(&source, &destination)
                .map_err(|error| format!("Не удалось закрепить вложение: {error}"))?;
            moves.push((source, destination));
            *text = final_relative.to_string_lossy().replace('\\', "/");
        }
        Value::Array(values) => {
            for value in values {
                finalize_staged_attachments(value, root, module, record_id, moves)?;
            }
        }
        Value::Object(values) => {
            for value in values.values_mut() {
                finalize_staged_attachments(value, root, module, record_id, moves)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn rollback_attachment_moves(moves: &[(PathBuf, PathBuf)]) {
    for (source, destination) in moves.iter().rev() {
        if let Some(parent) = source.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let _ = fs::rename(destination, source);
    }
}

fn configured_history_limit(root: &Path) -> i64 {
    let path = root.join("settings").join("data.sqlite3");
    let Ok(connection) =
        Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
    else {
        return 100;
    };
    let payload: Option<String> = connection
        .query_row(
            "SELECT payload FROM records WHERE title = 'application' AND archived = 0 ORDER BY updated_at DESC LIMIT 1",
            [],
            |row| row.get(0),
        )
        .optional()
        .unwrap_or(None);
    payload
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|value| value.get("historyLimit").and_then(Value::as_i64))
        .unwrap_or(100)
        .clamp(10, 1000)
}

#[tauri::command]
fn prune_history(state: State<'_, AppState>, limit: i64) -> Result<usize, String> {
    if !(10..=1000).contains(&limit) {
        return Err("Хранить можно от 10 до 1000 изменений на запись".to_string());
    }
    let _maintenance = state
        .maintenance
        .lock()
        .map_err(|_| "Хранилище временно недоступно".to_string())?;
    let mut removed = 0;
    for module in MODULES {
        let connection = open_database(&state.workspace.root, module)?;
        removed += connection
            .execute(
                "DELETE FROM history WHERE id IN (
                   SELECT id FROM (
                     SELECT id, ROW_NUMBER() OVER (PARTITION BY record_id ORDER BY id DESC) AS position
                     FROM history
                   ) WHERE position > ?1
                 )",
                [limit],
            )
            .map_err(|error| error.to_string())?;
    }
    Ok(removed)
}

#[tauri::command]
fn import_records_atomic(
    state: State<'_, AppState>,
    module: String,
    records: Vec<ImportRecord>,
) -> Result<usize, String> {
    if records.is_empty() || records.len() > 10_000 {
        return Err("Пакет должен содержать от 1 до 10 000 записей".to_string());
    }
    let _maintenance = state
        .maintenance
        .lock()
        .map_err(|_| "Хранилище временно недоступно".to_string())?;
    let mut ids = HashSet::new();
    if records.iter().any(|record| {
        record.title.trim().is_empty()
            || Uuid::parse_str(&record.id).is_err()
            || !ids.insert(record.id.clone())
    }) {
        return Err("Пакет содержит пустое название или повторяющийся идентификатор".to_string());
    }
    let mut connection = open_database(&state.workspace.root, &module)?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let now = Utc::now().to_rfc3339();
    for record in records {
        let payload = serde_json::to_string(&record.payload).map_err(|error| error.to_string())?;
        transaction.execute(
            "INSERT INTO records(id, title, payload, archived, created_at, updated_at) VALUES (?1, ?2, ?3, 0, ?4, ?4)",
            params![record.id, record.title.trim(), payload, now],
        ).map_err(|error| format!("Пакет не сохранён: {error}"))?;
        transaction.execute(
            "INSERT INTO history(record_id, action, snapshot, created_at) VALUES (?1, 'created', NULL, ?2)",
            params![record.id, now],
        ).map_err(|error| error.to_string())?;
    }
    let count = ids.len();
    transaction
        .commit()
        .map_err(|error| format!("Пакет не сохранён: {error}"))?;
    Ok(count)
}

#[tauri::command]
fn archive_record(
    state: State<'_, AppState>,
    module: String,
    id: String,
    archived: bool,
) -> Result<(), String> {
    let _maintenance = state
        .maintenance
        .lock()
        .map_err(|_| "Хранилище временно недоступно".to_string())?;
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

#[tauri::command]
fn save_draft(
    state: State<'_, AppState>,
    module: String,
    key: String,
    payload: Value,
) -> Result<(), String> {
    if key.trim().is_empty() || key.len() > 100 {
        return Err("Некорректный ключ черновика".to_string());
    }
    let _maintenance = state
        .maintenance
        .lock()
        .map_err(|_| "Хранилище временно недоступно".to_string())?;
    let connection = open_database(&state.workspace.root, &module)?;
    connection
        .execute(
            "INSERT INTO drafts(key, payload, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at",
            params![
                key,
                serde_json::to_string(&payload).map_err(|error| error.to_string())?,
                Utc::now().to_rfc3339()
            ],
        )
        .map_err(|error| format!("Не удалось сохранить черновик: {error}"))?;
    Ok(())
}

#[tauri::command]
fn read_draft(
    state: State<'_, AppState>,
    module: String,
    key: String,
) -> Result<Option<Value>, String> {
    let connection = open_database(&state.workspace.root, &module)?;
    let payload: Option<String> = connection
        .query_row("SELECT payload FROM drafts WHERE key = ?1", [key], |row| {
            row.get(0)
        })
        .optional()
        .map_err(|error| error.to_string())?;
    payload
        .map(|text| {
            serde_json::from_str(&text).map_err(|_| "Сохранённый черновик повреждён".to_string())
        })
        .transpose()
}

#[tauri::command]
fn clear_draft(state: State<'_, AppState>, module: String, key: String) -> Result<(), String> {
    let _maintenance = state
        .maintenance
        .lock()
        .map_err(|_| "Хранилище временно недоступно".to_string())?;
    let connection = open_database(&state.workspace.root, &module)?;
    connection
        .execute("DELETE FROM drafts WHERE key = ?1", [key])
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn delete_record(state: State<'_, AppState>, module: String, id: String) -> Result<(), String> {
    let _maintenance = state
        .maintenance
        .lock()
        .map_err(|_| "Хранилище временно недоступно".to_string())?;
    let mut connection = open_database(&state.workspace.root, &module)?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let archived: Option<i64> = transaction
        .query_row("SELECT archived FROM records WHERE id = ?1", [&id], |row| {
            row.get(0)
        })
        .optional()
        .map_err(|error| error.to_string())?;
    if archived != Some(1) {
        return Err("Окончательно удалить можно только запись из архива".to_string());
    }
    transaction
        .execute("DELETE FROM history WHERE record_id = ?1", [&id])
        .map_err(|error| error.to_string())?;
    transaction
        .execute("DELETE FROM records WHERE id = ?1", [&id])
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    let attachment_dir = state
        .workspace
        .root
        .join("attachments")
        .join(validated_module(&module)?)
        .join(safe_file_name(&id));
    if attachment_dir.is_dir() {
        fs::remove_dir_all(attachment_dir).map_err(|error| error.to_string())?;
    }
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
    let _maintenance = state
        .maintenance
        .lock()
        .map_err(|_| "Хранилище временно недоступно".to_string())?;
    validated_module(&module)?;
    let source = PathBuf::from(source_path);
    if !source.is_file() {
        return Err("Выбранный файл не найден".to_string());
    }
    const MAX_ATTACHMENT_BYTES: u64 = 100 * 1024 * 1024;
    let source_size = fs::metadata(&source)
        .map_err(|error| error.to_string())?
        .len();
    if source_size == 0 || source_size > MAX_ATTACHMENT_BYTES {
        return Err("Размер вложения должен быть больше нуля и не превышать 100 МБ".to_string());
    }
    let original_name = source
        .file_name()
        .and_then(|name| name.to_str())
        .map(safe_file_name)
        .unwrap_or_else(|| "file".to_string());
    if Uuid::parse_str(&record_id).is_err() {
        return Err("Некорректный идентификатор сессии вложений".to_string());
    }
    let relative = PathBuf::from("attachment-staging")
        .join(&module)
        .join(safe_file_name(&record_id))
        .join(format!("{}-{}", Uuid::new_v4(), original_name));
    let destination = state.workspace.root.join(&relative);
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let temporary = destination.with_extension("uploading");
    fs::copy(&source, &temporary)
        .map_err(|error| format!("Не удалось скопировать вложение: {error}"))?;
    let copied_size = fs::metadata(&temporary)
        .map_err(|error| error.to_string())?
        .len();
    if copied_size != source_size {
        let _ = fs::remove_file(&temporary);
        return Err("Вложение скопировано не полностью".to_string());
    }
    let sha256 = sha256_file(&temporary)?;
    fs::rename(&temporary, &destination).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        format!("Не удалось завершить сохранение вложения: {error}")
    })?;
    let size_bytes = fs::metadata(&destination)
        .map_err(|error| error.to_string())?
        .len();
    Ok(AttachmentInfo {
        relative_path: relative.to_string_lossy().replace('\\', "/"),
        file_name: original_name,
        size_bytes,
        sha256,
        mime_type: match destination
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str()
        {
            "pdf" => "application/pdf",
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            _ => "application/octet-stream",
        }
        .to_string(),
    })
}

#[tauri::command]
fn discard_staged_attachments(
    state: State<'_, AppState>,
    module: String,
    record_id: String,
) -> Result<(), String> {
    let _maintenance = state
        .maintenance
        .lock()
        .map_err(|_| "Хранилище временно недоступно".to_string())?;
    validated_module(&module)?;
    if Uuid::parse_str(&record_id).is_err() {
        return Err("Некорректный идентификатор сессии вложений".to_string());
    }
    let directory = state
        .workspace
        .root
        .join("attachment-staging")
        .join(module)
        .join(safe_file_name(&record_id));
    if directory.is_dir() {
        fs::remove_dir_all(directory).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn delete_attachment(state: State<'_, AppState>, relative_path: String) -> Result<(), String> {
    let _maintenance = state
        .maintenance
        .lock()
        .map_err(|_| "Хранилище временно недоступно".to_string())?;
    let relative = Path::new(&relative_path);
    let parts: Vec<_> = relative.components().collect();
    if parts.len() < 4
        || !matches!(parts.first(), Some(Component::Normal(value)) if *value == "attachments")
        || parts
            .iter()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err("Некорректный путь вложения".to_string());
    }
    let module = parts
        .get(1)
        .and_then(|part| match part {
            Component::Normal(value) => value.to_str(),
            _ => None,
        })
        .ok_or_else(|| "Некорректный раздел вложения".to_string())?;
    validated_module(module)?;
    let candidate = state.workspace.root.join(relative);
    if candidate.is_file() {
        fs::remove_file(candidate).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn audit_attachments(state: State<'_, AppState>, remove: bool) -> Result<AttachmentAudit, String> {
    let _maintenance = state
        .maintenance
        .lock()
        .map_err(|_| "Хранилище временно недоступно".to_string())?;
    attachments::audit(&state.workspace.root, &MODULES, remove)
}

fn atomic_write(destination: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let temporary = destination.with_extension(format!(
        "{}.part",
        destination
            .extension()
            .and_then(|part| part.to_str())
            .unwrap_or("tmp")
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
        return Err(format!(
            "Файл больше допустимого размера {} МБ",
            limit / 1024 / 1024
        ));
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
        return Err(format!(
            "Файл больше допустимого размера {} МБ",
            limit / 1024 / 1024
        ));
    }
    let bytes = fs::read(&path).map_err(|error| error.to_string())?;
    let mime = match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => "image/png",
    };
    Ok(format!("data:{mime};base64,{}", BASE64.encode(bytes)))
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut input = File::open(path).map_err(|error| error.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = input.read(&mut buffer).map_err(|error| error.to_string())?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn collect_backup_files(
    source: &Path,
    prefix: &str,
    files: &mut Vec<(PathBuf, String)>,
) -> Result<(), String> {
    if !source.exists() {
        return Ok(());
    }
    for entry in WalkDir::new(source).follow_links(false) {
        let entry = entry.map_err(|error| error.to_string())?;
        if entry.file_type().is_symlink() || !entry.file_type().is_file() {
            continue;
        }
        let relative = entry
            .path()
            .strip_prefix(source)
            .map_err(|error| error.to_string())?;
        let name = format!(
            "{}/{}",
            prefix,
            relative.to_string_lossy().replace('\\', "/")
        );
        files.push((entry.path().to_path_buf(), name));
    }
    Ok(())
}

fn create_backup_impl(workspace: &Workspace, module: Option<String>) -> Result<BackupInfo, String> {
    let selected_modules: Vec<&str> = match module.as_deref() {
        Some(name) => vec![validated_module(name)?],
        None => MODULES.to_vec(),
    };
    let snapshot_path = workspace
        .root
        .join("runtime-cache")
        .join(format!("backup-{}", Uuid::new_v4()));
    fs::create_dir(&snapshot_path).map_err(|error| error.to_string())?;
    let _snapshot = TemporaryDirectory(snapshot_path.clone());
    for name in &selected_modules {
        let source_dir = workspace.root.join(name);
        let snapshot_dir = snapshot_path.join(name);
        fs::create_dir_all(&snapshot_dir).map_err(|error| error.to_string())?;
        let connection = open_database(&workspace.root, name)?;
        let snapshot_database = snapshot_dir.join("data.sqlite3");
        connection
            .backup(DatabaseName::Main, &snapshot_database, None)
            .map_err(|error| {
                format!("Не удалось создать согласованный снимок базы {name}: {error}")
            })?;
        let snapshot_connection = Connection::open_with_flags(
            &snapshot_database,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .map_err(|error| error.to_string())?;
        let integrity: String = snapshot_connection
            .query_row("PRAGMA integrity_check;", [], |row| row.get(0))
            .map_err(|error| error.to_string())?;
        if integrity != "ok" {
            return Err(format!("Снимок базы {name} не прошёл проверку целостности"));
        }
        for entry in WalkDir::new(&source_dir).min_depth(1).follow_links(false) {
            let entry = entry.map_err(|error| error.to_string())?;
            if !entry.file_type().is_file()
                || entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("data.sqlite3")
            {
                continue;
            }
            let relative = entry
                .path()
                .strip_prefix(&source_dir)
                .map_err(|error| error.to_string())?;
            let destination = snapshot_dir.join(relative);
            if let Some(parent) = destination.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            fs::copy(entry.path(), destination).map_err(|error| error.to_string())?;
        }
    }
    let label = module.as_deref().unwrap_or("all");
    let file_name = format!(
        "sbk-tools-{}-{}-{:03}.sbkbackup",
        label,
        Utc::now().format("%Y%m%d-%H%M%S"),
        Utc::now().timestamp_subsec_millis()
    );
    let destination = workspace.root.join("backups").join(&file_name);
    let temporary = destination.with_extension("sbkbackup.part");
    let mut backup_files = Vec::new();
    for name in &selected_modules {
        collect_backup_files(&snapshot_path.join(name), name, &mut backup_files)?;
        collect_backup_files(
            &workspace.root.join("attachments").join(name),
            &format!("attachments/{name}"),
            &mut backup_files,
        )?;
    }
    let mut checksums = BTreeMap::new();
    for (path, name) in &backup_files {
        checksums.insert(
            name.clone(),
            BackupFileMeta {
                size_bytes: fs::metadata(path).map_err(|error| error.to_string())?.len(),
                sha256: sha256_file(path)?,
            },
        );
    }
    let manifest = BackupManifest {
        product: "sbk-tools-desktop".to_string(),
        backup_format_version: 2,
        schema_version: SCHEMA_VERSION,
        created_at: Utc::now().to_rfc3339(),
        modules: selected_modules
            .iter()
            .map(|name| (*name).to_string())
            .collect(),
        files: checksums,
    };
    let file = File::create(&temporary).map_err(|error| error.to_string())?;
    let mut archive = zip::ZipWriter::new(file);
    archive
        .start_file("manifest.json", SimpleFileOptions::default())
        .map_err(|error| error.to_string())?;
    archive
        .write_all(
            serde_json::to_string_pretty(&manifest)
                .map_err(|error| error.to_string())?
                .as_bytes(),
        )
        .map_err(|error| error.to_string())?;
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    for (path, name) in backup_files {
        archive
            .start_file(name, options)
            .map_err(|error| error.to_string())?;
        let mut input = File::open(path).map_err(|error| error.to_string())?;
        std::io::copy(&mut input, &mut archive).map_err(|error| error.to_string())?;
    }
    let completed = archive.finish().map_err(|error| error.to_string())?;
    completed.sync_all().map_err(|error| error.to_string())?;
    if let Err(error) = fs::rename(&temporary, &destination) {
        let _ = fs::remove_file(&temporary);
        return Err(error.to_string());
    }
    let size_bytes = fs::metadata(&destination)
        .map_err(|error| error.to_string())?
        .len();
    if let Ok(mut log) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(workspace.root.join("logs").join("backup-restore.log"))
    {
        let message = format!(
            "{} backup completed; scope={}; size={size_bytes}\n",
            Utc::now().to_rfc3339(),
            label
        );
        let _ = log.write_all(message.as_bytes());
        let _ = log.sync_all();
    }
    Ok(BackupInfo {
        path: destination.to_string_lossy().into_owned(),
        file_name,
        size_bytes,
    })
}

#[tauri::command]
fn create_backup(state: State<'_, AppState>, module: Option<String>) -> Result<BackupInfo, String> {
    let _maintenance = state
        .maintenance
        .lock()
        .map_err(|_| "Хранилище временно недоступно".to_string())?;
    create_backup_impl(&state.workspace, module)
}

const ENCRYPTED_BACKUP_MAGIC: &[u8; 8] = b"SBKENC02";
const MAX_ENCRYPTED_BACKUP_BYTES: u64 = 512 * 1024 * 1024;

fn backup_key(password: &str, salt: &[u8; 16]) -> Result<Zeroizing<[u8; 32]>, String> {
    if password.chars().count() < 10 {
        return Err("Пароль резервной копии должен содержать не менее 10 символов".to_string());
    }
    let mut key = Zeroizing::new([0_u8; 32]);
    Argon2::default()
        .hash_password_into(password.as_bytes(), salt, key.as_mut())
        .map_err(|_| "Не удалось подготовить ключ шифрования".to_string())?;
    Ok(key)
}

fn encrypt_backup(source: &Path, destination: &Path, password: &str) -> Result<(), String> {
    let size = fs::metadata(source)
        .map_err(|error| error.to_string())?
        .len();
    if size == 0 || size > MAX_ENCRYPTED_BACKUP_BYTES {
        return Err("Для шифрования размер копии должен быть от 1 байта до 512 МБ".to_string());
    }
    let plaintext = Zeroizing::new(fs::read(source).map_err(|error| error.to_string())?);
    let mut salt = [0_u8; 16];
    let mut nonce = [0_u8; 24];
    getrandom::fill(&mut salt)
        .map_err(|_| "Не удалось получить криптографическую случайность".to_string())?;
    getrandom::fill(&mut nonce)
        .map_err(|_| "Не удалось получить криптографическую случайность".to_string())?;
    let key = backup_key(password, &salt)?;
    let cipher = XChaCha20Poly1305::new_from_slice(key.as_ref())
        .map_err(|_| "Не удалось создать шифратор".to_string())?;
    let ciphertext = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: plaintext.as_slice(),
                aad: ENCRYPTED_BACKUP_MAGIC,
            },
        )
        .map_err(|_| "Не удалось зашифровать резервную копию".to_string())?;
    let mut output = Vec::with_capacity(48 + ciphertext.len());
    output.extend_from_slice(ENCRYPTED_BACKUP_MAGIC);
    output.extend_from_slice(&salt);
    output.extend_from_slice(&nonce);
    output.extend_from_slice(&ciphertext);
    atomic_write(destination, &output)
}

fn decrypt_backup(source: &Path, destination: &Path, password: &str) -> Result<(), String> {
    let size = fs::metadata(source)
        .map_err(|error| error.to_string())?
        .len();
    if !(49..=MAX_ENCRYPTED_BACKUP_BYTES + 1024).contains(&size) {
        return Err("Размер зашифрованной копии недопустим".to_string());
    }
    let encrypted = fs::read(source).map_err(|error| error.to_string())?;
    if &encrypted[..8] != ENCRYPTED_BACKUP_MAGIC {
        return Err("Файл не является зашифрованной копией SBK Tools v2".to_string());
    }
    let salt: [u8; 16] = encrypted[8..24]
        .try_into()
        .map_err(|_| "Заголовок копии повреждён".to_string())?;
    let nonce: [u8; 24] = encrypted[24..48]
        .try_into()
        .map_err(|_| "Заголовок копии повреждён".to_string())?;
    let key = backup_key(password, &salt)?;
    let cipher = XChaCha20Poly1305::new_from_slice(key.as_ref())
        .map_err(|_| "Не удалось создать дешифратор".to_string())?;
    let plaintext = Zeroizing::new(
        cipher
            .decrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: &encrypted[48..],
                    aad: ENCRYPTED_BACKUP_MAGIC,
                },
            )
            .map_err(|_| "Неверный пароль или файл резервной копии повреждён".to_string())?,
    );
    atomic_write(destination, plaintext.as_slice())
}

#[tauri::command]
fn create_encrypted_backup(
    state: State<'_, AppState>,
    module: Option<String>,
    password: String,
) -> Result<BackupInfo, String> {
    let _maintenance = state
        .maintenance
        .lock()
        .map_err(|_| "Хранилище временно недоступно".to_string())?;
    let plain = create_backup_impl(&state.workspace, module)?;
    let source = PathBuf::from(&plain.path);
    let destination = PathBuf::from(format!("{}.enc", plain.path));
    if let Err(error) = encrypt_backup(&source, &destination, &password) {
        let _ = fs::remove_file(&source);
        return Err(error);
    }
    fs::remove_file(&source).map_err(|error| error.to_string())?;
    let size_bytes = fs::metadata(&destination)
        .map_err(|error| error.to_string())?
        .len();
    Ok(BackupInfo {
        path: destination.to_string_lossy().into_owned(),
        file_name: format!("{}.enc", plain.file_name),
        size_bytes,
    })
}

#[tauri::command]
fn verify_encrypted_backup(
    state: State<'_, AppState>,
    path: String,
    password: String,
) -> Result<BackupVerification, String> {
    let directory = state
        .workspace
        .root
        .join("runtime-cache")
        .join(format!("encrypted-verify-{}", Uuid::new_v4()));
    fs::create_dir(&directory).map_err(|error| error.to_string())?;
    let _temporary = TemporaryDirectory(directory.clone());
    let decrypted = directory.join("backup.sbkbackup");
    decrypt_backup(Path::new(&path), &decrypted, &password)?;
    verify_backup(state, decrypted.to_string_lossy().into_owned())
}

#[tauri::command]
fn restore_encrypted_backup(
    state: State<'_, AppState>,
    path: String,
    password: String,
) -> Result<(), String> {
    let directory = state
        .workspace
        .root
        .join("runtime-cache")
        .join(format!("encrypted-restore-{}", Uuid::new_v4()));
    fs::create_dir(&directory).map_err(|error| error.to_string())?;
    let _temporary = TemporaryDirectory(directory.clone());
    let decrypted = directory.join("backup.sbkbackup");
    decrypt_backup(Path::new(&path), &decrypted, &password)?;
    restore_backup(state, decrypted.to_string_lossy().into_owned())
}

fn pinned_backups(root: &Path) -> HashSet<String> {
    fs::read_to_string(root.join("backups").join("pinned.json"))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn write_pinned_backups(root: &Path, names: &HashSet<String>) -> Result<(), String> {
    let destination = root.join("backups").join("pinned.json");
    atomic_write(
        &destination,
        serde_json::to_vec_pretty(names)
            .map_err(|error| error.to_string())?
            .as_slice(),
    )
}

fn safe_backup_name(name: &str) -> Result<&str, String> {
    if name.is_empty()
        || name.len() > 240
        || !(name.ends_with(".sbkbackup") || name.ends_with(".sbkbackup.enc"))
        || Path::new(name).components().count() != 1
    {
        return Err("Некорректное имя резервной копии".to_string());
    }
    Ok(name)
}

#[tauri::command]
fn list_backups(state: State<'_, AppState>) -> Result<Vec<BackupListItem>, String> {
    let pinned = pinned_backups(&state.workspace.root);
    let mut rows = Vec::new();
    for entry in
        fs::read_dir(state.workspace.root.join("backups")).map_err(|error| error.to_string())?
    {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("");
        if !path.is_file() || !(name.ends_with(".sbkbackup") || name.ends_with(".sbkbackup.enc")) {
            continue;
        }
        let metadata = entry.metadata().map_err(|error| error.to_string())?;
        let file_name = entry.file_name().to_string_lossy().into_owned();
        let modified = metadata
            .modified()
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        rows.push(BackupListItem {
            path: path.to_string_lossy().into_owned(),
            file_name: file_name.clone(),
            size_bytes: metadata.len(),
            modified_at: chrono::DateTime::<Utc>::from(modified).to_rfc3339(),
            pinned: pinned.contains(&file_name),
        });
    }
    rows.sort_by(|left, right| right.modified_at.cmp(&left.modified_at));
    Ok(rows)
}

#[tauri::command]
fn set_backup_pinned(
    state: State<'_, AppState>,
    file_name: String,
    pinned: bool,
) -> Result<(), String> {
    let _maintenance = state
        .maintenance
        .lock()
        .map_err(|_| "Хранилище временно недоступно".to_string())?;
    let name = safe_backup_name(&file_name)?;
    if !state.workspace.root.join("backups").join(name).is_file() {
        return Err("Резервная копия не найдена".to_string());
    }
    let mut names = pinned_backups(&state.workspace.root);
    if pinned {
        names.insert(name.to_string());
    } else {
        names.remove(name);
    }
    write_pinned_backups(&state.workspace.root, &names)
}

#[tauri::command]
fn delete_backup(state: State<'_, AppState>, file_name: String) -> Result<(), String> {
    let _maintenance = state
        .maintenance
        .lock()
        .map_err(|_| "Хранилище временно недоступно".to_string())?;
    let name = safe_backup_name(&file_name)?;
    if pinned_backups(&state.workspace.root).contains(name) {
        return Err("Сначала открепите резервную копию".to_string());
    }
    let path = state.workspace.root.join("backups").join(name);
    if path.is_file() {
        fs::remove_file(path).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn rotate_backups(
    state: State<'_, AppState>,
    keep: usize,
    max_age_days: u64,
) -> Result<usize, String> {
    if !(1..=100).contains(&keep) {
        return Err("Хранить можно от 1 до 100 незакреплённых копий".to_string());
    }
    if !(1..=3650).contains(&max_age_days) {
        return Err("Срок хранения должен быть от 1 до 3650 дней".to_string());
    }
    let _maintenance = state
        .maintenance
        .lock()
        .map_err(|_| "Хранилище временно недоступно".to_string())?;
    let pinned = pinned_backups(&state.workspace.root);
    let mut files: Vec<_> = fs::read_dir(state.workspace.root.join("backups"))
        .map_err(|error| error.to_string())?
        .filter_map(Result::ok)
        .filter(|entry| {
            (entry.file_name().to_string_lossy().ends_with(".sbkbackup")
                || entry
                    .file_name()
                    .to_string_lossy()
                    .ends_with(".sbkbackup.enc"))
                && !pinned.contains(&entry.file_name().to_string_lossy().into_owned())
        })
        .collect();
    files.sort_by_key(|entry| {
        std::cmp::Reverse(
            entry
                .metadata()
                .and_then(|value| value.modified())
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH),
        )
    });
    let mut removed = 0;
    let cutoff = std::time::SystemTime::now()
        .checked_sub(Duration::from_secs(max_age_days * 86_400))
        .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
    for (index, entry) in files.into_iter().enumerate() {
        let modified = entry
            .metadata()
            .and_then(|value| value.modified())
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        if index >= keep || modified < cutoff {
            fs::remove_file(entry.path()).map_err(|error| error.to_string())?;
            removed += 1;
        }
    }
    Ok(removed)
}

#[tauri::command]
fn verify_backup(state: State<'_, AppState>, path: String) -> Result<BackupVerification, String> {
    let _maintenance = state
        .maintenance
        .lock()
        .map_err(|_| "Хранилище временно недоступно".to_string())?;
    const LIMIT: u64 = 2 * 1024 * 1024 * 1024;
    let archive_size = fs::metadata(&path)
        .map_err(|error| error.to_string())?
        .len();
    if archive_size == 0 || archive_size > LIMIT {
        return Err("Размер резервной копии превышает безопасный предел".to_string());
    }
    let mut archive = zip::ZipArchive::new(File::open(&path).map_err(|error| error.to_string())?)
        .map_err(|_| "Файл не является резервной копией СБК".to_string())?;
    let manifest: BackupManifest = {
        let mut entry = archive
            .by_name("manifest.json")
            .map_err(|_| "В резервной копии нет manifest.json".to_string())?;
        if entry.size() > 1024 * 1024 {
            return Err("Manifest превышает безопасный предел".to_string());
        }
        let mut text = String::new();
        entry
            .read_to_string(&mut text)
            .map_err(|error| error.to_string())?;
        serde_json::from_str(&text).map_err(|_| "Manifest повреждён".to_string())?
    };
    if manifest.product != "sbk-tools-desktop"
        || manifest.backup_format_version != 2
        || manifest.schema_version > SCHEMA_VERSION
    {
        return Err("Версия или тип резервной копии несовместимы".to_string());
    }
    let modules: HashSet<String> = manifest.modules.iter().cloned().collect();
    if modules.len() != manifest.modules.len()
        || modules
            .iter()
            .any(|module| validated_module(module).is_err())
    {
        return Err("Manifest содержит неизвестные или повторяющиеся разделы".to_string());
    }
    let stage_path = state
        .workspace
        .root
        .join("runtime-cache")
        .join(format!("verify-backup-{}", Uuid::new_v4()));
    fs::create_dir(&stage_path).map_err(|error| error.to_string())?;
    let _stage = TemporaryDirectory(stage_path.clone());
    let mut unpacked = 0_u64;
    let mut found = HashSet::new();
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|error| error.to_string())?;
        if entry.is_dir() || entry.name() == "manifest.json" {
            continue;
        }
        let relative = entry
            .enclosed_name()
            .ok_or_else(|| "Опасный путь внутри архива".to_string())?;
        if !valid_archive_path(&relative, &modules) {
            return Err("Недопустимый путь внутри резервной копии".to_string());
        }
        let name = relative.to_string_lossy().replace('\\', "/");
        if !found.insert(name.clone()) {
            return Err("Повторяющийся путь внутри резервной копии".to_string());
        }
        unpacked = unpacked
            .checked_add(entry.size())
            .ok_or_else(|| "Некорректный размер архива".to_string())?;
        if unpacked > LIMIT
            || (entry.compressed_size() > 0 && entry.size() / entry.compressed_size() > 250)
        {
            return Err("Небезопасный распакованный размер резервной копии".to_string());
        }
        let expected = manifest
            .files
            .get(&name)
            .ok_or_else(|| format!("Файл {name} не объявлен в manifest"))?;
        if entry.size() != expected.size_bytes {
            return Err(format!("Размер файла {name} не совпадает"));
        }
        let destination = stage_path.join(&relative);
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let mut output = File::create(&destination).map_err(|error| error.to_string())?;
        std::io::copy(&mut entry, &mut output).map_err(|error| error.to_string())?;
        output.sync_all().map_err(|error| error.to_string())?;
        if sha256_file(&destination)? != expected.sha256 {
            return Err(format!("Контрольная сумма файла {name} не совпадает"));
        }
    }
    if found.len() != manifest.files.len() {
        return Err("Состав резервной копии не совпадает с manifest".to_string());
    }
    validate_sqlite_files(&stage_path, &manifest.modules)?;
    Ok(BackupVerification {
        sha256: sha256_file(Path::new(&path))?,
        created_at: manifest.created_at,
        modules: manifest.modules,
        files: found.len(),
        unpacked_bytes: unpacked,
    })
}

fn valid_archive_path(path: &Path, modules: &HashSet<String>) -> bool {
    let parts: Vec<String> = path
        .components()
        .filter_map(|component| match component {
            Component::Normal(value) => Some(value.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect();
    if parts.len() != path.components().count() || parts.is_empty() {
        return false;
    }
    if parts[0] == "manifest.json" {
        return parts.len() == 1;
    }
    if parts[0] == "attachments" {
        return parts.len() >= 3 && modules.contains(&parts[1]);
    }
    modules.contains(&parts[0]) && parts.len() >= 2
}

struct TemporaryDirectory(PathBuf);

impl Drop for TemporaryDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn validate_sqlite_files(stage: &Path, modules: &[String]) -> Result<(), String> {
    for module in modules {
        let database = stage.join(module).join("data.sqlite3");
        if !database.is_file() {
            return Err(format!(
                "В резервной копии отсутствует база раздела {module}"
            ));
        }
        let connection =
            Connection::open_with_flags(&database, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                .map_err(|_| format!("База раздела {module} повреждена"))?;
        let result: String = connection
            .query_row("PRAGMA integrity_check;", [], |row| row.get(0))
            .map_err(|_| format!("База раздела {module} не прошла проверку"))?;
        if result != "ok" {
            return Err(format!("База раздела {module} повреждена: {result}"));
        }
    }
    Ok(())
}

fn rollback_workspace_swaps(swaps: &[(PathBuf, PathBuf, bool)]) {
    for (target, rollback, existed) in swaps.iter().rev() {
        let _ = fs::remove_dir_all(target);
        if *existed {
            let _ = fs::rename(rollback, target);
        }
    }
}

#[tauri::command]
fn restore_backup(state: State<'_, AppState>, path: String) -> Result<(), String> {
    let _maintenance = state
        .maintenance
        .lock()
        .map_err(|_| "Хранилище временно недоступно".to_string())?;
    const MAX_BACKUP_BYTES: u64 = 2 * 1024 * 1024 * 1024;
    const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;
    let archive_size = fs::metadata(&path)
        .map_err(|error| format!("Не удалось проверить резервную копию: {error}"))?
        .len();
    if archive_size == 0 || archive_size > MAX_BACKUP_BYTES {
        return Err("Размер файла резервной копии превышает безопасный предел".to_string());
    }
    let file = File::open(&path)
        .map_err(|error| format!("Не удалось открыть резервную копию: {error}"))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|_| "Файл не является резервной копией СБК".to_string())?;
    let manifest: BackupManifest = {
        let mut manifest_file = archive
            .by_name("manifest.json")
            .map_err(|_| "В резервной копии нет manifest.json".to_string())?;
        if manifest_file.size() > MAX_MANIFEST_BYTES {
            return Err("Manifest резервной копии превышает безопасный предел".to_string());
        }
        let mut text = String::new();
        manifest_file
            .read_to_string(&mut text)
            .map_err(|error| error.to_string())?;
        serde_json::from_str(&text)
            .map_err(|_| "Manifest резервной копии повреждён или устарел".to_string())?
    };
    if manifest.product != "sbk-tools-desktop" {
        return Err("Выбран файл другого приложения".to_string());
    }
    if manifest.backup_format_version != 2 || manifest.schema_version > SCHEMA_VERSION {
        return Err("Резервная копия создана более новой версией приложения".to_string());
    }
    let modules: HashSet<String> = manifest.modules.iter().cloned().collect();
    if modules.is_empty()
        || modules.len() != manifest.modules.len()
        || modules
            .iter()
            .any(|module| validated_module(module).is_err())
    {
        return Err("Manifest содержит неизвестные или повторяющиеся разделы".to_string());
    }
    const MAX_BACKUP_ENTRIES: usize = 10_000;
    if archive.len() > MAX_BACKUP_ENTRIES {
        return Err("В резервной копии слишком много файлов".to_string());
    }
    let mut declared_size = 0_u64;
    let mut declared_names = HashSet::new();
    for index in 0..archive.len() {
        let entry = archive.by_index(index).map_err(|error| error.to_string())?;
        if entry.is_dir() || entry.name() == "manifest.json" {
            continue;
        }
        let enclosed = entry
            .enclosed_name()
            .ok_or_else(|| "Опасный путь внутри архива".to_string())?;
        if !valid_archive_path(&enclosed, &modules) {
            return Err("Недопустимый путь внутри резервной копии".to_string());
        }
        let name = enclosed.to_string_lossy().replace('\\', "/");
        if !declared_names.insert(name) {
            return Err("Резервная копия содержит повторяющийся путь".to_string());
        }
        declared_size = declared_size
            .checked_add(entry.size())
            .ok_or_else(|| "Размер резервной копии некорректен".to_string())?;
        if declared_size > MAX_BACKUP_BYTES || entry.size() > MAX_BACKUP_BYTES / 2 {
            return Err(
                "Распакованный размер резервной копии превышает безопасный предел".to_string(),
            );
        }
        if entry.compressed_size() > 0 && entry.size() / entry.compressed_size() > 250 {
            return Err("Резервная копия имеет небезопасно высокий коэффициент сжатия".to_string());
        }
    }
    let required_space = declared_size.saturating_mul(2).saturating_add(archive_size);
    let available =
        fs2::available_space(&state.workspace.root).map_err(|error| error.to_string())?;
    if available < required_space {
        return Err("Недостаточно свободного места для безопасного восстановления".to_string());
    }
    let stage_parent = state
        .workspace
        .root
        .parent()
        .ok_or_else(|| "Не удалось выбрать staging-каталог".to_string())?;
    let stage_path = stage_parent.join(format!(".sbk-tools-restore-{}", Uuid::new_v4()));
    fs::create_dir(&stage_path).map_err(|error| error.to_string())?;
    let stage = TemporaryDirectory(stage_path.clone());
    let mut total_size = 0_u64;
    let mut extracted = BTreeMap::new();
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|error| error.to_string())?;
        if entry.is_dir() || entry.name() == "manifest.json" {
            continue;
        }
        let enclosed = entry
            .enclosed_name()
            .ok_or_else(|| "Опасный путь внутри архива".to_string())?;
        if !valid_archive_path(&enclosed, &modules) {
            return Err("Недопустимый путь внутри резервной копии".to_string());
        }
        total_size = total_size
            .checked_add(entry.size())
            .ok_or_else(|| "Размер резервной копии некорректен".to_string())?;
        if total_size > MAX_BACKUP_BYTES || entry.size() > MAX_BACKUP_BYTES / 2 {
            return Err(
                "Распакованный размер резервной копии превышает безопасный предел".to_string(),
            );
        }
        if entry.compressed_size() > 0 && entry.size() / entry.compressed_size() > 250 {
            return Err("Резервная копия имеет небезопасно высокий коэффициент сжатия".to_string());
        }
        let name = enclosed.to_string_lossy().replace('\\', "/");
        if extracted.contains_key(&name) {
            return Err("Резервная копия содержит повторяющийся путь".to_string());
        }
        let destination = stage_path.join(&enclosed);
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let mut output = File::create(&destination).map_err(|error| error.to_string())?;
        std::io::copy(&mut entry, &mut output).map_err(|error| error.to_string())?;
        output.sync_all().map_err(|error| error.to_string())?;
        extracted.insert(
            name.clone(),
            BackupFileMeta {
                size_bytes: entry.size(),
                sha256: sha256_file(&destination)?,
            },
        );
    }
    if extracted.len() != manifest.files.len() {
        return Err("Состав резервной копии не совпадает с manifest".to_string());
    }
    for (name, expected) in &manifest.files {
        let actual = extracted
            .get(name)
            .ok_or_else(|| format!("В резервной копии отсутствует {name}"))?;
        if actual.size_bytes != expected.size_bytes || actual.sha256 != expected.sha256 {
            return Err(format!("Контрольная сумма файла {name} не совпадает"));
        }
    }
    validate_sqlite_files(&stage_path, &manifest.modules)?;

    let safety_backup = create_backup_impl(&state.workspace, None)?;
    let rollback_root = stage_path.join("rollback");
    fs::create_dir(&rollback_root).map_err(|error| error.to_string())?;
    let mut replacements = Vec::new();
    for module in &manifest.modules {
        for relative in [
            PathBuf::from(module),
            PathBuf::from("attachments").join(module),
        ] {
            let staged = stage_path.join(&relative);
            fs::create_dir_all(&staged).map_err(|error| error.to_string())?;
            let target = state.workspace.root.join(&relative);
            let rollback = rollback_root.join(&relative);
            if let Some(parent) = rollback.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            replacements.push((staged, target, rollback));
        }
    }
    let mut swaps: Vec<(PathBuf, PathBuf, bool)> = Vec::new();
    for (staged, target, rollback) in replacements {
        let existed = target.exists();
        let move_old_result = if existed {
            fs::rename(&target, &rollback)
        } else {
            Ok(())
        };
        if let Err(error) = move_old_result {
            rollback_workspace_swaps(&swaps);
            return Err(format!("Не удалось подготовить замену данных: {error}"));
        }
        if let Err(error) = fs::rename(&staged, &target) {
            if existed {
                let _ = fs::rename(&rollback, &target);
            }
            rollback_workspace_swaps(&swaps);
            return Err(format!("Не удалось применить резервную копию: {error}"));
        }
        swaps.push((target, rollback, existed));
    }
    let message = format!(
        "{} restore completed; safety backup: {}\n",
        Utc::now().to_rfc3339(),
        safety_backup.file_name
    );
    if let Ok(mut log) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(state.workspace.root.join("logs").join("backup-restore.log"))
    {
        let _ = log.write_all(message.as_bytes());
        let _ = log.sync_all();
    }
    drop(stage);
    Ok(())
}

fn scanner_worker_command() -> Result<(Command, bool), String> {
    if let Some(path) = std::env::var_os("SBK_SCANNER_WORKER") {
        return Ok((Command::new(path), false));
    }
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let binary_name = if cfg!(windows) {
        "sbk-scanner-worker.exe"
    } else {
        "sbk-scanner-worker"
    };
    let mut candidates = vec![
        executable
            .parent()
            .unwrap_or(Path::new("."))
            .join(binary_name),
    ];
    #[cfg(target_os = "macos")]
    if let Some(resources) = executable
        .ancestors()
        .find(|path| path.ends_with("Contents/MacOS"))
    {
        candidates.push(
            resources
                .parent()
                .unwrap_or(resources)
                .join("Resources")
                .join(binary_name),
        );
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

fn verify_runtime_file(path: &Path, expected: &RuntimeFileMeta) -> Result<(), String> {
    let metadata = fs::metadata(path)
        .map_err(|_| format!("Обязательный компонент {} отсутствует", path.display()))?;
    if !metadata.is_file() || metadata.len() != expected.size_bytes {
        return Err(format!(
            "Размер компонента {} не совпадает с релизом",
            path.display()
        ));
    }
    if sha256_file(path)? != expected.sha256 {
        return Err(format!(
            "Компонент {} был изменён и не будет запущен",
            path.display()
        ));
    }
    Ok(())
}

fn verify_packaged_runtime(worker: &Path, runtime_root: &Path) -> Result<(), String> {
    RUNTIME_VERIFICATION
        .get_or_init(|| {
            let manifest: RuntimeManifest = serde_json::from_str(TRUSTED_RUNTIME_MANIFEST)
                .map_err(|_| "Встроенный manifest компонентов повреждён".to_string())?;
            if manifest.schema_version != 1 || manifest.resources.is_empty() {
                return Err("Встроенный manifest компонентов имеет неизвестную версию".to_string());
            }
            verify_runtime_file(worker, &manifest.worker)?;
            let resources = runtime_root.join("resources");
            for (relative, expected) in &manifest.resources {
                let relative_path = Path::new(relative);
                if relative_path
                    .components()
                    .any(|component| !matches!(component, Component::Normal(_)))
                {
                    return Err("Встроенный manifest содержит опасный путь".to_string());
                }
                verify_runtime_file(&resources.join(relative_path), expected)?;
            }
            Ok(())
        })
        .clone()
}

fn start_runtime_verification(app: &AppHandle) {
    let Ok((command, true)) = scanner_worker_command() else {
        return;
    };
    let Ok(resource_dir) = app.path().resource_dir() else {
        return;
    };
    let runtime = resource_dir.join("scanner-runtime");
    if !runtime.join("resources").is_dir() {
        return;
    }
    let worker = PathBuf::from(command.get_program());
    thread::spawn(move || {
        let _ = verify_packaged_runtime(&worker, &runtime);
    });
}

#[cfg(unix)]
fn configure_scanner_process_group(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    command.process_group(0);
}

#[cfg(not(unix))]
fn configure_scanner_process_group(_command: &mut Command) {}

fn terminate_scanner_tree(child: &mut Child) {
    let pid = child.id();
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(unix)]
    {
        let _ = Command::new("kill")
            .args(["-TERM", &format!("-{pid}")])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < deadline {
        if child.try_wait().ok().flatten().is_some() {
            return;
        }
        thread::sleep(Duration::from_millis(40));
    }
    #[cfg(unix)]
    {
        let _ = Command::new("kill")
            .args(["-KILL", &format!("-{pid}")])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

struct ScannerJobGuard {
    jobs: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    job_id: String,
    config_path: PathBuf,
}

impl Drop for ScannerJobGuard {
    fn drop(&mut self) {
        if let Ok(mut jobs) = self.jobs.lock() {
            jobs.remove(&self.job_id);
        }
        let _ = fs::remove_file(&self.config_path);
    }
}

fn validate_scanner_result(operation: &str, event: &Value) -> Result<(), String> {
    let expected_type = if operation == "preview" {
        "preview"
    } else {
        "complete"
    };
    if event.get("type").and_then(Value::as_str) != Some(expected_type) {
        return Err("Worker вернул незавершённый результат".to_string());
    }
    if event.get("protocolVersion").and_then(Value::as_i64) != Some(2) {
        return Err("Worker вернул несовместимую версию протокола".to_string());
    }
    let output = event
        .get("outputPath")
        .and_then(Value::as_str)
        .ok_or_else(|| "Worker не указал итоговый файл".to_string())?;
    let metadata =
        fs::metadata(output).map_err(|_| "Worker не создал итоговый файл".to_string())?;
    if !metadata.is_file() || metadata.len() == 0 {
        return Err("Worker создал пустой итоговый файл".to_string());
    }
    let mut magic = [0_u8; 8];
    let count = File::open(output)
        .and_then(|mut file| file.read(&mut magic))
        .map_err(|error| format!("Не удалось проверить итоговый файл: {error}"))?;
    let valid = if operation == "preview" {
        count == magic.len() && magic == [137, 80, 78, 71, 13, 10, 26, 10]
    } else {
        count >= 5 && &magic[..5] == b"%PDF-"
    };
    if !valid {
        return Err("Worker создал файл неверного формата".to_string());
    }
    Ok(())
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
    if config.get("protocolVersion").and_then(Value::as_i64) != Some(2) {
        return Err("Версия протокола сканера несовместима с приложением".to_string());
    }
    Uuid::parse_str(&job_id).map_err(|_| "Некорректный идентификатор задачи".to_string())?;
    let input = config
        .get("inputPath")
        .and_then(Value::as_str)
        .ok_or_else(|| "Не выбран исходный документ".to_string())?;
    if !Path::new(input).is_file() {
        return Err("Исходный документ не найден".to_string());
    }
    if operation == "preview" {
        let preview_dir = workspace.root.join("runtime-cache").join("previews");
        fs::create_dir_all(&preview_dir).map_err(|error| error.to_string())?;
        config["outputPath"] = Value::String(
            preview_dir
                .join(format!("{job_id}.png"))
                .to_string_lossy()
                .into_owned(),
        );
    } else {
        let output = config
            .get("outputPath")
            .and_then(Value::as_str)
            .ok_or_else(|| "Не выбран путь итогового PDF".to_string())?;
        if Path::new(input).canonicalize().ok() == Path::new(output).canonicalize().ok()
            && Path::new(output).exists()
        {
            return Err("Исходный документ нельзя перезаписать".to_string());
        }
    }
    let preview_output = if operation == "preview" {
        config
            .get("outputPath")
            .and_then(Value::as_str)
            .map(PathBuf::from)
    } else {
        None
    };
    let config_path = workspace
        .root
        .join("runtime-cache")
        .join(format!("scanner-{job_id}.json"));
    atomic_write(
        &config_path,
        serde_json::to_string(&config)
            .map_err(|error| error.to_string())?
            .as_bytes(),
    )?;
    let cancellation = Arc::new(AtomicBool::new(false));
    jobs.lock()
        .map_err(|_| "Не удалось зарегистрировать задачу".to_string())?
        .insert(job_id.clone(), cancellation.clone());
    let _guard = ScannerJobGuard {
        jobs: jobs.clone(),
        job_id: job_id.clone(),
        config_path: config_path.clone(),
    };
    let (mut command, packaged_worker) = scanner_worker_command()?;
    let worker_path = PathBuf::from(command.get_program());
    let mut runtime_root = None;
    if let Ok(resource_dir) = app.path().resource_dir() {
        let scanner_runtime = resource_dir.join("scanner-runtime");
        if scanner_runtime.join("resources").is_dir() {
            command.env("SCANDOCUMENT_RESOURCE_ROOT", scanner_runtime);
            runtime_root = Some(resource_dir.join("scanner-runtime"));
        }
    }
    if packaged_worker {
        let runtime = runtime_root
            .as_deref()
            .ok_or_else(|| "В поставке отсутствуют встроенные компоненты обработки".to_string())?;
        verify_packaged_runtime(&worker_path, runtime)?;
    }
    command
        .arg(&operation)
        .arg("--config")
        .arg(&config_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_scanner_process_group(&mut command);
    let mut child = command
        .spawn()
        .map_err(|error| format!("Не удалось запустить локальный модуль обработки: {error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Worker не открыл канал прогресса".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Worker не открыл канал ошибок".to_string())?;
    let (sender, receiver) = std::sync::mpsc::channel::<String>();
    let stdout_thread = thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let _ = sender.send(line);
        }
    });
    let stderr_thread = thread::spawn(move || {
        let mut text = String::new();
        let _ = BufReader::new(stderr).read_to_string(&mut text);
        text
    });
    let expected_type = if operation == "preview" {
        "preview"
    } else {
        "complete"
    };
    let mut final_event = None;
    let mut error_event = None;
    let accept_event = |event: Value,
                        final_event: &mut Option<Value>,
                        error_event: &mut Option<Value>| {
        match event.get("type").and_then(Value::as_str) {
            Some(kind) if kind == expected_type => *final_event = Some(event),
            Some("error") => *error_event = Some(event),
            _ => {}
        }
    };
    loop {
        while let Ok(line) = receiver.try_recv() {
            if let Ok(event) = serde_json::from_str::<Value>(&line) {
                let _ = app.emit(
                    "scanner-progress",
                    serde_json::json!({ "jobId": job_id, "event": &event }),
                );
                accept_event(event, &mut final_event, &mut error_event);
            }
        }
        if cancellation.load(Ordering::Relaxed) {
            terminate_scanner_tree(&mut child);
            let _ = stdout_thread.join();
            let _ = stderr_thread.join();
            if let Some(path) = &preview_output {
                let _ = fs::remove_file(path);
            }
            return Err("Обработка отменена. Исходный документ не изменён.".to_string());
        }
        if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
            let _ = stdout_thread.join();
            while let Ok(line) = receiver.try_recv() {
                if let Ok(event) = serde_json::from_str::<Value>(&line) {
                    accept_event(event, &mut final_event, &mut error_event);
                }
            }
            let stderr_text = stderr_thread.join().unwrap_or_default();
            if !status.success() {
                if let Some(path) = &preview_output {
                    let _ = fs::remove_file(path);
                }
                let message = error_event
                    .as_ref()
                    .and_then(|event| event.get("message"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(|| {
                        if stderr_text.trim().is_empty() {
                            "Обработка документа завершилась с ошибкой".to_string()
                        } else {
                            stderr_text
                                .lines()
                                .last()
                                .unwrap_or("Ошибка worker")
                                .to_string()
                        }
                    });
                return Err(message);
            }
            let Some(mut event) = final_event else {
                if let Some(path) = &preview_output {
                    let _ = fs::remove_file(path);
                }
                return Err("Worker не вернул завершённый результат".to_string());
            };
            if let Err(error) = validate_scanner_result(&operation, &event) {
                if let Some(path) = &preview_output {
                    let _ = fs::remove_file(path);
                }
                return Err(error);
            }
            if operation == "process"
                && let Some(output) = event.get("outputPath").and_then(Value::as_str)
            {
                let digest = sha256_file(Path::new(output))?;
                if let Some(object) = event.as_object_mut() {
                    object.insert("outputSha256".to_string(), Value::String(digest));
                }
            }
            return Ok(event);
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
    tauri::async_runtime::spawn_blocking(move || {
        run_scanner_worker(app, workspace, jobs, job_id, operation, config)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn scanner_cancel(state: State<'_, AppState>, job_id: String) -> Result<(), String> {
    let jobs = state
        .scanner_jobs
        .lock()
        .map_err(|_| "Не удалось открыть список задач".to_string())?;
    let token = jobs
        .get(&job_id)
        .ok_or_else(|| "Задача уже завершена".to_string())?;
    token.store(true, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
fn delete_runtime_file(state: State<'_, AppState>, path: String) -> Result<(), String> {
    let candidate = PathBuf::from(path);
    let canonical = candidate
        .canonicalize()
        .map_err(|_| "Временный файл уже удалён".to_string())?;
    let runtime = state
        .workspace
        .root
        .join("runtime-cache")
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if !canonical.starts_with(&runtime) || !canonical.is_file() {
        return Err("Разрешено удалять только временные файлы приложения".to_string());
    }
    fs::remove_file(canonical).map_err(|error| error.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let workspace = open_workspace().expect("SBK Tools workspace could not be opened");
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            start_runtime_verification(app.handle());
            Ok(())
        })
        .manage(AppState {
            workspace: Arc::new(workspace),
            scanner_jobs: Arc::new(Mutex::new(HashMap::new())),
            maintenance: Arc::new(Mutex::new(())),
        })
        .invoke_handler(tauri::generate_handler![
            workspace_info,
            set_workspace_location,
            read_xlsx,
            write_xlsx,
            list_records,
            get_record,
            record_history,
            restore_history_version,
            upsert_record,
            import_records_atomic,
            archive_record,
            save_draft,
            read_draft,
            clear_draft,
            delete_record,
            copy_attachment,
            discard_staged_attachments,
            delete_attachment,
            audit_attachments,
            prune_history,
            write_text_file,
            read_text_file,
            read_binary_file,
            create_backup,
            create_encrypted_backup,
            verify_encrypted_backup,
            restore_encrypted_backup,
            list_backups,
            set_backup_pinned,
            delete_backup,
            rotate_backups,
            verify_backup,
            restore_backup,
            scanner_run,
            scanner_cancel,
            delete_runtime_file,
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
        write_xlsx(
            path.to_string_lossy().into_owned(),
            SpreadsheetData {
                sheet_name: Some("Договоры".to_string()),
                rows: vec![
                    vec!["Номер".to_string(), "Заказчик".to_string()],
                    vec!["18/24".to_string(), "АО Энергосеть".to_string()],
                ],
            },
        )
        .expect("xlsx write");
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
        let count: i64 = staff
            .query_row("SELECT COUNT(*) FROM records", [], |row| row.get(0))
            .expect("count");
        assert_eq!(count, 0);
        drop(calculator);
        drop(staff);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn backup_uses_consistent_sqlite_snapshot_and_checksums() {
        let root = std::env::temp_dir().join(format!("sbk-tools-backup-{}", Uuid::new_v4()));
        ensure_workspace(&root).expect("workspace");
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(root.join(".workspace.lock"))
            .expect("lock");
        let workspace = Workspace {
            root: root.clone(),
            portable: false,
            writable: true,
            _lock: lock,
        };
        let connection = open_database(&root, "calculator").expect("database");
        connection
            .execute(
                "INSERT INTO records(id, title, payload, archived, created_at, updated_at) VALUES ('calc', 'Тест', '{}', 0, 'now', 'now')",
                [],
            )
            .expect("insert");
        drop(connection);

        let info = create_backup_impl(&workspace, Some("calculator".to_string())).expect("backup");
        let file = File::open(&info.path).expect("backup file");
        let mut archive = zip::ZipArchive::new(file).expect("zip");
        let manifest: BackupManifest = {
            let mut entry = archive.by_name("manifest.json").expect("manifest");
            let mut text = String::new();
            entry.read_to_string(&mut text).expect("read manifest");
            serde_json::from_str(&text).expect("parse manifest")
        };
        assert_eq!(manifest.backup_format_version, 2);
        assert_eq!(manifest.modules, vec!["calculator"]);
        let expected = manifest
            .files
            .get("calculator/data.sqlite3")
            .expect("database checksum");
        let restore_stage = root.join("runtime-cache").join("restore-test");
        fs::create_dir_all(restore_stage.join("calculator")).expect("restore stage");
        let extracted = restore_stage.join("calculator").join("data.sqlite3");
        {
            let mut entry = archive
                .by_name("calculator/data.sqlite3")
                .expect("database entry");
            let mut output = File::create(&extracted).expect("output");
            std::io::copy(&mut entry, &mut output).expect("extract");
        }
        assert_eq!(sha256_file(&extracted).expect("hash"), expected.sha256);
        validate_sqlite_files(&restore_stage, &["calculator".to_string()])
            .expect("snapshot integrity");
        let restored = Connection::open(&extracted).expect("open snapshot");
        let count: i64 = restored
            .query_row("SELECT COUNT(*) FROM records", [], |row| row.get(0))
            .expect("query snapshot");
        assert_eq!(count, 1);
        drop(restored);
        drop(workspace);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn backup_path_allowlist_rejects_traversal_and_other_modules() {
        let modules = HashSet::from(["calculator".to_string()]);
        assert!(valid_archive_path(
            Path::new("calculator/data.sqlite3"),
            &modules
        ));
        assert!(valid_archive_path(
            Path::new("attachments/calculator/id/file.pdf"),
            &modules
        ));
        assert!(!valid_archive_path(Path::new("../escape"), &modules));
        assert!(!valid_archive_path(
            Path::new("staff/data.sqlite3"),
            &modules
        ));
    }

    #[test]
    fn database_v1_migrates_to_v2_without_losing_records() {
        let root = std::env::temp_dir().join(format!("sbk-tools-migration-{}", Uuid::new_v4()));
        ensure_workspace(&root).expect("workspace");
        let path = root.join("calculator").join("data.sqlite3");
        let legacy = Connection::open(&path).expect("legacy database");
        legacy
            .execute_batch(
                "CREATE TABLE records (
                    id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, payload TEXT NOT NULL,
                    archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
                );
                CREATE TABLE history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, record_id TEXT NOT NULL,
                    action TEXT NOT NULL, snapshot TEXT, created_at TEXT NOT NULL
                );
                INSERT INTO records VALUES ('legacy', 'Старый расчёт', '{}', 0, 'now', 'now');
                PRAGMA user_version = 1;",
            )
            .expect("legacy schema");
        drop(legacy);

        let migrated = open_database(&root, "calculator").expect("migration");
        let version: i64 = migrated
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("version");
        let records: i64 = migrated
            .query_row("SELECT COUNT(*) FROM records", [], |row| row.get(0))
            .expect("records");
        migrated
            .execute(
                "INSERT INTO drafts(key, payload, updated_at) VALUES ('current', '{}', 'now')",
                [],
            )
            .expect("draft table");
        assert_eq!(version, 2);
        assert_eq!(records, 1);
        let migration_backups = fs::read_dir(root.join("backups"))
            .expect("backups")
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("before-migration-calculator-")
            })
            .count();
        assert_eq!(migration_backups, 1);
        drop(migrated);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn encrypted_backup_round_trip_rejects_wrong_password() {
        let root = std::env::temp_dir().join(format!("sbk-tools-encryption-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("temp");
        let source = root.join("source.sbkbackup");
        let encrypted = root.join("source.sbkbackup.enc");
        let restored = root.join("restored.sbkbackup");
        fs::write(&source, b"synthetic non-confidential backup").expect("source");
        encrypt_backup(&source, &encrypted, "correct horse battery").expect("encrypt");
        assert!(decrypt_backup(&encrypted, &restored, "wrong password").is_err());
        decrypt_backup(&encrypted, &restored, "correct horse battery").expect("decrypt");
        assert_eq!(
            fs::read(restored).expect("restored"),
            b"synthetic non-confidential backup"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn staged_attachments_are_finalized_and_can_be_rolled_back() {
        let root = std::env::temp_dir().join(format!("sbk-tools-staging-{}", Uuid::new_v4()));
        ensure_workspace(&root).expect("workspace");
        let record_id = Uuid::new_v4().to_string();
        let relative = PathBuf::from("attachment-staging")
            .join("staff")
            .join(&record_id)
            .join("file.pdf");
        let source = root.join(&relative);
        fs::create_dir_all(source.parent().expect("parent")).expect("staging directory");
        fs::write(&source, b"attachment").expect("staged attachment");
        let mut payload =
            serde_json::json!({ "document": { "relativePath": relative.to_string_lossy() } });
        let mut moves = Vec::new();
        finalize_staged_attachments(&mut payload, &root, "staff", &record_id, &mut moves)
            .expect("finalize");
        let final_relative = payload["document"]["relativePath"]
            .as_str()
            .expect("final path");
        assert!(final_relative.starts_with("attachments/staff/"));
        assert!(root.join(final_relative).is_file());
        assert!(!source.exists());
        rollback_attachment_moves(&moves);
        assert!(source.is_file());
        assert!(!root.join(final_relative).exists());
        let _ = fs::remove_dir_all(root);
    }
}
