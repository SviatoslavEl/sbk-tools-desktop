use chrono::Utc;
use rusqlite::Connection;
use std::fs;
use std::path::{Path, PathBuf};

pub(crate) const SCHEMA_VERSION: i64 = 2;
pub(crate) const MODULES: [&str; 6] = [
    "settings",
    "calculator",
    "scanner",
    "contract-experience",
    "staff",
    "procurement",
];

pub(crate) fn validated_module(module: &str) -> Result<&str, String> {
    MODULES
        .iter()
        .find(|candidate| **candidate == module)
        .copied()
        .ok_or_else(|| "Неизвестный раздел данных".to_string())
}

pub(crate) fn database_path(root: &Path, module: &str) -> Result<PathBuf, String> {
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

pub(crate) fn open_database(root: &Path, module: &str) -> Result<Connection, String> {
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
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
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
    if current_version < 2 {
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        transaction
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS drafts (
                    key TEXT PRIMARY KEY NOT NULL,
                    payload TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                PRAGMA user_version = 2;",
            )
            .map_err(|error| format!("Не удалось обновить схему раздела {module}: {error}"))?;
        transaction.commit().map_err(|error| error.to_string())?;
    }
    connection
        .execute_batch("PRAGMA wal_autocheckpoint=1000; PRAGMA busy_timeout=5000;")
        .map_err(|error| error.to_string())?;
    Ok(connection)
}
