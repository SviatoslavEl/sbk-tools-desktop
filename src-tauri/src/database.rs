use chrono::Utc;
use rusqlite::{Connection, OpenFlags};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

pub(crate) const SCHEMA_VERSION: i64 = 3;
pub(crate) const MODULES: [&str; 7] = [
    "settings",
    "calculator",
    "scanner",
    "contract-experience",
    "staff",
    "procurement",
    "tender-calendar",
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
    // WAL relies on shared-memory semantics that are unreliable on SMB/NFS.
    // A rollback journal plus the workspace's single-editor lock is slower but
    // remains recoverable and visible to read-only clients on network shares.
    connection
        .pragma_update(None, "journal_mode", "DELETE")
        .map_err(|error| format!("Не удалось включить безопасный журнал: {error}"))?;
    connection
        .pragma_update(None, "synchronous", "FULL")
        .map_err(|error| format!("Не удалось включить надёжную запись: {error}"))?;
    connection
        .busy_timeout(Duration::from_secs(8))
        .map_err(|error| format!("Не удалось настроить ожидание блокировки: {error}"))?;
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
    if current_version < 3 {
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        if module == "procurement" {
            transaction
                .execute_batch(
                    "CREATE TABLE IF NOT EXISTS intelligence_providers (
                        id TEXT PRIMARY KEY NOT NULL,
                        name TEXT NOT NULL,
                        mode TEXT NOT NULL CHECK(mode IN ('disabled', 'same-computer', 'local-network')),
                        endpoint TEXT,
                        secret_reference TEXT,
                        certificate_fingerprint TEXT,
                        enabled INTEGER NOT NULL DEFAULT 0,
                        configuration_json TEXT NOT NULL,
                        created_at TEXT NOT NULL,
                        updated_at TEXT NOT NULL
                    );
                    CREATE TABLE IF NOT EXISTS analysis_jobs (
                        id TEXT PRIMARY KEY NOT NULL,
                        request_id TEXT NOT NULL UNIQUE,
                        capability TEXT NOT NULL,
                        procurement_id TEXT NOT NULL,
                        workspace_id TEXT NOT NULL,
                        input_revision INTEGER NOT NULL,
                        input_hash TEXT NOT NULL,
                        document_versions_json TEXT NOT NULL,
                        provider_id TEXT,
                        server_version TEXT,
                        model_version TEXT,
                        schema_version TEXT NOT NULL,
                        attempts INTEGER NOT NULL DEFAULT 0,
                        status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','cancelled','interrupted','expired')),
                        remote_job_id TEXT,
                        cancellation_requested INTEGER NOT NULL DEFAULT 0,
                        error_code TEXT,
                        created_at TEXT NOT NULL,
                        started_at TEXT,
                        finished_at TEXT,
                        FOREIGN KEY(provider_id) REFERENCES intelligence_providers(id) ON DELETE SET NULL
                    );
                    CREATE INDEX IF NOT EXISTS idx_analysis_jobs_scope ON analysis_jobs(workspace_id, procurement_id, created_at DESC);
                    CREATE TABLE IF NOT EXISTS analysis_artifacts (
                        id TEXT PRIMARY KEY NOT NULL,
                        job_id TEXT NOT NULL,
                        kind TEXT NOT NULL,
                        content_hash TEXT NOT NULL,
                        content_json TEXT NOT NULL,
                        created_at TEXT NOT NULL,
                        FOREIGN KEY(job_id) REFERENCES analysis_jobs(id) ON DELETE CASCADE
                    );
                    CREATE TABLE IF NOT EXISTS analysis_suggestions (
                        id TEXT PRIMARY KEY NOT NULL,
                        job_id TEXT NOT NULL,
                        procurement_id TEXT NOT NULL,
                        capability TEXT NOT NULL,
                        input_revision INTEGER NOT NULL,
                        input_hash TEXT NOT NULL,
                        target TEXT NOT NULL,
                        operation TEXT NOT NULL,
                        value_json TEXT NOT NULL,
                        confidence REAL,
                        warnings_json TEXT NOT NULL,
                        incomplete INTEGER NOT NULL DEFAULT 0,
                        status TEXT NOT NULL CHECK(status IN ('proposed','accepted','rejected','edited','stale','invalid')),
                        created_at TEXT NOT NULL,
                        reviewed_at TEXT,
                        reviewed_by TEXT,
                        FOREIGN KEY(job_id) REFERENCES analysis_jobs(id) ON DELETE CASCADE
                    );
                    CREATE INDEX IF NOT EXISTS idx_analysis_suggestions_scope ON analysis_suggestions(procurement_id, status, created_at DESC);
                    CREATE TABLE IF NOT EXISTS analysis_evidence (
                        id TEXT PRIMARY KEY NOT NULL,
                        suggestion_id TEXT NOT NULL,
                        document_id TEXT NOT NULL,
                        version_id TEXT NOT NULL,
                        source_sha256 TEXT NOT NULL,
                        locator TEXT NOT NULL,
                        excerpt TEXT NOT NULL,
                        FOREIGN KEY(suggestion_id) REFERENCES analysis_suggestions(id) ON DELETE CASCADE
                    );
                    CREATE TABLE IF NOT EXISTS document_versions (
                        version_id TEXT PRIMARY KEY NOT NULL,
                        document_id TEXT NOT NULL,
                        procurement_id TEXT NOT NULL,
                        file_name TEXT NOT NULL,
                        mime_type TEXT NOT NULL,
                        size_bytes INTEGER NOT NULL,
                        source_sha256 TEXT NOT NULL,
                        source_label TEXT NOT NULL,
                        relative_path TEXT,
                        extraction_engine_version TEXT NOT NULL,
                        processing_status TEXT NOT NULL,
                        warnings_json TEXT NOT NULL,
                        supersedes_version_id TEXT,
                        created_at TEXT NOT NULL,
                        FOREIGN KEY(supersedes_version_id) REFERENCES document_versions(version_id)
                    );
                    CREATE INDEX IF NOT EXISTS idx_document_versions_document ON document_versions(procurement_id, document_id, created_at DESC);
                    CREATE TABLE IF NOT EXISTS document_text_extractions (
                        id TEXT PRIMARY KEY NOT NULL,
                        version_id TEXT NOT NULL,
                        locator TEXT NOT NULL,
                        page_number INTEGER,
                        section_name TEXT,
                        sheet_name TEXT,
                        cell_range TEXT,
                        text_content TEXT NOT NULL,
                        created_at TEXT NOT NULL,
                        FOREIGN KEY(version_id) REFERENCES document_versions(version_id) ON DELETE CASCADE
                    );",
                )
                .map_err(|error| format!("Не удалось создать AI-ready схему закупок: {error}"))?;
        }
        transaction
            .execute_batch("PRAGMA user_version = 3;")
            .map_err(|error| format!("Не удалось завершить миграцию схемы: {error}"))?;
        transaction.commit().map_err(|error| error.to_string())?;
    }
    connection
        .execute_batch("PRAGMA wal_autocheckpoint=1000; PRAGMA busy_timeout=5000;")
        .map_err(|error| error.to_string())?;
    Ok(connection)
}

