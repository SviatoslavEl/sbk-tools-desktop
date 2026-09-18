use argon2::Argon2;
use base64::{Engine as _, engine::general_purpose::STANDARD_NO_PAD};
use chrono::Utc;
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{
    Mutex,
    atomic::{AtomicBool, Ordering},
};

const ACCESS_CONTROL_FILE: &str = ".workspace-access.json";
const EDITOR_PRESENCE_FILE: &str = ".workspace-editor.json";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EditorOwner {
    pub(crate) display_name: String,
    pub(crate) user_name: String,
    pub(crate) device_name: String,
    pub(crate) started_at: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EditorPresence {
    pub(crate) token: String,
    pub(crate) owner: EditorOwner,
}

pub(crate) struct EditorState {
    pub(crate) busy: bool,
    pub(crate) presence: Option<EditorPresence>,
    pub(crate) message: Option<String>,
}

impl EditorState {
    fn unknown(message: impl Into<String>) -> Self {
        Self {
            busy: true,
            presence: None,
            message: Some(message.into()),
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceAccessControl {
    version: u8,
    salt: String,
    password_hash: String,
}

const WORKSPACE_DIRS: [&str; 13] = [
    "settings",
    "calculator",
    "scanner",
    "contract-experience",
    "staff",
    "procurement",
    "tender-calendar",
    "attachments",
    "attachment-staging",
    "backups",
    "logs",
    "runtime-cache",
    "exports",
];

pub(crate) struct Workspace {
    pub(crate) root: PathBuf,
    runtime_root: PathBuf,
    runtime_guard: Option<File>,
    pub(crate) portable: bool,
    pub(crate) configured: bool,
    pub(crate) warning: Option<String>,
    pub(crate) writable: bool,
    access_controlled: AtomicBool,
    editor_lease: Mutex<EditorLease>,
    admin_notice: Mutex<Option<String>>,
}

struct EditorLease {
    active: bool,
    token: String,
    edit: Option<File>,
    guard: Option<File>,
    presence_path: Option<PathBuf>,
    owner: Option<EditorOwner>,
    cleanup_error: Option<String>,
    release_reason: Option<String>,
    failure_audited: bool,
}

impl EditorLease {
    fn inactive() -> Self {
        Self {
            active: false,
            token: uuid::Uuid::new_v4().to_string(),
            edit: None,
            guard: None,
            presence_path: None,
            owner: None,
            cleanup_error: None,
            release_reason: None,
            failure_audited: false,
        }
    }

    fn cleanup_pending(&self) -> bool {
        !self.active && self.presence_path.is_some()
    }

    fn release_checked(&mut self) -> Result<(), String> {
        self.release_with(|path| fs::remove_file(path))
    }

    fn release_with(
        &mut self,
        remove: impl FnOnce(&Path) -> std::io::Result<()>,
    ) -> Result<(), String> {
        // Disable writes first, but retain this exact ownership information and
        // both locked handles until its claim has actually been removed.
        self.active = false;
        let Some(path) = self.presence_path.clone() else {
            self.edit.take();
            self.guard.take();
            return Ok(());
        };
        let result = (|| {
            let root = path.parent().ok_or("Не определена рабочая папка")?;
            if !fs::metadata(root).is_ok_and(|m| m.is_dir()) {
                return Err(
                    "Общая папка недоступна; собственный сеанс ещё не освобождён".to_string(),
                );
            }
            let bytes = match read_regular_claim(&path) {
                Ok(bytes) => bytes,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    // SMB can disappear after the initial directory check.
                    // Missing claim is success only when its parent is freshly
                    // readable and still confirms absence, not a network error.
                    return confirm_claim_absent_after_error(&path, &error);
                }
                Err(error) => {
                    return Err(format!("Не удалось проверить собственный сеанс: {error}"));
                }
            };
            let presence: EditorPresence = serde_json::from_slice(&bytes)
                .map_err(|_| "Запись сеанса повреждена; её принадлежность не подтверждена")?;
            if presence.token != self.token {
                // No longer ours. Forget local ownership, never touch replacement.
                self.presence_path = None;
                self.edit.take();
                self.guard.take();
                return Err(
                    "Запись принадлежит другому сеансу; чужая блокировка не изменена".into(),
                );
            }
            if read_regular_claim(&path).map_err(|e| e.to_string())? != bytes {
                return Err(
                    "Запись сеанса изменилась во время освобождения; повторите проверку".into(),
                );
            }
            remove(&path)
                .map_err(|error| format!("Не удалось удалить запись собственного сеанса: {error}"))
        })();
        match result {
            Ok(()) => {
                self.presence_path = None;
                self.cleanup_error = None;
                self.edit.take();
                self.guard.take();
                Ok(())
            }
            Err(error) => {
                let message = format!(
                    "Редактирование отключено, но освобождение сессии не подтверждено. {error}. Проверьте подключение и повторите освобождение."
                );
                self.cleanup_error = Some(message.clone());
                Err(message)
            }
        }
    }
}

impl Drop for EditorLease {
    fn drop(&mut self) {
        if self.presence_path.is_some()
            && let Err(error) = self.release_checked()
        {
            log_release_error(&self.token, &error);
        }
    }
}

fn log_release_error(token: &str, error: &str) {
    eprintln!("Editor session {token}: {error}");
    #[cfg(not(test))]
    if let Some(directory) = dirs::data_local_dir().map(|p| p.join("SBKTools").join("logs"))
        && fs::create_dir_all(&directory).is_ok()
        && let Ok(mut log) = OpenOptions::new()
            .create(true)
            .append(true)
            .open(directory.join("editor-release-errors.log"))
    {
        let _ = writeln!(log, "{} {token}: {error}", Utc::now().to_rfc3339());
    }
}

fn read_regular_claim(path: &Path) -> std::io::Result<Vec<u8>> {
    let metadata = regular_file_metadata(path)?;
    if metadata.len() > 64 * 1024 {
        return Err(std::io::Error::other(
            "Ожидался обычный служебный файл сеанса, не ссылка/каталог",
        ));
    }
    fs::read(path)
}

fn confirm_claim_absent_after_error(path: &Path, error: &std::io::Error) -> Result<(), String> {
    if error.kind() != std::io::ErrorKind::NotFound {
        return Err(format!("Отсутствие записи сеанса не подтверждено: {error}"));
    }
    #[cfg(windows)]
    if !matches!(error.raw_os_error(), Some(2 | 3)) {
        // ERROR_BAD_NETPATH/ERROR_BAD_NET_NAME can be classified as NotFound.
        // Only actual FILE_NOT_FOUND/PATH_NOT_FOUND may enter the parent probe.
        return Err(format!(
            "Ошибка сети не подтверждает отсутствие записи сеанса: {error}"
        ));
    }
    let root = path.parent().ok_or("Не определена рабочая папка")?;
    let entries = fs::read_dir(root)
        .map_err(|e| format!("Не удалось повторно проверить доступность общей папки: {e}"))?;
    for entry in entries {
        let entry = entry
            .map_err(|e| format!("Общая папка недоступна при проверке отсутствия сеанса: {e}"))?;
        if Some(entry.file_name().as_os_str()) == path.file_name() {
            return Err("Запись сеанса обнаружена повторно; отсутствие не подтверждено".into());
        }
    }
    match fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            #[cfg(windows)]
            if !matches!(e.raw_os_error(), Some(2 | 3)) {
                return Err(format!("Сетевое состояние записи сеанса неизвестно: {e}"));
            }
            Ok(())
        }
        Ok(_) => Err("Запись сеанса появилась повторно; отсутствие не подтверждено".into()),
        Err(e) => Err(format!(
            "Не удалось подтвердить отсутствие записи сеанса: {e}"
        )),
    }
}

fn regular_file_metadata(path: &Path) -> std::io::Result<fs::Metadata> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(std::io::Error::other(
            "Служебный путь не является обычным файлом",
        ));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err(std::io::Error::other(
                "Служебный путь является reparse point",
            ));
        }
    }
    Ok(metadata)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EditorRecoveryResult {
    pub(crate) archive_file_name: String,
    pub(crate) message: String,
}

/// Explicit, authenticated filesystem maintenance, not automatic stale takeover.
/// No local PID/hostname/timestamp can prove that a remote editor has stopped.
pub(crate) fn recover_workspace_editor_session(
    root: &Path,
    password: &str,
    target_token: &str,
    reason: &str,
    confirmation: &str,
    confirmed_all_editors_closed: bool,
) -> Result<EditorRecoveryResult, String> {
    crate::administration::authenticate(root, password)?;
    if confirmation != "ВОССТАНОВИТЬ ДОСТУП" || !confirmed_all_editors_closed {
        return Err("Подтвердите закрытие всех редакторов, включая компьютеры без связи, и введите «ВОССТАНОВИТЬ ДОСТУП». Локальная проверка не доказывает завершение удалённого процесса.".into());
    }
    if uuid::Uuid::parse_str(target_token).is_err()
        || !(3..=500).contains(&reason.trim().chars().count())
    {
        return Err("Нужны точный сеанс и причина длиной от 3 до 500 символов".into());
    }
    recover_confirmed_claim(root, target_token, reason.trim(), || {})
}

fn lock_existing_editor_file(path: &Path) -> Result<File, String> {
    regular_file_metadata(path).map_err(|e| {
        format!(
            "Не удалось проверить существующую блокировку {}: {e}",
            path.display()
        )
    })?;
    // Never create, truncate, unlink or replace either of these lock files.
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .map_err(|e| {
            format!(
                "Не удалось открыть существующую блокировку {}: {e}",
                path.display()
            )
        })?;
    file.try_lock_exclusive()
        .map_err(|error| recovery_lock_error(path, &error))?;
    regular_file_metadata(path).map_err(|e| {
        format!(
            "Не удалось повторно проверить блокировку {}: {e}",
            path.display()
        )
    })?;
    Ok(file)
}

fn recovery_lock_error(path: &Path, error: &std::io::Error) -> String {
    // fs2 exposes the native contention error: Windows ERROR_LOCK_VIOLATION
    // need not map to ErrorKind::WouldBlock on every Rust version.
    let contended = error.kind() == std::io::ErrorKind::WouldBlock
        || error
            .raw_os_error()
            .is_some_and(|code| Some(code) == fs2::lock_contended_error().raw_os_error());
    if contended {
        format!(
            "Блокировка {} ещё удерживается редактором: {error}. Восстановление отменено; не завершайте чужие процессы автоматически.",
            path.display()
        )
    } else {
        format!(
            "Не удалось подтвердить состояние блокировки {}: {error}. Состояние неизвестно; восстановление отменено. Проверьте сетевое хранилище и доступ к папке.",
            path.display()
        )
    }
}

