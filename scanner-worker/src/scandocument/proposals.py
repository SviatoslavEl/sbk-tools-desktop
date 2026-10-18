"""Customer-only commercial proposals. This renderer never receives record payloads."""

from __future__ import annotations

import hashlib
import json
import re
import signal
import threading
import uuid
from datetime import date
from decimal import Decimal, ROUND_HALF_UP, localcontext
from functools import lru_cache
from io import BytesIO
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

from docx import Document
from docx.enum.table import WD_TABLE_ALIGNMENT, WD_CELL_VERTICAL_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml import parse_xml
from docx.oxml.ns import qn
from docx.opc.constants import RELATIONSHIP_TYPE as RT
from docx.opc.packuri import PackURI
from docx.opc.part import Part
from docx.shared import Mm, Pt, RGBColor
from PIL import Image, ImageOps

from scandocument.resources import find_soffice, resource_path
from scandocument.errors import CancelledError

MAX_MINOR = 9007199254740991
MAX_PUBLIC_BYTES = 8 * 1024 * 1024
RATES = (0, 5, 7, 10, 11, 20, 22)
PROPOSAL_FONT = "SBK Proposal Sans"
# Separate from the older scanner/OCR fonts. The pinned OFL derivatives change
# only naming metadata and are embedded, avoiding host/internal-Office families.
PROPOSAL_FONT_FILES = (
    ("Regular", "embedRegular", "9f85711ba35ccf60cc66c9995c067683d69e2d85c81d999cbf0df17ad786a6ed"),
    ("Bold", "embedBold", "0c6ba818e63ba15471847dd402e27c9b5630cff62b6f05eab581bb4f116a900d"),
    ("Italic", "embedItalic", "d386cbc1fef5e5c6621fa96625b615c838f9865bc385f94397c6922480e32364"),
    ("BoldItalic", "embedBoldItalic", "101b87e65938570b3bc2d7a703d5d40ff3d1d1d04619c5530c7847a6c53e92b7"),
)


@lru_cache(maxsize=4)
def _proposal_fonts(directory: Path):
    from reportlab.pdfbase.ttfonts import TTFont

    result = []
    for variant, tag, digest in PROPOSAL_FONT_FILES:
        path = directory / f"SBKProposalSans-{variant}.ttf"
        if not path.is_file():
            raise ValueError("Встроенные шрифты КП недоступны. Переустановите приложение; системная подстановка отключена")
        data = path.read_bytes()
        if len(data) > 2 * 1024 * 1024 or hashlib.sha256(data).hexdigest() != digest:
            raise ValueError("Встроенный шрифт КП изменился. Экспорт остановлен; исходный текст не изменён")
        font = TTFont(f"proposal-{variant}", BytesIO(data))
        coverage = frozenset(code for code, glyph in font.face.charToGlyph.items() if glyph)
        result.append((variant, tag, data, coverage))
    return tuple(result)


def _document_strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for item in value.values():
            yield from _document_strings(item)
    elif isinstance(value, list):
        for item in value:
            yield from _document_strings(item)


def _font_slots(properties):
    fonts = properties.find(qn("w:rFonts"))
    if fonts is None:
        fonts = _xml("w:rFonts")
        properties.insert(0, fonts)
    # Theme slots can otherwise override the family, notably in tables and
    # footer fields. Keep all source characters; never replace Unicode dashes.
    for name in list(fonts.attrib):
        del fonts.attrib[name]
    for slot in ("ascii", "hAnsi", "eastAsia", "cs"):
        fonts.set(qn(f"w:{slot}"), PROPOSAL_FONT)


def _embed_proposal_fonts(doc, document):
    fonts = _proposal_fonts(resource_path("proposals", "fonts").resolve())
    required = {ord(char) for text in _document_strings(document) for char in text if char not in "\n\r\t"}
    required.update(map(ord, "Коммерческое предложение Страница № ₽ · • ЧЕРНОВИК ДЛЯ ПРОВЕРКИ Нужно проверить раздел пункт"))
    missing = sorted(set.union(*(required - coverage for _, _, _, coverage in fonts)))
    if missing:
        codes = ", ".join(f"U+{code:04X}" for code in missing[:12])
        raise ValueError(f"Встроенный шрифт КП не содержит символы {codes}. Текст не изменён; файл не создан")
    table = doc.part.rels.part_with_reltype(RT.FONT_TABLE)
    root = parse_xml(table.blob)
    for previous in list(root):
        if previous.get(qn("w:name")) == PROPOSAL_FONT:
            root.remove(previous)
    family = _xml("w:font", **{"w:name": PROPOSAL_FONT})
    root.append(family)
    for variant, tag, data, _coverage in fonts:
        # ECMA-376 font obfuscation, not encryption. The reversible GUID key
        # and complete unmodified font travel with this one document.
        font_key = uuid.UUID(bytes=hashlib.sha256(data).digest()[:16])
        key = font_key.bytes[::-1]
        obfuscated = bytearray(data)
        for index in range(min(32, len(obfuscated))):
            obfuscated[index] ^= key[index % 16]
        part = Part(PackURI(f"/word/fonts/proposal-{variant}.odttf"), "application/vnd.openxmlformats-officedocument.obfuscatedFont", bytes(obfuscated), doc.part.package)
        relation = table.relate_to(part, RT.FONT)
        family.append(_xml(f"w:{tag}", **{"r:id": relation, "w:fontKey": "{" + str(font_key).upper() + "}", "w:subsetted": "0"}))
    from lxml import etree

    table._blob = etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)
    settings = doc.settings.element
    for tag, value in (("embedTrueTypeFonts", "1"), ("saveSubsetFonts", "0")):
        element = settings.find(qn(f"w:{tag}"))
        if element is None:
            element = _xml(f"w:{tag}")
            settings.append(element)
        element.set(qn("w:val"), value)
    for style in doc.styles:
        _font_slots(style.element.get_or_add_rPr())
    for fonts_element in doc.styles.element.iter(qn("w:rFonts")):
        _font_slots(fonts_element.getparent())
    defaults = doc.styles.element.find(qn("w:docDefaults"))
    if defaults is not None:
        properties = defaults.find(f"{qn('w:rPrDefault')}/{qn('w:rPr')}")
        if properties is not None:
            _font_slots(properties)
    for part in (doc.part, *(section.footer.part for section in doc.sections)):
        for run in part.element.iter(qn("w:r")):
            _font_slots(run.get_or_add_rPr())


