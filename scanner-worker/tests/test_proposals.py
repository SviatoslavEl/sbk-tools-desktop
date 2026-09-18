from __future__ import annotations

import copy
import hashlib
import json
import os
from pathlib import Path
from zipfile import ZipFile

import pytest
from docx import Document
from PIL import Image

from scandocument.proposals import render, render_docx, validate_document


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

    def slow_office(_command, **kwargs):
        child = original_popen([sys.executable, "-c", "import time; time.sleep(60)"], **kwargs)
        children.append(child)
        return child

    monkeypatch.setattr("scandocument.proposals.find_soffice", lambda: Path(sys.executable))
    monkeypatch.setattr(office_engine.subprocess, "Popen", slow_office)
    timer = threading.Timer(0.4, lambda: (tmp_path / "cancel.requested").write_text("cancel"))
    timer.start()
    try:
        with pytest.raises(CancelledError):
            render({"document": document_fixture(), "workdir": str(tmp_path), "format": "pdf", "assets": []})
        assert len(children) == 1 and children[0].poll() is not None
        assert not (tmp_path / "proposal.pdf").exists()
    finally:
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
