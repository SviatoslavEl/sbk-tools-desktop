//! Binary delivery is restricted to this instance's generated PNG previews.
use std::fs::{self, File};
use std::io::Read;
use std::path::Path;

const MAX_PREVIEW_BYTES: u64 = 24 * 1024 * 1024;

pub fn read(runtime: &Path, path: &Path) -> Result<Vec<u8>, String> {
    let root = runtime
        .join("previews")
        .canonicalize()
        .map_err(|_| "Предпросмотр недоступен")?;
    let candidate = path
        .canonicalize()
        .map_err(|_| "Файл предпросмотра уже удалён")?;
    if candidate.parent() != Some(root.as_path())
        || candidate.extension().and_then(|value| value.to_str()) != Some("png")
        || !fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_file())
    {
        return Err("Разрешены только изображения предпросмотра текущего окна".into());
    }
    let file = File::open(candidate).map_err(|error| error.to_string())?;
    let length = file.metadata().map_err(|error| error.to_string())?.len();
    if length > MAX_PREVIEW_BYTES {
        return Err("Изображение предпросмотра превышает 24 МБ".into());
    }
    let mut bytes = Vec::with_capacity(length as usize);
    file.take(MAX_PREVIEW_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_PREVIEW_BYTES || !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err("Некорректное изображение предпросмотра".into());
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn binary_previews_restrict_paths_format_and_size() {
        let directory =
            std::env::temp_dir().join(format!("sbk-preview-read-{}", uuid::Uuid::new_v4()));
        let runtime = directory.join("instance");
        let previews = runtime.join("previews");
        fs::create_dir_all(&previews).unwrap();
        let png = b"\x89PNG\r\n\x1a\nexample";
        let owned = previews.join("page.png");
        fs::write(&owned, png).unwrap();
        assert_eq!(read(&runtime, &owned).unwrap(), png);
        let external = directory.join("private.png");
        fs::write(&external, png).unwrap();
        assert!(read(&runtime, &external).is_err());
        fs::write(previews.join("wrong.png"), b"not a PNG").unwrap();
        assert!(read(&runtime, &previews.join("wrong.png")).is_err());
        let large = previews.join("large.png");
        File::create(&large)
            .unwrap()
            .set_len(MAX_PREVIEW_BYTES + 1)
            .unwrap();
        assert!(read(&runtime, &large).is_err());
        assert!(read(&runtime, &previews.join("missing.png")).is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&external, previews.join("link.png")).unwrap();
            assert!(read(&runtime, &previews.join("link.png")).is_err());
        }
        fs::remove_dir_all(directory).unwrap();
    }
}
