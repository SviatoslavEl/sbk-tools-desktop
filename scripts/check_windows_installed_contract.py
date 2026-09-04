from __future__ import annotations

import hashlib
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]

PORTABLE_SNAPSHOT = {
    "scripts/package_windows_portable.ps1": "caeb60832eb8983e20ddeb04acd41103632309dac91ebb99fc94e57d3243397c",
    "windows-launcher/Cargo.toml": "6497d693e9caab781665eacebab9ce32c554d78d3e059dbe31ff1b5ae2314e03",
    "windows-launcher/Cargo.lock": "3a9c82e7eddbd4005448c4d4767de7c0da68ea466c357e76c67a488324270bd8",
    "windows-launcher/app.manifest": "6cd5bef612fab7b4c24b5a7944c19874f41e86512882a6156ba6b7a57d0a2bde",
    "windows-launcher/build.rs": "c768732240788f6951ad33599c2baddd1e78c4dd5a3bf6cdf5cb8052bd4e9dea",
    "windows-launcher/launcher.rc": "dee796c28bae15cf5c74ac1ece175de1b3f91771a9bd2fe9a116990d9d6eb7c7",
    "windows-launcher/src/main.rs": "81769280aeacd1f269d1afe0548affa27325f89a45c11e44d0afdd9956cc3cc4",
}


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes().replace(b"\r\n", b"\n")).hexdigest()


def main() -> None:
    for relative, expected in PORTABLE_SNAPSHOT.items():
        actual = sha256(ROOT / relative)
        if actual != expected:
            raise SystemExit(f"Portable v2.8.3 contract changed unexpectedly: {relative}")

    base = json.loads((ROOT / "src-tauri/tauri.conf.json").read_text(encoding="utf-8"))
    installed = json.loads(
        (ROOT / "src-tauri/tauri.installed.windows.conf.json").read_text(encoding="utf-8")
    )
    if base["identifier"] != "ru.sbk.tools" or base["productName"] != "СБК Инструменты":
        raise SystemExit("Portable application identity changed")
    if installed["productName"] != "СБК Инструменты — быстрый запуск":
        raise SystemExit("Installed product name is not stable")
    if installed["identifier"] != "ru.sbk.tools.fast":
        raise SystemExit("Installed application must have a stable separate identifier")
    if installed["identifier"] == base["identifier"]:
        raise SystemExit("Installed application would replace the portable application identity")
    if installed.get("mainBinaryName") in {None, "ScanDocument"}:
        raise SystemExit("Installed application binary has an invalid name")

    bundle = installed["bundle"]
    windows = bundle["windows"]
    nsis = windows["nsis"]
    if bundle["targets"] != ["nsis"] or nsis["installMode"] != "currentUser":
        raise SystemExit("Installed package must be a current-user NSIS installer")
    if bundle.get("licenseFile") != "../LICENSE":
        raise SystemExit("Installed package must show and include the project license")
    if windows["webviewInstallMode"]["type"] != "fixedRuntime":
        raise SystemExit("Installed package must include an offline WebView2 runtime")
    if nsis["startMenuFolder"] != "СБК Инструменты":
        raise SystemExit("Installed package must create the documented Start menu shortcut")
    if nsis["compression"] != "none":
        raise SystemExit("Installed package must not recompress the pre-compressed payload")

    installed_script = (ROOT / "scripts/package_windows_installed.ps1").read_text(
        encoding="utf-8"
    )
    if "windows-launcher" in installed_script or "SBKTools-runtime-$" in installed_script:
        raise SystemExit("Installed package must not use the portable extraction launcher")
    for required in (
        "SBK-Tools-Fast-Setup-$SafeVersion-x64.exe",
        "verify_runtime_manifest.py",
        "resource-manifest.json",
        '"--features", "installed-fast-start"',
        'VITE_SBK_INSTALLED_FAST_START = "true"',
        "create_payload_archive.py",
        "windows-installer-helper\\Cargo.toml",
        "nsis-3.11.zip",
    ):
        if required not in installed_script:
            raise SystemExit(f"Installed packaging check is missing: {required}")

    startup_source = (ROOT / "src-tauri/src/lib.rs").read_text(encoding="utf-8")
    frontend = (ROOT / "src/App.tsx").read_text(encoding="utf-8")
    for stage in (
        "Запускаем СБК Инструменты",
        "Проверяем рабочую папку",
        "Открываем базы данных",
        "Готовим модули",
        "Готово",
    ):
        if stage not in startup_source or stage not in frontend:
            raise SystemExit(f"Startup stage is missing: {stage}")
    if "VITE_SBK_INSTALLED_FAST_START" not in frontend:
        raise SystemExit("Installed startup is not isolated behind its build flavor")
    if "if (installedFastStart) return;" not in frontend:
        raise SystemExit("Portable startup delay is no longer isolated from the installed flavor")
    if "initialize_workspace_in_background" not in startup_source:
        raise SystemExit("Workspace initialization is not running in the background")
    if "report_startup_ui_visible" not in startup_source or "reportStartupUiVisible" not in frontend:
        raise SystemExit("GUI readiness is not reported by the rendered startup interface")

    workspace_source = (ROOT / "src-tauri/src/workspace.rs").read_text(encoding="utf-8")
    if '.join("SBKTools").join("ProductData")' not in workspace_source:
        raise SystemExit("Both application flavors must continue using the existing ProductData")
    cargo_manifest = (ROOT / "src-tauri/Cargo.toml").read_text(encoding="utf-8")
    if "installed-fast-start = []" not in cargo_manifest:
        raise SystemExit("Installed startup feature is missing from the Rust build")
    build_script = (ROOT / "src-tauri/build.rs").read_text(encoding="utf-8")
    if '#[cfg(feature = "installed-fast-start")]' not in build_script or (
        'include_str!("../scripts/windows-as-invoker.manifest")' not in build_script
    ):
        raise SystemExit("Installed asInvoker manifest must be embedded during compilation")

    nsis_template = (ROOT / "scripts/windows-installed.nsi").read_text(encoding="utf-8")
    for required in (
        "RequestExecutionLevel user",
        "SetCompress off",
        "SBK-Tools-Fast.exe",
        "sbk-installed-extractor.exe",
        "$LOCALAPPDATA\\Programs\\SBK Tools Fast",
        "Section /o \"Ярлык на рабочем столе\"",
    ):
        if required not in nsis_template:
            raise SystemExit(f"Installed NSIS contract is missing: {required}")
    if "ProductData" in nsis_template.split('Section "Uninstall"', maxsplit=1)[-1]:
        raise SystemExit("Installed uninstaller must not target ProductData")

    print("Windows packaging contract: portable preserved, installed flavor isolated, startup staged")


if __name__ == "__main__":
    main()
