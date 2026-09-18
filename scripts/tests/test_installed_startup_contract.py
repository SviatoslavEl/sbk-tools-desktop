from __future__ import annotations

import importlib.util
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    "installed_contract", ROOT / "scripts/check_windows_installed_contract.py"
)
assert spec and spec.loader
contract = importlib.util.module_from_spec(spec)
spec.loader.exec_module(contract)


class InstalledStartupContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.frontend = (ROOT / "src/App.tsx").read_text(encoding="utf-8")

    def test_current_app_uses_readiness_without_legacy_delay(self) -> None:
        self.assertNotIn("if (installedFastStart) return;", self.frontend)
        contract.check_frontend_startup_readiness(self.frontend)

    def test_check_does_not_depend_on_indentation_or_line_endings(self) -> None:
        reformatted = self.frontend.replace("\n", "\r\n\t")
        contract.check_frontend_startup_readiness(reformatted)

    def test_rejects_missing_workspace_or_backend_render_guard(self) -> None:
        for original, replacement in (
            (
                "if (!installedFastStart && !workspace)",
                "if (!installedFastStart && false)",
            ),
            (
                "if (installedFastStart && (!workspace || !startup.ready))",
                "if (installedFastStart && !workspace)",
            ),
            (
                "if (installedFastStart && (!workspace || !startup.ready))",
                "if (installedFastStart && !startup.ready)",
            ),
        ):
            with self.subTest(replacement=replacement):
                self.assertIn(original, self.frontend)
                with self.assertRaises(SystemExit):
                    contract.check_frontend_startup_readiness(
                        self.frontend.replace(original, replacement, 1)
                    )

    def test_rejects_fetching_workspace_before_backend_is_ready(self) -> None:
        self.assertIn("if (status.ready)", self.frontend)
        with self.assertRaisesRegex(SystemExit, "ready backend response"):
            contract.check_frontend_startup_readiness(
                self.frontend.replace("if (status.ready)", "if (true)", 1)
            )

    def test_rejects_delayed_initial_readiness_request(self) -> None:
        original = 'refreshWorkspace();\n    window.addEventListener('
        self.assertIn(original, self.frontend)
        with self.assertRaisesRegex(SystemExit, "immediately on mount"):
            contract.check_frontend_startup_readiness(
                self.frontend.replace(
                    original,
                    'window.setTimeout(refreshWorkspace, 3500);\n    window.addEventListener(',
                    1,
                )
            )

    def test_rejects_reintroduced_legacy_delay_state(self) -> None:
        with self.assertRaisesRegex(SystemExit, "artificial splash delay"):
            contract.check_frontend_startup_readiness(
                self.frontend + "\nconst startupDelayElapsed = true;\n"
            )

    def test_rejects_artificial_timer_even_with_renamed_state(self) -> None:
        for timer in (
            "window.setTimeout(() => setSplashFinished(true), 3500);",
            "setTimeout(() => setSplashFinished(true), 1000);",
        ):
            with self.subTest(timer=timer):
                with self.assertRaisesRegex(SystemExit, "not delay the UI"):
                    contract.check_frontend_startup_readiness(self.frontend + timer)

    def test_rejects_slow_polling_as_a_disguised_startup_delay(self) -> None:
        for interval in (140, 500):
            original = f"window.setTimeout(refreshWorkspace, {interval})"
            self.assertIn(original, self.frontend)
            with self.subTest(interval=interval):
                with self.assertRaisesRegex(SystemExit, "not delay the UI"):
                    contract.check_frontend_startup_readiness(
                        self.frontend.replace(
                            original, "window.setTimeout(refreshWorkspace, 3500)", 1
                        )
                    )


class WindowsNativeTestOrderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.workflow = (ROOT / ".github/workflows/release.yml").read_text(encoding="utf-8")

    def test_current_workflow_checks_windows_before_scanner_build(self) -> None:
        contract.check_windows_native_test_order(self.workflow)

    def test_check_accepts_windows_line_endings(self) -> None:
        contract.check_windows_native_test_order(self.workflow.replace("\n", "\r\n"))

    def test_rejects_old_late_placement(self) -> None:
        start = self.workflow.index("      - name: Run native Windows regression tests")
        end = self.workflow.index("      - run: python -m pip install", start)
        native = self.workflow[start:end]
        workflow = self.workflow[:start] + self.workflow[end:]
        marker = "      - name: Build independent installed fast-start package"
        workflow = workflow.replace(marker, native + marker, 1)
        with self.assertRaisesRegex(SystemExit, "precede scanner compilation"):
            contract.check_windows_native_test_order(workflow)

    def test_rejects_changed_flags_or_removed_suite(self) -> None:
        command = "cargo test --manifest-path src-tauri/Cargo.toml --lib"
        for replacement in ("", command + " -- --ignored"):
            with self.subTest(replacement=replacement):
                with self.assertRaises(SystemExit):
                    contract.check_windows_native_test_order(
                        self.workflow.replace(command, replacement, 1)
                    )

    def test_rejects_missing_failure_guard_or_placeholder_cleanup(self) -> None:
        for fragment in (
            "if ($LASTEXITCODE -ne 0) { throw 'Windows database/editor regression tests failed' }",
            "Remove-Item -LiteralPath $workerStub -ErrorAction Stop",
            "if ($createdWorkerStub -and (Test-Path -LiteralPath $workerStub))",
        ):
            with self.subTest(fragment=fragment):
                with self.assertRaisesRegex(SystemExit, "safety check is missing"):
                    contract.check_windows_native_test_order(
                        self.workflow.replace(fragment, "", 1)
                    )

    def test_rejects_skipped_or_ignored_test_step(self) -> None:
        marker = "      - name: Run native Windows regression tests before scanner compilation\n"
        for setting in ("if: false", "continue-on-error: true"):
            with self.subTest(setting=setting):
                with self.assertRaisesRegex(SystemExit, "unconditional and fail closed"):
                    contract.check_windows_native_test_order(
                        self.workflow.replace(marker, marker + f"        {setting}\n", 1)
                    )


if __name__ == "__main__":
    unittest.main()
