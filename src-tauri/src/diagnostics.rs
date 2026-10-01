//! Opt-in, local-only diagnostics. This module deliberately cannot accept free-form
//! messages, file paths, credentials or database/document payloads as log events.
use chrono::Utc;
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;
use uuid::Uuid;

const MAX_LOG_BYTES: u64 = 1024 * 1024;
const MAX_PENDING: usize = 256;
const LOG_FILES: [&str; 3] = [
    "diagnostics-current.jsonl",
    "diagnostics-1.jsonl",
    "diagnostics-2.jsonl",
];
const SETTINGS_FILE: &str = "settings.json";
const LOCK_FILE: &str = ".diagnostics.lock";
const EXPORT_README: &str = "SBK Tools diagnostic report\n\nThis report is created locally by the user. Nothing is uploaded automatically.\nIt contains operation names, UTC timestamps, elapsed milliseconds, build identity,\nerror categories and unfinished operations. It contains no database records,\ndocument contents, passwords, usernames, computer names or workspace paths.\nLogging is limited to three 1 MiB files. Missing completion events can indicate\na pending operation, process termination, disabled logging or rotated history.\nA locally stored report does not prove the cause of an operating-system freeze.\n";

/// Fixed names make accidental logging of a path or user-entered text impossible.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Operation {
    Startup,
    CommandQueueWait,
    WorkspaceOpen,
    WorkspaceAccess,
    WorkspaceStatus,
    DatabaseRead,
    DatabaseWrite,
    AdminDatabaseOpen,
    AdminDatabaseRead,
    AdminDatabaseWrite,
    Backup,
    RuntimeVerification,
    DirectoryScan,
    ModeSwitch,
    NetworkDisconnect,
    NetworkReconnect,
    FreeSpaceProbe,
    Scanner,
    ArchiveExport,
    ArchiveImport,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCategory {
    Permission,
    Locked,
    Timeout,
    Network,
    NotFound,
    InvalidInput,
    Storage,
    Cancelled,
    Interrupted,
    Other,
}

