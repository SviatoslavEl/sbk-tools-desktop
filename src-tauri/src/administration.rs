//! Cooperative administration for a trusted, filesystem-writable shared folder.
//! This is not an ACL boundary against users who can edit the database files.
use argon2::Argon2;
use base64::{Engine as _, engine::general_purpose::STANDARD_NO_PAD};
use chrono::Utc;
use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use serde::Serialize;
use std::path::Path;
use uuid::Uuid;
use zeroize::Zeroizing;

const FILE: &str = ".workspace-administration.sqlite3";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AdminEvent {
    pub id: i64,
    pub created_at: String,
    pub actor: String,
    pub action: String,
    pub target: String,
    pub reason: String,
}

fn open(root: &Path, writable: bool) -> Result<Connection, String> {
    let flags = if writable {
        OpenFlags::SQLITE_OPEN_READ_WRITE
    } else {
        OpenFlags::SQLITE_OPEN_READ_ONLY
    };
    let connection = Connection::open_with_flags(root.join(FILE), flags)
        .map_err(|e| format!("Хранилище владельца недоступно: {e}"))?;
    connection
        .busy_timeout(std::time::Duration::from_secs(3))
        .map_err(|e| e.to_string())?;
    Ok(connection)
}

pub(crate) fn configured(root: &Path) -> Result<bool, String> {
    if !root.join(FILE).exists() {
        return Ok(false);
    }
    open(root, false)?
        .query_row("SELECT EXISTS(SELECT 1 FROM owner WHERE id=1)", [], |row| {
            row.get(0)
        })
        .map_err(|e| e.to_string())
}

fn validate_password(password: &str) -> Result<(), String> {
    if !(12..=128).contains(&password.chars().count())
        || password.trim() != password
        || password.chars().any(char::is_control)
    {
        return Err("Пароль владельца: 12–128 символов, без управляющих символов и пробелов по краям. Используйте уникальную длинную фразу.".into());
    }
    Ok(())
}

pub(crate) fn setup(root: &Path, password: &str, actor: &str) -> Result<(), String> {
    validate_password(password)?;
    let salt = *Uuid::new_v4().as_bytes();
    let mut hash = Zeroizing::new([0u8; 32]);
    Argon2::default()
        .hash_password_into(password.as_bytes(), &salt, &mut *hash)
        .map_err(|e| e.to_string())?;
    let mut connection = Connection::open(root.join(FILE)).map_err(|e| e.to_string())?;
    connection
        .busy_timeout(std::time::Duration::from_secs(3))
        .map_err(|e| e.to_string())?;
    connection.execute_batch("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS owner(id INTEGER PRIMARY KEY CHECK(id=1), salt TEXT NOT NULL, verifier TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, created_at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, reason TEXT NOT NULL);").map_err(|e| e.to_string())?;
    let tx = connection.transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO owner(id,salt,verifier) VALUES(1,?1,?2)",
        params![STANDARD_NO_PAD.encode(salt), STANDARD_NO_PAD.encode(*hash)],
    )
    .map_err(|_| {
        "Владелец уже настроен. Перезаписать его через первичную настройку нельзя.".to_string()
    })?;
    tx.execute("INSERT INTO events(created_at,actor,action,target,reason) VALUES(?1,?2,'owner-setup','','Первичная настройка владельца')", params![Utc::now().to_rfc3339(), actor]).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

