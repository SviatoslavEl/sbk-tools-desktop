from __future__ import annotations

import hashlib
import json
import os
import zipfile
from pathlib import Path
from types import SimpleNamespace

import pytest
from PIL import Image, ImageDraw
from reportlab.pdfgen import canvas

from scandocument import extraction
from scandocument.extraction import extract_document


WORD = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
SHEET = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"


def docx(path: Path, body: str, **parts: str) -> Path:
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("[Content_Types].xml", "<Types/>")
        archive.writestr("word/document.xml", f'<w:document xmlns:w="{WORD}"><w:body>{body}</w:body></w:document>')
        for name, content in parts.items():
            archive.writestr(name, content)
    return path


def xlsx(path: Path, sheets: list[tuple[str, str, str]], *, styles: str | None = None,
         shared: str | None = None, date_1904: bool = False, omit_sheet: int = 0) -> Path:
    declarations = "".join(f'<sheet name="{name}" sheetId="{index}" state="{state}" r:id="r{index}"/>'
                           for index, (name, state, _text) in enumerate(sheets, 1))
    relationships = "".join(f'<Relationship Id="r{index}" Target="worksheets/sheet{index}.xml"/>'
                             for index in range(1, len(sheets) + 1))
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("[Content_Types].xml", "<Types/>")
        archive.writestr("xl/workbook.xml", f'<workbook xmlns="{SHEET}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr date1904="{int(date_1904)}"/><sheets>{declarations}</sheets></workbook>')
        archive.writestr("xl/_rels/workbook.xml.rels", f'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">{relationships}</Relationships>')
        for index, (_name, _state, rows) in enumerate(sheets, 1):
            if index != omit_sheet:
                archive.writestr(f"xl/worksheets/sheet{index}.xml", f'<worksheet xmlns="{SHEET}"><sheetData>{rows}</sheetData></worksheet>')
        if styles is not None:
            archive.writestr("xl/styles.xml", styles)
        if shared is not None:
            archive.writestr("xl/sharedStrings.xml", shared)
    return path


def inline(reference: str, text: str) -> str:
    return f'<c r="{reference}" t="inlineStr"><is><t>{text}</t></is></c>'


def test_text_hash_and_size_use_the_same_snapshot_if_original_path_is_replaced(tmp_path: Path, monkeypatch):
    source = docx(tmp_path / "source.docx", "<w:p><w:r><w:t>VERSION A price 100</w:t></w:r></w:p>")
    replacement = docx(tmp_path / "replacement.docx", "<w:p><w:r><w:t>VERSION B price 200</w:t></w:r></w:p>")
    original_bytes = source.read_bytes()
    replacement_bytes = replacement.read_bytes()
    original_parser = extraction._docx
    snapshots: list[Path] = []

    def replace_before_parse(snapshot):
        assert snapshot != source
        snapshots.append(snapshot)
        os.replace(replacement, source)
        return original_parser(snapshot)

    monkeypatch.setattr(extraction, "_docx", replace_before_parse)
    result = extract_document(source)
    assert "VERSION A price 100" in result["extractedText"]
    assert "VERSION B" not in result["extractedText"]
    assert result["sha256"] == hashlib.sha256(original_bytes).hexdigest()
    assert result["sizeBytes"] == len(original_bytes)
    assert result["fileName"] == "source.docx"
    assert source.read_bytes() == replacement_bytes
    assert result["sha256"] != hashlib.sha256(replacement_bytes).hexdigest()
    assert snapshots and not snapshots[0].exists()


def test_snapshot_rejects_source_mutation_detected_during_its_stream(tmp_path: Path, monkeypatch):
    source = docx(tmp_path / "source.docx", "<w:p><w:r><w:t>Stable fixture</w:t></w:r></w:p>")
    original = extraction.os.fstat
    observations = 0

    def changed(fd):
        nonlocal observations
        value = original(fd)
        observations += 1
        if observations != 2:
            return value
        return SimpleNamespace(st_mode=value.st_mode, st_size=value.st_size,
                               st_mtime_ns=value.st_mtime_ns + 1,
                               st_ctime_ns=value.st_ctime_ns)

    monkeypatch.setattr(extraction.os, "fstat", changed)
    with pytest.raises(ValueError, match="изменился во время чтения"):
        extract_document(source)