fn recover_confirmed_claim(
    root: &Path,
    target_token: &str,
    reason: &str,
    before_final_check: impl FnOnce(),
) -> Result<EditorRecoveryResult, String> {
    let path = root.join(EDITOR_PRESENCE_FILE);
    let original = read_regular_claim(&path)
        .map_err(|e| format!("Запись сеанса недоступна; восстановление отменено: {e}"))?;
    let presence: EditorPresence = serde_json::from_slice(&original)
        .map_err(|_| "Запись сеанса повреждена; автоматическое восстановление запрещено")?;
    if presence.token != target_token || presence.owner.display_name.trim().is_empty() {
        return Err("Сеанс изменился или не определён. Обновите сведения и подтвердите точный сеанс заново.".into());
    }
    let mut edit = lock_existing_editor_file(&root.join(".workspace.edit.lock"))?;
    let mut guard = lock_existing_editor_file(&root.join(".workspace.edit.guard"))?;
    verify_locked_token(&mut edit, target_token)
        .and_then(|_| verify_locked_token(&mut guard, target_token))
        .map_err(|_| "Маркеры блокировок не соответствуют выбранному сеансу. Состояние неизвестно; восстановление отменено.".to_string())?;
    if read_regular_claim(&path).map_err(|e| e.to_string())? != original {
        return Err(
            "Запись сеанса изменилась при проверке блокировок; восстановление отменено".into(),
        );
    }
    let archive_file_name = format!("{EDITOR_PRESENCE_FILE}.recovery-{}", uuid::Uuid::new_v4());
    let archive = root.join(&archive_file_name);
    let actor = current_editor_owner().display_name;
    let audit_reason = format!(
        "{reason}. Владелец подтвердил закрытие всех редакторов. Архив: {archive_file_name}"
    );
    crate::administration::record_session_event(
        root,
        &actor,
        target_token,
        "recovery-intent",
        &audit_reason,
    )?;
    let recovery = (|| {
        {
            let mut copy = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&archive)
                .map_err(|e| format!("Не удалось сохранить исходную запись сеанса: {e}"))?;
            copy.write_all(&original)
                .and_then(|_| copy.sync_all())
                .map_err(|e| format!("Не удалось подтвердить сохранение архива: {e}"))?;
        }
        if read_regular_claim(&archive).map_err(|e| e.to_string())? != original {
            return Err("Архив записи не прошёл проверку; исходный сеанс не изменён".to_string());
        }
        before_final_check();
        // Both existing locks remain held; compare immutable bytes, not just a
        // displayed owner name or an old session token supplied by the client.
        if read_regular_claim(&path).map_err(|e| e.to_string())? != original {
            return Err(
                "Запись сеанса изменилась перед освобождением; исходный файл не удалён".into(),
            );
        }
        fs::remove_file(&path).map_err(|e| {
            format!("Не удалось освободить запись. Архив сохранён как {archive_file_name}: {e}")
        })?;
        Ok(())
    })();
    match recovery {
        Ok(()) => {
            crate::administration::record_session_event(root, &actor, target_token, "recovery-completed", &audit_reason)
                .map_err(|e| format!("Запись освобождена, архив {archive_file_name} сохранён, но результат не записан в журнал: {e}"))?;
            Ok(EditorRecoveryResult {
                archive_file_name,
                message: "Оставшаяся запись сеанса сохранена в архив и освобождена. Права редактора не выданы: войдите обычным паролем рабочей папки.".into(),
            })
        }
        Err(error) => {
            if let Err(audit_error) = crate::administration::record_session_event(
                root,
                &actor,
                target_token,
                "recovery-failed",
                &format!("{audit_reason}. {error}"),
            ) {
                return Err(format!(
                    "{error}. Не удалось записать результат в журнал: {audit_error}"
                ));
            }
            Err(error)
        }
    }
}

fn environment_value(names: &[&str]) -> String {
    names
        .iter()
        .find_map(|name| {
            std::env::var(name)
                .ok()
                .filter(|value| !value.trim().is_empty())
        })
        .unwrap_or_default()
}

fn current_editor_owner() -> EditorOwner {
    let user_name = environment_value(&["USERNAME", "USER", "LOGNAME"]);
    let mut device_name = environment_value(&["COMPUTERNAME", "HOSTNAME"]);
    if device_name.is_empty() {
        // Finder-launched macOS applications normally have no HOSTNAME in
        // their environment. Resolve the OS hostname instead of omitting the
        // computer from the shared identity. This is display data, not proof
        // that a remote process is alive or permission to remove its claim.
        let mut command = std::process::Command::new("hostname");
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        if let Ok(output) = command.output()
            && output.status.success()
        {
            device_name = String::from_utf8_lossy(&output.stdout).trim().to_string();
        }
    }
    let display_name = match (user_name.is_empty(), device_name.is_empty()) {
        (false, false) => format!("{user_name} · {device_name}"),
        (false, true) => user_name.clone(),
        (true, false) => device_name.clone(),
        (true, true) => "Пользователь этого компьютера".to_string(),
    };
    EditorOwner {
        display_name,
        user_name,
        device_name,
        started_at: Utc::now().to_rfc3339(),
    }
}

fn publish_editor_presence(
    root: &Path,
    token: &str,
    owner: &EditorOwner,
) -> Result<(PathBuf, Option<String>), String> {
    publish_editor_presence_with(root, token, owner, |file, encoded| {
        file.write_all(encoded).and_then(|_| file.sync_all())
    })
}

fn publish_editor_presence_with(
    root: &Path,
    token: &str,
    owner: &EditorOwner,
    publish: impl FnOnce(&mut File, &[u8]) -> std::io::Result<()>,
) -> Result<(PathBuf, Option<String>), String> {
    let path = root.join(EDITOR_PRESENCE_FILE);
    let encoded = serde_json::to_vec_pretty(&EditorPresence {
        token: token.to_string(),
        owner: owner.clone(),
    })
    .map_err(|error| error.to_string())?;
    // CREATE_NEW/O_EXCL is the shared namespace claim, independent of advisory
    // lock visibility on another SMB client. Never truncate another session's
    // identity, even when the file server incorrectly grants both byte locks.
    // A partial/unreadable claim also stays occupied; it is not safe to infer
    // process death from a local PID, missing metadata or network timeout.
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|error| format!("Не удалось зарезервировать сессию редактора: {error}"))?;
    let error = publish(&mut file, &encoded)
        .err()
        .map(|error| format!("Не удалось опубликовать сведения о редакторе: {error}"));
    // Returning the path even after write/sync failure preserves responsibility
    // for this create_new operation. Never silently discard a partial claim.
    Ok((path, error))
}

#[cfg(test)]
fn write_editor_presence(root: &Path, token: &str, owner: &EditorOwner) -> Result<PathBuf, String> {
    let (path, error) = publish_editor_presence(root, token, owner)?;
    error.map_or(Ok(path), Err)
}

fn read_editor_state(root: &Path) -> EditorState {
    read_editor_state_with(
        root,
        |path| fs::read(path),
        |path| OpenOptions::new().read(true).open(path),
    )
}

fn read_editor_state_with(
    root: &Path,
    read_claim: impl FnOnce(&Path) -> std::io::Result<Vec<u8>>,
    mut open_lock: impl FnMut(&Path) -> std::io::Result<File>,
) -> EditorState {
    if !fs::metadata(root).is_ok_and(|metadata| metadata.is_dir()) {
        return EditorState::unknown(
            "Общая папка недоступна. Состояние редактора не подтверждено; вход заблокирован до восстановления подключения.",
        );
    }
    let presence_path = root.join(EDITOR_PRESENCE_FILE);
    match read_claim(&presence_path) {
        Ok(bytes) => {
            return match serde_json::from_slice::<EditorPresence>(&bytes) {
                Ok(presence)
                    if uuid::Uuid::parse_str(&presence.token).is_ok()
                        && !presence.owner.display_name.trim().is_empty() =>
                {
                    EditorState {
                        busy: true,
                        presence: Some(presence),
                        message: None,
                    }
                }
                _ => EditorState::unknown(
                    "Сессия редактора занята, но сведения о пользователе не удалось прочитать. Вход заблокирован; обновите состояние и проверьте доступ к общей папке.",
                ),
            };
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if let Err(message) = confirm_claim_absent_after_error(&presence_path, &error) {
                return EditorState::unknown(&message);
            }
        }
        Err(_) => {
            return EditorState::unknown(
                "Не удалось проверить сессию редактора в общей папке. Вход заблокирован до восстановления доступа.",
            );
        }
    }
    // During publication/removal, and with older clients, a byte lock may
    // exist without readable identity. Unknown ownership must not mean free.
    for name in [".workspace.edit.lock", ".workspace.edit.guard"] {
        let path = root.join(name);
        match open_lock(&path) {
            Ok(lock) => {
                if FileExt::try_lock_shared(&lock).is_err() {
                    return EditorState::unknown(
                        "Общая папка занята редактором, сведения о пользователе пока недоступны. Дождитесь освобождения сессии.",
                    );
                }
                let _ = FileExt::unlock(&lock);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if let Err(message) = confirm_claim_absent_after_error(&path, &error) {
                    return EditorState::unknown(&message);
                }
            }
            Err(_) => {
                return EditorState::unknown(
                    "Не удалось проверить блокировку общей папки. Вход в режим редактора заблокирован.",
                );
            }
        }
    }
    EditorState {
        busy: false,
        presence: None,
        message: None,
    }
}

impl Drop for Workspace {
    fn drop(&mut self) {
        // Each process owns only its own temporary directory. Closing one
        // application instance must never remove previews or worker configs
        // used by another concurrently running version.
        self.runtime_guard.take();
        let _ = fs::remove_dir_all(&self.runtime_root);
    }
}

