from __future__ import annotations

import importlib.util
from pathlib import Path
import shutil
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("worker_build", ROOT / "scripts/build_scanner_worker.py")
assert spec and spec.loader
worker_build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker_build)


class WorkerPackageDataTests(unittest.TestCase):
    def test_docx_templates_and_physical_parts_directory_are_shipped(self) -> None:
        arguments = worker_build.package_data_arguments(ROOT / "scanner-worker")
        self.assertIn("--include-package-data=docx", arguments)
        self.assertIn("--include-package-data=pypdfium2", arguments)
        mappings = [item.removeprefix("--include-data-files=") for item in arguments
                    if item.startswith("--include-data-files=")]
        self.assertEqual(len(mappings), 1)
        source, destination = mappings[0].split("=", 1)
        self.assertEqual(destination, "docx/parts/runtime-directory.txt")
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            templates = root / "docx/templates"
            templates.mkdir(parents=True)
            footer = templates / "default-footer.xml"
            footer.write_text("<footer/>", encoding="utf-8")
            # Reproduce the actual python-docx path; a missing intermediate
            # directory fails despite the target template being present.
            library_path = root / "docx/parts/../templates/default-footer.xml"
            with self.assertRaises(FileNotFoundError):
                library_path.read_bytes()
            packaged_marker = root / destination
            packaged_marker.parent.mkdir(parents=True)
            shutil.copyfile(source, packaged_marker)
            self.assertEqual(library_path.read_text(encoding="utf-8"), "<footer/>")

    def test_missing_marker_fails_before_compilation(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaisesRegex(FileNotFoundError, "directory marker"):
                worker_build.package_data_arguments(Path(temporary))


if __name__ == "__main__":
    unittest.main()
