from pathlib import Path

import pypdfium2 as pdfium
import pytest
from PIL import Image, ImageDraw
from pypdf import PdfReader

from scandocument import image_engine
from scandocument.errors import CorruptDocumentError, DocumentTooLargeError, UnsupportedFormatError
from scandocument.validation import inspect_document
from scandocument.worker_cli import merge, preview_result, process


def scan_config(source: Path, output: Path) -> dict:
    return {
        "protocolVersion": 2,
        "inputPath": str(source),
        "outputPath": str(output),
        "preset": "Оригинал",
        "settings": {"dpi": 72, "jpeg_quality": 95},
    }


def test_jpeg_respects_camera_orientation_in_preview_and_export(tmp_path: Path) -> None:
    source = tmp_path / "Оборот.JPEG"
    with Image.new("RGB", (320, 180), "red") as image:
        ImageDraw.Draw(image).rectangle((160, 0, 319, 179), fill="blue")
        exif = image.getexif()
        exif[274] = 6  # Rotate 90° clockwise for display.
        image.save(source, exif=exif)
    original = source.read_bytes()

    preview = preview_result(scan_config(source, tmp_path / "preview.png"))
    assert preview["pageCount"] == 1
    with Image.open(preview["originalPath"]) as image:
        assert image.size == (180, 320)
        assert image.getpixel((90, 80))[0] > 240
        assert image.getpixel((90, 240))[2] > 240

    output = tmp_path / "Оборот.pdf"
    assert process({**scan_config(source, output), "expectedSourceFingerprint": preview["sourceFingerprint"]}) == 0
    reader = PdfReader(output)
    assert len(reader.pages) == 1
    page_size = reader.pages[0].mediabox
    assert (float(page_size.width), float(page_size.height)) == pytest.approx(preview["pageSizePoints"], abs=0.01)
    assert source.read_bytes() == original


def test_png_transparency_prints_white_after_manual_rotation(tmp_path: Path) -> None:
    source = tmp_path / "Лист.png"
    with Image.new("RGBA", (240, 120), (200, 0, 0, 0)) as image:
        ImageDraw.Draw(image).rectangle((120, 0, 239, 119), fill=(0, 128, 0, 255))
        image.save(source)
    rotation = {"pageRotations": {"0": 90}}

    preview = preview_result({**scan_config(source, tmp_path / "preview.png"), **rotation, "finalPreview": True})
    with Image.open(preview["originalPath"]) as image:
        assert image.size == (120, 240)
        assert image.getpixel((60, 60)) == (255, 255, 255)
        assert image.getpixel((60, 180)) == (0, 128, 0)

    output = tmp_path / "Лист.pdf"
    assert process({**scan_config(source, output), **rotation}) == 0
    with pdfium.PdfDocument(output) as document:
        page = document[0]
        bitmap = page.render(scale=0.3)
        try:
            assert page.get_size() == pytest.approx(preview["pageSizePoints"], abs=0.01)
            with bitmap.to_pil().convert("RGB") as image:
                assert min(image.getpixel((image.width // 2, image.height // 4))) > 245
                red, green, blue = image.getpixel((image.width // 2, image.height * 3 // 4))
                assert green > 110 and red < 15 and blue < 15
        finally:
            bitmap.close()
            page.close()


def test_images_can_be_reordered_with_pdf_pages(tmp_path: Path) -> None:
    pdf = Path(__file__).parent / "fixtures" / "simple.pdf"
    jpg, png = tmp_path / "широкий.jpg", tmp_path / "высокий.png"
    with Image.new("RGB", (240, 120), "blue") as image:
        image.save(jpg)
    with Image.new("RGB", (100, 300), "green") as image:
        image.save(png)
    output = tmp_path / "Объединение.pdf"
    assert merge({
        **scan_config(pdf, output),
        "inputPaths": [str(pdf), str(jpg), str(png)],
        "mergePageOrder": [{"sourceIndex": index, "pageIndex": 0} for index in (2, 0, 1)],
    }) == 0
    pages = PdfReader(output).pages
    assert len(pages) == 3
    assert float(pages[0].mediabox.height / pages[0].mediabox.width) == pytest.approx(3, rel=0.001)
    assert float(pages[2].mediabox.width / pages[2].mediabox.height) == pytest.approx(2, rel=0.001)


def test_image_validation_rejects_wrong_type_damage_and_oversized_files(tmp_path: Path, monkeypatch) -> None:
    source = tmp_path / "photo.png"
    with Image.new("RGB", (16, 16)) as image:
        image.save(source, format="JPEG")
        with pytest.raises(UnsupportedFormatError, match="не соответствует расширению"):
            inspect_document(source)
        image.save(source)

    with monkeypatch.context() as patch:
        patch.setattr(image_engine, "MAX_IMAGE_PIXELS", 255)
        with pytest.raises(DocumentTooLargeError, match="слишком велико"):
            inspect_document(source)

    source.write_bytes(source.read_bytes()[:20])
    with pytest.raises(CorruptDocumentError, match="не повреждён"):
        inspect_document(source)