fn create_runtime_root(root: &Path, workspace_writable: bool) -> Result<(PathBuf, File), String> {
    // A viewer must also be able to render/convert documents when the shared
    // workspace is mounted read-only. Keep its ephemeral files in the system
    // temp directory instead of turning a valid read-only workspace into a
    // startup error.
    let base = if workspace_writable {
        root.join("runtime-cache")
    } else {
        std::env::temp_dir().join("SBKTools").join("runtime-cache")
    };
    fs::create_dir_all(&base)
        .map_err(|error| format!("Не удалось подготовить временные данные: {error}"))?;
    if let Ok(entries) = fs::read_dir(&base) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() || !entry.file_name().to_string_lossy().starts_with("instance-") {
                continue;
            }
            let lock_path = path.join(".instance.lock");
            let Ok(lock) = OpenOptions::new().read(true).write(true).open(lock_path) else {
                continue;
            };
            if lock.try_lock_exclusive().is_ok() {
                let _ = FileExt::unlock(&lock);
                drop(lock);
                let _ = fs::remove_dir_all(path);
            }
        }
    }
    let runtime_root = base.join(format!("instance-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&runtime_root)
        .map_err(|error| format!("Не удалось создать временную область процесса: {error}"))?;
    let guard = OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(runtime_root.join(".instance.lock"))
        .map_err(|error| format!("Не удалось создать блокировку временной области: {error}"))?;
    guard
        .try_lock_exclusive()
        .map_err(|error| format!("Не удалось заблокировать временную область: {error}"))?;
    Ok((runtime_root, guard))
}

pub(crate) fn workspace_pointer_path() -> Result<PathBuf, String> {
    dirs::config_dir()
        .map(|path| path.join("SBKTools").join("workspace.txt"))
        .ok_or_else(|| "Не удалось определить папку настроек системы".to_string())
}

fn product_directory() -> Result<(PathBuf, bool, bool), String> {
    if let Some(override_path) = std::env::var_os("SBK_TOOLS_WORKSPACE") {
        return Ok((PathBuf::from(override_path), false, true));
    }
    if let Ok(content) = workspace_pointer_path()
        .and_then(|pointer| fs::read_to_string(pointer).map_err(|error| error.to_string()))
    {
        let selected = PathBuf::from(content.trim());
        if !content.trim().is_empty() {
            return Ok((selected, false, true));
        }
    }
    if let Some(local) =
        dirs::data_local_dir().map(|path| path.join("SBKTools").join("ProductData"))
        && local.is_dir()
    {
        return Ok((local, false, true));
    }
    if let Ok(executable) = std::env::current_exe()
        && let Some(parent) = executable.parent()
    {
        let adjacent = parent.join("ProductData");
        if adjacent.is_dir() {
            return Ok((adjacent, true, true));
        }
        #[cfg(target_os = "macos")]
        if let Some(app_parent) = executable
            .ancestors()
            .find(|path| path.extension().is_some_and(|extension| extension == "app"))
            .and_then(Path::parent)
        {
            let adjacent_to_app = app_parent.join("ProductData");
            if adjacent_to_app.is_dir() {
                return Ok((adjacent_to_app, true, true));
            }
        }
    }
    dirs::data_local_dir()
        .map(|path| (path.join("SBKTools").join("first-run"), false, false))
        .ok_or_else(|| "Не удалось подготовить первый запуск".to_string())
}

pub(crate) fn ensure_workspace(root: &Path) -> Result<(), String> {
    fs::create_dir_all(root).map_err(|error| {
        format!(
            "Не удалось создать рабочую папку {}: {error}",
            root.display()
        )
    })?;
    for directory in WORKSPACE_DIRS {
        fs::create_dir_all(root.join(directory))
            .map_err(|error| format!("Не удалось подготовить раздел {directory}: {error}"))?;
    }
    // Additive modules are created only by initialization/the active editor.
    // They are deliberately not required by validate_workspace_layout: older
    // complete shares must remain openable by read-only clients without writes.
    fs::create_dir_all(root.join("commercial-proposals"))
        .map_err(|error| format!("Не удалось подготовить раздел КП: {error}"))?;
    Ok(())
}

pub(crate) fn validate_workspace_layout(root: &Path) -> Result<(), String> {
    if !root.is_dir() {
        return Err("Рабочая папка не существует".to_string());
    }
    for directory in WORKSPACE_DIRS {
        if !root.join(directory).is_dir() {
            return Err(format!("В рабочей папке отсутствует раздел {directory}"));
        }
    }
    Ok(())
}

fn lock_editor_file(path: &Path) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    let file = options.open(path).map_err(|error| error.to_string())?;
    file.try_lock_exclusive()
        .map_err(|error| error.to_string())?;
    Ok(file)
}

fn initialize_locked_token(file: &mut File, token: &str) -> Result<(), String> {
    file.set_len(0).map_err(|error| error.to_string())?;
    file.seek(SeekFrom::Start(0))
        .map_err(|error| error.to_string())?;
    file.write_all(token.as_bytes())
        .map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())
}

fn verify_locked_token(file: &mut File, token: &str) -> Result<(), String> {
    let mut stored = String::new();
    file.seek(SeekFrom::Start(0))
        .map_err(|error| error.to_string())?;
    file.read_to_string(&mut stored)
        .map_err(|error| error.to_string())?;
    if stored != token {
        return Err("Токен блокировки общей папки изменился".to_string());
    }
    Ok(())
}

fn verify_presence_token(root: &Path, token: &str) -> Result<(), String> {
    let state = read_editor_state(root);
    if state
        .presence
        .is_some_and(|presence| presence.token == token)
    {
        Ok(())
    } else {
        Err(
            "Сведения о текущей сессии отсутствуют, недоступны или принадлежат другому редактору"
                .to_string(),
        )
    }
}

fn acquire_editor_lease(root: &Path, writable: bool) -> EditorLease {
    acquire_editor_lease_with(root, writable, publish_editor_presence)
}

fn acquire_editor_lease_with(
    root: &Path,
    writable: bool,
    publish: impl FnOnce(&Path, &str, &EditorOwner) -> Result<(PathBuf, Option<String>), String>,
) -> EditorLease {
    let token = uuid::Uuid::new_v4().to_string();
    if !writable {
        return EditorLease::inactive();
    }
    // Obtain both handles first, without changing either ownership marker.
    // A failed contender must never corrupt the incumbent's first token just
    // because the second lock could not be obtained.
    let Ok(mut edit) = lock_editor_file(&root.join(".workspace.edit.lock")) else {
        return EditorLease::inactive();
    };
    let Ok(mut guard) = lock_editor_file(&root.join(".workspace.edit.guard")) else {
        return EditorLease::inactive();
    };
    let owner = current_editor_owner();
    let Ok((presence_path, publication_error)) = publish(root, &token, &owner) else {
        return EditorLease::inactive();
    };
    let active = publication_error.is_none()
        && initialize_locked_token(&mut edit, &token)
            .and_then(|_| initialize_locked_token(&mut guard, &token))
            .and_then(|_| verify_presence_token(root, &token))
            .is_ok();
    let mut lease = EditorLease {
        active,
        token,
        edit: Some(edit),
        guard: Some(guard),
        presence_path: Some(presence_path),
        owner: Some(owner),
        cleanup_error: publication_error,
        release_reason: None,
        failure_audited: false,
    };
    if !active {
        // Only this newly created claim is removed, while both handles remain
        // held. Drop checks the exact session token before removing it.
        let _ = lease.release_checked();
        // A failed cleanup keeps the token and handles in a disabled lease.
        return lease;
    }
    lease
}

fn read_access_control(root: &Path) -> Result<Option<WorkspaceAccessControl>, String> {
    let path = root.join(ACCESS_CONTROL_FILE);
    if !path.exists() {
        return Ok(None);
    }
    let bytes = fs::read(&path)
        .map_err(|error| format!("Не удалось прочитать настройки доступа: {error}"))?;
    let control: WorkspaceAccessControl = serde_json::from_slice(&bytes).map_err(|_| {
        "Файл управления доступом повреждён. Восстановите его из резервной копии.".to_string()
    })?;
    if control.version != 1 {
        return Err("Версия настроек доступа не поддерживается".to_string());
    }
    Ok(Some(control))
}

fn verify_access_password(root: &Path, password: &str) -> Result<(), String> {
    let control = read_access_control(root)?
        .ok_or_else(|| "Пароль рабочей папки ещё не установлен".to_string())?;
    let salt = STANDARD_NO_PAD
        .decode(control.salt)
        .map_err(|_| "Файл управления доступом повреждён".to_string())?;
    let expected = STANDARD_NO_PAD
        .decode(control.password_hash)
        .map_err(|_| "Файл управления доступом повреждён".to_string())?;
    let mut actual = vec![0u8; expected.len()];
    Argon2::default()
        .hash_password_into(password.as_bytes(), &salt, &mut actual)
        .map_err(|error| format!("Не удалось проверить пароль: {error}"))?;
    if actual.len() != expected.len()
        || !actual
            .iter()
            .zip(expected.iter())
            .fold(0u8, |difference, (left, right)| difference | (left ^ right))
            .eq(&0)
    {
        return Err("Неверный пароль рабочей папки".to_string());
    }
    Ok(())
}

fn write_access_control(root: &Path, password: &str) -> Result<(), String> {
    validate_new_access_password(password)?;
    let mut salt = [0u8; 16];
    getrandom::fill(&mut salt).map_err(|error| format!("Не удалось создать пароль: {error}"))?;
    let mut password_hash = [0u8; 32];
    Argon2::default()
        .hash_password_into(password.as_bytes(), &salt, &mut password_hash)
        .map_err(|error| format!("Не удалось создать пароль: {error}"))?;
    let control = WorkspaceAccessControl {
        version: 1,
        salt: STANDARD_NO_PAD.encode(salt),
        password_hash: STANDARD_NO_PAD.encode(password_hash),
    };
    let target = root.join(ACCESS_CONTROL_FILE);
    let encoded = serde_json::to_vec_pretty(&control).map_err(|error| error.to_string())?;
    if target.exists() {
        // Windows cannot atomically rename over an existing file. Keeping the
        // control file present while rewriting is safer than briefly removing
        // password protection; an interrupted write fails closed on next start.
        let mut file = OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(&target)
            .map_err(|error| format!("Не удалось сменить пароль: {error}"))?;
        file.write_all(&encoded)
            .map_err(|error| format!("Не удалось сменить пароль: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("Не удалось сменить пароль: {error}"))?;
        return Ok(());
    }
    let temporary = root.join(format!(
        "{ACCESS_CONTROL_FILE}.{}.tmp",
        uuid::Uuid::new_v4()
    ));
    fs::write(&temporary, encoded)
        .map_err(|error| format!("Не удалось сохранить настройки доступа: {error}"))?;
    fs::rename(&temporary, &target).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        format!("Не удалось включить парольный доступ: {error}")
    })?;
    Ok(())
}

fn validate_new_access_password(password: &str) -> Result<(), String> {
    let length = password.chars().count();
    if length < 6 {
        return Err("Пароль должен содержать не менее 6 символов. Допустимы русские и латинские буквы, цифры, пробелы и специальные символы".to_string());
    }
    if length > 128 {
        return Err("Пароль должен содержать не более 128 символов".to_string());
    }
    if password.trim() != password {
        return Err("Пробелы в начале и конце пароля недопустимы".to_string());
    }
    if password.chars().any(char::is_control) {
        return Err("Управляющие символы в пароле недопустимы".to_string());
    }
    Ok(())
}

