from __future__ import annotations

import argparse
import hashlib
import os
import platform
import shutil
import subprocess
import tempfile
from pathlib import Path


VERSION = "26.2.5"
PACKAGES = {
    "aarch64-apple-darwin": (
        f"https://download.documentfoundation.org/libreoffice/stable/{VERSION}/mac/aarch64/LibreOffice_{VERSION}_MacOS_aarch64.dmg",
        "c99fb4fe574437fc4cb820a4ca15271bca325920861f7139858b36d7f9df78ad",
    ),
    "x86_64-apple-darwin": (
        f"https://download.documentfoundation.org/libreoffice/stable/{VERSION}/mac/x86_64/LibreOffice_{VERSION}_MacOS_x86-64.dmg",
        "e26180298685274b54aa7fe6e1101c65465a372f457a6748ebd642720811db36",
    ),
    "x86_64-pc-windows-msvc": (
        f"https://download.documentfoundation.org/libreoffice/stable/{VERSION}/win/x86_64/LibreOffice_{VERSION}_Win_x86-64.msi",
        "f15ba07bfcb0186986cf3171063506f5d207c11f8cc051ba0d135209e9e915f9",
    ),
}


def stage_windows_cpp_runtime(destination: Path) -> None:
    """Bundle the supported app-local MSVC runtime required on clean Windows systems."""
    libraries: dict[str, Path] = {}
    configured = os.environ.get("VCToolsRedistDir")
    if configured:
        for library in Path(configured).glob("x64/Microsoft.VC*.CRT/*.dll"):
            libraries[library.name.lower()] = library
    program_files_x86 = Path(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)"))
    vswhere = program_files_x86 / "Microsoft Visual Studio/Installer/vswhere.exe"
    if vswhere.is_file():
        result = subprocess.run(
            [
                str(vswhere), "-latest", "-products", "*", "-requires",
                "Microsoft.VisualStudio.Component.VC.Redist.14.Latest", "-find",
                r"VC\Redist\MSVC\**\x64\Microsoft.VC*.CRT\*.dll",
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        for value in result.stdout.splitlines():
            library = Path(value.strip())
            if library.is_file():
                libraries[library.name.lower()] = library
    if not libraries:
        raise SystemExit(
            "Microsoft Visual C++ app-local runtime was not found via VCToolsRedistDir or vswhere"
        )
    program = destination / "program"
    for library in libraries.values():
        shutil.copy2(library, program / library.name)
    print(f"Staged {len(libraries)} Microsoft Visual C++ app-local runtime DLLs", flush=True)


def digest(path: Path) -> str:
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def download_verified(url: str, destination: Path, expected: str) -> None:
    for attempt in range(1, 4):
        subprocess.run([
            "curl", "--fail", "--location", "--retry", "5", "--retry-delay", "5",
            "--retry-all-errors", "--continue-at", "-", "--output", str(destination), url,
        ], check=True)
        if digest(destination) == expected:
            return
        destination.unlink(missing_ok=True)
        print(f"Checksum mismatch after attempt {attempt}; downloading again", flush=True)
    raise SystemExit("LibreOffice package checksum mismatch after retries")


def remove_python_bytecode(root: Path) -> tuple[int, int]:
    bytecode_files = list(root.rglob("*.pyc")) + list(root.rglob("*.pyo"))
    for bytecode in bytecode_files:
        bytecode.unlink()
    cache_directories = sorted(
        (path for path in root.rglob("__pycache__") if path.is_dir()),
        key=lambda path: len(path.parts),
        reverse=True,
    )
    for cache in cache_directories:
        shutil.rmtree(cache)
    return len(bytecode_files), len(cache_directories)


def main() -> None:
    parser = argparse.ArgumentParser(description="Stage pinned LibreOffice runtime")
    parser.add_argument("--target", required=True, choices=PACKAGES)
    parser.add_argument("--output", type=Path, default=Path("src-tauri/runtime-resources/resources"))
    args = parser.parse_args()
    url, expected = PACKAGES[args.target]
    args.output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="sbk-libreoffice-") as temporary_name:
        temporary = Path(temporary_name)
        package = temporary / Path(url).name
        download_verified(url, package, expected)
        if args.target.endswith("apple-darwin"):
            mount = temporary / "mount"
            mount.mkdir()
            subprocess.run(["hdiutil", "attach", "-nobrowse", "-readonly", "-mountpoint", str(mount), str(package)], check=True)
            try:
                source = mount / "LibreOffice.app"
                destination = args.output / "office/darwin/LibreOffice.app"
                if destination.exists():
                    shutil.rmtree(destination)
                shutil.copytree(source, destination, symlinks=True)
                # The LibreOffice image ships timestamp-based Python bytecode
                # caches whose headers predate the matching sources.  Embedded
                # Python rewrites them on first use, which would make a signed
                # application fail its own runtime integrity check.  Package
                # sources only and disable cache creation in office_engine.py.
                bytecode_count, cache_count = remove_python_bytecode(destination)
                print(
                    f"Removed {bytecode_count} mutable Python bytecode files "
                    f"and {cache_count} cache directories from the macOS LibreOffice runtime",
                    flush=True,
                )
            finally:
                subprocess.run(["hdiutil", "detach", str(mount)], check=True)
        elif platform.system() == "Windows":
            extracted = temporary / "administrative"
            extracted.mkdir()
            subprocess.run(["msiexec", "/a", str(package), "/qn", f"TARGETDIR={extracted}"], check=True)
            soffice = next(extracted.rglob("soffice.exe"), None)
            if soffice is None or soffice.parent.name.lower() != "program":
                raise SystemExit("soffice.exe was not found in the administrative image")
            source = soffice.parent.parent
            destination = args.output / "office/windows"
            if destination.exists():
                shutil.rmtree(destination)
            shutil.copytree(source, destination)
            stage_windows_cpp_runtime(destination)


if __name__ == "__main__":
    main()