def test_docx_preserves_tabs_breaks_cell_paragraphs_and_nested_table_text(tmp_path: Path):
    source = docx(tmp_path / "structure.docx", """
      <w:p><w:r><w:t>Цена</w:t><w:tab/><w:t>100</w:t><w:br/><w:t>НДС 20%</w:t></w:r></w:p>
      <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Сертификат A: минимум 3.</w:t></w:r></w:p>
      <w:p><w:r><w:t>Сертификат B: минимум 2.</w:t></w:r></w:p>
      <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Вложенное условие</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
      </w:tc><w:tc><w:p><w:r><w:t>5 лет</w:t></w:r></w:p></w:tc></w:tr></w:tbl>""")
    result = extract_document(source)
    assert result["fragments"][0]["text"] == "Цена\t100\nНДС 20%"
    assert "Сертификат A: минимум 3.\nСертификат B: минимум 2." in result["fragments"][1]["text"]
    assert result["extractedText"].count("Вложенное условие") == 1
    assert "\t5 лет" in result["fragments"][1]["text"]


def test_docx_nested_text_preserves_requirements_without_deleted_or_instruction_text(tmp_path: Path):
    source = docx(tmp_path / "nested-text.docx", """
      <w:p><w:r><w:t>Начало <w:t>Сертификат OSCP – не менее 5;</w:t> затем <w:t>Сертификат OSEP – не менее 2.</w:t>
      <w:del><w:t>REMOVED SECRET</w:t></w:del><w:instrText>FIELD INSTRUCTION</w:instrText><w:delText>DELETED FIELD</w:delText></w:t></w:r></w:p>
      <w:p><w:del><w:r><w:t><w:t>REMOVED NESTED</w:t></w:t></w:r></w:del></w:p>""")
    result = extract_document(source)
    text = result["extractedText"]
    assert "Начало Сертификат OSCP – не менее 5; затем Сертификат OSEP – не менее 2." in text
    assert text.count("OSCP") == 1 and text.count("OSEP") == 1
    assert "REMOVED" not in text and "INSTRUCTION" not in text and "DELETED" not in text


def test_docx_includes_referenced_footnotes_and_endnotes_but_not_unreferenced_history(tmp_path: Path):
    source = docx(tmp_path / "notes.docx", '<w:p><w:r><w:t>Сертификат A</w:t><w:footnoteReference w:id="3"/><w:endnoteReference w:id="7"/></w:r></w:p>',
                  **{"word/footnotes.xml": f'<w:footnotes xmlns:w="{WORD}"><w:footnote w:id="-1"><w:p><w:r><w:t>Separator</w:t></w:r></w:p></w:footnote><w:footnote w:id="3"><w:p><w:r><w:t>Минимум 3 специалиста с опытом 5 лет.</w:t></w:r></w:p></w:footnote><w:footnote w:id="9"><w:p><w:r><w:t>OLD UNREFERENCED HISTORY</w:t></w:r></w:p></w:footnote></w:footnotes>',
                     "word/endnotes.xml": f'<w:endnotes xmlns:w="{WORD}"><w:endnote w:id="7"><w:p><w:r><w:t>Исключение по согласованию.</w:t></w:r></w:p></w:endnote></w:endnotes>'})
    result = extract_document(source)
    assert "[Сноска 3]" in result["fragments"][0]["text"]
    assert "Минимум 3 специалиста с опытом 5 лет." in result["extractedText"]
    assert "Исключение по согласованию." in result["extractedText"]
    assert "HISTORY" not in result["extractedText"] and "Separator" not in result["extractedText"]
    assert result["fragments"][1]["noteType"] == "footnote"
    assert result["fragments"][2]["noteType"] == "endnote"


def test_missing_referenced_docx_note_is_not_silently_dropped(tmp_path: Path):
    source = docx(tmp_path / "missing-note.docx", '<w:p><w:r><w:t>Requirement</w:t><w:footnoteReference w:id="3"/></w:r></w:p>')
    with pytest.raises(ValueError, match="отсутствующую.*сноск"):
        extract_document(source)


def test_sparse_xlsx_preserves_empty_columns_even_before_the_first_real_cell(tmp_path: Path):
    rows = ('<row r="1">' + inline("A1", "Услуга") + inline("B1", "Количество") + inline("C1", "Цена") + '</row>'
            '<row r="2">' + inline("A2", "Аудит") + '<c r="C2"><v>100</v></c></row>'
            '<row r="3"><c r="C3"><v>200</v></c></row>')
    result = extract_document(xlsx(tmp_path / "sparse.xlsx", [("Данные", "visible", rows)]))
    assert [fragment["text"] for fragment in result["fragments"]] == ["Услуга\tКоличество\tЦена", "Аудит\t\t100", "\t\t200"]
    assert result["extractedText"].endswith("\n\t\t200")
    assert result["fragments"][1]["cells"][1]["reference"] == "C2"
    assert result["fragments"][2]["cellRange"] == "A3:C3"


