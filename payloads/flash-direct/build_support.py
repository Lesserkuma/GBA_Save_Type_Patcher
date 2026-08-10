#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Small, self-contained helpers for the Direct payload builders."""

from __future__ import annotations

import hashlib
import shutil
import subprocess
import sys
from functools import cache
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
TOOL_DIR = PROJECT_ROOT / "tools" / "devkitPro" / "devkitARM" / "bin"


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def source_sha256(paths: list[Path]) -> str:
    digest = hashlib.sha256()
    for path in sorted((item.resolve() for item in paths), key=lambda item: item.as_posix()):
        digest.update(path.relative_to(PROJECT_ROOT).as_posix().encode())
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


@cache
def tool_version(executable: Path) -> str:
    result = subprocess.run(
        [str(executable), "--version"], check=False, text=True,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )
    if result.returncode or not result.stdout.strip():
        raise SystemExit(f"Could not query {executable.name} version")
    return result.stdout.splitlines()[0]


@cache
def find_tool(name: str) -> Path:
    executable = f"{name}.exe" if sys.platform == "win32" else name
    found = shutil.which(name) or shutil.which(executable)
    path = Path(found) if found else TOOL_DIR / executable
    if not path.exists():
        raise SystemExit(f"{name} not found")
    tool_version(path)
    return path


def toolchain_summary() -> str:
    return "; ".join(tool_version(find_tool(name)) for name in (
        "arm-none-eabi-gcc", "arm-none-eabi-objcopy",
    ))


def generated_js_banner(
    generator: str, source_hash: str, binary_hash: str, license_expression: str,
) -> str:
    return "\n".join((
        "// Generated file. Do not edit.",
        f"// Generator: {generator}",
        f"// Generator version: 2; source SHA-256: {source_hash}",
        f"// Toolchain: {toolchain_summary()}; Binary SHA-256: {binary_hash}",
        f"// SPDX-License-Identifier: {license_expression}",
        "",
    ))


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="\n")
