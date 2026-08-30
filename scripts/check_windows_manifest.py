from __future__ import annotations

import xml.etree.ElementTree as ET
from pathlib import Path


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    manifest = root / "scripts" / "windows-as-invoker.manifest"
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

    print("Windows manifest activates Common Controls v6 and runs asInvoker")


if __name__ == "__main__":
    main()
