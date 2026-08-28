from __future__ import annotations

import argparse
import platform
import shutil
import subprocess
import sys
from pathlib import Path


TARGET_NAMES = {
    ("Darwin", "arm64"): "aarch64-apple-darwin",
    ("Darwin", "x86_64"): "x86_64-apple-darwin",
    ("Windows", "AMD64"): "x86_64-pc-windows-msvc",
    ("Windows", "ARM64"): "aarch64-pc-windows-msvc",
}


def main() -> None:
    parser = argparse.ArgumentParser(description="Build the offline scanner sidecar")
    parser.add_argument("--target", help="Rust target triple used by Tauri")
    parser.add_argument("--python", default=sys.executable)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    worker = root / "scanner-worker"
    output = worker / "dist"
    output.mkdir(parents=True, exist_ok=True)
    executable = "sbk-scanner-worker.exe" if platform.system() == "Windows" else "sbk-scanner-worker"
    onefile_temp = (
        "{PROGRAM_DIR}/.scanner-worker-{PID}-{TIME}"
        if platform.system() == "Windows"
        else "{TEMP}/ScanDocument-worker-{PID}-{TIME}"
    )
    command = [
        args.python, "-m", "nuitka", "--onefile", "--assume-yes-for-downloads",
        # Nuitka removes this unique directory on normal exit.  On Windows it
        # lives inside the outer launcher's runtime, so crash recovery removes
        # it on the next start.  A signed macOS bundle is read-only, therefore
        # macOS uses the system temp instead of modifying the app bundle.
        f"--onefile-tempdir-spec={onefile_temp}",
        "--onefile-cache-mode=temporary",
        f"--output-dir={output}", f"--output-filename={executable}",
        "--include-package=scandocument", "--include-package=PIL", "--include-package=numpy",
        "--include-package=pypdf", "--include-package=pypdfium2", "--include-package=docx",
        "--include-module=reportlab.pdfgen.canvas", "--include-module=reportlab.pdfbase.pdfmetrics",
        "--include-module=reportlab.pdfbase.ttfonts", "--include-package-data=pypdfium2",
        "--nofollow-import-to=reportlab.lib.testutils,reportlab.graphics.testshapes,numpy.conftest,numpy.tests,numpy.testing,numpy.typing.tests,pypdf.tests,docx.tests,tkinter,_tkinter",
    ]
    if platform.system() == "Windows":
        command.append("--windows-console-mode=disable")
    resources = worker / "resources"
    command.append(str(worker / "src/scandocument/worker_cli.py"))
    subprocess.run(command, cwd=root, check=True)
    target = args.target or TARGET_NAMES.get((platform.system(), platform.machine()))
    if not target:
        raise SystemExit(f"Unknown platform target: {platform.system()} {platform.machine()}")
    destination = root / "src-tauri/binaries" / f"sbk-scanner-worker-{target}"
    if platform.system() == "Windows":
        destination = destination.with_suffix(".exe")
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(output / executable, destination)
    staged_resources = root / "src-tauri/runtime-resources/resources"
    if staged_resources.exists():
        shutil.rmtree(staged_resources)
    shutil.copytree(resources, staged_resources)
    print(destination)


if __name__ == "__main__":
    main()
