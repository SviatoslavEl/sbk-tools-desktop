"""Synthetic vector-cell ownership tests; no private document content stored."""
from __future__ import annotations

import hashlib
import os
import time
from pathlib import Path

import pypdfium2 as pdfium
import pytest
from pypdf import PdfReader, PdfWriter
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

from scandocument import extraction, pdf_table_layout as layout


FONT = "QA-PdfGrid-Noto"
FONT_PATH = Path(__file__).parents[1] / "resources/fonts/NotoSans-Regular.ttf"
pdfmetrics.registerFont(TTFont(FONT, str(FONT_PATH)))


def grid_pdf(path: Path, *, defect: str = "", opaque_text=True, thin_rectangles=False) -> Path:
    document = canvas.Canvas(str(path), pagesize=(600, 800), pageCompression=0)

    def line(x0, y0, x1, y1):
        if thin_rectangles:
            if y0 == y1:
                document.rect(min(x0, x1), y0 - .24, abs(x1 - x0), .48, fill=1, stroke=0)
            else:
                document.rect(x0 - .24, min(y0, y1), .48, abs(y1 - y0), fill=1, stroke=0)
        else:
            document.line(x0, y0, x1, y1)

    def paint():
        document.setLineWidth(.48)
        document.setStrokeColorRGB(0, 0, 0)
        document.setFillColorRGB(0, 0, 0)
        for x in (40, 150, 550):
            if defect == "missing-border" and x == 150:
                line(x, 750, x, 720)
                continue
            if defect == "missing-second-border" and x == 150:
                line(x, 750, x, 390)
                continue
            if defect == "curved-border" and x == 150:
                p = document.beginPath()
                p.moveTo(x, 100)
                p.curveTo(x + 2, 250, x - 2, 600, x, 750)
                document.drawPath(p)
                continue
            line(x, 100, x, 750)
        for y in (750, 720, 390, 100):
            if defect == "merged-cell" and y == 390:
                line(40, y, 150, y)
            else:
                line(40, y, 550, y)
        if not opaque_text:
            document.setFillAlpha(0)
        document.setFont(FONT, 10)
        document.drawString(50, 732, "Артикул")
        document.drawString(160, 732, "Наименование оборудования")
        document.drawString(50, 700, "QA-SKU-A")
        document.drawString(50, 370, "Артикул" if defect == "ambiguous-header" else "QA-SKU-B")
        for y, count, letter in ((700, 19, "A"), (370, 13, "B")):
            if defect == "ambiguous-header" and letter == "B":
                document.drawString(160, y, "Наименование оборудования")
                continue
            document.drawString(160, y, f"QA model {letter}")
            for index in range(count):
                document.drawString(160, y - (index + 1) * 12, f"- Component {letter}-{index + 1:02}")
        if defect == "crossing-cell":
            document.drawString(148, 680, "CROSS")
        if defect == "crossing-row":
            document.drawString(170, 389, "CROSSROW")
        if defect == "large-overlap":
            document.drawString(170, 387.6, "g")
        if defect == "small-edge-overlap":
            # Origin and center both belong to row1; only a short descender
            # extends beyond its bottom edge, by <1pt and <25% glyph height.
            document.drawString(170, 391.7, "g")
        if defect == "baseline-in-band":
            document.drawString(170, 390, "g")

    if defect == "rotated-paths":
        document.rotate(1)
    if defect in ("identity-form", "translated-form"):
        document.beginForm("qa-grid", 0, 0, 600, 800)
        paint()
        document.endForm()
        if defect == "translated-form":
            document.translate(2, 0)
        document.doForm("qa-grid")
    else:
        paint()
    document.showPage()
    document.save()
    if defect == "rotated-page":
        reader = PdfReader(path)
        writer = PdfWriter()
        writer.add_page(reader.pages[0])
        writer.pages[0].rotate(90)
        writer.write(path)
    return path


def inspect_grid(path: Path, **kwargs):
    document = pdfium.PdfDocument(path)
    page = document[0]
    text = page.get_textpage()
    try:
        original = text.get_text_range().strip()
        result = layout.extract_pdf_table_rows(page, text, 1, **kwargs)
        return result, original
    finally:
        text.close()
        page.close()
        document.close()