impl ErrorCategory {
    /// Classification only: the original error is never saved or retained.
    pub fn from_message(message: &str) -> Self {
        let message = message.to_lowercase();
        if ["permission", "access denied", "отказано", "нет прав"]
            .iter()
            .any(|value| message.contains(value))
        {
            Self::Permission
        } else if ["timed out", "timeout", "истекло время", "тайм"]
            .iter()
            .any(|value| message.contains(value))
        {
            Self::Timeout
        } else if ["locked", "busy", "блокиров", "занят"]
            .iter()
            .any(|value| message.contains(value))
        {
            Self::Locked
        } else if ["network", "сеть", "сетев", "connection", "соединен"]
            .iter()
            .any(|value| message.contains(value))
        {
            Self::Network
        } else if ["not found", "no such file", "не найден"]
            .iter()
            .any(|value| message.contains(value))
        {
            Self::NotFound
        } else if ["invalid", "некоррект", "недопустим"]
            .iter()
            .any(|value| message.contains(value))
        {
            Self::InvalidInput
        } else if ["cancel", "отмен"]
            .iter()
            .any(|value| message.contains(value))
        {
            Self::Cancelled
        } else if ["disk full", "no space", "места на диске", "input/output"]
            .iter()
            .any(|value| message.contains(value))
        {
            Self::Storage
        } else {
            Self::Other
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticStatus {
    pub enabled: bool,
    pub session_id: String,
    pub pending_operations: usize,
    pub write_failures: u64,
    pub dropped_events: u64,
    pub available: bool,
    pub restart_required: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BuildIdentity {
    app_version: String,
    build_label: String,
    revision: String,
    platform: String,
    architecture: String,
    flavor: String,
}

impl BuildIdentity {
    fn current() -> Self {
        Self {
            app_version: safe_build_label(env!("CARGO_PKG_VERSION")),
            build_label: safe_build_label(option_env!("SBK_BUILD_LABEL").unwrap_or("local")),
            revision: safe_build_label(option_env!("SBK_BUILD_REVISION").unwrap_or("unknown")),
            platform: std::env::consts::OS.to_owned(),
            architecture: std::env::consts::ARCH.to_owned(),
            flavor: if cfg!(feature = "installed-fast-start") {
                "installed"
            } else {
                "desktop"
            }
            .to_owned(),
        }
    }

    fn valid(&self) -> bool {
        [&self.app_version, &self.build_label, &self.revision]
            .iter()
            .all(|value| safe_build_label(value) == **value)
            && ["windows", "macos", "linux"].contains(&self.platform.as_str())
            && ["x86_64", "x86", "aarch64", "arm"].contains(&self.architecture.as_str())
            && ["installed", "desktop"].contains(&self.flavor.as_str())
    }
}

fn safe_build_label(value: &str) -> String {
    if value.is_empty()
        || value.len() > 96
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-+".contains(&byte))
    {
        "unknown".to_owned()
    } else {
        value.to_owned()
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum EventKind {
    SessionStart,
    LoggingEnabled,
    LoggingDisabled,
    OperationBegin,
    OperationEnd,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Event {
    schema_version: u8,
    timestamp: String,
    session_id: String,
    build: BuildIdentity,
    event: EventKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    operation_id: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    operation: Option<Operation>,
    #[serde(skip_serializing_if = "Option::is_none")]
    elapsed_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    outcome: Option<Outcome>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(tag = "status", content = "category", rename_all = "snake_case")]
enum Outcome {
    Success,
    Error(ErrorCategory),
}

impl Event {
    fn valid(&self) -> bool {
        self.schema_version == 1
            && chrono::DateTime::parse_from_rfc3339(&self.timestamp).is_ok()
            && Uuid::parse_str(&self.session_id).is_ok()
            && self.build.valid()
    }
}

struct Pending {
    operation: Operation,
    started: Instant,
    timestamp: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PendingSnapshot {
    operation_id: u64,
    operation: Operation,
    started_at: String,
    elapsed_ms: u64,
}

struct State {
    enabled: bool,
    next_id: u64,
    pending: BTreeMap<u64, Pending>,
    write_failures: u64,
    dropped_events: u64,
}

struct Logger {
    root: Option<PathBuf>,
    session_id: String,
    build: BuildIdentity,
    max_log_bytes: u64,
    state: Mutex<State>,
}

static LOGGER: OnceLock<Arc<Logger>> = OnceLock::new();

fn logger() -> &'static Arc<Logger> {
    LOGGER.get_or_init(|| Arc::new(Logger::new(default_root(), MAX_LOG_BYTES)))
}

fn default_root() -> Option<PathBuf> {
    // Other backend unit tests can call instrumented production functions.
    // Those must never change the real user's logging preference or report.
    #[cfg(test)]
    {
        None
    }
    #[cfg(not(test))]
    {
        // GUI QA must not alter the real user's local preference or reports.
        // The override is absent from release builds and uses the same strict
        // local/no-link path validation as the normal per-user directory.
        #[cfg(debug_assertions)]
        if let Some(root) = std::env::var_os("SBK_DIAGNOSTICS_TEST_ROOT") {
            return Some(PathBuf::from(root));
        }
        dirs::data_local_dir().map(|base| base.join("SBKTools").join("diagnostics"))
    }
}

pub fn initialize() -> DiagnosticStatus {
    status()
}

pub fn status() -> DiagnosticStatus {
    logger().status()
}

pub fn set_enabled(enabled: bool) -> Result<DiagnosticStatus, String> {
    logger().set_enabled(enabled)
}

pub fn begin(operation: Operation) -> DiagnosticSpan {
    logger().begin(operation)
}

pub fn measure<T>(
    operation: Operation,
    action: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let span = begin(operation);
    let result = action();
    span.result(&result);
    result
}

pub fn export_bundle(destination: &Path) -> Result<(), String> {
    logger().export_bundle(destination)
}

pub struct DiagnosticSpan {
    logger: Option<Arc<Logger>>,
    id: u64,
}

impl DiagnosticSpan {
    pub fn success(mut self) {
        self.finish(Outcome::Success);
    }

    pub fn failure(mut self, category: ErrorCategory) {
        self.finish(Outcome::Error(category));
    }

    pub fn result<T>(self, result: &Result<T, String>) {
        match result {
            Ok(_) => self.success(),
            Err(error) => self.failure(ErrorCategory::from_message(error)),
        }
    }

    fn finish(&mut self, outcome: Outcome) {
        if let Some(logger) = self.logger.take() {
            logger.finish(self.id, outcome);
        }
    }
}

impl Drop for DiagnosticSpan {
    fn drop(&mut self) {
        self.finish(Outcome::Error(ErrorCategory::Interrupted));
    }
}

impl Logger {
    fn new(root: Option<PathBuf>, max_log_bytes: u64) -> Self {
        let root = root.filter(|root| ensure_local_directory(root).is_ok());
        let enabled = root
            .as_deref()
            .and_then(|root| read_settings(root).ok())
            .unwrap_or(false);
        let logger = Self {
            root,
            session_id: Uuid::new_v4().to_string(),
            build: BuildIdentity::current(),
            max_log_bytes,
            state: Mutex::new(State {
                enabled,
                next_id: 1,
                pending: BTreeMap::new(),
                write_failures: 0,
                dropped_events: 0,
            }),
        };
        if enabled {
            let mut state = logger
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            logger.append(&mut state, logger.event(EventKind::SessionStart));
        }
        logger
    }

    fn event(&self, kind: EventKind) -> Event {
        Event {
            schema_version: 1,
            timestamp: Utc::now().to_rfc3339(),
            session_id: self.session_id.clone(),
            build: self.build.clone(),
            event: kind,
            operation_id: None,
            operation: None,
            elapsed_ms: None,
            outcome: None,
        }
    }

    fn status(&self) -> DiagnosticStatus {
        let state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        self.status_locked(&state)
    }

    fn status_locked(&self, state: &State) -> DiagnosticStatus {
        DiagnosticStatus {
            enabled: state.enabled,
            session_id: self.session_id.clone(),
            pending_operations: state.pending.len(),
            write_failures: state.write_failures,
            dropped_events: state.dropped_events,
            available: self.root.is_some(),
            restart_required: false,
        }
    }

    fn set_enabled(&self, enabled: bool) -> Result<DiagnosticStatus, String> {
        let root = self.root.as_deref().ok_or_else(unavailable_error)?;
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        {
            let _lock = acquire_log_lock(root).map_err(|_| unavailable_error())?;
            write_settings(root, enabled).map_err(|_| unavailable_error())?;
        }
        if enabled != state.enabled {
            // Write the final event before disabling. Enabling starts recording
            // immediately; only the next launch needs to capture startup itself.
            state.enabled = true;
            self.append(
                &mut state,
                self.event(if enabled {
                    EventKind::LoggingEnabled
                } else {
                    EventKind::LoggingDisabled
                }),
            );
            state.enabled = enabled;
            if !enabled {
                state.pending.clear();
            }
        }
        Ok(self.status_locked(&state))
    }

    fn begin(self: &Arc<Self>, operation: Operation) -> DiagnosticSpan {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if !state.enabled || self.root.is_none() {
            return DiagnosticSpan {
                logger: None,
                id: 0,
            };
        }
        if state.pending.len() >= MAX_PENDING {
            state.dropped_events = state.dropped_events.saturating_add(1);
            return DiagnosticSpan {
                logger: None,
                id: 0,
            };
        }
        let id = state.next_id;
        state.next_id = state.next_id.saturating_add(1);
        let mut event = self.event(EventKind::OperationBegin);
        event.operation_id = Some(id);
        event.operation = Some(operation);
        state.pending.insert(
            id,
            Pending {
                operation,
                started: Instant::now(),
                timestamp: event.timestamp.clone(),
            },
        );
        // This tiny local write is complete before the caller enters a network
        // operation. Neither the logger mutex nor file lock outlives begin().
        self.append(&mut state, event);
        DiagnosticSpan {
            logger: Some(Arc::clone(self)),
            id,
        }
    }

    fn finish(&self, id: u64, outcome: Outcome) {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(pending) = state.pending.remove(&id) {
            let mut event = self.event(EventKind::OperationEnd);
            event.operation_id = Some(id);
            event.operation = Some(pending.operation);
            event.elapsed_ms = Some(elapsed_ms(pending.started));
            event.outcome = Some(outcome);
            self.append(&mut state, event);
        }
    }

    fn append(&self, state: &mut State, event: Event) {
        if !state.enabled {
            return;
        }
        if self.append_checked(&event).is_err() {
            // Diagnostic failures never propagate into a business operation.
            state.write_failures = state.write_failures.saturating_add(1);
        }
    }

    fn append_checked(&self, event: &Event) -> std::io::Result<()> {
        let root = self.root.as_deref().ok_or_else(invalid_path)?;
        let _lock = acquire_log_lock(root)?;
        let mut bytes = serde_json::to_vec(event)?;
        bytes.push(b'\n');
        if bytes.len() as u64 > self.max_log_bytes {
            return Err(invalid_path());
        }
        let current = root.join(LOG_FILES[0]);
        let current_size = match regular_file_metadata(&current) {
            Ok(metadata) => metadata.len(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => 0,
            Err(error) => return Err(error),
        };
        if current_size.saturating_add(bytes.len() as u64) > self.max_log_bytes {
            rotate(root)?;
        }
        let mut file = safe_open(&current, false, true)?;
        file.write_all(&bytes)
    }

    fn export_bundle(&self, destination: &Path) -> Result<(), String> {
        let root = self.root.as_deref().ok_or_else(unavailable_error)?;
        validate_export_destination(destination)?;
        // This DTO has no error text or paths by construction. Read the gate
        // before acquiring the logger mutex to avoid cross-component lock order.
        let network = crate::network_diagnostics::gate().diagnostic_snapshot();
        // Snapshot local files while holding only the local diagnostic lock.
        // Network commands can continue and never hold this lock themselves.
        let (events, snapshot) = {
            let state = self.state.lock().unwrap_or_else(|error| error.into_inner());
            let _lock = acquire_log_lock(root).map_err(|_| unavailable_error())?;
            let events = read_export_events(root, self.max_log_bytes)
                .map_err(|_| "Не удалось прочитать локальный журнал диагностики.".to_owned())?;
            let pending: Vec<_> = state
                .pending
                .iter()
                .map(|(id, pending)| PendingSnapshot {
                    operation_id: *id,
                    operation: pending.operation,
                    started_at: pending.timestamp.clone(),
                    elapsed_ms: elapsed_ms(pending.started),
                })
                .collect();
            let snapshot = serde_json::json!({
                "schemaVersion": 1,
                "exportedAt": Utc::now().to_rfc3339(),
                "build": self.build,
                "status": self.status_locked(&state),
                "pending": pending,
                "network": network,
            });
            (events, snapshot)
        };
        let file = safe_open(destination, true, false).map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                "Файл уже существует. Выберите новое имя отчёта.".to_owned()
            } else {
                "Не удалось создать отчёт. Выберите доступную локальную папку.".to_owned()
            }
        })?;
        let result = (|| -> Result<(), Box<dyn std::error::Error>> {
            let mut archive = zip::ZipWriter::new(file);
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            archive.start_file("README.txt", options)?;
            archive.write_all(EXPORT_README.as_bytes())?;
            archive.start_file("status.json", options)?;
            archive.write_all(&serde_json::to_vec_pretty(&snapshot)?)?;
            archive.start_file("operations.jsonl", options)?;
            archive.write_all(&events)?;
            archive.finish()?.sync_all()?;
            Ok(())
        })();
        if result.is_err() {
            // The destination was created exclusively by this call. Never
            // remove a pre-existing user file, directory or redirected target.
            if regular_file_metadata(destination).is_ok() {
                let _ = fs::remove_file(destination);
            }
            return Err("Не удалось записать отчёт диагностики на локальный диск.".to_owned());
        }
        Ok(())
    }
}

fn elapsed_ms(started: Instant) -> u64 {
    started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64
}

fn unavailable_error() -> String {
    "Локальный журнал диагностики недоступен. Проверьте свободное место и права в профиле Windows/macOS.".to_owned()
}

fn invalid_path() -> std::io::Error {
    std::io::Error::new(
        std::io::ErrorKind::PermissionDenied,
        "Diagnostic files require a regular local path",
    )
}

fn is_link(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    false
}

fn regular_file_metadata(path: &Path) -> std::io::Result<fs::Metadata> {
    let metadata = fs::symlink_metadata(path)?;
    if is_link(&metadata) || !metadata.is_file() {
        Err(invalid_path())
    } else {
        Ok(metadata)
    }
}

fn safe_open(path: &Path, create_new: bool, append: bool) -> std::io::Result<File> {
    match regular_file_metadata(path) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    let mut options = OpenOptions::new();
    options.read(true).write(true);
    if create_new {
        options.create_new(true);
    } else {
        options.create(true);
    }
    options.append(append);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
        #[cfg(target_os = "macos")]
        options.custom_flags(0x100); // O_NOFOLLOW
        #[cfg(target_os = "linux")]
        options.custom_flags(0x20000); // O_NOFOLLOW
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x00200000); // FILE_FLAG_OPEN_REPARSE_POINT
    }
    let file = options.open(path)?;
    let metadata = file.metadata()?;
    if is_link(&metadata) || !metadata.is_file() {
        return Err(invalid_path());
    }
    Ok(file)
}

fn safe_read(path: &Path, max_bytes: u64) -> std::io::Result<Vec<u8>> {
    let metadata = regular_file_metadata(path)?;
    if metadata.len() > max_bytes {
        return Err(invalid_path());
    }
    // Use the same no-follow open as writes, but never truncate or create a
    // missing source. The checked length and bounded read limit memory usage.
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        #[cfg(target_os = "macos")]
        options.custom_flags(0x100);
        #[cfg(target_os = "linux")]
        options.custom_flags(0x20000);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x00200000);
    }
    let file = options.open(path)?;
    if is_link(&file.metadata()?) || !file.metadata()?.is_file() {
        return Err(invalid_path());
    }
    let mut bytes = Vec::new();
    file.take(max_bytes + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > max_bytes {
        return Err(invalid_path());
    }
    Ok(bytes)
}

fn verify_local_path(path: &Path) -> std::io::Result<()> {
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir | Component::CurDir))
    {
        return Err(invalid_path());
    }
    #[cfg(target_os = "macos")]
    verify_macos_local_volume(path)?;
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use std::path::Prefix;
        let drive = match path.components().next() {
            Some(Component::Prefix(prefix)) => match prefix.kind() {
                Prefix::Disk(drive) | Prefix::VerbatimDisk(drive) => drive,
                _ => return Err(invalid_path()),
            },
            _ => return Err(invalid_path()),
        };
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn GetDriveTypeW(root_path: *const u16) -> u32;
        }
        let root = format!("{}:\\", char::from(drive));
        let root: Vec<u16> = std::ffi::OsStr::new(&root)
            .encode_wide()
            .chain(Some(0))
            .collect();
        // Reject UNC, mapped network drives, unknown volumes and optical media.
        // Local fixed/removable disks are the only diagnostic destinations.
        let kind = unsafe { GetDriveTypeW(root.as_ptr()) };
        if kind != 2 && kind != 3 {
            return Err(invalid_path());
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn verify_macos_local_volume(path: &Path) -> std::io::Result<()> {
    use std::os::unix::ffi::OsStrExt;

    // Darwin's __DARWIN_STRUCT_STATFS64, as defined by sys/mount.h. The cached
    // mount table avoids statfs(path): that could itself wait on a stalled SMB
    // share. MNT_NOWAIT specifically returns the kernel's cached mount data.
    #[repr(C)]
    struct StatFs {
        bsize: u32,
        iosize: i32,
        blocks: u64,
        bfree: u64,
        bavail: u64,
        files: u64,
        ffree: u64,
        fsid: [i32; 2],
        owner: u32,
        fs_type: u32,
        flags: u32,
        fs_subtype: u32,
        fs_type_name: [u8; 16],
        mounted_on: [u8; 1024],
        mounted_from: [u8; 1024],
        flags_ext: u32,
        reserved: [u32; 7],
    }
    unsafe extern "C" {
        #[cfg_attr(not(target_arch = "aarch64"), link_name = "getfsstat$INODE64")]
        fn getfsstat(buffer: *mut StatFs, buffer_size: i32, flags: i32) -> i32;
    }
    const MNT_NOWAIT: i32 = 2;
    const MNT_LOCAL: u32 = 0x1000;
    const _: () = assert!(std::mem::size_of::<StatFs>() == 2168);
    let count = unsafe { getfsstat(std::ptr::null_mut(), 0, MNT_NOWAIT) };
    if !(1..=1024).contains(&count) {
        return Err(invalid_path());
    }
    let capacity = count as usize + 16;
    let mut mounts: Vec<std::mem::MaybeUninit<StatFs>> = Vec::with_capacity(capacity);
    let found = unsafe {
        getfsstat(
            mounts.as_mut_ptr().cast(),
            (capacity * std::mem::size_of::<StatFs>()) as i32,
            MNT_NOWAIT,
        )
    };
    if found <= 0 || found as usize >= capacity {
        return Err(invalid_path());
    }
    // getfsstat has initialized exactly `found` structures in this allocation.
    unsafe { mounts.set_len(found as usize) };
    let mut volumes = Vec::with_capacity(found as usize);
    for mount in &mounts {
        let mount = unsafe { mount.assume_init_ref() };
        let Some(end) = mount.mounted_on.iter().position(|byte| *byte == 0) else {
            return Err(invalid_path());
        };
        volumes.push((
            PathBuf::from(std::ffi::OsStr::from_bytes(&mount.mounted_on[..end])),
            mount.flags & MNT_LOCAL != 0,
        ));
    }
    if local_mount_for(path, &volumes) {
        Ok(())
    } else {
        Err(invalid_path())
    }
}

#[cfg(target_os = "macos")]
fn local_mount_for(path: &Path, volumes: &[(PathBuf, bool)]) -> bool {
    volumes
        .iter()
        .filter(|(mount, _)| path.starts_with(mount))
        .max_by_key(|(mount, _)| mount.components().count())
        .is_some_and(|(_, local)| *local)
}

fn ensure_local_directory(path: &Path) -> std::io::Result<()> {
    verify_local_path(path)?;
    let mut current = PathBuf::new();
    for component in path.components() {
        let is_prefix = matches!(component, Component::Prefix(_));
        current.push(component);
        // A Windows drive prefix alone (especially canonical \\?\C:) is not
        // a directory. Inspect it only after the following root separator.
        if is_prefix {
            continue;
        }
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.is_dir() && !is_link(&metadata) => {}
            Ok(_) => return Err(invalid_path()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let created = match fs::create_dir(&current) {
                    Ok(()) => true,
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                        let metadata = fs::symlink_metadata(&current)?;
                        if !metadata.is_dir() || is_link(&metadata) {
                            return Err(invalid_path());
                        }
                        false
                    }
                    Err(error) => return Err(error),
                };
                #[cfg(unix)]
                if created {
                    use std::os::unix::fs::PermissionsExt;
                    fs::set_permissions(&current, fs::Permissions::from_mode(0o700))?;
                }
                #[cfg(not(unix))]
                let _ = created;
            }
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

fn check_existing_local_directory(path: &Path) -> std::io::Result<()> {
    verify_local_path(path)?;
    let mut current = PathBuf::new();
    for component in path.components() {
        let is_prefix = matches!(component, Component::Prefix(_));
        current.push(component);
        if is_prefix {
            continue;
        }
        let metadata = fs::symlink_metadata(&current)?;
        if !metadata.is_dir() || is_link(&metadata) {
            return Err(invalid_path());
        }
    }
    Ok(())
}

struct LocalLogLock(File);

impl Drop for LocalLogLock {
    fn drop(&mut self) {
        // Closing this descriptor alone is not sufficient on Unix: another
        // thread can spawn a child that briefly inherits it before exec. Such
        // an inherited reference would keep flock alive after the parent's
        // close. Explicit unlock releases this operation's lock immediately.
        let _ = FileExt::unlock(&self.0);
    }
}

fn acquire_log_lock(root: &Path) -> std::io::Result<LocalLogLock> {
    check_existing_local_directory(root)?;
    let file = safe_open(&root.join(LOCK_FILE), false, false)?;
    // Never wait for another process: diagnostics must not introduce a freeze.
    file.try_lock_exclusive()?;
    Ok(LocalLogLock(file))
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Settings {
    enabled: bool,
}

fn read_settings(root: &Path) -> std::io::Result<bool> {
    let bytes = safe_read(&root.join(SETTINGS_FILE), 256)?;
    Ok(serde_json::from_slice::<Settings>(&bytes)?.enabled)
}

fn write_settings(root: &Path, enabled: bool) -> std::io::Result<()> {
    let destination = root.join(SETTINGS_FILE);
    match regular_file_metadata(&destination) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    let temporary = root.join(format!("settings-{}.tmp", Uuid::new_v4()));
    let mut file = safe_open(&temporary, true, false)?;
    let result = (|| {
        file.write_all(&serde_json::to_vec(&Settings { enabled })?)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, &destination)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn rotate(root: &Path) -> std::io::Result<()> {
    // Validate every source/target before touching any of them.
    for name in LOG_FILES {
        match regular_file_metadata(&root.join(name)) {
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    let oldest = root.join(LOG_FILES[2]);
    if oldest.exists() {
        fs::remove_file(oldest)?;
    }
    for index in (0..2).rev() {
        let source = root.join(LOG_FILES[index]);
        if source.exists() {
            fs::rename(source, root.join(LOG_FILES[index + 1]))?;
        }
    }
    Ok(())
}

fn read_export_events(root: &Path, max_bytes: u64) -> std::io::Result<Vec<u8>> {
    let mut result = Vec::new();
    for name in LOG_FILES.iter().rev() {
        let bytes = match safe_read(&root.join(name), max_bytes) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        };
        for line in bytes.split(|byte| *byte == b'\n') {
            // Re-serialize only our strict schema, never copy untrusted raw logs.
            // A torn final write or foreign/corrupt line is omitted.
            if let Ok(event) = serde_json::from_slice::<Event>(line)
                && event.valid()
            {
                result.extend(serde_json::to_vec(&event)?);
                result.push(b'\n');
            }
        }
    }
    Ok(result)
}

fn validate_export_destination(destination: &Path) -> Result<(), String> {
    verify_local_path(destination).map_err(|_| {
        "Сохраните отчёт на локальный диск, не в сетевую папку или подключённый сетевой диск."
            .to_owned()
    })?;
    if destination.extension().and_then(|value| value.to_str()) != Some("zip") {
        return Err("Отчёт диагностики должен иметь расширение .zip.".to_owned());
    }
    let parent = destination
        .parent()
        .ok_or_else(|| "Выберите локальную папку для отчёта.".to_owned())?;
    check_existing_local_directory(parent).map_err(|_| {
        "Выберите обычную локальную папку, без ссылок и перенаправлений.".to_owned()
    })?;
    if fs::symlink_metadata(destination).is_ok() {
        return Err("Файл уже существует. Выберите новое имя отчёта.".to_owned());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestRoot(PathBuf);

    impl TestRoot {
        fn new() -> Self {
            // macOS /var is a system symlink; tests use its canonical local path.
            let base = std::env::temp_dir().canonicalize().expect("temp base");
            let root = base.join(format!("sbk-diagnostics-test-{}", Uuid::new_v4()));
            fs::create_dir(&root).expect("test root");
            Self(root)
        }

        fn logger(&self, limit: u64) -> Arc<Logger> {
            Arc::new(Logger::new(Some(self.0.join("logs")), limit))
        }
    }

    impl Drop for TestRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn contents(logger: &Logger) -> String {
        String::from_utf8(
            read_export_events(logger.root.as_deref().unwrap(), logger.max_log_bytes).unwrap(),
        )
        .unwrap()
    }

    #[test]
    fn disabled_by_default_and_choice_persists_locally() {
        let root = TestRoot::new();
        let logger = root.logger(MAX_LOG_BYTES);
        assert!(!logger.status().enabled);
        logger.begin(Operation::WorkspaceAccess).success();
        assert!(contents(&logger).is_empty());
        assert!(logger.set_enabled(true).unwrap().enabled);
        let next = root.logger(MAX_LOG_BYTES);
        assert!(next.status().enabled);
        next.set_enabled(false).unwrap();
        assert!(!root.logger(MAX_LOG_BYTES).status().enabled);
    }

    #[test]
    fn begin_is_written_and_pending_visible_before_operation_finishes() {
        let root = TestRoot::new();
        let logger = root.logger(MAX_LOG_BYTES);
        logger.set_enabled(true).unwrap();
        let span = logger.begin(Operation::WorkspaceAccess);
        assert_eq!(logger.status().pending_operations, 1);
        assert!(contents(&logger).contains("operation_begin"));
        assert!(!contents(&logger).contains("operation_end"));
        span.success();
        assert_eq!(logger.status().pending_operations, 0);
        let records: Vec<Event> = contents(&logger)
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert!(records.last().unwrap().elapsed_ms.unwrap() < 5000);
        assert!(matches!(
            records.last().unwrap().outcome,
            Some(Outcome::Success)
        ));
    }

    #[test]
    fn errors_are_classified_without_payload_paths_or_credentials() {
        let root = TestRoot::new();
        let logger = root.logger(MAX_LOG_BYTES);
        logger.set_enabled(true).unwrap();
        let error: Result<(), String> =
            Err(r"network timeout \\private-server\salaries\alice.pdf password=S3cr3t".into());
        logger.begin(Operation::DatabaseRead).result(&error);
        let text = contents(&logger);
        assert!(text.contains("timeout"));
        for forbidden in ["private-server", "salaries", "alice", "S3cr3t", "password"] {
            assert!(!text.contains(forbidden));
        }
        assert_eq!(
            ErrorCategory::from_message("database is locked"),
            ErrorCategory::Locked
        );
        assert_eq!(
            ErrorCategory::from_message("Access denied"),
            ErrorCategory::Permission
        );
        assert_eq!(
            ErrorCategory::from_message("Сетевая папка недоступна"),
            ErrorCategory::Network
        );
    }

    #[test]
    fn dropped_guard_records_interruption_and_disable_clears_pending() {
        let root = TestRoot::new();
        let logger = root.logger(MAX_LOG_BYTES);
        logger.set_enabled(true).unwrap();
        drop(logger.begin(Operation::DirectoryScan));
        assert!(contents(&logger).contains("interrupted"));
        let span = logger.begin(Operation::DatabaseRead);
        logger.set_enabled(false).unwrap();
        assert_eq!(logger.status().pending_operations, 0);
        let before = contents(&logger);
        span.success();
        assert_eq!(before, contents(&logger));
    }

    #[test]
    fn rotation_is_bounded_to_three_files() {
        let root = TestRoot::new();
        let logger = root.logger(1600);
        logger.set_enabled(true).unwrap();
        for _ in 0..100 {
            logger.begin(Operation::DatabaseRead).success();
        }
        let root = logger.root.as_ref().unwrap();
        assert_eq!(logger.status().write_failures, 0);
        for name in LOG_FILES {
            let metadata = fs::metadata(root.join(name)).unwrap();
            assert!(metadata.len() <= 1600);
        }
        assert_eq!(
            fs::read_dir(root)
                .unwrap()
                .filter_map(Result::ok)
                .filter(
                    |entry| entry.path().extension().and_then(|value| value.to_str())
                        == Some("jsonl")
                )
                .count(),
            3
        );
    }

    #[test]
    fn concurrent_operations_have_unique_ids_and_no_missing_completion() {
        let root = TestRoot::new();
        let logger = root.logger(MAX_LOG_BYTES);
        logger.set_enabled(true).unwrap();
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let logger = Arc::clone(&logger);
                std::thread::spawn(move || {
                    for _ in 0..20 {
                        logger.begin(Operation::DatabaseRead).success();
                    }
                })
            })
            .collect();
        for thread in threads {
            thread.join().unwrap();
        }
        let events: Vec<Event> = contents(&logger)
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        let starts: std::collections::BTreeSet<_> = events
            .iter()
            .filter(|event| matches!(event.event, EventKind::OperationBegin))
            .map(|event| event.operation_id.unwrap())
            .collect();
        assert_eq!(starts.len(), 160);
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(event.event, EventKind::OperationEnd))
                .count(),
            160
        );
        assert_eq!(logger.status().pending_operations, 0);
        assert_eq!(logger.status().write_failures, 0);
    }

    #[test]
    fn pending_limit_and_cross_process_lock_do_not_wait() {
        let root = TestRoot::new();
        let logger = root.logger(MAX_LOG_BYTES);
        logger.set_enabled(true).unwrap();
        let spans: Vec<_> = (0..MAX_PENDING + 4)
            .map(|_| logger.begin(Operation::WorkspaceAccess))
            .collect();
        assert_eq!(logger.status().pending_operations, MAX_PENDING);
        assert_eq!(logger.status().dropped_events, 4);
        drop(spans);
        let _lock = acquire_log_lock(logger.root.as_deref().unwrap()).unwrap();
        logger.begin(Operation::WorkspaceAccess).success();
        assert_eq!(logger.status().pending_operations, 0);
        assert!(logger.status().write_failures >= 2);
    }

    #[cfg(unix)]
    #[test]
    fn lock_release_does_not_depend_on_inherited_descriptors_closing() {
        let root = TestRoot::new();
        let logger = root.logger(MAX_LOG_BYTES);
        let root = logger.root.as_deref().unwrap();
        let lock = acquire_log_lock(root).unwrap();
        let inherited = lock.0.try_clone().unwrap();
        drop(lock);
        let next = acquire_log_lock(root).expect("explicit unlock releases even with inherited fd");
        drop(next);
        drop(inherited);
    }

    #[test]
    fn export_contains_pending_operations_and_does_not_overwrite() {
        let root = TestRoot::new();
        let logger = root.logger(MAX_LOG_BYTES);
        logger.set_enabled(true).unwrap();
        let _pending = logger.begin(Operation::WorkspaceAccess);
        let destination = root.0.join("report.zip");
        logger.export_bundle(&destination).unwrap();
        assert!(logger.export_bundle(&destination).is_err());
        let mut archive = zip::ZipArchive::new(File::open(destination).unwrap()).unwrap();
        assert_eq!(archive.len(), 3);
        let mut snapshot = String::new();
        archive
            .by_name("status.json")
            .unwrap()
            .read_to_string(&mut snapshot)
            .unwrap();
        let snapshot: serde_json::Value = serde_json::from_str(&snapshot).unwrap();
        assert_eq!(snapshot["pending"][0]["operation"], "workspace_access");
        assert!(snapshot["pending"][0]["elapsedMs"].is_number());
        assert_eq!(snapshot["status"]["pendingOperations"], 1);
        assert_eq!(snapshot["network"].as_object().unwrap().len(), 2);
        assert!(snapshot["network"]["phase"].is_string());
        assert!(snapshot["network"]["activeOperations"].is_number());
        assert!(snapshot["network"].get("error").is_none());
    }

    #[test]
    fn export_omits_foreign_or_corrupt_lines_and_other_log_files() {
        let root = TestRoot::new();
        let logger = root.logger(MAX_LOG_BYTES);
        logger.set_enabled(true).unwrap();
        let log_root = logger.root.as_ref().unwrap();
        let mut file = safe_open(&log_root.join(LOG_FILES[0]), false, true).unwrap();
        file.write_all(b"{\"password\":\"S3cr3t\"}\ncorrupt\n")
            .unwrap();
        fs::write(
            log_root.join("legacy.log"),
            "private-server password=S3cr3t",
        )
        .unwrap();
        let destination = root.0.join("report.zip");
        logger.export_bundle(&destination).unwrap();
        let mut archive = zip::ZipArchive::new(File::open(destination).unwrap()).unwrap();
        let mut text = String::new();
        archive
            .by_name("operations.jsonl")
            .unwrap()
            .read_to_string(&mut text)
            .unwrap();
        assert!(!text.contains("password"));
        assert!(!text.contains("private-server"));
        assert!(!text.contains("corrupt"));
    }

    #[test]
    fn unavailable_local_logging_never_breaks_operations() {
        let logger = Arc::new(Logger::new(None, MAX_LOG_BYTES));
        assert!(!logger.status().available);
        assert!(logger.set_enabled(true).is_err());
        logger.begin(Operation::WorkspaceAccess).success();
        assert_eq!(logger.status().pending_operations, 0);
    }

    #[test]
    fn invalid_identity_is_not_logged_as_arbitrary_text() {
        assert_eq!(safe_build_label("C:\\Users\\Private\\app"), "unknown");
        assert_eq!(safe_build_label("secret\npassword"), "unknown");
        assert_eq!(safe_build_label("2.9.0-test.75"), "2.9.0-test.75");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_rejects_network_mounts_before_opening_target_paths() {
        let mounts = vec![
            (PathBuf::from("/"), true),
            (PathBuf::from("/Volumes/network"), false),
            (PathBuf::from("/Volumes/local"), true),
        ];
        assert!(!local_mount_for(
            Path::new("/Volumes/network/logs/report.zip"),
            &mounts
        ));
        assert!(local_mount_for(
            Path::new("/Volumes/network-name-local/logs"),
            &mounts
        ));
        assert!(local_mount_for(Path::new("/Volumes/local/logs"), &mounts));
        assert!(local_mount_for(Path::new("/Users/test/logs"), &mounts));
        assert!(verify_macos_local_volume(&std::env::temp_dir().canonicalize().unwrap()).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_directories_files_and_export_targets_are_rejected() {
        use std::os::unix::fs::symlink;
        let root = TestRoot::new();
        let target = root.0.join("target");
        fs::create_dir(&target).unwrap();
        let link = root.0.join("link");
        symlink(&target, &link).unwrap();
        assert!(!Logger::new(Some(link), MAX_LOG_BYTES).status().available);
        let logger = root.logger(MAX_LOG_BYTES);
        logger.set_enabled(true).unwrap();
        let outside = root.0.join("outside.txt");
        fs::write(&outside, "unchanged").unwrap();
        let current = logger.root.as_ref().unwrap().join(LOG_FILES[0]);
        fs::remove_file(&current).unwrap();
        symlink(&outside, &current).unwrap();
        logger.begin(Operation::WorkspaceAccess).success();
        assert!(logger.status().write_failures > 0);
        assert_eq!(fs::read_to_string(&outside).unwrap(), "unchanged");
        assert!(logger.export_bundle(&root.0.join("report.zip")).is_err());
        let export_link = root.0.join("linked.zip");
        symlink(&outside, &export_link).unwrap();
        assert!(validate_export_destination(&export_link).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn windows_unc_network_locations_are_rejected_without_opening_them() {
        for path in [
            r"\\server\share\report.zip",
            r"\\?\UNC\server\share\report.zip",
            r"\\.\pipe\report.zip",
        ] {
            assert!(verify_local_path(Path::new(path)).is_err());
        }
    }
}