pub(crate) fn open_database_read_only(root: &Path, module: &str) -> Result<Connection, String> {
    let path = database_path(root, module)?;
    let connection = Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| format!("Не удалось открыть базу раздела {module} для чтения: {error}"))?;
    connection
        .busy_timeout(Duration::from_secs(8))
        .map_err(|error| format!("Не удалось настроить ожидание блокировки: {error}"))?;
    connection
        .pragma_update(None, "query_only", "ON")
        .map_err(|error| format!("Не удалось включить режим чтения: {error}"))?;
    Ok(connection)
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[test]
    fn network_safe_database_has_rollback_journal_and_readers_cannot_write() {
        let root = std::env::temp_dir().join(format!("sbk-network-db-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("calculator")).expect("module directory");
        fs::create_dir_all(root.join("backups")).expect("backup directory");
        let writer = open_database(&root, "calculator").expect("writer");
        let mode: String = writer
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .expect("journal mode");
        assert_eq!(mode.to_ascii_lowercase(), "delete");
        writer
            .execute(
                "INSERT INTO records(id,title,payload,created_at,updated_at) VALUES ('1','one','{}','now','now')",
                [],
            )
            .expect("seed");
        drop(writer);
        let reader = open_database_read_only(&root, "calculator").expect("reader");
        assert_eq!(
            reader
                .query_row("SELECT COUNT(*) FROM records", [], |row| row
                    .get::<_, i64>(0))
                .expect("read"),
            1
        );
        assert!(reader.execute("DELETE FROM records", []).is_err());
        drop(reader);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn read_only_open_never_runs_migrations() {
        let root = std::env::temp_dir().join(format!("sbk-readonly-schema-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("staff")).expect("module directory");
        let database = root.join("staff").join("data.sqlite3");
        let seed = Connection::open(&database).expect("seed database");
        seed.execute_batch("CREATE TABLE legacy(value TEXT); PRAGMA user_version = 1;")
            .expect("legacy schema");
        drop(seed);
        let reader = open_database_read_only(&root, "staff").expect("read-only open");
        let version: i64 = reader
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("schema version");
        assert_eq!(version, 1);
        let drafts: i64 = reader
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='drafts'",
                [],
                |row| row.get(0),
            )
            .expect("drafts query");
        assert_eq!(drafts, 0);
        drop(reader);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn opening_a_current_database_does_not_migrate_or_rewrite_it() {
        let root = std::env::temp_dir().join(format!("sbk-current-schema-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("staff")).expect("module directory");
        fs::create_dir_all(root.join("backups")).expect("backup directory");
        let database = root.join("staff").join("data.sqlite3");

        let connection = open_database(&root, "staff").expect("create current database");
        connection
            .execute(
                "INSERT INTO records(id,title,payload,created_at,updated_at) VALUES ('current','Current','{}','now','now')",
                [],
            )
            .expect("seed current database");
        drop(connection);
        let before = fs::read(&database).expect("database snapshot");

        drop(open_database(&root, "staff").expect("reopen current database"));

        assert_eq!(fs::read(&database).expect("database after reopen"), before);
        assert_eq!(
            fs::read_dir(root.join("backups"))
                .expect("backup directory")
                .count(),
            0,
            "a current schema must not create a migration backup"
        );
        let _ = fs::remove_dir_all(root);
    }
}
