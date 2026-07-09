#!/usr/bin/env python3
"""Compile the Fake-RTC runtime payload and update rtc-data.js."""

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
DEFAULT_BUILD_DIR = ROOT / "build"
DEFAULT_DATA_FILE = ROOT / ".." / "js" / "patchers" / "rtc-data.js"
DEFAULT_DEVKITARM_BIN = ROOT / ".." / "tools" / "devkitPro" / "devkitARM" / "bin"
LINK_ADDR = 0x09000000
GBA_ROM_BASE = 0x08000000

PAYLOAD_HEX_RE = re.compile(r"^export const RTC_PAYLOAD_HEX = (?P<value>(?:.|\n)*?);$", re.MULTILINE)
CONSTANTS_RE = re.compile(r"^export const RTC_PAYLOAD_CONSTANTS = (?P<json>\{.*?\});$", re.MULTILINE)
DEFINE_RE = re.compile(r"^#define\s+(?P<name>[A-Z0-9_]+)\s+(?P<value>\d+)u$", re.MULTILINE)

REQUIRED_SYMBOLS = {
    "payload_probe",
    "payload_reset",
    "payload_getstatus",
    "payload_gettimedate",
    "fake_rtc_menu_run_runtime",
}

ASSET_SIZES = {
    "menu_obj_palette": lambda d: 32,
    "menu_obj_tiles": lambda d: d["MENU_OBJ_TILES_SIZE_HALFWORDS"] * 2,
    "menu_runtime_bg_tiles": lambda d: d["MENU_RUNTIME_BG_TILES_SIZE_HALFWORDS"] * 2,
    "menu_runtime_bg_tile_starts": lambda d: d["MENU_RUNTIME_BG_COLS"] * d["MENU_RUNTIME_BG_ROWS"] * 2,
}

RELATIVE_BASES = [0x05000000, 0x05000200, 0x06000000, 0x06010000, 0x07000000]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Compile rtc_payload and embed it into JS data.")
    parser.add_argument("--build-dir", type=Path, default=DEFAULT_BUILD_DIR)
    parser.add_argument("--data-file", type=Path, default=DEFAULT_DATA_FILE)
    parser.add_argument("--payload-bin", type=Path)
    parser.add_argument("--no-assets", action="store_true", help="Do not regenerate menu_assets_generated.h before building.")
    parser.add_argument("--no-embed", action="store_true")
    return parser.parse_args()


def find_tool(name: str) -> Path:
    exe = f"{name}.exe" if sys.platform == "win32" else name
    found = shutil.which(name) or shutil.which(exe)
    if found:
        return Path(found)
    local = DEFAULT_DEVKITARM_BIN / exe
    if local.exists():
        return local
    raise SystemExit(f"{name} not found. Expected in PATH or {DEFAULT_DEVKITARM_BIN}.")