def test_closed_vector_cells_preserve_header_and_all_components_without_order_guessing(tmp_path):
    path = grid_pdf(tmp_path / "anonymous.pdf")
    before = hashlib.sha256(path.read_bytes()).hexdigest()
    result, original = inspect_grid(path)
    assert not result.limited
    assert len(result.fragments) == 3
    assert [fragment["id"] for fragment in result.fragments] == [f"page-1-grid-1-row-{i}" for i in (1, 2, 3)]
    for index, fragment in enumerate(result.fragments, 1):
        grid = fragment["pdfGrid"]
        assert grid["page"] == fragment["page"] == 1
        assert grid["version"] == 1 and grid["textLayer"] == "text"
        assert fragment["locator"] == f"Страница 1, таблица 1, строка {index}"
        assert len(grid["cells"]) == 2
        assert fragment["text"] == "\t".join(cell["text"] for cell in grid["cells"])
        assert grid["cells"][0]["bounds"][2] == grid["cells"][1]["bounds"][0]
    assert result.fragments[1]["pdfGrid"]["cells"][0]["text"] == "QA-SKU-A"
    assert result.fragments[2]["pdfGrid"]["cells"][0]["text"] == "QA-SKU-B"
    assert result.fragments[1]["text"].count("- Component A-") == 19
    assert result.fragments[2]["text"].count("- Component B-") == 13
    extracted = extraction.extract_document(path)
    assert extracted["fragments"][0]["id"] == "page-1"
    assert extracted["fragments"][0]["text"] == original
    assert extracted["extractedText"] == original  # no supplemental-row duplication
    assert len(extracted["fragments"]) == 4
    assert extracted["coverage"]["requiresOcr"] is False
    assert hashlib.sha256(path.read_bytes()).hexdigest() == before


@pytest.mark.parametrize("defect", ["missing-border", "missing-second-border", "merged-cell", "crossing-cell", "crossing-row",
                                       "large-overlap", "rotated-page", "rotated-paths", "ambiguous-header",
                                       "curved-border", "translated-form", "baseline-in-band"])
def test_uncertain_geometry_does_not_create_any_row_proof(tmp_path, defect):
    result, original = inspect_grid(grid_pdf(tmp_path / "unknown.pdf", defect=defect))
    assert original
    assert result.fragments == []


@pytest.mark.parametrize("thin_rectangles,defect", [(True, ""), (False, "identity-form"), (False, "small-edge-overlap")])
def test_thin_painted_rectangles_identity_nesting_and_bounded_descender_are_proven(tmp_path, thin_rectangles, defect):
    result, _ = inspect_grid(grid_pdf(tmp_path / "closed.pdf", thin_rectangles=thin_rectangles, defect=defect))
    assert not result.limited
    assert len(result.fragments) == 3


def test_invisible_owned_ocr_layer_is_labelled_and_never_removes_ocr_warnings(tmp_path):
    path = grid_pdf(tmp_path / "ocr.pdf", opaque_text=False)
    result, _ = inspect_grid(path)
    assert len(result.fragments) == 3
    assert all(fragment["pdfGrid"]["textLayer"] == "ocr" for fragment in result.fragments)
    extracted = extraction.extract_document(path)
    assert any("текст требует сверки" in warning for warning in extracted["warnings"])
    # This source has no raster images. Grid OCR provenance does not rewrite
    # the pre-existing page/image coverage classification in either direction.
    assert extracted["coverage"] == {"complete": True, "requiresOcr": False, "pagesWithoutText": [], "pagesWithImages": []}


def test_character_ownership_uses_real_paint_interiors_not_tuned_centerline_percentages():
    # Physical horizontal border ink is y29.75..30.25. Upper-cell baseline on
    # its upper outer edge is unambiguous, while baseline in that ink is not.
    interior = (1., 30.25, 19., 59.75)
    bands = ((.75, 1.), (29.75, 30.25), (19., 19.25), (59.75, 60.25))
    assert layout._char_owner((4., 29.4, 5., 31.), (4., 30.25), interior, bands)
    assert not layout._char_owner((4., 29.4, 5., 31.), (4., 30.), interior, bands)
    assert not layout._char_owner((18.5, 32., 21., 36.), (18.5, 32.), interior, bands)
    assert not layout._char_owner((4., 28., 5., 29.4), (4., 30.25), interior, bands)


