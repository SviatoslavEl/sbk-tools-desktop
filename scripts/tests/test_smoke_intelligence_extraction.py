from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest


ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("intelligence_extraction_smoke", ROOT / "scripts/smoke_intelligence_extraction.py")
assert spec and spec.loader
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)


def event() -> dict:
    return {"type": "extraction", "protocolVersion": 2, "extractionEngineVersion": smoke.ENGINE,
            "extractedText": "QA\tТекст", "fragments": [{"id": "row-1", "locator": "Лист QA", "text": "QA\tТекст"}],
            "warnings": [], "sheets": [], "coverage": {"complete": True, "requiresOcr": False,
                                                          "pagesWithoutText": [], "pagesWithImages": []}}


@pytest.mark.parametrize("stdout", ["", "[]", "not JSON", '{"type":"extraction","protocolVersion":2}',
                                    json.dumps({**event(), "extractionEngineVersion": "sbk-local-extractor/1"}),
                                    json.dumps({**event(), "coverage": {"complete": True}}),
                                    json.dumps({**event(), "sheets": None}),
                                    json.dumps({**event(), "fragments": [{"text": "lost locator"}]}),
                                    json.dumps(event()) + "\n" + json.dumps(event())])
def test_rejects_stale_or_lossy_executable_events(stdout: str):
    with pytest.raises(ValueError):
        smoke.read_event(stdout)


def test_valid_utf8_metadata_round_trips_and_damaged_documents_need_explicit_errors():
    expected = event()
    assert smoke.read_event(json.dumps(expected, ensure_ascii=False)) == expected
    rejected = {"type": "error", "class": "ValueError", "message": "Synthetic invalid sheet"}
    assert smoke.read_event(json.dumps(rejected), rejected=True) == rejected
    with pytest.raises(ValueError):
        smoke.read_event(json.dumps(expected), rejected=True)
    with pytest.raises(ValueError):
        smoke.read_event(" " * (smoke.MAX_EVENT_BYTES + 1))


def test_all_synthetic_checks_accept_current_protocol_and_use_only_supplied_executable(tmp_path: Path):
    # An independent source-based unit test of the smoke assertions, not proof
    # of packaged execution. CI repeats these checks against actual binaries.
    from scandocument.extraction import extract_document

    worker = tmp_path / "fake-compiled-worker"
    worker.write_bytes(b"unit-test sentinel; never executed")
    calls = []

    def fake_run(command, **kwargs):
        assert command[:3] == [str(worker.resolve()), "extract", "--config"]
        assert kwargs["timeout"] == 180 and kwargs["encoding"] == "utf-8"
        assert "PYTHONPATH" not in kwargs["env"] and "PYTHONHOME" not in kwargs["env"]
        config = json.loads(Path(command[3]).read_text(encoding="utf-8"))
        calls.append(config)
        try:
            result = extract_document(Path(config["inputPath"]), include_hidden_sheets=config.get("includeHiddenSheets", False),
                                      selected_sheets=config.get("selectedSheets"))
            return SimpleNamespace(returncode=0, stdout=json.dumps(result, ensure_ascii=False) + "\n", stderr="")
        except ValueError as error:
            return SimpleNamespace(returncode=1, stdout=json.dumps({"type": "error", "class": "ValueError", "message": str(error)}) + "\n", stderr="")

    with patch.object(smoke.subprocess, "run", side_effect=fake_run):
        report = smoke.run_smoke(worker, tmp_path)
    assert report["status"] == "passed" and report["synthetic"] is True
    assert len(report["checks"]) == 7 and len(calls) == 7
    assert sum(check["expectedRejection"] for check in report["checks"]) == 2
    assert all(Path(config["inputPath"]).parent == tmp_path for config in calls)
    assert all(check["sourceUnchanged"] for check in report["checks"])
    assert worker.read_bytes() == b"unit-test sentinel; never executed"


def test_report_path_never_overwrites_existing_evidence(tmp_path: Path):
    report = tmp_path / "report.json"
    report.write_text("keep previous evidence", encoding="utf-8")
    with patch("sys.argv", ["smoke", "--worker", "not-launched", "--report", str(report)]), pytest.raises(SystemExit, match="already exists"):
        smoke.main()
    assert report.read_text(encoding="utf-8") == "keep previous evidence"
    assert list(tmp_path.iterdir()) == [report]


def test_optimized_python_rejects_cli_and_direct_smoke_before_worker_or_evidence_access(tmp_path: Path):
    missing_worker = tmp_path / "must-not-be-launched"
    report = tmp_path / "must-not-be-created.json"
    cli = subprocess.run([sys.executable, "-O", str(ROOT / "scripts/smoke_intelligence_extraction.py"),
                          "--worker", str(missing_worker), "--report", str(report)],
                         capture_output=True, text=True, encoding="utf-8", timeout=30)
    assert cli.returncode != 0 and "Python optimization: assertions are disabled" in cli.stderr
    assert not report.exists() and not list(tmp_path.iterdir())
    direct = subprocess.run([sys.executable, "-O", "-c",
                             "import importlib.util, pathlib; "
                             f"spec = importlib.util.spec_from_file_location('smoke', {str(ROOT / 'scripts/smoke_intelligence_extraction.py')!r}); "
                             "module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module); "
                             f"module.run_smoke(pathlib.Path({str(missing_worker)!r}), pathlib.Path({str(tmp_path)!r}))"],
                            capture_output=True, text=True, encoding="utf-8", timeout=30)
    assert direct.returncode != 0 and "Python optimization: assertions are disabled" in direct.stderr
    assert "Supplied scanner executable is missing" not in direct.stderr
    assert not list(tmp_path.iterdir())


def test_workflow_checks_compiled_sidecar_and_both_final_packages_and_keeps_integrity_guard():
    workflow = (ROOT / ".github/workflows/release.yml").read_text(encoding="utf-8")
    assert workflow.count("python scripts/smoke_intelligence_extraction.py --worker") == 4
    for report in ("intelligence-extraction-sidecar/report.json", "intelligence-extraction-final-app/report.json",
                   "intelligence-extraction-installed/report.json"):
        assert report in workflow
    mac = workflow[workflow.index("      - name: Test final macOS app scanner runtime"):workflow.index("      - name: Upload scanner preparation evidence")]
    assert mac.index("smoke_intelligence_extraction.py") < mac.rindex("verify_runtime_manifest.py") < mac.index("codesign --verify")
    installed = workflow[workflow.index("          $worker = Get-ChildItem $installDir"):workflow.index("          function Start-VisibleApplication")]
    assert installed.index("smoke_intelligence_extraction.py") < installed.rindex("verify_runtime_manifest.py")
    assert "Installed intelligence extraction metadata or corruption guard failed offline" in installed
