from __future__ import annotations

import copy
import hashlib
import json
import os
import re
import struct
from io import BytesIO
from pathlib import Path
from uuid import UUID
from zipfile import ZipFile

import pytest
from docx import Document
from PIL import Image

from scandocument.proposals import PROPOSAL_FONT_FILES, render, render_docx, validate_document


def unicode_document_fixture():
    document = document_fixture()
    document["title"] = "Акт сдачи\u2011приемки — проверка Unicode"
    document["lines"][0]["description"] = "Акт сдачи\u2011приемки, ₽ и №, латиница A4, буквы ЁЙ."
    document["terms"]["payment"] = (
        "Передача акта сдачи\u2011приемки — № 1; сумма 12 000,00 ₽. "
        "Тире – и −; кавычки «условия»; неразрывный\u00a0пробел."
    )
    document["layout"]["footer"] = "Форма сдачи\u2011приемки"
    return document


def _glyph_box(font, code):
    glyph = font.face.charToGlyph[code]
    start, end = font.face.glyphPos[glyph:glyph + 2]
    assert glyph > 0 and end > start
    return struct.unpack_from(">hhhhh", font.face.get_table("glyf"), start)


def document_fixture(count=1):
    party = {
        "name": "Тестовая компания",
        "shortName": "Тест",
        "inn": "",
        "kpp": "",
        "ogrn": "",
        "address": "Москва, тестовый адрес",
        "contact": "",
        "paymentDetails": "",
    }
    contact = {"fullName": "", "position": "", "phone": "", "email": ""}
    line = {
        "title": "Настройка информационной системы",
        "description": "Тестовый объём работ, обучение пользователей и передача документации.",
        "unit": "усл.",
        "quantity": "1",
        "unitPrice": "12000",
        "priceBasis": "gross",
        "discountPercent": "0",
        "tax": {"kind": "vat", "rate": 20},
        "netMinor": "1000000",
        "vatMinor": "200000",
        "grossMinor": "1200000",
    }
    totals = {"netMinor": str(1000000 * count), "vatMinor": str(200000 * count), "grossMinor": str(1200000 * count)}
    return {
        "schemaVersion": 1,
        "number": "КП-20300101-QA",
        "revision": 1,
        "documentDate": "2030-01-01",
        "title": "Внедрение и сопровождение информационной системы",
        "validUntil": "2030-01-31",
        "currency": "RUB",
        "issuer": {**party, "name": "Тестовый исполнитель"},
        "recipient": {**party, "name": "Тестовый заказчик"},
        "addressee": contact.copy(),
        "contact": contact.copy(),
        "lines": [copy.deepcopy(line) for _ in range(count)],
        "totals": {"pricingVersion": "proposal-pricing/1", **totals, "byTax": [{"tax": line["tax"], **totals}]},
        "terms": {
            "delivery": "В течение 30 календарных дней с момента согласования задания.",
            "payment": "Оплата после приёмки результата.",
            "introduction": "Предлагаем выполнить следующие работы.",
            "conclusion": "Готовы ответить на вопросы по составу работ.",
        },
        "layout": {
            "style": "standard",
            "accentColor": "#245C48",
            "show": {"address": True, "requisites": True, "contact": True, "signer": True},
            "footer": "Тестовый документ — не коммерческое обязательство",
        },
        "attachments": [],
    }


def commercial_document_fixture(mode="final"):
    document = document_fixture()
    document["schemaVersion"] = 2
    del document["terms"]
    document["commercial"] = {
        "version": 1, "mode": mode,
        "sections": [
            {"anchor": "s1", "title": "Состав работ", "blocks": [
                {"anchor": "s1b1", "kind": "paragraph", "style": "lead", "content": [
                    {"kind": "text", "text": "Выполним обследование и передадим акт сдачи\u2011приемки. См. "},
                    {"kind": "local-ref", "target": "s2"}, {"kind": "text", "text": " и "},
                    {"kind": "local-ref", "target": "s1b3"}, {"kind": "text", "text": "."}]},
                {"anchor": "s1b2", "kind": "list", "style": "ordered", "items": [
                    [{"kind": "text", "text": "Согласовать исходные данные"}],
                    [{"kind": "text", "text": "Передать отчёт и документы"}]]},
                {"anchor": "s1b3", "kind": "table", "columns": ["Результат", "Передаваемые материалы"], "rows": [
                    [[{"kind": "text", "text": "Обследование"}], [{"kind": "text", "text": "Отчёт и перечень замечаний"}]],
                    [[{"kind": "text", "text": "Передача результата"}], [{"kind": "local-ref", "target": "s2b1"}]]]},
            ]},
            {"anchor": "s2", "title": "Сроки и оплата", "blocks": [
                {"anchor": "s2b1", "kind": "paragraph", "style": "body", "content": [
                    {"kind": "text", "text": "Срок исполнения 30 календарных дней. Оплата после приёмки результата."}]},
                {"anchor": "s2b2", "kind": "list", "style": "bullet", "items": [
                    [{"kind": "text", "text": "Передача в электронном виде"}]]},
                {"anchor": "s2b3", "kind": "paragraph", "style": "caveat", "content": [
                    {"kind": "text", "text": "Изменения состава работ согласуются письменно."}]},
            ]},
        ],
        "unresolved": [{"section": "s2", "message": "Уточнить основание начала срока"}] if mode == "review-draft" else [],
    }
    return document


def test_custom_template_layout_controls_export(tmp_path):
    document = commercial_document_fixture()
    document["layout"]["design"] = {"id": "custom", "letter": "Вступление шаблона", "mode": "final", "options": {
        "base": "starter-company-sbk", "paper": "landscape", "titleAlign": "center",
        "pricing": "gray", "pagination": "appendices", "heading": "Предложение услуг", "fontSize": 13,
        "brand": False, "cover": False, "footerArt": False, "pageNumbers": False,
    }}
    document["layout"]["footer"] = "Типовой колонтитул"
    output = tmp_path / "custom.docx"
    render_docx(document, output, {})
    doc = Document(output)
    assert doc.sections[0].page_width.mm > doc.sections[0].page_height.mm
    assert doc.styles["Normal"].font.size.pt == 13
    assert [heading.text for heading in doc.paragraphs if heading.style.name == "Title"] == ["Предложение услуг"]
    assert any(paragraph.text == "Вступление шаблона" for paragraph in doc.paragraphs)
    assert "Типовой колонтитул" in doc.sections[0].footer.paragraphs[0].text
    assert not doc.sections[0].footer.paragraphs[0]._p.xpath("w:fldSimple")
    assert not doc.inline_shapes

    options = document["layout"]["design"]["options"]
    options["base"] = "../untrusted"
    with pytest.raises(ValueError, match="параметры пользовательского шаблона"):
        validate_document(document)


