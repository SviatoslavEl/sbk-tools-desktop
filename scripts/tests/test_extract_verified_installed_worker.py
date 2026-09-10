from __future__ import annotations

import hashlib
import importlib.util
import io
import json
import struct
import tarfile
from pathlib import Path

import pytest
import zstandard


spec = importlib.util.spec_from_file_location("installed_worker", Path(__file__).parents[1] / "extract_verified_installed_worker.py")
assert spec and spec.loader
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


def worker_bytes(machine: int = 0x8664) -> bytes:
    data = bytearray(256)
    data[:2] = b"MZ"
    struct.pack_into("<I", data, 0x3C, 128)
    data[128:134] = b"PE\0\0" + struct.pack("<H", machine)
    return bytes(data)


def entries(worker: bytes | None = None) -> list[tuple[str, bytes]]:
    worker = worker if worker is not None else worker_bytes()
    manifest = {
        "schemaVersion": 1,
        "worker": {
            "fileName": "sbk-scanner-worker-x86_64-pc-windows-msvc.exe",
            "sizeBytes": len(worker),
            "sha256": hashlib.sha256(worker).hexdigest(),
        },
        "resources": {},
    }
    return [
        (helper.WORKER, worker),
        (helper.MANIFEST, json.dumps(manifest).encode()),
        ("SBK-Tools-Fast.exe", b"do not extract or run"),
        ("webview2-runtime/runtime.dll", b"do not reuse"),
        ("scanner-runtime/resources/office/runtime.dll", b"do not reuse"),
    ]


def archive(tmp_path: Path, values: list[tuple[str, bytes]], link: str | None = None) -> Path:
    tar = io.BytesIO()
    with tarfile.open(fileobj=tar, mode="w") as output:
        for name, data in values:
            info = tarfile.TarInfo(name)
            info.size = len(data)
            output.addfile(info, io.BytesIO(data))
        if link:
            info = tarfile.TarInfo(link)
            info.type = tarfile.SYMTYPE
            info.linkname = "/outside/worker.exe"
            output.addfile(info)
    path = tmp_path / "payload.tar.zst"
    path.write_bytes(zstandard.ZstdCompressor(write_checksum=True).compress(tar.getvalue()))
    return path


def test_extracts_only_worker_and_manifest_without_running_anything(tmp_path: Path) -> None:
    destination = tmp_path / "extracted"
    worker = helper.extract_verified_worker(archive(tmp_path, entries()), destination)
    assert worker.read_bytes() == worker_bytes()
    assert sorted(path.name for path in destination.iterdir()) == ["resource-manifest.json", helper.WORKER]


@pytest.mark.parametrize("field,value", [("sha256", "0" * 64), ("sizeBytes", 17), ("sizeBytes", True), ("fileName", "wrong-target.exe")])
def test_rejects_manifest_mismatch(tmp_path: Path, field: str, value) -> None:
    values = entries()
    manifest = json.loads(values[1][1])
    manifest["worker"][field] = value
    values[1] = (helper.MANIFEST, json.dumps(manifest).encode())
    with pytest.raises(ValueError):
        helper.extract_verified_worker(archive(tmp_path, values), tmp_path / "extracted")


@pytest.mark.parametrize("name", ["../outside.exe", "/outside.exe", r"C:\outside.exe", r"folder\outside.exe"])
def test_rejects_unsafe_paths_even_when_not_selected(tmp_path: Path, name: str) -> None:
    with pytest.raises(ValueError, match="Unsafe"):
        helper.extract_verified_worker(archive(tmp_path, entries() + [(name, b"no")]), tmp_path / "extracted")
    assert not (tmp_path / "outside.exe").exists()


@pytest.mark.parametrize("kind", ["missing", "duplicate", "symlink", "wrong-machine", "wrong-magic", "bad-zstd-checksum"])
def test_rejects_untrusted_or_damaged_payloads(tmp_path: Path, kind: str) -> None:
    values = entries(worker_bytes(0xAA64) if kind == "wrong-machine" else b"not executable" if kind == "wrong-magic" else None)
    if kind == "missing":
        values = values[1:]
    elif kind == "duplicate":
        values.append(values[0])
    path = archive(tmp_path, values, "linked-worker.exe" if kind == "symlink" else None)
    if kind == "bad-zstd-checksum":
        damaged = bytearray(path.read_bytes())
        damaged[-1] ^= 1
        path.write_bytes(damaged)
    with pytest.raises((ValueError, zstandard.ZstdError)):
        helper.extract_verified_worker(path, tmp_path / "extracted")


def test_does_not_overwrite_an_existing_extraction_directory(tmp_path: Path) -> None:
    destination = tmp_path / "extracted"
    destination.mkdir()
    sentinel = destination / "keep.txt"
    sentinel.write_text("preserve")
    with pytest.raises(FileExistsError):
        helper.extract_verified_worker(archive(tmp_path, entries()), destination)
    assert sentinel.read_text() == "preserve"
