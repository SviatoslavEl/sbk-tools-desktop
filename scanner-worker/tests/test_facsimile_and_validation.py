from __future__ import annotations

import os
import time
import zipfile
from pathlib import Path

import pytest

from scandocument.errors import CorruptDocumentError, DocumentTooLargeError, UnsupportedFormatError
from scandocument.models import DocumentInfo, FacsimilePlacement, Redaction
from scandocument.worker_cli import validate_protocol
from scandocument.tempfiles import SecureWorkspace
from scandocument.validation import detect_kind, validate_ocr_languages, validate_render_budget


def placement(tmp_path: Path, application: str, pages: list[int]) -> FacsimilePlacement:
    return FacsimilePlacement(tmp_path / "stamp.png", application=application, pages=pages)


def test_facsimile_requires_explicit_non_empty_selection(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="Пустой диапазон"):
        placement(tmp_path, "explicitPages", []).validate_for_document(3)
    with pytest.raises(ValueError, match="ровно один"):
        placement(tmp_path, "current", [0, 1]).validate_for_document(3)
    with pytest.raises(ValueError, match="пределы"):
        placement(tmp_path, "explicitPages", [3]).validate_for_document(3)


def test_facsimile_all_is_the_only_mode_without_pages(tmp_path: Path) -> None:
    item = placement(tmp_path, "all", [])
    item.validate_for_document(2)
    assert item.applies_to(0)
    assert item.applies_to(1)


def test_redaction_and_protocol_are_strict() -> None:
    Redaction([0], 0.1, 0.1, 0.5, 0.2).validate_for_document(1)
    with pytest.raises(ValueError, match="внутри страницы"):
        Redaction([0], 0.8, 0.1, 0.5, 0.2).validate_for_document(1)
    with pytest.raises(ValueError, match="протокола"):
        validate_protocol({"protocolVersion": 1})


def test_ocr_languages_are_limited_to_bundled_models() -> None:
    assert validate_ocr_languages("rus+eng+rus") == "rus+eng"
    with pytest.raises(UnsupportedFormatError):
        validate_ocr_languages("rus+deu")


def test_docx_zip_slip_is_rejected(tmp_path: Path) -> None:
    document = tmp_path / "hostile.docx"
    with zipfile.ZipFile(document, "w") as archive:
        archive.writestr("word/document.xml", "<document />")
        archive.writestr("../escaped.txt", "secret")
    with pytest.raises(CorruptDocumentError, match="небезопасный"):
        detect_kind(document)


def test_render_budget_rejects_unbounded_work(tmp_path: Path) -> None:
    info = DocumentInfo(tmp_path / "large.pdf", "pdf", 1, 500, [(14_000.0, 14_000.0)] * 500)
    with pytest.raises(DocumentTooLargeError, match="слишком велик"):
        validate_render_budget(info, 300)


def test_secure_workspace_is_unique_private_and_removed(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(SecureWorkspace, "base_dir", classmethod(lambda cls: tmp_path / "private"))
    with SecureWorkspace() as first:
        first_path = first
        assert first_path.is_dir()
        if os.name != "nt":
            assert first_path.stat().st_mode & 0o077 == 0
        with SecureWorkspace() as second:
            assert second != first_path
    assert not first_path.exists()


def test_next_launch_removes_orphan_workspace(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    root = tmp_path / "private"
    orphan = root / f"{SecureWorkspace.PREFIX}999999-dead"
    orphan.mkdir(parents=True)
    old = time.time() - SecureWorkspace.STALE_SECONDS - 10
    os.utime(orphan, (old, old))
    monkeypatch.setattr(SecureWorkspace, "base_dir", classmethod(lambda cls: root))
    monkeypatch.setattr(SecureWorkspace, "_process_alive", staticmethod(lambda pid: False))
    SecureWorkspace.cleanup_stale()
    assert not orphan.exists()