def _object(value, required: str, optional: str = "") -> dict:
    needed, allowed = set(required.split()), set((required + " " + optional).split())
    if not isinstance(value, dict) or not needed <= value.keys() or not value.keys() <= allowed:
        raise ValueError("Некорректная публичная схема КП; внутренние поля запрещены")
    return value


def _text(value, maximum=20000, required=False) -> str:
    if not isinstance(value, str) or len(value) > maximum or (required and not value.strip()):
        raise ValueError("КП содержит пустой или слишком длинный обязательный текст")
    if any(ord(char) < 32 and char not in "\n\r\t" for char in value):
        raise ValueError("Текст КП содержит недопустимые управляющие символы")
    return value


def _date(value: str, optional=False):
    if optional and value == "":
        return
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        raise ValueError("Некорректная дата КП")
    date.fromisoformat(value)


def _decimal(value: str, precision: int, maximum: str) -> Decimal:
    if not isinstance(value, str) or len(value) > 40 or not re.fullmatch(r"\d+(?:\.\d+)?", value):
        raise ValueError("Некорректное десятичное число в КП")
    if len(value.partition(".")[2]) > precision:
        raise ValueError("Превышена точность числа в КП")
    result = Decimal(value)
    if not 0 <= result <= Decimal(maximum):
        raise ValueError("Превышен диапазон числа в КП")
    return result


def _tax(value):
    _object(value, "kind", "rate")
    if value == {"kind": "none"}:
        return
    if value.get("kind") != "vat" or type(value.get("rate")) is not int or value["rate"] not in RATES:
        raise ValueError("Некорректная ставка НДС")


def _minor(value):
    if not isinstance(value, str) or not re.fullmatch(r"0|[1-9]\d{0,15}", value) or int(value) > MAX_MINOR:
        raise ValueError("Превышен диапазон денежной суммы КП")


def _asset(value):
    _object(value, "fileName sizeBytes sha256 mimeType")
    _text(value["fileName"], 255, True)
    if re.search(r'[\\/<>:"|?*\x00-\x1f]', value["fileName"]) or value["fileName"] in (".", ".."):
        raise ValueError("Некорректное имя приложения КП")
    _text(value["mimeType"], 100)
    if type(value["sizeBytes"]) is not int or not 0 <= value["sizeBytes"] <= 512 * 1024 * 1024:
        raise ValueError("Приложение КП превышает 512 МБ")
    if not isinstance(value["sha256"], str) or not re.fullmatch("[0-9a-f]{64}", value["sha256"]):
        raise ValueError("Некорректный хеш приложения КП")


def _public_size_budget(document):
    # Count compact JSON UTF-8 without serializing any whole text/node first.
    # Even JSONEncoder.iterencode allocates an entire escaped string chunk.
    size, ancestors = 0, set()

    def consume(count):
        nonlocal size
        size += count
        if size > MAX_PUBLIC_BYTES:
            raise ValueError("Слишком большой документ КП (более 8 МБ текста)")

    def string(value):
        if not isinstance(value, str):
            raise ValueError("Некорректный текст публичной схемы КП")
        consume(2)
        if len(value) > MAX_PUBLIC_BYTES - size:
            raise ValueError("Слишком большой документ КП (более 8 МБ текста)")
        for char in value:
            code = ord(char)
            if 0xD800 <= code <= 0xDFFF:
                raise ValueError("Некорректный Unicode в публичной схеме КП")
            consume(2 if char in '"\\\b\t\n\f\r' else 6 if code < 32 else 1 if code < 128 else 2 if code < 2048 else 3 if code < 65536 else 4)

    # Iterator frames avoid copying even an oversized adversarial list/dict.
    frames = [(iter((document,)), None, False)]
    while frames:
        iterator, container_id, is_dict = frames[-1]
        try:
            value = next(iterator)
        except StopIteration:
            frames.pop()
            if container_id is not None:
                ancestors.remove(container_id)
            continue
        if is_dict:
            key, value = value
            string(key)
            consume(1)
        if isinstance(value, (dict, list)):
            if id(value) in ancestors or len(frames) > 32:
                raise ValueError("Циклическая или слишком глубокая публичная схема КП")
            consume(2 + max(0, len(value) - 1))
            ancestors.add(id(value))
            frames.append((iter(value.items()) if isinstance(value, dict) else iter(value), id(value), isinstance(value, dict)))
        elif isinstance(value, str):
            string(value)
        elif value is None:
            consume(4)
        elif type(value) is bool:
            consume(4 if value else 5)
        elif type(value) is int:
            consume(len(str(value)))
        else:
            raise ValueError("Некорректное значение публичной схемы КП")


def _commercial_inline(value, references):
    if not isinstance(value, list) or len(value) > 2000:
        raise ValueError("Не более 2000 частей текста КП")
    for part in value:
        if not isinstance(part, dict):
            raise ValueError("Некорректная часть публичного текста КП")
        if part.get("kind") == "text":
            _object(part, "kind text")
            _commercial_text(part["text"])
        elif part.get("kind") == "local-ref":
            _object(part, "kind target")
            _text(part["target"], 16, True)
            references.append(part["target"])
        else:
            raise ValueError("Неподдерживаемая часть публичного текста КП")