def test_different_cell_origins_inside_one_unseparated_word_are_ambiguous():
    cells = [{"bounds": [1., 30., 19., 60.], "text": ""}, {"bounds": [1., 0., 19., 30.], "text": ""}]
    h = [(y, 1., 19., y - .25, y + .25) for y in (0., 30., 60.)]
    v = [(x, 0., 60., x - .25, x + .25) for x in (1., 19.)]
    glyphs = [((4., 35., 5., 39.), "A", (4., 35.), True, False),
              ((6., 15., 7., 19.), "B", (6., 15.), True, False)]
    with pytest.raises(layout._UncertainGrid):
        layout._reconstruct_cell_texts(glyphs, cells, [1., 0., 19., 60.], h, v)


def test_clipping_text_modes_do_not_provide_cell_evidence(tmp_path, monkeypatch):
    path = grid_pdf(tmp_path / "clipping.pdf")
    monkeypatch.setattr(layout.pdfium_raw, "FPDFTextObj_GetTextRenderMode", lambda _obj: 7)
    result, original = inspect_grid(path)
    assert original and result.fragments == []


@pytest.mark.parametrize("surrogate", [0xd800, 0xdfff])
def test_lone_surrogate_from_malformed_pdfium_mapping_fails_closed(tmp_path, monkeypatch, surrogate):
    path = grid_pdf(tmp_path / "malformed-mapping.pdf")
    original_getter = layout.pdfium_raw.FPDFText_GetUnicode
    monkeypatch.setattr(layout.pdfium_raw, "FPDFText_GetUnicode", lambda text, index: surrogate if index == 0 else original_getter(text, index))
    result, original = inspect_grid(path)
    assert original and result.fragments == []
    assert not result.limited


@pytest.mark.parametrize("name,value", [("MAX_GRID_OBJECTS", 1), ("MAX_GRID_CHARACTERS", 10),
                                          ("MAX_GRID_ROWS", 2), ("MAX_GRID_OUTPUT_CHARS", 10),
                                          ("MAX_GRID_CELL_CHARS", 10), ("MAX_GRID_EDGES", 2)])
def test_limits_are_atomic_and_do_not_truncate_original_page_text(tmp_path, monkeypatch, name, value):
    path = grid_pdf(tmp_path / "bounded.pdf")
    _, original = inspect_grid(path)
    monkeypatch.setattr(layout, name, value)
    result, _ = inspect_grid(path)
    assert result.limited and result.fragments == []
    extracted = extraction.extract_document(path)
    assert extracted["extractedText"] == original
    assert len(extracted["fragments"]) == 1
    assert any("безопасный предел" in warning for warning in extracted["warnings"])


def test_expired_deadline_and_document_optional_budget_preserve_text(tmp_path, monkeypatch):
    path = grid_pdf(tmp_path / "deadline.pdf")
    result, original = inspect_grid(path, deadline=time.monotonic() - 1)
    assert result.limited and result.fragments == []
    monkeypatch.setattr(extraction, "MAX_PDF_GRID_SECONDS", 0)
    extracted = extraction.extract_document(path)
    assert extracted["extractedText"] == original
    assert extracted["fragments"][0]["text"] == original
    assert len(extracted["fragments"]) == 1


def test_real_source_when_explicitly_provided_is_read_only():
    name = os.environ.get("SCANDOCUMENT_PDF_GRID_REAL_SOURCE")
    if not name:
        pytest.skip("Private source is only tested through an explicit local environment path.")
    path = Path(name)
    before = hashlib.sha256(path.read_bytes()).hexdigest()
    result, original = inspect_grid(path)
    assert hashlib.sha256(path.read_bytes()).hexdigest() == before
    assert original
    assert len(result.fragments) == 3
    assert [len(fragment["pdfGrid"]["cells"]) for fragment in result.fragments] == [2, 2, 2]
