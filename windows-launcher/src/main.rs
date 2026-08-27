#![windows_subsystem = "windows"]

use std::fs;
use std::io::Cursor;
use std::path::Path;
use std::process::Command;
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
        let Some(rest) = name.strip_prefix(PREFIX) else {
            continue;
        };
        let Some(pid) = rest
            .split('-')
            .next()
            .and_then(|value| value.parse::<u32>().ok())
        else {
            continue;
        };
        if !process_alive(pid) {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
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
    let temp = std::env::temp_dir();
    cleanup_stale(&temp);
    let runtime = temp.join(format!("{PREFIX}{}-{}", std::process::id(), Uuid::new_v4()));
    fs::create_dir(&runtime)
        .map_err(|error| format!("Не удалось создать временную папку: {error}"))?;
    if let Err(error) = unpack(&runtime) {
        let _ = fs::remove_dir_all(&runtime);
        return Err(error);
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
            let _ = fs::remove_dir_all(&runtime);
            return Err(error);
        }
    };
    let status = child.wait().map_err(|error| error.to_string())?;
    #[cfg(windows)]
    unsafe {
        CloseHandle(job as *mut _);
    }
    let code = status.code().unwrap_or(1);
    let _ = fs::remove_dir_all(&runtime);
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
