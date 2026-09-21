from __future__ import annotations

import hashlib
import json
import re
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


def check_frontend_startup_readiness(frontend: str) -> None:
    """Keep the splash tied to real readiness, not a minimum display time."""
    compact = re.sub(r"\s+", "", frontend)
    for guard, message in (
        (
            "if(!installedFastStart&&!workspace)return(",
            "Portable startup must wait for the workspace, without a timer gate",
        ),
        (
            "if(installedFastStart&&(!workspace||!startup.ready))return(",
            "Installed startup must wait for both backend readiness and the workspace",
        ),
    ):
        if guard not in compact:
            raise SystemExit(message)

    if "startupDelayElapsed" in frontend or "setStartupDelayElapsed" in frontend:
        raise SystemExit("Startup must not restore the artificial splash delay")
    if (
        "if(status.ready){constvalue=awaitgetWorkspaceInfo();"
        "if(stopped)return;setWorkspace(value);"
    ) not in compact:
        raise SystemExit("Installed workspace must come from the ready backend response")
    if "refreshWorkspace();window.addEventListener(" not in compact:
        raise SystemExit("Workspace readiness must be requested immediately on mount")

    # App currently needs timeouts only to retry the real readiness request.
    # Reject an added minimum-duration timer (including a renamed delay state)
    # while preserving the existing short status/error polling intervals.
    without_readiness_retries = re.sub(
        r"window\.setTimeout\(refreshWorkspace,(?:140|500)\)", "", compact
    )
    if re.search(r"\bsetTimeout\(", without_readiness_retries):
        raise SystemExit("Startup timeouts must only retry workspace readiness, not delay the UI")


