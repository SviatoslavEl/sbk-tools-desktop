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
}

impl Drop for EditorLease {
    fn drop(&mut self) {
        let Some(path) = self.presence_path.take() else {
            return;
        };
        let owned = fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<EditorPresence>(&bytes).ok())
            .is_some_and(|presence| presence.token == self.token);
        if owned {
            let _ = fs::remove_file(path);
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
    let device_name = environment_value(&["COMPUTERNAME", "HOSTNAME"]);
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

fn write_editor_presence(root: &Path, token: &str, owner: &EditorOwner) -> Option<PathBuf> {
    let path = root.join(EDITOR_PRESENCE_FILE);
    let encoded = serde_json::to_vec_pretty(&EditorPresence {
        token: token.to_string(),
        owner: owner.clone(),
    })
    .ok()?;
    let mut file = File::create(&path).ok()?;
    file.write_all(&encoded).ok()?;
    file.sync_all().ok()?;
    Some(path)
}

fn read_editor_presence(root: &Path) -> Option<EditorOwner> {
    let lock = OpenOptions::new()
        .read(true)
        .open(root.join(".workspace.edit.lock"))
        .ok()?;
    if FileExt::try_lock_shared(&lock).is_ok() {
        let _ = FileExt::unlock(&lock);
        return None;
    }
    let bytes = fs::read(root.join(EDITOR_PRESENCE_FILE)).ok()?;
    serde_json::from_slice::<EditorPresence>(&bytes)
        .ok()
        .map(|presence| presence.owner)
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

fn lock_token_file(
    path: &Path,
    token: &str,
    create: bool,
    initialize: bool,
) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options
        .read(true)
        .write(true)
        .create(create)
        .truncate(false);
    let mut file = options.open(path).map_err(|error| error.to_string())?;
    file.try_lock_exclusive()
        .map_err(|error| error.to_string())?;
    if initialize {
        file.set_len(0).map_err(|error| error.to_string())?;
        file.seek(SeekFrom::Start(0))
            .map_err(|error| error.to_string())?;
        file.write_all(token.as_bytes())
            .map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
    } else {
        let mut stored = String::new();
        file.seek(SeekFrom::Start(0))
            .map_err(|error| error.to_string())?;
        file.read_to_string(&mut stored)
            .map_err(|error| error.to_string())?;
        if stored != token {
            return Err("Токен блокировки общей папки изменился".to_string());
        }
    }
    Ok(file)
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

fn acquire_editor_lease(root: &Path, writable: bool) -> EditorLease {
    let token = uuid::Uuid::new_v4().to_string();
    if !writable {
        return EditorLease {
            active: false,
            token,
            edit: None,
            guard: None,
            presence_path: None,
            owner: None,
        };
    }
    let edit = lock_token_file(&root.join(".workspace.edit.lock"), &token, true, true).ok();
    let guard = edit.as_ref().and_then(|_| {
        lock_token_file(&root.join(".workspace.edit.guard"), &token, true, true).ok()
    });
    let active = edit.is_some() && guard.is_some();
    let owner = active.then(current_editor_owner);
    let presence_path = owner
        .as_ref()
        .and_then(|owner| write_editor_presence(root, &token, owner));
    EditorLease {
        active,
        token,
        edit: if active { edit } else { None },
        guard: if active { guard } else { None },
        presence_path,
        owner,
    }
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

    pub(crate) fn access_message(&self) -> String {
        if self.is_editor() {
            if self.access_controlled() {
                "Режим редактирования включён по паролю; эксклюзивная блокировка получена."
            } else {
                "Редактирование разрешено: получена эксклюзивная блокировка общей папки."
            }
            .to_string()
        } else if !self.writable {
            "Только просмотр и экспорт: файловая система не разрешает запись.".to_string()
        } else if let Some(owner) = self.editor_owner() {
            format!(
                "Только просмотр: режим редактирования сейчас у {}. Попросите пользователя выйти из режима редактора.",
                owner.display_name
            )
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
            return Ok(());
        }
        let next = acquire_editor_lease(&self.root, true);
        if !next.active {
            let owner = read_editor_presence(&self.root)
                .map(|owner| owner.display_name)
                .unwrap_or_else(|| "другой пользователь".to_string());
            return Err(format!(
                "Сейчас базу редактирует {owner}. Пароль не позволяет забрать его права. Попросите редактора перейти в режим просмотра или закрыть программу и повторите вход."
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
        let mut lease = self
            .editor_lease
            .lock()
            .map_err(|_| "Переключение режима недоступно".to_string())?;
        *lease = EditorLease {
            active: false,
            token: uuid::Uuid::new_v4().to_string(),
            edit: None,
            guard: None,
            presence_path: None,
            owner: None,
        };
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

    pub(crate) fn editor_owner(&self) -> Option<EditorOwner> {
        let lease = self.editor_lease.lock().ok()?;
        if lease.active {
            return lease.owner.clone();
        }
        drop(lease);
        read_editor_presence(&self.root)
    }

    pub(crate) fn actor_name(&self) -> String {
        current_editor_owner().display_name
    }

    pub(crate) fn editor_presence(&self) -> Option<EditorPresence> {
        let lease = self.editor_lease.lock().ok()?;
        if lease.active {
            return Some(EditorPresence {
                token: lease.token.clone(),
                owner: lease.owner.clone()?,
            });
        }
        drop(lease);
        read_editor_presence(&self.root)?;
        serde_json::from_slice(&fs::read(self.root.join(EDITOR_PRESENCE_FILE)).ok()?).ok()
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
            return Err("Общая база открыта только для просмотра. Для изменения нужны права записи на папку и свободная блокировка редактора.".to_string());
        }
        if let Some(request) = crate::administration::latest_request(&self.root, &lease.token)? {
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
                *lease = EditorLease {
                    active: false,
                    token: uuid::Uuid::new_v4().to_string(),
                    edit: None,
                    guard: None,
                    presence_path: None,
                    owner: None,
                };
                return Err(message);
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
            });
        if result.is_err() {
            *lease = EditorLease {
                active: false,
                token: uuid::Uuid::new_v4().to_string(),
                edit: None,
                guard: None,
                presence_path: None,
                owner: None,
            };
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
    fn exactly_one_process_owns_the_editor_lock() {
        if let Ok(root) = std::env::var("SBK_LOCK_TEST_CHILD_ROOT") {
            let expected = std::env::var("SBK_LOCK_TEST_CHILD_EXPECTED")
                .expect("expected editor state")
                == "true";
            let lease = acquire_editor_lease(Path::new(&root), true);
            assert_eq!(lease.active, expected);
            if !expected {
                let owner = read_editor_presence(Path::new(&root))
                    .expect("viewer sees editor identity even without write access");
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
                .contains("режим редактирования сейчас у")
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