def run(cmd: list[str]) -> str:
    print("+", " ".join(cmd))
    completed = subprocess.run(cmd, check=True, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    if completed.stdout:
        print(completed.stdout, end="")
    return completed.stdout


def generate_assets() -> None:
    run([sys.executable, str(ROOT / "generate_menu_assets.py")])


def compile_payload(build_dir: Path) -> tuple[Path, Path]:
    linker = ROOT / "payload.ld"
    sources = [ROOT / "rtc_runtime.S", ROOT / "rtc_state.S", ROOT / "fake_rtc_menu.c"]
    build_dir.mkdir(parents=True, exist_ok=True)
    elf = build_dir / "payload.elf"
    binary = build_dir / "payload.bin"

    gcc = find_tool("arm-none-eabi-gcc")
    objcopy = find_tool("arm-none-eabi-objcopy")
    run(
        [
            str(gcc),
            "-mcpu=arm7tdmi",
            "-mthumb",
            "-mthumb-interwork",
            "-Os",
            "-fno-toplevel-reorder",
            "-ffunction-sections",
            "-fdata-sections",
            "-nostartfiles",
            "-nostdlib",
            *[str(source) for source in sources],
            "-T",
            str(linker),
            "-Wl,--gc-sections",
            "-Wl,--emit-relocs",
            "-lgcc",
            "-o",
            str(elf),
        ]
    )
    run([str(objcopy), "-O", "binary", str(elf), str(binary)])
    return elf, binary


def parse_nm(elf: Path) -> dict[str, int]:
    nm = find_tool("arm-none-eabi-nm")
    out = run([str(nm), "-n", str(elf)])
    symbols: dict[str, int] = {}
    for line in out.splitlines():
        parts = line.split()
        if len(parts) < 3:
            continue
        symbols[parts[2]] = int(parts[0], 16)
    missing = sorted(REQUIRED_SYMBOLS - symbols.keys())
    if missing:
        raise SystemExit(f"Missing RTC payload symbols: {', '.join(missing)}")
    return symbols


def parse_asset_defines() -> dict[str, int]:
    header = (ROOT / "menu_assets_generated.h").read_text(encoding="utf-8")
    values: dict[str, int] = {}
    for match in DEFINE_RE.finditer(header):
        values[match.group("name")] = int(match.group("value"))
    return values


def asset_ranges(symbols: dict[str, int], defines: dict[str, int]) -> list[tuple[int, int]]:
    ranges: list[tuple[int, int]] = []
    for name, size_fn in ASSET_SIZES.items():
        if name not in symbols:
            continue
        start = symbols[name]
        ranges.append((start, start + size_fn(defines)))
    return ranges


def in_ranges(value: int, ranges: list[tuple[int, int]]) -> bool:
    return any(start <= value < end for start, end in ranges)


def relocation_offsets(payload: bytes, asset_ranges_: list[tuple[int, int]]) -> tuple[list[int], list[int]]:
    absolute: list[int] = []
    relative: list[int] = []
    payload_end = LINK_ADDR + len(payload)
    for offset in range(0, len(payload) - 3, 4):
        value = struct.unpack_from("<I", payload, offset)[0]
        target = value & 0xFFFFFFFE
        if LINK_ADDR <= target < payload_end:
            absolute.append(offset)
            continue
        for base in RELATIVE_BASES:
            asset_target = (value + base) & 0xFFFFFFFF
            if in_ranges(asset_target, asset_ranges_):
                relative.append(offset)
                break
    return absolute, relative


def js_string_literal_chunks(hex_payload: str, chunk_size: int = 128) -> str:
    chunks = [hex_payload[i : i + chunk_size] for i in range(0, len(hex_payload), chunk_size)]
    if not chunks:
        return '""'
    if len(chunks) == 1:
        return json.dumps(chunks[0])
    lines = ["  " + json.dumps(chunk) + " +" for chunk in chunks[:-1]]
    lines.append("  " + json.dumps(chunks[-1]))
    return "\n" + "\n".join(lines)


def default_data_text() -> str:
    return 'export const RTC_PAYLOAD_HEX = "";\nexport const RTC_PAYLOAD_CONSTANTS = {};\n'


def embed(data_file: Path, payload: bytes, symbols: dict[str, int], absolute: list[int], relative: list[int]) -> None:
    if data_file.exists():
        text = data_file.read_text(encoding="utf-8")
    else:
        text = default_data_text()

    public_symbols = {name: symbols[name] for name in sorted(REQUIRED_SYMBOLS)}
    constants = {
        "RTC_PAYLOAD_SIZE": len(payload),
        "RTC_ORIGINAL_PAYLOAD_LINK_ADDR": LINK_ADDR,
        "RTC_RELOCATION_OFFSETS": absolute,
        "RTC_RELATIVE_ASSET_RELOCATION_OFFSETS": relative,
        "RTC_ORIGINAL_PAYLOAD_SYMBOLS": public_symbols,
        "GBA_ROM_BASE": GBA_ROM_BASE,
    }
    constants_json = json.dumps(constants, ensure_ascii=False, separators=(",", ":"))
    if CONSTANTS_RE.search(text):
        text = CONSTANTS_RE.sub(f"export const RTC_PAYLOAD_CONSTANTS = {constants_json};", text, count=1)
    else:
        text += f"\nexport const RTC_PAYLOAD_CONSTANTS = {constants_json};\n"

    payload_literal = js_string_literal_chunks(payload.hex())
    if PAYLOAD_HEX_RE.search(text):
        text = PAYLOAD_HEX_RE.sub(f"export const RTC_PAYLOAD_HEX = {payload_literal};", text, count=1)
    else:
        text = f"export const RTC_PAYLOAD_HEX = {payload_literal};\n" + text

    data_file.parent.mkdir(parents=True, exist_ok=True)
    data_file.write_text(text, encoding="utf-8", newline="\n")


def main() -> int:
    args = parse_args()
    if not args.no_assets:
        generate_assets()
    if args.payload_bin:
        elf = args.build_dir / "payload.elf"
        binary = args.payload_bin
    else:
        elf, binary = compile_payload(args.build_dir)
    payload = binary.read_bytes()
    symbols = parse_nm(elf)
    defines = parse_asset_defines()
    absolute, relative = relocation_offsets(payload, asset_ranges(symbols, defines))
    print(f"payload: {binary}")
    print(f"payload_len: 0x{len(payload):x}")
    print(f"relocations: {len(absolute)} abs32, {len(relative)} asset-addend")
    if not args.no_embed:
        embed(args.data_file, payload, symbols, absolute, relative)
        print(f"updated: {args.data_file}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
