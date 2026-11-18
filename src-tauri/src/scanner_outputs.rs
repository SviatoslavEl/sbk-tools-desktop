//! Narrow, in-memory authority for opening scanner-generated artifacts.
//! This does not expand the generic frontend opener's filesystem scope.
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Default)]
pub(crate) struct ScannerOutputs {
    files: Mutex<HashSet<PathBuf>>,
}

fn canonical_existing(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("Для открытия нужен полный путь к созданному файлу или его папке.".into());
    }
    path.canonicalize().map_err(|_| {
        "Файл или папка недоступны. Проверьте, что результат не перемещён и сетевая папка подключена."
            .into()
    })
}

fn verify_pdf(path: &Path) -> Result<(), String> {
    if !path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("pdf"))
        || !fs::metadata(path).is_ok_and(|metadata| metadata.is_file())
    {
        return Err(
            "Разрешено открывать только созданный сканером PDF, не программу или другой тип файла."
                .into(),
        );
    }
    let mut magic = [0_u8; 5];
    File::open(path)
        .and_then(|mut file| file.read_exact(&mut magic))
        .map_err(|_| {
            "Не удалось проверить созданный PDF: файл недоступен или повреждён.".to_string()
        })?;
    if &magic != b"%PDF-" {
        return Err(
            "Файл больше не является PDF. Открытие отменено; сохраните результат заново.".into(),
        );
    }
    Ok(())
}

fn verify_conversion(path: &Path, format: &str) -> Result<(), String> {
    if format == "pdf" {
        return verify_pdf(path);
    }
    let (extension, signature): (&str, &[u8]) = match format {
        "jpeg" => ("jpg", b"\xff\xd8\xff"),
        "png" => ("png", b"\x89PNG\r\n\x1a\n"),
        _ => return Err("Неизвестный формат конвертации.".into()),
    };
    let mut magic = [0; 8];
    if path.extension().and_then(|value| value.to_str()) != Some(extension)
        || !path.is_file()
        || File::open(path)
            .and_then(|mut file| file.read_exact(&mut magic[..signature.len()]))
            .is_err()
        || &magic[..signature.len()] != signature
    {
        return Err("Результат конвертации недоступен или имеет неверный формат.".into());
    }
    Ok(())
}

impl ScannerOutputs {
    /// Called only after a successful process/merge worker result has passed
    /// protocol, content and digest validation. The worker must have produced
    /// the exact configured destination, not nominated some other existing PDF.
    pub(crate) fn register(&self, requested: &Path, produced: &Path) -> Result<(), String> {
        let requested = canonical_existing(requested)?;
        let produced = canonical_existing(produced)?;
        if requested != produced {
            return Err(
                "Worker вернул PDF не по выбранному пути. Открытие такого результата запрещено."
                    .into(),
            );
        }
        verify_pdf(&produced)?;
        self.files
            .lock()
            .map_err(|_| "Не удалось подтвердить доступ к созданному PDF.".to_string())?
            .insert(produced);
        Ok(())
    }

    pub(crate) fn register_conversion<'a>(
        &self,
        directory: &Path,
        source: &Path,
        format: &str,
        paths: impl Iterator<Item = &'a Path>,
    ) -> Result<(), String> {
        let directory = canonical_existing(directory)?;
        let source = canonical_existing(source)?;
        let mut approved = HashSet::new();
        for path in paths {
            let path = canonical_existing(path)?;
            if path.parent() != Some(&directory) || path == source || approved.contains(&path) {
                return Err("Worker вернул неверный путь результата конвертации.".into());
            }
            verify_conversion(&path, format)?;
            approved.insert(path);
        }
        self.files
            .lock()
            .map_err(|_| "Не удалось подтвердить доступ к результатам конвертации.")?
            .extend(approved);
        Ok(())
    }

    pub(crate) fn resolve(&self, requested: &Path, reveal: bool) -> Result<PathBuf, String> {
        let path = canonical_existing(requested)?;
        let files = self
            .files
            .lock()
            .map_err(|_| "Не удалось проверить доступ к созданному PDF.".to_string())?;
        if files.contains(&path) {
            // Revalidate at the point of opening: an approved filename must
            // not later become an executable, directory, or redirected link.
            match path.extension().and_then(|value| value.to_str()) {
                Some("jpg") => verify_conversion(&path, "jpeg")?,
                Some("png") => verify_conversion(&path, "png")?,
                _ => verify_pdf(&path)?,
            }
            return Ok(path);
        }
        if !reveal && path.is_dir() && files.iter().any(|file| file.parent() == Some(&path)) {
            // Batch/split output buttons may open precisely the directory
            // containing successful outputs, never arbitrary ancestors/trees.
            return Ok(path);
        }
        Err("Этот путь не подтверждён как результат сканера в текущем запуске. Сохраните результат заново, затем откройте его или его папку.".into())
    }
}

