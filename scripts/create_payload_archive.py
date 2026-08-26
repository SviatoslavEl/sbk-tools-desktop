from __future__ import annotations

import argparse
import tarfile
from pathlib import Path

import zstandard


def main() -> None:
    parser = argparse.ArgumentParser(description="Create a deterministic solid Windows payload")
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    root = args.root.resolve()
    if not root.is_dir():
        raise SystemExit(f"Payload directory does not exist: {root}")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    compressor = zstandard.ZstdCompressor(level=19, threads=-1, write_checksum=True)
    with args.output.open("wb") as raw, compressor.stream_writer(raw) as compressed:
        with tarfile.open(fileobj=compressed, mode="w|") as archive:
            for source in sorted(root.rglob("*"), key=lambda item: item.as_posix().lower()):
                relative = source.relative_to(root)
                info = archive.gettarinfo(str(source), arcname=relative.as_posix())
                info.mtime = 0
                info.uid = info.gid = 0
                info.uname = info.gname = ""
                if source.is_file():
                    with source.open("rb") as stream:
                        archive.addfile(info, stream)
                else:
                    archive.addfile(info)


if __name__ == "__main__":
    main()