pub(crate) struct ProvisionalEditorLease {
    _lease: EditorLease,
}

pub(crate) fn prepare_workspace_location(
    root: &Path,
) -> Result<Option<ProvisionalEditorLease>, String> {
    if validate_workspace_layout(root).is_ok() {
        return Ok(None);
    }
    fs::create_dir_all(root)
        .map_err(|error| format!("Не удалось создать рабочую папку: {error}"))?;
    let lease = acquire_editor_lease(root, true);
    if !lease.active {
        return Err(
            "Новая рабочая папка занята другим редактором или не поддерживает блокировки"
                .to_string(),
        );
    }
    ensure_workspace(root)?;
    Ok(Some(ProvisionalEditorLease { _lease: lease }))
}

pub(crate) fn open_workspace() -> Result<Workspace, String> {
    let (preferred, mut portable, mut configured) = product_directory()?;
    let mut root = preferred.clone();
    let mut warning = None;
    // An already prepared read-only share must open without even attempting to
    // create directories. Initialization is only for a new/incomplete workspace.
    if validate_workspace_layout(&root).is_err() && ensure_workspace(&root).is_err() {
        if configured {
            warning = Some(format!(
                "Ранее выбранная рабочая папка {} сейчас недоступна. Выберите её снова или укажите другую папку.",
                preferred.display()
            ));
            configured = false;
        }
        root = dirs::data_local_dir()
            .ok_or_else(|| {
                format!(
                    "Папка {} недоступна, резервное расположение не найдено",
                    preferred.display()
                )
            })?
            .join("SBKTools")
            .join("first-run");
        portable = false;
        ensure_workspace(&root)?;
    }
    let probe = root.join(format!(".write-probe-{}", uuid::Uuid::new_v4()));
    let writable = fs::write(&probe, b"ok")
        .and_then(|_| fs::remove_file(&probe))
        .is_ok();
    // The operating system / network filesystem is the authority. There is no
    // application password that pretends to grant access: a process may edit
    // only while it both has write permission and owns the exclusive lock.
    let access_controlled = read_access_control(&root)?.is_some();
    let editor_lease = acquire_editor_lease(&root, writable && !access_controlled);
    let editor = editor_lease.active;
    let (runtime_root, runtime_guard) = create_runtime_root(&root, writable)?;
    if editor {
        cleanup_stale_partial_backups(&root);
        let attachment_staging = root.join("attachment-staging");
        fs::remove_dir_all(&attachment_staging)
            .map_err(|error| format!("Не удалось очистить временные вложения: {error}"))?;
        fs::create_dir_all(&attachment_staging)
            .map_err(|error| format!("Не удалось подготовить временные вложения: {error}"))?;
    }
    Ok(Workspace {
        root,
        runtime_root,
        runtime_guard: Some(runtime_guard),
        portable,
        configured,
        warning,
        writable,
        access_controlled: AtomicBool::new(access_controlled),
        editor_lease: Mutex::new(editor_lease),
        admin_notice: Mutex::new(None),
    })
}

fn cleanup_stale_partial_backups(root: &Path) {
    if let Ok(entries) = fs::read_dir(root.join("backups")) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file()
                && path
                    .extension()
                    .is_some_and(|extension| extension == "part")
            {
                let _ = fs::remove_file(path);
            }
        }
    }
}

impl Workspace {
    pub(crate) fn runtime_root(&self) -> &Path {
        &self.runtime_root
    }

    pub(crate) fn access_controlled(&self) -> bool {
        // A different instance can enable protection after this viewer starts.
        self.access_controlled.load(Ordering::SeqCst)
            || self.root.join(ACCESS_CONTROL_FILE).exists()
    }

    #[cfg(test)]
    pub(crate) fn access_message(&self) -> String {
        self.access_message_for(&self.editor_state())
    }

    pub(crate) fn access_message_for(&self, state: &EditorState) -> String {
        if self.is_editor() {
            if self.access_controlled() {
                "Режим редактирования включён по паролю; эксклюзивная блокировка получена."
            } else {
                "Редактирование разрешено: получена эксклюзивная блокировка общей папки."
            }
            .to_string()
        } else if !self.writable {
            "Только просмотр и экспорт: файловая система не разрешает запись.".to_string()
        } else if let Some(presence) = &state.presence {
            format!(
                "Только просмотр: сессия редактора закреплена за {}. Попросите пользователя выйти из режима редактора. После аварийного завершения может потребоваться восстановление сессии.",
                presence.owner.display_name
            )
        } else if state.busy {
            state.message.clone().unwrap_or_else(|| {
                "Только просмотр: сессия редактора занята. Дождитесь её освобождения.".to_string()
            })
        } else if self.access_controlled() {
            "Только просмотр. Для редактирования введите пароль рабочей папки.".to_string()
        } else {
            "Только просмотр и экспорт. Редактирование в этом экземпляре не включено.".to_string()
        }
    }

    pub(crate) fn acquire_editor_with_password(&self, password: &str) -> Result<(), String> {
        if !self.writable {
            return Err("Файловая система не разрешает запись".to_string());
        }
        if self.access_controlled() {
            verify_access_password(&self.root, password)?;
        }
        let mut lease = self
            .editor_lease
            .lock()
            .map_err(|_| "Переключение режима недоступно".to_string())?;
        if lease.active {
            drop(lease);
            return self.require_editor();
        }
        if lease.cleanup_pending() {
            self.release_lease(&mut lease, "Повторное освобождение перед входом")?;
        }
        let next = acquire_editor_lease(&self.root, true);
        if !next.active {
            if next.cleanup_pending() {
                let message = next.cleanup_error.clone().unwrap_or_else(|| {
                    "Не завершено освобождение частично опубликованного сеанса".into()
                });
                *lease = next;
                return Err(message);
            }
            let state = read_editor_state(&self.root);
            let owner = state
                .presence
                .map(|presence| presence.owner.display_name)
                .unwrap_or_else(|| "другой пользователь".to_string());
            return Err(format!(
                "Не удалось получить сессию редактора: {owner}. Пароль не позволяет забрать его права. Попросите редактора перейти в режим просмотра или закрыть программу и повторите вход. После аварийного завершения сессия не освобождается автоматически. {}",
                state.message.unwrap_or_default()
            ));
        }
        *lease = next;
        if let Ok(mut notice) = self.admin_notice.lock() {
            *notice = None;
        }
        Ok(())
    }

    pub(crate) fn release_editor_with_password(&self, password: &str) -> Result<(), String> {
        if self.access_controlled() {
            verify_access_password(&self.root, password)?;
        }
        self.release_editor_on_exit()
    }

    pub(crate) fn release_editor_on_exit(&self) -> Result<(), String> {
        // Closing the application never needs a password. This only drops the
        // current process's lease and is also called explicitly by Tauri's Exit
        // event, because std::process::exit does not run Rust Drop handlers.
        let mut lease = self
            .editor_lease
            .lock()
            .map_err(|_| "Переключение режима недоступно".to_string())?;
        let result = self.release_lease(&mut lease, "Освобождение собственного режима редактора");
        if let Err(error) = &result {
            log_release_error(&lease.token, error);
        }
        result
    }

    fn release_lease(&self, lease: &mut EditorLease, reason: &str) -> Result<(), String> {
        let had_claim = lease.presence_path.is_some();
        let was_cleanup_pending = lease.cleanup_pending();
        lease
            .release_reason
            .get_or_insert_with(|| reason.to_string());
        let result = lease.release_checked();
        if had_claim {
            let action = if result.is_ok() {
                "release-acknowledged"
            } else {
                "release-failed"
            };
            let detail = format!(
                "{}. {}",
                lease.release_reason.as_deref().unwrap_or(reason),
                result
                    .as_ref()
                    .err()
                    .map(String::as_str)
                    .unwrap_or("Собственная запись сеанса освобождена")
            );
            if (result.is_ok() || !lease.failure_audited)
                && self
                    .root
                    .join(".workspace-administration.sqlite3")
                    .is_file()
            {
                match crate::administration::record_session_event(
                    &self.root,
                    &self.actor_name(),
                    &lease.token,
                    action,
                    &detail,
                ) {
                    Ok(()) => lease.failure_audited = result.is_err(),
                    Err(error) => log_release_error(
                        &lease.token,
                        &format!("Событие {action} не записано: {error}"),
                    ),
                }
            }
        }
        if let Err(error) = &result {
            if let Ok(mut notice) = self.admin_notice.lock() {
                *notice = Some(error.clone());
            }
        } else if was_cleanup_pending && let Ok(mut notice) = self.admin_notice.lock() {
            *notice = Some("Собственная сессия успешно освобождена после повторной проверки. Режим просмотра сохранён; для редактирования нужен обычный вход.".into());
        }
        result
    }

    pub(crate) fn editor_cleanup_pending(&self) -> bool {
        self.editor_lease
            .lock()
            .map(|lease| lease.cleanup_pending())
            .unwrap_or(true)
    }

    pub(crate) fn editor_cleanup_message(&self) -> Option<String> {
        self.editor_lease.lock().ok()?.cleanup_error.clone()
    }

    pub(crate) fn retry_pending_editor_release(&self) -> Result<(), String> {
        let mut lease = self
            .editor_lease
            .lock()
            .map_err(|_| "Проверка освобождения недоступна")?;
        if lease.cleanup_pending() {
            self.release_lease(
                &mut lease,
                "Повторная проверка освобождения собственного сеанса",
            )?;
        }
        Ok(())
    }

    pub(crate) fn set_access_password(
        &self,
        current_password: &str,
        new_password: &str,
    ) -> Result<(), String> {
        self.require_editor().map_err(|_| {
            "Установить или сменить пароль может только текущий редактор".to_string()
        })?;
        if self.access_controlled() {
            verify_access_password(&self.root, current_password)?;
        }
        write_access_control(&self.root, new_password)?;
        self.access_controlled.store(true, Ordering::SeqCst);
        Ok(())
    }
    pub(crate) fn is_editor(&self) -> bool {
        self.editor_lease
            .lock()
            .map(|lease| lease.active)
            .unwrap_or(false)
    }

    #[cfg(test)]
    pub(crate) fn editor_owner(&self) -> Option<EditorOwner> {
        self.editor_state().presence.map(|presence| presence.owner)
    }

    pub(crate) fn actor_name(&self) -> String {
        current_editor_owner().display_name
    }

    #[cfg(test)]
    pub(crate) fn editor_presence(&self) -> Option<EditorPresence> {
        self.editor_state().presence
    }

