#!/usr/bin/env python3
"""Compile the shared IRQ handler payload and update irq-handler-data.js."""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent
DEFAULT_BUILD_DIR = ROOT / "build"
DEFAULT_DATA_FILE = ROOT / ".." / "js" / "patchers" / "irq-handler-data.js"
DEFAULT_DEVKITARM_BIN = ROOT / ".." / "tools" / "devkitPro" / "devkitARM" / "bin"

PAYLOAD_HEX_RE = re.compile(r"^export const IRQ_HANDLER_PAYLOAD_HEX = (?P<value>(?:.|\n)*?);$", re.MULTILINE)
CONSTANTS_RE = re.compile(r"^export const IRQ_HANDLER_CONSTANTS = (?P<json>\{.*?\});$", re.MULTILINE)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Compile irq_handler/payload.S and embed it into JS data.")
    parser.add_argument("--build-dir", type=Path, default=DEFAULT_BUILD_DIR)
    parser.add_argument("--data-file", type=Path, default=DEFAULT_DATA_FILE)
    parser.add_argument("--payload-bin", type=Path)
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


def compile_payload(build_dir: Path) -> tuple[Path, Path]:
    source = ROOT / "payload.S"
    linker = ROOT / "payload.ld"
    build_dir.mkdir(parents=True, exist_ok=True)
    elf = build_dir / "payload.elf"
    binary = build_dir / "payload.bin"

    gcc = find_tool("arm-none-eabi-gcc")
    objcopy = find_tool("arm-none-eabi-objcopy")
    run(
        [
            str(gcc),
            "-mcpu=arm7tdmi",
            "-nostartfiles",
            "-nodefaultlibs",
            "-x",
            "assembler-with-cpp",
            str(source),
            "-T",
            str(linker),
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
    wanted = {
        "irq_config_magic",
        "irq_original_entrypoint",
        "irq_flags",
        "irq_rtc_menu_entry",
        "irq_batteryless_flush_entry",
        "irq_countdown_frames",
        "irq_indicator_mode",
        "irq_hotkey_mask",
        "irq_handler_entry",
        "irq_bootstrap",
        "irq_handler",
    }
    for line in out.splitlines():
        parts = line.split()
        if len(parts) < 3:
            continue
        name = parts[2]
        if name in wanted:
            symbols[name] = int(parts[0], 16)
    missing = sorted(wanted - symbols.keys())
    if missing:
        raise SystemExit(f"Missing IRQ payload symbols: {', '.join(missing)}")
    return symbols


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
    return (
        'export const IRQ_HANDLER_PAYLOAD_HEX = "";\n'
        "export const IRQ_HANDLER_CONSTANTS = {};\n"
    )


def embed(data_file: Path, payload: bytes, symbols: dict[str, int]) -> None:
    if data_file.exists():
        text = data_file.read_text(encoding="utf-8")
    else:
        text = default_data_text()

    constants = {
        "IRQ_HANDLER_SIZE": len(payload),
        "IRQ_HANDLER_MAGIC": 0x48515249,
        "IRQ_FLAG_RTC": 1,
        "IRQ_FLAG_BATTERYLESS": 2,
        "IRQ_FLAG_BATTERYLESS_AUTO": 4,
        "IRQ_HOTKEY_MASK": 0x030C,
        "IRQ_CONFIG_MAGIC_OFFSET": symbols["irq_config_magic"],
        "IRQ_ORIGINAL_ENTRYPOINT_OFFSET": symbols["irq_original_entrypoint"],
        "IRQ_FLAGS_OFFSET": symbols["irq_flags"],
        "IRQ_RTC_MENU_ENTRY_OFFSET": symbols["irq_rtc_menu_entry"],
        "IRQ_BATTERYLESS_FLUSH_ENTRY_OFFSET": symbols["irq_batteryless_flush_entry"],
        "IRQ_COUNTDOWN_FRAMES_OFFSET": symbols["irq_countdown_frames"],
        "IRQ_INDICATOR_MODE_OFFSET": symbols["irq_indicator_mode"],
        "IRQ_HOTKEY_MASK_OFFSET": symbols["irq_hotkey_mask"],
        "IRQ_HANDLER_ENTRY_OFFSET": symbols["irq_handler_entry"],
        "IRQ_BOOTSTRAP_OFFSET": symbols["irq_bootstrap"],
        "IRQ_HANDLER_OFFSET": symbols["irq_handler"],
    }

    constants_json = json.dumps(constants, ensure_ascii=False, separators=(",", ":"))
    if CONSTANTS_RE.search(text):
        text = CONSTANTS_RE.sub(f"export const IRQ_HANDLER_CONSTANTS = {constants_json};", text, count=1)
    else:
        text += f"\nexport const IRQ_HANDLER_CONSTANTS = {constants_json};\n"

    payload_literal = js_string_literal_chunks(payload.hex())
    if PAYLOAD_HEX_RE.search(text):
        text = PAYLOAD_HEX_RE.sub(f"export const IRQ_HANDLER_PAYLOAD_HEX = {payload_literal};", text, count=1)
    else:
        text = f"export const IRQ_HANDLER_PAYLOAD_HEX = {payload_literal};\n" + text

    data_file.parent.mkdir(parents=True, exist_ok=True)
    data_file.write_text(text, encoding="utf-8", newline="\n")


def main() -> int:
    args = parse_args()
    if args.payload_bin:
        elf = args.build_dir / "payload.elf"
        binary = args.payload_bin
    else:
        elf, binary = compile_payload(args.build_dir)
    payload = binary.read_bytes()
    symbols = parse_nm(elf)
    print(f"payload: {binary}")
    print(f"payload_len: 0x{len(payload):x}")
    if not args.no_embed:
        embed(args.data_file, payload, symbols)
        print(f"updated: {args.data_file}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
