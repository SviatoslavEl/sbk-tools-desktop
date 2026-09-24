from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("benchmark_scanner", ROOT / "scripts/benchmark_scanner.py")
assert spec and spec.loader
benchmark = importlib.util.module_from_spec(spec)
spec.loader.exec_module(benchmark)


class ScannerBenchmarkTests(unittest.TestCase):
    def test_cold_and_warm_operations_share_one_isolated_cache(self) -> None:
        cache = Path("isolated-cache")
        cases = benchmark.case_plan(Path("synthetic.docx"), cache, Path("outputs"), 3, 120)
        named = {name: config for name, _, config in cases}
        self.assertEqual(named["first-page-cold"]["pageIndex"], 0)
        self.assertEqual(named["first-page-warm"]["pageIndex"], 0)
        self.assertEqual(named["first-page-cold"]["previewCacheDir"], str(cache))
        self.assertEqual(named["first-page-warm"]["previewCacheDir"], str(cache))
        self.assertEqual(named["export-after-preview"]["previewCacheDir"], str(cache))
        self.assertNotEqual(named["export-empty-document-cache"]["previewCacheDir"], str(cache))
        self.assertTrue(all(config["outputPolicy"] == "no-clobber" for _, _, config in cases))
        self.assertTrue(all(config["ocrEnabled"] is False for _, _, config in cases))

    def test_prepared_pages_are_not_previously_requested_and_never_exceed_batch_limit(self) -> None:
        for pages in [3, 4, 5, 1000]:
            cases = benchmark.case_plan(Path("synthetic.pdf"), Path("cache"), Path("outputs"), pages, 120)
            prepared = next(config for _, operation, config in cases if operation == "preparePreview")
            self.assertLessEqual(len(prepared["pageIndices"]), 3)
            self.assertTrue(all(2 <= index < pages for index in prepared["pageIndices"]))
            self.assertEqual(len(set(prepared["outputPaths"])), len(prepared["pageIndices"]))
            self.assertNotIn("export-empty-document-cache", [name for name, _, _ in cases])

    def test_one_page_has_no_invalid_neighbor_requests(self) -> None:
        cases = benchmark.case_plan(Path("synthetic.pdf"), Path("cache"), Path("outputs"), 1, 96)
        self.assertEqual([name for name, _, _ in cases], ["first-page-cold", "first-page-warm", "export-after-preview"])
        self.assertEqual(len({config["outputPath"] for _, _, config in cases}), len(cases))

    def test_summary_keeps_scenarios_separate_and_reports_observed_percentile(self) -> None:
        samples = [{"scenario": "pdf:first-page-cold", "elapsedSeconds": value} for value in [3, 1, 2]]
        samples.append({"scenario": "pdf:first-page-warm", "elapsedSeconds": 0.5})
        result = benchmark.summarize(samples)
        self.assertEqual(result["pdf:first-page-cold"], {
            "samples": 3, "medianSeconds": 2, "p95Seconds": 3, "minSeconds": 1, "maxSeconds": 3,
        })
        self.assertEqual(result["pdf:first-page-warm"]["samples"], 1)
        self.assertEqual(benchmark.summarize([]), {})

    def test_error_or_incompatible_protocol_is_never_counted_as_fast_success(self) -> None:
        for stdout in ["", '{"type":"error"}', '{"type":"preview","protocolVersion":1}',
                       '["preview"]', 'not json']:
            with self.subTest(stdout=stdout), self.assertRaises(ValueError):
                benchmark.read_terminal_event(stdout, "preview")
        event = {"type": "preview", "protocolVersion": 2}
        self.assertEqual(benchmark.read_terminal_event('{"type":"progress"}\n' + json.dumps(event), "preview"), event)

    def test_run_directories_do_not_reuse_or_overwrite_existing_files(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            parent = Path(temporary)
            sentinel = parent / "report.json"
            sentinel.write_text("existing data", encoding="utf-8")
            first = benchmark.create_run_directory(parent, "run-")
            second = benchmark.create_run_directory(parent, "run-")
            self.assertNotEqual(first, second)
            self.assertEqual(first.parent, parent.resolve())
            self.assertEqual(sentinel.read_text(encoding="utf-8"), "existing data")

    def test_source_identity_detects_modified_added_and_deleted_modules(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            package = directory / "scandocument"
            package.mkdir()
            module = package / "worker_cli.py"
            module.write_text("version = 1", encoding="utf-8")
            original = benchmark.source_identity(directory)
            module.write_text("version = 2", encoding="utf-8")
            modified = benchmark.source_identity(directory)
            self.assertNotEqual(original, modified)
            added = package / "another.py"
            added.write_text("new = True", encoding="utf-8")
            self.assertNotEqual(modified, benchmark.source_identity(directory))
            added.unlink()
            self.assertEqual(modified, benchmark.source_identity(directory))

    def test_success_exit_without_expected_output_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            config = benchmark.case_plan(directory / "synthetic.pdf", directory / "cache", directory, 1, 96)[0][2]

            def fake_run(*args, **kwargs):
                kwargs["stdout"].write(json.dumps({"type": "preview", "protocolVersion": 2}))
                return type("Result", (), {"returncode": 0})()

            with patch.object(benchmark.subprocess, "run", side_effect=fake_run), self.assertRaises(KeyError):
                benchmark.run_case(["fake-worker"], {}, directory, "fake", "preview", config, 1, 5)


if __name__ == "__main__":
    unittest.main()
