from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath


def digest(path: Path) -> str:
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def verify_file(path: Path, metadata: object) -> None:
    if not isinstance(metadata, dict):
        raise SystemExit(f"Invalid runtime metadata for {path}")
    expected_size = metadata.get("sizeBytes")
    expected_digest = metadata.get("sha256")
    if not path.is_file():
        raise SystemExit(f"Runtime component is missing: {path}")
    if path.stat().st_size != expected_size:
        raise SystemExit(
            f"Runtime component size mismatch: {path} "
            f"(expected {expected_size}, found {path.stat().st_size})"
        )
    if digest(path) != expected_digest:
        raise SystemExit(f"Runtime component digest mismatch: {path}")


def verify_runtime(root: Path, worker: Path) -> int:
    root = root.resolve()
    worker = worker.resolve()
    resources = root / "resources"
    manifest_path = resources / "resource-manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise SystemExit(f"Runtime manifest cannot be read: {error}") from error
    if manifest.get("schemaVersion") != 1 or not isinstance(manifest.get("resources"), dict):
        raise SystemExit("Runtime manifest has an unsupported schema")
    verify_file(worker, manifest.get("worker"))
    entries = manifest["resources"]
    for relative, metadata in entries.items():
        if not isinstance(relative, str):
            raise SystemExit("Runtime manifest contains a non-string path")
        path = PurePosixPath(relative)
        if path.is_absolute() or not path.parts or any(part in {"", ".", ".."} for part in path.parts):
            raise SystemExit(f"Runtime manifest contains an unsafe path: {relative}")
        verify_file(resources.joinpath(*path.parts), metadata)
    bytecode = [
        path for path in resources.rglob("*")
        if path.is_file() and (path.suffix.lower() in {".pyc", ".pyo"} or "__pycache__" in path.parts)
    ]
    if bytecode:
        raise SystemExit(f"Mutable Python bytecode is packaged in the runtime: {bytecode[0]}")
    return len(entries)


def main() -> None:
    parser = argparse.ArgumentParser(description="Verify a packaged scanner runtime")
    parser.add_argument("--root", type=Path, required=True, help="scanner-runtime directory")
    parser.add_argument("--worker", type=Path, required=True)
    args = parser.parse_args()
    count = verify_runtime(args.root, args.worker)
    print(f"Verified packaged scanner runtime: {count} resources")


if __name__ == "__main__":
    main()
