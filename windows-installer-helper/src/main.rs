use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::process::ExitCode;
use std::sync::OnceLock;

mod locks;
mod transaction;

static DIAGNOSTIC_PATH: OnceLock<PathBuf> = OnceLock::new();

fn diagnostic(message: &str) {
    if let Some(path) = DIAGNOSTIC_PATH.get()
        && let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(path)
    {
        let _ = writeln!(file, "{message}");
    }
}

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
const INSTALL_MARKER: &str = ".sbk-tools-fast-installation";
const PRODUCT_DATA: &str = "ProductData";

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
        let root = path.components().find_map(|component| match component {
            Component::Normal(name) => Some(name),
            _ => None,
        });
        if !root.is_some_and(|name| {
            transaction::PAYLOAD_ROOTS
                .iter()
                .any(|allowed| name == *allowed)
        }) {
            return Err(format!(
                "Пакет содержит файл вне разрешённых компонентов программы: {}. База ProductData и пользовательские файлы не заменяются.",
                path.display()
            ));
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

fn directory_is_empty(path: &Path) -> Result<bool, String> {
    Ok(fs::read_dir(path)
        .map_err(|error| format!("Не удалось проверить каталог установки: {error}"))?
        .next()
        .is_none())
}

fn verify_existing_install(destination: &Path) -> Result<(), String> {
    if destination.exists() && !destination.is_dir() {
        return Err("Путь установки занят файлом. Выберите другой каталог.".to_string());
    }
    let product_data_only = if destination.is_dir() {
        let entries = fs::read_dir(destination)
            .map_err(|error| format!("Не удалось проверить каталог установки: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("Не удалось проверить каталог установки: {error}"))?;
        entries.len() == 1 && entries[0].file_name() == PRODUCT_DATA && entries[0].path().is_dir()
    } else {
        false
    };
    if destination.is_dir()
        && !directory_is_empty(destination)?
        && !destination.join(INSTALL_MARKER).is_file()
        && !product_data_only
    {
        return Err(
            "Выбран непустой каталог, который не принадлежит СБК Инструментам. Выберите другой каталог, чтобы не потерять файлы."
                .to_string(),
        );
    }
    Ok(())
}

fn install(archive: &Path, destination: &Path) -> Result<(), String> {
    transaction::install(archive, destination)
}

fn run() -> Result<(), String> {
    let mut arguments = std::env::args_os().skip(1);
    let archive_or_mode = PathBuf::from(
        arguments
            .next()
            .ok_or_else(|| "Не указан пакет установки".to_string())?,
    );
    let destination = PathBuf::from(
        arguments
            .next()
            .ok_or_else(|| "Не указан каталог установки".to_string())?,
    );
    let _diagnostic_path = arguments.next();
    if arguments.next().is_some() {
        return Err("Переданы лишние параметры установки".to_string());
    }
    if archive_or_mode == Path::new("--check") {
        transaction::preflight(&destination)
    } else {
        install(&archive_or_mode, &destination)
    }
}

fn main() -> ExitCode {
    let diagnostic_path = std::env::args_os().nth(3).map(PathBuf::from);
    if let Some(path) = &diagnostic_path {
        let _ = DIAGNOSTIC_PATH.set(path.clone());
    }
    diagnostic(&format!(
        "Extractor {} / PID {}",
        env!("CARGO_PKG_VERSION"),
        std::process::id()
    ));
    diagnostic(&format!(
        "Executable: {:?}; working directory: {:?}",
        std::env::current_exe(),
        std::env::current_dir()
    ));
    diagnostic(&format!("Destination: {:?}", std::env::args_os().nth(2)));
    match run() {
        Ok(()) => {
            diagnostic("Операция установщика завершена успешно");
            ExitCode::SUCCESS
        }
        Err(error) => {
            if let Some(path) = &diagnostic_path {
                let message_path = PathBuf::from(format!("{}.message.txt", path.display()));
                let bytes: Vec<u8> = std::iter::once(0xfeffu16)
                    .chain(format!("{error}\r\n").encode_utf16())
                    .flat_map(u16::to_le_bytes)
                    .collect();
                let _ = fs::write(message_path, bytes);
            }
            diagnostic(&format!("ERROR: {error}"));
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

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

    #[test]
    fn install_marker_and_product_data_are_separate() {
        assert_ne!(INSTALL_MARKER, PRODUCT_DATA);
        assert!(!REQUIRED_FILES.contains(&PRODUCT_DATA));
    }

    #[test]
    fn rejects_unowned_nonempty_install_directory() {
        let root = std::env::temp_dir().join(format!("sbk-installer-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("user-file.txt"), b"keep").unwrap();
        assert!(verify_existing_install(&root).is_err());
        fs::write(root.join(INSTALL_MARKER), b"owned").unwrap();
        assert!(verify_existing_install(&root).is_ok());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn accepts_product_data_only_after_uninstall() {
        let root = std::env::temp_dir().join(format!("sbk-installer-test-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join(PRODUCT_DATA)).unwrap();
        fs::write(root.join(PRODUCT_DATA).join("keep.txt"), b"keep").unwrap();
        assert!(verify_existing_install(&root).is_ok());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn payload_rejects_database_and_unknown_roots_before_installation() {
        for path in ["ProductData/keep.db", "user-notes.txt", "uninstall.exe"] {
            let root =
                std::env::temp_dir().join(format!("sbk-payload-allowlist-{}", Uuid::new_v4()));
            fs::create_dir(&root).unwrap();
            let archive = root.join("payload.tar.zst");
            let encoder =
                zstd::stream::Encoder::new(fs::File::create(&archive).unwrap(), 1).unwrap();
            let mut tar = tar::Builder::new(encoder);
            let mut header = tar::Header::new_gnu();
            header.set_size(4);
            header.set_mode(0o644);
            header.set_cksum();
            tar.append_data(&mut header, path, &b"deny"[..]).unwrap();
            tar.into_inner().unwrap().finish().unwrap();
            let destination = root.join("stage");
            fs::create_dir(&destination).unwrap();
            assert!(
                unpack(&archive, &destination)
                    .unwrap_err()
                    .contains("вне разрешённых")
            );
            assert!(directory_is_empty(&destination).unwrap());
            fs::remove_dir_all(root).unwrap();
        }
    }
}