def _commercial_text(value, required=False):
    _text(value, required=required)
    if any(127 <= ord(char) <= 159 for char in value):
        raise ValueError("Текст КП содержит недопустимые управляющие символы")


def _commercial(value):
    _object(value, "version mode sections unresolved")
    if type(value["version"]) is not int or value["version"] != 1 or value["mode"] not in ("review-draft", "final"):
        raise ValueError("Неподдерживаемая версия разделов КП")
    sections = value["sections"]
    if not isinstance(sections, list) or not 1 <= len(sections) <= 64:
        raise ValueError("В КП допустимо от 1 до 64 публичных разделов")
    anchors, section_anchors, references, total_blocks = set(), set(), [], 0
    for section_index, section in enumerate(sections, 1):
        _object(section, "anchor title blocks")
        anchor = f"s{section_index}"
        if section["anchor"] != anchor:
            raise ValueError("Нарушена последовательность разделов КП")
        anchors.add(anchor)
        section_anchors.add(anchor)
        _commercial_text(section["title"], required=True)
        blocks = section["blocks"]
        if not isinstance(blocks, list) or len(blocks) > 2000:
            raise ValueError("Некорректный состав раздела КП")
        total_blocks += len(blocks)
        if total_blocks > 2000:
            raise ValueError("Не более 2000 блоков в КП")
        for block_index, block in enumerate(blocks, 1):
            if not isinstance(block, dict) or block.get("anchor") != f"{anchor}b{block_index}":
                raise ValueError("Нарушена последовательность блоков КП")
            anchors.add(block["anchor"])
            if block.get("kind") == "paragraph":
                _object(block, "anchor kind style content")
                if block["style"] not in ("body", "lead", "subheading", "caveat"):
                    raise ValueError("Неподдерживаемый стиль абзаца КП")
                _commercial_inline(block["content"], references)
            elif block.get("kind") == "list":
                _object(block, "anchor kind style items")
                if block["style"] not in ("bullet", "ordered"):
                    raise ValueError("Неподдерживаемый стиль списка КП")
                if not isinstance(block["items"], list) or len(block["items"]) > 2000:
                    raise ValueError("В списке КП допустимо до 2000 пунктов")
                for item in block["items"]:
                    _commercial_inline(item, references)
            elif block.get("kind") == "table":
                _object(block, "anchor kind columns rows")
                columns = block["columns"]
                if not isinstance(columns, list) or not 1 <= len(columns) <= 8:
                    raise ValueError("В таблице КП допустимо от 1 до 8 столбцов")
                for column in columns:
                    _commercial_text(column, required=True)
                if not isinstance(block["rows"], list) or len(block["rows"]) > 2000:
                    raise ValueError("Не более 2000 строк таблицы КП")
                for row in block["rows"]:
                    if not isinstance(row, list) or len(row) != len(columns):
                        raise ValueError("Число ячеек не совпадает со столбцами КП")
                    for cell in row:
                        _commercial_inline(cell, references)
            else:
                raise ValueError("Неподдерживаемый публичный блок КП")
    if not total_blocks:
        raise ValueError("КП не содержит публичных блоков")
    if any(target not in anchors for target in references):
        raise ValueError("Локальная ссылка КП не имеет адресата")
    unresolved = value["unresolved"]
    if not isinstance(unresolved, list) or len(unresolved) > 2000:
        raise ValueError("Не более 2000 вопросов для проверки КП")
    if value["mode"] == "final" and unresolved:
        raise ValueError("Итоговый документ КП содержит нерешённые вопросы")
    for item in unresolved:
        _object(item, "section message")
        if not isinstance(item["section"], str) or item["section"] not in section_anchors:
            raise ValueError("Вопрос КП не имеет публичного раздела")
        _commercial_text(item["message"], required=True)
    _commercial_narrative_budget(value)


