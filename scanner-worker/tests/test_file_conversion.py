import json
from pathlib import Path

import pytest
from PIL import Image
from pypdf import PdfReader, PdfWriter

from scandocument.errors import CorruptDocumentError, UnsupportedFormatError
from scandocument.worker_cli import convert, preview_result


def run_conversion(source: Path, directory: Path, format: str, capsys, dpi: int = 150) -> list[Path]:
    assert convert({"protocolVersion": 2, "inputPath": str(source), "outputDirectory": str(directory),
                    "outputFormat": format, "dpi": dpi}) == 0
    events = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert events[0]["type"] == "progress"
    assert events[-1]["type"] == "complete"
    return [Path(path) for path in events[-1]["outputPaths"]]


def test_pdf_pages_become_ordered_pngs_and_repeated_conversion_keeps_previous_files(tmp_path: Path, capsys):
    source = tmp_path / "Отчёт.pdf"
    writer = PdfWriter()
    writer.add_blank_page(width=72, height=144)
    writer.add_blank_page(width=144, height=72)
    writer.write(source)
    original = source.read_bytes()

    paths = run_conversion(source, tmp_path, "png", capsys, dpi=300)
    assert len(paths) == 2
    assert "стр. 1" in paths[0].name and "стр. 2" in paths[1].name
    for path, size in zip(paths, [(300, 600), (600, 300)], strict=True):
        with Image.open(path) as image:
            assert image.format == "PNG" and image.size == size
    first_pass = {path: path.read_bytes() for path in paths}

    again = run_conversion(source, tmp_path, "png", capsys)
    assert all("(2)" in path.name for path in again)
    assert {path: path.read_bytes() for path in paths} == first_pass
    assert source.read_bytes() == original


def test_image_conversion_preserves_pixel_size_and_flattens_png_for_jpeg(tmp_path: Path, capsys):
    source = tmp_path / "Печать.png"
    with Image.new("RGBA", (240, 120), (200, 0, 0, 0)) as image:
        image.save(source)
    [jpeg] = run_conversion(source, tmp_path, "jpeg", capsys)
    with Image.open(jpeg) as image:
        assert image.format == "JPEG" and image.size == (240, 120)
        assert min(image.getpixel((120, 60))) > 250
    [png] = run_conversion(jpeg, tmp_path, "png", capsys)
    with Image.open(png) as image:
        assert image.format == "PNG" and image.size == (240, 120)
    [pdf] = run_conversion(source, tmp_path, "pdf", capsys)
    page = PdfReader(pdf).pages[0]
    assert float(page.mediabox.width / page.mediabox.height) == pytest.approx(2)
    assert next(iter(page.images)).image.size == (240, 120)


def test_docx_to_pdf_preserves_searchable_text(tmp_path: Path, capsys):
    source = Path(__file__).parent / "fixtures" / "simple.docx"
    [pdf] = run_conversion(source, tmp_path, "pdf", capsys)
    page = PdfReader(pdf).pages[0]
    assert page.extract_text().strip()


def test_same_format_is_rejected_before_creating_output(tmp_path: Path):
    source = tmp_path / "photo.jpeg"
    with Image.new("RGB", (10, 10)) as image:
        image.save(source)
    with pytest.raises(UnsupportedFormatError, match="уже в выбранном формате"):
        convert({"protocolVersion": 2, "inputPath": str(source), "outputDirectory": str(tmp_path), "outputFormat": "jpeg"})
    assert list(tmp_path.iterdir()) == [source]


