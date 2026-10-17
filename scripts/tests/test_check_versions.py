from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("check_versions", ROOT / "scripts/check_versions.py")
assert spec and spec.loader
versions = importlib.util.module_from_spec(spec)
spec.loader.exec_module(versions)


class VersionConsistencyTests(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.write("package.json", json.dumps({"version": "3.0.0"}))
        self.write("package-lock.json", json.dumps({
            "version": "3.0.0",
            "packages": {"": {"version": "3.0.0"}, "node_modules/example": {"version": "2.9.0"}},
        }))
        self.write("src-tauri/tauri.conf.json", json.dumps({"version": "3.0.0"}))
        for directory, name in (
            ("src-tauri", "sbk-tools-desktop"),
            ("windows-installer-helper", "sbk-tools-installed-extractor"),
        ):
            self.write(f"{directory}/Cargo.toml", f'[package]\nname = "{name}"\nversion = "3.0.0"\n')
            self.write(f"{directory}/Cargo.lock", (
                'version = 4\n\n[[package]]\nname = "other"\nversion = "2.9.0"\n\n'
                f'[[package]]\nname = "{name}"\nversion = "3.0.0"\n'
            ))
        self.write("scanner-worker/pyproject.toml", '[project]\nversion = "3.0.0"\n')
        self.write("scanner-worker/src/scandocument/__init__.py", '__version__ = "3.0.0"\n')
        # The frozen portable launcher is deliberately independent.
        self.write("windows-launcher/Cargo.toml", '[package]\nversion = "2.8.3"\n')

    def write(self, relative: str, content: str) -> None:
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")

    def test_accepts_matching_versions_without_changing_dependencies(self) -> None:
        self.assertEqual(versions.check_versions(self.root, "v3.0.0"), "3.0.0")

    def test_rejects_nested_npm_lock_root_mismatch(self) -> None:
        self.write("package-lock.json", json.dumps({
            "version": "3.0.0", "packages": {"": {"version": "2.9.0"}},
        }))
        with self.assertRaisesRegex(ValueError, "packages"):
            versions.check_versions(self.root)

    def test_rejects_each_local_cargo_lock_mismatch(self) -> None:
        for directory, name in (
            ("src-tauri", "sbk-tools-desktop"),
            ("windows-installer-helper", "sbk-tools-installed-extractor"),
        ):
            with self.subTest(directory=directory):
                path = self.root / directory / "Cargo.lock"
                original = path.read_text(encoding="utf-8")
                self.write(f"{directory}/Cargo.lock", original.replace('version = "3.0.0"', 'version = "2.9.0"'))
                with self.assertRaisesRegex(ValueError, directory):
                    versions.check_versions(self.root)
                self.write(f"{directory}/Cargo.lock", original)

    def test_rejects_missing_or_duplicate_local_lock_package(self) -> None:
        for content in (
            'version = 4\n',
            '[[package]]\nname = "sbk-tools-desktop"\nversion = "3.0.0"\n' * 2,
        ):
            with self.subTest(content=content):
                self.write("src-tauri/Cargo.lock", content)
                with self.assertRaisesRegex(ValueError, "exactly one local package"):
                    versions.check_versions(self.root)

    def test_rejects_wrong_release_tag(self) -> None:
        with self.assertRaisesRegex(ValueError, "Tag v2.9.0"):
            versions.check_versions(self.root, "v2.9.0")


if __name__ == "__main__":
    unittest.main()