    pub(crate) fn editor_state(&self) -> EditorState {
        let Ok(lease) = self.editor_lease.lock() else {
            return EditorState::unknown("Проверка текущей сессии редактора недоступна.");
        };
        if lease.active {
            return EditorState {
                busy: true,
                presence: lease.owner.clone().map(|owner| EditorPresence {
                    token: lease.token.clone(),
                    owner,
                }),
                message: None,
            };
        }
        drop(lease);
        read_editor_state(&self.root)
    }

    pub(crate) fn admin_notice(&self) -> Option<String> {
        self.admin_notice.lock().ok()?.clone()
    }

    pub(crate) fn require_editor(&self) -> Result<(), String> {
        let mut lease = self
            .editor_lease
            .lock()
            .map_err(|_| "Проверка блокировки недоступна".to_string())?;
        if !lease.active {
            return Err(lease.cleanup_error.clone().unwrap_or_else(|| "Общая база открыта только для просмотра. Для изменения нужны права записи на папку и свободная блокировка редактора.".to_string()));
        }
        let request = match crate::administration::latest_request(&self.root, &lease.token) {
            Ok(request) => request,
            Err(error) => {
                let message = format!(
                    "Не удалось проверить управление сессией редактора; включён просмотр: {error}"
                );
                if let Ok(mut notice) = self.admin_notice.lock() {
                    *notice = Some(message.clone());
                }
                let _ = self.release_lease(
                    &mut lease,
                    "Отключение записи: управление сессией недоступно",
                );
                return Err(message);
            }
        };
        if let Some(request) = request {
            let revoked = request.action == "revoke-requested";
            let message = format!(
                "{} {}: {}. {}",
                request.actor,
                if revoked {
                    "отозвал текущий режим редактора"
                } else {
                    "просит освободить режим редактора"
                },
                request.reason,
                if revoked {
                    "Включён просмотр. Несохранённый ввод не удалён; для новой записи требуется обычный вход в режим редактора"
                } else {
                    "Завершите работу и перейдите в режим просмотра в настройках"
                }
            );
            if let Ok(mut notice) = self.admin_notice.lock() {
                *notice = Some(message.clone());
            }
            if revoked {
                // Called under AppState.maintenance: outstanding writes finish
                // before this cooperative release. Never rewrite/remove another
                // process's lock or bypass the ordinary workspace password.
                let release = self.release_lease(
                    &mut lease,
                    &format!("Отзыв по запросу #{}: {}", request.id, request.reason),
                );
                return Err(release.err().unwrap_or(message));
            }
        }
        // Verify the ownership markers through the already locked handles.
        // Reopening them here used to release both exclusive locks for a brief
        // interval, so a second process could become editor while a save was
        // starting.
        let token = lease.token.clone();
        let result = lease
            .edit
            .as_mut()
            .ok_or_else(|| "Основная блокировка отсутствует".to_string())
            .and_then(|file| verify_locked_token(file, &token))
            .and_then(|_| {
                lease
                    .guard
                    .as_mut()
                    .ok_or_else(|| "Страхующая блокировка отсутствует".to_string())
                    .and_then(|file| verify_locked_token(file, &token))
            })
            .and_then(|_| verify_presence_token(&self.root, &token));
        if result.is_err() {
            let _ = self.release_lease(
                &mut lease,
                "Отключение записи после потери подтверждения блокировки",
            );
        }
        result.map_err(|error: String| {
            format!(
                "Блокировка общей папки потеряна; включён просмотр. Повторно войдите в режим редактирования в настройках, когда он освободится: {error}"
            )
        })
    }

