from __future__ import annotations

import hashlib
import io
import json
import struct
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from pathlib import Path
from typing import Any, BinaryIO
from zipfile import ZipFile


MAGIC = b"SCANDOCUMENT_PAYLOAD_V1"
FOOTER_SIZE = struct.calcsize("<Q") + len(MAGIC)
MAX_MANIFEST_SIZE = 1024 * 1024
MAX_SIGNATURE_TAIL = 4 * 1024 * 1024


class _BoundedReader(io.RawIOBase):
    def __init__(self, stream: BinaryIO, offset: int, size: int) -> None:
        self._stream = stream
        self._offset = offset
        self._size = size
        self._position = 0

    def readable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return True

    def tell(self) -> int:
        return self._position

    def seek(self, offset: int, whence: int = io.SEEK_SET) -> int:
        if whence == io.SEEK_SET:
            position = offset
        elif whence == io.SEEK_CUR:
            position = self._position + offset
        elif whence == io.SEEK_END:
            position = self._size + offset
        else:
            raise ValueError(f"Unsupported seek mode: {whence}")
        if position < 0:
            raise ValueError("Negative seek position")
        self._position = min(position, self._size)
        return self._position

    def read(self, size: int = -1) -> bytes:
        remaining = self._size - self._position
        if size is None or size < 0:
            size = remaining
        size = min(size, remaining)
        if size <= 0:
            return b""
        self._stream.seek(self._offset + self._position)
        data = self._stream.read(size)
        self._position += len(data)
        return data


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def append_payload(executable: Path, components: Mapping[str, Path]) -> None:
    """Append lazy component archives to an executable without sidecar files."""
    manifest: dict[str, Any] = {"version": 1, "components": {}}
    with executable.open("ab") as output:
        for name, source in sorted(components.items()):
            offset = output.tell()
            with source.open("rb") as stream:
                for block in iter(lambda: stream.read(1024 * 1024), b""):
                    output.write(block)
            manifest["components"][name] = {
                "offset": offset,
                "size": source.stat().st_size,
                "sha256": _sha256(source),
            }
        encoded = json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode("utf-8")
        if len(encoded) > MAX_MANIFEST_SIZE:
            raise ValueError("Embedded payload manifest is too large")
        output.write(encoded)
        output.write(struct.pack("<Q", len(encoded)))
        output.write(MAGIC)


def _read_manifest(stream: BinaryIO) -> tuple[dict[str, Any], int]:
    stream.seek(0, io.SEEK_END)
    file_size = stream.tell()
    tail_size = min(file_size, MAX_SIGNATURE_TAIL)
    stream.seek(file_size - tail_size)
    tail = stream.read(tail_size)
    magic_index = tail.rfind(MAGIC)
    if magic_index < struct.calcsize("<Q"):
        raise FileNotFoundError("ScanDocument embedded payload was not found")
    length_index = magic_index - struct.calcsize("<Q")
    manifest_size = struct.unpack("<Q", tail[length_index:magic_index])[0]
    if manifest_size <= 0 or manifest_size > MAX_MANIFEST_SIZE:
        raise OSError("ScanDocument embedded payload manifest is invalid")
    manifest_end = file_size - tail_size + length_index
    manifest_start = manifest_end - manifest_size
    if manifest_start < 0:
        raise OSError("ScanDocument embedded payload manifest is truncated")
    stream.seek(manifest_start)
    manifest = json.loads(stream.read(manifest_size).decode("utf-8"))
    if manifest.get("version") != 1 or not isinstance(manifest.get("components"), dict):
        raise OSError("ScanDocument embedded payload version is unsupported")
    return manifest, manifest_start


@contextmanager
def open_component_archive(executable: Path, component: str) -> Iterator[ZipFile]:
    stream = executable.open("rb")
    try:
        manifest, payload_end = _read_manifest(stream)
        entry = manifest["components"].get(component)
        if not isinstance(entry, dict):
            raise FileNotFoundError(f"Embedded component is missing: {component}")
        offset, size = int(entry["offset"]), int(entry["size"])
        if offset < 0 or size <= 0 or offset + size > payload_end:
            raise OSError("Embedded component bounds are invalid")
        bounded = _BoundedReader(stream, offset, size)
        with ZipFile(bounded) as archive:
            yield archive
    finally:
        stream.close()
