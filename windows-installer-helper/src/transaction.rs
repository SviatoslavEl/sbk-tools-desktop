use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{INSTALL_MARKER, diagnostic, locks, unpack, verify_existing_install, verify_payload};

// Only application-owned roots may enter the transaction. In particular, neither
// the installation directory itself nor ProductData is renamed or removed.
pub(crate) const PAYLOAD_ROOTS: &[&str] = &[
    "SBK-Tools-Fast.exe",
    "sbk-scanner-worker.exe",
    "scanner-runtime",
    "webview2-runtime",
    "LICENSE",
    "THIRD_PARTY_LICENSES.md",
];
const PENDING_MARKER: &str = ".sbk-tools-fast-update-pending";

fn normalize_destination(destination: &Path) -> Result<PathBuf, String> {
    let absolute = if destination.is_absolute() {
        destination.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|error| format!("Не удалось определить текущую папку: {error}"))?
            .join(destination)
    };
    let name = absolute
        .file_name()
        .ok_or("Нельзя устанавливать программу в корень диска")?;
    let parent = absolute
        .parent()
        .ok_or("Не указана родительская папка установки")?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Не удалось создать папку {}: {error}", parent.display()))?;
    let parent = fs::canonicalize(parent)
        .map_err(|error| format!("Не удалось открыть папку {}: {error}", parent.display()))?;
    let destination = parent.join(name);
    reject_link(&destination)?;
    if destination.exists() {
        fs::canonicalize(&destination).map_err(|error| {
            format!(
                "Не удалось определить папку установки {}: {error}",
                destination.display()
            )
        })
    } else {
        Ok(destination)
    }
}

fn acquire_install_lock(destination: &Path) -> Result<File, String> {
    // Persistent file + OS lock: do not unlink it on release, which could allow
    // two waiters to lock different inodes. The OS releases the lock on a crash.
    let key = destination.to_string_lossy().to_lowercase();
    let hash = format!("{:x}", Sha256::digest(key.as_bytes()));
    let path = destination
        .parent()
        .unwrap()
        .join(format!(".sbk-tools-fast-installer-lock-{hash}"));
    reject_link(&path)?;
    let file = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(&path)
        .map_err(|error| {
            format!(
                "Не удалось зарезервировать обновление {}: {error}",
                destination.display()
            )
        })?;
    file.try_lock().map_err(|error| format!("Другой установщик уже работает с папкой {} или блокировка недоступна: {error}. Дождитесь его завершения и повторите.", destination.display()))?;
    Ok(file)
}

fn reject_link(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            #[cfg(windows)]
            let reparse = {
                use std::os::windows::fs::MetadataExt;
                metadata.file_attributes() & 0x400 != 0
            };
            #[cfg(not(windows))]
            let reparse = false;
            if metadata.file_type().is_symlink() || reparse {
                return Err(format!(
                    "Обновление остановлено: компонент {} является ссылкой или точкой перенаправления. База и внешние файлы не изменялись.",
                    path.display()
                ));
            }
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Не удалось проверить {}: {error}", path.display())),
    }
}

fn verify_replaceable_tree(path: &Path) -> Result<(), String> {
    reject_link(path)?;
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("Не удалось проверить {}: {error}", path.display())),
    };
    // Check descendants as well: renaming a directory can fail because of a
    // loaded DLL or open child file. Report that exact path before unpacking.
    if metadata.is_dir() {
        let entries = fs::read_dir(path)
            .map_err(|error| format!("Не удалось прочитать {}: {error}", path.display()))?;
        for entry in entries {
            let entry = entry
                .map_err(|error| format!("Не удалось прочитать {}: {error}", path.display()))?;
            verify_replaceable_tree(&entry.path())?;
        }
    } else if !metadata.is_file() {
        return Err(format!(
            "Неподдерживаемый компонент программы: {}",
            path.display()
        ));
    }
    locks::ensure_replaceable(path)
}

