"""Restore the manifest-pinned sidecar, then sign only a manual macOS app.

Tauri may re-sign the sidecar while bundling. Only a verified Mach-O signature
region (and its derived __LINKEDIT sizes) may differ from the trusted input.
No worker is executed, manifests are never regenerated, and xattrs are untouched.
This is NOT the Developer-ID release path: that path must pre-sign nested
resources before generating its matching manifest, not accept a changed hash.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import struct
import subprocess


_spec = importlib.util.spec_from_file_location(
    "manual_bundle_runtime_verifier", Path(__file__).with_name("verify_runtime_manifest.py")
)
assert _spec and _spec.loader
_verifier = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_verifier)

MAX_MANIFEST_BYTES = 16 * 1024 * 1024
MAX_WORKER_BYTES = 512 * 1024 * 1024
MAX_RESOURCE_ENTRIES = 50_000
WORKER_CPUS = {
    "sbk-scanner-worker-aarch64-apple-darwin": (0x0100000C, 16_384),
    "sbk-scanner-worker-x86_64-apple-darwin": (0x01000007, 4_096),
}
CODESIGN = "/usr/bin/codesign"


def _canonical(path: Path, *, directory: bool = False) -> Path:
    path = Path(os.path.abspath(path))
    for ancestor in (path, *path.parents):
        if ancestor.is_symlink():
            raise ValueError(f"Symlink input or ancestor is not allowed: {ancestor}")
    if not (path.is_dir() if directory else path.is_file()):
        raise ValueError(f"Expected {'directory' if directory else 'file'}: {path}")
    if not directory and not stat.S_ISREG(path.stat().st_mode):
        raise ValueError(f"Expected a regular file: {path}")
    return path


def _disjoint(*paths: Path) -> None:
    for index, first in enumerate(paths):
        for second in paths[index + 1:]:
            if first == second or first in second.parents or second in first.parents:
                raise ValueError(f"Input paths overlap: {first}, {second}")


def _unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"Duplicate manifest key: {key}")
        result[key] = value
    return result


def _metadata(value: object) -> bool:
    return (
        isinstance(value, dict)
        and type(value.get("sizeBytes")) is int
        and value["sizeBytes"] >= 0
        and isinstance(value.get("sha256"), str)
        and re.fullmatch(r"[0-9a-f]{64}", value["sha256"]) is not None
    )


def _read_manifest(path: Path, worker: Path) -> tuple[dict, bytes]:
    if path.stat().st_size > MAX_MANIFEST_BYTES:
        raise ValueError("Runtime manifest exceeds the size limit")
    with path.open("rb") as stream:
        raw = stream.read(MAX_MANIFEST_BYTES + 1)
    if len(raw) > MAX_MANIFEST_BYTES:
        raise ValueError("Runtime manifest exceeds the size limit")
    try:
        manifest = json.loads(raw, object_pairs_hook=_unique_object)
    except (UnicodeError, json.JSONDecodeError) as error:
        raise ValueError("Runtime manifest is not valid JSON") from error
    if (
        not isinstance(manifest, dict)
        or set(manifest) != {"schemaVersion", "worker", "resources"}
        or type(manifest["schemaVersion"]) is not int
        or manifest["schemaVersion"] != 1
        or not _metadata(manifest["worker"])
        or set(manifest["worker"]) != {"fileName", "sizeBytes", "sha256"}
        or manifest["worker"]["fileName"] != worker.name
        or worker.name not in WORKER_CPUS
        or not isinstance(manifest["resources"], dict)
        or len(manifest["resources"]) > MAX_RESOURCE_ENTRIES
    ):
        raise ValueError("Runtime manifest or worker target is invalid")
    for relative, metadata in manifest["resources"].items():
        parsed = PurePosixPath(relative)
        if (
            not relative or parsed.is_absolute() or parsed.as_posix() != relative
            or any(part in {"", ".", ".."} for part in relative.split("/"))
            or "\\" in relative or ":" in relative
            or any(ord(character) < 32 for character in relative)
            or relative == "resource-manifest.json"
            or not _metadata(metadata) or set(metadata) != {"sizeBytes", "sha256"}
        ):
            raise ValueError(f"Unsafe runtime manifest entry: {relative}")
    return manifest, raw


def _manifest_matches(path: Path, expected: bytes) -> bool:
    if path.stat().st_size != len(expected):
        return False
    with path.open("rb") as stream:
        return stream.read(len(expected) + 1) == expected


def _resource_inventory(resources: Path, entries: dict) -> dict[str, str]:
    """Allow identical, internal framework aliases, never follow them as files."""
    files: set[str] = set()
    aliases: dict[str, str] = {}
    pending = [resources]
    count = 0
    while pending:
        directory = pending.pop()
        with os.scandir(directory) as children:
            for child in children:
                path = Path(child.path)
                relative = path.relative_to(resources).as_posix()
                count += 1
                if count > MAX_RESOURCE_ENTRIES * 3:
                    raise ValueError("Runtime inventory exceeds the entry limit")
                if "__pycache__" in path.relative_to(resources).parts or path.suffix.lower() in {".pyc", ".pyo"}:
                    raise ValueError(f"Mutable Python bytecode is not allowed: {relative}")
                if child.is_symlink():
                    target = os.readlink(path)
                    resolved = path.resolve(strict=True)
                    if Path(target).is_absolute() or not resolved.is_relative_to(resources):
                        raise ValueError(f"Runtime alias escapes resources: {relative}")
                    aliases[relative] = target
                elif child.is_dir(follow_symlinks=False):
                    pending.append(path)
                elif child.is_file(follow_symlinks=False):
                    if relative != "resource-manifest.json":
                        files.add(relative)
                else:
                    raise ValueError(f"Runtime contains a special file: {relative}")
    if files != set(entries):
        raise ValueError("Runtime file inventory does not match its manifest")
    return aliases


def _verify_runtime(root: Path, worker: Path) -> int:
    try:
        return _verifier.verify_runtime(root, worker)
    except SystemExit as error:
        raise ValueError(str(error)) from error


def _signed_code_identity(path: Path, worker_name: str) -> str:
    """Hash all non-signature bytes; validate every excluded size/range first."""
    size = path.stat().st_size
    if not 32 <= size <= MAX_WORKER_BYTES:
        raise ValueError("Unexpected worker size")
    with path.open("rb") as stream:
        header = stream.read(32)
        magic, cpu, _subtype, filetype, commands, command_bytes, _flags, _reserved = struct.unpack("<8I", header)
        expected_cpu, page_size = WORKER_CPUS[worker_name]
        if (
            magic != 0xFEEDFACF or cpu != expected_cpu or filetype != 2
            or not 1 <= commands <= 512 or not 8 <= command_bytes <= 65_536
            or 32 + command_bytes > size
        ):
            raise ValueError("Unexpected worker Mach-O architecture or commands")
        load_commands = stream.read(command_bytes)
        cursor = 0
        signature = None
        linkedit = None
        segments: list[tuple[bytes, int, int]] = []
        for _ in range(commands):
            if cursor + 8 > len(load_commands):
                raise ValueError("Truncated worker load command")
            command, length = struct.unpack_from("<II", load_commands, cursor)
            if length < 8 or length % 8 or cursor + length > len(load_commands):
                raise ValueError("Invalid worker load command length")
            if command == 0x1D:  # LC_CODE_SIGNATURE
                if signature is not None or length != 16:
                    raise ValueError("Ambiguous worker signature command")
                offset, count = struct.unpack_from("<II", load_commands, cursor + 8)
                signature = (offset, count, 32 + cursor + 12)
            if command == 0x19:  # LC_SEGMENT_64
                if length < 72:
                    raise ValueError("Truncated worker segment")
                name = load_commands[cursor + 8:cursor + 24].rstrip(b"\0")
                _address, virtual_size, offset, count = struct.unpack_from("<4Q", load_commands, cursor + 24)
                sections = struct.unpack_from("<I", load_commands, cursor + 64)[0]
                if length != 72 + sections * 80:
                    raise ValueError("Invalid worker segment sections")
                segments.append((name, offset, count))
                if name == b"__LINKEDIT":
                    if linkedit is not None or sections:
                        raise ValueError("Ambiguous worker __LINKEDIT segment")
                    linkedit = (offset, count, virtual_size, 32 + cursor)
            cursor += length
        if cursor != command_bytes or signature is None or linkedit is None:
            raise ValueError("Worker has no unique bounded signature")
        signature_offset, signature_size, signature_size_field = signature
        link_offset, link_size, virtual_size, link_command = linkedit
        if (
            signature_size < 12 or signature_offset < 32 + command_bytes
            or signature_offset + signature_size != size
            or link_offset % page_size or link_offset > signature_offset
            or link_offset + link_size != size
            or virtual_size != ((link_size + page_size - 1) // page_size) * page_size
            or any(offset + count > signature_offset for name, offset, count in segments if name != b"__LINKEDIT" and count)
        ):
            raise ValueError("Worker signature is not a final, isolated __LINKEDIT range")
        stream.seek(signature_offset)
        signature_header = stream.read(12)
        signature_magic, blob_size, blob_count = struct.unpack(">III", signature_header)
        if signature_magic != 0xFADE0CC0 or not 1 <= blob_count <= 128 or not 12 + blob_count * 8 <= blob_size <= signature_size:
            raise ValueError("Worker signature payload is not a bounded embedded signature")
        # Only these derived sizes are allowed to change during re-signing.
        ignored = ((signature_size_field, 4), (link_command + 32, 8), (link_command + 48, 8))
        stream.seek(0)
        identity = hashlib.sha256()
        position = 0
        while position < signature_offset:
            block = bytearray(stream.read(min(1024 * 1024, signature_offset - position)))
            if not block:
                raise ValueError("Worker changed while reading")
            for start, length in ignored:
                left, right = max(position, start), min(position + len(block), start + length)
                if left < right:
                    block[left - position:right - position] = bytes(right - left)
            identity.update(block)
            position += len(block)
        return identity.hexdigest()


def _run(*arguments: str) -> None:
    subprocess.run([CODESIGN, *arguments], check=True, timeout=120)


def _restore_worker(source: Path, target: Path, expected_sha: str, expected_size: int) -> None:
    """Preserve the target inode/xattrs; never copy metadata or follow a link."""
    previous = target.stat()
    if previous.st_nlink != 1 or os.path.samefile(source, target):
        raise ValueError("Worker target must not be a hard link")
    flags = os.O_WRONLY | os.O_NOFOLLOW
    descriptor = os.open(target, flags)
    with os.fdopen(descriptor, "wb") as output:
        current = os.fstat(output.fileno())
        if (current.st_dev, current.st_ino, current.st_nlink) != (previous.st_dev, previous.st_ino, 1):
            raise ValueError("Worker target changed before restoration")
        with source.open("rb") as original:
            if os.fstat(original.fileno()).st_size != expected_size:
                raise ValueError("Trusted worker changed before restoration")
            remaining = expected_size
            while remaining:
                block = original.read(min(1024 * 1024, remaining))
                if not block:
                    raise ValueError("Trusted worker changed during restoration")
                output.write(block)
                remaining -= len(block)
            if original.read(1):
                raise ValueError("Trusted worker grew during restoration")
        output.truncate()
        output.flush()
        os.fsync(output.fileno())
    if _verifier.digest(target) != expected_sha:
        raise ValueError("Restored worker does not match the trusted input")


def finalize_manual_bundle(app: Path, source_worker: Path, source_runtime: Path) -> dict[str, object]:
    app = _canonical(app, directory=True)
    source_worker = _canonical(source_worker)
    source_runtime = _canonical(source_runtime, directory=True)
    _disjoint(app, source_worker, source_runtime)
    if app.suffix != ".app" or source_worker.name not in WORKER_CPUS:
        raise ValueError("Expected a macOS app and an explicitly supported worker target")
    target_worker = _canonical(app / "Contents/MacOS/sbk-scanner-worker")
    target_runtime = _canonical(app / "Contents/Resources/scanner-runtime", directory=True)
    source_resources = _canonical(source_runtime / "resources", directory=True)
    target_resources = _canonical(target_runtime / "resources", directory=True)
    source_manifest = _canonical(source_resources / "resource-manifest.json")
    target_manifest = _canonical(target_resources / "resource-manifest.json")
    if os.path.samefile(source_worker, target_worker) or os.path.samefile(source_manifest, target_manifest) or target_worker.stat().st_nlink != 1:
        raise ValueError("Trusted inputs and app files must not be hard links")
    if not source_worker.stat().st_mode & 0o111 or not target_worker.stat().st_mode & 0o111:
        raise ValueError("Scanner worker must be executable")
    manifest, manifest_bytes = _read_manifest(source_manifest, source_worker)
    if not _manifest_matches(target_manifest, manifest_bytes):
        raise ValueError("App and trusted runtime manifests are different")
    aliases = _resource_inventory(source_resources, manifest["resources"])
    if _resource_inventory(target_resources, manifest["resources"]) != aliases:
        raise ValueError("App and trusted runtime aliases are different")
    resource_count = _verify_runtime(source_runtime, source_worker)
    # Before restoring, the source worker authenticates the app resource manifest.
    _verify_runtime(target_runtime, source_worker)
    _run("--verify", "--strict", "--verbose=2", str(source_worker))
    _run("--verify", "--strict", "--verbose=2", str(target_worker))
    identity = _signed_code_identity(source_worker, source_worker.name)
    if _signed_code_identity(target_worker, source_worker.name) != identity:
        raise ValueError("Unexpected bundled worker: bytes outside its signature changed")
    # Check again after external verification and before the only write operation.
    if not _manifest_matches(source_manifest, manifest_bytes) or not _manifest_matches(target_manifest, manifest_bytes):
        raise ValueError("Runtime manifest changed during validation")
    _verify_runtime(source_runtime, source_worker)
    worker_sha = manifest["worker"]["sha256"]
    _restore_worker(source_worker, target_worker, worker_sha, manifest["worker"]["sizeBytes"])
    _run("--force", "--sign", "-", str(app))  # Deliberately NOT --deep.
    _run("--verify", "--deep", "--strict", "--verbose=2", str(app))
    for root, worker, resources in (
        (source_runtime, source_worker, source_resources),
        (target_runtime, target_worker, target_resources),
    ):
        if not _manifest_matches(resources / "resource-manifest.json", manifest_bytes):
            raise ValueError("Runtime manifest changed during finalization")
        if _resource_inventory(resources, manifest["resources"]) != aliases:
            raise ValueError("Runtime inventory changed during finalization")
        _verify_runtime(root, worker)
    return {
        "app": str(app), "resources": resource_count,
        "workerSha256": worker_sha,
        "manifestSha256": hashlib.sha256(manifest_bytes).hexdigest(),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", type=Path, required=True)
    parser.add_argument("--source-worker", type=Path, required=True)
    parser.add_argument("--source-runtime", type=Path, required=True)
    args = parser.parse_args()
    try:
        report = finalize_manual_bundle(args.app, args.source_worker, args.source_runtime)
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        raise SystemExit(f"Manual macOS bundle finalization failed: {error}") from error
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