def test_public_v2_has_real_sections_lists_tables_bookmarks_without_legacy_terms(tmp_path):
    from lxml import etree
    document = commercial_document_fixture()
    original = copy.deepcopy(document)
    output = tmp_path / "commercial.docx"
    render_docx(document, output, {})
    ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
    with ZipFile(output) as archive:
        xml = etree.fromstring(archive.read("word/document.xml"))
        text = "".join(xml.xpath("//w:t/text()", namespaces=ns)).replace("\u00a0", " ")
        assert text.count("Итого к оплате:") == 1
        assert text.count("1. Состав работ") == 1 and "2. Сроки и оплата" in text
        assert "1.1. Выполним обследование" in text and "раздел 2" in text and "пункт 1.3" in text
        assert "Предлагаем выполнить следующие работы." not in text
        assert "В течение 30 календарных дней с момента согласования задания." not in text
        assert "Сроки работ и поставки" not in text and "Готовы ответить на вопросы" not in text
        assert "ЧЕРНОВИК" not in text and "ЧЕРНОВИК" not in archive.read("word/footer1.xml").decode()
        anchors = xml.xpath("//w:bookmarkStart/@w:name", namespaces=ns)
        assert anchors == ["s1", "s1b1", "s1b2", "s1b3", "s2", "s2b1", "s2b2", "s2b3"]
        assert xml.xpath("//w:hyperlink/@w:anchor", namespaces=ns) == ["s2", "s1b3", "s2b1"]
        assert not xml.xpath("//w:hyperlink/@r:id", namespaces={**ns, "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships"})
        assert len(xml.xpath("//w:pPr/w:numPr", namespaces=ns)) == 3
        assert len(xml.xpath("//w:tbl", namespaces=ns)) == 2
        assert len(xml.xpath("//w:tbl/w:tr[1]/w:trPr/w:tblHeader", namespaces=ns)) == 2
        assert len(xml.xpath("//w:tbl[2]/w:tblPr/w:tblLayout", namespaces=ns)) == 1
        assert not xml.xpath("//w:tbl[2]//w:trHeight", namespaces=ns)
        assert len(xml.xpath("//w:tbl[2]//w:cantSplit", namespaces=ns)) == 2
        numbering = etree.fromstring(archive.read("word/numbering.xml"))
        assert numbering.xpath("//w:lvl/w:numFmt[@w:val='decimal']", namespaces=ns)
        assert numbering.xpath("//w:lvl/w:numFmt[@w:val='bullet']", namespaces=ns)
        new_levels = numbering.xpath("//w:abstractNum[last()-1]/w:lvl | //w:abstractNum[last()]/w:lvl", namespaces=ns)
        assert len(new_levels) == 2
        for level in new_levels:
            slots = level.find("w:rPr/w:rFonts", namespaces=ns)
            assert slots is not None
            assert {slots.get(f"{{{ns['w']}}}{slot}") for slot in ("ascii", "hAnsi", "eastAsia", "cs")} == {"SBK Proposal Sans"}
            assert list(level).index(level.find("w:pPr", namespaces=ns)) < list(level).index(level.find("w:rPr", namespaces=ns))
        tags = [etree.QName(child).localname for child in numbering]
        assert max(i for i, tag in enumerate(tags) if tag == "abstractNum") < min(i for i, tag in enumerate(tags) if tag == "num")
        paragraphs = Document(output).paragraphs
        assert [p.text for p in paragraphs if p.style.name == "Heading 1"] == ["1. Состав работ", "2. Сроки и оплата"]
        assert str(Document(output).styles["Heading 1"].font.color.rgb) == "000000"
    assert document == original


def test_public_v2_review_draft_marks_body_footer_and_question_at_own_section(tmp_path):
    document = commercial_document_fixture("review-draft")
    output = tmp_path / "review.docx"
    render_docx(document, output, {})
    doc = Document(output)
    body = "\n".join(p.text for p in doc.paragraphs)
    assert body.count("ЧЕРНОВИК ДЛЯ ПРОВЕРКИ") == 1
    assert "ЧЕРНОВИК ДЛЯ ПРОВЕРКИ" in doc.sections[0].footer.paragraphs[0].text
    assert body.index("2. Сроки и оплата") < body.index("Нужно проверить: Уточнить основание начала срока") < body.index("2.1.")


def test_public_v2_short_heading_keeps_only_the_following_body_without_prose_keep_chain(tmp_path):
    from lxml import etree
    document = commercial_document_fixture()
    section = document["commercial"]["sections"][0]
    heading = "Информационная безопасность и пентест"
    body = "Заказчик предоставляет материалы и разрешение для проверки. " * 30
    section["blocks"].extend([
        {"anchor": "s1b4", "kind": "paragraph", "style": "body", "content": [{"kind": "text", "text": heading}]},
        {"anchor": "s1b5", "kind": "paragraph", "style": "body", "content": [{"kind": "text", "text": body}]},
    ])
    original = copy.deepcopy(document)
    output = tmp_path / "heading-body.docx"
    render_docx(document, output, {})
    ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
    with ZipFile(output) as archive:
        xml = etree.fromstring(archive.read("word/document.xml"))
        title = xml.xpath("//w:bookmarkStart[@w:name='s1b4']/parent::w:p", namespaces=ns)[0]
        following = xml.xpath("//w:bookmarkStart[@w:name='s1b5']/parent::w:p", namespaces=ns)[0]
        assert title.xpath("./w:pPr/w:keepNext[not(@w:val) or @w:val='1']", namespaces=ns)
        assert title.xpath("./w:pPr/w:keepLines[not(@w:val) or @w:val='1']", namespaces=ns)
        assert not following.xpath("./w:pPr/w:keepNext[not(@w:val) or @w:val='1']", namespaces=ns)
        assert not following.xpath("./w:pPr/w:keepLines[not(@w:val) or @w:val='1']", namespaces=ns)
        text = "".join(xml.xpath("//w:t/text()", namespaces=ns))
        assert text.count(heading) == 1 and text.count(body) == 1
        assert xml.xpath("//w:hyperlink/@w:anchor", namespaces=ns) == ["s2", "s1b3", "s2b1"]
    assert document == original


def test_public_v2_heading_hint_is_bounded_and_does_not_chain_short_paragraphs(tmp_path):
    from lxml import etree
    document = commercial_document_fixture()
    candidates = [f"Доступы к учебной системе {index}" for index in range(16)]
    texts = candidates + ["Основной текст с полным описанием условий. " * 10,
                          "Слишком длинный заголовок " + "доступы " * 20,
                          "Название\nВторая строка", "Обычное законченное предложение.", "Завершающий короткий заголовок"]
    document["commercial"]["sections"].append({"anchor": "s3", "title": "Условия проверки", "blocks": [
        {"anchor": f"s3b{index + 1}", "kind": "paragraph", "style": "body", "content": [{"kind": "text", "text": text}]}
        for index, text in enumerate(texts)
    ]})
    original = copy.deepcopy(document)
    output = tmp_path / "bounded-headings.docx"
    render_docx(document, output, {})
    ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
    with ZipFile(output) as archive:
        xml = etree.fromstring(archive.read("word/document.xml"))
        for index, text in enumerate(texts, 1):
            paragraph = xml.xpath(f"//w:bookmarkStart[@w:name='s3b{index}']/parent::w:p", namespaces=ns)[0]
            keep = paragraph.xpath("./w:pPr/w:keepNext[not(@w:val) or @w:val='1']", namespaces=ns)
            assert bool(keep) == (index == len(candidates))
            assert text.replace("\n", "") in "".join(paragraph.xpath(".//w:t/text()", namespaces=ns))
            if "\n" in text:
                assert paragraph.xpath(".//w:br", namespaces=ns)
    assert document == original


