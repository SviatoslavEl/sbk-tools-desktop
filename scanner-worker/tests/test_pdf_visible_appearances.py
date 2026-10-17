"""Visible PDF appearances must survive the scanner's raster conversion."""

from pathlib import Path

import pypdfium2 as pdfium
import pytest
from pypdf import PdfWriter
from pypdf.generic import (
    ArrayObject, BooleanObject, DictionaryObject, FloatObject, NameObject,
    NumberObject, DecodedStreamObject, TextStringObject,
)

from scandocument.models import EffectSettings, ProcessRequest
from scandocument.pdf_engine import open_render_document, render_page
from scandocument.pipeline import make_preview, process_document
from scandocument.tempfiles import SecureWorkspace


def visible_appearance_pdf(path: Path, *, widget=True, reversed_rect=False) -> Path:
    """A synthetic blue appearance, independent of fonts or private records."""
    writer = PdfWriter()
    page = writer.add_blank_page(width=200, height=160)
    appearance = DecodedStreamObject()
    appearance.set_data(b"0 0 1 rg 0 0 100 50 re f\n")
    appearance.update({
        NameObject("/Type"): NameObject("/XObject"),
        NameObject("/Subtype"): NameObject("/Form"),
        NameObject("/BBox"): ArrayObject([NumberObject(n) for n in (0, 0, 100, 50)]),
        NameObject("/Resources"): DictionaryObject(),
    })
    rectangle = (40, 80, 140, 30) if reversed_rect else (40, 30, 140, 80)
    annotation = DictionaryObject({
        NameObject("/Type"): NameObject("/Annot"),
        NameObject("/Subtype"): NameObject("/Widget" if widget else "/Square"),
        NameObject("/Rect"): ArrayObject([FloatObject(n) for n in rectangle]),
        NameObject("/F"): NumberObject(4),
        NameObject("/AP"): DictionaryObject({NameObject("/N"): writer._add_object(appearance)}),
    })
    if widget:
        annotation.update({
            NameObject("/FT"): NameObject("/Tx"),
            NameObject("/T"): TextStringObject("Synthetic QA appearance"),
            NameObject("/V"): TextStringObject("Synthetic only"),
        })
    annotation_ref = writer._add_object(annotation)
    page[NameObject("/Annots")] = ArrayObject([annotation_ref])
    if widget:
        writer._root_object[NameObject("/AcroForm")] = writer._add_object(DictionaryObject({
            NameObject("/Fields"): ArrayObject([annotation_ref]),
            NameObject("/NeedAppearances"): BooleanObject(False),
        }))
    writer.write(path)
    return path


def assert_blue_appearance(image):
    # The PDF's lower-left origin is inverted in the output raster.
    x, y = round(image.width * 90 / 200), round(image.height * 105 / 160)
    red, green, blue = image.convert("RGB").getpixel((x, y))
    assert blue > 190 and red < 60 and green < 60, (red, green, blue)


def test_document_initializes_forms_before_any_page_lookup(monkeypatch):
    events = []

    class Document:
        def __init__(self, source):
            events.append(("open", source))

        def init_forms(self):
            events.append("forms")

    monkeypatch.setattr(pdfium, "PdfDocument", Document)
    opened = open_render_document(Path("synthetic.pdf"))
    assert isinstance(opened, Document)
    assert events == [("open", "synthetic.pdf"), "forms"]


def test_document_closes_if_forms_cannot_be_initialized(monkeypatch):
    events = []

    class Document:
        def __init__(self, _source):
            pass

        def init_forms(self):
            raise ValueError("Synthetic form error")

        def close(self):
            events.append("closed")

    monkeypatch.setattr(pdfium, "PdfDocument", Document)
    with pytest.raises(ValueError, match="Synthetic form error"):
        open_render_document(Path("synthetic.pdf"))
    assert events == ["closed"]


@pytest.mark.parametrize("widget,reversed_rect", [(True, False), (True, True), (False, False)])
def test_render_page_keeps_visible_widget_and_annotation_appearances(tmp_path, widget, reversed_rect):
    source = visible_appearance_pdf(tmp_path / "visible.pdf", widget=widget, reversed_rect=reversed_rect)
    original_bytes = source.read_bytes()
    with pdfium.PdfDocument(source) as document:
        image, size = render_page(document, 0, 72)
        assert size == (200.0, 160.0)
        assert_blue_appearance(image)
    assert source.read_bytes() == original_bytes


def test_preview_and_raster_export_keep_the_same_visible_widget(tmp_path, monkeypatch):
    monkeypatch.setattr(SecureWorkspace, "base_dir", classmethod(lambda cls: tmp_path / "private"))
    source = visible_appearance_pdf(tmp_path / "visible.pdf", reversed_rect=True)
    before = source.read_bytes()
    settings = EffectSettings.from_dict({"dpi": 150, "jpeg_quality": 95})
    original, _processed, count, _warnings, _size = make_preview(source, settings, 42, 0)
    assert count == 1
    assert_blue_appearance(original)
    output = tmp_path / "processed.pdf"
    request = ProcessRequest(input_path=source, output_path=output, settings=settings, seed=42)
    process_document(request)
    with pdfium.PdfDocument(output) as document:
        image, _size = render_page(document, 0, 72)
        assert_blue_appearance(image)
    assert source.read_bytes() == before


def test_preview_does_not_reuse_pre_forms_raster_cache(tmp_path, monkeypatch):
    import hashlib
    from scandocument import preview_cache

    monkeypatch.setattr(SecureWorkspace, "base_dir", classmethod(lambda cls: tmp_path / "private"))
    source = visible_appearance_pdf(tmp_path / "visible.pdf", reversed_rect=True)
    cache = tmp_path / "cache"
    legacy_key = hashlib.sha256(
        f"raster-v2\0{preview_cache.source_fingerprint(source)}\0{0}\0{150}".encode()
    ).hexdigest()
    from PIL import Image
    preview_cache.write_raster(cache, legacy_key, Image.new("RGB", (200, 160), "white"))
    settings = EffectSettings.from_dict({"dpi": 150})
    original, *_ = make_preview(source, settings, 42, 0, preview_cache_dir=cache)
    assert_blue_appearance(original)
    assert preview_cache.raster_key(source, 0, 150) != legacy_key
