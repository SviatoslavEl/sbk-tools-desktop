from __future__ import annotations

import io
from pathlib import Path
from typing import TYPE_CHECKING

import pypdfium2 as pdfium
from PIL import Image

if TYPE_CHECKING:
    from pypdf import PdfWriter


def render_page(document: pdfium.PdfDocument, index: int, dpi: int) -> tuple[Image.Image, tuple[float, float]]:
    page = document[index]
    size = tuple(map(float, page.get_size()))
    bitmap = page.render(scale=dpi / 72.0, rotation=0)
    image = bitmap.to_pil().convert("RGB")
    bitmap.close()
    page.close()
    return image, size


def image_page_pdf(image: Image.Image, page_size: tuple[float, float], quality: int) -> bytes:
    from reportlab.pdfgen.canvas import Canvas

    jpeg = io.BytesIO()
    image.save(jpeg, "JPEG", quality=quality, optimize=True, subsampling=1)
    jpeg.seek(0)
    output = io.BytesIO()
    canvas = Canvas(output, pagesize=page_size, pageCompression=1)
    canvas.drawInlineImage(Image.open(jpeg), 0, 0, width=page_size[0], height=page_size[1])
    canvas.showPage()
    canvas.save()
    return output.getvalue()


def append_pdf_page(writer: PdfWriter, page_pdf: bytes) -> None:
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(page_pdf))
    writer.add_page(reader.pages[0])


def write_atomic(writer: PdfWriter, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(f".{destination.name}.scandocument-part")
    try:
        with temporary.open("wb") as stream:
            writer.write(stream)
            stream.flush()
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)
