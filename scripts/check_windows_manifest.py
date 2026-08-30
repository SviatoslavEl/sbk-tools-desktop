from __future__ import annotations

import xml.etree.ElementTree as ET
from pathlib import Path


def check_manifest(manifest: Path) -> None:
    document = ET.parse(manifest)

    common_controls = next(
        (
            element
            for element in document.iter()
            if element.tag.endswith("assemblyIdentity")
            and element.attrib.get("name") == "Microsoft.Windows.Common-Controls"
        ),
        None,
    )
    if common_controls is None or common_controls.attrib.get("version") != "6.0.0.0":
        raise SystemExit("Windows manifest must activate Microsoft.Windows.Common-Controls 6.0.0.0")

    execution_level = next(
        (element for element in document.iter() if element.tag.endswith("requestedExecutionLevel")),
        None,
    )
    if execution_level is None or execution_level.attrib != {
        "level": "asInvoker",
        "uiAccess": "false",
    }:
        raise SystemExit("Windows manifest must run asInvoker with uiAccess=false")


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    for manifest in (
        root / "scripts" / "windows-as-invoker.manifest",
        root / "windows-launcher" / "app.manifest",
    ):
        check_manifest(manifest)

    print("Windows manifests activate Common Controls v6 and run asInvoker")


if __name__ == "__main__":
    main()
