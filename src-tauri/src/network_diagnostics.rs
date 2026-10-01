//! Process-local admission gate for diagnosing shared-folder I/O.
//!
//! This does not change the shared workspace, its password, or another user's
//! lease. An admitted operation owns its permit until its actual I/O completes.
use chrono::Utc;
use serde::Serialize;
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

const PAUSED_MESSAGE: &str = "Обращения этого экземпляра к рабочей папке приостановлены. Подключитесь снова в диагностике сети.";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum Phase {
    Connected,
    Disconnecting,
    Disconnected,
    DisconnectFailed,
    Reconnecting,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NetworkStatus {
    phase: Phase,
    active_operations: usize,
    changed_at: String,
    error: Option<String>,
    restart_required: bool,
}

/// Only these two non-sensitive fields are allowed in exported diagnostics.
/// Deliberately not a serialization/filtering of NetworkStatus: that includes
/// a raw error which may name a server, a user or a workspace path.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiagnosticNetworkSnapshot {
    phase: Phase,
    active_operations: usize,
}

struct State {
    phase: Phase,
    active: usize,
    changed_at: String,
    error: Option<String>,
}

pub(crate) struct NetworkGate {
    state: Mutex<State>,
    idle: Condvar,
    pub(crate) transition: Mutex<()>,
}

impl NetworkGate {
    pub(crate) fn new() -> Self {
        Self {
            state: Mutex::new(State {
                phase: Phase::Connected,
                active: 0,
                changed_at: Utc::now().to_rfc3339(),
                error: None,
            }),
            idle: Condvar::new(),
            transition: Mutex::new(()),
        }
    }

    pub(crate) fn status(&self) -> NetworkStatus {
        let state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        NetworkStatus {
            phase: state.phase,
            active_operations: state.active,
            changed_at: state.changed_at.clone(),
            error: state.error.clone(),
            restart_required: false,
        }
    }

    pub(crate) fn diagnostic_snapshot(&self) -> DiagnosticNetworkSnapshot {
        let state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        DiagnosticNetworkSnapshot {
            phase: state.phase,
            active_operations: state.active,
        }
    }

    pub(crate) fn disconnected(&self) -> bool {
        self.status().phase == Phase::Disconnected
    }

    pub(crate) fn connected(&self) -> bool {
        self.status().phase == Phase::Connected
    }

    pub(crate) fn enter(self: &Arc<Self>) -> Result<OperationPermit, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Диагностика сети недоступна")?;
        if state.phase != Phase::Connected {
            return Err(PAUSED_MESSAGE.into());
        }
        if state.active >= 64 {
            return Err("Очередь операций заполнена. Дождитесь завершения текущих действий и повторите попытку.".into());
        }
        state.active += 1;
        Ok(OperationPermit { gate: self.clone() })
    }

    pub(crate) fn start_disconnect(&self) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Диагностика сети недоступна")?;
        if !matches!(state.phase, Phase::Connected | Phase::DisconnectFailed) {
            return Err("Изменение подключения уже выполняется".into());
        }
        state.phase = Phase::Disconnecting;
        state.changed_at = Utc::now().to_rfc3339();
        state.error = None;
        Ok(())
    }

    /// Waiting happens off the GUI thread. Timeout does not kill a write or
    /// release the editor lease underneath an operation still using it.
    pub(crate) fn wait_for_idle(&self, timeout: Duration) -> Result<(), String> {
        let started = Instant::now();
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Диагностика сети недоступна")?;
        while state.active != 0 {
            let Some(remaining) = timeout.checked_sub(started.elapsed()) else {
                return Err("Операции с файлами ещё не завершились. Новые обращения остановлены, но отключение не подтверждено. Дождитесь завершения и повторите отключение.".into());
            };
            state = self
                .idle
                .wait_timeout(state, remaining)
                .map_err(|_| "Не удалось дождаться завершения операций")?
                .0;
        }
        Ok(())
    }

    pub(crate) fn finish_disconnect(&self, result: &Result<(), String>) {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state.phase = if result.is_ok() {
            Phase::Disconnected
        } else {
            Phase::DisconnectFailed
        };
        state.error = result.as_ref().err().cloned();
        state.changed_at = Utc::now().to_rfc3339();
    }

    pub(crate) fn start_reconnect(&self) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Диагностика сети недоступна")?;
        if !matches!(state.phase, Phase::Disconnected | Phase::DisconnectFailed) {
            return Err("Изменение подключения уже выполняется".into());
        }
        state.phase = Phase::Reconnecting;
        state.error = None;
        state.changed_at = Utc::now().to_rfc3339();
        Ok(())
    }

    pub(crate) fn finish_reconnect(&self, result: &Result<(), String>) {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        // A failure may include an unconfirmed editor release. Never report a
        // clean offline state in that case, and keep ordinary commands denied.
        state.phase = if result.is_ok() {
            Phase::Connected
        } else {
            Phase::DisconnectFailed
        };
        state.error = result.as_ref().err().cloned();
        state.changed_at = Utc::now().to_rfc3339();
    }
}

