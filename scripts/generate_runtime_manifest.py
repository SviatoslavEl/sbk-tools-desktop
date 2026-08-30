from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path


def digest(path: Path) -> str:
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def generate_manifest(root: Path, worker: Path) -> dict[str, object]:
    root = root.resolve()
    resources = root / "resources"
    worker = worker.resolve()
    if not resources.is_dir() or not worker.is_file():
        raise SystemExit("Runtime resources or scanner worker are missing")

    entries: dict[str, dict[str, int | str]] = {}
    manifest_path = resources / "resource-manifest.json"
    for path in sorted(resources.rglob("*")):
        relative = path.relative_to(resources)
        if (
            not path.is_file()
            or path.is_symlink()
            or path == manifest_path
            or "__pycache__" in relative.parts
            or path.suffix.lower() in {".pyc", ".pyo"}
        ):
            continue
        entries[relative.as_posix()] = {"sizeBytes": path.stat().st_size, "sha256": digest(path)}
    payload = {
        "schemaVersion": 1,
        "worker": {"fileName": worker.name, "sizeBytes": worker.stat().st_size, "sha256": digest(worker)},
        "resources": entries,
    }
    manifest_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return payload


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate the trusted offline runtime manifest")
    parser.add_argument("--root", type=Path, required=True, help="Directory containing resources/")
    parser.add_argument("--worker", type=Path, required=True)
    args = parser.parse_args()
    payload = generate_manifest(args.root, args.worker)
    manifest_path = args.root.resolve() / "resources" / "resource-manifest.json"
    entries = payload["resources"]
    assert isinstance(entries, dict)
    print(f"{manifest_path}: {len(entries)} resources")


if __name__ == "__main__":
    main()
