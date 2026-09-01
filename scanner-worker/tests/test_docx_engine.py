import errno
from pathlib import Path

from scandocument import docx_engine, office_engine
from scandocument.errors import DocxConversionError


def test_office_failure_uses_basic_docx_fallback(monkeypatch, tmp_path: Path) -> None:
    source = Path(__file__).parent / "fixtures/simple.docx"
    destination = tmp_path / "rendered.pdf"

    monkeypatch.setattr(docx_engine, "find_soffice", lambda: tmp_path / "soffice.exe")

    def fail_office(*_args, **_kwargs):
        raise DocxConversionError("office failed")

    monkeypatch.setattr("scandocument.office_engine.convert_with_office", fail_office)
    warnings = docx_engine.convert_docx_to_pdf(source, destination)

    assert destination.read_bytes().startswith(b"%PDF")
    assert any("автономный совместимый режим" in warning for warning in warnings)


def test_office_environment_keeps_runtime_bytecode_immutable(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("HTTPS_PROXY", "http://proxy.invalid")
    profile = tmp_path / "profile"
    workdir = tmp_path / "work"

    environment = office_engine._office_environment(profile, workdir)

    assert environment["HOME"] == str(profile)
    assert environment["TMPDIR"] == str(workdir)
    assert environment["PYTHONDONTWRITEBYTECODE"] == "1"
    assert "HTTPS_PROXY" not in environment


def test_converted_pdf_is_copied_when_windows_drives_differ(monkeypatch, tmp_path: Path) -> None:
    produced = tmp_path / "office" / "office-input.pdf"
    destination = tmp_path / "network-drive" / "converted.pdf"
    produced.parent.mkdir()
    produced.write_bytes(b"%PDF-1.7\nconverted")
    real_replace = office_engine.os.replace
    attempts = 0

    def cross_drive_once(source, target):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise OSError(errno.EXDEV, "different disk drives")
        return real_replace(source, target)

    monkeypatch.setattr(office_engine.os, "replace", cross_drive_once)
    office_engine._install_converted_pdf(produced, destination)

    assert destination.read_bytes() == b"%PDF-1.7\nconverted"
    assert not produced.exists()
    assert attempts == 2