fn check_destination(destination: &Path) -> Result<(), String> {
    reject_link(destination)?;
    let pending = destination.join(PENDING_MARKER);
    reject_link(&pending)?;
    if pending.exists() {
        return Err(format!(
            "Предыдущее обновление не завершено. Не запускайте программу и не удаляйте служебные папки. Файлы для восстановления указаны в {}. ProductData остаётся на месте.",
            pending.display()
        ));
    }
    verify_existing_install(destination)?;
    for name in PAYLOAD_ROOTS.iter().copied().chain([INSTALL_MARKER]) {
        verify_replaceable_tree(&destination.join(name))?;
    }
    // NSIS writes these after the payload transaction. Do not defer a known
    // lock on them until the new application files have already been installed.
    verify_replaceable_tree(&destination.join("uninstall.exe"))?;
    reject_link(&destination.join("licenses"))?;
    verify_replaceable_tree(&destination.join("licenses/NSIS-COPYING"))?;
    Ok(())
}

pub(crate) fn preflight(destination: &Path) -> Result<(), String> {
    let destination = normalize_destination(destination)?;
    let _lock = acquire_install_lock(&destination)?;
    diagnostic(&format!(
        "Preflight (stable directory): {}",
        destination.display()
    ));
    check_destination(&destination)
}

fn cleanup(path: &Path) {
    if let Err(error) = fs::remove_dir_all(path) {
        diagnostic(&format!(
            "Cleanup left recoverable directory {}: {error}",
            path.display()
        ));
    }
}

fn rename_checked(from: &Path, to: &Path) -> Result<(), String> {
    fs::rename(from, to).map_err(|error| {
        format!(
            "Не удалось переместить компонент {} в {}: {error}",
            from.display(),
            to.display()
        )
    })
}

fn replace_roots(
    staging: &Path,
    destination: &Path,
    backup: &Path,
    rename: &mut impl FnMut(&Path, &Path) -> Result<(), String>,
) -> Result<(), String> {
    let roots: Vec<&str> = PAYLOAD_ROOTS
        .iter()
        .copied()
        .chain([INSTALL_MARKER])
        .collect();
    let mut backed_up = Vec::new();
    let mut installed = Vec::new();
    let operation: Result<(), String> = (|| {
        // Remove the old entry point first; never expose a new executable with
        // an old runtime. On rollback the old executable is restored last.
        for name in &roots {
            let from = destination.join(name);
            if from
                .try_exists()
                .map_err(|error| format!("Не удалось проверить {}: {error}", from.display()))?
            {
                rename(&from, &backup.join(name))?;
                backed_up.push(*name);
            }
        }
        for name in roots.iter().skip(1).copied().chain([roots[0]]) {
            rename(&staging.join(name), &destination.join(name))?;
            installed.push(name);
        }
        Ok(())
    })();
    if let Err(error) = operation {
        let mut rollback_errors = Vec::new();
        for name in installed.iter().rev() {
            if let Err(rollback) = rename(&destination.join(name), &staging.join(name)) {
                rollback_errors.push(rollback);
            }
        }
        for name in backed_up.iter().rev() {
            if *name == PAYLOAD_ROOTS[0] && !rollback_errors.is_empty() {
                rollback_errors.push(format!("Исполняемый файл оставлен в {}: восстановление остальных компонентов не завершено", backup.join(name).display()));
                continue;
            }
            if destination.join(name).exists() {
                rollback_errors.push(format!(
                    "Нельзя восстановить {}: путь занят; прежний компонент сохранён в {}",
                    destination.join(name).display(),
                    backup.join(name).display()
                ));
            } else if let Err(rollback) = rename(&backup.join(name), &destination.join(name)) {
                rollback_errors.push(rollback);
            }
        }
        if !rollback_errors.is_empty() {
            return Err(format!(
                "{error}\nАвтоматический возврат файлов программы не завершён: {}\nНе удаляйте {} и {}. ProductData не перемещалась и не удалялась.",
                rollback_errors.join("; "),
                backup.display(),
                staging.display()
            ));
        }
        // Caller may clean up only after this marker is successfully removed.
        fs::remove_file(destination.join(PENDING_MARKER)).map_err(|marker_error| format!("{error}\nПрежние компоненты восстановлены, но не удалось снять маркер незавершённого обновления: {marker_error}. Сохранены {} и {}.", backup.display(), staging.display()))?;
        cleanup(staging);
        cleanup(backup);
        return Err(format!(
            "{error}\nПрежние файлы программы восстановлены. ProductData и пользовательские файлы не изменялись. Закройте указанный компонент и повторите установку."
        ));
    }
    Ok(())
}

