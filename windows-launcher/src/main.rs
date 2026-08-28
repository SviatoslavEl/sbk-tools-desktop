#![windows_subsystem = "windows"]

use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;
use std::time::Duration;
#[cfg(windows)]
use std::{mem::size_of, os::windows::io::AsRawHandle, process::Child};
use uuid::Uuid;
use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
#[cfg(windows)]
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
    SetInformationJobObject,
};
use windows_sys::Win32::System::Threading::{
    GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{MB_ICONERROR, MB_OK, MessageBoxW};

static PAYLOAD: &[u8] = include_bytes!(env!("SBK_PAYLOAD_TAR_ZST"));
const PREFIX: &str = "SBKTools-runtime-";

fn runtime_pid(name: &str) -> Option<u32> {
    name.strip_prefix(PREFIX)?
        .split('-')
        .next()?
        .parse::<u32>()
        .ok()
}

fn remove_runtime(runtime: &Path) -> Result<(), String> {
    let mut last_error = None;
    for _ in 0..20 {
        match fs::remove_dir_all(runtime) {
            Ok(()) => return Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => last_error = Some(error),
        }
        thread::sleep(Duration::from_millis(100));
    }
    Err(format!(
        "Не удалось удалить временные компоненты {}: {}",
        runtime.display(),
        last_error
            .map(|error| error.to_string())
            .unwrap_or_else(|| "неизвестная ошибка".to_string())
    ))
}

#[cfg(windows)]
fn create_kill_job(child: &Child) -> Result<isize, String> {
    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return Err("Не удалось создать контейнер процесса".to_string());
        }
        let mut information: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        information.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &information as *const _ as *const _,
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        if configured == 0 {
            CloseHandle(job);
            return Err("Не удалось настроить контейнер процесса".to_string());
        }
        let assigned = AssignProcessToJobObject(job, child.as_raw_handle() as *mut _);
        if assigned == 0 {
            CloseHandle(job);
            return Err("Не удалось привязать приложение к контейнеру процесса".to_string());
        }
        Ok(job as isize)
    }
}

fn process_alive(pid: u32) -> bool {
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return false;
        }
        let mut code = 0_u32;
        let alive = GetExitCodeProcess(handle, &mut code) != 0 && code == STILL_ACTIVE as u32;
        CloseHandle(handle);
        alive
    }
}

fn cleanup_stale(base: &Path) {
    let Ok(entries) = fs::read_dir(base) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(pid) = runtime_pid(&name) else {
            continue;
        };
        if !process_alive(pid) {
            let _ = remove_runtime(&entry.path());
        }
    }
}

fn verify_embedded_payload(runtime: &Path) -> Result<(), String> {
    let required = [
        "SBK-Tools.exe",
        "sbk-scanner-worker.exe",
        "scanner-runtime/resources/ocr/windows/bin/tesseract.exe",
        "scanner-runtime/resources/ocr/windows/tessdata/eng.traineddata",
        "scanner-runtime/resources/ocr/windows/tessdata/rus.traineddata",
        "scanner-runtime/resources/office/windows/program/soffice.exe",
        "webview2-runtime/Microsoft.WebView2.FixedVersionRuntime.151.0.4129.107.x64/msedgewebview2.exe",
    ];
    for relative in required {
        if !runtime.join(relative).is_file() {
            return Err(format!("Во встроенном пакете отсутствует {relative}"));
        }
    }
    Ok(())
}

fn checked_worker(
    runtime: &Path,
    working_directory: &Path,
    arguments: &[&str],
) -> Result<(), String> {
    let status = Command::new(runtime.join("sbk-scanner-worker.exe"))
        .args(arguments)
        .current_dir(working_directory)
        .env(
            "SCANDOCUMENT_RESOURCE_ROOT",
            runtime.join("scanner-runtime"),
        )
        .status()
        .map_err(|error| format!("Не удалось проверить встроенный модуль сканера: {error}"))?;
    if !status.success() {
        return Err(format!(
            "Встроенный модуль сканера не прошёл проверку: {}",
            arguments.join(" ")
        ));
    }
    Ok(())
}

