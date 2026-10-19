"""Additive native DOCX structure; never a semantic document classifier.

The existing extractor owns fragment IDs, text, order and trimming. This helper
only describes those emitted owners. ``physicalSection`` is a PART-LOCAL index
of actual sectPr boundaries, not a logical heading or an auxiliary-part link to
a body section. A header/footer/note with no local boundary therefore has 0.
"""
from __future__ import annotations

import re
from collections.abc import Callable


WORD = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
MAX_STYLE_DEPTH = 64
MAX_STYLE_ID_CHARS = 256
MAX_ROW_CELLS = 4096
MAX_GRID_SPAN = 16_384


def _tag(name: str) -> str:
    return f"{{{WORD}}}{name}"


def _single(element, name: str):
    children = element.findall(_tag(name)) if element is not None else []
    return children[0] if len(children) == 1 else None


def _identifier(value: str | None) -> str | None:
    if (value and value.strip() and len(value) <= MAX_STYLE_ID_CHARS
            and not re.search(r"[\x00-\x1f\x7f-\x9f]", value)):
        return value
    return None


def _outline(properties) -> tuple[bool, int | None]:
    """Declared body-text/invalid values suppress inheritance, never a heading."""
    entries = properties.findall(_tag("outlineLvl")) if properties is not None else []
    if not entries:
        return False, None
    if len(entries) != 1:
        return True, None
    raw = entries[0].get(_tag("val"), "")
    if not re.fullmatch(r"[0-9]{1,2}", raw):
        return True, None
    value = int(raw)
    return True, value if 0 <= value <= 8 else None


