fn main() {
    emit_build_identity();
    let manifest = std::path::Path::new("runtime-resources/resources/resource-manifest.json");
    println!("cargo:rerun-if-changed={}", manifest.display());
    let content = std::fs::read_to_string(manifest).unwrap_or_else(|_| {
        r#"{"schemaVersion":0,"worker":{"fileName":"","sizeBytes":0,"sha256":""},"resources":{}}"#
            .to_string()
    });
    let destination = std::path::PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR"))
        .join("trusted-runtime-manifest.json");
    std::fs::write(destination, content).expect("write trusted runtime manifest");
    #[cfg(feature = "installed-fast-start")]
    {
        let windows = tauri_build::WindowsAttributes::new()
            .app_manifest(include_str!("../scripts/windows-as-invoker.manifest"));
        let attributes = tauri_build::Attributes::new().windows_attributes(windows);
        tauri_build::try_build(attributes).expect("failed to run installed Tauri build script");
    }

    #[cfg(not(feature = "installed-fast-start"))]
    tauri_build::build()
}

fn emit_build_identity() {
    for name in ["GITHUB_SHA", "ARTIFACT_VERSION"] {
        println!("cargo:rerun-if-env-changed={name}");
    }
    println!("cargo:rerun-if-changed=../.git/HEAD");
    println!("cargo:rerun-if-changed=../.git/logs/HEAD");
    let revision = std::env::var("GITHUB_SHA")
        .ok()
        .or_else(|| {
            let result = std::process::Command::new("git")
                .args(["rev-parse", "HEAD"])
                .output()
                .ok()?;
            result
                .status
                .success()
                .then(|| String::from_utf8_lossy(&result.stdout).trim().to_owned())
        })
        .filter(|value| {
            matches!(value.len(), 40 | 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
        })
        .unwrap_or_else(|| "unknown".into());
    let label = std::env::var("ARTIFACT_VERSION")
        .ok()
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 80
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b".-_".contains(&byte))
        })
        .unwrap_or_else(|| "local-development".into());
    println!("cargo:rustc-env=SBK_BUILD_REVISION={revision}");
    println!("cargo:rustc-env=SBK_BUILD_LABEL={label}");
}
