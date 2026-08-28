from pathlib import Path
import zipfile

import pytest

from scandocument.extraction import MAX_SOURCE_BYTES, _validate_source, extract_document
from scandocument.errors import DocumentTooLargeError


FIXTURES = Path(__file__).parent / "fixtures"


def test_pdf_extraction_keeps_page_locators_and_sha256():
    result = extract_document(FIXTURES / "simple.pdf")
    assert result["mimeType"] == "application/pdf"
    assert len(result["sha256"]) == 64
    assert result["fragments"][0]["page"] == 1
    assert result["fragments"][0]["locator"] == "Страница 1"


def test_docx_extraction_keeps_paragraph_locators():
    result = extract_document(FIXTURES / "simple.docx")
    assert result["mimeType"].endswith("wordprocessingml.document")
    assert any(fragment.get("section", "").startswith("Абзац") for fragment in result["fragments"])
    assert result["extractedText"].strip()


def test_extraction_accepts_one_gib_boundary_and_rejects_one_byte_more(tmp_path: Path):
    boundary = tmp_path / "boundary.pdf"
    with boundary.open("wb") as stream:
        stream.write(b"%PDF-")
        stream.seek(MAX_SOURCE_BYTES - 1)
        stream.write(b"\0")
    assert _validate_source(boundary)[0] == MAX_SOURCE_BYTES
    with boundary.open("ab") as stream:
        stream.write(b"\0")
    with pytest.raises(ValueError, match="1 ГБ"):
        _validate_source(boundary)


def test_extraction_rejects_docx_zip_bomb_like_scanner_paths(tmp_path: Path):
    source = FIXTURES / "simple.docx"
    hostile = tmp_path / "hostile.docx"
    with zipfile.ZipFile(source) as existing, zipfile.ZipFile(hostile, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for entry in existing.infolist():
            archive.writestr(entry, existing.read(entry.filename))
        archive.writestr("word/ignored-bomb.bin", b"A" * (5 * 1024 * 1024))
    with pytest.raises(DocumentTooLargeError, match="коэффициент сжатия"):
        extract_document(hostile)


def test_magic_mismatch_is_rejected(tmp_path: Path):
    fake = tmp_path / "fake.pdf"
    fake.write_text("not a PDF", encoding="utf-8")
    with pytest.raises(ValueError, match="настоящие PDF"):
        extract_document(fake)


def test_xlsx_extraction_keeps_sheet_and_cell_range_and_reports_hidden_sheet(tmp_path: Path):
    path = tmp_path / "book.xlsx"
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("[Content_Types].xml", "<Types xmlns='http://schemas.openxmlformats.org/package/2006/content-types'/>")
        archive.writestr("xl/workbook.xml", """<workbook xmlns='http://schemas.openxmlformats.org/spreadsheetml/2006/main' xmlns:r='http://schemas.openxmlformats.org/officeDocument/2006/relationships'><sheets><sheet name='Расчёт' sheetId='1' state='hidden' r:id='rId1'/></sheets></workbook>""")
        archive.writestr("xl/_rels/workbook.xml.rels", """<Relationships xmlns='http://schemas.openxmlformats.org/package/2006/relationships'><Relationship Id='rId1' Target='worksheets/sheet1.xml'/></Relationships>""")
        archive.writestr("xl/sharedStrings.xml", """<sst xmlns='http://schemas.openxmlformats.org/spreadsheetml/2006/main'><si><t>Цена</t></si></sst>""")
        archive.writestr("xl/worksheets/sheet1.xml", """<worksheet xmlns='http://schemas.openxmlformats.org/spreadsheetml/2006/main'><sheetData><row r='1'><c r='A1' t='s'><v>0</v></c><c r='B1'><v>100</v></c></row></sheetData></worksheet>""")
    result = extract_document(path)
    assert result["fragments"] == [{"id": "sheet-1", "locator": "Лист Расчёт, A1:B1", "sheet": "Расчёт", "cellRange": "A1:B1", "text": "Цена\t100"}]
    assert "скрыт" in result["warnings"][0]
