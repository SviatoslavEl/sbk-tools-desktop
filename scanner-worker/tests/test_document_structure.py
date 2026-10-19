from __future__ import annotations

import hashlib
import zipfile
from html import escape
from pathlib import Path

import pytest
from lxml import etree

from scandocument import document_structure as structure_module
from scandocument.document_structure import DocxStructure
from scandocument.extraction import extract_document


WORD = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
BASE_KEYS = {"version", "format", "method", "part", "kind", "containerId", "order", "physicalSection"}
TABLE_KEYS = {"tableId", "rowIndex", "rowCount", "headerMarker", "cells"}
PARAGRAPH_KEYS = {"styleId", "outlineLevel", "outlineBasis"}


def document(path: Path, body: str, **parts: str) -> Path:
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("[Content_Types].xml", "<Types/>")
        archive.writestr("word/document.xml", f'<w:document xmlns:w="{WORD}"><w:body>{body}</w:body></w:document>')
        for name, text in parts.items():
            archive.writestr(name, text)
    return path


def paragraph(text: str, properties: str = "") -> str:
    return f"<w:p>{f'<w:pPr>{properties}</w:pPr>' if properties else ''}<w:r><w:t>{escape(text)}</w:t></w:r></w:p>"


def cell(text: str, properties: str = "") -> str:
    return f"<w:tc>{f'<w:tcPr>{properties}</w:tcPr>' if properties else ''}{paragraph(text)}</w:tc>"


def row(*texts: str, marker: str | None = None) -> str:
    properties = f"<w:trPr>{marker}</w:trPr>" if marker is not None else ""
    return f"<w:tr>{properties}{''.join(cell(text) for text in texts)}</w:tr>"


def styles(*entries: str) -> str:
    return f'<w:styles xmlns:w="{WORD}">{"".join(entries)}</w:styles>'


def style(identifier: str, *, parent: str | None = None, level: str | None = None) -> str:
    inheritance = f'<w:basedOn w:val="{parent}"/>' if parent else ""
    properties = f'<w:pPr><w:outlineLvl w:val="{level}"/></w:pPr>' if level is not None else ""
    return f'<w:style w:type="paragraph" w:styleId="{identifier}">{inheritance}{properties}</w:style>'


def assert_closed(result: dict) -> None:
    for order, fragment in enumerate(result["fragments"]):
        meta = fragment["structure"]
        assert meta["order"] == order
        assert meta["version"] == 1 and meta["format"] == "docx" and meta["method"] == "ooxml"
        assert isinstance(meta["physicalSection"], int) and meta["physicalSection"] >= 0
        optional = TABLE_KEYS if meta["kind"] == "table-row" else PARAGRAPH_KEYS if meta["kind"] == "paragraph" else set()
        assert BASE_KEYS <= set(meta) <= BASE_KEYS | optional
        if meta["kind"] == "table-row":
            assert TABLE_KEYS <= set(meta)
            assert meta["containerId"] == meta["tableId"]
            assert 0 <= meta["rowIndex"] < meta["rowCount"]
            assert "\t".join(item["text"] for item in meta["cells"]) == fragment["text"]
            for index, item in enumerate(meta["cells"]):
                assert set(item) == {"index", "text", "gridSpan", "verticalMerge", "nestedTableCount"}
                assert item["index"] == index and item["gridSpan"] >= 1
        else:
            assert not TABLE_KEYS.intersection(meta)


