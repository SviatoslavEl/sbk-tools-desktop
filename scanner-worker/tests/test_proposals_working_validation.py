"""Pure V3 validation only. No Document, font, Office or export is executed."""
from __future__ import annotations

import copy
import json
from pathlib import Path
from unittest.mock import patch

import pytest

from scandocument import proposals


def working_fixture(mode="review-draft"):
    return {
        "kind": "proposal-working-public-document", "schemaVersion": 3, "mode": mode,
        "title": "  Рабочее КП e\u0301 🧪\r\nбез нормализации  ",
        "metadata": {"number": None, "documentDate": None, "validUntil": None, "currency": None, "issuerName": None, "recipientName": None},
        "layout": {"style": "compact", "accentColor": "#aB12eF"},
        "sections": [{"area": area, "title": f"Раздел {index}", "blocks": [f"  Целый выбранный блок {index}\r\n漢字 🧪\t e\u0301.  "]}
                     for index, area in enumerate(proposals.WORKING_PROPOSAL_AREAS)],
    }


@pytest.fixture(autouse=True)
def forbid_artifact_operations(monkeypatch):
    def forbidden(*_args, **_kwargs):
        pytest.fail("Validation must not instantiate/render a document or call Office/fonts")

    for name in ("Document", "render_docx", "_render_working_docx", "_embed_proposal_fonts", "find_soffice"):
        monkeypatch.setattr(proposals, name, forbidden)


def test_v3_validate_returns_original_exact_text_null_order_and_no_legacy_defaults():
    document = working_fixture("final")
    before = json.dumps(document, ensure_ascii=False, separators=(",", ":"))
    assert proposals.validate_document(document) is document
    assert json.dumps(document, ensure_ascii=False, separators=(",", ":")) == before
    assert all(value is None for value in document["metadata"].values())
    assert not {"lines", "totals", "currency", "revision", "issuer", "recipient", "terms", "commercial", "attachments"} & document.keys()
    document["sections"][0]["blocks"] = ["second originally", "first explicitly now\r\n"]
    proposals.validate_document(document)
    assert document["sections"][0]["blocks"] == ["second originally", "first explicitly now\r\n"]


@pytest.mark.parametrize("field,limit", [("number", 200), ("currency", 80), ("issuerName", 2000), ("recipientName", 2000)])
def test_v3_nullable_metadata_exact_unicode_limit_and_no_defaults(field, limit):
    document = working_fixture()
    document["metadata"][field] = "🧪" * limit
    proposals.validate_document(document)
    document["metadata"][field] += "🧪"
    with pytest.raises(ValueError):
        proposals.validate_document(document)
    for invalid in (False, 0, {}, [], 1.5):
        document["metadata"][field] = invalid
        with pytest.raises(ValueError):
            proposals.validate_document(document)


@pytest.mark.parametrize("field", ["documentDate", "validUntil"])
def test_v3_dates_are_explicit_real_calendar_or_null_not_today_or_empty(field):
    document = working_fixture()
    for value in (None, "0001-01-01", "9999-12-31", "2032-02-29"):
        document["metadata"][field] = value
        assert proposals.validate_document(document)["metadata"][field] == value
    for value in ("0000-01-01", "2031-02-29", "2026-13-01", "2026-01-32", "", "2026-1-01", False, 20260101):
        document["metadata"][field] = value
        with pytest.raises(ValueError):
            proposals.validate_document(document)


@pytest.mark.parametrize("location", ["title", "section-title", "block"])
def test_v3_codepoint_limits_and_unicode_controls_without_truncation(location):
    document = working_fixture()
    maximum = 20000 if location == "block" else 500
    target, key = (document, "title") if location == "title" else (document["sections"][0], "title") if location == "section-title" else (document["sections"][0]["blocks"], 0)
    target[key] = "🧪" * maximum
    proposals.validate_document(document)
    target[key] += "🧪"
    with pytest.raises(ValueError):
        proposals.validate_document(document)
    assert len(target[key]) == maximum + 1
    for invalid in ("bad\x00", "bad\x1f", "bad\x7f", "bad\x85", "bad\x9f", "bad\ud800", "bad\udfff", False, None):
        target[key] = invalid
        with pytest.raises(ValueError):
            proposals.validate_document(document)


@pytest.mark.parametrize("location", ["root", "metadata", "layout", "section"])
def test_v3_closed_shape_rejects_private_fields_at_every_object_level(location):
    document = working_fixture()
    target = document if location == "root" else document["sections"][0] if location == "section" else document[location]
    for key in ("privateContext", "raw", "historyJson", "evidenceRefs", "questionAnswers", "reviewReason", "humanApproval", "id"):
        target[key] = "PRIVATE_SENTINEL"
        with pytest.raises(ValueError):
            proposals.validate_document(document)
        del target[key]