pub(crate) fn shell_path(path: &Path) -> Result<String, String> {
    let value = path
        .to_str()
        .ok_or_else(|| "Имя файла нельзя передать системному приложению.".to_string())?;
    // canonicalize on Windows returns verbatim paths. Explorer/PDF file
    // associations expect an ordinary drive or UNC path, not the \\?\ prefix.
    Ok(if let Some(unc) = value.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc}")
    } else if let Some(drive) = value.strip_prefix(r"\\?\") {
        drive.to_string()
    } else {
        value.to_string()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> PathBuf {
        let root = std::env::temp_dir().join(format!("sbk-output-scope-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn pdf(path: &Path) {
        fs::write(path, b"%PDF-1.7\nsynthetic scoped output\n%%EOF").unwrap();
    }

    #[test]
    fn only_successful_exact_outputs_and_their_parent_are_openable() {
        let root = fixture();
        let output = root.join("result.pdf");
        let unrelated = root.join("unrelated.pdf");
        pdf(&output);
        pdf(&unrelated);
        let scope = ScannerOutputs::default();
        assert!(scope.resolve(&output, false).is_err());
        assert!(scope.resolve(&root, false).is_err());
        assert!(scope.register(&output, &unrelated).is_err());
        assert!(scope.resolve(&unrelated, false).is_err());
        scope.register(&output, &output).unwrap();
        assert_eq!(
            scope.resolve(&output, false).unwrap(),
            output.canonicalize().unwrap()
        );
        assert!(scope.resolve(&output, true).is_ok());
        assert_eq!(
            scope.resolve(&root, false).unwrap(),
            root.canonicalize().unwrap()
        );
        assert!(scope.resolve(&root, true).is_err());
        assert!(scope.resolve(root.parent().unwrap(), false).is_err());
        assert!(scope.resolve(&unrelated, false).is_err());
        assert!(scope.resolve(Path::new("result.pdf"), false).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn batch_and_split_register_each_successful_destination_without_recursive_grants() {
        let root = fixture();
        let nested = root.join("nested");
        fs::create_dir(&nested).unwrap();
        let scope = ScannerOutputs::default();
        for name in ["part-1.pdf", "part-2.PDF", "merged.pdf"] {
            let output = root.join(name);
            pdf(&output);
            scope.register(&output, &output).unwrap();
            assert!(scope.resolve(&output, false).is_ok());
        }
        assert!(scope.resolve(&root, false).is_ok());
        assert!(scope.resolve(&nested, false).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn executables_corrupt_replaced_and_missing_files_are_rejected() {
        let root = fixture();
        let executable = root.join("result.exe");
        pdf(&executable);
        let output = root.join("result.pdf");
        let scope = ScannerOutputs::default();
        assert!(scope.register(&executable, &executable).is_err());
        fs::write(&output, b"MZ executable pretending to be PDF").unwrap();
        assert!(scope.register(&output, &output).is_err());
        pdf(&output);
        scope.register(&output, &output).unwrap();
        fs::write(&output, b"MZ replaced file").unwrap();
        assert!(scope.resolve(&output, false).is_err());
        fs::remove_file(&output).unwrap();
        assert!(scope.resolve(&output, false).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn converter_scope_checks_the_format_directory_and_source() {
        let root = fixture();
        let directory = root.join("exports");
        fs::create_dir(&directory).unwrap();
        let source = directory.join("source.png");
        let result = directory.join("result.png");
        let elsewhere = root.join("elsewhere.png");
        for path in [&source, &result, &elsewhere] {
            fs::write(path, b"\x89PNG\r\n\x1a\nsynthetic").unwrap();
        }
        let outputs = ScannerOutputs::default();
        for (path, format) in [(&source, "png"), (&elsewhere, "png"), (&result, "jpeg")] {
            assert!(
                outputs
                    .register_conversion(&directory, &source, format, [path.as_path()].into_iter())
                    .is_err()
            );
        }
        assert!(outputs.resolve(&directory, false).is_err());
        outputs
            .register_conversion(&directory, &source, "png", [result.as_path()].into_iter())
            .unwrap();
        assert!(outputs.resolve(&directory, false).is_ok());
        assert!(outputs.resolve(&source, false).is_err());
        assert!(outputs.resolve(&result, true).is_ok());
        fs::write(&result, b"invalid").unwrap();
        assert!(outputs.resolve(&result, false).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn canonical_aliases_work_but_redirected_symlinks_do_not_expand_scope() {
        use std::os::unix::fs::symlink;
        let root = fixture();
        let output = root.join("result.pdf");
        let unrelated = root.join("private.pdf");
        let alias = root.join("alias.pdf");
        pdf(&output);
        pdf(&unrelated);
        symlink(&output, &alias).unwrap();
        let scope = ScannerOutputs::default();
        scope.register(&alias, &output).unwrap();
        assert!(scope.resolve(&alias, false).is_ok());
        assert!(
            scope
                .resolve(&output.canonicalize().unwrap(), false)
                .is_ok()
        );
        fs::remove_file(&alias).unwrap();
        symlink(&unrelated, &alias).unwrap();
        assert!(scope.resolve(&alias, false).is_err());
        // Replacing the originally registered path with a symlink is denied too.
        fs::remove_file(&output).unwrap();
        symlink(&unrelated, &output).unwrap();
        assert!(scope.resolve(&output, false).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn shell_path_preserves_mac_and_supports_windows_drive_and_unc_paths() {
        assert_eq!(
            shell_path(Path::new("/private/tmp/result.pdf")).unwrap(),
            "/private/tmp/result.pdf"
        );
        assert_eq!(
            shell_path(Path::new(r"\\?\C:\Exports\result.pdf")).unwrap(),
            r"C:\Exports\result.pdf"
        );
        assert_eq!(
            shell_path(Path::new(r"\\?\UNC\server\share\result.pdf")).unwrap(),
            r"\\server\share\result.pdf"
        );
    }
}
