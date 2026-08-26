from __future__ import annotations

import json
import re
import sys
from pathlib import Path


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    version = json.loads((root / "package.json").read_text(encoding="utf-8"))["version"]
    checks = {
        "package-lock.json": json.loads((root / "package-lock.json").read_text(encoding="utf-8"))["version"],
        "src-tauri/tauri.conf.json": json.loads((root / "src-tauri/tauri.conf.json").read_text(encoding="utf-8"))["version"],
        "src-tauri/Cargo.toml": re.search(r'^version = "([^"]+)"', (root / "src-tauri/Cargo.toml").read_text(encoding="utf-8"), re.MULTILINE).group(1),
        "scanner-worker/pyproject.toml": re.search(r'^version = "([^"]+)"', (root / "scanner-worker/pyproject.toml").read_text(encoding="utf-8"), re.MULTILINE).group(1),
    }
    mismatches = {name: value for name, value in checks.items() if value != version}
    if mismatches:
        print(f"Version source package.json is {version}; mismatches: {mismatches}", file=sys.stderr)
        raise SystemExit(1)
    tag = next((arg.removeprefix("--tag=") for arg in sys.argv[1:] if arg.startswith("--tag=")), "")
    if tag and tag.removeprefix("v") != version:
        print(f"Tag {tag} does not match package version {version}", file=sys.stderr)
        raise SystemExit(1)
    print(f"Version {version} is consistent")


if __name__ == "__main__":
    main()
