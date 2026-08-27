use fs2::FileExt;
use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};

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
    pub(crate) portable: bool,
    pub(crate) configured: bool,
    pub(crate) warning: Option<String>,
    pub(crate) writable: bool,
    pub(crate) _lock: File,
}

impl Drop for Workspace {
    fn drop(&mut self) {
        let runtime = self.root.join("runtime-cache");
        let _ = fs::remove_dir_all(&runtime);
        let _ = fs::create_dir_all(runtime);
    }
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

pub(crate) fn open_workspace() -> Result<Workspace, String> {
    let (preferred, mut portable, mut configured) = product_directory()?;
    let mut root = preferred.clone();
    let mut warning = None;
    if ensure_workspace(&root).is_err() {
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
        .truncate(false)
        .read(true)
        .write(true)
        .open(root.join(".workspace.lock"))
        .map_err(|error| format!("Не удалось открыть блокировку workspace: {error}"))?;
    lock.try_lock_exclusive()
        .map_err(|_| "Эта рабочая папка уже открыта в другом экземпляре приложения.".to_string())?;
    let runtime = root.join("runtime-cache");
    fs::remove_dir_all(&runtime)
        .map_err(|error| format!("Не удалось очистить временные данные: {error}"))?;
    fs::create_dir_all(&runtime)
        .map_err(|error| format!("Не удалось подготовить временные данные: {error}"))?;
    let attachment_staging = root.join("attachment-staging");
    fs::remove_dir_all(&attachment_staging)
        .map_err(|error| format!("Не удалось очистить временные вложения: {error}"))?;
    fs::create_dir_all(&attachment_staging)
        .map_err(|error| format!("Не удалось подготовить временные вложения: {error}"))?;
    Ok(Workspace {
        root,
        portable,
        configured,
        warning,
        writable,
        _lock: lock,
    })
}
