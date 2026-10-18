//! Narrow customer-document boundary. Shared records and internal notes never reach the renderer.
use crate::{AppState, Workspace};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::sync::{
    Arc, Mutex, OnceLock,
    atomic::{AtomicBool, Ordering},
    mpsc,
};
use std::time::{Duration, Instant};
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProposalAsset {
    relative_path: String,
    file_name: String,
    size_bytes: u64,
    sha256: String,
    mime_type: String,
}
struct AuthorizedOutput {
    digest: String,
    preview_root: Option<PathBuf>,
}
static OUTPUTS: OnceLock<Mutex<HashMap<PathBuf, AuthorizedOutput>>> = OnceLock::new();
fn outputs() -> &'static Mutex<HashMap<PathBuf, AuthorizedOutput>> {
    OUTPUTS.get_or_init(Default::default)
}
struct PrivateDirectory {
    path: PathBuf,
    keep: bool,
}
impl Drop for PrivateDirectory {
    fn drop(&mut self) {
        if !self.keep {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}
fn object<'a>(
    value: &'a Value,
    required: &str,
    optional: &str,
) -> Result<&'a serde_json::Map<String, Value>, String> {
    let map = value.as_object().ok_or("Некорректная публичная схема КП")?;
    let allowed: HashSet<_> = required
        .split_whitespace()
        .chain(optional.split_whitespace())
        .collect();
    if required
        .split_whitespace()
        .any(|key| !map.contains_key(key))
        || map.keys().any(|key| !allowed.contains(key.as_str()))
    {
        return Err("Экспорт КП отклонён: схема содержит лишние или отсутствующие поля. Внутренние данные в клиентском документе запрещены.".into());
    }
    Ok(map)
}
fn string_fields(value: &Value, names: &str) -> Result<(), String> {
    for key in names.split_whitespace() {
        if !value[key].as_str().is_some_and(|text| {
            text.len() <= 80000
                && !text
                    .chars()
                    .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
        }) {
            return Err(format!("Некорректный текст поля {key} в КП"));
        }
    }
    Ok(())
}
fn asset_schema(value: &Value) -> Result<(), String> {
    object(value, "fileName sizeBytes sha256 mimeType", "")?;
    string_fields(value, "fileName sha256 mimeType")?;
    let hash = value["sha256"].as_str().unwrap_or_default();
    let name = value["fileName"].as_str().unwrap_or_default();
    if hash.len() != 64
        || !hash
            .bytes()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
        || name.is_empty()
        || name.chars().count() > 255
        || name
            .chars()
            .any(|c| r#"/\<>:"|?*"#.contains(c) || c.is_control())
        || matches!(name, "." | "..")
        || value["sizeBytes"]
            .as_u64()
            .is_none_or(|size| size > 512 * 1024 * 1024)
    {
        return Err("Некорректные имя, размер или хеш приложения КП".into());
    }
    Ok(())
}
fn tax_schema(value: &Value) -> Result<(), String> {
    object(value, "kind", "rate")?;
    if value == &json!({"kind":"none"})
        || (value["kind"] == "vat"
            && value["rate"]
                .as_u64()
                .is_some_and(|rate| [0, 5, 7, 10, 11, 20, 22].contains(&rate)))
    {
        Ok(())
    } else {
        Err("Некорректный НДС КП".into())
    }
}
const MAX_PUBLIC_BYTES: usize = 8 * 1024 * 1024;
struct PublicSizeBudget(usize);
impl Write for PublicSizeBudget {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0 = self
            .0
            .checked_add(bytes.len())
            .filter(|size| *size <= MAX_PUBLIC_BYTES)
            .ok_or_else(|| {
                std::io::Error::other("Слишком большой документ КП (более 8 МБ текста)")
            })?;
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
fn commercial_text(value: &Value, required: bool) -> Result<(), String> {
    if value.as_str().is_none_or(|text| {
        text.chars().take(20001).count() > 20000
            || (required && text.trim().is_empty())
            || text
                .chars()
                .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
    }) {
        return Err("Некорректный текст публичного раздела КП".into());
    }
    Ok(())
}
fn commercial_inline(value: &Value, references: &mut Vec<String>) -> Result<(), String> {
    let parts = value
        .as_array()
        .filter(|parts| parts.len() <= 2000)
        .ok_or("Не более 2000 частей текста КП")?;
    for part in parts {
        match part["kind"].as_str() {
            Some("text") => {
                object(part, "kind text", "")?;
                commercial_text(&part["text"], false)?;
            }
            Some("local-ref") => {
                object(part, "kind target", "")?;
                let target = part["target"]
                    .as_str()
                    .filter(|target| target.len() <= 16)
                    .ok_or("Некорректная локальная ссылка КП")?;
                references.push(target.to_owned());
            }
            _ => return Err("Неподдерживаемая часть публичного текста КП".into()),
        }
    }
    Ok(())
}
fn commercial_schema(value: &Value) -> Result<(), String> {
    object(value, "version mode sections unresolved", "")?;
    let mode = value["mode"]
        .as_str()
        .ok_or("Не указан режим документа КП")?;
    if value["version"] != 1 || !matches!(mode, "review-draft" | "final") {
        return Err("Неподдерживаемая версия разделов КП".into());
    }
    let sections = value["sections"]
        .as_array()
        .filter(|items| !items.is_empty() && items.len() <= 64)
        .ok_or("В КП допустимо от 1 до 64 публичных разделов")?;
    let mut anchors = HashSet::new();
    let mut references = Vec::new();
    let mut total_blocks = 0usize;
    for (section_index, section) in sections.iter().enumerate() {
        object(section, "anchor title blocks", "")?;
        let anchor = format!("s{}", section_index + 1);
        if section["anchor"] != anchor {
            return Err("Нарушена последовательность разделов КП".into());
        }
        anchors.insert(anchor.clone());
        commercial_text(&section["title"], true)?;
        let blocks = section["blocks"]
            .as_array()
            .filter(|items| items.len() <= 2000)
            .ok_or("Некорректный состав раздела КП")?;
        total_blocks += blocks.len();
        if total_blocks > 2000 {
            return Err("Не более 2000 блоков в КП".into());
        }
        for (block_index, block) in blocks.iter().enumerate() {
            let block_anchor = format!("{anchor}b{}", block_index + 1);
            if block["anchor"] != block_anchor {
                return Err("Нарушена последовательность блоков КП".into());
            }
            anchors.insert(block_anchor);
            match block["kind"].as_str() {
                Some("paragraph") => {
                    object(block, "anchor kind style content", "")?;
                    if !matches!(
                        block["style"].as_str(),
                        Some("body" | "lead" | "subheading" | "caveat")
                    ) {
                        return Err("Неподдерживаемый стиль абзаца КП".into());
                    }
                    commercial_inline(&block["content"], &mut references)?;
                }
                Some("list") => {
                    object(block, "anchor kind style items", "")?;
                    if !matches!(block["style"].as_str(), Some("bullet" | "ordered")) {
                        return Err("Неподдерживаемый стиль списка КП".into());
                    }
                    let items = block["items"]
                        .as_array()
                        .filter(|items| items.len() <= 2000)
                        .ok_or("В списке КП допустимо до 2000 пунктов")?;
                    for item in items {
                        commercial_inline(item, &mut references)?;
                    }
                }
                Some("table") => {
                    object(block, "anchor kind columns rows", "")?;
                    let columns = block["columns"]
                        .as_array()
                        .filter(|items| !items.is_empty() && items.len() <= 8)
                        .ok_or("В таблице КП допустимо от 1 до 8 столбцов")?;
                    for column in columns {
                        commercial_text(column, true)?;
                    }
                    let rows = block["rows"]
                        .as_array()
                        .filter(|items| items.len() <= 2000)
                        .ok_or("Не более 2000 строк таблицы КП")?;
                    for row in rows {
                        let cells = row
                            .as_array()
                            .filter(|cells| cells.len() == columns.len())
                            .ok_or("Число ячеек не совпадает со столбцами КП")?;
                        for cell in cells {
                            commercial_inline(cell, &mut references)?;
                        }
                    }
                }
                _ => return Err("Неподдерживаемый публичный блок КП".into()),
            }
        }
    }
    if total_blocks == 0 {
        return Err("КП не содержит публичных блоков".into());
    }
    if references.iter().any(|target| !anchors.contains(target)) {
        return Err("Локальная ссылка КП не имеет адресата".into());
    }
    let unresolved = value["unresolved"]
        .as_array()
        .filter(|items| items.len() <= 2000)
        .ok_or("Не более 2000 вопросов для проверки КП")?;
    if mode == "final" && !unresolved.is_empty() {
        return Err("Итоговый документ КП содержит нерешённые вопросы".into());
    }
    for item in unresolved {
        object(item, "section message", "")?;
        if !sections
            .iter()
            .any(|section| section["anchor"] == item["section"])
        {
            return Err("Вопрос КП не имеет публичного раздела".into());
        }
        commercial_text(&item["message"], true)?;
    }
    Ok(())
}
pub(crate) fn validate_public(document: &Value) -> Result<(), String> {
    serde_json::to_writer(&mut PublicSizeBudget(0), document).map_err(|e| e.to_string())?;
    let version = document["schemaVersion"]
        .as_u64()
        .ok_or("Неподдерживаемая версия КП")?;
    let body_field = match version {
        1 => "terms",
        2 => "commercial",
        _ => return Err("Неподдерживаемая версия КП".into()),
    };
    object(
        document,
        &format!(
            "schemaVersion number revision documentDate title validUntil currency issuer recipient addressee contact lines totals {body_field} layout attachments"
        ),
        "signer",
    )?;
    if document["currency"] != "RUB"
        || !document["revision"]
            .as_u64()
            .is_some_and(|r| (1..=100000).contains(&r))
    {
        return Err("Неподдерживаемая версия КП".into());
    }
    string_fields(document, "number documentDate title validUntil")?;
    let date = chrono::NaiveDate::parse_from_str(
        document["documentDate"].as_str().unwrap_or_default(),
        "%Y-%m-%d",
    )
    .map_err(|_| "Некорректная дата КП")?;
    let expires = chrono::NaiveDate::parse_from_str(
        document["validUntil"].as_str().unwrap_or_default(),
        "%Y-%m-%d",
    )
    .map_err(|_| "Некорректный срок действия КП")?;
    if expires < date {
        return Err("Срок действия не может быть раньше даты КП".into());
    }
    for name in ["issuer", "recipient"] {
        let fields = "name shortName inn kpp ogrn address contact paymentDetails";
        object(&document[name], fields, "")?;
        string_fields(&document[name], fields)?;
    }
    for name in ["addressee", "contact", "signer"] {
        if name == "signer" && document.get(name).is_none() {
            continue;
        }
        let fields = if name == "signer" {
            "fullName position phone email basis issuedAt expiresAt"
        } else {
            "fullName position phone email"
        };
        object(&document[name], fields, "")?;
        string_fields(&document[name], fields)?;
    }
    let lines = document["lines"]
        .as_array()
        .filter(|lines| !lines.is_empty() && lines.len() <= 1000)
        .ok_or("В КП допустимо от 1 до 1000 позиций")?;
    for line in lines {
        let fields = "title description unit quantity unitPrice priceBasis discountPercent netMinor vatMinor grossMinor";
        object(line, &format!("{fields} tax"), "")?;
        string_fields(line, fields)?;
        tax_schema(&line["tax"])?;
    }
    object(
        &document["totals"],
        "pricingVersion netMinor vatMinor grossMinor byTax",
        "",
    )?;
    string_fields(
        &document["totals"],
        "pricingVersion netMinor vatMinor grossMinor",
    )?;
    let groups = document["totals"]["byTax"]
        .as_array()
        .filter(|v| v.len() <= 8)
        .ok_or("Некорректная разбивка НДС")?;
    for group in groups {
        object(group, "tax netMinor vatMinor grossMinor", "")?;
        string_fields(group, "netMinor vatMinor grossMinor")?;
        tax_schema(&group["tax"])?;
    }
    if version == 1 {
        object(
            &document["terms"],
            "delivery payment introduction conclusion",
            "",
        )?;
        string_fields(
            &document["terms"],
            "delivery payment introduction conclusion",
        )?;
    } else {
        commercial_schema(&document["commercial"])?;
    }
    object(&document["layout"], "style accentColor show footer", "logo")?;
    string_fields(&document["layout"], "style accentColor footer")?;
    let show = object(
        &document["layout"]["show"],
        "address requisites contact signer",
        "",
    )?;
    if show.values().any(|v| !v.is_boolean()) {
        return Err("Некорректные настройки отображения КП".into());
    }
    if let Some(logo) = document["layout"].get("logo") {
        asset_schema(logo)?;
        if logo["sizeBytes"].as_u64().unwrap_or(u64::MAX) > 5 * 1024 * 1024
            || !matches!(logo["mimeType"].as_str(), Some("image/png" | "image/jpeg"))
        {
            return Err("Логотип должен быть PNG/JPEG до 5 МБ".into());
        }
    }
    let attachments = document["attachments"]
        .as_array()
        .filter(|a| a.len() <= 100)
        .ok_or("Не более 100 приложений КП")?;
    for asset in attachments {
        asset_schema(asset)?;
    }
    Ok(())
}
fn reference_assets(document: &Value) -> Vec<&Value> {
    document["attachments"]
        .as_array()
        .into_iter()
        .flatten()
        .chain(document["layout"].get("logo"))
        .collect()
}
fn stage_assets(
    root: &Path,
    document: &Value,
    assets: &[ProposalAsset],
    directory: &Path,
    cancelled: &AtomicBool,
) -> Result<Vec<Value>, String> {
    if assets.len() > 101 {
        return Err("Слишком много файлов КП".into());
    }
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let refs = reference_assets(document);
    let mut staged = HashMap::new();
    let mut bytes = 0u64;
    for reference in refs {
        let hash = reference["sha256"].as_str().unwrap_or_default();
        if staged.contains_key(hash) {
            continue;
        }
        let asset = assets
            .iter()
            .find(|asset| {
                asset.sha256 == hash
                    && reference["fileName"] == asset.file_name
                    && reference["sizeBytes"] == asset.size_bytes
                    && reference["mimeType"] == asset.mime_type
            })
            .ok_or("Не найдено одно из выбранных вложений КП")?;
        bytes = bytes
            .checked_add(asset.size_bytes)
            .ok_or("Превышен размер вложений")?;
        if bytes > 1024 * 1024 * 1024 {
            return Err("Суммарный размер приложений КП превышает 1 ГБ".into());
        }
        let relative = Path::new(&asset.relative_path);
        let parts: Vec<_> = relative.components().collect();
        if parts.len() < 4
            || !matches!(parts.first(), Some(Component::Normal(part)) if *part == "attachments" || *part == "attachment-staging")
            || parts
                .iter()
                .any(|part| !matches!(part, Component::Normal(_)))
        {
            return Err("КП может использовать только сохранённые вложения общей папки".into());
        }
        let source = root
            .join(relative)
            .canonicalize()
            .map_err(|_| format!("Приложение «{}» недоступно", asset.file_name))?;
        if !source.starts_with(&root) || !source.is_file() {
            return Err("Вложение выходит за пределы общей папки".into());
        }
        let destination = directory.join(hash);
        if fs::metadata(&source).map_err(|e| e.to_string())?.len() != asset.size_bytes {
            return Err(format!(
                "Приложение «{}» изменилось. Выберите его заново",
                asset.file_name
            ));
        }
        let mut input = File::open(source)
            .map_err(|e| e.to_string())?
            .take(asset.size_bytes + 1);
        let mut target = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&destination)
            .map_err(|e| e.to_string())?;
        let mut buffer = vec![0u8; 1024 * 1024];
        loop {
            if cancelled.load(Ordering::SeqCst) {
                return Err("Экспорт КП отменён".into());
            }
            let read = input.read(&mut buffer).map_err(|e| e.to_string())?;
            if read == 0 {
                break;
            }
            target
                .write_all(&buffer[..read])
                .map_err(|e| format!("Не удалось подготовить приложение: {e}"))?;
        }
        drop(target);
        if fs::metadata(&destination).map_err(|e| e.to_string())?.len() != asset.size_bytes
            || crate::sha256_file(&destination)? != hash
        {
            return Err(format!(
                "Хеш приложения «{}» не совпадает. Экспорт отменён",
                asset.file_name
            ));
        }
        staged.insert(hash.to_string(), json!({"sha256":hash,"path":destination}));
    }
    Ok(staged.into_values().collect())
}
fn destination_path(path: &str, format: &str, workspace: &Path) -> Result<PathBuf, String> {
    let target = Path::new(path);
    if !target.is_absolute()
        || target
            .extension()
            .and_then(|s| s.to_str())
            .is_none_or(|s| !s.eq_ignore_ascii_case(format))
    {
        return Err("Выберите полный путь с правильным расширением КП".into());
    }
    let name = target
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("Некорректное имя результата КП")?;
    if name.len() > 220
        || name
            .chars()
            .any(|c| r#"<>:"|?*"#.contains(c) || c.is_control())
        || name.ends_with(['.', ' '])
    {
        return Err("Имя результата слишком длинное или содержит запрещённые символы".into());
    }
    let parent = target
        .parent()
        .ok_or("Выберите папку назначения")?
        .canonicalize()
        .map_err(|_| "Папка назначения недоступна")?;
    let destination = parent.join(name);
    let root = workspace.canonicalize().map_err(|e| e.to_string())?;
    if destination.starts_with(&root) && !destination.starts_with(root.join("exports")) {
        return Err(
            "Не сохраняйте КП внутрь служебных папок базы. Выберите другую папку или папку exports"
                .into(),
        );
    }
    if destination.exists() || fs::symlink_metadata(&destination).is_ok() {
        return Err("Файл с таким именем уже существует. Выберите свободное имя; существующий файл не изменён".into());
    }
    Ok(destination)
}
fn publish(source: &Path, destination: &Path, cancel: &AtomicBool) -> Result<(), String> {
    let parent = destination.parent().ok_or("Некорректный путь результата")?;
    let stage = parent.join(format!(".sbk-proposal-{}.part", Uuid::new_v4()));
    let result = (|| {
        let mut input = File::open(source).map_err(|e| e.to_string())?;
        let mut target = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&stage)
            .map_err(|e| format!("Папка недоступна для записи: {e}"))?;
        let mut buffer = vec![0u8; 1024 * 1024];
        loop {
            if cancel.load(Ordering::SeqCst) {
                return Err("Экспорт КП отменён".into());
            }
            let read = input.read(&mut buffer).map_err(|e| e.to_string())?;
            if read == 0 {
                break;
            }
            target
                .write_all(&buffer[..read])
                .map_err(|e| e.to_string())?;
        }
        target.sync_all().map_err(|e| e.to_string())?;
        drop(target);
        if crate::sha256_file(source)? != crate::sha256_file(&stage)? {
            return Err("Не удалось проверить сохранённый файл КП".into());
        }
        if cancel.load(Ordering::SeqCst) {
            return Err("Экспорт КП отменён".into());
        }
        // Atomic no-clobber publication on the destination filesystem. Do not
        // fall back to rename-overwrite or copy to a visible, incomplete file.
        crate::publication::publish_no_replace(&stage, destination).map_err(|e| format!("Не удалось безопасно опубликовать КП без перезаписи ({e}). Проверьте свободное имя и доступность папки."))?;
        Ok(())
    })();
    let _ = fs::remove_file(stage);
    result
}
fn render_worker(
    app: AppHandle,
    workspace: Arc<Workspace>,
    cancellation: Arc<AtomicBool>,
    document: Value,
    assets: Vec<ProposalAsset>,
    format: String,
    output_path: Option<String>,
) -> Result<Value, String> {
    validate_public(&document)?;
    if !["docx", "pdf", "zip", "preview"].contains(&format.as_str()) {
        return Err("Неподдерживаемый формат КП".into());
    }
    let destination = if format == "preview" {
        None
    } else {
        Some(destination_path(
            output_path
                .as_deref()
                .ok_or("Не выбран путь результата КП")?,
            &format,
            &workspace.root,
        )?)
    };
    let parent = workspace.runtime_root().join("proposal-jobs");
    fs::create_dir_all(&parent).map_err(|e| e.to_string())?;
    let mut directory = PrivateDirectory {
        path: parent.join(Uuid::new_v4().to_string()),
        keep: false,
    };
    fs::create_dir(&directory.path).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&directory.path, fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
    }
    directory.path = directory.path.canonicalize().map_err(|e| e.to_string())?;
    let asset_directory = directory.path.join("assets");
    fs::create_dir(&asset_directory).map_err(|e| e.to_string())?;
    let asset_files = stage_assets(
        &workspace.root,
        &document,
        &assets,
        &asset_directory,
        &cancellation,
    )?;
    if cancellation.load(Ordering::SeqCst) {
        return Err("Экспорт КП отменён".into());
    }
    let config = directory.path.join("config.json");
    fs::write(&config, serde_json::to_vec(&json!({"document":document,"assets":asset_files,"format":format,"workdir":directory.path})).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let (mut command, packaged) = crate::scanner_worker_command()?;
    if let Some(runtime) = crate::scanner_runtime_root(&app) {
        if packaged {
            crate::verify_packaged_runtime(Path::new(command.get_program()), &runtime)?;
        }
        command.env("SCANDOCUMENT_RESOURCE_ROOT", runtime);
    } else if packaged {
        return Err("Встроенные компоненты подготовки КП не найдены".into());
    }
    command
        .arg("proposal")
        .arg("--config")
        .arg(&config)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("PYTHONDONTWRITEBYTECODE", "1");
    crate::configure_scanner_process_group(&mut command);
    let mut child = command
        .spawn()
        .map_err(|e| format!("Не удалось запустить подготовку КП: {e}"))?;
    let (Some(stdout), Some(stderr)) = (child.stdout.take(), child.stderr.take()) else {
        crate::terminate_scanner_tree(&mut child);
        let _ = child.wait();
        return Err("Нет каналов ответа модуля КП".into());
    };
    let (sender, receiver) = mpsc::channel();
    let stdout_thread = std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let _ = sender.send(line);
        }
    });
    let stderr_thread = std::thread::spawn(move || {
        let mut reader = BufReader::new(stderr);
        let _ = std::io::copy(&mut reader, &mut std::io::sink());
    });
    let started = Instant::now();
    let mut complete = None;
    let mut error = None;
    loop {
        if cancellation.load(Ordering::SeqCst) || started.elapsed() > Duration::from_secs(900) {
            // Office runs in its own process group; let the worker stop that
            // group cooperatively before the forced worker-tree fallback.
            let _ = fs::write(directory.path.join("cancel.requested"), b"cancel");
            let deadline = Instant::now() + Duration::from_secs(4);
            while Instant::now() < deadline {
                if child.try_wait().ok().flatten().is_some() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(40));
            }
            crate::terminate_scanner_tree(&mut child);
            let _ = child.wait();
            let _ = stdout_thread.join();
            let _ = stderr_thread.join();
            return Err(if cancellation.load(Ordering::SeqCst) {
                "Экспорт КП отменён"
            } else {
                "Превышено время подготовки КП"
            }
            .into());
        }
        for line in receiver.try_iter() {
            if let Ok(event) = serde_json::from_str::<Value>(&line) {
                if event["type"] == "complete" {
                    complete = Some(event);
                } else if event["type"] == "error" {
                    error = Some(
                        event["message"]
                            .as_str()
                            .unwrap_or("Не удалось создать КП")
                            .to_string(),
                    );
                }
            }
        }
        let status = match child.try_wait() {
            Ok(status) => status,
            Err(error) => {
                crate::terminate_scanner_tree(&mut child);
                let _ = child.wait();
                let _ = stdout_thread.join();
                let _ = stderr_thread.join();
                return Err(error.to_string());
            }
        };
        match status {
            Some(status) => {
                // stdout may reach EOF just after the process exits.
                for line in receiver.iter() {
                    if let Ok(event) = serde_json::from_str::<Value>(&line) {
                        if event["type"] == "complete" {
                            complete = Some(event);
                        } else if event["type"] == "error" {
                            error = Some(
                                event["message"]
                                    .as_str()
                                    .unwrap_or("Не удалось создать КП")
                                    .to_string(),
                            );
                        }
                    }
                }
                let _ = stdout_thread.join();
                let _ = stderr_thread.join();
                if !status.success() || error.is_some() {
                    return Err(
                        error.unwrap_or_else(|| "Модуль подготовки КП завершился с ошибкой".into())
                    );
                }
                break;
            }
            None => std::thread::sleep(Duration::from_millis(60)),
        }
    }
    let mut event = complete.ok_or("Модуль КП не подтвердил готовность документа")?;
    let expected = directory.path.join(format!(
        "proposal.{}",
        if format == "preview" { "pdf" } else { &format }
    ));
    if event["outputPath"].as_str() != expected.to_str() || !expected.is_file() {
        return Err("Модуль КП вернул неожиданный путь результата".into());
    }
    let digest = crate::sha256_file(&expected)?;
    let bytes = fs::metadata(&expected).map_err(|e| e.to_string())?.len();
    if bytes == 0 || event["sha256"] != digest || event["outputBytes"].as_u64() != Some(bytes) {
        return Err("Итоговый файл КП не прошёл проверку целостности".into());
    }
    let final_path = if let Some(destination) = destination {
        publish(&expected, &destination, &cancellation)?;
        destination
    } else {
        let pages = event["previewPages"]
            .as_array()
            .ok_or("Предпросмотр КП не содержит страниц")?;
        if pages.is_empty()
            || pages.len() > 2000
            || event["pageCount"].as_u64() != Some(pages.len() as u64)
        {
            return Err("Некорректные страницы предпросмотра КП".into());
        }
        for (index, page) in pages.iter().enumerate() {
            let path = directory.path.join(format!("page-{}.png", index + 1));
            if page.as_str() != path.to_str() || !path.is_file() {
                return Err("Некорректный путь страницы предпросмотра КП".into());
            }
        }
        // Keep only customer PDF and raster pages, not config/private source assets.
        let _ = fs::remove_file(&config);
        let _ = fs::remove_dir_all(&asset_directory);
        let _ = fs::remove_dir_all(directory.path.join("office"));
        let _ = fs::remove_file(directory.path.join("proposal.docx"));
        let _ = fs::remove_file(directory.path.join("logo-clean.png"));
        expected
    };
    let canonical = final_path.canonicalize().map_err(|e| e.to_string())?;
    outputs()
        .lock()
        .map_err(|_| "Не удалось зарегистрировать результат КП")?
        .insert(
            canonical.clone(),
            AuthorizedOutput {
                digest,
                preview_root: if format == "preview" {
                    Some(directory.path.clone())
                } else {
                    None
                },
            },
        );
    directory.keep = format == "preview";
    event["outputPath"] = json!(canonical);
    event.as_object_mut().unwrap().remove("type");
    Ok(event)
}

