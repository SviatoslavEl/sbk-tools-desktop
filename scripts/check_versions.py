from __future__ import annotations

import json
import re
import sys
from pathlib import Path


def locked_package_version(path: Path, name: str) -> str:
    # Cargo generates one [[package]] block per package. Read only the named
    # local package, not similarly-versioned dependencies or lock format 4.
    blocks = re.split(r"(?m)^\[\[package\]\][ \t]*(?:#.*)?$", path.read_text(encoding="utf-8"))[1:]
    versions = []
    for block in blocks:
        if not re.search(rf'(?m)^name\s*=\s*"{re.escape(name)}"[ \t]*(?:#.*)?$', block):
            continue
        match = re.search(r'(?m)^version\s*=\s*"([^"]+)"[ \t]*(?:#.*)?$', block)
        if not match:
            raise ValueError(f"{path.name} has no version for local package {name}")
        versions.append(match.group(1))
    if len(versions) != 1:
        raise ValueError(f"{path.name} must contain exactly one local package {name}")
    return versions[0]


def check_versions(root: Path, tag: str = "") -> str:
    version = json.loads((root / "package.json").read_text(encoding="utf-8"))["version"]
    package_lock = json.loads((root / "package-lock.json").read_text(encoding="utf-8"))
    checks = {
        "package-lock.json": package_lock["version"],
        'package-lock.json packages[""]': package_lock["packages"][""]["version"],
        "src-tauri/tauri.conf.json": json.loads((root / "src-tauri/tauri.conf.json").read_text(encoding="utf-8"))["version"],
        "src-tauri/Cargo.toml": re.search(r'^version = "([^"]+)"', (root / "src-tauri/Cargo.toml").read_text(encoding="utf-8"), re.MULTILINE).group(1),
        "src-tauri/Cargo.lock": locked_package_version(root / "src-tauri/Cargo.lock", "sbk-tools-desktop"),
        "scanner-worker/pyproject.toml": re.search(r'^version = "([^"]+)"', (root / "scanner-worker/pyproject.toml").read_text(encoding="utf-8"), re.MULTILINE).group(1),
        "scanner-worker/src/scandocument/__init__.py": re.search(r'^__version__ = "([^"]+)"', (root / "scanner-worker/src/scandocument/__init__.py").read_text(encoding="utf-8"), re.MULTILINE).group(1),
        # The portable launcher stays frozen at 2.8.3, independently of the
        # bundled application's version (enforced by the installed contract).
        "windows-installer-helper/Cargo.toml": re.search(r'^version = "([^"]+)"', (root / "windows-installer-helper/Cargo.toml").read_text(encoding="utf-8"), re.MULTILINE).group(1),
        "windows-installer-helper/Cargo.lock": locked_package_version(root / "windows-installer-helper/Cargo.lock", "sbk-tools-installed-extractor"),
    }
    mismatches = {name: value for name, value in checks.items() if value != version}
    if mismatches:
        raise ValueError(f"Version source package.json is {version}; mismatches: {mismatches}")
    if tag and tag.removeprefix("v") != version:
        raise ValueError(f"Tag {tag} does not match package version {version}")
    return version


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    tag = next((arg.removeprefix("--tag=") for arg in sys.argv[1:] if arg.startswith("--tag=")), "")
    try:
        version = check_versions(root, tag)
    except (OSError, ValueError, KeyError, AttributeError, TypeError) as error:
        print(f"Version consistency check failed: {error}", file=sys.stderr)
        raise SystemExit(1)
    print(f"Version {version} is consistent")


if __name__ == "__main__":
    main()
