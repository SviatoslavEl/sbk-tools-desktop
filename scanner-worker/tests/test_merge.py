import json
import shutil
from pathlib import Path

from pypdf import PdfReader

from scandocument.worker_cli import merge


def test_merge_combines_pdf_and_docx_in_selected_order(tmp_path: Path, capsys) -> None:
    fixtures = Path(__file__).parent / "fixtures"
    first = tmp_path / "first.pdf"
    second = tmp_path / "second.docx"
    shutil.copyfile(fixtures / "simple.pdf", first)
    shutil.copyfile(fixtures / "simple.docx", second)
    output = tmp_path / "merged.pdf"

    result = merge({
        "protocolVersion": 2,
        "inputPaths": [str(first), str(second)],
        "outputPath": str(output),
        "preset": "Оригинал",
        "settings": {"dpi": 72, "jpeg_quality": 80},
        "ocrEnabled": False,
        "pdfaEnabled": False,
        "seed": 42,
    })

    events = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert result == 0
    assert output.read_bytes().startswith(b"%PDF-")
    assert len(PdfReader(output).pages) == 2
    assert events[-1]["type"] == "complete"
    assert events[-1]["pageCount"] == 2
