use rusqlite::Connection;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashSet;
use std::fs;
use std::path::Path;
use walkdir::WalkDir;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentAudit {
    pub referenced_files: usize,
    pub stored_files: usize,
    pub orphaned_files: usize,
    pub orphaned_bytes: u64,
    pub removed_files: usize,
}

fn collect_attachment_paths(value: &Value, result: &mut HashSet<String>) {
    match value {
        Value::String(text) if text.starts_with("attachments/") => {
            result.insert(text.replace('\\', "/"));
        }
        Value::Array(values) => {
            for value in values {
                collect_attachment_paths(value, result);
            }
        }
        Value::Object(values) => {
            for value in values.values() {
                collect_attachment_paths(value, result);
            }
        }
        _ => {}
    }
}

fn collect_json_column(
    connection: &Connection,
    query: &str,
    references: &mut HashSet<String>,
) -> Result<(), String> {
    let mut statement = connection
        .prepare(query)
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    for row in rows {
        let text = row.map_err(|error| error.to_string())?;
        if let Ok(value) = serde_json::from_str::<Value>(&text) {
            collect_attachment_paths(&value, references);
        }
    }
    Ok(())
}

fn referenced_paths(root: &Path, modules: &[&str]) -> Result<HashSet<String>, String> {
    let mut references = HashSet::new();
    for module in modules {
        let database = root.join(module).join("data.sqlite3");
        if !database.is_file() {
            continue;
        }
        let connection =
            Connection::open_with_flags(database, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                .map_err(|error| error.to_string())?;
        collect_json_column(&connection, "SELECT payload FROM records", &mut references)?;
        collect_json_column(
            &connection,
            "SELECT snapshot FROM history WHERE snapshot IS NOT NULL",
            &mut references,
        )?;
        collect_json_column(&connection, "SELECT payload FROM drafts", &mut references)?;
    }
    Ok(references)
}

pub fn audit(root: &Path, modules: &[&str], remove: bool) -> Result<AttachmentAudit, String> {
    let references = referenced_paths(root, modules)?;
    let attachments = root.join("attachments");
    let mut stored_files = 0;
    let mut orphaned_files = 0;
    let mut orphaned_bytes = 0;
    let mut removed_files = 0;
    if attachments.is_dir() {
        for entry in WalkDir::new(&attachments).follow_links(false) {
            let entry = entry.map_err(|error| error.to_string())?;
            if !entry.file_type().is_file() {
                continue;
            }
            stored_files += 1;
            let relative = entry
                .path()
                .strip_prefix(root)
                .map_err(|_| "Некорректный путь вложения".to_string())?
                .to_string_lossy()
                .replace('\\', "/");
            if !references.contains(&relative) {
                orphaned_files += 1;
                orphaned_bytes += entry.metadata().map_err(|error| error.to_string())?.len();
                if remove {
                    fs::remove_file(entry.path()).map_err(|error| error.to_string())?;
                    removed_files += 1;
                }
            }
        }
        if remove {
            let mut directories: Vec<_> = WalkDir::new(&attachments)
                .min_depth(1)
                .follow_links(false)
                .into_iter()
                .filter_map(Result::ok)
                .filter(|entry| entry.file_type().is_dir())
                .map(|entry| entry.into_path())
                .collect();
            directories.sort_by_key(|path| std::cmp::Reverse(path.components().count()));
            for directory in directories {
                let _ = fs::remove_dir(directory);
            }
        }
    }
    Ok(AttachmentAudit {
        referenced_files: references.len(),
        stored_files,
        orphaned_files,
        orphaned_bytes,
        removed_files,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recursively_collects_only_managed_attachment_paths() {
        let value = serde_json::json!({
            "document": { "relativePath": "attachments/staff/a/file.pdf" },
            "other": ["not-an-attachment", "attachments/calculator/b/table.xlsx"]
        });
        let mut result = HashSet::new();
        collect_attachment_paths(&value, &mut result);
        assert_eq!(result.len(), 2);
        assert!(result.contains("attachments/staff/a/file.pdf"));
    }

    #[test]
    fn audit_preserves_referenced_files_and_removes_only_orphans() {
        let root =
            std::env::temp_dir().join(format!("sbk-attachment-audit-{}", uuid::Uuid::new_v4()));
        let module = root.join("staff");
        let files = root.join("attachments/staff/person");
        fs::create_dir_all(&module).expect("module directory");
        fs::create_dir_all(&files).expect("attachment directory");
        let connection = Connection::open(module.join("data.sqlite3")).expect("database");
        connection
            .execute_batch(
                "CREATE TABLE records(payload TEXT NOT NULL);
             CREATE TABLE history(snapshot TEXT);
             CREATE TABLE drafts(payload TEXT NOT NULL);",
            )
            .expect("schema");
        connection
            .execute(
                "INSERT INTO records(payload) VALUES (?1)",
                [r#"{"file":{"relativePath":"attachments/staff/person/kept.pdf"}}"#],
            )
            .expect("record");
        fs::write(files.join("kept.pdf"), b"kept").expect("kept file");
        fs::write(files.join("orphan.pdf"), b"orphan").expect("orphan file");
        let report = audit(&root, &["staff"], true).expect("audit");
        assert_eq!(report.stored_files, 2);
        assert_eq!(report.orphaned_files, 1);
        assert_eq!(report.removed_files, 1);
        assert!(files.join("kept.pdf").is_file());
        assert!(!files.join("orphan.pdf").exists());
        let _ = fs::remove_dir_all(root);
    }
}
