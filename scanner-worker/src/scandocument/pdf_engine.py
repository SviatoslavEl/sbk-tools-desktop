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


def configure_pdfa_2b(writer: PdfWriter) -> None:
    from PIL import ImageCms
    from pypdf.generic import ArrayObject, DictionaryObject, NameObject, NumberObject, StreamObject, TextStringObject

    writer.pdf_header = "%PDF-1.7"
    profile = StreamObject()
    profile.set_data(ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes())
    profile.update({NameObject("/N"): NumberObject(3)})
    profile_ref = writer._add_object(profile)
    intent = DictionaryObject({
        NameObject("/Type"): NameObject("/OutputIntent"),
        NameObject("/S"): NameObject("/GTS_PDFA1"),
        NameObject("/OutputConditionIdentifier"): TextStringObject("sRGB IEC61966-2.1"),
        NameObject("/Info"): TextStringObject("sRGB IEC61966-2.1"),
        NameObject("/DestOutputProfile"): profile_ref,
    })
    writer._root_object[NameObject("/OutputIntents")] = ArrayObject([writer._add_object(intent)])
    xmp = b'''<?xpacket begin="\xef\xbb\xbf" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/"><pdfaid:part>2</pdfaid:part><pdfaid:conformance>B</pdfaid:conformance></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>'''
    metadata = StreamObject()
    metadata.set_data(xmp)
    metadata.update({NameObject("/Type"): NameObject("/Metadata"), NameObject("/Subtype"): NameObject("/XML")})
    writer._root_object[NameObject("/Metadata")] = writer._add_object(metadata)


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