    #[cfg(test)]
    pub(crate) fn for_test(root: PathBuf, editor: bool) -> Self {
        fs::create_dir_all(&root).expect("test workspace root");
        let lease = acquire_editor_lease(&root, editor);
        let (runtime_root, runtime_guard) =
            create_runtime_root(&root, true).expect("test runtime root");
        Self {
            root,
            runtime_root,
            runtime_guard: Some(runtime_guard),
            portable: false,
            configured: true,
            warning: None,
            writable: editor,
            access_controlled: AtomicBool::new(false),
            editor_lease: Mutex::new(lease),
            admin_notice: Mutex::new(None),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use uuid::Uuid;

    #[test]
    fn editor_state_is_unknown_when_parent_disappears_during_claim_or_lock_probe() {
        for disappear_during_claim in [false, true] {
            let root = std::env::temp_dir().join(format!("sbk-state-mid-probe-{}", Uuid::new_v4()));
            fs::create_dir(&root).unwrap();
            let state = read_editor_state_with(
                &root,
                |path| {
                    if disappear_during_claim {
                        fs::remove_dir(&root).unwrap();
                    }
                    fs::read(path)
                },
                |path| {
                    if !disappear_during_claim {
                        fs::remove_dir(&root).unwrap();
                    }
                    OpenOptions::new().read(true).open(path)
                },
            );
            assert!(state.busy, "a disappeared share must not be shown as free");
            assert!(state.presence.is_none());
            assert!(state.message.is_some());
            assert!(!root.exists());
        }
    }

    #[test]
    fn editor_state_rechecks_a_claim_that_reappeared_after_not_found() {
        let root = std::env::temp_dir().join(format!("sbk-state-reappeared-{}", Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let token = Uuid::new_v4().to_string();
        let state = read_editor_state_with(
            &root,
            |path| {
                let missing = fs::read(path).unwrap_err();
                write_editor_presence(&root, &token, &current_editor_owner()).unwrap();
                Err(missing)
            },
            |path| OpenOptions::new().read(true).open(path),
        );
        assert!(state.busy);
        assert!(state.message.is_some());
        assert_eq!(read_editor_state(&root).presence.unwrap().token, token);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn missing_claim_requires_a_fresh_readable_parent_not_a_network_error() {
        let root =
            std::env::temp_dir().join(format!("sbk-claim-missing-parent-{}", Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let path = root.join(EDITOR_PRESENCE_FILE);
        let missing = fs::read(&path).unwrap_err();
        confirm_claim_absent_after_error(&path, &missing).unwrap();
        fs::write(&path, b"reappeared").unwrap();
        assert!(confirm_claim_absent_after_error(&path, &missing).is_err());
        fs::remove_file(&path).unwrap();
        #[cfg(windows)]
        for code in [53, 67] {
            assert!(
                confirm_claim_absent_after_error(&path, &std::io::Error::from_raw_os_error(code))
                    .is_err()
            );
        }
        fs::remove_dir(&root).unwrap();
        assert!(confirm_claim_absent_after_error(&path, &missing).is_err());
    }

    #[test]
    fn recovery_lock_errors_distinguish_contention_from_unavailable_storage() {
        let path = Path::new("synthetic-workspace/.workspace.edit.lock");
        let contended = recovery_lock_error(path, &fs2::lock_contended_error());
        assert!(contended.contains("удерживается редактором"));
        let unavailable = recovery_lock_error(
            path,
            &std::io::Error::from(std::io::ErrorKind::PermissionDenied),
        );
        assert!(unavailable.contains("Состояние неизвестно"));
        assert!(unavailable.contains("synthetic-workspace/.workspace.edit.lock"));
        assert!(!unavailable.contains("удерживается редактором"));
        #[cfg(windows)]
        {
            let unsupported = recovery_lock_error(path, &std::io::Error::from_raw_os_error(50));
            assert!(unsupported.contains("Состояние неизвестно"));
            assert!(unsupported.contains("os error 50"));
        }
    }

    #[test]
    fn partial_presence_publication_keeps_disabled_cleanup_responsibility() {
        let root = std::env::temp_dir().join(format!("sbk-publish-failure-{}", Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let mut lease = acquire_editor_lease_with(&root, true, |root, token, owner| {
            publish_editor_presence_with(root, token, owner, |file, encoded| {
                file.write_all(&encoded[..8])?;
                Err(std::io::ErrorKind::WriteZero.into())
            })
        });
        assert!(!lease.active);
        assert!(lease.cleanup_pending());
        assert!(lease.edit.is_some() && lease.guard.is_some());
        assert!(
            lease.release_checked().is_err(),
            "unknown partial claim cannot be removed blindly"
        );
        let claim = fs::read(root.join(EDITOR_PRESENCE_FILE)).unwrap();
        assert_eq!(claim.len(), 8);
        assert!(!acquire_editor_lease(&root, true).active);
        // Isolated fixture teardown leaves no appdata/user files modified.
        lease.presence_path = None;
        drop(lease);
        assert_eq!(fs::read(root.join(EDITOR_PRESENCE_FILE)).unwrap(), claim);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failed_own_release_retains_exact_token_and_locks_until_retry() {
        let root = std::env::temp_dir().join(format!("sbk-release-retry-{}", Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let mut lease = acquire_editor_lease(&root, true);
        let token = lease.token.clone();
        let original = fs::read(root.join(EDITOR_PRESENCE_FILE)).unwrap();
        let error = lease
            .release_with(|_| Err(std::io::ErrorKind::PermissionDenied.into()))
            .unwrap_err();
        assert!(error.contains("освобождение сессии не подтверждено"));
        assert!(!lease.active);
        assert!(lease.cleanup_pending());
        assert_eq!(lease.token, token);
        assert!(lease.edit.is_some() && lease.guard.is_some());
        assert_eq!(fs::read(root.join(EDITOR_PRESENCE_FILE)).unwrap(), original);
        assert!(!acquire_editor_lease(&root, true).active);
        lease.release_checked().unwrap();
        assert!(!lease.cleanup_pending());
        assert!(lease.cleanup_error.is_none());
        assert!(lease.edit.is_none() && lease.guard.is_none());
        let next = acquire_editor_lease(&root, true);
        assert!(next.active);
        drop(next);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unreadable_own_claim_disables_writes_and_status_retry_audits_success_once() {
        let root = std::env::temp_dir().join(format!("sbk-release-read-retry-{}", Uuid::new_v4()));
        let editor = Workspace::for_test(root.clone(), true);
        crate::administration::setup(&root, "separate-owner-password", "owner").unwrap();
        let path = root.join(EDITOR_PRESENCE_FILE);
        let original = fs::read(&path).unwrap();
        let token = editor.editor_presence().unwrap().token;
        // A directory in place of the claim models an unreadable/invalid path
        // without changing permissions on any real user or network directory.
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        assert!(editor.release_editor_on_exit().is_err());
        assert!(editor.editor_cleanup_pending());
        assert!(editor.require_editor().is_err());
        assert!(editor.retry_pending_editor_release().is_err());
        let failures = crate::administration::events(&root).unwrap();
        assert_eq!(
            failures
                .iter()
                .filter(|event| event.action == "release-failed")
                .count(),
            1
        );
        assert!(
            !failures
                .iter()
                .any(|event| event.action == "release-acknowledged")
        );
        fs::remove_dir(&path).unwrap();
        fs::write(&path, original).unwrap();
        editor.retry_pending_editor_release().unwrap();
        editor.retry_pending_editor_release().unwrap();
        assert!(!editor.is_editor());
        assert!(!editor.editor_cleanup_pending());
        assert!(editor.editor_cleanup_message().is_none());
        let events = crate::administration::events(&root).unwrap();
        assert_eq!(
            events
                .iter()
                .filter(|event| event.action == "release-acknowledged" && event.target == token)
                .count(),
            1
        );
        assert!(
            crate::administration::latest_request(&root, &token)
                .unwrap()
                .is_none()
        );
        drop(editor);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn retry_never_removes_a_foreign_replacement_claim() {
        let root = std::env::temp_dir().join(format!("sbk-release-foreign-{}", Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let mut lease = acquire_editor_lease(&root, true);
        assert!(
            lease
                .release_with(|_| Err(std::io::ErrorKind::PermissionDenied.into()))
                .is_err()
        );
        let path = root.join(EDITOR_PRESENCE_FILE);
        fs::remove_file(&path).unwrap();
        write_editor_presence(&root, &Uuid::new_v4().to_string(), &current_editor_owner()).unwrap();
        let replacement = fs::read(&path).unwrap();
        assert!(
            lease
                .release_checked()
                .unwrap_err()
                .contains("чужая блокировка не изменена")
        );
        assert!(!lease.cleanup_pending());
        drop(lease);
        assert_eq!(fs::read(path).unwrap(), replacement);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn windows_open_claim_without_delete_sharing_keeps_lease_for_successful_retry() {
        use std::os::windows::fs::OpenOptionsExt;
        let root =
            std::env::temp_dir().join(format!("sbk-windows-release-retry-{}", Uuid::new_v4()));
        let editor = Workspace::for_test(root.clone(), true);
        let path = root.join(EDITOR_PRESENCE_FILE);
        let original = fs::read(&path).unwrap();
        // GENERIC_READ is intentional: metadata-only READ_ATTRIBUTES does not
        // establish this Windows sharing denial. Do not share DELETE (0x4).
        let blocker = OpenOptions::new()
            .read(true)
            .share_mode(0x1 | 0x2)
            .open(&path)
            .unwrap();
        let error = editor.release_editor_on_exit().unwrap_err();
        assert!(error.contains("os error 32"), "{error}");
        assert!(!editor.is_editor());
        assert!(editor.editor_cleanup_pending());
        assert_eq!(fs::read(&path).unwrap(), original);
        assert!(!acquire_editor_lease(&root, true).active);
        drop(blocker);
        editor.retry_pending_editor_release().unwrap();
        assert!(!editor.editor_cleanup_pending());
        assert!(!path.exists());
        drop(editor);
        fs::remove_dir_all(root).unwrap();
    }

    fn orphan_fixture() -> (PathBuf, String, Vec<u8>) {
        let root = std::env::temp_dir().join(format!("sbk-owner-recovery-{}", Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let mut lease = acquire_editor_lease(&root, true);
        assert!(lease.active);
        let token = lease.token.clone();
        let original = fs::read(root.join(EDITOR_PRESENCE_FILE)).unwrap();
        // Test-only crash simulation: close both OS handles while preserving
        // exactly the immutable claim that an abrupt process exit leaves.
        lease.presence_path = None;
        drop(lease);
        crate::administration::setup(&root, "separate-owner-password", "owner").unwrap();
        (root, token, original)
    }

    fn recover_fixture(root: &Path, token: &str) -> Result<EditorRecoveryResult, String> {
        recover_workspace_editor_session(
            root,
            "separate-owner-password",
            token,
            "Подтверждено закрытие всех редакторов",
            "ВОССТАНОВИТЬ ДОСТУП",
            true,
        )
    }

    #[test]
    fn confirmed_owner_recovery_archives_exact_claim_and_preserves_normal_password_and_data() {
        let (root, token, original) = orphan_fixture();
        write_access_control(&root, "ordinary-editor-password").unwrap();
        let access_bytes = fs::read(root.join(ACCESS_CONTROL_FILE)).unwrap();
        fs::write(
            root.join("synthetic-user-database.bin"),
            b"unchanged test data",
        )
        .unwrap();
        let lock_bytes = fs::read(root.join(".workspace.edit.lock")).unwrap();
        let guard_bytes = fs::read(root.join(".workspace.edit.guard")).unwrap();
        let viewer = Workspace::for_test(root.clone(), true);
        assert!(!viewer.is_editor());
        let result = recover_fixture(&root, &token).unwrap();
        assert!(
            result
                .archive_file_name
                .starts_with(".workspace-editor.json.recovery-")
        );
        assert_eq!(
            fs::read(root.join(result.archive_file_name)).unwrap(),
            original
        );
        assert!(!root.join(EDITOR_PRESENCE_FILE).exists());
        assert_eq!(
            fs::read(root.join(".workspace.edit.lock")).unwrap(),
            lock_bytes
        );
        assert_eq!(
            fs::read(root.join(".workspace.edit.guard")).unwrap(),
            guard_bytes
        );
        assert_eq!(
            fs::read(root.join(ACCESS_CONTROL_FILE)).unwrap(),
            access_bytes
        );
        assert_eq!(
            fs::read(root.join("synthetic-user-database.bin")).unwrap(),
            b"unchanged test data"
        );
        crate::administration::authenticate(&root, "separate-owner-password").unwrap();
        assert!(!viewer.is_editor(), "recovery grants no editor authority");
        assert!(
            viewer
                .acquire_editor_with_password("separate-owner-password")
                .is_err()
        );
        viewer
            .acquire_editor_with_password("ordinary-editor-password")
            .unwrap();
        assert!(viewer.require_editor().is_ok());
        let events = crate::administration::events(&root).unwrap();
        assert!(
            events
                .iter()
                .any(|event| event.action == "recovery-intent" && event.target == token)
        );
        assert!(
            events
                .iter()
                .any(|event| event.action == "recovery-completed" && event.target == token)
        );
        drop(viewer);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn recovery_requires_fresh_owner_auth_exact_confirmation_target_and_reason() {
        let (root, token, original) = orphan_fixture();
        for (password, target, reason, phrase, closed) in [
            (
                "incorrect-owner-password",
                token.as_str(),
                "Причина",
                "ВОССТАНОВИТЬ ДОСТУП",
                true,
            ),
            (
                "separate-owner-password",
                token.as_str(),
                "Причина",
                "ВОССТАНОВИТЬ ДОСТУП",
                false,
            ),
            (
                "separate-owner-password",
                token.as_str(),
                "Причина",
                "да",
                true,
            ),
            (
                "separate-owner-password",
                token.as_str(),
                "  ",
                "ВОССТАНОВИТЬ ДОСТУП",
                true,
            ),
            (
                "separate-owner-password",
                "unknown",
                "Причина",
                "ВОССТАНОВИТЬ ДОСТУП",
                true,
            ),
        ] {
            assert!(
                recover_workspace_editor_session(&root, password, target, reason, phrase, closed)
                    .is_err()
            );
            assert_eq!(fs::read(root.join(EDITOR_PRESENCE_FILE)).unwrap(), original);
        }
        assert!(recover_fixture(&root, &Uuid::new_v4().to_string()).is_err());
        assert!(
            recover_workspace_editor_session(
                &root,
                "separate-owner-password",
                &token,
                &"a".repeat(501),
                "ВОССТАНОВИТЬ ДОСТУП",
                true
            )
            .is_err()
        );
        assert_eq!(crate::administration::events(&root).unwrap().len(), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn recovery_refuses_either_active_lock_and_never_creates_missing_lock_files() {
        let (root, token, original) = orphan_fixture();
        for name in [".workspace.edit.lock", ".workspace.edit.guard"] {
            let blocker = lock_editor_file(&root.join(name)).unwrap();
            assert!(
                recover_fixture(&root, &token)
                    .unwrap_err()
                    .contains("удерживается")
            );
            assert_eq!(fs::read(root.join(EDITOR_PRESENCE_FILE)).unwrap(), original);
            drop(blocker);
        }
        fs::remove_file(root.join(".workspace.edit.guard")).unwrap();
        assert!(recover_fixture(&root, &token).is_err());
        assert!(!root.join(".workspace.edit.guard").exists());
        assert_eq!(fs::read(root.join(EDITOR_PRESENCE_FILE)).unwrap(), original);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn recovery_refuses_inconsistent_lock_markers_without_changing_them() {
        let (root, token, original) = orphan_fixture();
        let guard = root.join(".workspace.edit.guard");
        let foreign_token = Uuid::new_v4().to_string();
        fs::write(&guard, &foreign_token).unwrap();
        assert!(
            recover_fixture(&root, &token)
                .unwrap_err()
                .contains("Маркеры блокировок не соответствуют")
        );
        assert_eq!(fs::read_to_string(&guard).unwrap(), foreign_token);
        assert_eq!(fs::read(root.join(EDITOR_PRESENCE_FILE)).unwrap(), original);
        assert_eq!(crate::administration::events(&root).unwrap().len(), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn recovery_refuses_missing_malformed_and_directory_claims() {
        let (root, token, _) = orphan_fixture();
        let path = root.join(EDITOR_PRESENCE_FILE);
        fs::remove_file(&path).unwrap();
        assert!(recover_fixture(&root, &token).is_err());
        fs::write(&path, b"{partial").unwrap();
        assert!(recover_fixture(&root, &token).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"{partial");
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        assert!(recover_fixture(&root, &token).is_err());
        assert!(path.is_dir());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn recovery_refuses_symlink_claims_and_lock_paths() {
        use std::os::unix::fs::symlink;
        let (root, token, original) = orphan_fixture();
        let path = root.join(EDITOR_PRESENCE_FILE);
        let destination = root.join("synthetic-original-claim");
        fs::rename(&path, &destination).unwrap();
        symlink(&destination, &path).unwrap();
        assert!(recover_fixture(&root, &token).is_err());
        assert_eq!(fs::read(&destination).unwrap(), original);
        fs::remove_file(&path).unwrap();
        fs::rename(&destination, &path).unwrap();
        fs::remove_file(root.join(".workspace.edit.guard")).unwrap();
        symlink(
            root.join(".workspace.edit.lock"),
            root.join(".workspace.edit.guard"),
        )
        .unwrap();
        assert!(recover_fixture(&root, &token).is_err());
        assert_eq!(fs::read(&path).unwrap(), original);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn recovery_detects_claim_change_after_archive_without_removing_replacement() {
        let (root, token, original) = orphan_fixture();
        let path = root.join(EDITOR_PRESENCE_FILE);
        let other = Uuid::new_v4().to_string();
        let error = recover_confirmed_claim(
            &root,
            &token,
            "Контроль гонки записи",
            || {
                fs::remove_file(&path).unwrap();
                write_editor_presence(&root, &other, &current_editor_owner()).unwrap();
            },
        )
        .unwrap_err();
        assert!(error.contains("изменилась перед освобождением"));
        assert_eq!(read_editor_state(&root).presence.unwrap().token, other);
        let archives: Vec<_> = fs::read_dir(&root)
            .unwrap()
            .map(Result::unwrap)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".workspace-editor.json.recovery-")
            })
            .collect();
        assert_eq!(archives.len(), 1);
        assert_eq!(fs::read(archives[0].path()).unwrap(), original);
        let events = crate::administration::events(&root).unwrap();
        assert!(events.iter().any(|event| event.action == "recovery-failed"));
        assert!(
            !events
                .iter()
                .any(|event| event.action == "recovery-completed")
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn exactly_one_process_owns_the_editor_lock() {
        if let Ok(root) = std::env::var("SBK_LOCK_TEST_CHILD_ROOT") {
            let expected = std::env::var("SBK_LOCK_TEST_CHILD_EXPECTED")
                .expect("expected editor state")
                == "true";
            let lease = acquire_editor_lease(Path::new(&root), true);
            assert_eq!(lease.active, expected);
            if !expected {
                let owner = read_editor_state(Path::new(&root))
                    .presence
                    .expect("viewer sees editor identity even without write access")
                    .owner;
                assert!(!owner.display_name.is_empty());
            }
            return;
        }
        let root = std::env::temp_dir().join(format!("sbk-shared-lock-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("temp workspace");
        let first = acquire_editor_lease(&root, true);
        assert!(first.active);
        let run_child = |expected: bool| {
            let status = Command::new(std::env::current_exe().expect("test executable"))
                .args([
                    "--exact",
                    "workspace::tests::exactly_one_process_owns_the_editor_lock",
                    "--nocapture",
                ])
                .env("SBK_LOCK_TEST_CHILD_ROOT", &root)
                .env(
                    "SBK_LOCK_TEST_CHILD_EXPECTED",
                    if expected { "true" } else { "false" },
                )
                .status()
                .expect("spawn competing process");
            assert!(status.success());
        };
        run_child(false);
        drop(first);
        run_child(true);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn viewer_message_updates_after_editor_exits() {
        let root = std::env::temp_dir().join(format!("sbk-viewer-message-{}", Uuid::new_v4()));
        let editor = Workspace::for_test(root.clone(), true);
        let viewer = Workspace::for_test(root.clone(), true);
        assert!(
            viewer
                .access_message()
                .contains("сессия редактора закреплена за")
        );
        drop(editor);
        assert!(viewer.editor_owner().is_none());
        assert_eq!(
            viewer.access_message(),
            "Только просмотр и экспорт. Редактирование в этом экземпляре не включено."
        );
        viewer.acquire_editor_with_password("").unwrap();
        assert!(viewer.is_editor());
        drop(viewer);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn remote_presence_remains_authoritative_when_advisory_locks_appear_free() {
        let root = std::env::temp_dir().join(format!("sbk-remote-presence-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let remote_token = Uuid::new_v4().to_string();
        let owner = EditorOwner {
            display_name: "Коллега · REMOTE-PC".into(),
            user_name: "Коллега".into(),
            device_name: "REMOTE-PC".into(),
            // Neither an old timestamp nor a PID not present on this computer
            // proves that a different computer has stopped editing.
            started_at: "2020-01-01T00:00:00Z".into(),
        };
        write_editor_presence(&root, &remote_token, &owner).unwrap();
        let mut remote_json: serde_json::Value =
            serde_json::from_slice(&fs::read(root.join(EDITOR_PRESENCE_FILE)).unwrap()).unwrap();
        remote_json["processId"] = serde_json::json!(4_000_000_000u64);
        fs::write(
            root.join(EDITOR_PRESENCE_FILE),
            serde_json::to_vec(&remote_json).unwrap(),
        )
        .unwrap();
        for name in [".workspace.edit.lock", ".workspace.edit.guard"] {
            fs::write(root.join(name), &remote_token).unwrap();
            let file = lock_editor_file(&root.join(name)).unwrap();
            drop(file); // Simulate a client that sees no remote advisory lock.
        }
        write_access_control(&root, "shared-editor-password").unwrap();
        let viewer = Workspace::for_test(root.clone(), true);
        assert!(!viewer.is_editor());
        let state = viewer.editor_state();
        assert!(state.busy);
        assert!(state.message.is_none());
        let presence = state.presence.unwrap();
        assert_eq!(presence.owner.device_name, "REMOTE-PC");
        assert_eq!(presence.token, remote_token);
        assert!(
            viewer
                .acquire_editor_with_password("shared-editor-password")
                .is_err()
        );
        for name in [".workspace.edit.lock", ".workspace.edit.guard"] {
            assert_eq!(fs::read_to_string(root.join(name)).unwrap(), remote_token);
        }
        drop(viewer);
        assert_eq!(
            read_editor_state(&root).presence.unwrap().token,
            remote_token
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn atomic_presence_claim_allows_only_one_contender_without_advisory_locks() {
        let root = std::env::temp_dir().join(format!("sbk-claim-race-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let start = std::sync::Arc::new(std::sync::Barrier::new(2));
        let children: Vec<_> = (0..2)
            .map(|_| {
                let root = root.clone();
                let start = start.clone();
                std::thread::spawn(move || {
                    let token = Uuid::new_v4().to_string();
                    let owner = current_editor_owner();
                    start.wait();
                    write_editor_presence(&root, &token, &owner)
                        .ok()
                        .map(|_| token)
                })
            })
            .collect();
        let winners: Vec<_> = children
            .into_iter()
            .filter_map(|child| child.join().unwrap())
            .collect();
        assert_eq!(winners.len(), 1);
        assert_eq!(read_editor_state(&root).presence.unwrap().token, winners[0]);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn malformed_or_unreadable_presence_is_busy_and_never_overwritten() {
        for is_directory in [false, true] {
            let root =
                std::env::temp_dir().join(format!("sbk-unknown-presence-{}", Uuid::new_v4()));
            fs::create_dir_all(&root).unwrap();
            let path = root.join(EDITOR_PRESENCE_FILE);
            if is_directory {
                fs::create_dir(&path).unwrap();
            } else {
                fs::write(&path, b"{partial identity").unwrap();
            }
            let viewer = Workspace::for_test(root.clone(), true);
            let state = viewer.editor_state();
            assert!(state.busy);
            assert!(state.presence.is_none());
            assert!(state.message.is_some());
            assert!(!viewer.is_editor(), "publishing an identity is mandatory");
            assert!(viewer.acquire_editor_with_password("").is_err());
            assert!(viewer.access_message().contains("заблокирован"));
            drop(viewer);
            if is_directory {
                assert!(path.is_dir());
            } else {
                assert_eq!(fs::read(path).unwrap(), b"{partial identity");
            }
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn unavailable_workspace_is_unknown_not_free() {
        let root =
            std::env::temp_dir().join(format!("sbk-unavailable-workspace-{}", Uuid::new_v4()));
        let state = read_editor_state(&root);
        assert!(state.busy);
        assert!(state.presence.is_none());
        assert!(state.message.unwrap().contains("недоступна"));
        assert!(!acquire_editor_lease(&root, true).active);
        assert!(!root.exists());
    }

    #[test]
    fn occupied_guard_without_identity_is_unknown_and_preserves_first_token() {
        let root = std::env::temp_dir().join(format!("sbk-partial-lock-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join(".workspace.edit.lock"), b"incumbent-token").unwrap();
        let guard = lock_editor_file(&root.join(".workspace.edit.guard")).unwrap();
        let state = read_editor_state(&root);
        assert!(state.busy);
        assert!(state.presence.is_none());
        assert!(state.message.is_some());
        assert!(!acquire_editor_lease(&root, true).active);
        assert_eq!(
            fs::read(root.join(".workspace.edit.lock")).unwrap(),
            b"incumbent-token"
        );
        drop(guard);
        // Another concurrently running test may briefly inherit open handles
        // between fork and exec. Allow that child to reach close-on-exec.
        for _ in 0..50 {
            if !read_editor_state(&root).busy {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(!read_editor_state(&root).busy);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn lost_presence_demotes_editor_without_removing_another_sessions_claim() {
        for corrupt in [false, true] {
            let root = std::env::temp_dir().join(format!("sbk-lost-presence-{}", Uuid::new_v4()));
            let editor = Workspace::for_test(root.clone(), true);
            assert!(editor.require_editor().is_ok());
            let path = root.join(EDITOR_PRESENCE_FILE);
            fs::remove_file(&path).unwrap();
            if corrupt {
                fs::write(&path, b"{partial identity").unwrap();
            } else {
                write_editor_presence(&root, &Uuid::new_v4().to_string(), &current_editor_owner())
                    .unwrap();
            }
            let replacement = fs::read(&path).unwrap();
            assert!(editor.require_editor().is_err());
            assert!(!editor.is_editor());
            drop(editor);
            assert_eq!(fs::read(path).unwrap(), replacement);
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn explicit_application_exit_releases_only_its_own_password_protected_session() {
        let root = std::env::temp_dir().join(format!("sbk-explicit-exit-{}", Uuid::new_v4()));
        let editor = Workspace::for_test(root.clone(), true);
        let viewer = Workspace::for_test(root.clone(), true);
        editor
            .set_access_password("", "shared-editor-password")
            .unwrap();
        let token = editor.editor_presence().unwrap().token;
        viewer.release_editor_on_exit().unwrap();
        assert_eq!(editor.editor_presence().unwrap().token, token);
        assert!(editor.require_editor().is_ok());
        editor.release_editor_on_exit().unwrap();
        assert!(!editor.is_editor());
        assert!(!root.join(EDITOR_PRESENCE_FILE).exists());
        viewer
            .acquire_editor_with_password("shared-editor-password")
            .unwrap();
        assert!(viewer.require_editor().is_ok());
        drop(editor);
        assert!(viewer.require_editor().is_ok());
        drop(viewer);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn inaccessible_administration_state_demotes_instead_of_reporting_active_editor() {
        let root = std::env::temp_dir().join(format!("sbk-admin-unavailable-{}", Uuid::new_v4()));
        let editor = Workspace::for_test(root.clone(), true);
        fs::write(
            root.join(".workspace-administration.sqlite3"),
            b"not a database",
        )
        .unwrap();
        assert!(editor.require_editor().is_err());
        assert!(!editor.is_editor());
        assert!(editor.admin_notice().unwrap().contains("включён просмотр"));
        drop(editor);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn crashed_session_is_not_taken_over_based_on_local_lock_or_pid() {
        if let Ok(root) = std::env::var("SBK_CRASH_CLAIM_TEST_ROOT") {
            let lease = acquire_editor_lease(Path::new(&root), true);
            assert!(lease.active);
            // Simulate abrupt termination: file locks are released by the OS,
            // but a Drop handler cannot remove the published session claim.
            std::process::exit(0);
        }
        let root = std::env::temp_dir().join(format!("sbk-crashed-claim-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let status = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "workspace::tests::crashed_session_is_not_taken_over_based_on_local_lock_or_pid",
                "--nocapture",
            ])
            .env("SBK_CRASH_CLAIM_TEST_ROOT", &root)
            .status()
            .unwrap();
        assert!(status.success());
        assert!(read_editor_state(&root).busy);
        assert!(!acquire_editor_lease(&root, true).active);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn password_cannot_take_over_another_editor_and_viewer_detects_new_password() {
        let root = std::env::temp_dir().join(format!("sbk-password-handoff-{}", Uuid::new_v4()));
        let editor = Workspace::for_test(root.clone(), true);
        let viewer = Workspace::for_test(root.clone(), true);
        assert!(editor.is_editor());
        assert!(!viewer.is_editor());
        assert!(!viewer.access_controlled());
        editor.set_access_password("", "editor-password").unwrap();
        assert!(viewer.access_controlled());
        assert!(
            viewer
                .acquire_editor_with_password("wrong-password")
                .is_err()
        );
        let reason = viewer
            .acquire_editor_with_password("editor-password")
            .unwrap_err();
        assert!(reason.contains("Пароль не позволяет забрать его права"));
        assert!(editor.require_editor().is_ok());
        assert!(!viewer.is_editor());
        assert_eq!(
            editor.editor_owner().unwrap().started_at,
            viewer.editor_owner().unwrap().started_at
        );
        editor
            .release_editor_with_password("editor-password")
            .unwrap();
        assert!(viewer.editor_owner().is_none());
        assert!(
            viewer
                .acquire_editor_with_password("wrong-password")
                .is_err()
        );
        viewer
            .acquire_editor_with_password("editor-password")
            .unwrap();
        assert!(viewer.require_editor().is_ok());
        assert!(!editor.is_editor());
        drop(viewer);
        drop(editor);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn filesystem_read_only_mode_never_attempts_editor_ownership() {
        let root = std::env::temp_dir().join(format!("sbk-shared-readonly-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("temp workspace");
        assert!(!acquire_editor_lease(&root, false).active);
        assert!(!root.join(".workspace.edit.lock").exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn cooperative_owner_revoke_releases_only_target_lease_without_password_bypass() {
        let root = std::env::temp_dir().join(format!("sbk-cooperative-owner-{}", Uuid::new_v4()));
        let editor = Workspace::for_test(root.clone(), true);
        let next = Workspace::for_test(root.clone(), true);
        editor
            .set_access_password("", "ordinary-editor-password")
            .unwrap();
        crate::administration::setup(&root, "separate-owner-password", "owner").unwrap();
        let target = editor.editor_presence().unwrap();
        crate::administration::record_request(
            &root,
            "viewer",
            &target.token,
            "Просьба освободить",
            false,
        )
        .unwrap();
        assert!(
            editor.require_editor().is_ok(),
            "ordinary request cannot revoke"
        );
        assert!(editor.admin_notice().unwrap().contains("просит"));
        crate::administration::record_request(
            &root,
            "owner",
            &target.token,
            "Завершить редактирование",
            true,
        )
        .unwrap();
        assert!(
            next.acquire_editor_with_password("ordinary-editor-password")
                .is_err(),
            "no forced unlocking of another process"
        );
        assert!(editor.require_editor().is_err());
        assert!(!editor.is_editor());
        assert!(editor.admin_notice().unwrap().contains("отозвал"));
        assert!(
            next.acquire_editor_with_password("separate-owner-password")
                .is_err(),
            "owner password is not a workspace credential"
        );
        next.acquire_editor_with_password("ordinary-editor-password")
            .unwrap();
        assert!(
            next.require_editor().is_ok(),
            "new lease is not targeted by prior revoke"
        );
        assert!(editor.require_editor().is_err());
        drop(next);
        drop(editor);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn validating_a_viewer_layout_never_creates_missing_directories() {
        let root = std::env::temp_dir().join(format!("sbk-shared-layout-{}", Uuid::new_v4()));
        ensure_workspace(&root).expect("prepared workspace");
        fs::remove_dir(root.join("exports")).expect("remove one section");
        assert!(validate_workspace_layout(&root).is_err());
        assert!(!root.join("exports").exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn viewer_cannot_pass_the_backend_edit_guard() {
        let root = std::env::temp_dir().join(format!("sbk-shared-guard-{}", Uuid::new_v4()));
        let workspace = Workspace::for_test(root, false);
        assert!(workspace.require_editor().is_err());
    }

    #[test]
    fn password_control_requires_explicit_verified_mode_switch() {
        let root = std::env::temp_dir().join(format!("sbk-password-access-{}", Uuid::new_v4()));
        ensure_workspace(&root).expect("workspace");
        let workspace = Workspace::for_test(root.clone(), true);
        let owner = workspace.editor_owner().expect("editor identity");
        assert!(!owner.display_name.is_empty());
        assert!(root.join(EDITOR_PRESENCE_FILE).is_file());
        workspace
            .set_access_password("", "correct-horse")
            .expect("set first password");
        assert!(workspace.access_controlled());
        assert!(root.join(ACCESS_CONTROL_FILE).is_file());
        assert!(workspace.release_editor_with_password("wrong").is_err());
        assert!(workspace.is_editor());
        workspace
            .release_editor_with_password("correct-horse")
            .expect("release editor");
        assert!(!workspace.is_editor());
        assert!(!root.join(EDITOR_PRESENCE_FILE).exists());
        assert!(workspace.acquire_editor_with_password("wrong").is_err());
        assert!(!workspace.is_editor());
        workspace
            .acquire_editor_with_password("correct-horse")
            .expect("acquire editor");
        assert!(workspace.is_editor());
        assert!(root.join(EDITOR_PRESENCE_FILE).is_file());
        workspace
            .set_access_password("correct-horse", "new-correct-horse")
            .expect("change password");
        assert!(
            workspace
                .release_editor_with_password("correct-horse")
                .is_err()
        );
        workspace
            .release_editor_with_password("new-correct-horse")
            .expect("new password releases editor");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn password_policy_rejects_short_long_and_padded_values() {
        assert!(validate_new_access_password("123").is_err());
        assert!(validate_new_access_password(&"a".repeat(129)).is_err());
        assert!(validate_new_access_password(" пароль").is_err());
        assert!(validate_new_access_password("Пароль-42!").is_ok());
    }

    #[test]
    fn runtime_directories_are_isolated_between_instances() {
        let root = std::env::temp_dir().join(format!("sbk-runtime-isolation-{}", Uuid::new_v4()));
        ensure_workspace(&root).expect("workspace");
        let first = Workspace::for_test(root.clone(), true);
        let second = Workspace::for_test(root.clone(), false);
        assert_ne!(first.runtime_root(), second.runtime_root());
        let second_marker = second.runtime_root().join("active-preview");
        fs::write(&second_marker, b"ok").expect("marker");
        drop(first);
        assert!(second_marker.is_file());
        drop(second);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn read_only_viewer_uses_system_temp_for_runtime_files() {
        let root = std::env::temp_dir().join(format!("sbk-readonly-runtime-{}", Uuid::new_v4()));
        ensure_workspace(&root).expect("workspace");
        let (runtime, guard) = create_runtime_root(&root, false).expect("viewer runtime root");
        assert!(!runtime.starts_with(&root));
        assert!(runtime.join(".instance.lock").is_file());
        drop(guard);
        let _ = fs::remove_dir_all(runtime);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn token_mismatch_demotes_editor_until_restart() {
        let root = std::env::temp_dir().join(format!("sbk-shared-token-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("temp workspace");
        let workspace = Workspace::for_test(root.clone(), true);
        {
            // Windows enforces byte-range locks even for another handle in the
            // same process. Inject corruption through the owning handle so the
            // test exercises token verification on every supported platform.
            let mut lease = workspace.editor_lease.lock().unwrap();
            let file = lease.edit.as_mut().expect("editor lock");
            file.set_len(0).expect("truncate token");
            file.seek(SeekFrom::Start(0)).expect("seek token");
            file.write_all(b"foreign-owner").expect("corrupt token");
            file.sync_all().expect("flush token");
        }
        assert!(workspace.require_editor().is_err());
        assert!(!workspace.is_editor());
        assert!(workspace.require_editor().is_err());
        drop(workspace);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn existing_layout_can_be_selected_while_editor_is_busy_but_incomplete_cannot() {
        let ready = std::env::temp_dir().join(format!("sbk-shared-ready-{}", Uuid::new_v4()));
        ensure_workspace(&ready).expect("ready workspace");
        let held = acquire_editor_lease(&ready, true);
        assert!(held.active);
        assert!(
            prepare_workspace_location(&ready)
                .expect("read-only selection")
                .is_none()
        );
        drop(held);

        let incomplete =
            std::env::temp_dir().join(format!("sbk-shared-incomplete-{}", Uuid::new_v4()));
        fs::create_dir_all(&incomplete).expect("incomplete root");
        let held = acquire_editor_lease(&incomplete, true);
        assert!(held.active);
        assert!(prepare_workspace_location(&incomplete).is_err());
        assert!(!incomplete.join("settings").exists());
        drop(held);
        let _ = fs::remove_dir_all(ready);
        let _ = fs::remove_dir_all(incomplete);
    }

    #[test]
    fn stale_partial_backups_are_removed_without_touching_completed_files() {
        let root = std::env::temp_dir().join(format!("sbk-stale-part-{}", Uuid::new_v4()));
        ensure_workspace(&root).expect("workspace");
        let partial = root.join("backups").join("interrupted.sbkbackup.part");
        let complete = root.join("backups").join("complete.sbkbackup");
        fs::write(&partial, b"confidential partial data").expect("partial");
        fs::write(&complete, b"complete").expect("complete");
        cleanup_stale_partial_backups(&root);
        assert!(!partial.exists());
        assert!(complete.exists());
        let _ = fs::remove_dir_all(root);
    }
}