def validate_document(document: dict) -> dict:
    _public_size_budget(document)
    version = document.get("schemaVersion") if isinstance(document, dict) else None
    if type(version) is not int or version not in (1, 2):
        raise ValueError("Неподдерживаемая версия КП")
    body_field = "terms" if version == 1 else "commercial"
    _object(
        document,
        f"schemaVersion number revision documentDate title validUntil currency issuer recipient addressee contact lines totals {body_field} layout attachments",
        "signer",
    )
    if (
        document["currency"] != "RUB"
        or type(document["revision"]) is not int
        or not 1 <= document["revision"] <= 100000
    ):
        raise ValueError("Неподдерживаемая версия или валюта КП")
    for key in ("number", "title"):
        _text(document[key], 500, True)
    for key in ("documentDate", "validUntil"):
        _date(document[key])
    if document["validUntil"] < document["documentDate"]:
        raise ValueError("Срок действия не может быть раньше даты КП")
    for key in ("issuer", "recipient"):
        party = _object(document[key], "name shortName inn kpp ogrn address contact paymentDetails")
        for name, value in party.items():
            _text(value, 500 if name in ("name", "shortName") else 20000, name == "name")
    for key in ("addressee", "contact", "signer"):
        if key not in document:
            continue
        contact = _object(
            document[key], "fullName position phone email" + (" basis issuedAt expiresAt" if key == "signer" else "")
        )
        for value in contact.values():
            _text(value)
        if key == "signer":
            _date(contact["issuedAt"], True)
            _date(contact["expiresAt"], True)
    lines = document["lines"]
    if not isinstance(lines, list) or not 1 <= len(lines) <= 1000:
        raise ValueError("В КП допустимо от 1 до 1000 позиций")
    totals = {"netMinor": 0, "vatMinor": 0, "grossMinor": 0}
    groups = {}
    with localcontext() as context:
        context.prec = 64
        for line in lines:
            _object(
                line,
                "title description unit quantity unitPrice priceBasis discountPercent tax netMinor vatMinor grossMinor",
            )
            _text(line["title"], 500, True)
            _text(line["description"])
            _text(line["unit"], 50, True)
            quantity = _decimal(line["quantity"], 6, "1000000000")
            price = _decimal(line["unitPrice"], 4, "1000000000000")
            discount = _decimal(line["discountPercent"], 2, "100")
            if not quantity or line["priceBasis"] not in ("gross", "net"):
                raise ValueError("Количество должно быть положительным; укажите базу цены")
            _tax(line["tax"])
            base = int((quantity * price * (1 - discount / 100) * 100).quantize(Decimal(1), rounding=ROUND_HALF_UP))
            rate = line["tax"].get("rate", 0)
            vat = int(
                (Decimal(base) * rate / (100 if line["priceBasis"] == "net" else 100 + rate)).quantize(
                    Decimal(1), rounding=ROUND_HALF_UP
                )
            )
            expected = {
                "netMinor": base if line["priceBasis"] == "net" else base - vat,
                "vatMinor": vat,
                "grossMinor": base + vat if line["priceBasis"] == "net" else base,
            }
            key = json.dumps(line["tax"], sort_keys=True)
            group = groups.setdefault(key, {"tax": line["tax"], "netMinor": 0, "vatMinor": 0, "grossMinor": 0})
            for field, amount in expected.items():
                _minor(line[field])
                if int(line[field]) != amount:
                    raise ValueError("Сумма строки не совпадает с proposal-pricing/1")
                totals[field] += amount
                group[field] += amount
    public_totals = _object(document["totals"], "pricingVersion netMinor vatMinor grossMinor byTax")
    if public_totals["pricingVersion"] != "proposal-pricing/1":
        raise ValueError("Неподдерживаемая версия расчёта КП")
    for field, amount in totals.items():
        _minor(public_totals[field])
        if int(public_totals[field]) != amount:
            raise ValueError("Общий итог КП не совпадает с суммой строк")
    expected_groups = [
        {key: str(value) if key != "tax" else value for key, value in group.items()} for group in groups.values()
    ]
    if public_totals["byTax"] != expected_groups:
        raise ValueError("Разбивка НДС не совпадает с суммой строк")
    if version == 1:
        terms = _object(document["terms"], "delivery payment introduction conclusion")
        for value in terms.values():
            _text(value)
    else:
        _commercial(document["commercial"])
    layout = _object(document["layout"], "style accentColor show footer", "logo")
    if (
        layout["style"] not in ("standard", "compact")
        or not isinstance(layout["accentColor"], str)
        or not re.fullmatch("#[0-9a-fA-F]{6}", layout["accentColor"])
    ):
        raise ValueError("Некорректное оформление КП")
    show = _object(layout["show"], "address requisites contact signer")
    if any(type(value) is not bool for value in show.values()):
        raise ValueError("Некорректные настройки блоков КП")
    _text(layout["footer"])
    if "logo" in layout:
        _asset(layout["logo"])
        if (
            layout["logo"]["mimeType"] not in ("image/png", "image/jpeg")
            or layout["logo"]["sizeBytes"] > 5 * 1024 * 1024
        ):
            raise ValueError("Логотип должен быть PNG/JPEG до 5 МБ")
    if not isinstance(document["attachments"], list) or len(document["attachments"]) > 100:
        raise ValueError("Не более 100 приложений КП")
    for asset in document["attachments"]:
        _asset(asset)
    return document


def _money(minor: str) -> str:
    amount = int(minor)
    return f"{amount // 100:,}".replace(",", " ") + f",{amount % 100:02d}"


def _number(value: str, minimum_decimals=0) -> str:
    whole, _, fraction = value.partition(".")
    fraction = fraction.ljust(minimum_decimals, "0")
    return f"{int(whole):,}".replace(",", " ") + ("," + fraction if fraction else "")


def _tax_label(tax):
    return "Без НДС" if tax["kind"] == "none" else f"НДС {tax['rate']}%"


def _xml(tag, **attrs):
    element = OxmlElement(tag)
    for key, value in attrs.items():
        element.set(qn(key), str(value))
    return element


def _paragraph(document, text, *, bold=False, keep=False, style=None):
    paragraph = document.add_paragraph(style=style)
    paragraph.paragraph_format.keep_with_next = keep
    paragraph.add_run(text).bold = bold
    return paragraph


def _party_text(party, show):
    items = [party["name"]]
    if show["requisites"]:
        items.extend(
            f"{label} {party[key]}" for key, label in (("inn", "ИНН"), ("kpp", "КПП"), ("ogrn", "ОГРН")) if party[key]
        )
    if show["address"] and party["address"]:
        items.append(party["address"])
    if show["contact"] and party["contact"]:
        items.append(party["contact"])
    return " · ".join(items)


def _commercial_labels(commercial):
    labels = {}
    for section_index, section in enumerate(commercial["sections"], 1):
        labels[section["anchor"]] = f"раздел\u00a0{section_index}"
        for block_index, block in enumerate(section["blocks"], 1):
            labels[block["anchor"]] = f"пункт\u00a0{section_index}.{block_index}"
    return labels


def _bookmark(paragraph, anchor, bookmark_id):
    paragraph._p.append(_xml("w:bookmarkStart", **{"w:id": bookmark_id, "w:name": anchor}))
    # Word bookmarks cover the complete visible number and content, not a
    # stale source-contract number or a private clause identifier.
    return lambda: paragraph._p.append(_xml("w:bookmarkEnd", **{"w:id": bookmark_id}))


