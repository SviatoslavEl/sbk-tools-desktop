use std::fs;

fn main() {
    println!("cargo:rerun-if-env-changed=SBK_PAYLOAD_ZIP");
    if std::env::var_os("SBK_PAYLOAD_ZIP").is_none() {
        let payload = std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap())
            .join("empty-test-payload.zip");
        // Valid empty ZIP, used only by compile/test/clippy checks. Release packaging
        // always supplies the real payload through SBK_PAYLOAD_ZIP.
        fs::write(
            &payload,
            [
                0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            ],
        )
        .unwrap();
        println!("cargo:rustc-env=SBK_PAYLOAD_ZIP={}", payload.display());
    }
    embed_resource::compile("launcher.rc", embed_resource::NONE)
        .manifest_required()
        .unwrap();
}
