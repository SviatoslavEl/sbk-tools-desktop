use std::path::Path;

/// Read-only snapshot of whether Windows currently grants rename/delete access.
/// The caller must restrict this check to existing, installer-owned paths and
/// still handle a later rename failure: another process can open the file later.
#[cfg(windows)]
pub fn ensure_replaceable(path: &Path) -> Result<(), String> {
    windows::ensure_replaceable(path)
}

/// Unix sharing semantics cannot stand in for a Windows sharing-lock check.
#[cfg(not(windows))]
pub fn ensure_replaceable(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(any(windows, test))]
fn process_label(application: &str, service: &str, pid: u32) -> String {
    let clean = |value: &str| value.split_whitespace().collect::<Vec<_>>().join(" ");
    let application = clean(application);
    let service = clean(service);
    match (application.is_empty(), service.is_empty()) {
        (false, true) => format!("{application} (PID {pid})"),
        (false, false) => format!("{application} (служба {service}, PID {pid})"),
        (true, false) => format!("Служба {service} (PID {pid})"),
        (true, true) => format!("Процесс с неизвестным именем (PID {pid})"),
    }
}

#[cfg(any(windows, test))]
fn replacement_error(path: &Path, code: u32, system_error: &str, diagnosis: &str) -> String {
    format!(
        "Не удалось подготовить к замене: {}\nОшибка Windows {code}: {system_error}\n{diagnosis}\n\
         Закройте использующее этот путь приложение, если оно вам известно, и повторите установку. \
         Если причина — права доступа, выберите доступный для записи каталог. \
         Установщик не завершает процессы автоматически.",
        path.display()
    )
}

#[cfg(windows)]
mod windows {
    use super::{process_label, replacement_error};
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Foundation::{
        CloseHandle, ERROR_INVALID_NAME, ERROR_MORE_DATA, ERROR_SUCCESS, GetLastError,
        INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, DELETE, FILE_FLAG_BACKUP_SEMANTICS, FILE_SHARE_DELETE, FILE_SHARE_READ,
        FILE_SHARE_WRITE, OPEN_EXISTING,
    };
    use windows_sys::Win32::System::RestartManager::{
        CCH_RM_SESSION_KEY, RM_PROCESS_INFO, RmEndSession, RmGetList, RmRegisterResources,
        RmStartSession,
    };