def test_multiple_tables_keep_old_global_row_ids_and_native_local_row_ownership(tmp_path: Path):
    body = (paragraph("") + paragraph("Introduction")
            + "<w:tbl>" + row("Column A", "Column B", marker="<w:tblHeader/>") + row("", "")
            + row("First table", "Value") + "</w:tbl>"
            + paragraph("Physical boundary", "<w:sectPr/>")
            + "<w:tbl>" + row("Second heading", "Other", marker='<w:tblHeader w:val="0"/>')
            + row("Second table", "Value") + "</w:tbl><w:sectPr/>")
    source = document(tmp_path / "tables.docx", body)
    original = source.read_bytes()
    result = extract_document(source)
    assert_closed(result)
    assert [(item["id"], item["locator"], item["text"]) for item in result["fragments"]] == [
        ("paragraph-2", "Абзац 2", "Introduction"),
        ("table-row-1", "Таблица, строка 1", "Column A\tColumn B"),
        ("table-row-3", "Таблица, строка 3", "First table\tValue"),
        ("paragraph-3", "Абзац 3", "Physical boundary"),
        ("table-row-4", "Таблица, строка 4", "Second heading\tOther"),
        ("table-row-5", "Таблица, строка 5", "Second table\tValue"),
    ]
    rows = [item["structure"] for item in result["fragments"] if item["structure"]["kind"] == "table-row"]
    assert [(item["tableId"], item["rowIndex"], item["rowCount"], item["headerMarker"]) for item in rows] == [
        ("word/document.xml:table-1", 0, 3, True), ("word/document.xml:table-1", 2, 3, False),
        ("word/document.xml:table-2", 0, 2, False), ("word/document.xml:table-2", 1, 2, False),
    ]
    assert [item["structure"]["physicalSection"] for item in result["fragments"]] == [0, 0, 0, 0, 1, 1]
    assert result["extractedText"] == "\n".join(item["text"] for item in result["fragments"])
    assert result["coverage"] == {"complete": True, "requiresOcr": False, "pagesWithoutText": [], "pagesWithImages": []}
    assert result["sha256"] == hashlib.sha256(original).hexdigest() and source.read_bytes() == original


@pytest.mark.parametrize(("marker", "expected"), [
    (None, False), ("<w:tblHeader/>", True), ('<w:tblHeader w:val="true"/>', True),
    ('<w:tblHeader w:val="1"/>', True), ('<w:tblHeader w:val="on"/>', True),
    ('<w:tblHeader w:val="false"/>', False), ('<w:tblHeader w:val="0"/>', False),
    ('<w:tblHeader w:val="off"/>', False),
])
def test_header_marker_uses_only_direct_native_on_off_not_words_or_first_row(tmp_path: Path, marker, expected):
    source = document(tmp_path / "header.docx", "<w:tbl>" + row("Состав действий", "Результат", marker=marker) + "</w:tbl>")
    result = extract_document(source)
    assert_closed(result)
    assert result["fragments"][0]["structure"]["headerMarker"] is expected


def test_whole_cells_preserve_internal_tabs_nested_tables_and_merges_without_fill_down(tmp_path: Path):
    first = ("<w:tc><w:tcPr><w:gridSpan w:val='2'/><w:vMerge w:val='restart'/></w:tcPr>"
             "<w:p><w:r><w:t>Alpha</w:t><w:tab/><w:t>Beta</w:t><w:br/><w:t>Line</w:t></w:r></w:p>"
             "<w:tbl>" + row("Nested", "Cell") + "</w:tbl></w:tc>")
    continued = "<w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p/></w:tc>"
    source = document(tmp_path / "nested.docx", "<w:tbl><w:tr>" + first + cell("Original")
                      + "</w:tr><w:tr>" + continued + cell("Next") + "</w:tr></w:tbl>")
    result = extract_document(source)
    assert_closed(result)
    assert [item["id"] for item in result["fragments"]] == ["table-row-1", "table-row-2"]
    first_row, second_row = result["fragments"]
    assert first_row["text"] == "Alpha\tBeta\nLine\nNested\tCell\tOriginal"
    assert first_row["structure"]["rowCount"] == second_row["structure"]["rowCount"] == 2
    assert first_row["structure"]["cells"] == [
        {"index": 0, "text": "Alpha\tBeta\nLine\nNested\tCell", "gridSpan": 2, "verticalMerge": "restart", "nestedTableCount": 1},
        {"index": 1, "text": "Original", "gridSpan": 1, "verticalMerge": "none", "nestedTableCount": 0},
    ]
    assert second_row["text"] == "\tNext"
    assert second_row["structure"]["cells"][0] == {"index": 0, "text": "", "gridSpan": 1, "verticalMerge": "continue", "nestedTableCount": 0}
    assert result["extractedText"].count("Nested") == 1


def test_long_cells_are_whole_and_not_subject_to_a_2000_or_20000_character_quote_cut(tmp_path: Path):
    text = "  Beginning\t" + "Длинное условие; " * 4000 + "\nEnd  "
    # Native tabs/newlines are inside one cell; no text-splitting shortcut.
    source = document(tmp_path / "long.docx", "<w:tbl>" + row(text, "Last") + "</w:tbl>")
    result = extract_document(source)
    assert_closed(result)
    assert result["fragments"][0]["structure"]["cells"][0]["text"] == text
    assert result["fragments"][0]["text"] == text + "\tLast"


