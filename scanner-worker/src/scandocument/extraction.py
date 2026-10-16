from __future__ import annotations

import hashlib
import math
import os
import posixpath
import re
import stat
import zipfile
from datetime import datetime, timedelta
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP, localcontext
from pathlib import Path

import pypdfium2 as pdfium
import pypdfium2.raw as pdfium_raw
from lxml import etree

from scandocument.tempfiles import SecureWorkspace
from scandocument.validation import MAX_FILE_BYTES, MAX_PAGES, validate_docx_archive


MAX_SOURCE_BYTES = MAX_FILE_BYTES
MAX_EXTRACTED_CHARS = 20 * 1024 * 1024
MAX_ZIP_UNPACKED_BYTES = 500 * 1024 * 1024
MAX_XML_PART_BYTES = 50 * 1024 * 1024
MAX_FRAGMENTS = 50_000
MAX_SHEETS = 1_000
NS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
NS_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
NS_PACKAGE_REL = "http://schemas.openxmlformats.org/package/2006/relationships"
NS_WORD = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
CELL_REFERENCE = re.compile(r"([A-Z]{1,3})([1-9][0-9]{0,6})\Z")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _validate_source(path: Path) -> tuple[int, bytes]:
    # Extraction uses the streaming snapshot below; retain this probe for callers.
    if not path.is_file():
        raise ValueError("Документ не найден.")
    with path.open("rb") as stream:
        size = os.fstat(stream.fileno()).st_size
        if size <= 0 or size > MAX_SOURCE_BYTES:
            raise ValueError("Размер документа должен быть от 1 байта до 1 ГБ.")
        return size, stream.read(8)