fn run_self_test(runtime: &Path) -> Result<i32, String> {
    verify_embedded_payload(runtime)?;
    checked_worker(runtime, runtime, &["info"])?;
    if let Some(project_root) = std::env::var_os("SBK_ONEFILE_SELF_TEST_ROOT").map(PathBuf::from) {
        fs::create_dir_all(project_root.join("scanner-worker/tests/output"))
            .map_err(|error| error.to_string())?;
        for (operation, config) in [
            ("extract", "scanner-worker/tests/fixtures/preview.json"),
            ("preview", "scanner-worker/tests/fixtures/preview.json"),
            ("preview", "scanner-worker/tests/fixtures/preview-docx.json"),
            ("process", "scanner-worker/tests/fixtures/process.json"),
            ("process", "scanner-worker/tests/fixtures/process-docx.json"),
            ("process", "scanner-worker/tests/fixtures/process-ocr.json"),
            (
                "process",
                "scanner-worker/tests/fixtures/process-facsimile.json",
            ),
        ] {
            checked_worker(runtime, &project_root, &[operation, "--config", config])?;
        }
    }
    let nested_temp_remains = fs::read_dir(runtime)
        .map_err(|error| error.to_string())?
        .flatten()
        .any(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with(".scanner-worker-")
        });
    if nested_temp_remains {
        return Err("Временные компоненты сканера не удалены после проверки".to_string());
    }
    Ok(0)
}

fn unpack(destination: &Path) -> Result<(), String> {
    let cursor = Cursor::new(PAYLOAD);
    let decoder = zstd::stream::read::Decoder::new(cursor)
        .map_err(|_| "Встроенные компоненты повреждены".to_string())?;
    let mut archive = tar::Archive::new(decoder);
    let entries = archive.entries().map_err(|error| error.to_string())?;
    for entry in entries {
        let mut entry = entry.map_err(|error| error.to_string())?;
        if !entry
            .unpack_in(destination)
            .map_err(|error| error.to_string())?
        {
            return Err("Встроенный архив содержит опасный путь".to_string());
        }
    }
    Ok(())
}

fn run() -> Result<i32, String> {
    let self_test = std::env::args_os().any(|argument| argument == "--self-test");
    let temp = std::env::temp_dir();
    cleanup_stale(&temp);
    let runtime = temp.join(format!("{PREFIX}{}-{}", std::process::id(), Uuid::new_v4()));
    fs::create_dir(&runtime)
        .map_err(|error| format!("Не удалось создать временную папку: {error}"))?;
    if let Err(error) = unpack(&runtime) {
        let _ = remove_runtime(&runtime);
        return Err(error);
    }
    if self_test {
        let result = run_self_test(&runtime);
        let cleanup = remove_runtime(&runtime);
        return match (result, cleanup) {
            (Err(error), _) => Err(error),
            (Ok(_), Err(error)) => Err(error),
            (Ok(code), Ok(())) => Ok(code),
        };
    }
    let executable = runtime.join("SBK-Tools.exe");
    let mut child = Command::new(&executable)
        .current_dir(&runtime)
        .spawn()
        .map_err(|error| format!("Не удалось запустить приложение: {error}"))?;
    #[cfg(windows)]
    let job = match create_kill_job(&child) {
        Ok(job) => job,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            let _ = remove_runtime(&runtime);
            return Err(error);
        }
    };
    let status = child.wait().map_err(|error| error.to_string())?;
    #[cfg(windows)]
    unsafe {
        CloseHandle(job as *mut _);
    }
    let code = status.code().unwrap_or(1);
    remove_runtime(&runtime)?;
    Ok(code)
}

fn main() {
    let code = match run() {
        Ok(code) => code,
        Err(message) => {
            let title: Vec<u16> = "СБК Инструменты — ошибка запуска\0"
                .encode_utf16()
                .collect();
            let text: Vec<u16> = format!("{message}\n\nВременные компоненты не были сохранены.\0")
                .encode_utf16()
                .collect();
            unsafe {
                MessageBoxW(
                    std::ptr::null_mut(),
                    text.as_ptr(),
                    title.as_ptr(),
                    MB_OK | MB_ICONERROR,
                );
            }
            1
        }
    };
    std::process::exit(code);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_exact_runtime_names_with_numeric_pid() {
        assert_eq!(runtime_pid("SBKTools-runtime-42-deadbeef"), Some(42));
        assert_eq!(runtime_pid("SBKTools-runtime-nope-deadbeef"), None);
        assert_eq!(runtime_pid("unrelated-42-deadbeef"), None);
    }
}
