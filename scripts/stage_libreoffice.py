from __future__ import annotations

import argparse
import hashlib
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


if __name__ == "__main__":
    main()
