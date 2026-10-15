"""Verify a supplied scanner executable using only synthetic extraction fixtures.

Never imports the worker implementation or reads user documents. The same smoke
runs before packaging and against the final macOS/installed Windows worker.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import tempfile
import time
import zipfile
from pathlib import Path

from PIL import Image
from reportlab.pdfgen import canvas


WORD = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
SHEET = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
ENGINE = "sbk-local-extractor/2"
MAX_EVENT_BYTES = 2 * 1024 * 1024


def require_runtime_assertions() -> None:
    if not __debug__:
        raise RuntimeError("Extraction smoke cannot run with Python optimization: assertions are disabled")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def read_event(stdout: str, *, rejected: bool = False) -> dict:
    if len(stdout.encode("utf-8")) > MAX_EVENT_BYTES:
        raise ValueError("Synthetic extraction exceeded the protocol output bound")
    lines = stdout.splitlines()
    if len(lines) != 1:
        raise ValueError("Extraction must return exactly one JSON-line event")
    event = json.loads(lines[0])
    if not isinstance(event, dict):
        raise ValueError("Extraction event is not an object")
    if rejected:
        if event.get("type") != "error" or event.get("class") != "ValueError":
            raise ValueError("Damaged XLSX must fail with an explicit validation error")
        return event
    if (event.get("type") != "extraction" or event.get("protocolVersion") != 2
            or event.get("extractionEngineVersion") != ENGINE):
        raise ValueError("Worker returned an incompatible or stale extraction engine")
    if not isinstance(event.get("extractedText"), str) or not isinstance(event.get("fragments"), list):
        raise ValueError("Extraction text or fragments are missing")
    if not isinstance(event.get("warnings"), list) or any(not isinstance(value, str) for value in event["warnings"]):
        raise ValueError("Extraction warnings are missing or malformed")
    if not isinstance(event.get("sheets"), list):
        raise ValueError("Sheet metadata is missing")
    coverage = event.get("coverage", {})
    if not isinstance(coverage, dict) or any(type(coverage.get(key)) is not bool for key in ("complete", "requiresOcr")):
        raise ValueError("Extraction coverage is missing or malformed")
    for key in ("pagesWithoutText", "pagesWithImages"):
        if not isinstance(coverage.get(key), list) or any(type(page) is not int or page < 1 for page in coverage[key]):
            raise ValueError("Extraction page coverage is malformed")
    for fragment in event["fragments"]:
        if not isinstance(fragment, dict) or any(not isinstance(fragment.get(key), str) for key in ("id", "locator", "text")):
            raise ValueError("Extraction fragment identifiers or text were lost")
    # Reject non-finite JSON numbers and verify UTF-8 metadata round trips.
    if json.loads(json.dumps(event, ensure_ascii=False, allow_nan=False)) != event:
        raise ValueError("Extraction metadata does not round trip through JSON")
    return event


def write_workbook(path: Path, *, missing_hidden: bool = False, bad_shared: bool = False) -> None:
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("[Content_Types].xml", "<Types/>")
        archive.writestr("xl/workbook.xml", f'<workbook xmlns="{SHEET}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Текущий QA" sheetId="1" state="visible" r:id="r1"/><sheet name="История QA" sheetId="2" state="hidden" r:id="r2"/></sheets></workbook>')
        archive.writestr("xl/_rels/workbook.xml.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Target="worksheets/sheet1.xml"/><Relationship Id="r2" Target="worksheets/sheet2.xml"/></Relationships>')
        archive.writestr("xl/styles.xml", f'<styleSheet xmlns="{SHEET}"><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="9"/></cellXfs></styleSheet>')
        cells = ('<c r="C9" s="1"><v>46316</v></c><c r="D9" s="2"><v>0.2</v></c><c r="P9"><v>876543.21</v></c>'
                 if not bad_shared else '<c r="A9" t="s"><v>99</v></c>')
        archive.writestr("xl/worksheets/sheet1.xml", f'<worksheet xmlns="{SHEET}"><sheetData><row r="9">{cells}</row></sheetData></worksheet>')
        archive.writestr("xl/sharedStrings.xml", f'<sst xmlns="{SHEET}"><si><t>SYNTHETIC QA SHARED</t></si></sst>')
        if not missing_hidden:
            archive.writestr("xl/worksheets/sheet2.xml", f'<worksheet xmlns="{SHEET}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>OLD SYNTHETIC 2018</t></is></c></row></sheetData></worksheet>')


def create_fixtures(directory: Path) -> dict[str, Path]:
    word = directory / "synthetic-nested-notes.docx"
    with zipfile.ZipFile(word, "w") as archive:
        archive.writestr("[Content_Types].xml", "<Types/>")
        archive.writestr("word/document.xml", f'<w:document xmlns:w="{WORD}"><w:body><w:p><w:r><w:t><w:t>Сертификат QA – не менее 5;</w:t></w:t><w:tab/><w:t>Условие</w:t><w:br/><w:t>Новая строка</w:t><w:footnoteReference w:id="3"/></w:r></w:p></w:body></w:document>')
        archive.writestr("word/footnotes.xml", f'<w:footnotes xmlns:w="{WORD}"><w:footnote w:id="3"><w:p><w:r><w:t>Только синтетический текст сноски.</w:t></w:r></w:p></w:footnote></w:footnotes>')
    workbook = directory / "synthetic-selected-sheets.xlsx"
    missing = directory / "synthetic-missing-hidden-sheet.xlsx"
    shared = directory / "synthetic-bad-shared-index.xlsx"
    write_workbook(workbook)
    write_workbook(missing, missing_hidden=True)
    write_workbook(shared, bad_shared=True)
    image = directory / "synthetic-image.png"
    Image.new("RGB", (32, 32), "gray").save(image)
    pdf = directory / "synthetic-hybrid.pdf"
    drawing = canvas.Canvas(str(pdf))
    drawing.drawString(72, 760, "SYNTHETIC BODY QA")
    drawing.showPage()
    drawing.drawImage(str(image), 72, 700, 100, 100)
    drawing.save()
    return {"docx": word, "xlsx": workbook, "missing": missing, "shared": shared, "pdf": pdf}


def run_smoke(worker: Path, directory: Path, runtime: Path | None = None) -> dict:
    require_runtime_assertions()
    worker = worker.resolve()
    if not worker.is_file():
        raise ValueError("Supplied scanner executable is missing")
    if runtime is not None and not (runtime.resolve() / "resources").is_dir():
        raise ValueError("Supplied scanner runtime is missing")
    worker_digest = sha256(worker)
    files = create_fixtures(directory)
    environment = dict(os.environ)
    for name in ("PYTHONPATH", "PYTHONHOME", "SCANDOCUMENT_SOFFICE"):
        environment.pop(name, None)
    if runtime is not None:
        environment["SCANDOCUMENT_RESOURCE_ROOT"] = str(runtime.resolve())
    reports: list[dict] = []

    def run(label: str, source: Path, *, rejected: bool = False, **options) -> dict:
        before = sha256(source)
        config = directory / f"{label}.config.json"
        config.write_text(json.dumps({"protocolVersion": 2, "inputPath": str(source), **options}), encoding="utf-8")
        started = time.perf_counter()
        result = subprocess.run([str(worker), "extract", "--config", str(config)], env=environment,
                                capture_output=True, text=True, encoding="utf-8", timeout=180)
        elapsed = time.perf_counter() - started
        (directory / f"{label}.jsonl").write_text(result.stdout, encoding="utf-8")
        (directory / f"{label}.stderr.log").write_text(result.stderr, encoding="utf-8")
        if (result.returncode != 0) != rejected:
            raise ValueError(f"{label}: unexpected executable exit code {result.returncode}")
        event = read_event(result.stdout, rejected=rejected)
        if sha256(source) != before or not rejected and event.get("sha256") != before:
            raise ValueError(f"{label}: original bytes or extraction hash changed")
        reports.append({"check": label, "exitCode": result.returncode, "expectedRejection": rejected,
                        "elapsedSeconds": round(elapsed, 4), "sourceUnchanged": True,
                        **({"engine": event["extractionEngineVersion"], "characters": len(event["extractedText"]),
                            "fragmentCount": len(event["fragments"]), "coverage": event["coverage"],
                            "sheets": event["sheets"], "warnings": event["warnings"]} if not rejected else {})})
        return event

    word = run("docx-nested-tab-footnote", files["docx"])
    assert "Сертификат QA – не менее 5;\tУсловие\nНовая строка[Сноска 3]" in word["extractedText"]
    assert "Только синтетический текст сноски." in word["extractedText"]
    assert any(fragment.get("noteType") == "footnote" for fragment in word["fragments"])
    current = run("xlsx-visible-sparse-date-numeric", files["xlsx"])
    assert [sheet["included"] for sheet in current["sheets"]] == [True, False]
    assert [sheet["state"] for sheet in current["sheets"]] == ["visible", "hidden"]
    assert "OLD SYNTHETIC" not in current["extractedText"] and current["warnings"]
    fragment = current["fragments"][0]
    assert fragment["text"].startswith("\t\t2026-10-21\t20%") and fragment["cellRange"] == "A9:P9"
    assert fragment["sheetId"] == "1" and fragment["sheetState"] == "visible"
    cells = fragment["cells"]
    assert [cell["reference"] for cell in cells] == ["C9", "D9", "P9"]
    assert [cell["valueType"] for cell in cells] == ["date", "percentage", "number"]
    assert cells[2]["text"] == "876543.21" and cells[2]["rawValue"] == "876543.21"
    assert all(type(cell["hasFormula"]) is bool for cell in cells)
    hidden = run("xlsx-hidden-explicit", files["xlsx"], includeHiddenSheets=True, selectedSheets=["2"])
    assert [sheet["included"] for sheet in hidden["sheets"]] == [False, True]
    assert hidden["extractedText"] == "OLD SYNTHETIC 2018"
    assert all(fragment["sheetId"] == "2" and fragment["sheetState"] == "hidden"
               and fragment["includedByUser"] is True for fragment in hidden["fragments"])
    empty = run("xlsx-none-selected", files["xlsx"], selectedSheets=[])
    assert empty["fragments"] == [] and empty["extractedText"] == "" and len(empty["sheets"]) == 2
    assert not any(sheet["included"] for sheet in empty["sheets"])
    run("xlsx-missing-sheet-rejected", files["missing"], rejected=True)
    run("xlsx-shared-index-rejected", files["shared"], rejected=True)
    hybrid = run("pdf-hybrid-incomplete", files["pdf"])
    assert hybrid["coverage"] == {"complete": False, "requiresOcr": True, "pagesWithoutText": [2], "pagesWithImages": [2]}
    assert hybrid["fragments"][1]["hasImages"] is True and hybrid["fragments"][1]["textCoverage"] == "partial"
    assert hybrid["fragments"][1]["text"] == "" and len(hybrid["warnings"]) >= 2
    if sha256(worker) != worker_digest:
        raise ValueError("Scanner executable changed during extraction checks")
    return {"status": "passed", "synthetic": True, "extractionEngineVersion": ENGINE,
            "worker": str(worker), "workerSha256": worker_digest, "checks": reports}


def main() -> None:
    require_runtime_assertions()
    parser = argparse.ArgumentParser(description="Check a compiled extractor with synthetic offline documents")
    parser.add_argument("--worker", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--runtime", type=Path)
    args = parser.parse_args()
    report_path = args.report.resolve()
    # A report must never replace a pre-existing file supplied by a caller.
    if report_path.exists():
        raise SystemExit("Report already exists; choose a fresh evidence path")
    report_path.parent.mkdir(parents=True, exist_ok=True)
    directory = Path(tempfile.mkdtemp(prefix="run-", dir=report_path.parent))
    try:
        report = run_smoke(args.worker, directory, args.runtime)
    except Exception as error:
        report_path.write_text(json.dumps({"status": "failed", "synthetic": True, "error": str(error)[:2000],
                                          "errorClass": type(error).__name__, "fixtureDirectory": str(directory)}, indent=2), encoding="utf-8")
        raise
    report["fixtureDirectory"] = str(directory)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    # Windows CI may expose a legacy console encoding. ASCII JSON escapes are
    # lossless; keep the evidence file above as readable UTF-8.
    print(json.dumps(report, ensure_ascii=True), flush=True)


if __name__ == "__main__":
    main()
