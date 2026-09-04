use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::ExitCode;
use uuid::Uuid;

const REQUIRED_FILES: &[&str] = &[
    "SBK-Tools-Fast.exe",
    "sbk-scanner-worker.exe",
    "scanner-runtime/resources/resource-manifest.json",
    "scanner-runtime/resources/ocr/windows/bin/tesseract.exe",
    "scanner-runtime/resources/ocr/windows/tessdata/eng.traineddata",
    "scanner-runtime/resources/ocr/windows/tessdata/rus.traineddata",
    "scanner-runtime/resources/office/windows/program/soffice.exe",
    "webview2-runtime/Microsoft.WebView2.FixedVersionRuntime.151.0.4129.107.x64/msedgewebview2.exe",
    "LICENSE",
    "THIRD_PARTY_LICENSES.md",
];

fn safe_archive_path(path: &Path) -> bool {
    !path.as_os_str().is_empty()
        && path
            .components()
            .all(|component| matches!(component, Component::Normal(_) | Component::CurDir))
}

fn unpack(archive_path: &Path, destination: &Path) -> Result<(), String> {
    let archive = fs::File::open(archive_path)
        .map_err(|error| format!("Не удалось открыть пакет установки: {error}"))?;
    let decoder = zstd::stream::read::Decoder::new(archive)
        .map_err(|error| format!("Пакет установки повреждён: {error}"))?;
    let mut archive = tar::Archive::new(decoder);
    let entries = archive
        .entries()
        .map_err(|error| format!("Не удалось прочитать пакет установки: {error}"))?;
    for entry in entries {
        let mut entry = entry.map_err(|error| error.to_string())?;
        let kind = entry.header().entry_type();
        if !kind.is_file() && !kind.is_dir() {
            return Err("Пакет установки содержит неподдерживаемый объект".to_string());
        }
        let path = entry.path().map_err(|error| error.to_string())?;
        if !safe_archive_path(&path) {
            return Err("Пакет установки содержит опасный путь".to_string());
        }
        if !entry
            .unpack_in(destination)
            .map_err(|error| error.to_string())?
        {
            return Err("Пакет установки содержит опасный путь".to_string());
        }
    }
    Ok(())
}

fn verify_payload(root: &Path) -> Result<(), String> {
    for relative in REQUIRED_FILES {
        if !root.join(relative).is_file() {
            return Err(format!(
                "В пакете отсутствует обязательный файл: {relative}"
            ));
        }
    }
    Ok(())
}

fn install(archive: &Path, destination: &Path) -> Result<(), String> {
    let parent = destination
        .parent()
        .ok_or_else(|| "Не удалось определить каталог установки".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Не удалось создать каталог установки: {error}"))?;

    let suffix = Uuid::new_v4();
    let staging = parent.join(format!(".sbk-tools-fast-installing-{suffix}"));
    let backup = parent.join(format!(".sbk-tools-fast-previous-{suffix}"));
    fs::create_dir(&staging)
        .map_err(|error| format!("Не удалось подготовить установку: {error}"))?;

    let prepared = unpack(archive, &staging).and_then(|()| verify_payload(&staging));
    if let Err(error) = prepared {
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }

    let had_previous = destination.exists();
    if had_previous && let Err(error) = fs::rename(destination, &backup) {
        let _ = fs::remove_dir_all(&staging);
        return Err(format!(
            "Не удалось обновить программу. Закройте запущенные экземпляры и повторите: {error}"
        ));
    }

    if let Err(error) = fs::rename(&staging, destination) {
        if had_previous {
            let _ = fs::rename(&backup, destination);
        }
        let _ = fs::remove_dir_all(&staging);
        return Err(format!("Не удалось завершить установку: {error}"));
    }

    if had_previous {
        let _ = fs::remove_dir_all(backup);
    }
    Ok(())
}

fn run() -> Result<(), String> {
    let mut arguments = std::env::args_os().skip(1);
    let archive = PathBuf::from(
        arguments
            .next()
            .ok_or_else(|| "Не указан пакет установки".to_string())?,
    );
    let destination = PathBuf::from(
        arguments
            .next()
            .ok_or_else(|| "Не указан каталог установки".to_string())?,
    );
    if arguments.next().is_some() {
        return Err("Переданы лишние параметры установки".to_string());
    }
    install(&archive, &destination)
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_relative_archive_paths() {
        assert!(safe_archive_path(Path::new(
            "scanner-runtime/resources/file.bin"
        )));
        assert!(!safe_archive_path(Path::new("../ProductData")));
        assert!(!safe_archive_path(Path::new("/absolute/path")));
    }

    #[test]
    fn required_payload_keeps_user_data_outside_program_directory() {
        assert!(
            REQUIRED_FILES
                .iter()
                .all(|path| !path.contains("ProductData"))
        );
        assert!(REQUIRED_FILES.contains(&"SBK-Tools-Fast.exe"));
    }
}