pub(crate) struct OperationPermit {
    gate: Arc<NetworkGate>,
}

impl Drop for OperationPermit {
    fn drop(&mut self) {
        let mut state = self
            .gate
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        state.active = state.active.saturating_sub(1);
        self.gate.idle.notify_all();
    }
}

pub(crate) fn gate() -> &'static Arc<NetworkGate> {
    static GATE: OnceLock<Arc<NetworkGate>> = OnceLock::new();
    GATE.get_or_init(|| Arc::new(NetworkGate::new()))
}

pub(crate) fn enter_operation() -> Result<OperationPermit, String> {
    gate().enter()
}

/// Default deny while paused, including new commands added in later releases.
/// Only this fixed set must remain local and must never inspect the workspace.
pub(crate) fn local_command(command: &str) -> bool {
    matches!(
        command,
        "network_access_status"
            | "disconnect_workspace_network"
            | "reconnect_workspace_network"
            | "diagnostic_status"
            | "set_diagnostic_logging"
            | "export_diagnostic_bundle"
            | "startup_status"
            | "report_startup_ui_visible"
            | "quit_application"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diagnostic_snapshot_has_only_phase_and_count_even_after_private_error() {
        let gate = Arc::new(NetworkGate::new());
        let _permit = gate.enter().unwrap();
        gate.start_disconnect().unwrap();
        gate.finish_disconnect(&Err(r"\\private-server\accounting\alice secret".into()));
        let value = serde_json::to_value(gate.diagnostic_snapshot()).unwrap();
        assert_eq!(value.as_object().unwrap().len(), 2);
        assert_eq!(value["phase"], "disconnectFailed");
        assert_eq!(value["activeOperations"], 1);
        assert!(!value.to_string().contains("private-server"));
        assert!(value.get("error").is_none());
    }

    #[test]
    fn pause_blocks_all_new_work_and_waits_for_owned_permits() {
        let gate = Arc::new(NetworkGate::new());
        let permit = gate.enter().unwrap();
        gate.start_disconnect().unwrap();
        assert!(gate.enter().is_err());
        assert!(gate.wait_for_idle(Duration::from_millis(1)).is_err());
        assert!(!gate.disconnected());
        drop(permit);
        let result = gate.wait_for_idle(Duration::from_secs(1));
        gate.finish_disconnect(&result);
        assert!(gate.disconnected());
        assert_eq!(gate.status().active_operations, 0);
        assert!(gate.enter().is_err());
    }

    #[test]
    fn failed_cleanup_never_reports_offline_or_reopens_admission() {
        let gate = Arc::new(NetworkGate::new());
        gate.start_disconnect().unwrap();
        gate.finish_disconnect(&Err("release not confirmed".into()));
        assert_eq!(gate.status().phase, Phase::DisconnectFailed);
        assert!(!gate.disconnected());
        assert!(gate.enter().is_err());
        gate.start_disconnect().unwrap();
        gate.finish_disconnect(&Ok(()));
        assert!(gate.disconnected());
    }

    #[test]
    fn reconnect_does_not_admit_operations_until_checks_finish() {
        let gate = Arc::new(NetworkGate::new());
        gate.start_disconnect().unwrap();
        gate.finish_disconnect(&Ok(()));
        gate.start_reconnect().unwrap();
        assert!(gate.enter().is_err());
        gate.finish_reconnect(&Err("share unavailable".into()));
        assert!(gate.enter().is_err());
        gate.start_reconnect().unwrap();
        gate.finish_reconnect(&Ok(()));
        assert!(gate.enter().is_ok());
    }

    #[test]
    fn allowlist_excludes_every_ordinary_workspace_and_file_entry() {
        for command in [
            "workspace_info",
            "workspace_owner_info",
            "workspace_health",
            "scanner_run",
            "scanner_source_revision",
            "scanner_plan_outputs",
            "proposal_render",
            "read_text_file",
            "write_text_file",
            "list_records",
            "create_backup",
            "set_workspace_location",
            "retry_workspace_initialization",
            "open_document_path",
            "future_command",
        ] {
            assert!(!local_command(command), "{command}");
        }
        for command in [
            "network_access_status",
            "disconnect_workspace_network",
            "reconnect_workspace_network",
            "diagnostic_status",
            "set_diagnostic_logging",
            "export_diagnostic_bundle",
            "quit_application",
        ] {
            assert!(local_command(command), "{command}");
        }
    }
}
