//! Synthetic local fixtures only: never open the user's configured workspace.
use super::*;

const OWNER_PASSWORD: &str = "Synthetic owner fixture 2026!";

fn fixture(label: &str) -> (PathBuf, Workspace, Arc<network_diagnostics::NetworkGate>) {
    let root = std::env::temp_dir().join(format!("sbk-network-{label}-{}", Uuid::new_v4()));
    workspace::ensure_workspace(&root).unwrap();
    let workspace = Workspace::for_test(root.clone(), true);
    administration::setup(&root, OWNER_PASSWORD, "Synthetic fixture").unwrap();
    (
        root,
        workspace,
        Arc::new(network_diagnostics::NetworkGate::new()),
    )
}

#[test]
fn wrong_owner_password_cannot_close_admission_or_release_editor() {
    let (root, workspace, gate) = fixture("owner");
    let before = fs::read(root.join(".workspace-editor.json")).unwrap();
    assert!(authorize_network_disconnect(&workspace, &gate, "incorrect password").is_err());
    assert!(gate.connected());
    assert!(workspace.is_editor());
    assert_eq!(
        fs::read(root.join(".workspace-editor.json")).unwrap(),
        before
    );
    drop(workspace);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn active_operation_prevents_release_until_it_really_finishes() {
    let (root, workspace, gate) = fixture("drain");
    let operation = gate.enter().unwrap();
    authorize_network_disconnect(&workspace, &gate, OWNER_PASSWORD).unwrap();
    let result =
        finish_network_disconnect(&workspace, &gate, &Mutex::new(()), Duration::from_millis(1));
    gate.finish_disconnect(&result);
    assert!(result.is_err());
    assert!(!gate.disconnected());
    assert!(workspace.is_editor());
    assert!(gate.enter().is_err());
    drop(operation);
    authorize_network_disconnect(&workspace, &gate, OWNER_PASSWORD).unwrap();
    let result =
        finish_network_disconnect(&workspace, &gate, &Mutex::new(()), Duration::from_secs(1));
    gate.finish_disconnect(&result);
    result.unwrap();
    assert!(gate.disconnected());
    assert!(!workspace.is_editor());
    assert!(!root.join(".workspace-editor.json").exists());
    drop(workspace);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn uncertain_own_claim_does_not_report_successfully_disconnected() {
    let (root, workspace, gate) = fixture("uncertain");
    let presence = root.join(".workspace-editor.json");
    let original = fs::read(&presence).unwrap();
    authorize_network_disconnect(&workspace, &gate, OWNER_PASSWORD).unwrap();
    fs::write(&presence, b"invalid synthetic claim").unwrap();
    let result =
        finish_network_disconnect(&workspace, &gate, &Mutex::new(()), Duration::from_secs(1));
    gate.finish_disconnect(&result);
    assert!(result.is_err());
    assert!(!gate.disconnected());
    assert!(workspace.editor_cleanup_pending());
    assert_eq!(fs::read(&presence).unwrap(), b"invalid synthetic claim");
    fs::write(&presence, original).unwrap();
    drop(workspace);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn disconnecting_viewer_never_changes_another_instances_editor_claim() {
    let (root, editor, gate) = fixture("other-editor");
    let viewer = Workspace::for_test(root.clone(), false);
    let before = fs::read(root.join(".workspace-editor.json")).unwrap();
    authorize_network_disconnect(&viewer, &gate, OWNER_PASSWORD).unwrap();
    let result = finish_network_disconnect(&viewer, &gate, &Mutex::new(()), Duration::from_secs(1));
    gate.finish_disconnect(&result);
    result.unwrap();
    assert!(gate.disconnected());
    assert!(editor.is_editor());
    assert_eq!(
        fs::read(root.join(".workspace-editor.json")).unwrap(),
        before
    );
    drop(viewer);
    drop(editor);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn reconnect_is_read_only_and_preserves_module_database_bytes() {
    let (root, workspace, gate) = fixture("read-only-reconnect");
    let mut before = Vec::new();
    for module in MODULES {
        drop(open_database(&root, module).unwrap());
        before.push((
            module,
            fs::read(root.join(module).join("data.sqlite3")).unwrap(),
        ));
    }
    authorize_network_disconnect(&workspace, &gate, OWNER_PASSWORD).unwrap();
    let result =
        finish_network_disconnect(&workspace, &gate, &Mutex::new(()), Duration::from_secs(1));
    gate.finish_disconnect(&result);
    result.unwrap();
    gate.start_reconnect().unwrap();
    let result = reconnect_workspace_read_only(&workspace);
    gate.finish_reconnect(&result);
    result.unwrap();
    assert!(gate.connected());
    assert!(!workspace.is_editor());
    assert!(!root.join(".workspace-editor.json").exists());
    for (module, bytes) in before {
        assert_eq!(
            fs::read(root.join(module).join("data.sqlite3")).unwrap(),
            bytes
        );
    }
    drop(workspace);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn reconnect_refreshes_workspace_password_added_by_another_editor() {
    let (root, workspace, gate) = fixture("password-refresh");
    for module in MODULES {
        drop(open_database(&root, module).unwrap());
    }
    authorize_network_disconnect(&workspace, &gate, OWNER_PASSWORD).unwrap();
    let result =
        finish_network_disconnect(&workspace, &gate, &Mutex::new(()), Duration::from_secs(1));
    gate.finish_disconnect(&result);
    result.unwrap();
    assert!(!workspace.access_controlled());
    let other = Workspace::for_test(root.clone(), true);
    assert!(other.is_editor());
    other
        .set_access_password("", "Synthetic workspace password 2026!")
        .unwrap();
    drop(other);
    reconnect_workspace_read_only(&workspace).unwrap();
    assert!(workspace.access_controlled());
    assert!(workspace.acquire_editor_with_password("").is_err());
    assert!(!workspace.is_editor());
    drop(workspace);
    fs::remove_dir_all(root).unwrap();
}

/// Opt-in manual GUI fixture. The caller creates an EMPTY uniquely named
/// temporary directory first; this helper never consults workspace.txt and
/// refuses normal user/workspace paths. It leaves its fixture for the GUI run.
#[test]
#[ignore = "Explicit isolated local GUI fixture only"]
fn prepare_network_diagnostic_ui_fixture() {
    let requested = std::env::var_os("SBK_DIAGNOSTICS_UI_FIXTURE_ROOT")
        .expect("Set SBK_DIAGNOSTICS_UI_FIXTURE_ROOT to an empty sbk-network-qa-* temp directory");
    let root = PathBuf::from(requested)
        .canonicalize()
        .expect("Existing local temp directory");
    let temp = std::env::temp_dir().canonicalize().unwrap();
    let allowed = root.starts_with(&temp)
        || (cfg!(unix)
            && Path::new("/tmp")
                .canonicalize()
                .ok()
                .is_some_and(|temp| root.starts_with(temp)));
    assert!(
        allowed,
        "Fixture must be under the local temporary directory"
    );
    assert!(
        root.file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("sbk-network-qa-")
    );
    assert!(root.is_dir());
    assert!(
        fs::read_dir(&root).unwrap().next().is_none(),
        "Fixture directory must be empty"
    );
    workspace::ensure_workspace(&root).unwrap();
    let workspace = Workspace::for_test(root.clone(), true);
    assert!(workspace.is_editor());
    for module in MODULES {
        drop(open_database(&root, module).unwrap());
    }
    administration::setup(&root, OWNER_PASSWORD, "Synthetic local GUI QA").unwrap();
    workspace.release_editor_on_exit().unwrap();
    assert!(!workspace.editor_cleanup_pending());
    eprintln!("Isolated synthetic GUI fixture ready: {}", root.display());
}

#[test]
fn document_open_rejects_outside_paths_executables_and_directories() {
    let (root, workspace, _) = fixture("document-boundary");
    let document = root.join("attachments").join("synthetic.pdf");
    fs::write(&document, b"synthetic document").unwrap();
    assert!(authorized_document_path(&root, &document).is_ok());
    let program = root.join("attachments").join("synthetic.exe");
    fs::write(&program, b"not executable fixture").unwrap();
    assert!(authorized_document_path(&root, &program).is_err());
    let outside = root.join("synthetic.pdf");
    fs::write(&outside, b"outside attachment tree").unwrap();
    assert!(authorized_document_path(&root, &outside).is_err());
    assert!(authorized_document_path(&root, &root.join("attachments")).is_err());
    assert!(
        authorized_document_path(&root, Path::new("https://example.invalid/file.pdf")).is_err()
    );
    drop(workspace);
    fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[test]
fn document_open_rejects_attachment_symlink_escape() {
    let (root, workspace, _) = fixture("document-symlink");
    let outside = root.join("outside.pdf");
    fs::write(&outside, b"not in attachment tree").unwrap();
    let link = root.join("attachments").join("link.pdf");
    std::os::unix::fs::symlink(&outside, &link).unwrap();
    assert!(authorized_document_path(&root, &link).is_err());
    drop(workspace);
    fs::remove_dir_all(root).unwrap();
}