def test_public_v2_short_heading_and_list_caption_do_not_keep_the_list_as_one_record(tmp_path):
    from lxml import etree
    document = commercial_document_fixture()
    document["commercial"]["sections"].append({"anchor": "s3", "title": "Материалы", "blocks": [
        {"anchor": "s3b1", "kind": "paragraph", "style": "body", "content": [
            {"kind": "text", "text": "Доступы к учебной системе"}]},
        {"anchor": "s3b2", "kind": "list", "style": "bullet", "items": [
            [{"kind": "text", "text": f"Полный пункт предоставляемых материалов {index}."}]
            for index in range(20)
        ]},
        {"anchor": "s3b3", "kind": "paragraph", "style": "body", "content": [
            {"kind": "text", "text": "См. "}, {"kind": "local-ref", "target": "s2b1"}]},
    ]})
    original = copy.deepcopy(document)
    output = tmp_path / "heading-list.docx"
    render_docx(document, output, {})
    ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
    with ZipFile(output) as archive:
        xml = etree.fromstring(archive.read("word/document.xml"))
        for anchor in ("s3b1", "s3b2"):
            paragraph = xml.xpath(f"//w:bookmarkStart[@w:name='{anchor}']/parent::w:p", namespaces=ns)[0]
            assert paragraph.xpath("./w:pPr/w:keepNext[not(@w:val) or @w:val='1']", namespaces=ns)
        items = xml.xpath("//w:body/w:p[w:pPr/w:numPr]", namespaces=ns)
        assert len(items) == 23
        for paragraph in items:
            assert not paragraph.xpath("./w:pPr/w:keepNext[not(@w:val) or @w:val='1']", namespaces=ns)
            assert not paragraph.xpath("./w:pPr/w:keepLines[not(@w:val) or @w:val='1']", namespaces=ns)
        referenced = xml.xpath("//w:bookmarkStart[@w:name='s3b3']/parent::w:p", namespaces=ns)[0]
        assert not referenced.xpath("./w:pPr/w:keepNext[not(@w:val) or @w:val='1']", namespaces=ns)
        assert referenced.xpath("./w:hyperlink/@w:anchor", namespaces=ns) == ["s2b1"]
    assert document == original


def test_public_v2_structural_block_ordinals_have_bounded_captions_and_keep_their_bookmarks(tmp_path):
    from lxml import etree
    document = commercial_document_fixture()
    original = copy.deepcopy(document)
    output = tmp_path / "block-captions.docx"
    render_docx(document, output, {})
    ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
    with ZipFile(output) as archive:
        xml = etree.fromstring(archive.read("word/document.xml"))
        captions = {}
        for anchor in ("s1b2", "s1b3", "s2b2"):
            paragraphs = xml.xpath(f"//w:bookmarkStart[@w:name='{anchor}']/parent::w:p", namespaces=ns)
            assert len(paragraphs) == 1
            captions[anchor] = "".join(paragraphs[0].xpath(".//w:t/text()", namespaces=ns))
            assert paragraphs[0].xpath("./w:pPr/w:keepNext[not(@w:val) or @w:val='1']", namespaces=ns)
            assert paragraphs[0].xpath("./w:bookmarkEnd", namespaces=ns)
        assert captions["s1b2"] == "1.2. Перечень"
        assert captions["s2b2"] == "2.2. Перечень"
        assert captions["s1b3"] == "1.3. Таблица: Результат / Передаваемые материалы"
        assert xml.xpath("//w:tbl[2]/w:tr[1]/w:tc/w:p/w:r/w:t/text()", namespaces=ns) == ["Результат", "Передаваемые материалы"]
        assert xml.xpath("//w:hyperlink/@w:anchor", namespaces=ns) == ["s2", "s1b3", "s2b1"]
        assert len(xml.xpath("//w:pPr/w:numPr", namespaces=ns)) == 3
    assert document == original


def test_public_v2_caption_fallback_never_truncates_original_columns_or_cells(tmp_path):
    from lxml import etree
    document = commercial_document_fixture()
    block = document["commercial"]["sections"][0]["blocks"][2]
    labels = ["Длинное исходное название " * 9, "Описание", "Результат"]
    body = "Полное содержание ячейки. " * 20
    block["columns"] = labels
    block["rows"] = [[[{"kind": "text", "text": body}], [{"kind": "local-ref", "target": "s2b1"}], []]]
    original = copy.deepcopy(document)
    output = tmp_path / "caption-fallback.docx"
    render_docx(document, output, {})
    ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
    with ZipFile(output) as archive:
        xml = etree.fromstring(archive.read("word/document.xml"))
        caption = xml.xpath("//w:bookmarkStart[@w:name='s1b3']/parent::w:p", namespaces=ns)[0]
        assert "".join(caption.xpath(".//w:t/text()", namespaces=ns)) == "1.3. Таблица сведений"
        text = "".join(xml.xpath("//w:t/text()", namespaces=ns))
        assert text.count(labels[0]) == 1 and text.count(body) == 1
        records = xml.xpath("//w:body/w:p[w:r/w:t[starts-with(., 'Длинное исходное название ')]]", namespaces=ns)
        assert records and records[0].xpath("./w:pPr/w:keepNext/@w:val", namespaces=ns) == ["0"]
        assert xml.xpath("//w:hyperlink/@w:anchor", namespaces=ns) == ["s2", "s1b3", "s2b1"]
    assert document == original


@pytest.mark.parametrize("mutation", [
    lambda d: d.update(terms={"delivery": "private"}),
    lambda d: d["commercial"].update(sourceSnapshotKey="private"),
    lambda d: d["commercial"]["sections"][0].update(sourceId="private"),
    lambda d: d["commercial"]["sections"][0]["blocks"][0].update(rawQuote="private"),
    lambda d: d["commercial"]["sections"][0]["blocks"][0]["content"][1].update(url="https://example.org"),
    lambda d: d["commercial"]["sections"][0]["blocks"][0]["content"][1].update(target="source-clause"),
    lambda d: d["commercial"]["sections"][0].update(anchor="s01"),
    lambda d: d["commercial"]["sections"][0]["blocks"][0].update(anchor="s1b2"),
    lambda d: d["commercial"]["sections"][0]["blocks"][2]["rows"].append([]),
    lambda d: d["commercial"]["sections"][0]["blocks"][0].update(style="html"),
    lambda d: d["commercial"].update(unresolved=[{"section": "s1", "message": "Not final"}]),
    lambda d: d["commercial"].update(mode="review-draft", unresolved=[{"section": "s1b1", "message": "No section"}]),
    lambda d: d["commercial"].update(mode="review-draft", unresolved=[{"sectionTitle": "Состав работ", "message": "No alias"}]),
    lambda d: d["commercial"]["sections"][0].update(title="x" * 20001),
    lambda d: d["commercial"]["sections"][0].update(title="control\x7f"),
])
def test_public_v2_rejects_unknown_fields_broken_refs_and_unreviewed_final(tmp_path, mutation):
    document = commercial_document_fixture()
    mutation(document)
    with pytest.raises(ValueError):
        render_docx(document, tmp_path / "invalid-v2.docx", {})
    assert not (tmp_path / "invalid-v2.docx").exists()


def test_public_v2_limits_are_bounded_and_unicode_codepoint_based():
    document = commercial_document_fixture()
    document["commercial"]["sections"][0]["title"] = "я" * 20000
    validate_document(document)
    document["commercial"]["sections"][0]["blocks"][0]["content"] = [{"kind": "text", "text": "x" * 20000}] * 500
    with pytest.raises(ValueError, match="8 МБ"):
        validate_document(document)
    for count in (0, 65):
        document = commercial_document_fixture()
        document["commercial"]["sections"] = [{"anchor": f"s{i + 1}", "title": "Раздел", "blocks": []} for i in range(count)]
        with pytest.raises(ValueError):
            validate_document(document)
    document = commercial_document_fixture()
    for section in document["commercial"]["sections"]:
        section["blocks"] = []
    with pytest.raises(ValueError, match="не содержит"):
        validate_document(document)


