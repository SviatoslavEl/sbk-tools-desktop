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


if __name__ == "__main__":
    unittest.main()