@pytest.mark.parametrize("date_1904,serial,expected", [(False, "46316", "2026-10-21"), (True, "0", "1904-01-01"), (False, "1", "1900-01-01")])
def test_xlsx_date_epoch_and_percent_formats_are_typed(tmp_path: Path, date_1904, serial, expected):
    styles = f'<styleSheet xmlns="{SHEET}"><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="9"/><xf numFmtId="10"/></cellXfs></styleSheet>'
    rows = f'<row r="1"><c r="A1" s="1"><v>{serial}</v></c><c r="B1" s="2"><v>0.2</v></c><c r="C1" s="3"><v>0.2</v></c></row>'
    result = extract_document(xlsx(tmp_path / "formats.xlsx", [("Данные", "visible", rows)], styles=styles, date_1904=date_1904))
    cells = result["fragments"][0]["cells"]
    assert result["fragments"][0]["text"] == f"{expected}\t20%\t20.00%"
    assert cells[0]["valueType"] == "date" and cells[0]["rawValue"] == serial
    assert cells[1]["valueType"] == "percentage" and cells[1]["numberFormat"] == "0%"


def test_custom_date_and_datetime_styles_preserve_the_meaning_not_serials(tmp_path: Path):
    styles = f'<styleSheet xmlns="{SHEET}"><numFmts><numFmt numFmtId="165" formatCode="dd.mm.yyyy"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="165"/><xf numFmtId="22"/></cellXfs></styleSheet>'
    rows = '<row r="1"><c r="A1" s="1"><v>46316</v></c><c r="B1" s="2"><v>46316.5</v></c></row>'
    result = extract_document(xlsx(tmp_path / "custom.xlsx", [("Данные", "visible", rows)], styles=styles))
    assert result["fragments"][0]["text"] == "2026-10-21\t2026-10-21T12:00:00"
    assert result["fragments"][0]["cells"][1]["valueType"] == "datetime"


def test_percentage_display_rounds_like_excel_and_elapsed_hours_are_not_wrapped(tmp_path: Path):
    styles = f'<styleSheet xmlns="{SHEET}"><cellXfs><xf numFmtId="0"/><xf numFmtId="9"/><xf numFmtId="46"/></cellXfs></styleSheet>'
    rows = '<row r="1"><c r="A1" s="1"><v>0.125</v></c><c r="B1" s="2"><v>1.25</v></c></row>'
    result = extract_document(xlsx(tmp_path / "elapsed.xlsx", [("Данные", "visible", rows)], styles=styles))
    assert result["fragments"][0]["text"] == "13%\t30:00:00"
    assert result["fragments"][0]["cells"][1]["valueType"] == "duration"


def test_hidden_and_very_hidden_history_are_excluded_until_explicit_opt_in(tmp_path: Path):
    sheets = [("Актуальный", "visible", '<row r="1">' + inline("A1", "CURRENT 2026") + '</row>'),
              ("История", "hidden", '<row r="1">' + inline("A1", "OLD SCHOOL 2018") + '</row>'),
              ("Служебный", "veryHidden", '<row r="1">' + inline("A1", "OLD BUILDING 2021") + '</row>')]
    source = xlsx(tmp_path / "history.xlsx", sheets)
    current = extract_document(source)
    assert current["extractedText"] == "CURRENT 2026"
    assert [sheet["state"] for sheet in current["sheets"]] == ["visible", "hidden", "veryHidden"]
    assert [sheet["included"] for sheet in current["sheets"]] == [True, False, False]
    chosen = extract_document(source, include_hidden_sheets=True, selected_sheets=["2"])
    assert chosen["extractedText"] == "OLD SCHOOL 2018"
    assert chosen["fragments"][0]["sheetId"] == "2" and chosen["fragments"][0]["includedByUser"] is True
    assert chosen["sha256"] == current["sha256"]
    with pytest.raises(ValueError, match="без явного разрешения"):
        extract_document(source, selected_sheets=["2"])
    with pytest.raises(ValueError, match="неизвестные"):
        extract_document(source, selected_sheets=["999"])
    assert extract_document(source, selected_sheets=[])["fragments"] == []


