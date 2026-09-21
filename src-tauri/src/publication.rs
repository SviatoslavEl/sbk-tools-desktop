//! Publish a completed sibling file without replacing an existing destination.
//! Callers own cleanup of their private staging path, including after failure.

use std::path::Path;

#[cfg(target_os = "macos")]
pub(crate) fn publish_no_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    unsafe extern "C" {
        fn renamex_np(
            from: *const std::ffi::c_char,
            to: *const std::ffi::c_char,
            flags: u32,
        ) -> i32;
    }
    let from = CString::new(source.as_os_str().as_bytes())?;
    let to = CString::new(destination.as_os_str().as_bytes())?;
    // RENAME_EXCL: the OS, not a racy exists() check, rejects an occupied name.
    if unsafe { renamex_np(from.as_ptr(), to.as_ptr(), 0x00000004) } == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(windows)]
pub(crate) fn publish_no_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn MoveFileExW(from: *const u16, to: *const u16, flags: u32) -> i32;
    }
    fn wide_path(path: &Path) -> std::io::Result<Vec<u16>> {
        let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
        if wide.contains(&0) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "File path contains a null character",
            ));
        }
        wide.push(0);
        Ok(wide)
    }
    // Canonicalizing the existing file and destination parent gives Win32
    // verbatim drive/UNC paths, preserving long-path support of std::fs.
    let from = wide_path(&source.canonicalize()?)?;
    let name = destination.file_name().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "Missing destination name")
    })?;
    let parent = destination
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let to = wide_path(&parent.canonicalize()?.join(name))?;
    // MOVEFILE_WRITE_THROUGH only; no REPLACE_EXISTING or COPY_ALLOWED.
    // std::fs::rename replaces existing files on Windows and is not suitable.
    if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 0x8) } != 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
pub(crate) fn publish_no_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    std::fs::hard_link(source, destination)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::{Arc, Barrier};
    use uuid::Uuid;

    fn fixture() -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("sbk-publication-{}", Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        root
    }

    #[test]
    fn publication_preserves_existing_file_and_private_stage() {
        let root = fixture();
        let source = root.join("private.part");
        let destination = root.join("finished.zip");
        fs::write(&source, b"new archive").unwrap();
        fs::write(&destination, b"original archive").unwrap();
        assert!(publish_no_replace(&source, &destination).is_err());
        assert_eq!(fs::read(&source).unwrap(), b"new archive");
        assert_eq!(fs::read(&destination).unwrap(), b"original archive");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn publication_race_has_one_complete_winner() {
        let root = fixture();
        let destination = root.join("finished.zip");
        let barrier = Arc::new(Barrier::new(2));
        let workers: Vec<_> = b"AB"
            .iter()
            .copied()
            .map(|byte| {
                let source = root.join(format!("{byte}.part"));
                fs::write(&source, vec![byte; 128 * 1024]).unwrap();
                let destination = destination.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    (byte, publish_no_replace(&source, &destination).is_ok())
                })
            })
            .collect();
        let results: Vec<_> = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect();
        let winners: Vec<_> = results.iter().filter(|(_, success)| *success).collect();
        assert_eq!(winners.len(), 1);
        assert_eq!(
            fs::read(&destination).unwrap(),
            vec![winners[0].0; 128 * 1024]
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn publication_failure_never_consumes_stage_or_creates_parent() {
        let root = fixture();
        let source = root.join("private.part");
        fs::write(&source, b"complete archive").unwrap();
        let missing = root.join("missing");
        assert!(publish_no_replace(&source, &missing.join("result.zip")).is_err());
        assert!(!missing.exists());
        assert_eq!(fs::read(&source).unwrap(), b"complete archive");
        assert!(publish_no_replace(&source, &root).is_err());
        assert_eq!(fs::read(&source).unwrap(), b"complete archive");
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn windows_publication_supports_long_unicode_paths() {
        let root = fixture();
        let mut parent = root.clone();
        for _ in 0..5 {
            parent.push("длинная-папка-коммерческих-предложений-1234567890");
        }
        fs::create_dir_all(&parent).unwrap();
        let source = parent.join("законченный-экспорт.part");
        let destination = parent.join("подбор-документов.zip");
        fs::write(&source, b"complete archive").unwrap();
        publish_no_replace(&source, &destination).unwrap();
        assert_eq!(fs::read(&destination).unwrap(), b"complete archive");
        fs::write(&source, b"another export").unwrap();
        assert!(publish_no_replace(&source, &destination).is_err());
        assert_eq!(fs::read(&destination).unwrap(), b"complete archive");
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn windows_publication_rejects_null_without_truncating_destination() {
        use std::ffi::OsString;
        use std::os::windows::ffi::{OsStrExt, OsStringExt};
        let root = fixture();
        let source = root.join("private.part");
        let destination = root.join("finished.zip");
        fs::write(&source, b"complete archive").unwrap();
        let mut encoded: Vec<_> = destination.as_os_str().encode_wide().collect();
        encoded.extend([0, b'x' as u16]);
        let invalid = std::path::PathBuf::from(OsString::from_wide(&encoded));
        assert_eq!(
            publish_no_replace(&source, &invalid).unwrap_err().kind(),
            std::io::ErrorKind::InvalidInput
        );
        assert!(!destination.exists());
        assert_eq!(fs::read(&source).unwrap(), b"complete archive");
        fs::remove_dir_all(root).unwrap();
    }
}
