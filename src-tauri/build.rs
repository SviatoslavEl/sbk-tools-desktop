fn main() {
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
