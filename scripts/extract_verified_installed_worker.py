"""Extract only a verified worker from an already authenticated installer payload."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import struct
import tarfile
from pathlib import Path, PurePosixPath

import zstandard


WORKER = "sbk-scanner-worker.exe"
MANIFEST = "scanner-runtime/resources/resource-manifest.json"
LIMITS = {WORKER: 512 * 1024 * 1024, MANIFEST: 16 * 1024 * 1024}
MAX_PAYLOAD = 16 * 1024 * 1024 * 1024


class LimitedReader:
    def __init__(self, stream):
        self.stream = stream
        self.consumed = 0

    def read(self, size: int = -1) -> bytes:
        data = self.stream.read(min(size if size >= 0 else 1024 * 1024, MAX_PAYLOAD - self.consumed + 1))
        self.consumed += len(data)
        if self.consumed > MAX_PAYLOAD:
            raise ValueError("Installer payload exceeds the extraction limit")
        return data


def extract_verified_worker(archive: Path, directory: Path) -> Path:
    directory.mkdir(parents=True, exist_ok=False)
    extracted: dict[str, Path] = {}
    with archive.open("rb") as raw, zstandard.ZstdDecompressor().stream_reader(raw) as stream:
        reader = LimitedReader(stream)
        with tarfile.open(fileobj=reader, mode="r|") as payload:
            for member in payload:
                name = member.name
                relative = PurePosixPath(name)
                if relative.is_absolute() or ".." in relative.parts or "\\" in name or ":" in name:
                    raise ValueError("Unsafe installer payload path")
                if not (member.isfile() or member.isdir()) or member.issparse():
                    raise ValueError("Links and special files are not allowed in a reusable payload")
                if name not in LIMITS:
                    continue
                if name in extracted or not member.isfile() or not 0 < member.size <= LIMITS[name]:
                    raise ValueError("Duplicate, oversized, or invalid worker/manifest entry")
                source = payload.extractfile(member)
                if source is None:
                    raise ValueError("Cannot read worker/manifest entry")
                destination = directory / (WORKER if name == WORKER else "resource-manifest.json")
                with source, destination.open("xb") as output:
                    while block := source.read(1024 * 1024):
                        output.write(block)
                if destination.stat().st_size != member.size:
                    raise ValueError("Truncated worker/manifest entry")
                extracted[name] = destination
        # Drain the zstd frame so its checksum/truncation errors cannot be hidden
        # behind tar's end-of-archive padding. No runtime files are extracted.
        while reader.read(1024 * 1024):
            pass
    if set(extracted) != set(LIMITS):
        raise ValueError("Installer payload does not contain the worker and trusted manifest")
    manifest = json.loads(extracted[MANIFEST].read_text(encoding="utf-8"))
    if manifest.get("schemaVersion") != 1 or not isinstance(manifest.get("resources"), dict):
        raise ValueError("Unsupported trusted runtime manifest")
    expected = manifest.get("worker", {})
    if (expected.get("fileName") != "sbk-scanner-worker-x86_64-pc-windows-msvc.exe"
            or type(expected.get("sizeBytes")) is not int
            or not re.fullmatch(r"[a-fA-F0-9]{64}", str(expected.get("sha256", "")))):
        raise ValueError("Invalid Windows x64 worker manifest entry")
    worker = extracted[WORKER]
    with worker.open("rb") as source:
        digest = hashlib.file_digest(source, "sha256").hexdigest()
        source.seek(0)
        header = source.read(64)
        if len(header) < 64 or header[:2] != b"MZ":
            raise ValueError("Worker is not a Windows executable")
        source.seek(struct.unpack_from("<I", header, 0x3C)[0])
        if source.read(6) != b"PE\0\0\x64\x86":
            raise ValueError("Worker is not a Windows x64 PE executable")
    if worker.stat().st_size != expected["sizeBytes"] or digest != expected["sha256"].lower():
        raise ValueError("Worker size/SHA256 does not match the trusted manifest")
    return worker


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--directory", type=Path, required=True)
    args = parser.parse_args()
    print(extract_verified_worker(args.archive, args.directory))


if __name__ == "__main__":
    main()