def _append_inlines(paragraph, content, labels):
    # Source spans retain their grammatical qualifier. Only the link's
    # generated label becomes numeric in that context; literal text is never
    # rewritten. A qualified comma/"и" group keeps that qualifier for each
    # following reference, but an unrelated sentence ends the group.
    gap = ""
    qualified_group = False
    for part in content:
        if part["kind"] == "text":
            paragraph.add_run(part["text"])
            gap += part["text"]
        else:
            explicit_qualifier = re.search(
                r"(?<!\w)(?:п\.\s*п\.|пп\.|п\.|пункт(?:а|у|ом|е|ы|ов|ам|ами|ах)?|раздел(?:а|у|ом|е|ы|ов|ам|ами|ах)?)\s*$",
                gap, re.IGNORECASE,
            )
            continued_group = qualified_group and re.fullmatch(r"[\s,;]*(?:(?:и|или)[\s,;]*)?", gap, re.IGNORECASE)
            qualified_group = bool(explicit_qualifier or continued_group)
            label = labels[part["target"]]
            if qualified_group:
                label = label.partition("\u00a0")[2] or label
            link = _xml("w:hyperlink", **{"w:anchor": part["target"], "w:history": "1"})
            run = _xml("w:r")
            properties = _xml("w:rPr")
            properties.append(_xml("w:color", **{"w:val": "245C48"}))
            properties.append(_xml("w:u", **{"w:val": "single"}))
            run.append(properties)
            text = _xml("w:t")
            text.text = label
            run.append(text)
            link.append(run)
            paragraph._p.append(link)
            gap = ""


def _list_numbering(doc, style):
    root = doc.part.numbering_part.element
    abstract_id = max((int(item.get(qn("w:abstractNumId"))) for item in root.findall(qn("w:abstractNum"))), default=-1) + 1
    num_id = max((int(item.get(qn("w:numId"))) for item in root.findall(qn("w:num"))), default=0) + 1
    abstract = _xml("w:abstractNum", **{"w:abstractNumId": abstract_id})
    abstract.append(_xml("w:multiLevelType", **{"w:val": "singleLevel"}))
    level = _xml("w:lvl", **{"w:ilvl": "0"})
    level.append(_xml("w:start", **{"w:val": "1"}))
    level.append(_xml("w:numFmt", **{"w:val": "bullet" if style == "bullet" else "decimal"}))
    level.append(_xml("w:lvlText", **{"w:val": "•" if style == "bullet" else "%1."}))
    level.append(_xml("w:lvlJc", **{"w:val": "left"}))
    properties = _xml("w:pPr")
    properties.append(_xml("w:ind", **{"w:left": "360", "w:hanging": "240"}))
    level.append(properties)
    run_properties = _xml("w:rPr")
    _font_slots(run_properties)
    level.append(run_properties)
    abstract.append(level)
    root.insert_element_before(abstract, "w:num", "w:numIdMacAtCleanup")
    num = _xml("w:num", **{"w:numId": num_id})
    num.append(_xml("w:abstractNumId", **{"w:val": abstract_id}))
    root.insert_element_before(num, "w:numIdMacAtCleanup")
    return num_id


def _commercial_table(doc, block, labels, accent):
    table = doc.add_table(rows=1, cols=len(block["columns"]))
    table.alignment, table.autofit = WD_TABLE_ALIGNMENT.CENTER, False
    width = 174 / len(block["columns"])
    for column in table.columns:
        column.width = Mm(width)
    properties = table._tbl.tblPr
    borders = _xml("w:tblBorders")
    for side in ("top", "left", "bottom", "right", "insideH", "insideV"):
        borders.append(_xml(f"w:{side}", **{"w:val": "single", "w:sz": "4", "w:color": "D9D9D9"}))
    properties.insert_element_before(borders, "w:shd", "w:tblLayout", "w:tblCellMar", "w:tblLook")
    margins = _xml("w:tblCellMar")
    for side in ("top", "left", "bottom", "right"):
        margins.append(_xml(f"w:{side}", **{"w:w": "90", "w:type": "dxa"}))
    properties.insert_element_before(margins, "w:tblLook")
    table.rows[0]._tr.get_or_add_trPr().append(_xml("w:tblHeader"))
    for cell, title in zip(table.rows[0].cells, block["columns"], strict=True):
        cell.width, cell.vertical_alignment = Mm(width), WD_CELL_VERTICAL_ALIGNMENT.CENTER
        cell.text = title
        cell._tc.get_or_add_tcPr().append(_xml("w:shd", **{"w:fill": accent}))
        for run in cell.paragraphs[0].runs:
            run.bold, run.font.color.rgb = True, RGBColor(255, 255, 255)
    for row_index, content in enumerate(block["rows"]):
        row = table.add_row()
        # Keep short rows intact, but let long legitimate deliverables flow
        # across pages instead of forcing a fixed-height or unbreakable row.
        if sum(len(part.get("text", labels.get(part.get("target"), ""))) for cell in content for part in cell) < 800:
            row._tr.get_or_add_trPr().append(_xml("w:cantSplit"))
        for cell, inlines in zip(row.cells, content, strict=True):
            cell.width, cell.vertical_alignment = Mm(width), WD_CELL_VERTICAL_ALIGNMENT.CENTER
            paragraph = cell.paragraphs[0]
            paragraph.paragraph_format.space_after = Pt(3)
            paragraph.paragraph_format.line_spacing = 1.08
            _append_inlines(paragraph, inlines, labels)
            if row_index % 2:
                cell._tc.get_or_add_tcPr().append(_xml("w:shd", **{"w:fill": "F3F5F4"}))


def _narrative_commercial_table(block, labels):
    # At three or more equal columns a sustained prose cell becomes a narrow
    # wall of text. Keep compact comparison matrices as tables; one long cell
    # switches the WHOLE record block so its column relationships stay clear.
    return len(block["columns"]) >= 3 and any(
        sum(len(part["text"] if part["kind"] == "text" else labels[part["target"]]) for part in cell) > 320
        for row in block["rows"] for cell in row
    )


