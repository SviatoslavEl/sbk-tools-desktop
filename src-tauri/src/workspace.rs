use fs2::FileExt;
use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};

const WORKSPACE_DIRS: [&str; 12] = [
    "settings",
    "calculator",
    "scanner",
    "contract-experience",
    "staff",
    "procurement",
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

fn adjacent_product_directory() -> Result<PathBuf, String> {
    if let Some(override_path) = std::env::var_os("SBK_TOOLS_WORKSPACE") {
        return Ok(PathBuf::from(override_path));
    }

    let executable = std::env::current_exe()
        .map_err(|error| format!("Не удалось определить расположение приложения: {error}"))?;

    #[cfg(target_os = "macos")]
    {
        if let Some(parent) = executable
            .ancestors()
            .find(|path| path.extension().is_some_and(|extension| extension == "app"))
            .and_then(Path::parent)
        {
            return Ok(parent.join("ProductData"));
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
    if let Ok(content) = workspace_pointer_path()
        .and_then(|pointer| fs::read_to_string(pointer).map_err(|error| error.to_string()))
    {
        let selected = PathBuf::from(content.trim());
        if !content.trim().is_empty() {
            return Ok((selected, false));
        }
    }
    adjacent_product_directory().map(|path| (path, true))
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
    let (preferred, mut portable) = product_directory()?;
    let mut root = preferred.clone();
    if ensure_workspace(&root).is_err() {
        root = dirs::data_local_dir()
            .ok_or_else(|| {
                format!(
                    "Папка {} недоступна, резервное расположение не найдено",
                    preferred.display()
                )
            })?
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
        writable,
        _lock: lock,
    })
}
