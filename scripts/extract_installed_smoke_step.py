"""Copy the exact trusted release-workflow smoke body; never synthesize tests."""
from __future__ import annotations

import argparse
import hashlib
import os
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[1]
STEP_NAME = "Install, launch twice, verify shared locking and uninstall safely"


def extract_smoke_body(workflow: dict) -> str:
    steps = workflow["jobs"]["build-installed-windows"]["steps"]
    matching = [step for step in steps if step.get("name") == STEP_NAME]
    if len(matching) != 1 or matching[0].get("shell") != "pwsh":
        raise ValueError("Expected one PowerShell installed smoke step")
    step = matching[0]
    body = step.get("run")
    if not isinstance(body, str) or not body.strip() or "${{" in body or step.get("env"):
        raise ValueError("Smoke body needs unsupported interpolation or step-specific environment")
    for required in (
        "verify_runtime_manifest.py",
        "scanner-worker/tests/fixtures/preview.json",
        "scanner-worker/tests/fixtures/process-docx.json",
        "scanner-worker/tests/fixtures/process-ocr.json",
        "scanner-worker/tests/fixtures/process-facsimile.json",
        "Invoke-InstalledUninstall",
        "Close-VisibleApplication",
        "Fail-closed launch after forced termination",
        "Launch after explicit isolated-test recovery",
        "Install smoke and ProductData preservation checks completed",
    ):
        if required not in body:
            raise ValueError(f"Required installed regression is missing: {required}")
    return body


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    if os.environ.get("GITHUB_ACTIONS") != "true" or not os.environ.get("RUNNER_TEMP"):
        raise SystemExit("Generate the installed smoke script only on an isolated CI runner")
    output = args.output.resolve()
    temporary = Path(os.environ["RUNNER_TEMP"]).resolve()
    if not output.is_relative_to(temporary) or output.suffix.lower() != ".ps1":
        raise SystemExit("Smoke output must be a new .ps1 inside RUNNER_TEMP")
    workflow = yaml.safe_load((ROOT / ".github/workflows/release.yml").read_text(encoding="utf-8"))
    body = extract_smoke_body(workflow)
    data = body.encode("utf-8")
    # Exclusive creation, no edits to release.yml or an existing script.
    with output.open("xb") as stream:
        stream.write(data)
    print(f"Extracted exact release smoke body: {len(data)} bytes; SHA256 {hashlib.sha256(data).hexdigest()}")
    print(output)


if __name__ == "__main__":
    main()