def test_only_actual_direct_or_inherited_outline_levels_create_outline_metadata(tmp_path: Path):
    definitions = styles(style("Base", level="2"), style("Derived", parent="Base"), style("Heading1"),
                         style("Body", parent="Base", level="9"), style("Bad", parent="Base", level="wrong"),
                         style("CycleA", parent="CycleB", level="1"), style("CycleB", parent="CycleA"))
    settings = [('<w:pStyle w:val="Derived"/>', {"styleId": "Derived", "outlineLevel": 2, "outlineBasis": "style"}),
                ('<w:pStyle w:val="Derived"/><w:outlineLvl w:val="0"/>', {"styleId": "Derived", "outlineLevel": 0, "outlineBasis": "paragraph"}),
                ('<w:pStyle w:val="Derived"/><w:outlineLvl w:val="9"/>', {"styleId": "Derived"}),
                ('<w:pStyle w:val="Derived"/><w:outlineLvl w:val="broken"/>', {"styleId": "Derived"}),
                ('<w:pStyle w:val="Heading1"/>', {"styleId": "Heading1"}),
                ('<w:pStyle w:val="Unknown"/>', {"styleId": "Unknown"}),
                ('<w:pStyle w:val="Body"/>', {"styleId": "Body"}),
                ('<w:pStyle w:val="Bad"/>', {"styleId": "Bad"}),
                ('<w:pStyle w:val="CycleA"/>', {"styleId": "CycleA"})]
    source = document(tmp_path / "outlines.docx", "".join(paragraph(f"Paragraph {index}", properties) for index, (properties, _) in enumerate(settings)),
                      **{"word/styles.xml": definitions})
    result = extract_document(source)
    assert_closed(result)
    for fragment, (_, expected) in zip(result["fragments"], settings, strict=True):
        assert {key: value for key, value in fragment["structure"].items() if key in PARAGRAPH_KEYS} == expected
    assert result["extractedText"] == "\n".join(f"Paragraph {index}" for index in range(len(settings)))


