from __future__ import annotations

import io
import os
import hashlib
from html import escape
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


def _jpeg_for_budget(image: Image.Image, quality: int, target_bytes: int | None) -> bytes:
    def encode(selected_quality: int) -> bytes:
        buffer = io.BytesIO()
        image.save(buffer, "JPEG", quality=selected_quality, optimize=True, subsampling=1)
        return buffer.getvalue()

    maximum = max(55, min(100, int(quality)))
    if target_bytes is None:
        return encode(maximum)
    target = max(8_192, int(target_bytes * 0.94))
    low, high = 55, maximum
    best = encode(low)
    if len(best) > target:
        return best
    while low <= high:
        candidate_quality = (low + high) // 2
        candidate = encode(candidate_quality)
        if len(candidate) <= target:
            best = candidate
            low = candidate_quality + 1
        else:
            high = candidate_quality - 1
    return best


class StreamingPdfWriter:
    """Write raster PDF pages directly to disk with bounded Python memory.

    The scanner always produces raster pages, so retaining a ``pypdf.PdfWriter``
    object graph (including every JPEG) until the end is unnecessary.  This
    writer emits page/image/content objects immediately and keeps only xref
    offsets and page object numbers.  The optional OCR layer uses an invisible
    Type3 font with a ToUnicode map, keeping searchable Russian/English text
    without embedding a second copy of every page.
    """

    _CATALOG_ID = 1
    _PAGES_ID = 2
    _FONT_ID = 3
    _CHARPROC_ID = 4
    _TO_UNICODE_ID = 5
    _METADATA_ID = 6
    _ICC_ID = 7
    _OUTPUT_INTENT_ID = 8
    _INFO_ID = 9

    def __init__(self, destination: Path, title: str, seed: int, pdfa: bool = False) -> None:
        from scandocument.tempfiles import SecureWorkspace

        self.destination = destination
        self.destination.parent.mkdir(parents=True, exist_ok=True)
        self.temporary, self._journal = SecureWorkspace.register_output_part(destination)
        try:
            self._stream = self.temporary.open("xb")
        except Exception:
            self._journal.unlink(missing_ok=True)
            raise
        self._stream.write(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
        self._offsets: dict[int, int] = {}
        self._page_ids: list[int] = []
        self._next_id = 10
        # A simple Type3 font has 255 usable character codes. Additional banks
        # are allocated lazily, so OCR text is never truncated to one alphabet.
        self._font_banks: list[tuple[int, int, int, dict[str, int]]] = [
            (self._FONT_ID, self._CHARPROC_ID, self._TO_UNICODE_ID, {})
        ]
        self._title = title
        self._seed = seed
        self._pdfa = pdfa
        self._finished = False

    def _write_object(self, object_id: int, payload: bytes) -> None:
        self._offsets[object_id] = self._stream.tell()
        self._stream.write(f"{object_id} 0 obj\n".encode("ascii"))
        self._stream.write(payload)
        self._stream.write(b"\nendobj\n")

    def _write_stream(self, object_id: int, dictionary: bytes, payload: bytes) -> None:
        header = dictionary.rstrip(b">>") + f" /Length {len(payload)} >>\nstream\n".encode("ascii")
        self._write_object(object_id, header + payload + b"\nendstream")

    def _character_code(self, character: str) -> tuple[int, int]:
        for bank_index, (_font_id, _charproc_id, _unicode_id, characters) in enumerate(self._font_banks):
            existing = characters.get(character)
            if existing is not None:
                return bank_index, existing
        font_id, charproc_id, unicode_id = self._font_banks[-1][:3]
        characters = self._font_banks[-1][3]
        if len(characters) >= 255:
            font_id, charproc_id, unicode_id = self._next_id, self._next_id + 1, self._next_id + 2
            self._next_id += 3
            characters = {}
            self._font_banks.append((font_id, charproc_id, unicode_id, characters))
        code = len(characters) + 1
        characters[character] = code
        return len(self._font_banks) - 1, code

    def _ocr_content(
        self, words, image_size: tuple[int, int], page_size: tuple[float, float]
    ) -> tuple[bytes, set[int]]:
        if not words:
            return b"", set()
        sx = page_size[0] / max(1, image_size[0])
        sy = page_size[1] / max(1, image_size[1])
        commands: list[str] = []
        used_banks: set[int] = set()
        for word in words:
            font_size = max(3.0, word.height * sy * 0.86)
            x = word.left * sx
            y = page_size[1] - (word.top + word.height) * sy
            runs: list[tuple[int, bytearray]] = []
            for character in f"{word.text} ":
                bank_index, code = self._character_code(character)
                used_banks.add(bank_index)
                if not runs or runs[-1][0] != bank_index:
                    runs.append((bank_index, bytearray()))
                runs[-1][1].append(code)
            cursor = x
            for bank_index, encoded in runs:
                commands.append(
                    f"BT /Focr{bank_index + 1} {font_size:.3f} Tf 3 Tr 1 0 0 1 "
                    f"{cursor:.3f} {y:.3f} Tm <{encoded.hex()}> Tj ET"
                )
                cursor += len(encoded) * font_size * 0.5
        return ("\n".join(commands) + "\n").encode("ascii"), used_banks

    def add_page(
        self,
        jpeg: bytes,
        page_size: tuple[float, float],
        image_size: tuple[int, int],
        words=None,
    ) -> None:
        image_id, content_id, page_id = self._next_id, self._next_id + 1, self._next_id + 2
        self._next_id += 3
        image_name = f"Im{len(self._page_ids) + 1}"
        width, height = image_size
        image_dictionary = (
            f"<< /Type /XObject /Subtype /Image /Width {width} /Height {height} "
            "/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode >>"
        ).encode("ascii")
        self._write_stream(image_id, image_dictionary, jpeg)
        page_width, page_height = page_size
        ocr_content, used_banks = self._ocr_content(words, image_size, page_size)
        content = f"q {page_width:.4f} 0 0 {page_height:.4f} 0 0 cm /{image_name} Do Q\n".encode("ascii") + ocr_content
        self._write_stream(content_id, b"<< >>", content)
        resources = f"/XObject << /{image_name} {image_id} 0 R >>"
        if used_banks:
            fonts = " ".join(
                f"/Focr{bank_index + 1} {self._font_banks[bank_index][0]} 0 R"
                for bank_index in sorted(used_banks)
            )
            resources += f" /Font << {fonts} >>"
        page = (
            f"<< /Type /Page /Parent {self._PAGES_ID} 0 R "
            f"/MediaBox [0 0 {page_width:.4f} {page_height:.4f}] "
            f"/Resources << {resources} >> /Contents {content_id} 0 R >>"
        ).encode("ascii")
        self._write_object(page_id, page)
        self._page_ids.append(page_id)

    @staticmethod
    def _unicode_cmap(characters: dict[str, int]) -> bytes:
        mappings = sorted(((code, char) for char, code in characters.items()))
        chunks = [
            "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n"
            "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n"
            "/CMapName /ScanDocumentOCR def\n/CMapType 2 def\n"
            "1 begincodespacerange\n<00> <FF>\nendcodespacerange\n"
        ]
        for start in range(0, len(mappings), 100):
            group = mappings[start:start + 100]
            chunks.append(f"{len(group)} beginbfchar\n")
            for code, character in group:
                target = character.encode("utf-16-be").hex().upper()
                chunks.append(f"<{code:02X}> <{target}>\n")
            chunks.append("endbfchar\n")
        chunks.append("endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n")
        return "".join(chunks).encode("ascii")

    @staticmethod
    def _utf16_hex(value: str) -> str:
        return "FEFF" + value.encode("utf-16-be").hex().upper()

    def finish(self) -> None:
        if self._finished:
            return
        try:
            for bank_index, (font_id, charproc_id, unicode_id, characters) in enumerate(self._font_banks):
                character_count = max(1, len(characters))
                names = " ".join(f"/g{index}" for index in range(1, character_count + 1))
                char_procs = " ".join(
                    f"/g{index} {charproc_id} 0 R" for index in range(1, character_count + 1)
                )
                widths = " ".join("500" for _ in range(character_count))
                font = (
                    f"<< /Type /Font /Subtype /Type3 /Name /Focr{bank_index + 1} /FontBBox [0 0 1 1] "
                    f"/FontMatrix [0.001 0 0 0.001 0 0] /CharProcs << {char_procs} >> "
                    f"/Encoding << /Type /Encoding /Differences [1 {names}] >> "
                    f"/FirstChar 1 /LastChar {character_count} /Widths [{widths}] /Resources << >> "
                    f"/ToUnicode {unicode_id} 0 R >>"
                ).encode("ascii")
                self._write_object(font_id, font)
                self._write_stream(charproc_id, b"<< >>", b"")
                self._write_stream(unicode_id, b"<< >>", self._unicode_cmap(characters))

            escaped_title = escape(self._title)
            xmp = (
                '<?xpacket begin="\ufeff" id="W5M0MpCehiHzreSzNTczkc9d"?>'
                '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
                '<rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/" '
                'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:pdf="http://ns.adobe.com/pdf/1.3/">'
                f'<pdfaid:part>{2 if self._pdfa else 0}</pdfaid:part><pdfaid:conformance>{"B" if self._pdfa else ""}</pdfaid:conformance>'
                f'<dc:title><rdf:Alt><rdf:li xml:lang="x-default">{escaped_title}</rdf:li></rdf:Alt></dc:title>'
                '<pdf:Producer>ScanDocument</pdf:Producer>'
                '</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>'
            ).encode("utf-8")
            self._write_stream(self._METADATA_ID, b"<< /Type /Metadata /Subtype /XML >>", xmp)
            from PIL import ImageCms

            profile = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
            self._write_stream(self._ICC_ID, b"<< /N 3 >>", profile)
            intent = (
                f"<< /Type /OutputIntent /S /GTS_PDFA1 /OutputConditionIdentifier (sRGB IEC61966-2.1) "
                f"/Info (sRGB IEC61966-2.1) /DestOutputProfile {self._ICC_ID} 0 R >>"
            ).encode("ascii")
            self._write_object(self._OUTPUT_INTENT_ID, intent)
            self._write_object(
                self._INFO_ID,
                f"<< /Producer (ScanDocument) /Title <{self._utf16_hex(self._title)}> "
                f"/ScanDocumentSeed ({self._seed}) >>".encode("ascii"),
            )
            kids = " ".join(f"{page_id} 0 R" for page_id in self._page_ids)
            self._write_object(
                self._PAGES_ID,
                f"<< /Type /Pages /Count {len(self._page_ids)} /Kids [{kids}] >>".encode("ascii"),
            )
            catalog_extras = (
                f" /Metadata {self._METADATA_ID} 0 R /OutputIntents [{self._OUTPUT_INTENT_ID} 0 R]"
                if self._pdfa else ""
            )
            self._write_object(
                self._CATALOG_ID,
                f"<< /Type /Catalog /Pages {self._PAGES_ID} 0 R{catalog_extras} >>".encode("ascii"),
            )
            xref_offset = self._stream.tell()
            maximum_id = self._next_id - 1
            self._stream.write(f"xref\n0 {maximum_id + 1}\n".encode("ascii"))
            self._stream.write(b"0000000000 65535 f \n")
            for object_id in range(1, maximum_id + 1):
                self._stream.write(f"{self._offsets[object_id]:010d} 00000 n \n".encode("ascii"))
            file_identifier = hashlib.sha256(
                f"ScanDocument\0{self._title}\0{self._seed}\0{len(self._page_ids)}".encode("utf-8")
            ).digest()[:16].hex().upper()
            self._stream.write(
                f"trailer\n<< /Size {maximum_id + 1} /Root {self._CATALOG_ID} 0 R /Info {self._INFO_ID} 0 R "
                f"/ID [<{file_identifier}> <{file_identifier}>] >>\n"
                f"startxref\n{xref_offset}\n%%EOF\n".encode("ascii")
            )
            self._stream.flush()
            os.fsync(self._stream.fileno())
            self._stream.close()
            self.temporary.replace(self.destination)
            self._finished = True
            self._journal.unlink(missing_ok=True)
        finally:
            if not self._finished:
                self.abort()

    def abort(self) -> None:
        if not self._stream.closed:
            self._stream.close()
        self.temporary.unlink(missing_ok=True)
        self._journal.unlink(missing_ok=True)


def image_page_pdf(
    image: Image.Image,
    page_size: tuple[float, float],
    quality: int,
    target_bytes: int | None = None,
) -> bytes:
    from reportlab.pdfgen.canvas import Canvas

    jpeg = io.BytesIO(_jpeg_for_budget(image, quality, target_bytes))
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
