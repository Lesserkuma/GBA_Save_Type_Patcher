#!/usr/bin/env python3
"""Compile payload.c and update the Web Tool payload data."""

from __future__ import annotations

import argparse
import json
import re
import shutil
import struct
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent
RUNTIME_DIR = ROOT
DEFAULT_BUILD_DIR = RUNTIME_DIR / "build"
DEFAULT_DATA_FILE = ROOT / ".." / "js" / "patchers" / "sram-data.js"

COUNTDOWN_MARKER = bytes.fromhex("01bc0047ffb400b56622002a02d1")
PAYLOAD_HEX_EXPORT_RE = re.compile(
    r'^export const BATTERYLESS_PAYLOAD_HEX = (?P<value>(?:.|\n)*?);$',
    re.MULTILINE,
)
SRAM_CONSTANTS_RE = re.compile(
    r'^export const SRAM_CONSTANTS = (?P<json>\{.*?\});$',
    re.MULTILINE,
)

PAYLOAD_WORD_CONSTANTS = {
    0x0C: "BATTERYLESS_PATCHED_ENTRYPOINT",
    0x10: "BATTERYLESS_WRITE_SRAM_PATCHED",
    0x14: "BATTERYLESS_WRITE_EEPROM_PATCHED",
    0x18: "BATTERYLESS_WRITE_FLASH_PATCHED",
    0x1C: "BATTERYLESS_WRITE_EEPROM_V111_POSTHOOK",
    0x20: "BATTERYLESS_SRAM_BANK_SELECT_PATCHED",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Compile payload.c and embed the resulting bytes into ../js/patchers/sram-data.js."
    )
    parser.add_argument(
        "--build-dir",
        type=Path,
        default=DEFAULT_BUILD_DIR,
        help="Directory for intermediate payload build outputs.",
    )
    parser.add_argument(
        "--data-file",
        type=Path,
        default=DEFAULT_DATA_FILE,
        help="Web payload data file to update.",
    )
    parser.add_argument(
        "--payload-bin",
        type=Path,
        help="Use an existing payload.bin instead of compiling payload.c.",
    )
    parser.add_argument(
        "--no-embed",
        action="store_true",
        help="Only build or read payload.bin; do not update the Web payload data file.",
    )
    return parser.parse_args()


def find_tool(name: str) -> Path:
    exe = f"{name}.exe" if sys.platform == "win32" else name
    found = shutil.which(name) or shutil.which(exe)
    if found:
        return Path(found)

    raise SystemExit(f"{name} not found. Expected in PATH.")


def run(cmd: list[str]) -> None:
    print("+", " ".join(cmd))
    subprocess.run(cmd, check=True)


def compile_payload(build_dir: Path) -> Path:
    source = RUNTIME_DIR / "payload.c"
    linker_script = RUNTIME_DIR / "payload.ld"
    if not source.exists():
        raise SystemExit(f"Source file not found: {source}")
    if not linker_script.exists():
        raise SystemExit(f"Linker script not found: {linker_script}")

    build_dir.mkdir(parents=True, exist_ok=True)
    elf_path = build_dir / "payload.elf"
    bin_path = build_dir / "payload.bin"

    gcc = find_tool("arm-none-eabi-gcc")
    objcopy = find_tool("arm-none-eabi-objcopy")

    run(
        [
            str(gcc),
            "-mcpu=arm7tdmi",
            "-nostartfiles",
            "-nodefaultlibs",
            "-mthumb",
            "-fPIE",
            "-Os",
            "-fno-toplevel-reorder",
            str(source),
            "-T",
            str(linker_script),
            "-o",
            str(elf_path),
        ]
    )
    run([str(objcopy), "-O", "binary", str(elf_path), str(bin_path)])
    return bin_path


