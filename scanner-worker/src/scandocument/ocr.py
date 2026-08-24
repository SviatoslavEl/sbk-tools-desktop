from __future__ import annotations

import csv
import io
import os
import subprocess
from dataclasses import dataclass
from pathlib import Path

from PIL import Image
from pypdf import PdfReader, PdfWriter
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen.canvas import Canvas

from scandocument.errors import OcrUnavailableError
from scandocument.resources import bundle_root, find_font, find_tessdata, find_tesseract


@dataclass(slots=True)
class OcrWord:
    text: str
    left: int
    top: int
    width: int
    height: int
    confidence: float
    block: int = 0
    paragraph: int = 0
    line: int = 0


def recognize_words(image: Image.Image, languages: str, workdir: Path) -> list[OcrWord]:
    executable = find_tesseract()
    if not executable:
        raise OcrUnavailableError("В сборку не включён локальный OCR-модуль.") from FileNotFoundError(
            f"OCR runtime was not found below resource root: {bundle_root()}"
        )
    # PPM is deliberately used here: the release OCR binary is statically linked
    # with a minimal Leptonica build and therefore needs no bundled image codecs.
    image_path = workdir / "ocr-input.ppm"
    image.convert("RGB").save(image_path, "PPM")
    env = os.environ.copy()
    tessdata = find_tessdata()
    if tessdata:
        env["TESSDATA_PREFIX"] = str(tessdata)
    command = [
        str(executable), str(image_path), "stdout", "-l", languages, "--psm", "3",
        "-c", "tessedit_create_tsv=1",
    ]
    try:
        result = subprocess.run(
            command, env=env, cwd=workdir, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, timeout=180, check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    finally:
        image_path.unlink(missing_ok=True)
    if result.returncode != 0:
        raise OcrUnavailableError("Локальный OCR не смог распознать страницу.")
    words: list[OcrWord] = []
    reader = csv.DictReader(io.StringIO(result.stdout.decode("utf-8", "replace")), delimiter="\t")
    for row in reader:
        text = (row.get("text") or "").strip()
        try:
            confidence = float(row.get("conf") or -1)
            if text and confidence >= 20:
                words.append(OcrWord(
                    text, int(row["left"]), int(row["top"]), int(row["width"]),
                    int(row["height"]), confidence, int(row.get("block_num") or 0),
                    int(row.get("par_num") or 0), int(row.get("line_num") or 0),
                ))
        except (KeyError, TypeError, ValueError):
            continue
    return words


def add_invisible_text(
    page_pdf: bytes,
    words: list[OcrWord],
    image_size: tuple[int, int],
    page_size: tuple[float, float],
) -> bytes:
    overlay = io.BytesIO()
    canvas = Canvas(overlay, pagesize=page_size, pageCompression=1)
    font_name = "Helvetica"
    font = find_font()
    if font:
        try:
            pdfmetrics.registerFont(TTFont("SDOCR", str(font)))
            font_name = "SDOCR"
        except Exception:
            pass
    sx, sy = page_size[0] / image_size[0], page_size[1] / image_size[1]
    lines: dict[tuple[int, int, int], list[OcrWord]] = {}
    for word in words:
        lines.setdefault((word.block, word.paragraph, word.line), []).append(word)
    for line_words in lines.values():
        line_words.sort(key=lambda item: item.left)
        first = line_words[0]
        text = canvas.beginText()
        text.setTextRenderMode(3)
        font_size = max(3.0, max(word.height for word in line_words) * sy * 0.86)
        text.setFont(font_name, font_size)
        text.setTextOrigin(first.left * sx, page_size[1] - (first.top + first.height) * sy)
        text.textOut(" ".join(word.text for word in line_words))
        canvas.drawText(text)
    canvas.showPage()
    canvas.save()
    base_reader = PdfReader(io.BytesIO(page_pdf))
    overlay_reader = PdfReader(io.BytesIO(overlay.getvalue()))
    base_reader.pages[0].merge_page(overlay_reader.pages[0])
    writer = PdfWriter()
    writer.add_page(base_reader.pages[0])
    result = io.BytesIO()
    writer.write(result)
    return result.getvalue()
