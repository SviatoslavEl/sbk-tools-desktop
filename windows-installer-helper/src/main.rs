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
    let parent = destination
        .parent()
        .ok_or_else(|| "Не удалось определить каталог установки".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Не удалось создать каталог установки: {error}"))?;
    let had_previous = destination.exists();
    if had_previous {
        verify_existing_install(destination)?;
    }

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
    if let Err(error) = fs::write(staging.join(INSTALL_MARKER), b"SBK Tools Fast\n") {
        let _ = fs::remove_dir_all(&staging);
        return Err(format!("Не удалось записать маркер установки: {error}"));
    }

    if had_previous && let Err(error) = fs::rename(destination, &backup) {
        let _ = fs::remove_dir_all(&staging);
        return Err(format!(
            "Не удалось обновить программу. Закройте запущенные экземпляры и повторите: {error}"
        ));
    }

    let previous_product_data = backup.join(PRODUCT_DATA);
    let staged_product_data = staging.join(PRODUCT_DATA);
    let preserved_product_data = had_previous && previous_product_data.exists();
    if preserved_product_data && staged_product_data.exists() {
        let _ = fs::rename(&backup, destination);
        let _ = fs::remove_dir_all(&staging);
        return Err("Пакет установки не должен содержать ProductData".to_string());
    }
    if preserved_product_data
        && let Err(error) = fs::rename(&previous_product_data, &staged_product_data)
    {
        let _ = fs::rename(&backup, destination);
        let _ = fs::remove_dir_all(&staging);
        return Err(format!(
            "Не удалось сохранить ProductData при обновлении: {error}"
        ));
    }

    if let Err(error) = fs::rename(&staging, destination) {
        let product_data_restored = !preserved_product_data
            || fs::rename(&staged_product_data, &previous_product_data).is_ok();
        if had_previous {
            let _ = fs::rename(&backup, destination);
        }
        if product_data_restored {
            let _ = fs::remove_dir_all(&staging);
        } else {
            return Err(format!(
                "Не удалось завершить установку: {error}. ProductData сохранена для ручного восстановления в {}",
                staged_product_data.display()
            ));
        }
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
    let _diagnostic_path = arguments.next();
    if arguments.next().is_some() {
        return Err("Переданы лишние параметры установки".to_string());
    }
    install(&archive, &destination)
}

fn main() -> ExitCode {
    let diagnostic_path = std::env::args_os().nth(3).map(PathBuf::from);
    if let Some(path) = &diagnostic_path {
        let _ = fs::write(path, "Распаковщик запущен\n");
    }
    match run() {
        Ok(()) => {
            if let Some(path) = &diagnostic_path {
                let _ = fs::write(path, "Установка файлов завершена успешно\n");
            }
            ExitCode::SUCCESS
        }
        Err(error) => {
            if let Some(path) = &diagnostic_path {
                let _ = fs::write(path, format!("{error}\n"));
            }
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
}
