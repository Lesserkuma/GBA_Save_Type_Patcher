#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later AND MIT
"""Build the relocatable-in-ROM EEPROM V120/V121 aftermath wrapper."""

from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path

from build_support import (
    find_tool,
    generated_js_banner,
    sha256_bytes,
    source_sha256,
    write_text,
)

ROOT = Path(__file__).resolve().parent
PROJECT_ROOT = ROOT.parent.parent
DEFAULT_BUILD_DIR = ROOT / "build" / "eeprom-v120-wrapper"
DEFAULT_DATA_FILE = PROJECT_ROOT / "js" / "patchers" / "eeprom-v120-wrapper-data.js"

SYMBOLS = {
    "setupAddress": "eeprom_v120_setup_address",
    "cleanupAddress": "eeprom_v120_cleanup_address",
    "payloadAddress": "eeprom_v120_payload_address",
    "timerStateAddress": "eeprom_v120_timer_state_address",
    "configAddress": "eeprom_v120_config_address",
}
FIXED_HARDWARE_LITERALS = (
    0x04000202,
    0x04000200,
    0x04000006,
    0x04000100,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--build-dir", type=Path, default=DEFAULT_BUILD_DIR)
    parser.add_argument("--data-file", type=Path, default=DEFAULT_DATA_FILE)
    parser.add_argument("--no-embed", action="store_true")
    return parser.parse_args()


def run(command: list[str]) -> str:
    print("+", " ".join(command))
    result = subprocess.run(
        command, check=False, text=True,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )
    if result.stdout:
        print(result.stdout, end="")
    if result.returncode:
        raise SystemExit(result.returncode)
    return result.stdout


def main() -> int:
    args = parse_args()
    args.build_dir.mkdir(parents=True, exist_ok=True)
    obj = args.build_dir / "eeprom-v120-wrapper.o"
    elf = args.build_dir / "eeprom-v120-wrapper.elf"
    binary = args.build_dir / "eeprom-v120-wrapper.bin"
    gcc = find_tool("arm-none-eabi-gcc")
    objcopy = find_tool("arm-none-eabi-objcopy")
    nm = find_tool("arm-none-eabi-nm")
    objdump = find_tool("arm-none-eabi-objdump")

    run([
        str(gcc), "-mcpu=arm7tdmi", "-mthumb", "-c",
        str(ROOT / "eeprom-v120-wrapper.S"), "-o", str(obj),
    ])
    run([
        str(gcc), "-nostdlib", "-Wl,-Ttext=0", "-Wl,--build-id=none",
        str(obj), "-o", str(elf),
    ])
    relocations = run([str(objdump), "-r", str(elf)])
    if "R_ARM_" in relocations:
        raise SystemExit("EEPROM V120 wrapper contains unresolved relocations")
    run([str(objcopy), "-O", "binary", str(elf), str(binary)])
    payload = binary.read_bytes()

    table: dict[str, int] = {}
    for line in run([str(nm), "-n", str(elf)]).splitlines():
        fields = line.split()
        if len(fields) >= 3:
            table[fields[-1]] = int(fields[0], 16)
    start = table.get("eeprom_v120_wrapper_start")
    end = table.get("eeprom_v120_wrapper_end")
    if start != 0 or end != len(payload) or len(payload) > 0xE4 or len(payload) % 4:
        raise SystemExit("EEPROM V120 wrapper violates its in-place size contract")
    offsets = {name: table[symbol] for name, symbol in SYMBOLS.items()}
    for name, offset in offsets.items():
        if offset % 4 or offset < 0 or offset + 4 > len(payload):
            raise SystemExit(f"Invalid EEPROM V120 wrapper field: {name}")
    fixed_start = offsets["configAddress"] + 4
    if fixed_start + len(FIXED_HARDWARE_LITERALS) * 4 != len(payload):
        raise SystemExit("EEPROM V120 fixed literal pool is misplaced")
    for index, expected in enumerate(FIXED_HARDWARE_LITERALS):
        offset = fixed_start + index * 4
        if int.from_bytes(payload[offset:offset + 4], "little") != expected:
            raise SystemExit(f"Invalid EEPROM V120 fixed literal at 0x{offset:x}")

    if not args.no_embed:
        banner = generated_js_banner(
            generator="payloads/flash-direct/compile_eeprom_v120_wrapper.py",
            source_hash=source_sha256([
                ROOT / "eeprom-v120-wrapper.S", Path(__file__),
                ROOT / "build_support.py",
            ]),
            binary_hash=sha256_bytes(payload),
            license_expression="GPL-3.0-or-later AND MIT",
        )
        text = "\n".join((
            banner.rstrip(),
            f'export const EEPROM_V120_RUNTIME_WRAPPER_HEX = "{payload.hex()}";',
            "export const EEPROM_V120_RUNTIME_WRAPPER_OFFSETS = Object.freeze("
            + json.dumps(offsets, sort_keys=True, separators=(",", ":"))
            + ");",
            "",
        ))
        write_text(args.data_file, text)
        print(f"Embedded {len(payload)} bytes in {args.data_file}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