@pytest.mark.parametrize(("extension", "encoder", "mode"), [
    ("TIFF", "TIFF", "RGB"), ("BMP", "BMP", "RGB"), ("DIB", "DIB", "RGB"),
    ("WEBP", "WEBP", "RGB"), ("GIF", "GIF", "RGB"), ("JFIF", "JPEG", "RGB"),
    ("ICO", "ICO", "RGB"), ("TGA", "TGA", "RGB"), ("PCX", "PCX", "RGB"),
    ("PBM", "PPM", "1"), ("PGM", "PPM", "L"), ("PPM", "PPM", "RGB"), ("PNM", "PPM", "RGB"),
])
def test_extended_formats_only_open_in_converter(tmp_path: Path, capsys, extension: str, encoder: str, mode: str):
    source = tmp_path / f"Тест.{extension}"
    with Image.new(mode, (32, 32)) as image:
        image.save(source, format=encoder)
    with pytest.raises(UnsupportedFormatError, match="PDF, DOCX, JPEG или PNG"):
        preview_result({"protocolVersion": 2, "inputPath": str(source), "outputPath": str(tmp_path / "preview.png")})
    [output] = run_conversion(source, tmp_path, "png", capsys)
    with Image.open(output) as image:
        assert image.size == (32, 32) and image.format == "PNG"


@pytest.mark.parametrize("extension", ["tif", "gif", "webp", "png"])
def test_all_pages_or_frames_kept_in_order(tmp_path: Path, capsys, extension: str):
    source = tmp_path / f"Листы.{extension}"
    with Image.new("RGB", (64, 32), "red") as first, Image.new("RGB", (64, 32), "blue") as second:
        first.save(source, save_all=True, append_images=[second], duration=100, lossless=True)

    [pdf] = run_conversion(source, tmp_path, "pdf", capsys)
    pages = PdfReader(pdf).pages
    assert len(pages) == 2
    for page, color in zip(pages, ((255, 0, 0), (0, 0, 255)), strict=True):
        assert next(iter(page.images)).image.getpixel((16, 16)) == color

    output_format = "jpeg" if extension == "png" else "png"
    outputs = run_conversion(source, tmp_path, output_format, capsys)
    assert len(outputs) == 2
    assert [path.name.split("стр. ")[-1][0] for path in outputs] == ["1", "2"]


def test_transparent_webp_keeps_alpha_in_png(tmp_path: Path, capsys):
    source = tmp_path / "Печать.webp"
    with Image.new("RGBA", (32, 32), (200, 0, 0, 0)) as image:
        image.save(source, lossless=True)
    [result] = run_conversion(source, tmp_path, "png", capsys)
    with Image.open(result) as image:
        assert image.mode == "RGBA" and image.getpixel((16, 16))[3] == 0


def test_renamed_image_is_rejected(tmp_path: Path, capsys):
    source = tmp_path / "Лист.tiff"
    with Image.new("RGB", (32, 32)) as image:
        image.save(source, format="PNG")
    with pytest.raises(CorruptDocumentError, match="Проверьте формат файла"):
        run_conversion(source, tmp_path, "pdf", capsys)
    assert list(tmp_path.iterdir()) == [source]


@pytest.mark.parametrize("extension", ["HEIC", "heif"])
def test_iphone_photo_orientation_in_all_output_formats(tmp_path: Path, capsys, extension: str):
    fixture = Path(__file__).parent / "fixtures" / "iphone-orientation.heic"
    source = tmp_path / f"Фото.{extension}"
    source.write_bytes(fixture.read_bytes())
    with pytest.raises(UnsupportedFormatError, match="PDF, DOCX, JPEG или PNG"):
        preview_result({"protocolVersion": 2, "inputPath": str(source), "outputPath": str(tmp_path / "preview.png")})
    for format in ("png", "jpeg", "pdf"):
        [output] = run_conversion(source, tmp_path, format, capsys)
        if format == "pdf":
            page = PdfReader(output).pages[0]
            assert page.mediabox.height > page.mediabox.width
            image = next(iter(page.images)).image
        else:
            image = Image.open(output)
        with image:
            assert image.size == (96, 160)
            assert image.getpixel((48, 40))[0] > 220
            assert image.getpixel((48, 120))[2] > 220
    assert source.read_bytes() == fixture.read_bytes()