def _commercial_narrative_budget(commercial):
    # Repeating long column labels for every full-width record can amplify a
    # small valid wire document. Bound the TOTAL expanded UTF-8 prose across
    # all adaptive blocks before Document()/OOXML allocation, never truncate.
    # Full ordinal reference labels are a conservative upper bound: an
    # explicitly qualified numeric-only link is shorter, never longer.
    labels = _commercial_labels(commercial)
    total = 0

    def consume(size):
        nonlocal total
        total += size
        if total > MAX_PUBLIC_BYTES:
            raise ValueError("Развёрнутый текст таблиц КП превышает 8 МБ. Документ не усечён")

    for section in commercial["sections"]:
        for block in section["blocks"]:
            if block["kind"] != "table" or not _narrative_commercial_table(block, labels):
                continue
            consume(sum(len(title.encode("utf-8")) + 2 for title in block["columns"]) * len(block["rows"]))
            for row in block["rows"]:
                for cell in row:
                    for part in cell:
                        consume(len((part["text"] if part["kind"] == "text" else labels[part["target"]]).encode("utf-8")))


def _commercial_narrative_records(doc, block, labels):
    for row_index, row in enumerate(block["rows"]):
        for column_index, (title, content) in enumerate(zip(block["columns"], row, strict=True)):
            paragraph = doc.add_paragraph()
            paragraph.paragraph_format.space_before = Pt(8 if row_index and column_index == 0 else 0)
            paragraph.paragraph_format.space_after = Pt(5)
            # Do not turn a whole long record into a heading/keep chain: prose
            # must flow across page boundaries rather than leave half a page.
            paragraph.paragraph_format.keep_with_next = False
            paragraph.paragraph_format.keep_together = False
            paragraph.add_run(title + ": ").bold = True
            _append_inlines(paragraph, content, labels)


def _render_commercial(doc, commercial, accent):
    labels = _commercial_labels(commercial)
    bookmark_ids = {anchor: index for index, anchor in enumerate(labels, 1)}
    for section_index, section in enumerate(commercial["sections"], 1):
        heading = doc.add_paragraph(style="Heading 1")
        end = _bookmark(heading, section["anchor"], bookmark_ids[section["anchor"]])
        heading.add_run(f"{section_index}. {section['title']}")
        end()
        for question in commercial["unresolved"]:
            if question["section"] == section["anchor"]:
                paragraph = _paragraph(doc, "Нужно проверить: " + question["message"], bold=True)
                paragraph.paragraph_format.keep_with_next = True
        for block_index, block in enumerate(section["blocks"], 1):
            ordinal = f"{section_index}.{block_index}"
            paragraph = doc.add_paragraph(style="Heading 2" if block.get("style") == "subheading" and block["kind"] == "paragraph" else None)
            end = _bookmark(paragraph, block["anchor"], bookmark_ids[block["anchor"]])
            prefix = paragraph.add_run(ordinal + ". ")
            prefix.bold = block["kind"] != "paragraph" or block.get("style") in ("lead", "subheading")
            if block["kind"] == "paragraph":
                _append_inlines(paragraph, block["content"], labels)
                if block["style"] == "caveat":
                    for run in paragraph.runs:
                        run.italic = True
                elif block["style"] == "lead":
                    for run in paragraph.runs:
                        run.bold = True
                end()
            else:
                end()
                paragraph.paragraph_format.keep_with_next = True
                if block["kind"] == "list":
                    num_id = _list_numbering(doc, block["style"])
                    for item in block["items"]:
                        item_paragraph = doc.add_paragraph(style="List Paragraph")
                        numbering = _xml("w:numPr")
                        numbering.append(_xml("w:ilvl", **{"w:val": "0"}))
                        numbering.append(_xml("w:numId", **{"w:val": num_id}))
                        item_paragraph._p.get_or_add_pPr().append(numbering)
                        _append_inlines(item_paragraph, item, labels)
                elif _narrative_commercial_table(block, labels):
                    _commercial_narrative_records(doc, block, labels)
                else:
                    _commercial_table(doc, block, labels, accent)


