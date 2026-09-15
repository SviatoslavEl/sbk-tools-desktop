"""Bounded, best-effort cache of unfiltered page rasters between worker launches."""
from __future__ import annotations

import hashlib
import json
import os
import tempfile
from pathlib import Path

from PIL import Image

MAX_CACHE_BYTES = 128 * 1024 * 1024
# A page has an unfiltered and a processed raster; keep at most 32 such pairs.
MAX_CACHE_PAGES = 64
MAX_CONVERSION_CACHE_BYTES = 512 * 1024 * 1024
MAX_CONVERSION_CACHE_FILES = 4


def prune_converted_documents(directory: Path, current: Path) -> None:
    """Keep a few reusable DOCX conversions; never walk outside this cache."""
    try:
        entries = []
        for path in directory.glob("docx-*.pdf"):
            try:
                stat = path.stat()
                entries.append((path == current, stat.st_mtime_ns, stat.st_size, path))
            except OSError:
                continue
        total = 0
        for index, (_, _, size, path) in enumerate(sorted(entries, reverse=True)):
            total += size
            if path != current and (index >= MAX_CONVERSION_CACHE_FILES or total > MAX_CONVERSION_CACHE_BYTES):
                try:
                    path.unlink(missing_ok=True)
                    path.with_suffix(".warnings.json").unlink(missing_ok=True)
                except OSError:
                    # An active parser on Windows may still own the file.
                    pass
    except OSError:
        pass


def source_fingerprint(source: Path) -> str:
    """Identify the selected revision, including same-size atomic replacements."""
    stat = source.stat()
    return hashlib.sha256(
        f"source-v2\0{source.resolve()}\0{stat.st_size}\0{stat.st_mtime_ns}\0"
        f"{stat.st_ctime_ns}\0{stat.st_dev}\0{stat.st_ino}".encode()
    ).hexdigest()


def raster_key(source: Path, page: int, dpi: int) -> str:
    return hashlib.sha256(
        f"raster-v2\0{source_fingerprint(source)}\0{page}\0{dpi}".encode()
    ).hexdigest()


def processed_key(original_key: str, settings: dict, seed: int) -> str:
    from scandocument import __version__

    encoded = json.dumps(settings, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(f"processed-v1\0{__version__}\0{original_key}\0{seed}\0{encoded}".encode()).hexdigest()


def read_raster(directory: Path | None, key: str) -> Image.Image | None:
    if directory is None:
        return None
    path = directory / f"raster-{key}.png"
    try:
        with Image.open(path) as image:
            result = image.convert("RGB")
        path.touch()
        return result
    except (OSError, ValueError):
        return None


def write_raster(directory: Path | None, key: str, image: Image.Image) -> None:
    if directory is None:
        return
    temporary: Path | None = None
    try:
        directory.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=directory, prefix="raster-", suffix=".tmp", delete=False) as file:
            temporary = Path(file.name)
            image.save(file, format="PNG", compress_level=1)
        os.replace(temporary, directory / f"raster-{key}.png")
        entries = sorted(
            ((path.stat().st_mtime_ns, path.stat().st_size, path) for path in directory.glob("raster-*.png")),
            reverse=True,
        )
        total = 0
        for index, (_, size, path) in enumerate(entries):
            total += size
            if index >= MAX_CACHE_PAGES or total > MAX_CACHE_BYTES:
                path.unlink(missing_ok=True)
    except OSError:
        # A cache miss/full disk must never prevent previewing the document.
        pass
    finally:
        if temporary is not None:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass
