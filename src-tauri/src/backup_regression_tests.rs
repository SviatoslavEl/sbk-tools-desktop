use super::*;
use crate::workspace::ensure_workspace;

fn fixture(label: &str) -> (PathBuf, Workspace) {
    let root = std::env::temp_dir().join(format!("sbk-backup-{label}-{}", Uuid::new_v4()));
    ensure_workspace(&root).unwrap();
    let workspace = Workspace::for_test(root.clone(), true);
    (root, workspace)
}

#[test]
fn older_workspace_new_module_read_is_empty_without_creating_or_migrating_anything() {
    let (root, workspace) = fixture("optional-module");
    fs::remove_dir(root.join("commercial-proposals")).unwrap();
    for module in MODULES
        .into_iter()
        .filter(|module| *module != "commercial-proposals")
    {
        drop(open_database(&root, module).unwrap());
    }
    let before = snapshot(&root);
    assert!(validate_workspace_layout(&root).is_ok());
    assert!(
        open_optional_database_read_only(&root, "commercial-proposals")
            .unwrap()
            .is_none()
    );
    // Validate the same read-only module loop used at startup.
    for module in MODULES {
        let _ = open_optional_database_read_only(&root, module).unwrap();
    }
    assert_eq!(snapshot(&root), before);
    assert!(!root.join("commercial-proposals").exists());
    assert!(
        open_optional_database_read_only(&root.join("offline"), "commercial-proposals").is_err()
    );
    assert!(open_optional_database_read_only(&root, "invalid-module").is_err());
    // Initialization adds only the new module, leaving all old DB bytes intact.
    initialize_module(&root, "commercial-proposals").unwrap();
    assert!(
        open_optional_database_read_only(&root, "commercial-proposals")
            .unwrap()
            .is_some()
    );
    for (path, bytes) in before {
        assert_eq!(snapshot_file(&root, &root.join(path)).unwrap(), bytes);
    }
    drop(workspace);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn malformed_optional_module_is_not_treated_as_a_missing_old_module() {
    let (root, workspace) = fixture("optional-corrupt");
    fs::write(
        root.join("commercial-proposals/data.sqlite3"),
        b"not sqlite",
    )
    .unwrap();
    let invalid = open_optional_database_read_only(&root, "commercial-proposals")
        .unwrap()
        .expect("present corrupt database must not become empty optional data");
    assert!(
        invalid
            .query_row("SELECT COUNT(*) FROM records", [], |row| row
                .get::<_, i64>(0))
            .is_err()
    );
    drop(invalid);
    fs::remove_file(root.join("commercial-proposals/data.sqlite3")).unwrap();
    fs::remove_dir(root.join("commercial-proposals")).unwrap();
    fs::write(root.join("commercial-proposals"), b"not a directory").unwrap();
    assert!(open_optional_database_read_only(&root, "commercial-proposals").is_err());
    drop(workspace);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn seven_module_backup_restores_old_records_without_removing_new_module_data() {
    let (root, workspace) = fixture("legacy-seven");
    let legacy: Vec<String> = MODULES
        .into_iter()
        .filter(|module| *module != "commercial-proposals")
        .map(str::to_owned)
        .collect();
    assert_eq!(legacy.len(), 7);
    let mut files = BTreeMap::new();
    for module in MODULES {
        let connection = open_database(&root, module).unwrap();
        connection.execute("INSERT INTO records(id,title,payload,created_at,updated_at) VALUES ('qa','Original','{}','then','then')", []).unwrap();
    }
    let path = root.join("old-seven.sbkbackup");
    let mut zip = zip::ZipWriter::new(File::create(&path).unwrap());
    for module in &legacy {
        let relative = format!("{module}/data.sqlite3");
        let source = root.join(&relative);
        files.insert(
            relative.clone(),
            BackupFileMeta {
                size_bytes: fs::metadata(&source).unwrap().len(),
                sha256: sha256_file(&source).unwrap(),
            },
        );
        zip.start_file(relative, SimpleFileOptions::default())
            .unwrap();
        zip.write_all(&fs::read(source).unwrap()).unwrap();
    }
    let manifest = BackupManifest {
        product: "sbk-tools-desktop".into(),
        backup_format_version: 2,
        schema_version: SCHEMA_VERSION,
        created_at: Utc::now().to_rfc3339(),
        modules: legacy.clone(),
        files,
    };
    zip.start_file("manifest.json", SimpleFileOptions::default())
        .unwrap();
    zip.write_all(&serde_json::to_vec(&manifest).unwrap())
        .unwrap();
    zip.finish().unwrap();
    validate_backup_container(&path).unwrap();
    for module in MODULES {
        let connection = open_database(&root, module).unwrap();
        connection
            .execute("UPDATE records SET title='Changed'", [])
            .unwrap();
    }
    let proposal_before = fs::read(root.join("commercial-proposals/data.sqlite3")).unwrap();
    restore_backup_impl(&workspace, &path).unwrap();
    for module in &legacy {
        let connection = open_database_read_only(&root, module).unwrap();
        let title: String = connection
            .query_row("SELECT title FROM records WHERE id='qa'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(title, "Original");
    }
    assert_eq!(
        fs::read(root.join("commercial-proposals/data.sqlite3")).unwrap(),
        proposal_before
    );
    assert!(fs::read_dir(root.join("backups")).unwrap().any(|entry| {
        entry
            .unwrap()
            .path()
            .extension()
            .is_some_and(|ext| ext == "sbkbackup")
    }));
    drop(workspace);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn damaged_or_unreadable_pins_abort_rotation_without_deleting_any_backup() {
    for broken_directory in [false, true] {
        let (root, workspace) = fixture("pins");
        let backups = root.join("backups");
        let names: HashSet<String> = ["a.sbkbackup", "b.sbkbackup", "c.sbkbackup"]
            .into_iter()
            .map(String::from)
            .collect();
        for name in &names {
            fs::write(backups.join(name), b"synthetic").unwrap();
        }
        write_pinned_backups(&root, &names).unwrap();
        assert_eq!(pinned_backups(&root).unwrap(), names);
        if broken_directory {
            fs::remove_file(backups.join("pinned.json")).unwrap();
            fs::create_dir(backups.join("pinned.json")).unwrap();
        } else {
            fs::write(backups.join("pinned.json"), b"[").unwrap();
        }
        assert!(rotate_backups_impl(&root, 1, 3650).is_err());
        for name in &names {
            assert_eq!(fs::read(backups.join(name)).unwrap(), b"synthetic");
        }
        drop(workspace);
        fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn absent_pins_are_allowed_only_in_a_readable_existing_backup_directory() {
    let (root, workspace) = fixture("missing-pins");
    assert!(pinned_backups(&root).unwrap().is_empty());
    fs::remove_dir(root.join("backups")).unwrap();
    assert!(pinned_backups(&root).is_err());
    drop(workspace);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn every_backup_budget_rejects_creation_before_publication() {
    let limits = [
        BackupLimits {
            entries: 1,
            ..BACKUP_LIMITS
        },
        BackupLimits {
            file_bytes: 1,
            ..BACKUP_LIMITS
        },
        BackupLimits {
            unpacked_bytes: 1,
            ..BACKUP_LIMITS
        },
        BackupLimits {
            manifest_bytes: 1,
            ..BACKUP_LIMITS
        },
        BackupLimits {
            archive_bytes: 1,
            ..BACKUP_LIMITS
        },
        BackupLimits {
            compression_ratio: 1,
            ..BACKUP_LIMITS
        },
    ];
    for (index, limit) in limits.into_iter().enumerate() {
        let (root, workspace) = fixture(&format!("budget-{index}"));
        assert!(
            create_backup_with_limits(&workspace, Some("staff".into()), limit).is_err(),
            "budget {index}"
        );
        assert_eq!(
            fs::read_dir(root.join("backups")).unwrap().count(),
            0,
            "failed backup or plaintext partial leaked"
        );
        drop(workspace);
        fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn generated_backup_passes_the_same_gate_used_by_verify_and_restore() {
    let (root, workspace) = fixture("valid");
    let connection = open_database(&root, "staff").unwrap();
    connection.execute("INSERT INTO records(id,title,payload,created_at,updated_at) VALUES ('qa','QA','{}','now','now')", []).unwrap();
    drop(connection);
    let backup = create_backup_impl(&workspace, Some("staff".into())).unwrap();
    let path = Path::new(&backup.path);
    validate_backup_container(path).unwrap();
    // The identical container is rejected consistently for each narrower budget.
    for limit in [
        BackupLimits {
            entries: 1,
            ..BACKUP_LIMITS
        },
        BackupLimits {
            file_bytes: 1,
            ..BACKUP_LIMITS
        },
        BackupLimits {
            unpacked_bytes: 1,
            ..BACKUP_LIMITS
        },
        BackupLimits {
            manifest_bytes: 1,
            ..BACKUP_LIMITS
        },
        BackupLimits {
            archive_bytes: 1,
            ..BACKUP_LIMITS
        },
        BackupLimits {
            compression_ratio: 1,
            ..BACKUP_LIMITS
        },
    ] {
        assert!(validate_backup_container_with_limits(path, limit).is_err());
    }
    drop(workspace);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn budget_boundaries_are_inclusive_and_zero_compressed_size_is_not_a_bypass() {
    let limits = BackupLimits {
        archive_bytes: 100,
        unpacked_bytes: 10,
        file_bytes: 6,
        manifest_bytes: 10,
        entries: 2,
        compression_ratio: 2,
    };
    assert!(limits.entries(2).is_ok());
    assert!(limits.entries(3).is_err());
    let mut total = 0;
    limits.add_file(&mut total, 6, Some(3)).unwrap();
    limits.add_file(&mut total, 4, Some(2)).unwrap();
    assert!(limits.add_file(&mut total, 1, Some(1)).is_err());
    assert!(limits.add_file(&mut 0, 7, None).is_err());
    assert!(limits.add_file(&mut 0, 1, Some(0)).is_err());
    assert!(limits.add_file(&mut 0, 0, Some(0)).is_ok());
    let mut maximum = u64::MAX;
    assert!(limits.add_file(&mut maximum, 1, None).is_err());
}

#[cfg(windows)]
fn is_snapshot_lock_path(relative: &Path) -> bool {
    if relative == Path::new(".workspace.edit.lock")
        || relative == Path::new(".workspace.edit.guard")
    {
        return true;
    }
    let parts: Vec<_> = relative.components().collect();
    parts.len() == 3
        && parts[0].as_os_str() == "runtime-cache"
        && parts[2].as_os_str() == ".instance.lock"
        && parts[1]
            .as_os_str()
            .to_str()
            .and_then(|name| name.strip_prefix("instance-"))
            .is_some_and(|id| Uuid::parse_str(id).is_ok())
}

#[cfg(windows)]
fn read_locked_snapshot_file(path: &Path) -> std::io::Result<Vec<u8>> {
    use std::ffi::c_void;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateFileMappingW(
            file: *mut c_void,
            attributes: *const c_void,
            protection: u32,
            maximum_size_high: u32,
            maximum_size_low: u32,
            name: *const u16,
        ) -> *mut c_void;
        fn MapViewOfFile(
            mapping: *mut c_void,
            access: u32,
            offset_high: u32,
            offset_low: u32,
            bytes: usize,
        ) -> *mut c_void;
        fn UnmapViewOfFile(address: *const c_void) -> i32;
    }

    // Test-only read-only mapping preserves exact byte comparisons without
    // releasing the live editor's lock. LockFileEx explicitly permits mapped
    // reads even when a new ReadFile handle receives ERROR_LOCK_VIOLATION.
    // https://learn.microsoft.com/windows/win32/api/fileapi/nf-fileapi-lockfileex
    let file = File::open(path)?;
    let length = usize::try_from(file.metadata()?.len())
        .map_err(|_| std::io::Error::other("Snapshot lock file is too large"))?;
    if length == 0 {
        return Ok(Vec::new());
    }
    if length > 64 * 1024 {
        return Err(std::io::Error::other(
            "Unexpectedly large snapshot lock file",
        ));
    }
    let raw_mapping = unsafe {
        CreateFileMappingW(
            file.as_raw_handle(),
            std::ptr::null(),
            0x02, // PAGE_READONLY
            0,
            0,
            std::ptr::null(),
        )
    };
    if raw_mapping.is_null() {
        return Err(std::io::Error::last_os_error());
    }
    let mapping = unsafe { OwnedHandle::from_raw_handle(raw_mapping) };
    let view = unsafe { MapViewOfFile(mapping.as_raw_handle(), 0x04, 0, 0, length) }; // FILE_MAP_READ
    if view.is_null() {
        return Err(std::io::Error::last_os_error());
    }
    let bytes = unsafe { std::slice::from_raw_parts(view.cast::<u8>(), length).to_vec() };
    if unsafe { UnmapViewOfFile(view) } == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(bytes)
}

fn snapshot_file(root: &Path, path: &Path) -> std::io::Result<Vec<u8>> {
    let _ = root; // Used by the Windows-only, exact lock-file fallback below.
    match fs::read(path) {
        #[cfg(windows)]
        Err(error)
            if error.raw_os_error() == Some(33)
                && path.strip_prefix(root).is_ok_and(is_snapshot_lock_path) =>
        {
            read_locked_snapshot_file(path)
        }
        result => result,
    }
}

fn snapshot(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    WalkDir::new(root)
        .into_iter()
        .map(Result::unwrap)
        .filter(|entry| entry.file_type().is_file())
        .map(|entry| {
            (
                entry.path().strip_prefix(root).unwrap().to_path_buf(),
                snapshot_file(root, entry.path()).unwrap(),
            )
        })
        .collect()
}

#[test]
fn snapshot_keeps_locked_token_bytes_detects_changes_and_preserves_lock() {
    use fs2::FileExt;
    use std::io::{Seek, SeekFrom};

    let root = std::env::temp_dir().join(format!("sbk-snapshot-{}", Uuid::new_v4()));
    fs::create_dir(&root).unwrap();
    let relative = Path::new(".workspace.edit.lock");
    let path = root.join(relative);
    let mut owner = OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(&path)
        .unwrap();
    owner.write_all(b"original").unwrap();
    owner.sync_all().unwrap();
    owner.try_lock_exclusive().unwrap();
    #[cfg(windows)]
    assert_eq!(fs::read(&path).unwrap_err().raw_os_error(), Some(33));
    let before = snapshot(&root);
    assert_eq!(before.len(), 1);
    assert_eq!(before[relative], b"original");
    owner.seek(SeekFrom::Start(0)).unwrap();
    owner.write_all(b"modified").unwrap();
    owner.sync_all().unwrap();
    let after = snapshot(&root);
    assert_eq!(after[relative], b"modified");
    assert_ne!(after, before);
    let contender = OpenOptions::new()
        .read(true)
        .write(true)
        .open(&path)
        .unwrap();
    assert!(contender.try_lock_exclusive().is_err());
    drop(contender);
    drop(owner);
    assert_eq!(fs::read(&path).unwrap(), b"modified");
    fs::remove_dir_all(root).unwrap();
}

#[cfg(windows)]
#[test]
fn snapshot_does_not_hide_unexpected_locks_or_missing_files() {
    use fs2::FileExt;

    let root = std::env::temp_dir().join(format!("sbk-snapshot-errors-{}", Uuid::new_v4()));
    fs::create_dir_all(root.join("staff")).unwrap();
    for relative in ["staff/data.sqlite3", "staff/.workspace.edit.lock"] {
        let path = root.join(relative);
        let mut owner = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(&path)
            .unwrap();
        owner.write_all(b"must not be skipped").unwrap();
        owner.sync_all().unwrap();
        owner.try_lock_exclusive().unwrap();
        assert_eq!(
            snapshot_file(&root, &path).unwrap_err().raw_os_error(),
            Some(33)
        );
    }
    assert_eq!(
        snapshot_file(&root, &root.join(".workspace.edit.guard"))
            .unwrap_err()
            .kind(),
        std::io::ErrorKind::NotFound
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn health_only_reads_and_does_not_change_editor_lease_files_or_data() {
    let (root, workspace) = fixture("health");
    let backup = create_backup_impl(&workspace, Some("staff".into())).unwrap();
    let before = snapshot(&root);
    let health = workspace_health_impl(&workspace);
    assert!(health.available);
    assert!(health.editor.owned_by_this_instance);
    assert!(workspace.is_editor());
    assert_eq!(health.backup.latest.unwrap().file_name, backup.file_name);
    assert_eq!(health.backup.verification.status, "not-recorded");
    assert_eq!(
        health.writable_basis,
        "last-known-os-access-not-a-write-probe"
    );
    assert_eq!(snapshot(&root), before);
    fs::write(root.join("backups/pinned.json"), b"invalid").unwrap();
    let health = workspace_health_impl(&workspace);
    assert!(
        health
            .issues
            .iter()
            .any(|issue| issue.code == "pins-invalid")
    );
    assert_eq!(health.backup.latest.unwrap().pinned, None);
    assert!(workspace.is_editor());
    drop(workspace);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn health_reports_unavailable_backup_directory_without_creating_it() {
    let (root, workspace) = fixture("health-unavailable");
    fs::remove_dir(root.join("backups")).unwrap();
    let before = snapshot(&root);
    let health = workspace_health_impl(&workspace);
    assert!(
        health
            .issues
            .iter()
            .any(|issue| issue.code == "backup-list-unavailable")
    );
    assert!(health.backup.latest.is_none());
    assert_eq!(snapshot(&root), before);
    assert!(!root.join("backups").exists());
    drop(workspace);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn selected_registry_files_filter_metadata_and_attachments_including_empty_selection() {
    let (root, workspace) = fixture("registry-selection");
    let first = "attachments/staff/qa/first.pdf";
    let second = "attachments/staff/qa/second.pdf";
    fs::create_dir_all(root.join("attachments/staff/qa")).unwrap();
    fs::write(root.join(first), b"first").unwrap();
    fs::write(root.join(second), b"second").unwrap();
    let payload = serde_json::json!({"fullName": "QA", "documents": [
        {"id": "first", "name": "Selected certificate", "relativePath": first},
        {"id": "second", "name": "Unselected certificate", "relativePath": second}
    ]});
    let connection = open_database(&root, "staff").unwrap();
    connection.execute("INSERT INTO records(id,title,payload,created_at,updated_at) VALUES ('qa','QA',?1,'now','now')", [payload.to_string()]).unwrap();
    drop(connection);
    for (label, paths, expected) in [
        ("selected", Some(HashSet::from([first.to_string()])), 1),
        ("none", Some(HashSet::new()), 0),
        ("legacy", None, 2),
    ] {
        let output = root.join(format!("{label}.zip"));
        create_registry_archive_impl(&workspace, "staff", &output, None, paths.as_ref()).unwrap();
        let mut archive = zip::ZipArchive::new(File::open(output).unwrap()).unwrap();
        let records: Value =
            serde_json::from_reader(archive.by_name("records.json").unwrap()).unwrap();
        assert_eq!(
            records[0]["payload"]["documents"].as_array().unwrap().len(),
            expected
        );
        assert_eq!(
            archive
                .file_names()
                .filter(|name| name.starts_with("attachments/"))
                .count(),
            expected
        );
        if label == "selected" {
            assert!(!records.to_string().contains("Unselected certificate"));
            assert!(archive.by_name(second).is_err());
        }
    }
    drop(workspace);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn registry_export_preserves_existing_destination_and_removes_only_its_partial() {
    let (root, workspace) = fixture("registry-no-clobber");
    let connection = open_database(&root, "staff").unwrap();
    connection.execute("INSERT INTO records(id,title,payload,created_at,updated_at) VALUES ('qa','QA','{}','now','now')", []).unwrap();
    drop(connection);
    let output = root.join("existing.zip");
    fs::write(&output, b"previous finished archive").unwrap();
    assert!(create_registry_archive_impl(&workspace, "staff", &output, None, None).is_err());
    assert_eq!(fs::read(&output).unwrap(), b"previous finished archive");
    assert!(!fs::read_dir(&root).unwrap().any(|entry| {
        entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .ends_with(".part")
    }));
    drop(workspace);
    fs::remove_dir_all(root).unwrap();
}