    pub(super) fn ensure_replaceable(path: &Path) -> Result<(), String> {
        // Canonical paths support long Windows paths and satisfy Restart
        // Manager's full-path requirement. Preserve the original in the UI.
        let probe_path = std::fs::canonicalize(path)
            .or_else(|_| std::path::absolute(path))
            .unwrap_or_else(|_| path.to_path_buf());
        let mut wide: Vec<u16> = probe_path.as_os_str().encode_wide().collect();
        if wide.contains(&0) {
            return Err(replacement_error(
                path,
                ERROR_INVALID_NAME,
                "Путь содержит недопустимый нулевой символ.",
                "Определение использующего путь процесса не выполнялось.",
            ));
        }
        wide.push(0);

        // DELETE is only the requested access right. OPEN_EXISTING and the
        // absence of DELETE_ON_CLOSE leave all files and directories untouched.
        let handle = unsafe {
            CreateFileW(
                wide.as_ptr(),
                DELETE,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                null(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS,
                null_mut(),
            )
        };
        if handle != INVALID_HANDLE_VALUE {
            // There is no write, rename or delete operation on this handle.
            unsafe { CloseHandle(handle) };
            return Ok(());
        }
        // Capture immediately; metadata/Restart Manager calls alter last-error.
        let code = unsafe { GetLastError() };
        let system_error = std::io::Error::from_raw_os_error(code as i32).to_string();
        let diagnosis = match std::fs::metadata(&probe_path) {
            Ok(metadata) if metadata.is_file() => diagnose_file(&wide),
            Ok(metadata) if metadata.is_dir() => {
                "Процесс, использующий каталог, определить не удалось: Restart Manager не поддерживает регистрацию каталогов.".to_owned()
            }
            _ => "Процесс, использующий путь, определить не удалось: тип объекта недоступен.".to_owned(),
        };
        Err(replacement_error(path, code, &system_error, &diagnosis))
    }

    // Only the session's diagnostic bookkeeping is changed. In particular,
    // RmShutdown/RmRestart and any process-termination API are never called.
    struct RestartSession(u32);

    impl Drop for RestartSession {
        fn drop(&mut self) {
            unsafe { RmEndSession(self.0) };
        }
    }

    fn diagnostic_failure(operation: &str, code: u32) -> String {
        format!(
            "Процесс, использующий файл, определить не удалось: {operation}, ошибка Windows {code}: {}.",
            std::io::Error::from_raw_os_error(code as i32)
        )
    }

    fn from_wide(value: &[u16]) -> String {
        let end = value
            .iter()
            .position(|&unit| unit == 0)
            .unwrap_or(value.len());
        String::from_utf16_lossy(&value[..end])
    }

    fn diagnose_file(wide_path: &[u16]) -> String {
        let mut session_handle = 0;
        let mut session_key = [0u16; CCH_RM_SESSION_KEY as usize + 1];
        let result = unsafe { RmStartSession(&mut session_handle, 0, session_key.as_mut_ptr()) };
        if result != ERROR_SUCCESS {
            return diagnostic_failure("RmStartSession", result);
        }
        let session = RestartSession(session_handle);
        let files = [wide_path.as_ptr()];
        let result =
            unsafe { RmRegisterResources(session.0, 1, files.as_ptr(), 0, null(), 0, null()) };
        if result != ERROR_SUCCESS {
            return diagnostic_failure("RmRegisterResources", result);
        }

        let mut entries = Vec::<RM_PROCESS_INFO>::new();
        // The process list can grow between calls. Bound both retries and
        // memory usage; a failed diagnostic never turns the preflight into OK.
        for _ in 0..4 {
            let mut needed = 0;
            let mut count = entries.len() as u32;
            let mut reboot_reasons = 0;
            let buffer = if entries.is_empty() {
                null_mut()
            } else {
                entries.as_mut_ptr()
            };
            let result = unsafe {
                RmGetList(
                    session.0,
                    &mut needed,
                    &mut count,
                    buffer,
                    &mut reboot_reasons,
                )
            };
            if result == ERROR_MORE_DATA {
                if needed == 0 || needed > 4096 {
                    return "Процесс, использующий файл, определить не удалось: Restart Manager вернул неподдерживаемый размер списка.".to_owned();
                }
                entries.resize(needed as usize, RM_PROCESS_INFO::default());
                continue;
            }
            if result != ERROR_SUCCESS {
                return diagnostic_failure("RmGetList", result);
            }
            if count as usize > entries.len() {
                return "Процесс, использующий файл, определить не удалось: Restart Manager вернул неполный список.".to_owned();
            }
            let mut labels: Vec<String> = entries[..count as usize]
                .iter()
                .map(|entry| {
                    process_label(
                        &from_wide(&entry.strAppName),
                        &from_wide(&entry.strServiceShortName),
                        entry.Process.dwProcessId,
                    )
                })
                .collect();
            labels.sort();
            labels.dedup();
            if labels.is_empty() {
                return "Restart Manager не определил процесс, использующий файл. Причиной могут быть права доступа, системная блокировка или уже завершившийся процесс.".to_owned();
            }
            let omitted = labels.len().saturating_sub(16);
            labels.truncate(16);
            let mut description = format!(
                "Windows сообщает, что файл используют: {}.",
                labels.join("; ")
            );
            if omitted > 0 {
                description.push_str(&format!(" Ещё процессов: {omitted}."));
            }
            return description;
        }
        "Процесс, использующий файл, определить не удалось: список процессов изменился во время проверки. Повторите установку.".to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn process_description_preserves_name_and_pid() {
        assert_eq!(
            process_label("СБК Инструменты", "", 42),
            "СБК Инструменты (PID 42)"
        );
        assert_eq!(
            process_label("", "BackupSvc", 77),
            "Служба BackupSvc (PID 77)"
        );
        assert_eq!(
            process_label("Indexer", "Search", 7),
            "Indexer (служба Search, PID 7)"
        );
    }

    #[test]
    fn unnamed_process_is_not_guessed() {
        assert_eq!(
            process_label("  ", "", 19),
            "Процесс с неизвестным именем (PID 19)"
        );
        assert_eq!(
            process_label("Editor\r\n Instance", "", 8),
            "Editor Instance (PID 8)"
        );
    }

    #[test]
    fn failure_keeps_path_code_and_uncertain_diagnosis() {
        let path = Path::new(r"C:\СБК Инструменты\scanner-runtime\worker.dll");
        let message = replacement_error(path, 32, "Sharing violation", "Владелец не определён.");
        assert!(message.contains(&path.display().to_string()));
        assert!(message.contains("Ошибка Windows 32: Sharing violation"));
        assert!(message.contains("Владелец не определён."));
        assert!(message.contains("не завершает процессы автоматически"));
    }

    #[cfg(not(windows))]
    #[test]
    fn non_windows_does_not_emulate_windows_locks_or_require_an_existing_path() {
        assert!(ensure_replaceable(Path::new("nonexistent-windows-lock-probe")).is_ok());
    }
}
