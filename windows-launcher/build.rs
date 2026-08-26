use std::fs;

fn main() {
    println!("cargo:rerun-if-env-changed=SBK_PAYLOAD_TAR_ZST");
    if std::env::var_os("SBK_PAYLOAD_TAR_ZST").is_none() {
        let payload = std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap())
            .join("empty-test-payload.tar.zst");
        // Compile-only placeholder. Release packaging always supplies the real
        // deterministic payload through SBK_PAYLOAD_TAR_ZST.
        fs::write(&payload, []).unwrap();
        println!("cargo:rustc-env=SBK_PAYLOAD_TAR_ZST={}", payload.display());
    }
    embed_resource::compile("launcher.rc", embed_resource::NONE)
        .manifest_required()
        .unwrap();
}