def read_payload(args: argparse.Namespace) -> tuple[Path, bytes]:
    bin_path = args.payload_bin if args.payload_bin else compile_payload(args.build_dir)
    if not bin_path.exists():
        raise SystemExit(f"payload.bin not found: {bin_path}")
    payload = bin_path.read_bytes()
    if len(payload) < 0x2C:
        raise SystemExit(f"payload.bin is too small: 0x{len(payload):x} bytes")
    return bin_path, payload


def find_countdown_offset(payload: bytes) -> int:
    marker_count = payload.count(COUNTDOWN_MARKER)
    if marker_count != 1:
        raise SystemExit(f"Countdown marker must appear exactly once, found: {marker_count}.")
    return payload.index(COUNTDOWN_MARKER) + 8


def update_constants(constants: dict, payload: bytes) -> int:
    for offset, name in PAYLOAD_WORD_CONSTANTS.items():
        constants[name] = struct.unpack_from("<I", payload, offset)[0]

    constants["BATTERYLESS_ORIGINAL_ENTRYPOINT_OFFSET"] = 0x00
    constants["BATTERYLESS_FLUSH_MODE_OFFSET"] = 0x04
    constants["BATTERYLESS_SAVE_SIZE_OFFSET"] = 0x08
    constants["BATTERYLESS_STORAGE_MODE_OFFSET"] = 0x24
    constants["BATTERYLESS_INDICATOR_MODE_OFFSET"] = 0x28

    countdown_offset = find_countdown_offset(payload)
    constants["BATTERYLESS_COUNTDOWN_IMMEDIATE_OFFSET"] = countdown_offset
    return countdown_offset


def js_string_literal_chunks(hex_payload: str, chunk_size: int = 128) -> str:
    chunks = [hex_payload[i : i + chunk_size] for i in range(0, len(hex_payload), chunk_size)]
    if not chunks:
        return '""'
    if len(chunks) == 1:
        return json.dumps(chunks[0])
    lines = ["  " + json.dumps(chunk) + " +" for chunk in chunks[:-1]]
    lines.append("  " + json.dumps(chunks[-1]))
    return "\n" + "\n".join(lines)


def embed_payload(data_file: Path, payload: bytes) -> int:
    text = data_file.read_text(encoding="utf-8")

    constants_match = SRAM_CONSTANTS_RE.search(text)
    if not constants_match:
        raise SystemExit(f"SRAM_CONSTANTS export not found in {data_file}")
    constants = json.loads(constants_match.group("json"))
    countdown_offset = update_constants(constants, payload)

    constants_json = json.dumps(constants, ensure_ascii=False, separators=(",", ":"))
    text, constants_replacements = SRAM_CONSTANTS_RE.subn(
        f"export const SRAM_CONSTANTS = {constants_json};",
        text,
        count=1,
    )
    if constants_replacements != 1:
        raise SystemExit("SRAM_CONSTANTS export was not updated exactly once.")

    payload_literal = js_string_literal_chunks(payload.hex())
    text, payload_replacements = PAYLOAD_HEX_EXPORT_RE.subn(
        f"export const BATTERYLESS_PAYLOAD_HEX = {payload_literal};",
        text,
        count=1,
    )
    if payload_replacements != 1:
        raise SystemExit("BATTERYLESS_PAYLOAD_HEX export was not updated exactly once.")

    data_file.write_text(text, encoding="utf-8", newline="\n")
    return countdown_offset


def main() -> int:
    args = parse_args()
    bin_path, payload = read_payload(args)
    print(f"payload: {bin_path}")
    print(f"payload_len: 0x{len(payload):x}")

    countdown_offset = find_countdown_offset(payload)
    print(f"countdown_offset: 0x{countdown_offset:x}")

    if args.no_embed:
        return 0

    embedded_countdown_offset = embed_payload(args.data_file, payload)
    print(f"updated: {args.data_file}")
    print(f"embedded: {len(payload)} bytes")
    print(f"embedded_countdown_offset: 0x{embedded_countdown_offset:x}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