def test_public_v2_container_limits_accept_boundary_not_next_item():
    for count in (2000, 2001):
        for kind in ("blocks", "inline", "items", "rows", "unresolved"):
            document = commercial_document_fixture("review-draft")
            section = document["commercial"]["sections"][0]
            if kind == "blocks":
                document["commercial"]["sections"] = [section]
                document["commercial"]["unresolved"] = []
                section["blocks"] = [{"anchor": f"s1b{i + 1}", "kind": "paragraph", "style": "body", "content": []} for i in range(count)]
            elif kind == "inline":
                section["blocks"][0]["content"] = [{"kind": "text", "text": ""}] * count
            elif kind == "items":
                section["blocks"][1]["items"] = [[]] * count
            elif kind == "rows":
                section["blocks"][2]["rows"] = [[[], []]] * count
            else:
                document["commercial"]["unresolved"] = [{"section": "s1", "message": "Уточнить"}] * count
            if count == 2000:
                validate_document(document)
            else:
                with pytest.raises(ValueError):
                    validate_document(document)
    for count in (64, 65):
        document = commercial_document_fixture()
        document["commercial"]["sections"] = [{"anchor": f"s{i + 1}", "title": "Раздел", "blocks": [{"anchor": f"s{i + 1}b1", "kind": "paragraph", "style": "body", "content": []}]} for i in range(count)]
        if count == 64:
            validate_document(document)
        else:
            with pytest.raises(ValueError):
                validate_document(document)
    for count in (8, 9):
        document = commercial_document_fixture()
        block = document["commercial"]["sections"][0]["blocks"][2]
        block.update(columns=["Столбец"] * count, rows=[])
        if count == 8:
            validate_document(document)
        else:
            with pytest.raises(ValueError):
                validate_document(document)