class DocxStructure:
    """Bounded OOXML provenance for existing whole-fragment owners only."""

    def __init__(self, body, styles=None, *, max_fragments: int = 50_000,
                 max_characters: int = 20 * 1024 * 1024) -> None:
        self.max_fragments = max_fragments
        self.max_characters = max_characters
        self._nodes = 0
        self._cells = 0
        self._cell_characters = 0
        self._emitted = 0
        self._parts: set[str] = set()
        self._locations: dict = {}
        self._rows: dict = {}
        self._styles: dict = {}
        self._style_levels: dict[str, int | None] = {}
        if styles is not None:
            self._read_styles(styles)
        self.add_part("word/document.xml", body)

    def _node(self) -> None:
        self._nodes += 1
        if self._nodes > self.max_fragments * 32:
            raise ValueError("Структура DOCX превышает безопасный предел XML-узлов.")

    def _read_styles(self, root) -> None:
        for _element in root.iter():
            self._node()
        entries = root.findall(_tag("style"))
        if len(entries) > self.max_fragments:
            raise ValueError("DOCX содержит слишком много определений стилей.")
        for element in entries:
            identifier = _identifier(element.get(_tag("styleId")))
            if not identifier:
                continue
            # A duplicate ID is ambiguous, even when the duplicate has no level.
            if identifier in self._styles:
                self._styles[identifier] = None
                continue
            self._styles[identifier] = element if (element.get(_tag("type")) in {None, "paragraph"}
                                                  and len(element.findall(_tag("pPr"))) <= 1) else None

    def _style_outline(self, identifier: str) -> int | None:
        if identifier in self._style_levels:
            return self._style_levels[identifier]
        current, seen = identifier, set()
        declared, selected = False, None
        for _depth in range(MAX_STYLE_DEPTH):
            if current in seen:
                selected = None
                break
            seen.add(current)
            element = self._styles.get(current)
            if element is None:
                # An unknown/ambiguous parent does not supply a missing level.
                # A nearer explicitly declared level remains native evidence.
                break
            present, level = _outline(_single(element, "pPr"))
            if not declared and present:
                declared, selected = True, level
            parent = _single(element, "basedOn")
            current = _identifier(parent.get(_tag("val"))) if parent is not None else None
            if current is None:
                break
        else:
            selected = None
        self._style_levels[identifier] = selected
        return selected

    def add_part(self, part: str, root) -> None:
        if (not isinstance(part, str) or not part.startswith("word/") or len(part) > MAX_STYLE_ID_CHARS
                or re.search(r"[\x00-\x1f\x7f-\x9f]", part) or part in self._parts):
            raise ValueError("DOCX содержит неоднозначную структурную часть.")
        self._parts.add(part)
        physical_section, table_index = 0, 0
        tables: dict = {}
        for element in root.iter():
            self._node()
            # Do not retain a Python wrapper/map entry for every text run.
            # Only existing fragment-owner kinds can be described later.
            if element is root or element.tag in {_tag("p"), _tag("tr"), _tag("footnote"), _tag("endnote")}:
                self._locations[element] = (part, physical_section)
            if element.tag == _tag("tbl"):
                table_index += 1
                tables[element] = (f"{part}:table-{table_index}", [])
            elif element.tag == _tag("tr"):
                table = next((ancestor for ancestor in element.iterancestors()
                              if ancestor.tag == _tag("tbl")), None)
                if table in tables:
                    tables[table][1].append(element)
            elif element.tag == _tag("sectPr"):
                parent = element.getparent()
                paragraph = parent.getparent() if parent is not None else None
                body_boundary = parent is root and root.tag == _tag("body")
                paragraph_boundary = (parent is not None and parent.tag == _tag("pPr")
                                      and paragraph is not None and paragraph.tag == _tag("p")
                                      and not any(ancestor.tag in {_tag("tr"), _tag("p")}
                                                  for ancestor in paragraph.iterancestors()))
                # A sectPr in a table cell, nested paragraph or auxiliary part
                # does not establish a body-pagination boundary. Aux parts
                # have no legal body-section evidence and remain local 0.
                if part == "word/document.xml" and (body_boundary or paragraph_boundary):
                    physical_section += 1
                    if physical_section > self.max_fragments:
                        raise ValueError("DOCX содержит слишком много физических границ разделов.")
        for table_id, rows in tables.values():
            if len(rows) > self.max_fragments:
                raise ValueError("DOCX содержит слишком много строк одной таблицы.")
            for row_index, row in enumerate(rows):
                self._rows[row] = (table_id, row_index, len(rows))

    @staticmethod
    def _table_property(element, properties: str, name: str):
        parents = element.findall(_tag(properties))
        if len(parents) > 1:
            raise ValueError("DOCX содержит неоднозначные свойства таблицы.")
        entries = parents[0].findall(_tag(name)) if parents else []
        if len(entries) > 1:
            raise ValueError("DOCX содержит повторяющееся свойство таблицы.")
        return entries[0] if entries else None

    def _table(self, element, text: str, cell_text: Callable) -> dict:
        owner = self._rows.get(element)
        if owner is None:
            raise ValueError("DOCX содержит строку без подтверждённой родительской таблицы.")
        table_id, row_index, row_count = owner
        marker = self._table_property(element, "trPr", "tblHeader")
        value = marker.get(_tag("val")) if marker is not None else "false"
        if value not in {None, "true", "1", "on", "false", "0", "off"}:
            raise ValueError("DOCX содержит повреждённый маркер заголовка таблицы.")
        # This is an effective native marker, not a semantic header/body verdict.
        header = value in {None, "true", "1", "on"}
        native_cells = element.findall(_tag("tc"))
        if len(native_cells) > MAX_ROW_CELLS:
            raise ValueError("DOCX содержит слишком много ячеек одной строки.")
        cells = []
        for index, cell in enumerate(native_cells):
            self._cells += 1
            if self._cells > self.max_fragments * 4:
                raise ValueError("Структура DOCX превышает безопасный предел ячеек.")
            span = self._table_property(cell, "tcPr", "gridSpan")
            raw_span = span.get(_tag("val"), "") if span is not None else "1"
            if not re.fullmatch(r"[0-9]{1,5}", raw_span) or not 1 <= int(raw_span) <= MAX_GRID_SPAN:
                raise ValueError("DOCX содержит повреждённое объединение ячеек.")
            merge = self._table_property(cell, "tcPr", "vMerge")
            vertical_merge = merge.get(_tag("val"), "continue") if merge is not None else "none"
            if vertical_merge not in {"none", "restart", "continue"} or merge is not None and vertical_merge == "none":
                raise ValueError("DOCX содержит повреждённое вертикальное объединение.")
            value = cell_text(cell)
            self._cell_characters += len(value)
            if self._cell_characters > self.max_characters:
                raise ValueError("Текст структурных ячеек DOCX превышает безопасный предел.")
            nested_tables = sum(1 for _nested in cell.iter(_tag("tbl")))
            if nested_tables > self.max_fragments:
                raise ValueError("DOCX содержит слишком много вложенных таблиц одной ячейки.")
            cells.append({"index": index, "text": value, "gridSpan": int(raw_span),
                          "verticalMerge": vertical_merge,
                          "nestedTableCount": nested_tables})
        if "\t".join(cell["text"] for cell in cells) != text:
            raise ValueError("Текст строки DOCX не совпадает с её целыми исходными ячейками.")
        return {"containerId": table_id, "tableId": table_id, "rowIndex": row_index,
                "rowCount": row_count, "headerMarker": header, "cells": cells}

    def describe(self, element, *, kind: str, order: int, text: str,
                 cell_text: Callable | None = None) -> dict:
        if (kind not in {"paragraph", "table-row", "header-footer", "note"}
                or order != self._emitted or order >= self.max_fragments or element not in self._locations):
            raise ValueError("Нарушено владение или порядок структурных фрагментов DOCX.")
        part, physical_section = self._locations[element]
        container = f"{part}:body" if kind == "paragraph" else part
        if kind == "note":
            note_id = element.get(_tag("id"), "")
            if len(note_id) > MAX_STYLE_ID_CHARS:
                raise ValueError("DOCX содержит слишком длинный идентификатор сноски.")
            container = f"{part}:note-{note_id}"
        if not _identifier(container):
            raise ValueError("DOCX содержит слишком длинный структурный идентификатор.")
        result = {"version": 1, "format": "docx", "method": "ooxml", "part": part,
                  "kind": kind, "containerId": container, "order": order,
                  "physicalSection": physical_section}
        if kind == "paragraph":
            properties = _single(element, "pPr")
            style = _single(properties, "pStyle")
            style_id = _identifier(style.get(_tag("val"))) if style is not None else None
            if style_id:
                result["styleId"] = style_id
            declared, level = _outline(properties)
            if declared:
                if level is not None:
                    result.update(outlineLevel=level, outlineBasis="paragraph")
            elif style_id:
                level = self._style_outline(style_id)
                if level is not None:
                    result.update(outlineLevel=level, outlineBasis="style")
        elif kind == "table-row":
            if cell_text is None:
                raise ValueError("Отсутствует исходный текст структурных ячеек DOCX.")
            result.update(self._table(element, text, cell_text))
        self._emitted += 1
        return result