def _snapshot_source(path: Path, snapshot: Path) -> tuple[int, bytes, str]:
    digest = hashlib.sha256()
    size = 0
    magic = b""
    with path.open("rb") as source, snapshot.open("xb") as target:
        before = os.fstat(source.fileno())
        if not stat.S_ISREG(before.st_mode):
            raise ValueError("Выберите обычный файл документа.")
        if before.st_size <= 0 or before.st_size > MAX_SOURCE_BYTES:
            raise ValueError("Размер документа должен быть от 1 байта до 1 ГБ.")
        for block in iter(lambda: source.read(1024 * 1024), b""):
            size += len(block)
            if size > MAX_SOURCE_BYTES:
                raise ValueError("Размер документа должен быть от 1 байта до 1 ГБ.")
            if not magic:
                magic = block[:8]
            digest.update(block)
            target.write(block)
        after = os.fstat(source.fileno())
        if size != before.st_size or (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (
                after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise ValueError("Документ изменился во время чтения. Дождитесь завершения его сохранения и добавьте файл снова.")
    return size, magic, digest.hexdigest()


class _Fragments(list):
    def __init__(self) -> None:
        super().__init__()
        self.characters = 0

    def append(self, fragment: dict) -> None:
        self.characters += len(str(fragment.get("text", "")))
        if len(self) >= MAX_FRAGMENTS:
            raise ValueError("Документ содержит слишком много текстовых фрагментов.")
        if self.characters > MAX_EXTRACTED_CHARS:
            raise ValueError("Извлечённый текст превышает безопасный предел 20 МБ.")
        super().append(fragment)


def _bounded(fragments: list[dict]) -> tuple[list[dict], str]:
    if len(fragments) > MAX_FRAGMENTS:
        raise ValueError("Документ содержит слишком много текстовых фрагментов.")
    texts = [str(fragment.get("text", "")) for fragment in fragments]
    if sum(map(len, texts)) > MAX_EXTRACTED_CHARS:
        raise ValueError("Извлечённый текст превышает безопасный предел 20 МБ.")
    # Leading tabs identify missing XLSX columns and must survive model input.
    return fragments, "\n".join(text for text in texts if text.strip())


def _xml(archive: zipfile.ZipFile, name: str):
    if archive.getinfo(name).file_size > MAX_XML_PART_BYTES:
        raise ValueError("XML-часть документа превышает безопасный предел 50 МБ.")
    parser = etree.XMLParser(resolve_entities=False, load_dtd=False, no_network=True)
    root = etree.fromstring(archive.read(name), parser=parser)
    if root.getroottree().docinfo.doctype:
        raise ValueError("Документ содержит неподдерживаемые XML-сущности.")
    return root


def _coverage(complete=True, *, no_text=None, images=None) -> dict:
    return {"complete": bool(complete), "requiresOcr": bool(no_text or images),
            "pagesWithoutText": no_text or [], "pagesWithImages": images or []}


def _pdf_metadata_value(document, key: str) -> str:
    # Metadata is only a provenance hint, never evidence of OCR completeness.
    # Probe its size before using the helper, which otherwise allocates a buffer
    # of arbitrary size supplied by the PDF.
    size = pdfium_raw.FPDF_GetMetaText(document, key.encode("ascii") + b"\0", None, 0)
    return document.get_metadata_value(key).strip() if 2 <= size <= 512 else ""


def _pdf(path: Path) -> tuple[str, list[dict], list[str], dict]:
    document = pdfium.PdfDocument(path)
    fragments = _Fragments()
    no_text: list[int] = []
    image_pages: list[int] = []
    scanner_producer = False
    scanner_ocr_attempted = False
    try:
        if len(document) > MAX_PAGES:
            raise ValueError("PDF содержит слишком много страниц.")
        scanner_producer = _pdf_metadata_value(document, "Producer") == "ScanDocument"
        scanner_ocr_attempted = scanner_producer and _pdf_metadata_value(document, "ScanDocumentOCR") == "attempted-v1"
        for index in range(len(document)):
            page = document[index]
            text_page = page.get_textpage()
            try:
                text = text_page.get_text_range().strip()
                # Text in the body does not prove that a raster letterhead was OCRed.
                has_images = next(page.get_objects(filter=[pdfium_raw.FPDF_PAGEOBJ_IMAGE]), None) is not None
            finally:
                text_page.close()
                page.close()
            if not text:
                no_text.append(index + 1)
            if has_images:
                image_pages.append(index + 1)
            fragments.append({"id": f"page-{index + 1}", "locator": f"Страница {index + 1}",
                              "page": index + 1, "text": text, "hasImages": has_images,
                              "textCoverage": "partial" if not text or has_images else "text-layer"})
    finally:
        document.close()
    warnings: list[str] = []
    if scanner_ocr_attempted:
        warnings.append("По метаданным PDF ранее выполнялось OCR сканером приложения; это отметка обработки, а не подтверждение полноты распознавания.")
    elif scanner_producer and len(no_text) < len(fragments):
        warnings.append("По метаданным PDF создан сканером приложения. Найден текстовый слой; наличие прежнего OCR по этим метаданным не подтверждено.")
    if no_text:
        if len(no_text) == len(fragments):
            warnings.append("В PDF нет текстового слоя. " + (
                "Проверьте качество скана и языки распознавания; при необходимости выполните OCR повторно."
                if scanner_ocr_attempted else "Для поиска сначала выполните OCR в модуле сканирования."))
        else:
            warnings.append(f"Текст извлечён не со всех страниц PDF. Без текстового слоя: {', '.join(map(str, no_text))}. " + (
                "Проверьте эти страницы; при необходимости выполните OCR повторно только для этих страниц."
                if scanner_ocr_attempted else "Выполните OCR или исключите эти страницы."))
    if image_pages:
        warnings.append(f"PDF содержит изображения на страницах: {', '.join(map(str, image_pages))}. " + (
            "Найден текстовый слой; полнота текста внутри изображений и растровых шапок не подтверждена. Проверьте извлечённый текст по страницам и при пропусках выполните OCR для нужных страниц."
            if len(no_text) < len(fragments) else
            "Текст внутри изображений и растровых шапок сейчас недоступен для извлечения; полнота документа не подтверждена."))
    return "application/pdf", fragments, warnings, _coverage(not no_text and not image_pages, no_text=no_text, images=image_pages)


def _word_text(element, references: dict[str, list[str]]) -> str:
    tag = etree.QName(element).localname if isinstance(element.tag, str) else ""
    if tag in {"del", "moveFrom", "instrText", "delText"}:
        return ""
    if tag == "t":
        # Some exported DOCX files nest text runs inside w:t. Keep that readable
        # content without inventing separators or including deleted/instruction text.
        return (element.text or "") + "".join(
            _word_text(child, references) + (child.tail or "") for child in element)
    if tag == "tab":
        return "\t"
    if tag in {"br", "cr"}:
        return "\n"
    if tag in {"footnoteReference", "endnoteReference"}:
        kind = "footnote" if tag == "footnoteReference" else "endnote"
        note_id = element.attrib.get(f"{{{NS_WORD}}}id", "")
        if not note_id:
            raise ValueError("DOCX содержит повреждённую ссылку на сноску.")
        if note_id not in references[kind]:
            references[kind].append(note_id)
        return f"[{('Сноска' if kind == 'footnote' else 'Концевая сноска')} {note_id}]"
    if tag == "tr":
        return "\t".join(_word_text(cell, references).strip("\n") for cell in element.findall(f"{{{NS_WORD}}}tc")) + "\n"
    text = "".join(_word_text(child, references) for child in element)
    return text + "\n" if tag == "p" else text


def _docx(path: Path) -> tuple[str, list[dict], list[str], dict]:
    validate_docx_archive(path)
    with zipfile.ZipFile(path) as archive:
        names = set(archive.namelist())
        if "word/document.xml" not in names or "[Content_Types].xml" not in names:
            raise ValueError("DOCX повреждён или имеет неподдерживаемую структуру.")
        fragments = _Fragments()
        references: dict[str, list[str]] = {"footnote": [], "endnote": []}
        body = _xml(archive, "word/document.xml").find(f"{{{NS_WORD}}}body")
        if body is None:
            raise ValueError("DOCX повреждён или имеет неподдерживаемую структуру.")
        paragraph_index = 0
        row_index = 0
        for element in body.iter():
            if element.tag == f"{{{NS_WORD}}}p":
                if any(ancestor.tag in {f"{{{NS_WORD}}}tr", f"{{{NS_WORD}}}p"} for ancestor in element.iterancestors()):
                    continue
                paragraph_index += 1
                text = _word_text(element, references).strip()
                if text:
                    fragments.append({"id": f"paragraph-{paragraph_index}", "locator": f"Абзац {paragraph_index}",
                                      "section": f"Абзац {paragraph_index}", "text": text})
            elif element.tag == f"{{{NS_WORD}}}tr":
                if any(ancestor.tag == f"{{{NS_WORD}}}tr" for ancestor in element.iterancestors()):
                    continue
                row_index += 1
                text = _word_text(element, references).strip("\n")
                if text.strip():
                    fragments.append({"id": f"table-row-{row_index}", "locator": f"Таблица, строка {row_index}",
                                      "section": "Таблица", "text": text})
        header_footer_names = sorted(name for name in names if (name.startswith("word/header") or name.startswith("word/footer")) and name.endswith(".xml"))
        for index, name in enumerate(header_footer_names, 1):
            kind = "Верхний колонтитул" if "/header" in name else "Нижний колонтитул"
            text = _word_text(_xml(archive, name), references).strip()
            if text:
                fragments.append({"id": f"section-{index}", "locator": f"Раздел {index}: {kind}",
                                  "section": f"Раздел {index}", "text": text})
        for kind, note_ids in references.items():
            if not note_ids:
                continue
            part = f"word/{'footnotes' if kind == 'footnote' else 'endnotes'}.xml"
            if part not in names:
                raise ValueError("DOCX содержит ссылку на отсутствующую часть со сносками.")
            notes = {note.attrib.get(f"{{{NS_WORD}}}id"): note for note in _xml(archive, part)
                     if note.tag == f"{{{NS_WORD}}}{kind}"}
            for note_id in list(note_ids):
                note = notes.get(note_id)
                if note is None:
                    raise ValueError("DOCX содержит ссылку на отсутствующую сноску.")
                label = f"{('Сноска' if kind == 'footnote' else 'Концевая сноска')} {note_id}"
                text = _word_text(note, references).strip()
                fragments.append({"id": f"{kind}-{note_id}", "locator": label, "section": "Сноски",
                                  "noteId": note_id, "noteType": kind, "text": f"[{label}] {text}"})
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document", fragments, [], _coverage()


BUILTIN_FORMATS = {
    0: "General", 1: "0", 2: "0.00", 9: "0%", 10: "0.00%", 14: "mm-dd-yy", 15: "d-mmm-yy",
    16: "d-mmm", 17: "mmm-yy", 18: "h:mm AM/PM", 19: "h:mm:ss AM/PM", 20: "h:mm", 21: "h:mm:ss",
    22: "m/d/yy h:mm", 45: "mm:ss", 46: "[h]:mm:ss", 47: "mmss.0", 49: "@",
}


def _styles(archive: zipfile.ZipFile, names: set[str]) -> list[str]:
    if "xl/styles.xml" not in names:
        return ["General"]
    root = _xml(archive, "xl/styles.xml")
    custom: dict[int, str] = {}
    for entry in root.findall(f"./{{{NS_MAIN}}}numFmts/{{{NS_MAIN}}}numFmt"):
        try:
            custom[int(entry.attrib["numFmtId"])] = entry.attrib["formatCode"]
        except (ValueError, KeyError) as error:
            raise ValueError("XLSX содержит повреждённый числовой формат.") from error
    formats: list[str] = []
    for entry in root.findall(f"./{{{NS_MAIN}}}cellXfs/{{{NS_MAIN}}}xf"):
        try:
            identifier = int(entry.attrib.get("numFmtId", "0"))
        except ValueError as error:
            raise ValueError("XLSX содержит повреждённую ссылку на числовой формат.") from error
        formats.append(custom.get(identifier, BUILTIN_FORMATS.get(identifier, "General")))
    return formats or ["General"]


def _display_number(raw: str, number_format: str, date_1904: bool) -> tuple[str, str]:
    try:
        number = Decimal(raw)
    except InvalidOperation as error:
        raise ValueError("XLSX содержит повреждённое числовое значение.") from error
    if not number.is_finite():
        raise ValueError("XLSX содержит недопустимое числовое значение.")
    # Literals, colours and locale markers are not date/percent operators.
    code = re.sub(r'"[^"]*"|\\.', "", number_format.lower())
    code = re.sub(r'\[(?![hms]+\])[^\]]*\]', "", code).split(";")[0]
    if "%" in code:
        decimals = re.search(r"\.([0#]+)", code)
        digits = min(len(decimals.group(1)) if decimals else 0, 12)
        if abs(number.adjusted()) > 100:
            raise ValueError("XLSX содержит слишком большое процентное значение.")
        with localcontext() as context:
            context.prec = 128
            percentage = (number * 100).quantize(Decimal(1).scaleb(-digits), rounding=ROUND_HALF_UP)
        return f"{percentage:.{digits}f}%", "percentage"
    date_format = bool(re.search(r"[yd]", code))
    time_format = bool(re.search(r"[hs]", code))
    if date_format or time_format:
        serial = float(number)
        if not math.isfinite(serial) or abs(serial) > 3_000_000:
            raise ValueError("XLSX содержит дату вне поддерживаемого диапазона.")
        if not date_1904 and 60 <= serial < 61 and date_format:
            raise ValueError("XLSX содержит несуществующую дату 29.02.1900.")
        if time_format and not date_format:
            duration = "[h]" in code
            seconds = round(serial * 86400) if duration else round((serial % 1) * 86400) % 86400
            return f"{seconds // 3600:02d}:{seconds % 3600 // 60:02d}:{seconds % 60:02d}", "duration" if duration else "time"
        if not date_1904 and 0 < serial < 60:
            serial += 1
        try:
            value = (datetime(1904, 1, 1) if date_1904 else datetime(1899, 12, 30)) + timedelta(days=serial)
        except (OverflowError, ValueError) as error:
            raise ValueError("XLSX содержит дату вне поддерживаемого диапазона.") from error
        return (value.isoformat(timespec="seconds"), "datetime") if time_format else (value.date().isoformat(), "date")
    return raw, "number"


def _column(reference: str, row_number: int) -> int:
    match = CELL_REFERENCE.fullmatch(reference)
    if not match or int(match.group(2)) != row_number or row_number > 1_048_576:
        raise ValueError("XLSX содержит повреждённую координату ячейки.")
    column = 0
    for letter in match.group(1):
        column = column * 26 + ord(letter) - ord("A") + 1
    if column > 16_384:
        raise ValueError("XLSX содержит координату за пределами листа.")
    return column


def _column_name(column: int) -> str:
    letters = ""
    while column:
        column, remainder = divmod(column - 1, 26)
        letters = chr(65 + remainder) + letters
    return letters


def _xlsx(path: Path, include_hidden: bool, selected_sheets: list[str] | None) -> tuple[str, list[dict], list[str], dict, list[dict]]:
    fragments = _Fragments()
    warnings: list[str] = []
    sheets: list[dict] = []
    complete = True
    with zipfile.ZipFile(path) as archive:
        entries = archive.infolist()
        names = set(archive.namelist())
        if len(entries) > 50_000 or len(names) != len(entries) or sum(entry.file_size for entry in entries) > MAX_ZIP_UNPACKED_BYTES:
            raise ValueError("XLSX превышает безопасный предел или содержит повторяющиеся внутренние файлы.")
        if "xl/workbook.xml" not in names or "xl/_rels/workbook.xml.rels" not in names or "[Content_Types].xml" not in names:
            raise ValueError("XLSX повреждён или имеет неподдерживаемую структуру.")
        shared: list[str] = []
        if "xl/sharedStrings.xml" in names:
            shared = ["".join(node.text or "" for node in item.iter(f"{{{NS_MAIN}}}t"))
                      for item in _xml(archive, "xl/sharedStrings.xml").findall(f"{{{NS_MAIN}}}si")]
        formats = _styles(archive, names)
        relations = _xml(archive, "xl/_rels/workbook.xml.rels")
        targets: dict[str, str] = {}
        for entry in relations.findall(f"{{{NS_PACKAGE_REL}}}Relationship"):
            identifier = entry.attrib.get("Id", "")
            target = entry.attrib.get("Target", "")
            if not identifier or identifier in targets or entry.attrib.get("TargetMode") == "External" or ":" in target:
                raise ValueError("XLSX содержит повреждённые или внешние ссылки на листы.")
            targets[identifier] = posixpath.normpath(target.lstrip("/") if target.startswith("/") else posixpath.join("xl", target))
        workbook = _xml(archive, "xl/workbook.xml")
        date_1904 = workbook.find(f"{{{NS_MAIN}}}workbookPr")
        date_1904 = date_1904 is not None and date_1904.attrib.get("date1904", "0") in {"1", "true"}
        declared = workbook.findall(f".//{{{NS_MAIN}}}sheet")
        if len(declared) > MAX_SHEETS:
            raise ValueError("XLSX содержит слишком много листов.")
        identifiers: set[str] = set()
        for sheet in declared:
            identifier = sheet.attrib.get("sheetId", "")
            name = sheet.attrib.get("name", "")
            state = sheet.attrib.get("state", "visible")
            target = targets.get(sheet.attrib.get(f"{{{NS_REL}}}id", ""), "")
            if not identifier or identifier in identifiers or not name or state not in {"visible", "hidden", "veryHidden"} or target not in names:
                raise ValueError("XLSX содержит отсутствующий лист или повреждённое описание листов.")
            identifiers.add(identifier)
            included = (state == "visible" or include_hidden) and (selected_sheets is None or identifier in selected_sheets)
            sheets.append({"id": identifier, "name": name, "state": state, "included": included})
        if selected_sheets is not None and (any(identifier not in identifiers for identifier in selected_sheets)
                or any(sheet["state"] != "visible" and sheet["id"] in selected_sheets for sheet in sheets) and not include_hidden):
            raise ValueError("Выбраны неизвестные листы или скрытые листы без явного разрешения.")
        for sheet, metadata in zip(declared, sheets, strict=True):
            name = metadata["name"]
            if metadata["state"] != "visible":
                action = "включён по явному выбору пользователя" if metadata["included"] else "исключён из извлечения по умолчанию"
                warnings.append(f"Лист «{name}» скрыт ({metadata['state']}) и {action}.")
            if not metadata["included"]:
                continue
            target = targets[sheet.attrib[f"{{{NS_REL}}}id"]]
            root = _xml(archive, target)
            row_numbers: set[int] = set()
            for row_index, row in enumerate(root.findall(f"./{{{NS_MAIN}}}sheetData/{{{NS_MAIN}}}row"), 1):
                try:
                    row_number = int(row.attrib.get("r", str(row_index)))
                except ValueError as error:
                    raise ValueError("XLSX содержит повреждённую строку листа.") from error
                if row_number < 1 or row_number > 1_048_576 or row_number in row_numbers:
                    raise ValueError("XLSX содержит повторяющуюся или повреждённую строку листа.")
                row_numbers.add(row_number)
                values: dict[int, str] = {}
                cells: list[dict] = []
                last_column = 0
                for cell in row.findall(f"{{{NS_MAIN}}}c"):
                    reference = cell.attrib.get("r", f"{_column_name(last_column + 1)}{row_number}")
                    column = _column(reference, row_number)
                    if column in values:
                        raise ValueError("XLSX содержит повторяющуюся координату ячейки.")
                    last_column = max(column, last_column)
                    try:
                        style = int(cell.attrib.get("s", "0"))
                    except ValueError as error:
                        raise ValueError("XLSX содержит повреждённую ссылку на стиль ячейки.") from error
                    if style < 0 or style >= len(formats):
                        raise ValueError("XLSX содержит отсутствующий стиль ячейки.")
                    number_format = formats[style]
                    kind = cell.attrib.get("t", "n")
                    node = cell.find(f"{{{NS_MAIN}}}v")
                    raw = node.text if node is not None and node.text is not None else ""
                    value = raw
                    value_type = "text"
                    if kind == "inlineStr":
                        value = "".join(node.text or "" for node in cell.iter(f"{{{NS_MAIN}}}t"))
                        raw = value
                    elif kind == "s":
                        if not raw.isdigit() or int(raw) >= len(shared):
                            raise ValueError("XLSX содержит повреждённую ссылку на общий текст ячейки.")
                        value = shared[int(raw)]
                    elif kind == "b":
                        if raw not in {"0", "1"}:
                            raise ValueError("XLSX содержит повреждённое логическое значение.")
                        value, value_type = ("TRUE" if raw == "1" else "FALSE"), "boolean"
                    elif kind == "e":
                        value_type = "error"
                        complete = False
                        warnings.append(f"Лист «{name}», {reference}: сохранена ошибка Excel; значение не вычислено.")
                    elif kind == "d":
                        try:
                            datetime.fromisoformat(raw.replace("Z", "+00:00"))
                        except ValueError as error:
                            raise ValueError("XLSX содержит повреждённую дату.") from error
                        value_type = "datetime" if "T" in raw else "date"
                    elif kind in {"n", ""} and raw:
                        value, value_type = _display_number(raw, number_format, bool(date_1904))
                    elif kind not in {"n", "", "str"}:
                        raise ValueError("XLSX содержит неподдерживаемый тип ячейки.")
                    has_formula = cell.find(f"{{{NS_MAIN}}}f") is not None
                    if has_formula and not raw:
                        complete = False
                        warnings.append(f"Лист «{name}», {reference}: у формулы нет сохранённого значения; пересчёт формул не выполнялся.")
                    values[column] = value
                    cells.append({"reference": reference, "text": value, "rawValue": raw,
                                  "valueType": value_type if value else "empty", "numberFormat": number_format,
                                  "hasFormula": has_formula})
                text = "\t".join(values.get(column, "") for column in range(1, last_column + 1))
                if text.strip():
                    first = f"A{row_number}"
                    last = f"{_column_name(last_column)}{row_number}"
                    cell_range = first if first == last else f"{first}:{last}"
                    fragments.append({"id": f"sheet-{metadata['id']}-row-{row_number}", "locator": f"Лист {name}, {cell_range}",
                                      "sheet": name, "sheetId": metadata["id"], "sheetState": metadata["state"],
                                      "includedByUser": metadata["state"] != "visible" and include_hidden,
                                      "cellRange": cell_range, "cells": cells, "text": text})
    return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", fragments, warnings, _coverage(complete), sheets


def extract_document(path: Path, *, include_hidden_sheets: bool = False, selected_sheets: list[str] | None = None) -> dict:
    if not isinstance(include_hidden_sheets, bool) or (selected_sheets is not None and (
            not isinstance(selected_sheets, list) or len(selected_sheets) > MAX_SHEETS
            or any(not isinstance(identifier, str) or not identifier or len(identifier) > 128 for identifier in selected_sheets)
            or len(set(selected_sheets)) != len(selected_sheets))):
        raise ValueError("Неверные параметры выбора листов XLSX.")
    if not path.is_file():
        raise ValueError("Документ не найден.")
    with SecureWorkspace() as workspace:
        snapshot = workspace / f"source{path.suffix.lower()}"
        size, magic, digest = _snapshot_source(path, snapshot)
        sheets: list[dict] = []
        if magic.startswith(b"%PDF-"):
            mime_type, fragments, warnings, coverage = _pdf(snapshot)
        elif magic.startswith(b"PK\x03\x04") and path.suffix.lower() == ".docx":
            mime_type, fragments, warnings, coverage = _docx(snapshot)
        elif magic.startswith(b"PK\x03\x04") and path.suffix.lower() == ".xlsx":
            mime_type, fragments, warnings, coverage, sheets = _xlsx(snapshot, include_hidden_sheets, selected_sheets)
        else:
            raise ValueError("Поддерживаются только настоящие PDF, DOCX и XLSX.")
        fragments, text = _bounded(fragments)
    return {"type": "extraction", "fileName": path.name, "mimeType": mime_type, "sizeBytes": size,
            "sha256": digest, "extractedText": text, "fragments": fragments, "warnings": list(dict.fromkeys(warnings)),
            "coverage": coverage, "sheets": sheets, "extractionEngineVersion": "sbk-local-extractor/2", "protocolVersion": 2}