def render_docx(document: dict, output: Path, assets: dict[str, Path]) -> None:
    validate_document(document)
    doc = Document()
    compact = document["layout"]["style"] == "compact"
    section = doc.sections[0]
    section.page_width, section.page_height = Mm(210), Mm(297)
    section.top_margin = section.bottom_margin = Mm(18 if compact else 20)
    section.left_margin = section.right_margin = Mm(18)
    section.header_distance = section.footer_distance = Mm(9)
    normal = doc.styles["Normal"]
    normal.font.name, normal.font.size = PROPOSAL_FONT, Pt(11)
    normal.paragraph_format.space_after = Pt(5 if compact else 7)
    normal.paragraph_format.line_spacing = 1.08
    normal.paragraph_format.widow_control = True
    for name, size in (("Title", 20), ("Heading 1", 13), ("Heading 2", 11)):
        style = doc.styles[name]
        style.font.name, style.font.size = PROPOSAL_FONT, Pt(size)
        style.font.color.rgb = RGBColor(0, 0, 0) if document["schemaVersion"] == 2 else RGBColor.from_string(document["layout"]["accentColor"][1:])
        style.paragraph_format.keep_with_next = True
        if name == "Title":
            style.font.color.rgb = RGBColor(0, 0, 0)
            for border in style.element.xpath("w:pPr/w:pBdr"):
                border.getparent().remove(border)
    props = doc.core_properties
    props.author = props.last_modified_by = ""
    props.title, props.subject = document["title"], "Коммерческое предложение"
    props.comments = props.keywords = props.category = props.identifier = props.language = ""
    props.revision = document["revision"]
    footer = section.footer.paragraphs[0]
    footer.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    footer.paragraph_format.space_after = Pt(0)
    review_draft = document["schemaVersion"] == 2 and document["commercial"]["mode"] == "review-draft"
    if review_draft:
        footer.add_run("ЧЕРНОВИК ДЛЯ ПРОВЕРКИ\n").bold = True
    if document["layout"]["footer"]:
        footer.add_run(document["layout"]["footer"] + "\n")
    footer.add_run("Страница ")
    footer._p.append(_xml("w:fldSimple", **{"w:instr": "PAGE"}))
    for run in footer.runs:
        run.font.size = Pt(9)
    logo = document["layout"].get("logo")
    if logo:
        source = assets[logo["sha256"]]
        with Image.open(source) as original:
            if (
                original.format not in ("PNG", "JPEG")
                or original.width * original.height > 16000000
                or max(original.size) > 8192
                or min(original.size) < 1
            ):
                raise ValueError("Некорректные размеры или формат логотипа")
            original.load()
            clean = ImageOps.exif_transpose(original).convert("RGBA")
            clean.info.clear()
            clean.thumbnail((1600, 800))
            clean_path = output.parent / "logo-clean.png"
            clean.save(clean_path, format="PNG")
        logo_width = min(40, 20 * clean.width / clean.height)
        doc.add_picture(str(clean_path), width=Mm(logo_width))
    show = document["layout"]["show"]
    _paragraph(doc, _party_text(document["issuer"], show), bold=True, keep=True)
    if review_draft:
        _paragraph(doc, "ЧЕРНОВИК ДЛЯ ПРОВЕРКИ", bold=True, keep=True)
    _paragraph(doc, "Коммерческое предложение", style="Title")
    _paragraph(
        doc, f"№ {document['number']} от {document['documentDate']} · Редакция {document['revision']}", keep=True
    )
    _paragraph(doc, document["title"], bold=True, keep=True)
    _paragraph(doc, "Заказчик: " + _party_text(document["recipient"], show))
    addressee = document["addressee"]
    if any(addressee.values()):
        _paragraph(doc, "Адресат: " + ", ".join(value for value in addressee.values() if value))
    if document["schemaVersion"] == 1 and document["terms"]["introduction"]:
        _paragraph(doc, document["terms"]["introduction"])
    table = doc.add_table(rows=1, cols=5)
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    table.autofit = False
    widths = [12, 69, 21, 35, 37]
    for column, width in zip(table.columns, widths, strict=True):
        column.width = Mm(width)
    table._tbl.tblPr.append(_xml("w:tblLayout", **{"w:type": "fixed"}))
    margins = _xml("w:tblCellMar")
    for side in ("top", "left", "bottom", "right"):
        margins.append(_xml(f"w:{side}", **{"w:w": "75", "w:type": "dxa"}))
    table._tbl.tblPr.append(margins)
    table.rows[0]._tr.get_or_add_trPr().append(_xml("w:tblHeader"))
    for cell, title in zip(table.rows[0].cells, ["№", "Наименование", "Кол-во", "Цена, ₽", "Сумма, ₽"], strict=True):
        cell.text = title
        cell._tc.get_or_add_tcPr().append(_xml("w:shd", **{"w:fill": document["layout"]["accentColor"][1:]}))
        for run in cell.paragraphs[0].runs:
            run.bold = True
            run.font.color.rgb = RGBColor(255, 255, 255)
    for index, line in enumerate(document["lines"], 1):
        row = table.add_row()
        tax_info = _tax_label(line["tax"]) + (
            ", цена без НДС" if line["priceBasis"] == "net" and line["tax"]["kind"] == "vat" else ""
        )
        if line["discountPercent"] != "0":
            tax_info += f" · Скидка {_number(line['discountPercent'])}%"
        details = "\n".join(value for value in (line["title"], line["description"], tax_info) if value)
        if len(details) < 800:
            row._tr.get_or_add_trPr().append(_xml("w:cantSplit"))
        values = [
            str(index),
            details,
            _number(line["quantity"]) + "\n" + line["unit"],
            _number(line["unitPrice"], 2),
            _money(line["grossMinor"]),
        ]
        for column_index, (cell, width, value) in enumerate(zip(row.cells, widths, values, strict=True)):
            cell.width = Mm(width)
            cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
            cell.text = value
            paragraph = cell.paragraphs[0]
            paragraph.paragraph_format.space_after = Pt(0)
            paragraph.paragraph_format.line_spacing = 1.05
            paragraph.alignment = WD_ALIGN_PARAGRAPH.LEFT if column_index == 1 else WD_ALIGN_PARAGRAPH.RIGHT
            for run in paragraph.runs:
                run.font.size = Pt(10 if compact else 10.5)
            if index % 2 == 0:
                cell._tc.get_or_add_tcPr().append(_xml("w:shd", **{"w:fill": "F3F5F4"}))
    _paragraph(doc, "", keep=True)
    _paragraph(doc, f"Стоимость без НДС: {_money(document['totals']['netMinor'])} ₽", keep=True)
    for group in document["totals"]["byTax"]:
        suffix = (
            f": {_money(group['vatMinor'])} ₽"
            if group["tax"]["kind"] == "vat"
            else f": {_money(group['grossMinor'])} ₽"
        )
        _paragraph(doc, _tax_label(group["tax"]) + suffix, keep=True)
    _paragraph(doc, f"Итого к оплате: {_money(document['totals']['grossMinor'])} ₽", bold=True)
    if document["schemaVersion"] == 1:
        for label, key in (("Сроки работ и поставки", "delivery"), ("Условия оплаты", "payment")):
            if document["terms"][key]:
                _paragraph(doc, label, style="Heading 1")
                _paragraph(doc, document["terms"][key])
    else:
        _render_commercial(doc, document["commercial"], document["layout"]["accentColor"][1:])
    _paragraph(doc, "Предложение действительно до " + document["validUntil"])
    if document["schemaVersion"] == 1 and document["terms"]["conclusion"]:
        _paragraph(doc, document["terms"]["conclusion"])
    if show["requisites"] and document["issuer"]["paymentDetails"]:
        _paragraph(doc, "Банковские реквизиты", style="Heading 1")
        _paragraph(doc, document["issuer"]["paymentDetails"])
    if show["contact"] and any(document["contact"].values()):
        _paragraph(doc, "Контакт: " + ", ".join(value for value in document["contact"].values() if value))
    if show["signer"] and document.get("signer", {}).get("fullName"):
        signer = document["signer"]
        _paragraph(
            doc,
            ", ".join(value for value in (signer["position"], signer["fullName"]) if value),
            keep=bool(signer["basis"]),
        )
        if signer["basis"]:
            _paragraph(doc, "Основание полномочий: " + signer["basis"])
    if document["attachments"]:
        _paragraph(doc, "Приложения к предложению", style="Heading 1")
        for index, asset in enumerate(document["attachments"], 1):
            _paragraph(doc, f"{index}. {asset['fileName']}")
    _embed_proposal_fonts(doc, document)
    doc.save(output)


