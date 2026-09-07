"""Bounded, best-effort cache of unfiltered page rasters between worker launches."""
from __future__ import annotations

import hashlib
import os
import tempfile
from pathlib import Path

from PIL import Image

MAX_CACHE_BYTES = 96 * 1024 * 1024
MAX_CACHE_PAGES = 32


def raster_key(source: Path, page: int, dpi: int) -> str:
    stat = source.stat()
    return hashlib.sha256(
        f"raster-v1\0{source.resolve()}\0{stat.st_size}\0{stat.st_mtime_ns}\0{page}\0{dpi}".encode()
    ).hexdigest()


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
