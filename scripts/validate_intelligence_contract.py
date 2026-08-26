#!/usr/bin/env python3
from __future__ import annotations

import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCHEMA = ROOT / "contracts/intelligence/v1/schemas.json"
OPENAPI = ROOT / "contracts/intelligence/v1/openapi.yaml"
RUST = ROOT / "src-tauri/src/intelligence.rs"
TYPESCRIPT = ROOT / "src/modules/intelligence/api.ts"


def main() -> int:
    schema = json.loads(SCHEMA.read_text(encoding="utf-8"))
    expected = set(schema["$defs"]["capability"]["enum"])
    rust = RUST.read_text(encoding="utf-8")
    typescript = TYPESCRIPT.read_text(encoding="utf-8")
    rust_values = set(re.findall(r'#\[serde\(rename = "([a-z_.]+)"\)\]', rust))
    block = re.search(r"intelligenceCapabilities\s*=\s*\[(.*?)\]\s*as const", typescript, re.S)
    if not block:
        raise SystemExit("TypeScript capability list not found")
    typescript_values = set(re.findall(r'"([a-z_.]+)"', block.group(1)))
    if rust_values != expected:
        raise SystemExit(f"Rust capabilities differ from JSON Schema: {sorted(rust_values ^ expected)}")
    if typescript_values != expected:
        raise SystemExit(f"TypeScript capabilities differ from JSON Schema: {sorted(typescript_values ^ expected)}")
    openapi = OPENAPI.read_text(encoding="utf-8")
    for path in ("/v1/health", "/v1/capabilities", "/v1/jobs", "/v1/jobs/{jobId}", "/v1/jobs/{jobId}/result"):
        if f"  {path}:" not in openapi:
            raise SystemExit(f"OpenAPI path is missing: {path}")
    print(f"Intelligence contract PASS: {len(expected)} closed capabilities, schema 1.0")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