pub(crate) fn authenticate(root: &Path, password: &str) -> Result<(), String> {
    if password.len() > 1024 {
        return Err("Неверный пароль владельца".into());
    }
    let (salt, verifier): (String, String) = open(root, false)?
        .query_row("SELECT salt,verifier FROM owner WHERE id=1", [], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .map_err(|_| "Владелец не настроен".to_string())?;
    let salt = STANDARD_NO_PAD
        .decode(salt)
        .map_err(|_| "Настройки владельца повреждены".to_string())?;
    let expected = STANDARD_NO_PAD
        .decode(verifier)
        .map_err(|_| "Настройки владельца повреждены".to_string())?;
    if salt.len() != 16 || expected.len() != 32 {
        return Err("Настройки владельца повреждены".into());
    }
    let mut actual = Zeroizing::new([0u8; 32]);
    Argon2::default()
        .hash_password_into(password.as_bytes(), &salt, &mut *actual)
        .map_err(|e| e.to_string())?;
    let mismatch = actual
        .iter()
        .zip(&expected)
        .fold(0u8, |value, (a, b)| value | (a ^ b));
    if mismatch != 0 {
        return Err("Неверный пароль владельца".into());
    }
    Ok(())
}

pub(crate) fn record_request(
    root: &Path,
    actor: &str,
    target: &str,
    reason: &str,
    revoke: bool,
) -> Result<(), String> {
    if Uuid::parse_str(target).is_err() || !(3..=500).contains(&reason.trim().chars().count()) {
        return Err("Укажите текущую сессию и причину длиной от 3 до 500 символов".into());
    }
    let connection = open(root, true)?;
    connection
        .execute(
            "INSERT INTO events(created_at,actor,action,target,reason) VALUES(?1,?2,?3,?4,?5)",
            params![
                Utc::now().to_rfc3339(),
                actor,
                if revoke {
                    "revoke-requested"
                } else {
                    "release-requested"
                },
                target,
                reason.trim()
            ],
        )
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub(crate) fn latest_request(root: &Path, token: &str) -> Result<Option<AdminEvent>, String> {
    if !root.join(FILE).exists() {
        return Ok(None);
    }
    // A revoke always wins over subsequent ordinary requests for the same lease.
    open(root, false)?.query_row("SELECT id,created_at,actor,action,target,reason FROM events WHERE target=?1 ORDER BY (action='revoke-requested') DESC,id DESC LIMIT 1", [token], read_event).optional().map_err(|e| e.to_string())
}

fn read_event(row: &rusqlite::Row<'_>) -> rusqlite::Result<AdminEvent> {
    Ok(AdminEvent {
        id: row.get(0)?,
        created_at: row.get(1)?,
        actor: row.get(2)?,
        action: row.get(3)?,
        target: row.get(4)?,
        reason: row.get(5)?,
    })
}

pub(crate) fn events(root: &Path) -> Result<Vec<AdminEvent>, String> {
    let connection = open(root, false)?;
    let mut statement = connection.prepare("SELECT id,created_at,actor,action,target,reason FROM events ORDER BY id DESC LIMIT 100").map_err(|e| e.to_string())?;
    statement
        .query_map([], read_event)
        .map_err(|e| e.to_string())?
        .map(|row| row.map_err(|e| e.to_string()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn owner_is_unique_password_is_not_plaintext_and_requests_target_exact_lease() {
        let root = std::env::temp_dir().join(format!("sbk-owner-test-{}", Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        assert!(!configured(&root).unwrap());
        assert!(setup(&root, "short", "test").is_err());
        setup(&root, "test-owner-password-only", "test").unwrap();
        assert!(configured(&root).unwrap());
        assert!(setup(&root, "replacement-password", "other").is_err());
        assert!(authenticate(&root, "incorrect-password").is_err());
        authenticate(&root, "test-owner-password-only").unwrap();
        let bytes = std::fs::read(root.join(FILE)).unwrap();
        assert!(
            !bytes
                .windows(24)
                .any(|value| value == b"test-owner-password-only")
        );
        let token = Uuid::new_v4().to_string();
        record_request(&root, "owner", &token, "Проверка отзыва", true).unwrap();
        record_request(&root, "viewer", &token, "Обычный запрос", false).unwrap();
        assert_eq!(
            latest_request(&root, &token).unwrap().unwrap().action,
            "revoke-requested"
        );
        assert!(
            latest_request(&root, &Uuid::new_v4().to_string())
                .unwrap()
                .is_none()
        );
        assert_eq!(events(&root).unwrap().len(), 3);
        std::fs::remove_dir_all(root).unwrap();
    }
}