pub(crate) fn install(archive: &Path, destination: &Path) -> Result<(), String> {
    let destination = normalize_destination(destination)?;
    let _lock = acquire_install_lock(&destination)?;
    diagnostic(&format!(
        "Preflight before extraction: {}",
        destination.display()
    ));
    check_destination(&destination)?;
    let suffix = Uuid::new_v4();
    let parent = destination.parent().unwrap();
    let staging = parent.join(format!(".sbk-tools-fast-installing-{suffix}"));
    let backup = parent.join(format!(".sbk-tools-fast-previous-{suffix}"));
    fs::create_dir(&staging).map_err(|error| {
        format!(
            "Не удалось подготовить установку {}: {error}",
            staging.display()
        )
    })?;
    diagnostic(&format!(
        "Staging: {}; backup: {}",
        staging.display(),
        backup.display()
    ));
    let prepared = unpack(archive, &staging)
        .and_then(|()| verify_payload(&staging))
        .and_then(|()| {
            fs::write(staging.join(INSTALL_MARKER), b"SBK Tools Fast\n")
                .map_err(|error| format!("Не удалось записать маркер установки: {error}"))
        })
        .and_then(|()| check_destination(&destination));
    if let Err(error) = prepared {
        cleanup(&staging);
        return Err(error);
    }
    fs::create_dir_all(&destination).map_err(|error| {
        format!(
            "Не удалось открыть папку установки {}: {error}",
            destination.display()
        )
    })?;
    fs::create_dir(&backup).map_err(|error| {
        format!(
            "Не удалось подготовить сохранение прежних компонентов {}: {error}",
            backup.display()
        )
    })?;
    let pending = destination.join(PENDING_MARKER);
    let journal = format!(
        "SBK Tools interrupted update\nDestination: {}\nPrevious application components: {}\nNew application components: {}\nProductData is unchanged. Do not delete these directories.\n",
        destination.display(),
        backup.display(),
        staging.display()
    );
    let mut marker = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&pending)
        .map_err(|error| {
            format!(
                "Не удалось зарезервировать обновление {}: {error}",
                pending.display()
            )
        })?;
    marker
        .write_all(journal.as_bytes())
        .and_then(|()| marker.sync_all())
        .map_err(|error| {
            format!(
                "Не удалось сохранить журнал {}: {error}. Файлы программы ещё не изменены.",
                pending.display()
            )
        })?;
    drop(marker);
    replace_roots(&staging, &destination, &backup, &mut rename_checked)?;
    // Keep all recovery files if even completion bookkeeping fails.
    fs::remove_file(&pending).map_err(|error| format!("Новые файлы программы установлены, но завершение обновления не подтверждено: {error}. Сохранены {} и {}. Не удаляйте их.", backup.display(), pending.display()))?;
    cleanup(&staging);
    cleanup(&backup);
    diagnostic(
        "Application components replaced; installation directory, ProductData and unknown user files kept in place",
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io;

    fn fixture() -> (PathBuf, PathBuf, PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!("sbk-update-unit-{}", Uuid::new_v4()));
        let destination = root.join("installed");
        let staging = root.join("new");
        let backup = root.join("previous");
        for path in [&destination, &staging, &backup] {
            fs::create_dir_all(path).unwrap();
        }
        for name in PAYLOAD_ROOTS.iter().copied().chain([INSTALL_MARKER]) {
            fs::write(destination.join(name), b"old").unwrap();
            fs::write(staging.join(name), b"new").unwrap();
        }
        fs::create_dir(destination.join("ProductData")).unwrap();
        fs::write(destination.join("ProductData/keep.db"), b"database").unwrap();
        fs::write(destination.join("setup.exe"), b"keep installer").unwrap();
        fs::write(destination.join(PENDING_MARKER), b"test journal").unwrap();
        (root, destination, staging, backup)
    }

    #[test]
    fn stable_root_keeps_user_data_and_installer_while_replacing_only_program_files() {
        let (root, destination, staging, backup) = fixture();
        replace_roots(&staging, &destination, &backup, &mut rename_checked).unwrap();
        for name in PAYLOAD_ROOTS {
            assert_eq!(fs::read(destination.join(name)).unwrap(), b"new");
        }
        assert_eq!(
            fs::read(destination.join("ProductData/keep.db")).unwrap(),
            b"database"
        );
        assert_eq!(
            fs::read(destination.join("setup.exe")).unwrap(),
            b"keep installer"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn every_single_rename_failure_restores_the_old_program_and_keeps_data() {
        let operations = (PAYLOAD_ROOTS.len() + 1) * 2;
        for fail_at in 0..operations {
            let (root, destination, staging, backup) = fixture();
            let mut count = 0;
            let mut rename = |from: &Path, to: &Path| {
                let fail = count == fail_at;
                count += 1;
                if fail {
                    Err(io::Error::from_raw_os_error(32).to_string())
                } else {
                    rename_checked(from, to)
                }
            };
            assert!(replace_roots(&staging, &destination, &backup, &mut rename).is_err());
            for name in PAYLOAD_ROOTS.iter().copied().chain([INSTALL_MARKER]) {
                assert_eq!(
                    fs::read(destination.join(name)).unwrap(),
                    b"old",
                    "operation {fail_at}, {name}"
                );
            }
            assert_eq!(
                fs::read(destination.join("ProductData/keep.db")).unwrap(),
                b"database"
            );
            assert_eq!(
                fs::read(destination.join("setup.exe")).unwrap(),
                b"keep installer"
            );
            assert!(!destination.join(PENDING_MARKER).exists());
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn failed_rollback_preserves_recovery_files_and_blocks_another_update() {
        let (root, destination, staging, backup) = fixture();
        let mut rename = |from: &Path, to: &Path| {
            if from.starts_with(&staging) || from.starts_with(&backup) {
                Err("synthetic sharing violation".into())
            } else {
                rename_checked(from, to)
            }
        };
        assert!(
            replace_roots(&staging, &destination, &backup, &mut rename)
                .unwrap_err()
                .contains("возврат")
        );
        assert!(backup.join("SBK-Tools-Fast.exe").exists());
        assert!(staging.join("SBK-Tools-Fast.exe").exists());
        assert!(destination.join(PENDING_MARKER).exists());
        assert!(
            check_destination(&destination)
                .unwrap_err()
                .contains("Предыдущее обновление")
        );
        assert_eq!(
            fs::read(destination.join("ProductData/keep.db")).unwrap(),
            b"database"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn partially_blocked_rollback_never_restores_a_launchable_mixed_version() {
        let (root, destination, staging, backup) = fixture();
        let mut rename = |from: &Path, to: &Path| {
            if (from == staging.join("webview2-runtime"))
                || (from == destination.join("scanner-runtime")
                    && to == staging.join("scanner-runtime"))
            {
                Err("synthetic sharing violation".into())
            } else {
                rename_checked(from, to)
            }
        };
        let error = replace_roots(&staging, &destination, &backup, &mut rename).unwrap_err();
        assert!(error.contains("возврат"));
        assert!(!destination.join("SBK-Tools-Fast.exe").exists());
        assert_eq!(fs::read(backup.join("SBK-Tools-Fast.exe")).unwrap(), b"old");
        assert!(destination.join(PENDING_MARKER).exists());
        assert_eq!(
            fs::read(destination.join("ProductData/keep.db")).unwrap(),
            b"database"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn destination_lock_excludes_a_second_installer() {
        let root = std::env::temp_dir().join(format!("sbk-update-lock-unit-{}", Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let destination = root.join("app");
        let first = acquire_install_lock(&destination).unwrap();
        assert!(acquire_install_lock(&destination).is_err());
        drop(first);
        drop(acquire_install_lock(&destination).unwrap());
        fs::remove_dir_all(root).unwrap();
    }
}
