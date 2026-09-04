#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import tomllib
import uuid
from pathlib import Path


def component(name: str, version: str, kind: str, license_name: str | None = None, sha256: str | None = None) -> dict:
    item = {"type": "library", "name": name, "version": version, "purl": f"pkg:{kind}/{name}@{version}"}
    if license_name:
        item["licenses"] = [{"license": {"name": license_name}}]
    if sha256:
        item["hashes"] = [{"alg": "SHA-256", "content": sha256}]
    return item


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default="release-artifacts/SBK-Tools.cyclonedx.json")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    components: dict[str, dict] = {}
    package_lock = json.loads((root / "package-lock.json").read_text(encoding="utf-8"))
    for path, value in package_lock.get("packages", {}).items():
        if not path or not value.get("version"):
            continue
        name = value.get("name") or path.rsplit("node_modules/", 1)[-1]
        item = component(name, value["version"], "npm", value.get("license"))
        components[item["purl"]] = item
    for lock_path in (
        root / "src-tauri" / "Cargo.lock",
        root / "windows-launcher" / "Cargo.lock",
        root / "windows-installer-helper" / "Cargo.lock",
    ):
        cargo = tomllib.loads(lock_path.read_text(encoding="utf-8"))
        for value in cargo.get("package", []):
            item = component(value["name"], value["version"], "cargo")
            components[item["purl"]] = item
    worker = tomllib.loads((root / "scanner-worker" / "pyproject.toml").read_text(encoding="utf-8"))
    for requirement in worker["project"].get("dependencies", []):
        name, version = requirement.split("==", 1)
        item = component(name, version, "pypi")
        components[item["purl"]] = item
    bundled = [
        component("NSIS", "3.11", "generic", "zlib/libpng"),
        component("LibreOffice", "26.2.5", "generic", "MPL-2.0 OR LGPL-3.0-or-later"),
        component("Tesseract OCR", "5", "generic", "Apache-2.0"),
        component("tessdata-fast-rus", "4.1.0", "generic", "Apache-2.0"),
        component("Microsoft Edge WebView2 Fixed Runtime", "151.0.4129.107", "generic", "Microsoft Edge WebView2 Runtime License", "f1e1c2c9b34c79ba4d88df77fb79a05441e1bd7481d6a985d76dd377cda45f33"),
    ]
    for item in bundled:
        components[item["purl"]] = item
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    serial_seed = f"sbk-tools:{package_lock['version']}:{len(components)}"
    document = {
        "bomFormat": "CycloneDX",
        "specVersion": "1.5",
        "serialNumber": f"urn:uuid:{uuid.uuid5(uuid.NAMESPACE_URL, serial_seed)}",
        "version": 1,
        "metadata": {"component": {"type": "application", "name": "SBK Tools", "version": package_lock["version"]}},
        "components": sorted(components.values(), key=lambda item: item["purl"]),
    }
    output.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