def test_public_size_preflight_counts_utf8_and_json_escapes_without_whole_serialization(monkeypatch):
    from scandocument.proposals import _public_size_budget
    data = {"кириллица": ["\"\\\n\t\x01", "abc", "😀"], "integer": 2, "bool": False, "null": None}
    expected = len(json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
    monkeypatch.setattr("scandocument.proposals.MAX_PUBLIC_BYTES", expected)
    _public_size_budget(data)
    monkeypatch.setattr("scandocument.proposals.MAX_PUBLIC_BYTES", expected - 1)
    with pytest.raises(ValueError, match="8 МБ"):
        _public_size_budget(data)
    cycle = []
    cycle.append(cycle)
    with pytest.raises(ValueError, match="Циклическая"):
        _public_size_budget(cycle)


def test_public_v2_long_table_rows_can_flow_and_plain_text_is_not_markup(tmp_path):
    from lxml import etree
    document = commercial_document_fixture()
    long_text = "Материалы обследования и передаваемые результаты. " * 100
    block = document["commercial"]["sections"][0]["blocks"][2]
    block["rows"] = [[[{"kind": "text", "text": "Длинный результат"}], [{"kind": "text", "text": long_text}]]]
    document["commercial"]["sections"][1]["blocks"][0]["content"] = [{"kind": "text", "text": '<script>alert("plain text")</script> & https://example.org'}]
    output = tmp_path / "long-row.docx"
    render_docx(document, output, {})
    ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
    with ZipFile(output) as archive:
        xml = etree.fromstring(archive.read("word/document.xml"))
        assert not xml.xpath("//w:tbl[2]//w:cantSplit | //w:tbl[2]//w:trHeight", namespaces=ns)
        assert long_text in "".join(xml.xpath("//w:t/text()", namespaces=ns))
        assert '<script>alert("plain text")</script> & https://example.org' in "".join(xml.xpath("//w:t/text()", namespaces=ns))
        assert "TargetMode=\"External\"" not in archive.read("word/_rels/document.xml.rels").decode()


def test_public_v2_narrative_records_use_full_width_and_preserve_every_cell_and_link(tmp_path):
    from lxml import etree
    document = commercial_document_fixture()
    block = document["commercial"]["sections"][0]["blocks"][2]
    long_text = "Полный состав действий, ограничений и передаваемых результатов. " * 10
    block["columns"] = ["Блок", "Что проверяем", "Состав действий", "Результат"]
    block["rows"] = [
        [[{"kind": "text", "text": "Первая услуга"}], [{"kind": "text", "text": long_text}],
         [{"kind": "text", "text": "Условие первой услуги. См. "}, {"kind": "local-ref", "target": "s2b1"}],
         [{"kind": "text", "text": "Первый точный результат"}]],
        [[{"kind": "text", "text": "Вторая услуга"}], [{"kind": "text", "text": "Краткий второй объект"}],
         [{"kind": "local-ref", "target": "s2"}, {"kind": "text", "text": " и самостоятельное условие"}], []],
    ]
    original = copy.deepcopy(document)
    output = tmp_path / "narrative-records.docx"
    render_docx(document, output, {})
    ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
    with ZipFile(output) as archive:
        xml = etree.fromstring(archive.read("word/document.xml"))
        assert len(xml.xpath("//w:tbl", namespaces=ns)) == 1  # only the independent price table
        text = "".join(xml.xpath("//w:t/text()", namespaces=ns)).replace("\u00a0", " ")
        expected = ["Блок: Первая услуга", "Что проверяем: " + long_text,
                    "Состав действий: Условие первой услуги. См. пункт 2.1", "Результат: Первый точный результат",
                    "Блок: Вторая услуга", "Что проверяем: Краткий второй объект",
                    "Состав действий: раздел 2 и самостоятельное условие", "Результат: "]
        position = text.index("1.3. ")
        for cell in expected:
            position = text.index(cell, position) + len(cell)
        assert long_text in text and text.count("Первый точный результат") == 1
        assert xml.xpath("//w:bookmarkStart[@w:name='s1b3']/@w:id", namespaces=ns)
        assert xml.xpath("//w:hyperlink/@w:anchor", namespaces=ns) == ["s2", "s1b3", "s2b1", "s2"]
        records = xml.xpath("//w:body/w:p[w:r/w:t[starts-with(., 'Блок: ') or starts-with(., 'Что проверяем: ') or starts-with(., 'Состав действий: ') or starts-with(., 'Результат: ')]]", namespaces=ns)
        assert len(records) == 8
        for index, paragraph in enumerate(records):
            assert len(paragraph.xpath("./w:pPr/w:keepNext[not(@w:val) or @w:val='1']", namespaces=ns)) == (1 if index in (0, 4) else 0)
            if index not in (0, 4):
                assert paragraph.xpath("./w:pPr/w:keepNext/@w:val", namespaces=ns) == ["0"]
            assert paragraph.xpath("./w:pPr/w:keepLines/@w:val", namespaces=ns) == ["0"]
            assert paragraph.xpath("./w:r[1]/w:rPr/w:b", namespaces=ns)
    assert document == original


@pytest.mark.parametrize("first,following,title,keep", [
    ([{"kind": "text", "text": "2.1.4"}], [{"kind": "text", "text": "Содержание блока"}], "Блок", True),
    ([{"kind": "text", "text": "Первая "}, {"kind": "text", "text": "услуга"}], [{"kind": "text", "text": "Действия"}], "Блок", True),
    ([{"kind": "text", "text": "Я" * 160}], [{"kind": "text", "text": "Действия"}], "Блок", True),
    ([{"kind": "text", "text": "Я" * 161}], [{"kind": "text", "text": "Действия"}], "Блок", False),
    ([{"kind": "text", "text": "Первая\nуслуга"}], [{"kind": "text", "text": "Действия"}], "Блок", False),
    ([{"kind": "text", "text": "Первая\rуслуга"}], [{"kind": "text", "text": "Действия"}], "Блок", False),
    ([{"kind": "text", "text": "Первая\tуслуга"}], [{"kind": "text", "text": "Действия"}], "Блок", False),
    ([], [{"kind": "text", "text": "Действия"}], "Блок", False),
    ([{"kind": "text", "text": "  "}], [{"kind": "text", "text": "Действия"}], "Блок", False),
    ([{"kind": "local-ref", "target": "s2b1"}], [{"kind": "text", "text": "Действия"}], "Блок", False),
    ([{"kind": "text", "text": "См. "}, {"kind": "local-ref", "target": "s2b1"}], [{"kind": "text", "text": "Действия"}], "Блок", False),
    ([{"kind": "text", "text": "Первая услуга"}], [], "Блок", False),
    ([{"kind": "text", "text": "Первая услуга"}], [{"kind": "text", "text": ""}], "Блок", False),
    ([{"kind": "text", "text": "Первая услуга"}], [{"kind": "text", "text": " \n\t"}], "Блок", False),
    ([{"kind": "text", "text": "Первая услуга"}], [{"kind": "local-ref", "target": "s2b1"}], "Блок", True),
    ([{"kind": "text", "text": "Первая услуга"}], [{"kind": "text", "text": "Действия"}], "Многострочный\nзаголовок", False),
    ([{"kind": "text", "text": "Первая услуга"}], [{"kind": "text", "text": "Действия"}], "З" * 161, False),
])
def test_narrative_record_only_short_text_first_cell_keeps_immediate_following_paragraph(first, following, title, keep):
    from lxml import etree
    from scandocument.proposals import _append_inlines, _commercial_narrative_records

    labels = {"s2b1": "пункт\u00a02.1"}
    block = {"columns": [title, "Предмет", "Действия", "Результат"], "rows": [[
        first, following,
        [{"kind": "text", "text": "Сохранить полный состав действий. " * 30}],
        [{"kind": "local-ref", "target": "s2b1"}],
    ]]}
    original = copy.deepcopy(block)
    doc = Document()
    _commercial_narrative_records(doc, block, labels)
    ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
    paragraphs = doc.element.xpath("./w:body/w:p")
    assert len(paragraphs) == 4
    for index, (paragraph, column, content) in enumerate(zip(paragraphs, block["columns"], block["rows"][0], strict=True)):
        assert doc.paragraphs[index].paragraph_format.keep_with_next is (index == 0 and keep)
        assert paragraph.xpath("./w:pPr/w:keepLines/@w:val") == ["0"]
        # Rebuilding the expected paragraph independently of pagination must
        # preserve every text run, reference and literal column label exactly.
        expected = Document().add_paragraph()
        expected.add_run(column + ": ").bold = True
        _append_inlines(expected, content, labels)
        assert [etree.tostring(child) for child in paragraph if child.tag != f"{{{ns['w']}}}pPr"] == [
            etree.tostring(child) for child in expected._p
        ]
    assert doc.element.xpath("./w:body/w:p//w:hyperlink/@w:anchor") == [
        part["target"] for cell in block["rows"][0] for part in cell if part["kind"] == "local-ref"
    ]
    assert block == original


@pytest.mark.parametrize("length,columns,expected_tables", [(320, 4, 2), (321, 4, 1), (321, 3, 1), (1000, 2, 2)])
def test_public_v2_narrative_threshold_leaves_compact_tables_unchanged(tmp_path, length, columns, expected_tables):
    from lxml import etree
    document = commercial_document_fixture()
    block = document["commercial"]["sections"][0]["blocks"][2]
    block["columns"] = [f"Столбец {index + 1}" for index in range(columns)]
    block["rows"] = [[[{"kind": "text", "text": "X" * length}]] + [[{"kind": "text", "text": f"Значение {index}"}] for index in range(columns - 1)]]
    original = copy.deepcopy(document)
    output = tmp_path / "threshold.docx"
    render_docx(document, output, {})
    with ZipFile(output) as archive:
        xml = etree.fromstring(archive.read("word/document.xml"))
        ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
        assert len(xml.xpath("//w:tbl", namespaces=ns)) == expected_tables
        assert "X" * length in "".join(xml.xpath("//w:t/text()", namespaces=ns))
        if expected_tables == 2:
            assert xml.xpath("//w:tbl[2]/w:tr[1]/w:trPr/w:tblHeader", namespaces=ns)
            assert len(xml.xpath("//w:tbl[2]/w:tr[1]/w:tc", namespaces=ns)) == columns
    assert document == original


def test_public_v2_rejects_narrative_label_amplification_before_document_allocation(tmp_path, monkeypatch):
    from scandocument.proposals import MAX_PUBLIC_BYTES
    document = commercial_document_fixture()
    block = document["commercial"]["sections"][0]["blocks"][2]
    block["columns"] = ["К" * 20_000, "О" * 20_000, "Р" * 20_000]
    block["rows"] = [[[], [], []] for _ in range(80)]
    block["rows"][0][0] = [{"kind": "text", "text": "Я" * 321}]
    assert len(json.dumps(document, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) < MAX_PUBLIC_BYTES
    original = copy.deepcopy(document)
    output = tmp_path / "must-not-exist.docx"

    def no_document():
        pytest.fail("Document/OOXML allocation preceded narrative budget rejection")

    monkeypatch.setattr("scandocument.proposals.Document", no_document)
    with pytest.raises(ValueError, match="Развёрнутый текст таблиц"):
        render_docx(document, output, {})
    assert not output.exists() and document == original


def test_public_v2_narrative_expanded_utf8_and_reference_budget_exact_boundary(monkeypatch):
    from scandocument.proposals import _commercial_labels
    document = commercial_document_fixture()
    block = document["commercial"]["sections"][0]["blocks"][2]
    block["columns"] = ["К" * 1000, "О" * 1000, "Р" * 1000]
    block["rows"] = [[[], [], []] for _ in range(10)]
    block["rows"][0][0] = [{"kind": "text", "text": "Я" * 321}]
    block["rows"][0][1] = [{"kind": "local-ref", "target": "s2b1"}]
    labels = _commercial_labels(document["commercial"])
    expected = sum(len((title + ": ").encode("utf-8")) for title in block["columns"]) * 10
    expected += len(("Я" * 321).encode("utf-8")) + len(labels["s2b1"].encode("utf-8"))
    assert len(json.dumps(document, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) < expected
    original = copy.deepcopy(document)
    monkeypatch.setattr("scandocument.proposals.MAX_PUBLIC_BYTES", expected)
    validate_document(document)
    monkeypatch.setattr("scandocument.proposals.MAX_PUBLIC_BYTES", expected - 1)
    with pytest.raises(ValueError, match="Развёрнутый текст таблиц"):
        validate_document(document)
    assert document == original


def test_public_v2_narrative_expansion_budget_is_shared_by_all_adaptive_blocks(monkeypatch):
    document = commercial_document_fixture()
    first = document["commercial"]["sections"][0]["blocks"][2]
    first["columns"] = ["К" * 1000, "О" * 1000, "Р" * 1000]
    first["rows"] = [[[{"kind": "text", "text": "Я" * 321}], [], []] for _ in range(10)]
    second = copy.deepcopy(first)
    second["anchor"] = "s1b4"
    document["commercial"]["sections"][0]["blocks"].append(second)
    each = sum(len((title + ": ").encode("utf-8")) for title in first["columns"]) * 10 + len(("Я" * 321).encode("utf-8")) * 10
    assert len(json.dumps(document, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) < each
    original = copy.deepcopy(document)
    monkeypatch.setattr("scandocument.proposals.MAX_PUBLIC_BYTES", each * 2)
    validate_document(document)
    monkeypatch.setattr("scandocument.proposals.MAX_PUBLIC_BYTES", each * 2 - 1)
    with pytest.raises(ValueError, match="Развёрнутый текст таблиц"):
        validate_document(document)
    assert document == original


def test_public_v2_local_refs_respect_literal_inflection_and_qualified_groups(tmp_path):
    from lxml import etree
    document = commercial_document_fixture()
    content = [
        {"kind": "text", "text": "Срок определён пунктом "}, {"kind": "local-ref", "target": "s2b1"},
        {"kind": "text", "text": ". См. п.п. "}, {"kind": "local-ref", "target": "s1b2"},
        {"kind": "text", "text": ", "}, {"kind": "local-ref", "target": "s1b3"},
        {"kind": "text", "text": " и "}, {"kind": "local-ref", "target": "s2b1"},
        {"kind": "text", "text": ". Условия находятся в разделе "}, {"kind": "local-ref", "target": "s2"},
        {"kind": "text", "text": ". Отдельная ссылка: "}, {"kind": "local-ref", "target": "s1b2"},
        {"kind": "text", "text": "; дополнительная: "}, {"kind": "local-ref", "target": "s2"},
    ]
    document["commercial"]["sections"][0]["blocks"][0]["content"] = content
    original = copy.deepcopy(document)
    output = tmp_path / "qualified-refs.docx"
    render_docx(document, output, {})
    with ZipFile(output) as archive:
        xml = etree.fromstring(archive.read("word/document.xml"))
        ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
        text = "".join(xml.xpath("//w:t/text()", namespaces=ns)).replace("\u00a0", " ")
        assert "Срок определён пунктом 2.1. См. п.п. 1.2, 1.3 и 2.1." in text
        assert "в разделе 2. Отдельная ссылка: пункт 1.2; дополнительная: раздел 2" in text
        assert "пунктом пункт" not in text and "п.п. пункт" not in text and "разделе раздел" not in text
        assert xml.xpath("//w:hyperlink/@w:anchor", namespaces=ns) == ["s2b1", "s1b2", "s1b3", "s2b1", "s2", "s1b2", "s2", "s2b1"]
    assert document == original


@pytest.mark.skipif(not os.environ.get("SCANDOCUMENT_SOFFICE"), reason="Bundled office runtime required")
def test_actual_v2_narrative_records_pdf_keeps_text_and_qualified_links(tmp_path):
    from pypdf import PdfReader
    document = commercial_document_fixture("review-draft")
    block = document["commercial"]["sections"][0]["blocks"][2]
    block["columns"] = ["Блок", "Предмет", "Действия", "Результат"]
    first_scope = "Сохранить условие доступа и полный состав конкретной услуги. " * 8
    block["rows"] = [
        [[{"kind": "text", "text": "Первая услуга"}], [{"kind": "text", "text": first_scope}],
         [{"kind": "text", "text": "Согласно пункту "}, {"kind": "local-ref", "target": "s2b1"}],
         [{"kind": "text", "text": "Первый точный итог"}]],
        [[{"kind": "text", "text": "Вторая услуга"}], [{"kind": "text", "text": "Второй точный предмет"}],
         [{"kind": "text", "text": "Вторая самостоятельная проверка"}],
         [{"kind": "text", "text": "Второй точный итог"}]],
    ]
    original = copy.deepcopy(document)
    result = render({"document": document, "workdir": str(tmp_path), "format": "preview", "assets": []})
    reader = PdfReader(result["outputPath"])
    text = re.sub(r"\s+", " ", "\n".join(page.extract_text() or "" for page in reader.pages))
    assert "Согласно пункту 2.1" in text and "пункту пункт" not in text
    for value in ["Первая услуга", "Первый точный итог", "Вторая услуга", "Второй точный предмет", "Вторая самостоятельная проверка", "Второй точный итог"]:
        assert text.count(value) == 1
    assert text.count("Сохранить условие доступа и полный состав конкретной услуги.") == 8
    assert len(result["previewPages"]) == len(reader.pages)
    assert document == original
    print(f"PROPOSAL_NARRATIVE_RECORDS_QA: {tmp_path}")


@pytest.mark.skipif(not os.environ.get("SCANDOCUMENT_SOFFICE"), reason="Bundled office runtime required")
@pytest.mark.parametrize("mode", ["final", "review-draft"])
def test_actual_v2_pdf_preserves_full_width_content_and_draft_gate(tmp_path, mode):
    from pypdf import PdfReader
    document = commercial_document_fixture(mode)
    table = document["commercial"]["sections"][0]["blocks"][2]
    table["rows"] = [[[{"kind": "text", "text": f"Результат {index + 1}"}], [{"kind": "text", "text": "Описание передаваемых документов и результатов обследования."}]] for index in range(24)]
    original = copy.deepcopy(document)
    result = render({"document": document, "workdir": str(tmp_path), "format": "preview", "assets": []})
    reader = PdfReader(result["outputPath"])
    pages = [page.extract_text() or "" for page in reader.pages]
    text = re.sub(r"\s+", " ", "\n".join(pages))
    assert len(pages) >= 2 and len(result["previewPages"]) == len(pages)
    assert text.count("Итого к оплате:") == 1 and text.count("12 000,00 ₽") == 1
    assert "акт сдачи\u2011приемки" in text and "раздел 2" in text and "пункт 1.3" in text
    assert "1.1. Выполним обследование" in text and "2.1. Срок исполнения 30" in text
    assert "Результат 24" in text and text.count("Передаваемые материалы") >= 2
    assert text.count("Описание передаваемых документов и результатов обследования.") == 24
    assert "исходного договора" not in text and "sourceSnapshot" not in text and "sha256:" not in text
    if mode == "review-draft":
        assert all("ЧЕРНОВИК ДЛЯ ПРОВЕРКИ" in page for page in pages)
        assert text.count("Нужно проверить: Уточнить основание начала срока") == 1
    else:
        assert "ЧЕРНОВИК" not in text and "Нужно проверить:" not in text
    families = set()
    internal_links = 0
    for page in reader.pages:
        for reference in page["/Resources"]["/Font"].get_object().values():
            font = reference.get_object()
            name = str(font["/BaseFont"]).split("+", 1)[-1]
            families.add(name)
            assert name.startswith("SBKProposalSans-") and "/FontFile2" in font["/FontDescriptor"].get_object()
        for reference in page.get("/Annots", []):
            annotation = reference.get_object()
            if annotation.get("/Subtype") == "/Link":
                assert "/URI" not in annotation.get("/A", {})
                internal_links += 1
    assert internal_links >= 2 and "SBKProposalSans-Italic" in families
    assert document == original
    print(f"PROPOSAL_V2_{mode}_QA: {tmp_path}")


@pytest.mark.parametrize("count", [1, 20, 1000])
def test_docx_layout_structure_and_prices(tmp_path, count):
    document = document_fixture(count)
    output = tmp_path / "proposal.docx"
    render_docx(document, output, {})
    doc = Document(output)
    assert len(doc.tables[0].rows) == count + 1
    assert abs(doc.sections[0].page_width.mm - 210) < 0.1
    assert not doc.styles["Title"].element.xpath("w:pPr/w:pBdr")
    assert str(doc.styles["Title"].font.color.rgb) == "000000"
    with ZipFile(output) as archive:
        xml = archive.read("word/document.xml").decode()
        assert "tblHeader" in xml
        assert "Итого к оплате" in xml
        assert "12 000,00" in xml
        assert "PAGE" in archive.read("word/footer1.xml").decode()
        assert "SECRET" not in b"".join(archive.read(name) for name in archive.namelist()).decode(errors="ignore")


def test_docx_embeds_exact_pinned_fonts_and_keeps_every_source_unicode(tmp_path):
    from lxml import etree
    from reportlab.pdfbase.ttfonts import TTFont
    from scandocument.resources import resource_path

    document = unicode_document_fixture()
    original = copy.deepcopy(document)
    output = tmp_path / "unicode.docx"
    render_docx(document, output, {})
    ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
          "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships"}
    with ZipFile(output) as archive:
        table = etree.fromstring(archive.read("word/fontTable.xml"))
        relationships = {entry.get("Id"): entry.get("Target") for entry in etree.fromstring(archive.read("word/_rels/fontTable.xml.rels"))}
        fonts = table.xpath('w:font[@w:name="SBK Proposal Sans"]/*', namespaces=ns)
        assert len(fonts) == 4
        pins = json.loads(resource_path("proposals", "fonts", "SOURCE.json").read_text())
        expected = {tag: (variant, digest) for variant, tag, digest in PROPOSAL_FONT_FILES}
        for entry in fonts:
            variant, digest = expected[etree.QName(entry).localname]
            font_key = UUID(entry.get(f"{{{ns['w']}}}fontKey").strip("{}"))
            key = font_key.bytes[::-1]
            target = relationships[entry.get(f"{{{ns['r']}}}id")]
            embedded = bytearray(archive.read(f"word/{target}"))
            for index in range(32):
                embedded[index] ^= key[index % 16]
            assert hashlib.sha256(embedded).hexdigest() == digest == pins["files"][f"SBKProposalSans-{variant}.ttf"]
            padded = embedded + b"\0" * (-len(embedded) % 4)
            assert sum(struct.unpack(f">{len(padded) // 4}I", padded)) & 0xFFFFFFFF == 0xB1B0AFBA
            font = TTFont(variant, BytesIO(embedded))
            assert font.face.name == f"SBKProposalSans-{variant}".encode("ascii")
            assert struct.unpack_from(">H", font.face.get_table("OS/2"), 8)[0] == 0
            for char in "Акт сдачи\u2011приемки ₽ № ЁЙ − – —\u00a0\u202f":
                assert font.face.charToGlyph.get(ord(char), 0) > 0
        body = etree.fromstring(archive.read("word/document.xml"))
        footer = etree.fromstring(archive.read("word/footer1.xml"))
        assert "".join(body.xpath("//w:t/text()", namespaces=ns)).count("\u2011") == 3
        assert "Форма сдачи\u2011приемки" in "".join(footer.xpath("//w:t/text()", namespaces=ns))
        for root in (body, footer, etree.fromstring(archive.read("word/styles.xml"))):
            for slots in root.xpath("//w:rFonts", namespaces=ns):
                assert {slots.get(f"{{{ns['w']}}}{slot}") for slot in ("ascii", "hAnsi", "eastAsia", "cs")} == {"SBK Proposal Sans"}
                assert not any("Theme" in key for key in slots.attrib)
    assert document == original
    assert "SIL OPEN FONT LICENSE Version 1.1" in resource_path("proposals", "fonts", "OFL.txt").read_text()


def test_unknown_unicode_fails_closed_without_replacing_business_text(tmp_path):
    document = document_fixture()
    document["terms"]["payment"] = "Неизвестный символ \U0001f9ea не должен стать квадратом."
    original = copy.deepcopy(document)
    with pytest.raises(ValueError, match=r"U\+1F9EA"):
        render_docx(document, tmp_path / "unsupported.docx", {})
    assert document == original and not (tmp_path / "unsupported.docx").exists()


def test_missing_proposal_font_never_falls_back_to_system_fonts(tmp_path, monkeypatch):
    monkeypatch.setattr("scandocument.proposals.resource_path", lambda *_parts: tmp_path / "missing-fonts")
    with pytest.raises(ValueError, match="системная подстановка отключена"):
        render_docx(document_fixture(), tmp_path / "missing.docx", {})
    assert not (tmp_path / "missing.docx").exists()


def test_changed_font_asset_fails_before_writing_a_document(tmp_path, monkeypatch):
    directory = tmp_path / "tampered-fonts"
    directory.mkdir()
    (directory / "SBKProposalSans-Regular.ttf").write_bytes(b"not the pinned font")
    monkeypatch.setattr("scandocument.proposals.resource_path", lambda *_parts: directory)
    with pytest.raises(ValueError, match="шрифт КП изменился"):
        render_docx(document_fixture(), tmp_path / "tampered.docx", {})
    assert not (tmp_path / "tampered.docx").exists()


@pytest.mark.skipif(not os.environ.get("SCANDOCUMENT_SOFFICE"), reason="Bundled office runtime required")
def test_actual_pdf_unicode_has_real_pinned_glyphs_not_merely_correct_extracted_text(tmp_path):
    from pypdf import PdfReader
    from reportlab.pdfbase.ttfonts import TTFont
    from scandocument.resources import resource_path

    document = unicode_document_fixture()
    original = copy.deepcopy(document)
    result = render({"document": document, "workdir": str(tmp_path), "format": "preview", "assets": []})
    reader = PdfReader(result["outputPath"])
    assert len(reader.pages) == 1
    text = "\n".join(page.extract_text() or "" for page in reader.pages)
    assert text.count("\u2011") == 4
    assert "сдачи\u2011приемки" in text and "12 000,00 ₽" in text and "ЁЙ" in text
    checked = set()
    for reference in reader.pages[0]["/Resources"]["/Font"].get_object().values():
        font = reference.get_object()
        name = str(font["/BaseFont"]).split("+", 1)[-1]
        assert name in ("SBKProposalSans-Regular", "SBKProposalSans-Bold"), "System or internal LO font substitution is not accepted"
        descriptor = font["/FontDescriptor"].get_object()
        embedded = TTFont(name, BytesIO(descriptor["/FontFile2"].get_object().get_data()))
        source = TTFont(f"source-{name}", str(resource_path("proposals", "fonts", f"{name}.ttf")))
        cmap = font["/ToUnicode"].get_object().get_data().decode("ascii")
        for encoded, unicode_value in re.findall(r"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>", cmap):
            if unicode_value.upper() not in ("2011", "20BD"):
                continue
            code = int(unicode_value, 16)
            # A correct ToUnicode map alone is insufficient: the old Arial
            # PDF mapped U+2011 to a 1280x1280 square. Check the actual embedded
            # TrueType glyph against the exact pinned source glyph geometry.
            assert _glyph_box(embedded, int(encoded, 16)) == _glyph_box(source, code)
            checked.add((name, code))
    assert checked == {(f"SBKProposalSans-{variant}", code) for variant in ("Regular", "Bold") for code in (0x2011, 0x20BD)}
    assert document == original
    assert (tmp_path / "office/office-profile").is_dir()
    assert all(Path(path).is_file() for path in result["previewPages"])
    print(f"PROPOSAL_UNICODE_QA: {tmp_path}")


@pytest.mark.parametrize(
    "location,field", [("root", "internalNote"), ("issuer", "companyId"), ("layout", "templateId"), ("line", "cost")]
)
def test_rejects_unknown_private_fields_before_render(tmp_path, location, field):
    document = document_fixture()
    target = document if location == "root" else document["lines"][0] if location == "line" else document[location]
    target[field] = "SECRET_SENTINEL"
    with pytest.raises(ValueError, match="схема"):
        render_docx(document, tmp_path / "invalid.docx", {})
    assert not (tmp_path / "invalid.docx").exists()


def test_rejects_tampered_totals_and_expiry():
    document = document_fixture()
    document["totals"]["grossMinor"] = "1200001"
    with pytest.raises(ValueError, match="итог"):
        validate_document(document)
    document = document_fixture()
    document["validUntil"] = "2029-12-31"
    with pytest.raises(ValueError, match="раньше"):
        validate_document(document)


def test_missing_office_fails_pdf_but_docx_remains_available(tmp_path, monkeypatch):
    monkeypatch.setattr("scandocument.proposals.find_soffice", lambda: None)
    config = {"document": document_fixture(), "workdir": str(tmp_path), "assets": [], "format": "pdf"}
    with pytest.raises(ValueError, match="DOCX можно сохранить"):
        render(config)
    assert (tmp_path / "proposal.docx").is_file()
    config["format"] = "docx"
    assert render(config)["outputBytes"] > 1000


def test_attachment_outside_private_stage_rejected(tmp_path):
    source = tmp_path / "outside.txt"
    source.write_text("public attachment")
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    document = document_fixture()
    document["attachments"] = [
        {"fileName": "test.txt", "sizeBytes": source.stat().st_size, "sha256": digest, "mimeType": "text/plain"}
    ]
    with pytest.raises(ValueError, match="не принадлежит"):
        render(
            {
                "document": document,
                "workdir": str(tmp_path),
                "format": "docx",
                "assets": [{"sha256": digest, "path": str(source)}],
            }
        )


def test_logo_is_decoded_and_metadata_removed(tmp_path):
    from PIL.PngImagePlugin import PngInfo

    logo = tmp_path / "source.png"
    metadata = PngInfo()
    metadata.add_text("internal", "SECRET_LOGO_METADATA")
    Image.new("RGB", (300, 100), "green").save(logo, pnginfo=metadata)
    digest = hashlib.sha256(logo.read_bytes()).hexdigest()
    document = document_fixture()
    document["layout"]["logo"] = {
        "fileName": "logo.png",
        "sizeBytes": logo.stat().st_size,
        "sha256": digest,
        "mimeType": "image/png",
    }
    output = tmp_path / "result.docx"
    render_docx(document, output, {digest: logo})
    with ZipFile(output) as archive:
        assert not any(b"SECRET_LOGO_METADATA" in archive.read(name) for name in archive.namelist())


def test_cancel_stops_actual_office_child_process(tmp_path, monkeypatch):
    import subprocess
    import sys
    import threading
    from scandocument.errors import CancelledError
    from scandocument import office_engine

    original_popen = subprocess.Popen
    children = []
    timers = []

    def slow_office(_command, **kwargs):
        child = original_popen([sys.executable, "-c", "import time; time.sleep(60)"], **kwargs)
        children.append(child)
        timer = threading.Timer(0.4, lambda: (tmp_path / "cancel.requested").write_text("cancel"))
        timers.append(timer)
        timer.start()
        return child

    monkeypatch.setattr("scandocument.proposals.find_soffice", lambda: Path(sys.executable))
    monkeypatch.setattr(office_engine.subprocess, "Popen", slow_office)
    try:
        with pytest.raises(CancelledError):
            render({"document": document_fixture(), "workdir": str(tmp_path), "format": "pdf", "assets": []})
        assert len(children) == 1 and children[0].poll() is not None
        assert not (tmp_path / "proposal.pdf").exists()
    finally:
        for timer in timers:
            timer.cancel()
        for child in children:
            if child.poll() is None:
                child.kill()
                child.wait()


@pytest.mark.skipif(
    not os.environ.get("SCANDOCUMENT_SOFFICE"), reason="Bundled office runtime required for actual PDF rendering"
)
@pytest.mark.parametrize("count", [1, 20, 1000])
def test_real_office_pdf_and_preview_pages(tmp_path, count):
    from pypdf import PdfReader

    document = document_fixture(count)
    if count == 20:
        document["lines"][0]["description"] = (
            "Длинное описание проверяет перенос текста между строками и страницами. " * 50
        )
        document["number"] += "-ДлинныйНомер" * 15
    result = render({"document": document, "workdir": str(tmp_path), "format": "preview", "assets": []})
    reader = PdfReader(result["outputPath"])
    assert len(reader.pages) == result["pageCount"] == len(result["previewPages"])
    text = "\n".join(page.extract_text() for page in reader.pages)
    assert "Итого к оплате" in text
    assert "SECRET" not in text + str(reader.metadata)
    assert len(reader.pages) >= (2 if count > 1 else 1)
    for path in result["previewPages"]:
        with Image.open(path) as image:
            assert image.width > 600 and image.height > 900
    (tmp_path / "public-document.json").write_text(json.dumps(document, ensure_ascii=False), encoding="utf-8")
    print(f"PROPOSAL_QA_{count}: {tmp_path}")


@pytest.mark.skipif(not os.environ.get("SCANDOCUMENT_SOFFICE"), reason="Bundled office runtime required")
def test_zip_explicit_attachments_only_and_no_paths(tmp_path):
    assets = tmp_path / "assets"
    assets.mkdir()
    payload = b"Explicit public attachment"
    digest = hashlib.sha256(payload).hexdigest()
    path = assets / digest
    path.write_bytes(payload)
    (assets / "unselected-secret.txt").write_text("SECRET_UNSELECTED")
    document = document_fixture()
    document["attachments"] = [
        {"fileName": "Описание.txt", "sizeBytes": len(payload), "sha256": digest, "mimeType": "text/plain"}
    ]
    result = render(
        {
            "document": document,
            "assets": [{"sha256": digest, "path": str(path)}],
            "workdir": str(tmp_path),
            "format": "zip",
        }
    )
    with ZipFile(result["outputPath"]) as archive:
        assert len(archive.namelist()) == 4
        assert not any(b"SECRET_UNSELECTED" in archive.read(name) for name in archive.namelist())
        manifest = archive.read("Перечень.json").decode()
        assert str(tmp_path) not in manifest
        assert "relativePath" not in manifest


@pytest.mark.skipif(not os.environ.get("SCANDOCUMENT_SOFFICE"), reason="Bundled office runtime required")
def test_compact_logo_fractional_and_large_prices_render(tmp_path):
    from pypdf import PdfReader

    assets = tmp_path / "assets"
    assets.mkdir()
    logo = assets / "logo.png"
    exif = Image.Exif()
    exif[0x013B] = "SECRET_EXIF_AUTHOR"
    Image.new("RGB", (400, 120), "#245C48").save(logo, exif=exif)
    digest = hashlib.sha256(logo.read_bytes()).hexdigest()
    document = document_fixture(3)
    document["layout"]["style"] = "compact"
    document["layout"]["logo"] = {
        "fileName": "logo.png",
        "sizeBytes": logo.stat().st_size,
        "sha256": digest,
        "mimeType": "image/png",
    }
    document["lines"][0].update(
        quantity="0.1",
        unitPrice="0.2",
        priceBasis="net",
        tax={"kind": "vat", "rate": 22},
        netMinor="2",
        vatMinor="0",
        grossMinor="2",
    )
    document["lines"][1].update(
        unitPrice="1000000000000",
        tax={"kind": "none"},
        netMinor="100000000000000",
        vatMinor="0",
        grossMinor="100000000000000",
    )
    document["lines"][2].update(
        quantity="3", unitPrice="0.005", tax={"kind": "none"}, netMinor="2", vatMinor="0", grossMinor="2"
    )
    document["totals"] = {
        "pricingVersion": "proposal-pricing/1",
        "netMinor": "100000000000004",
        "vatMinor": "0",
        "grossMinor": "100000000000004",
        "byTax": [
            {"tax": {"kind": "vat", "rate": 22}, "netMinor": "2", "vatMinor": "0", "grossMinor": "2"},
            {"tax": {"kind": "none"}, "netMinor": "100000000000002", "vatMinor": "0", "grossMinor": "100000000000002"},
        ],
    }
    result = render(
        {
            "document": document,
            "workdir": str(tmp_path),
            "format": "preview",
            "assets": [{"sha256": digest, "path": str(logo)}],
        }
    )
    reader = PdfReader(result["outputPath"])
    text = "\n".join(page.extract_text() for page in reader.pages)
    assert "1 000 000 000 000,04" in text
    assert "НДС 22%" in text and "Без НДС" in text
    with ZipFile(tmp_path / "proposal.docx") as archive:
        assert not any(b"SECRET_EXIF_AUTHOR" in archive.read(name) for name in archive.namelist())
    assert "SECRET_EXIF_AUTHOR" not in text + str(reader.metadata)
    print(f"PROPOSAL_QA_LOGO: {tmp_path}")
