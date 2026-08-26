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
    tauri_build::build()
}