def test_duplicate_or_deep_style_definitions_do_not_invent_an_outline(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(structure_module, "MAX_STYLE_DEPTH", 2)
    definitions = styles(style("Duplicate", level="1"), style("Duplicate", level="2"),
                         style("Deep", parent="Middle"), style("Middle", parent="Base"), style("Base", level="3"),
                         '<w:style w:type="paragraph" w:styleId="Malformed"><w:basedOn w:val="Base"/><w:pPr/><w:pPr/></w:style>')
    source = document(tmp_path / "styles.docx", "".join(paragraph(name, f'<w:pStyle w:val="{name}"/>') for name in ["Duplicate", "Deep", "Malformed"]),
                      **{"word/styles.xml": definitions})
    result = extract_document(source)
    assert all("outlineLevel" not in item["structure"] for item in result["fragments"])


def test_auxiliary_native_parts_keep_old_text_order_and_no_invented_body_section_links(tmp_path: Path):
    body = (paragraph("Section zero", "<w:sectPr/>") + paragraph("Section one")
            + '<w:p><w:r><w:t>References</w:t></w:r><w:footnoteReference w:id="3"/><w:endnoteReference w:id="7"/></w:p><w:sectPr/>')
    source = document(tmp_path / "parts.docx", body, **{
        "word/header1.xml": f'<w:hdr xmlns:w="{WORD}">{paragraph("Header")}</w:hdr>',
        "word/footer1.xml": f'<w:ftr xmlns:w="{WORD}">{paragraph("Footer")}</w:ftr>',
        "word/footnotes.xml": f'<w:footnotes xmlns:w="{WORD}"><w:footnote w:id="3">{paragraph("Footnote")}</w:footnote><w:footnote w:id="9">{paragraph("UNREFERENCED")}</w:footnote></w:footnotes>',
        "word/endnotes.xml": f'<w:endnotes xmlns:w="{WORD}"><w:endnote w:id="7">{paragraph("Endnote")}</w:endnote></w:endnotes>',
    })
    result = extract_document(source)
    assert_closed(result)
    assert [item["id"] for item in result["fragments"]] == ["paragraph-1", "paragraph-2", "paragraph-3", "section-1", "section-2", "footnote-3", "endnote-7"]
    assert [item["text"] for item in result["fragments"]] == ["Section zero", "Section one", "References[Сноска 3][Концевая сноска 7]", "Footer", "Header", "[Сноска 3] Footnote", "[Концевая сноска 7] Endnote"]
    assert [item["structure"]["physicalSection"] for item in result["fragments"]] == [0, 1, 1, 0, 0, 0, 0]
    assert [item["structure"]["part"] for item in result["fragments"][3:]] == ["word/footer1.xml", "word/header1.xml", "word/footnotes.xml", "word/endnotes.xml"]
    assert [item["structure"]["kind"] for item in result["fragments"][3:]] == ["header-footer", "header-footer", "note", "note"]
    assert "UNREFERENCED" not in result["extractedText"]


def test_misplaced_cell_or_auxiliary_sectpr_does_not_advance_later_body_owners(tmp_path: Path):
    nested = ("<w:tr><w:tc>" + paragraph("Cell content", "<w:sectPr/>")
              + "</w:tc></w:tr>")
    body = (paragraph("Before table") + "<w:tbl>" + nested + row("Following row") + "</w:tbl>"
            + paragraph("After table") + paragraph("Legal body paragraph boundary", "<w:sectPr/>")
            + '<w:p><w:r><w:t>After boundary</w:t></w:r><w:footnoteReference w:id="3"/><w:footnoteReference w:id="4"/></w:p>'
            + "<w:sectPr/>")
    source = document(tmp_path / "misplaced-section.docx", body, **{
        "word/header1.xml": f'<w:hdr xmlns:w="{WORD}">{paragraph("Header", "<w:sectPr/>")}</w:hdr>',
        "word/footnotes.xml": (f'<w:footnotes xmlns:w="{WORD}"><w:footnote w:id="3">'
                               + paragraph("First note", "<w:sectPr/>") + '</w:footnote><w:footnote w:id="4">'
                               + paragraph("Following note") + "</w:footnote></w:footnotes>"),
    })
    before = source.read_bytes()
    result = extract_document(source)
    assert_closed(result)
    assert [(fragment["id"], fragment["text"], fragment["structure"]["physicalSection"])
            for fragment in result["fragments"]] == [
        ("paragraph-1", "Before table", 0), ("table-row-1", "Cell content", 0),
        ("table-row-2", "Following row", 0), ("paragraph-2", "After table", 0),
        ("paragraph-3", "Legal body paragraph boundary", 0),
        ("paragraph-4", "After boundary[Сноска 3][Сноска 4]", 1),
        ("section-1", "Header", 0), ("footnote-3", "[Сноска 3] First note", 0),
        ("footnote-4", "[Сноска 4] Following note", 0),
    ]
    assert result["extractedText"] == "\n".join(fragment["text"] for fragment in result["fragments"])
    assert source.read_bytes() == before


@pytest.mark.parametrize("properties", ['<w:gridSpan w:val="0"/>', '<w:gridSpan w:val="-1"/>',
                                        '<w:gridSpan w:val="bad"/>', '<w:gridSpan w:val="16385"/>',
                                        '<w:gridSpan/><w:gridSpan w:val="2"/>', '<w:vMerge w:val="wrong"/>'])
def test_malformed_cell_structure_fails_explicitly_without_repairing_original_text(tmp_path: Path, properties):
    source = document(tmp_path / "bad-merge.docx", "<w:tbl><w:tr>" + cell("Original text", properties) + "</w:tr></w:tbl>")
    before = source.read_bytes()
    with pytest.raises(ValueError, match="DOCX"):
        extract_document(source)
    assert source.read_bytes() == before


def test_malformed_header_does_not_become_a_guessed_header(tmp_path: Path):
    source = document(tmp_path / "bad-header.docx", "<w:tbl>" + row("Heading", marker='<w:tblHeader w:val="unknown"/>') + "</w:tbl>")
    with pytest.raises(ValueError, match="маркер заголовка"):
        extract_document(source)


def test_structure_work_is_bounded_without_changing_or_truncating_source_owners(tmp_path: Path, monkeypatch):
    root = etree.fromstring(f'<w:body xmlns:w="{WORD}">{"<w:p/>" * 33}</w:body>')
    with pytest.raises(ValueError, match="XML-узлов"):
        DocxStructure(root, max_fragments=1)
    monkeypatch.setattr(structure_module, "MAX_ROW_CELLS", 1)
    source = document(tmp_path / "too-many-cells.docx", "<w:tbl>" + row("A", "B") + "</w:tbl>")
    before = source.read_bytes()
    with pytest.raises(ValueError, match="слишком много ячеек"):
        extract_document(source)
    assert source.read_bytes() == before