@pytest.mark.parametrize("version", [None, True, 3.0, "3", 4, 1, 2])
def test_v3_version_never_coerces_or_falls_back_into_legacy(version):
    document = working_fixture()
    document["schemaVersion"] = version
    with pytest.raises(ValueError):
        proposals.validate_document(document)


def test_v3_exact_sections_order_lists_and_bounds():
    document = working_fixture()
    for section in document["sections"]:
        section["blocks"] = ["whole"] * 65
    proposals.validate_document(document)  # 7*65=455 whole strings, no synthetic price rows.
    document["sections"][0]["blocks"].append("extra")
    with pytest.raises(ValueError):
        proposals.validate_document(document)
    for mutate in (lambda d: d["sections"].reverse(), lambda d: d["sections"].pop(), lambda d: d["sections"].append(copy.deepcopy(d["sections"][0])),
                   lambda d: d["sections"][0].update(area="payment"), lambda d: d["sections"][0].update(blocks=("not-a-list",)),
                   lambda d: d["sections"][0].update(blocks=[{"text": "not a whole string"}]), lambda d: d.update(kind="proposal"),
                   lambda d: d["layout"].update(style=["compact"]), lambda d: d["layout"].update(accentColor="#12345")):
        invalid = working_fixture()
        mutate(invalid)
        with pytest.raises(ValueError):
            proposals.validate_document(invalid)


def test_v3_all_whitespace_final_matches_frontend_trim_including_bom():
    document = working_fixture()
    for section in document["sections"]:
        section["blocks"] = []
    proposals.validate_document(document)  # An empty review draft can remain a usable saved working document.
    document["mode"] = "final"
    for whitespace in ("", " \t\r\n", "\ufeff", "\u00a0\ufeff\u3000\u2028"):
        document["sections"][0]["blocks"] = [whitespace]
        with pytest.raises(ValueError):
            proposals.validate_document(document)
    document["sections"][0]["blocks"] = ["\ufeff Явно выбранный текст \ufeff"]
    proposals.validate_document(document)


def test_v3_private_named_business_prose_is_not_semantically_redacted():
    document = working_fixture()
    text = "PRIVATE_SENTINEL/historyJson/evidenceRefs — это явно выбранные деловые названия.\r\n"
    document["sections"][0]["blocks"] = [text]
    proposals.validate_document(document)
    assert document["sections"][0]["blocks"] == [text]


def test_v3_compact_utf8_budget_exact_boundary_and_aggregate_overflow(monkeypatch):
    document = working_fixture()
    encoded = json.dumps(document, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    monkeypatch.setattr(proposals, "MAX_PUBLIC_BYTES", len(encoded))
    proposals.validate_document(document)
    document["sections"][0]["blocks"][0] += "x"
    with pytest.raises(ValueError, match="8 МБ"):
        proposals.validate_document(document)
    monkeypatch.setattr(proposals, "MAX_PUBLIC_BYTES", 8 * 1024 * 1024)
    huge = working_fixture()
    for section in huge["sections"]:
        section["blocks"] = ["x" * 20000] * 65
    with pytest.raises(ValueError, match="8 МБ"):
        proposals.validate_document(huge)
    assert len(huge["sections"][0]["blocks"][0]) == 20000


@pytest.mark.parametrize("output_format", ["docx", "pdf", "preview"])
def test_v3_options_validate_purely_with_no_assets_or_filesystem(output_format):
    proposals._working_render_options(output_format, [])
    with patch.object(Path, "resolve", side_effect=AssertionError("No path should be read")):
        assert proposals._verified_assets(working_fixture(), [], Path("/SYNTHETIC_NEVER_READ")) == {}


@pytest.mark.parametrize("output_format", ["zip", "DOCX", "", None])
def test_v3_rejects_zip_or_unknown_formats_before_any_work(output_format):
    with pytest.raises(ValueError):
        proposals._working_render_options(output_format, [])


@pytest.mark.parametrize("entries", [None, {}, (), [{"path": "/PRIVATE/NEVER_READ", "sha256": "a" * 64}]])
def test_v3_rejects_all_asset_requests_without_resolving_paths(entries):
    with patch.object(Path, "resolve", side_effect=AssertionError("No path should be read")):
        with pytest.raises(ValueError):
            proposals._verified_assets(working_fixture(), entries, Path("/SYNTHETIC_NEVER_READ"))


def test_existing_v1_v2_validation_remains_unchanged_no_rendering():
    from test_proposals import commercial_document_fixture, document_fixture

    for document in (document_fixture(), commercial_document_fixture()):
        before = copy.deepcopy(document)
        assert proposals.validate_document(document) is document
        assert document == before
