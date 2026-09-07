"""Build a tiny packaging fixture, never a distributable application."""
import io
from pathlib import Path
import re
import sys
import tarfile

import zstandard

source = Path(__file__).resolve().parents[1] / "windows-installer-helper/src/main.rs"
required = source.read_text(encoding="utf-8").split("const REQUIRED_FILES:", 1)[1].split("];", 1)[0]
with Path(sys.argv[1]).open("wb") as target:
    with zstandard.ZstdCompressor().stream_writer(target) as compressed:
        with tarfile.open(fileobj=compressed, mode="w|") as archive:
            for name in re.findall(r'"([^"]+)"', required):
                data = b"SBK installer test fixture\n"
                entry = tarfile.TarInfo(name)
                entry.size = len(data)
                archive.addfile(entry, io.BytesIO(data))
