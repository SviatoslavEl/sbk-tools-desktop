use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

const WORKSPACE_DIRS: [&str; 8] = [
    "settings",
    "calculator",
    "scanner",
    "contract-experience",
    "staff",
    "attachments",
    "backups",
    "logs",
];

#[derive(Serialize)]
struct WorkspaceInfo {
    root: String,
    portable: bool,
    writable: bool,
}

fn product_directory() -> Result<PathBuf, String> {
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

fn ensure_workspace(root: &Path) -> Result<(), String> {
    fs::create_dir_all(root)
        .map_err(|error| format!("Не удалось создать рабочую папку {}: {error}", root.display()))?;
    for directory in WORKSPACE_DIRS {
        fs::create_dir_all(root.join(directory))
            .map_err(|error| format!("Не удалось подготовить раздел {directory}: {error}"))?;
    }
    Ok(())
}

#[tauri::command]
fn workspace_info() -> Result<WorkspaceInfo, String> {
    let root = product_directory()?;
    ensure_workspace(&root)?;
    let probe = root.join(".write-probe");
    let writable = fs::write(&probe, b"ok")
        .and_then(|_| fs::remove_file(&probe))
        .is_ok();
    Ok(WorkspaceInfo {
        root: root.to_string_lossy().into_owned(),
        portable: true,
        writable,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![workspace_info])
        .run(tauri::generate_context!())
        .expect("SBK Tools could not start");
}
