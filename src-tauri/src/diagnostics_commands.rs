//! Local-only diagnostic controls. None of these commands opens the shared workspace.
use crate::diagnostics::{self, DiagnosticStatus};
use std::path::PathBuf;

#[tauri::command]
pub(crate) fn diagnostic_status() -> DiagnosticStatus {
    diagnostics::status()
}

#[tauri::command]
pub(crate) async fn set_diagnostic_logging(enabled: bool) -> Result<DiagnosticStatus, String> {
    tauri::async_runtime::spawn_blocking(move || diagnostics::set_enabled(enabled))
        .await
        .map_err(|_| "Не удалось переключить локальный диагностический журнал".to_owned())?
}

#[tauri::command]
pub(crate) async fn export_diagnostic_bundle(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || diagnostics::export_bundle(&PathBuf::from(path)))
        .await
        .map_err(|_| "Не удалось подготовить локальный диагностический журнал".to_owned())?
}