@pytest.mark.parametrize("index", ["99", "-1", "not-an-index", ""])
def test_invalid_shared_string_index_is_rejected_not_inserted_as_content(tmp_path: Path, index):
    shared = f'<sst xmlns="{SHEET}"><si><t>Заказчик</t></si></sst>'
    source = xlsx(tmp_path / "bad-shared.xlsx", [("Данные", "visible", f'<row r="1"><c r="A1" t="s"><v>{index}</v></c></row>')], shared=shared)
    with pytest.raises(ValueError, match="повреждённую ссылку на общий текст"):
        extract_document(source)


def test_declared_missing_sheet_is_rejected_even_when_hidden(tmp_path: Path):
    source = xlsx(tmp_path / "missing.xlsx", [("Данные", "visible", '<row r="1">' + inline("A1", "Current") + '</row>'),
                                             ("История", "hidden", "")], omit_sheet=2)
    with pytest.raises(ValueError, match="отсутствующий лист"):
        extract_document(source)


@pytest.mark.parametrize("cell", ['<c r="A1" s="99"><v>1</v></c>', '<c r="A2"><v>1</v></c>', '<c r="XFE1"><v>1</v></c>', '<c r="A1"><v>NaN</v></c>'])
def test_corrupt_styles_coordinates_and_nonfinite_values_are_rejected(tmp_path: Path, cell):
    source = xlsx(tmp_path / "corrupt.xlsx", [("Данные", "visible", f'<row r="1">{cell}</row>')])
    with pytest.raises(ValueError):
        extract_document(source)


def test_uncalculated_formulas_and_excel_errors_have_explicit_partial_coverage(tmp_path: Path):
    rows = '<row r="1">' + inline("A1", "Price") + '<c r="B1"><f>SUM(B2:B3)</f></c><c r="C1" t="e"><v>#VALUE!</v></c></row>'
    result = extract_document(xlsx(tmp_path / "formula.xlsx", [("Данные", "visible", rows)]))
    assert result["coverage"]["complete"] is False
    assert any("пересчёт формул не выполнялся" in warning for warning in result["warnings"])
    assert any("ошибка Excel" in warning for warning in result["warnings"])
    assert result["fragments"][0]["cells"][1]["hasFormula"] is True


@pytest.mark.parametrize("hybrid,same_page", [(False, False), (True, False), (True, True)])
def test_pdf_image_only_hybrid_and_raster_letterheads_all_report_incomplete_ocr(tmp_path: Path, hybrid, same_page):
    source = tmp_path / "raster.pdf"
    raster = Image.new("RGB", (500, 100), "white")
    ImageDraw.Draw(raster).text((10, 30), "RASTER PRICE AND REQUISITES", fill="black")
    document = canvas.Canvas(str(source))
    if hybrid:
        document.drawString(50, 750, "Synthetic PDF body text")
        if not same_page:
            document.showPage()
    document.drawInlineImage(raster, 50, 400, width=400, height=80)
    document.showPage()
    document.save()
    result = extract_document(source)
    assert result["coverage"]["complete"] is False and result["coverage"]["requiresOcr"] is True
    assert result["coverage"]["pagesWithImages"] == ([2] if hybrid and not same_page else [1])
    assert result["coverage"]["pagesWithoutText"] == ([] if same_page else [2] if hybrid else [1])
    assert any("растровых шапок" in warning for warning in result["warnings"])
    assert bool(result["extractedText"].strip()) is hybrid
    assert "RASTER PRICE" not in result["extractedText"]


def test_cli_forwards_hidden_sheet_opt_in_and_specific_sheet_ids(tmp_path: Path, monkeypatch, capsys):
    import sys
    from scandocument import worker_cli
    config = tmp_path / "config.json"
    config.write_text(json.dumps({"protocolVersion": 2, "inputPath": "synthetic.xlsx", "includeHiddenSheets": True, "selectedSheets": ["2"]}), encoding="utf-8")
    calls = []
    monkeypatch.setattr(worker_cli.SecureWorkspace, "cleanup_stale", lambda: None)
    monkeypatch.setattr(worker_cli, "extract_document", lambda path, **kwargs: calls.append((path, kwargs)) or {"type": "extraction"})
    monkeypatch.setattr(sys, "argv", ["worker", "extract", "--config", str(config)])
    assert worker_cli.main() == 0
    assert calls == [(Path("synthetic.xlsx"), {"include_hidden_sheets": True, "selected_sheets": ["2"]})]
    assert json.loads(capsys.readouterr().out)["type"] == "extraction"
