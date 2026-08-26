#![windows_subsystem = "windows"]

use std::fs::{self, File};
use std::io::{Cursor, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use uuid::Uuid;
use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
use windows_sys::Win32::System::Threading::{
    GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{MB_ICONERROR, MB_OK, MessageBoxW};

static PAYLOAD: &[u8] = include_bytes!(env!("SBK_PAYLOAD_ZIP"));
const PREFIX: &str = "SBKTools-runtime-";

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
    let mut archive =
        zip::ZipArchive::new(cursor).map_err(|_| "Встроенные компоненты повреждены".to_string())?;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|error| error.to_string())?;
        let relative = entry
            .enclosed_name()
            .ok_or_else(|| "Встроенный архив содержит опасный путь".to_string())?;
        let target = destination.join(relative);
        if entry.is_dir() {
            fs::create_dir_all(&target).map_err(|error| error.to_string())?;
            continue;
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let mut output = File::create(&target).map_err(|error| error.to_string())?;
        std::io::copy(&mut entry, &mut output).map_err(|error| error.to_string())?;
        output.flush().map_err(|error| error.to_string())?;
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
    let local_data = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| temp.clone())
        .join("SBKTools")
        .join("ProductData");
    fs::create_dir_all(&local_data)
        .map_err(|error| format!("Не удалось открыть папку данных: {error}"))?;
    let executable = runtime.join("SBK-Tools.exe");
    let status = Command::new(&executable)
        .current_dir(&runtime)
        .env("SBK_TOOLS_WORKSPACE", &local_data)
        .spawn()
        .map_err(|error| format!("Не удалось запустить приложение: {error}"))?
        .wait()
        .map_err(|error| error.to_string())?;
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
