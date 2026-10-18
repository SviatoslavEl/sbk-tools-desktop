"""Build-only, deterministic private-family derivation; never imported by worker.

Install fonttools==4.60.1 in an isolated development environment, then supply
the unmodified fonts from the checksum-pinned LibreOffice package in SOURCE.json.
Only name metadata changes. All layout, cmap and outline tables must stay exact.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import struct
from pathlib import Path

FAMILY = "SBK Proposal Sans"
POSTSCRIPT = "SBKProposalSans"
FONTTOOLS_VERSION = "4.60.1"


def derive(source: Path, output: Path, pin: str, expected: str) -> str:
    import fontTools
    from fontTools.ttLib import TTFont

    if fontTools.__version__ != FONTTOOLS_VERSION:
        raise ValueError(f"Use exactly fonttools=={FONTTOOLS_VERSION}; not a worker dependency")
    original = source.read_bytes()
    if hashlib.sha256(original).hexdigest() != pin:
        raise ValueError(f"Source font checksum mismatch: {source.name}")
    variant = source.stem.removeprefix("NotoSans-")
    style = "Bold Italic" if variant == "BoldItalic" else variant
    font = TTFont(io.BytesIO(original), lazy=True, recalcBBoxes=False, recalcTimestamp=False)
    preserved = {tag: font.reader[tag] for tag in font.keys() if tag not in ("GlyphOrder", "name", "head", "DSIG")}
    replacements = {1: FAMILY, 2: style, 3: f"SBK-Proposal-Sans-1;{pin[:16]}", 4: f"{FAMILY} {style}",
                    6: f"{POSTSCRIPT}-{variant}", 16: FAMILY, 17: style, 18: f"{FAMILY} {style}", 21: FAMILY, 22: style}
    for record in font["name"].names:
        if record.nameID in replacements:
            record.string = replacements[record.nameID].encode(record.getEncoding())
    if "DSIG" in font:
        del font["DSIG"]  # Any original signature no longer describes this derivative.
    buffer = io.BytesIO()
    font.save(buffer, reorderTables=False)
    data = buffer.getvalue()
    derived = TTFont(io.BytesIO(data), lazy=True, recalcTimestamp=False)
    for tag, value in preserved.items():
        if derived.reader[tag] != value:
            raise ValueError(f"Derivation changed non-name table {tag}")
    old_head, new_head = font.reader["head"], derived.reader["head"]
    if old_head[:8] + old_head[12:] != new_head[:8] + new_head[12:]:
        raise ValueError("Derivation changed font metrics or timestamps")
    padded = data + b"\0" * (-len(data) % 4)
    if sum(struct.unpack(f">{len(padded) // 4}I", padded)) & 0xFFFFFFFF != 0xB1B0AFBA:
        raise ValueError("Invalid complete SFNT checksum")
    digest = hashlib.sha256(data).hexdigest()
    if digest != expected:
        raise ValueError(f"Derived font checksum differs from reviewed pin: {output.name}")
    output.write_bytes(data)
    return digest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--pins", type=Path, required=True)
    args = parser.parse_args()
    metadata = json.loads(args.pins.read_text())
    args.output.mkdir(parents=True, exist_ok=True)
    results = {}
    for name, digest in metadata["upstreamFiles"].items():
        target = name.replace("NotoSans-", f"{POSTSCRIPT}-")
        results[target] = derive(args.source / name, args.output / target, digest, metadata["files"][target])
    print(json.dumps(results, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
