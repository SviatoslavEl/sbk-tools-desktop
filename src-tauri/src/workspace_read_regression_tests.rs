//! Synthetic local fixtures only; never consult workspace.txt or user data.
use super::*;
use std::cell::Cell;

fn root(label: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("sbk-read-{label}-{}", Uuid::new_v4()));
    fs::create_dir(&root).unwrap();
    root
}

fn contract_fixture() -> PathBuf {
    let root = root("contracts");
    fs::create_dir(root.join("contract-experience")).unwrap();
    let connection = Connection::open(root.join("contract-experience/data.sqlite3")).unwrap();
    // A pre-existing schema is read as-is; not initialized by the reader.
    connection.execute_batch(r#"CREATE TABLE records(id TEXT PRIMARY KEY, title TEXT NOT NULL, payload TEXT NOT NULL, archived INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE drafts(key TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL);
        INSERT INTO records VALUES('old','Old','{"number":"1"}',0,'now','2025');
        INSERT INTO records VALUES('new','New','{"number":"2"}',0,'now','2026');
        INSERT INTO records VALUES('archived','Archived','{}',1,'now','2027');
        INSERT INTO drafts VALUES('company-directory-v1','{"companies":[]}', 'now');
        PRAGMA user_version=2;"#).unwrap();
    drop(connection);
    root
}

#[test]
fn contract_snapshot_opens_once_and_never_rewrites_existing_database() {
    let root = contract_fixture();
    let path = root.join("contract-experience/data.sqlite3");
    let before = fs::read(&path).unwrap();
    let opens = Cell::new(0);
    let snapshot = read_contract_workspace_with(&root, |root| {
        opens.set(opens.get() + 1);
        // Controlled local delay stands in for an expensive SMB connection.
        // Count calls rather than asserting machine-dependent wall-clock time.
        thread::sleep(Duration::from_millis(10));
        let connection = open_database_read_only(root, "contract-experience")?;
        assert!(connection.is_readonly(DatabaseName::Main).unwrap());
        assert!(connection.execute("DELETE FROM records", []).is_err());
        Ok(connection)
    })
    .unwrap();
    assert_eq!(opens.get(), 1);
    assert_eq!(snapshot.records.len(), 2);
    assert_eq!(snapshot.records[0].id, "new");
    assert_eq!(snapshot.records[1].payload["number"], "1");
    assert_eq!(
        snapshot.directory,
        Some(serde_json::json!({"companies": []}))
    );
    assert_eq!(fs::read(&path).unwrap(), before);
    assert!(!root.join("backups").exists());
    assert_eq!(fs::read_dir(path.parent().unwrap()).unwrap().count(), 1);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn missing_directory_is_none_but_corrupt_or_unreadable_directory_fails_closed() {
    let root = contract_fixture();
    let path = root.join("contract-experience/data.sqlite3");
    let connection = Connection::open(&path).unwrap();
    connection.execute("DELETE FROM drafts", []).unwrap();
    let read = || {
        read_contract_workspace_with(&root, |root| {
            open_database_read_only(root, "contract-experience")
        })
    };
    assert!(read().unwrap().directory.is_none());
    connection
        .execute(
            "INSERT INTO drafts VALUES('company-directory-v1','invalid json','now')",
            [],
        )
        .unwrap();
    assert!(read().is_err());
    connection.execute("DROP TABLE drafts", []).unwrap();
    let before = fs::read(&path).unwrap();
    assert!(read().is_err());
    drop(connection);
    assert_eq!(fs::read(&path).unwrap(), before);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn missing_contract_database_is_not_created_by_snapshot_reader() {
    let root = root("missing");
    fs::create_dir(root.join("contract-experience")).unwrap();
    assert!(
        read_contract_workspace_with(&root, |root| {
            open_database_read_only(root, "contract-experience")
        })
        .is_err()
    );
    assert!(!root.join("contract-experience/data.sqlite3").exists());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn presentation_observations_probe_once_per_ttl_not_once_per_poll() {
    let mut cache = WorkspaceObservationCache::default();
    let root = Path::new("synthetic-root");
    let started = Instant::now();
    let probes = Cell::new(0);
    for seconds in [0, 3, 6, 9, 12, 15, 18, 21, 24, 27] {
        let value = cache.get_or_probe(root, started + Duration::from_secs(seconds), || {
            probes.set(probes.get() + 1);
            thread::sleep(Duration::from_millis(10));
            WorkspaceObservations {
                owner_configured: false,
                free_space_bytes: 123,
            }
        });
        assert_eq!(value.free_space_bytes, 123);
    }
    assert_eq!(probes.get(), 1);
    let expired = cache.get_or_probe(root, started + WORKSPACE_OBSERVATION_TTL, || {
        probes.set(probes.get() + 1);
        WorkspaceObservations {
            owner_configured: true,
            free_space_bytes: 0,
        }
    });
    assert_eq!(probes.get(), 2);
    assert!(
        expired.owner_configured,
        "do not retain a stale missing-owner assertion"
    );
    assert_eq!(expired.free_space_bytes, 0);
}

#[test]
fn presentation_cache_is_root_scoped_bounded_and_explicitly_invalidated() {
    let mut cache = WorkspaceObservationCache::default();
    let now = Instant::now();
    let probes = Cell::new(0);
    for name in ["first", "second", "first"] {
        cache.get_or_probe(Path::new(name), now, || {
            probes.set(probes.get() + 1);
            WorkspaceObservations {
                owner_configured: false,
                free_space_bytes: 1,
            }
        });
    }
    assert_eq!(
        probes.get(),
        3,
        "a different root replaces the one-entry cache"
    );
    cache.invalidate();
    cache.get_or_probe(Path::new("first"), now, || {
        probes.set(probes.get() + 1);
        WorkspaceObservations {
            owner_configured: true,
            free_space_bytes: 2,
        }
    });
    assert_eq!(probes.get(), 4);
}

#[test]
fn cached_observations_never_cache_editor_ownership() {
    let root = root("ownership");
    workspace::ensure_workspace(&root).unwrap();
    let workspace = Workspace::for_test(root.clone(), true);
    #[cfg(feature = "installed-fast-start")]
    let workspace = {
        let startup = StartupWorkspace::new();
        startup.finish(workspace).unwrap();
        Arc::new(startup)
    };
    #[cfg(not(feature = "installed-fast-start"))]
    let workspace = Arc::new(workspace);
    let state = AppState {
        workspace,
        scanner_jobs: Arc::new(Mutex::new(HashMap::new())),
        scanner_outputs: Arc::new(scanner_outputs::ScannerOutputs::default()),
        maintenance: Arc::new(Mutex::new(())),
        workspace_observations: Arc::new(Mutex::new(WorkspaceObservationCache::default())),
    };
    assert!(workspace_info_inner(&state).unwrap().editor);
    assert!(state.workspace_observations.lock().unwrap().entry.is_some());
    let workspace = state.active_workspace().unwrap();
    workspace.release_editor_on_exit().unwrap();
    let other_editor = Workspace::for_test(root.clone(), true);
    assert!(other_editor.is_editor());
    let before = fs::read(root.join(".workspace-editor.json")).unwrap();
    let info = workspace_info_inner(&state).unwrap();
    assert!(!info.editor);
    assert!(info.editor_busy);
    assert_eq!(
        fs::read(root.join(".workspace-editor.json")).unwrap(),
        before
    );
    drop(other_editor);
    drop(workspace);
    drop(state);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn paused_snapshot_command_is_not_local_and_never_opens_a_connection() {
    assert!(!network_diagnostics::local_command(
        "read_contract_workspace"
    ));
    let gate = Arc::new(network_diagnostics::NetworkGate::new());
    gate.start_disconnect().unwrap();
    gate.finish_disconnect(&Ok(()));
    let opens = Cell::new(0);
    let result = (|| {
        let _admission = gate.enter()?;
        read_contract_workspace_with(Path::new("not-a-real-workspace"), |_| {
            opens.set(opens.get() + 1);
            Err("must not reach filesystem".to_string())
        })
    })();
    assert!(result.is_err());
    assert_eq!(opens.get(), 0);
}