def check_windows_native_test_order(workflow: str) -> None:
    """Fail Windows regressions before spending time compiling the scanner worker."""
    jobs = re.split(r"(?m)^  build-installed-windows:\s*$", workflow, maxsplit=1)
    if len(jobs) != 2:
        raise SystemExit("Installed Windows build job is missing")
    job = re.split(r"(?m)^  [\w-]+:\s*$", jobs[1], maxsplit=1)[0]
    steps = re.findall(r"(?ms)^      - .*?(?=^      - |\Z)", job)
    native_steps = [
        (index, step) for index, step in enumerate(steps)
        if "name: Run native Windows regression tests before scanner compilation" in step
    ]
    if len(native_steps) != 1:
        raise SystemExit("Windows native regression tests need one dedicated early step")
    index, native = native_steps[0]
    command = "cargo test --manifest-path src-tauri/Cargo.toml --lib"
    if job.count(command) != 1 or not re.search(rf"(?m)^\s*{re.escape(command)}\s*$", native):
        raise SystemExit("Windows native regression suite must run once with its existing flags")
    prerequisite = "\n".join(steps[:index])
    if "run: npm ci" not in prerequisite or "uses: dtolnay/rust-toolchain@" not in prerequisite:
        raise SystemExit("Windows native regression tests must follow Node and Rust setup")
    if any(marker in prerequisite for marker in (
        "pip install -e scanner-worker",
        "reuse_verified_windows_worker.ps1",
        "build_scanner_worker.py",
        "package_windows_installed.ps1",
    )):
        raise SystemExit("Windows native regression tests must precede scanner compilation")
    if re.search(r"(?m)^        (?:if|continue-on-error):", native):
        raise SystemExit("Windows native regression tests must be unconditional and fail closed")
    for required in (
        "shell: pwsh",
        "if ($LASTEXITCODE -ne 0) { throw 'Windows database/editor regression tests failed' }",
        '$createdWorkerStub = -not (Test-Path -LiteralPath $workerStub)',
        "if ($createdWorkerStub) { New-Item -ItemType File -Path $workerStub | Out-Null }",
        "} finally {",
        "if ($createdWorkerStub -and (Test-Path -LiteralPath $workerStub))",
        "Remove-Item -LiteralPath $workerStub -ErrorAction Stop",
        "Get-Content -LiteralPath src-tauri/tauri.windows.conf.json -Raw | ConvertFrom-Json",
        "$webviewRelative = $windowsMetadata.bundle.windows.webviewInstallMode.path",
        "$windowsMetadata.bundle.windows.webviewInstallMode.type -ne 'fixedRuntime'",
        r"$webviewRelative -notmatch '^\./webview2-runtime/[^/\\]+$'",
        "$webviewStub = Join-Path (Join-Path $env:GITHUB_WORKSPACE 'src-tauri') $webviewRelative",
        "$createdWebviewStub = -not (Test-Path -LiteralPath $webviewStub)",
        "if ($createdWebviewStub) { New-Item -ItemType Directory -Force -Path $webviewStub | Out-Null }",
        "if ($createdWebviewStub -and (Test-Path -LiteralPath $webviewStub))",
        "[IO.Directory]::Delete($webviewStub, $false)",
    ):
        if required not in native:
            raise SystemExit(f"Windows native preflight safety check is missing: {required}")


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
    if installed["productName"] != "СБК Инструменты":
        raise SystemExit("Installed product name must not expose an internal build flavor")
    if any(window.get("title") != "СБК Инструменты" for window in installed["app"]["windows"]):
        raise SystemExit("Installed window title must use the plain product name")
    if installed["identifier"] != "ru.sbk.tools.fast":
        raise SystemExit("Installed application must have a stable separate identifier")
    if installed["identifier"] == base["identifier"]:
        raise SystemExit("Installed application would replace the portable application identity")
    if installed.get("mainBinaryName") != "SBK-Tools-Fast":
        raise SystemExit("Installed application binary must retain its update-compatible filename")

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
        'Copy-Item $Extractor (Join-Path $NsisStage "sbk-installed-extractor.exe")',
        "nsis-3.11.zip",
        '"/INPUTCHARSET" "UTF8"',
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
    check_frontend_startup_readiness(frontend)
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
        '!define PRODUCT_NAME "СБК Инструменты"',
        '!define PRODUCT_ID "ru.sbk.tools.fast"',
        '!define PRODUCT_KEY "Software\\SBK\\ToolsFast"',
        'WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "${PRODUCT_NAME}"',
        'CreateShortcut "$APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\СБК Инструменты\\${PRODUCT_NAME}.lnk"',
        "RequestExecutionLevel user",
        "SetCompress off",
        "SBK-Tools-Fast.exe",
        "sbk-installed-extractor.exe",
        "$LOCALAPPDATA\\Programs\\SBK Tools Fast",
        "Section /o \"Ярлык на рабочем столе\"",
        'StrCpy $StartMenuFolder "СБК Инструменты"',
        "IfSilent silent_install_failure",
        "SBK-Tools-Fast-Install-Error.log",
        "SetErrorLevel 1",
        '"$TEMP\\SBK-Tools-Fast-Install-Error.log"',
        "ExecWait",
        "InitPluginsDir",
        "kernel32::GetFileAttributesW",
        "SetErrorLevel 5",
        ".__sbk_product_data",
    ):
        if required not in nsis_template:
            raise SystemExit(f"Installed NSIS contract is missing: {required}")
    shortcut_migration = nsis_template.split("shortcut_ready:\n", maxsplit=1)[-1].split("SectionEnd", maxsplit=1)[0]
    for required in (
        'IfFileExists "$DESKTOP\\${LEGACY_PRODUCT_NAME}.lnk" update_desktop_shortcut 0',
        'IfFileExists "$DESKTOP\\${PRODUCT_NAME}.lnk" update_desktop_shortcut legacy_desktop_ready',
        'CreateShortcut "$DESKTOP\\${PRODUCT_NAME}.lnk" "$INSTDIR\\${PRODUCT_EXE}"',
        'IfErrors legacy_desktop_ready',
        'Delete "$DESKTOP\\${LEGACY_PRODUCT_NAME}.lnk"',
        'Delete "$APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\СБК Инструменты\\${LEGACY_PRODUCT_NAME}.lnk"',
        'Delete "$APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\СБК Инструменты\\Удалить ${LEGACY_PRODUCT_NAME}.lnk"',
    ):
        if required not in shortcut_migration:
            raise SystemExit("Installed update must retire its old display-name shortcuts after creating the new one")
    install_sections = nsis_template.split('Section "Uninstall"', maxsplit=1)[0]
    if 'Delete "$DESKTOP\\${PRODUCT_NAME}.lnk"' in install_sections:
        raise SystemExit("Installed update must not remove an existing plain-name desktop shortcut")
    shortcut_setup = install_sections.split('SetShellVarContext current', maxsplit=1)[-1]
    if shortcut_setup.index('SetOutPath "$INSTDIR"') > shortcut_setup.index('CreateShortcut '):
        raise SystemExit("Installed shortcuts must use the installation directory as their working directory")
    uninstall_section = nsis_template.split('Section "Uninstall"', maxsplit=1)[-1]
    for required in (
        'Rename "$INSTDIR\\ProductData" $0',
        'Rename $0 "$INSTDIR\\ProductData"',
        "preserve_failure:",
    ):
        if required not in uninstall_section:
            raise SystemExit("Installed uninstaller must preserve adjacent ProductData")
    if 'RMDir /r "$INSTDIR\\ProductData"' in uninstall_section:
        raise SystemExit("Installed uninstaller must not remove ProductData")

    extractor_manifest = (ROOT / "windows-installer-helper/app.manifest").read_text(
        encoding="utf-8"
    )
    if "<longPathAware" not in extractor_manifest:
        raise SystemExit("Installed extractor must support long Windows runtime paths")

    release_workflow = (ROOT / ".github/workflows/release.yml").read_text(encoding="utf-8")
    check_windows_native_test_order(release_workflow)
    for required in (
        "Wait-InstallerProcess",
        "SBK-Tools-Fast-Install-Error.log",
        "timeout-minutes: 35",
        "Release build-only Windows runtimes before install smoke",
        "Free space before installer smoke",
        "Fast-start installer failed",
        "SBK-Tools-Windows-x64-Installed-Diagnostics",
        "SBK-Tools-Fast-Smoke.log",
        "Start-Transcript",
        "Fast-start smoke failure",
        "Installed runtime manifest verification failed",
        "Wait-DatabaseSettle",
        "Concurrent installed viewer replaced the editor lock",
        "Uninstall removed adjacent ProductData",
        "Update removed adjacent ProductData",
        "Repeated installed launch left stale editor ownership",
        "Installed database schema is incomplete",
        "Reinstall after uninstall lost adjacent ProductData",
        "Installed display name still contains a build flavor",
        "Programs\\СБК Инструменты\\СБК Инструменты.lnk",
    ):
        if required not in release_workflow:
            raise SystemExit(f"Installed smoke timeout protection is missing: {required}")

    installer_regressions = (ROOT / "scripts/test_windows_installer_regressions.ps1").read_text(encoding="utf-8")
    for required in (
        "plain-product-name-and-legacy-shortcut-migration",
        "Installer metadata still exposes the fast-start suffix",
        "Update left the obsolete shortcut",
        "Shortcut no longer targets the update-compatible executable",
        "((IPersistFile)instance).Load(shortcutPath, 0)",
        "link.GetPath(target, target.Capacity, IntPtr.Zero, SLGP_RAWPATH)",
        "Assert-True ($actualTarget -eq $expectedTarget)",
        "Assert-True (Test-Path -LiteralPath $actualTarget -PathType Leaf)",
        "Assert-True ($actualWorkingDirectory -eq $Destination)",
        "Fresh silent installation ignored the desktop shortcut opt-out",
        "display-name-second-update",
        "Assert-ShortcutTarget $newDesktop $destination",
    ):
        if required not in installer_regressions:
            raise SystemExit(f"Installed display-name regression is missing: {required}")

    print("Windows packaging contract: portable preserved, installed flavor isolated, startup staged")


if __name__ == "__main__":
    main()