#[tauri::command]
pub(crate) async fn proposal_render(
    app: AppHandle,
    state: State<'_, AppState>,
    job_id: String,
    document: Value,
    assets: Vec<ProposalAsset>,
    format: String,
    output_path: Option<String>,
) -> Result<Value, String> {
    let operation_permit = crate::network_diagnostics::enter_operation()?;
    let workspace = state.active_workspace()?;
    Uuid::parse_str(&job_id).map_err(|_| "Некорректный идентификатор задачи КП")?;
    let jobs = state.scanner_jobs.clone();
    let cancellation = Arc::new(AtomicBool::new(false));
    {
        let mut guard = jobs
            .lock()
            .map_err(|_| "Не удалось зарегистрировать задачу КП")?;
        if guard.contains_key(&job_id) {
            return Err("Эта задача уже выполняется".into());
        }
        guard.insert(job_id.clone(), cancellation.clone());
    }
    // A pause can begin after admission but before this job joins the registry.
    if !crate::network_diagnostics::gate().connected() {
        cancellation.store(true, Ordering::SeqCst);
    }
    tauri::async_runtime::spawn_blocking(move || {
        let _operation_permit = operation_permit;
        let diagnostic = crate::diagnostics::begin(crate::diagnostics::Operation::Scanner);
        let result = render_worker(
            app,
            workspace,
            cancellation,
            document,
            assets,
            format,
            output_path,
        );
        if let Ok(mut guard) = jobs.lock() {
            guard.remove(&job_id);
        }
        diagnostic.result(&result);
        result
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub(crate) fn proposal_cleanup_preview(output_path: String) -> Result<(), String> {
    let _operation_permit = crate::network_diagnostics::enter_operation()?;
    let path = PathBuf::from(output_path);
    let mut registry = outputs()
        .lock()
        .map_err(|_| "Не удалось проверить предпросмотр КП")?;
    let entry = registry
        .get(&path)
        .ok_or("Этот предпросмотр не принадлежит текущему запуску")?;
    let root = entry
        .preview_root
        .as_ref()
        .ok_or("Нельзя удалить экспортированный документ этой командой")?;
    fs::remove_dir_all(root).map_err(|e| e.to_string())?;
    registry.remove(&path);
    Ok(())
}
#[tauri::command]
pub(crate) fn proposal_open_output(
    app: AppHandle,
    path: String,
    reveal: Option<bool>,
) -> Result<(), String> {
    let _operation_permit = crate::network_diagnostics::enter_operation()?;
    let path = PathBuf::from(path)
        .canonicalize()
        .map_err(|_| "Результат КП недоступен")?;
    let registry = outputs()
        .lock()
        .map_err(|_| "Не удалось проверить результат КП")?;
    let entry = registry
        .get(&path)
        .ok_or("Этот файл не создан экспортом КП в текущем запуске")?;
    if crate::sha256_file(&path)? != entry.digest {
        return Err("Файл изменился после экспорта. Открытие отменено".into());
    }
    if reveal.unwrap_or(true) {
        app.opener()
            .reveal_item_in_dir(&path)
            .map_err(|e| e.to_string())
    } else {
        app.opener()
            .open_path(crate::scanner_outputs::shell_path(&path)?, None::<&str>)
            .map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn public_fixture(version: u64) -> Value {
        let party = json!({"name":"Компания","shortName":"","inn":"","kpp":"","ogrn":"","address":"","contact":"","paymentDetails":""});
        let contact = json!({"fullName":"","position":"","phone":"","email":""});
        let mut value = json!({
            "schemaVersion":version,"number":"КП-1","revision":1,"documentDate":"2030-01-01","title":"Предложение","validUntil":"2030-02-01","currency":"RUB",
            "issuer":party,"recipient":party,"addressee":contact,"contact":contact,
            "lines":[{"title":"Услуга","description":"","unit":"комплекс","quantity":"1","unitPrice":"100","priceBasis":"net","discountPercent":"0","tax":{"kind":"none"},"netMinor":"10000","vatMinor":"0","grossMinor":"10000"}],
            "totals":{"pricingVersion":"proposal-pricing/1","netMinor":"10000","vatMinor":"0","grossMinor":"10000","byTax":[{"tax":{"kind":"none"},"netMinor":"10000","vatMinor":"0","grossMinor":"10000"}]},
            "layout":{"style":"standard","accentColor":"#245C48","show":{"address":true,"requisites":true,"contact":true,"signer":true},"footer":""},"attachments":[]
        });
        if version == 1 {
            value["terms"] = json!({"delivery":"","payment":"","introduction":"","conclusion":""});
        } else {
            value["commercial"] = json!({"version":1,"mode":"final","sections":[{"anchor":"s1","title":"Состав","blocks":[
                {"anchor":"s1b1","kind":"paragraph","style":"body","content":[{"kind":"text","text":"Объём работ: "},{"kind":"local-ref","target":"s1b2"}]},
                {"anchor":"s1b2","kind":"list","style":"ordered","items":[[{"kind":"text","text":"Передача результата"}]]},
                {"anchor":"s1b3","kind":"table","columns":["Результат","Срок"],"rows":[[[{"kind":"text","text":"Отчёт"}],[{"kind":"local-ref","target":"s1"}]]]}
            ]}],"unresolved":[]});
        }
        value
    }
    #[test]
    fn public_versions_keep_disjoint_closed_bodies() {
        for version in [1, 2] {
            assert!(validate_public(&public_fixture(version)).is_ok());
        }
        let mut v1 = public_fixture(1);
        v1["commercial"] = public_fixture(2)["commercial"].clone();
        assert!(validate_public(&v1).is_err());
        let mut v2 = public_fixture(2);
        v2["terms"] = public_fixture(1)["terms"].clone();
        assert!(validate_public(&v2).is_err());
    }
    #[test]
    fn commercial_rejects_private_keys_bad_anchors_and_foreign_refs() {
        let mut v2 = public_fixture(2);
        v2["commercial"]["sections"][0]["blocks"][0]["sourceId"] = json!("private-source");
        assert!(validate_public(&v2).is_err());
        for anchor in [
            "source-clause",
            "s01",
            "s2",
            "https://example.org",
            "s1\" onclick",
        ] {
            let mut invalid = public_fixture(2);
            invalid["commercial"]["sections"][0]["anchor"] = json!(anchor);
            assert!(validate_public(&invalid).is_err());
        }
        let mut dangling = public_fixture(2);
        dangling["commercial"]["sections"][0]["blocks"][0]["content"][1]["target"] = json!("s2b1");
        assert!(validate_public(&dangling).is_err());
        let mut remote = public_fixture(2);
        remote["commercial"]["sections"][0]["blocks"][0]["content"][1]["url"] =
            json!("https://example.org");
        assert!(validate_public(&remote).is_err());
    }
    #[test]
    fn commercial_review_questions_are_section_bound_and_never_final() {
        let mut value = public_fixture(2);
        value["commercial"]["unresolved"] = json!([{"section":"s1","message":"Уточнить срок"}]);
        assert!(validate_public(&value).is_err());
        value["commercial"]["mode"] = json!("review-draft");
        assert!(validate_public(&value).is_ok());
        value["commercial"]["unresolved"][0]["section"] = json!("s1b1");
        assert!(validate_public(&value).is_err());
        value["commercial"]["unresolved"] =
            json!([{"sectionTitle":"Состав","message":"Уточнить срок"}]);
        assert!(validate_public(&value).is_err());
    }
    #[test]
    fn commercial_validates_text_shape_and_global_size_early() {
        let mut value = public_fixture(2);
        value["commercial"]["sections"][0]["title"] = json!("я".repeat(20000));
        assert!(validate_public(&value).is_ok());
        value["commercial"]["sections"][0]["title"] = json!("я".repeat(20001));
        assert!(validate_public(&value).is_err());
        let mut value = public_fixture(2);
        value["commercial"]["sections"][0]["blocks"][2]["rows"][0] = json!([]);
        assert!(validate_public(&value).is_err());
        let mut value = public_fixture(2);
        value["commercial"]["sections"][0]["blocks"][0]["content"] =
            json!(vec![json!({"kind":"text","text":"x".repeat(20000)}); 500]);
        assert!(validate_public(&value).unwrap_err().contains("8 МБ"));
        let mut value = public_fixture(2);
        value["commercial"]["sections"][0]["blocks"] = json!([]);
        assert!(validate_public(&value).is_err());
    }
    #[test]
    fn commercial_container_limits_accept_the_boundary_but_not_the_next_item() {
        for count in [2000, 2001] {
            let mut value = public_fixture(2);
            value["commercial"]["sections"][0]["blocks"] = json!((1..=count).map(|index| json!({"anchor":format!("s1b{index}"),"kind":"paragraph","style":"body","content":[]})).collect::<Vec<_>>());
            assert_eq!(validate_public(&value).is_ok(), count == 2000);
            let mut value = public_fixture(2);
            value["commercial"]["sections"][0]["blocks"][0]["content"] =
                json!(vec![json!({"kind":"text","text":""}); count]);
            assert_eq!(validate_public(&value).is_ok(), count == 2000);
            let mut value = public_fixture(2);
            value["commercial"]["sections"][0]["blocks"][1]["items"] =
                json!(vec![json!([]); count]);
            assert_eq!(validate_public(&value).is_ok(), count == 2000);
            let mut value = public_fixture(2);
            value["commercial"]["sections"][0]["blocks"][2]["rows"] =
                json!(vec![json!([[], []]); count]);
            assert_eq!(validate_public(&value).is_ok(), count == 2000);
        }
        for count in [64, 65] {
            let mut value = public_fixture(2);
            value["commercial"]["sections"] = json!((1..=count).map(|index| json!({"anchor":format!("s{index}"),"title":"Раздел","blocks":[{"anchor":format!("s{index}b1"),"kind":"paragraph","style":"body","content":[]}]})).collect::<Vec<_>>());
            assert_eq!(validate_public(&value).is_ok(), count == 64);
        }
        for count in [8, 9] {
            let mut value = public_fixture(2);
            value["commercial"]["sections"][0]["blocks"][2]["columns"] =
                json!(vec!["Столбец"; count]);
            value["commercial"]["sections"][0]["blocks"][2]["rows"] = json!([]);
            assert_eq!(validate_public(&value).is_ok(), count == 8);
        }
    }
    fn fixture_root() -> PathBuf {
        let root = std::env::temp_dir().join(format!("proposal-test-{}", Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        root
    }
    #[test]
    fn concurrent_publish_has_exactly_one_complete_winner() {
        let root = fixture_root();
        let destination = root.join("result.docx");
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let handles: Vec<_> = ["first", "second"]
            .into_iter()
            .map(|content| {
                let source = root.join(format!("{content}.docx"));
                fs::write(&source, content.repeat(10000)).unwrap();
                let destination = destination.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    publish(&source, &destination, &AtomicBool::new(false))
                })
            })
            .collect();
        // Both publishers were allowed to start together; the OS owns the
        // no-replace decision, not a racy exists-then-rename check.
        let results: Vec<_> = handles
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .collect();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        let content = fs::read_to_string(&destination).unwrap();
        assert!(content == "first".repeat(10000) || content == "second".repeat(10000));
        assert_eq!(fs::read_dir(&root).unwrap().count(), 3);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn attachments_are_scoped_checked_and_copied_not_mutated() {
        let root = fixture_root();
        let stage = root.join("stage");
        fs::create_dir(&stage).unwrap();
        let relative = "attachments/contracts/record/public.txt";
        let source = root.join(relative);
        fs::create_dir_all(source.parent().unwrap()).unwrap();
        fs::write(&source, "public").unwrap();
        let hash = crate::sha256_file(&source).unwrap();
        let document = json!({"attachments":[{"fileName":"public.txt","sizeBytes":6,"sha256":hash,"mimeType":"text/plain"}],"layout":{}});
        let mut assets = vec![ProposalAsset {
            relative_path: relative.into(),
            file_name: "public.txt".into(),
            size_bytes: 6,
            sha256: hash.clone(),
            mime_type: "text/plain".into(),
        }];
        assert_eq!(
            stage_assets(&root, &document, &assets, &stage, &AtomicBool::new(false))
                .unwrap()
                .len(),
            1
        );
        assert_eq!(fs::read_to_string(&source).unwrap(), "public");
        assets[0].relative_path = "../outside.txt".into();
        assert!(stage_assets(&root, &document, &assets, &stage, &AtomicBool::new(false)).is_err());
        assets[0].relative_path = relative.into();
        fs::write(&source, "SECRET").unwrap();
        let second_stage = root.join("second-stage");
        fs::create_dir(&second_stage).unwrap();
        assert!(
            stage_assets(
                &root,
                &document,
                &assets,
                &second_stage,
                &AtomicBool::new(false)
            )
            .unwrap_err()
            .contains("Хеш")
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn attachment_symlink_cannot_escape_workspace() {
        let root = fixture_root();
        let outside = root.join("outside.txt");
        fs::write(&outside, "secret").unwrap();
        let workspace = root.join("workspace");
        let attachment = workspace.join("attachments/contracts/record/link.txt");
        fs::create_dir_all(attachment.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(&outside, &attachment).unwrap();
        let stage = root.join("stage");
        fs::create_dir(&stage).unwrap();
        let hash = crate::sha256_file(&outside).unwrap();
        let document = json!({"attachments":[{"fileName":"link.txt","sizeBytes":6,"sha256":hash,"mimeType":"text/plain"}],"layout":{}});
        let assets = vec![ProposalAsset {
            relative_path: "attachments/contracts/record/link.txt".into(),
            file_name: "link.txt".into(),
            size_bytes: 6,
            sha256: hash,
            mime_type: "text/plain".into(),
        }];
        assert!(
            stage_assets(
                &workspace,
                &document,
                &assets,
                &stage,
                &AtomicBool::new(false)
            )
            .unwrap_err()
            .contains("пределы")
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn publish_never_replaces_existing_destination() {
        let root = std::env::temp_dir().join(format!("proposal-test-{}", Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let source = root.join("source.docx");
        let destination = root.join("result.docx");
        fs::write(&source, "new").unwrap();
        fs::write(&destination, "original").unwrap();
        assert!(publish(&source, &destination, &AtomicBool::new(false)).is_err());
        assert_eq!(fs::read_to_string(&destination).unwrap(), "original");
        assert_eq!(fs::read_dir(&root).unwrap().count(), 2);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn cancellation_leaves_no_visible_partial_result() {
        let root = std::env::temp_dir().join(format!("proposal-test-{}", Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let source = root.join("source.pdf");
        let destination = root.join("result.pdf");
        fs::write(&source, "data").unwrap();
        assert!(publish(&source, &destination, &AtomicBool::new(true)).is_err());
        assert!(!destination.exists());
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn closed_schema_rejects_private_fields() {
        assert!(
            object(
                &json!({"name":"public","internalNote":"secret"}),
                "name",
                ""
            )
            .is_err()
        );
        assert!(asset_schema(&json!({"fileName":"public.pdf","sizeBytes":1,"sha256":"a".repeat(64),"mimeType":"application/pdf","relativePath":"secret"})).is_err());
    }
}