def _verified_assets(document, entries, workdir: Path) -> dict[str, Path]:
    references = document["attachments"] + ([document["layout"]["logo"]] if document["layout"].get("logo") else [])
    expected = {asset["sha256"]: asset for asset in references}
    if not isinstance(entries, list):
        raise ValueError("Некорректный список вложений")
    result = {}
    for entry in entries:
        _object(entry, "sha256 path")
        path = Path(entry["path"]).resolve(strict=True)
        if path.parent != (workdir / "assets").resolve() or not path.is_file() or entry["sha256"] not in expected:
            raise ValueError("Вложение не принадлежит текущей задаче КП")
        info = expected[entry["sha256"]]
        if path.stat().st_size != info["sizeBytes"] or _digest(path) != entry["sha256"]:
            raise ValueError("Вложение изменилось после проверки")
        result[entry["sha256"]] = path
    if result.keys() != expected.keys():
        raise ValueError("Не найдено одно из явно выбранных приложений")
    return result


def _digest(path: Path) -> str:
    with path.open("rb") as handle:
        digest = hashlib.sha256()
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
        return digest.hexdigest()


def _render(config: dict, stopped: threading.Event) -> dict:
    document = validate_document(config["document"])
    workdir = Path(config["workdir"]).resolve(strict=True)

    def cancelled():
        return stopped.is_set() or (workdir / "cancel.requested").exists()

    def check_cancelled():
        if cancelled():
            raise CancelledError("Экспорт КП отменён")

    check_cancelled()
    output_format = config["format"]
    if output_format not in ("docx", "pdf", "preview", "zip"):
        raise ValueError("Неподдерживаемый формат КП")
    assets = _verified_assets(document, config.get("assets", []), workdir)
    docx_path = workdir / "proposal.docx"
    render_docx(document, docx_path, assets)
    check_cancelled()
    output = docx_path
    page_count = None
    previews = []
    if output_format != "docx":
        soffice = find_soffice()
        if not soffice:
            raise ValueError("Встроенный офисный модуль недоступен. DOCX можно сохранить отдельно; PDF не создан")
        from scandocument.office_engine import convert_with_office
        from pypdf import PdfReader, PdfWriter

        pdf = workdir / "proposal.pdf"
        office_workdir = workdir / "office"
        office_workdir.mkdir(mode=0o700)
        convert_with_office(docx_path, pdf, soffice, office_workdir, cancelled)
        check_cancelled()
        # Strip automatic Office metadata and reconstruct pages without source paths or authors.
        reader, writer = PdfReader(pdf), PdfWriter()
        for page in reader.pages:
            writer.add_page(page)
        writer.add_metadata(
            {"/Title": document["title"], "/Subject": "Коммерческое предложение", "/Creator": "СБК Инструменты"}
        )
        clean = workdir / "proposal-clean.pdf"
        with clean.open("xb") as handle:
            writer.write(handle)
        clean.replace(pdf)
        page_count = len(reader.pages)
        output = pdf
        if output_format == "preview":
            import pypdfium2 as pdfium

            with pdfium.PdfDocument(pdf) as rendered:
                for index in range(len(rendered)):
                    check_cancelled()
                    image_path = workdir / f"page-{index + 1}.png"
                    page = rendered[index]
                    bitmap = page.render(scale=1.2)
                    image = bitmap.to_pil()
                    image.save(image_path)
                    image.close()
                    bitmap.close()
                    page.close()
                    previews.append(str(image_path))
        if output_format == "zip":
            output = workdir / "proposal.zip"
            manifest = {"schemaVersion": 1, "number": document["number"], "revision": document["revision"], "files": []}
            with ZipFile(output, "x", compression=ZIP_DEFLATED) as archive:
                archive.write(docx_path, "Коммерческое предложение.docx")
                archive.write(pdf, "Коммерческое предложение.pdf")
                for index, asset in enumerate(document["attachments"], 1):
                    check_cancelled()
                    member = f"Приложения/{index:03d}-{asset['fileName']}"
                    archive.write(assets[asset["sha256"]], member)
                    manifest["files"].append(
                        {"name": member, "sizeBytes": asset["sizeBytes"], "sha256": asset["sha256"]}
                    )
                archive.writestr("Перечень.json", json.dumps(manifest, ensure_ascii=False, indent=2))
    check_cancelled()
    return {
        "type": "complete",
        "outputPath": str(output),
        "outputBytes": output.stat().st_size,
        "sha256": _digest(output),
        "pageCount": page_count,
        "previewPages": previews,
    }


def render(config: dict) -> dict:
    stopped = threading.Event()
    previous = None
    if threading.current_thread() is threading.main_thread():
        previous = signal.signal(signal.SIGTERM, lambda *_args: stopped.set())
    try:
        return _render(config, stopped)
    finally:
        if previous is not None:
            signal.signal(signal.SIGTERM, previous)
