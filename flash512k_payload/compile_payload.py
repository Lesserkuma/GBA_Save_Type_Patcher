#!/usr/bin/env python3
"""Build the 512K FLASH runtime and embed its generated ABI."""

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
DEFAULT_DATA_FILE = ROOT / ".." / "js" / "patchers" / "flash512k-data.js"
DEFAULT_DEVKITARM_BIN = ROOT / ".." / "tools" / "devkitPro" / "devkitARM" / "bin"

SIGNATURE = b"thx Maniac\x00\x00lk_flash512k"
RAM_CODE_CAPACITY = 1152
PAYLOAD_RE = re.compile(
    r"^export const FLASH512K_PAYLOAD_HEX\s*=\s*(?P<value>(?:.|\n)*?);$",
    re.MULTILINE,
)
SIGNATURE_RE = re.compile(
    r'^export const FLASH512K_SIGNATURE_HEX\s*=\s*(?P<value>".*?");$',
    re.MULTILINE,
)
CONSTANTS_RE = re.compile(
    r"^export const FLASH512K_CONSTANTS\s*=\s*(?P<json>\{.*?\});$",
    re.MULTILINE,
)

ENTRY_SYMBOLS = {
    "FLASH512K_WRITE_SRAM_ENTRY": "write_sram_patched",
    "FLASH512K_WRITE_EEPROM_ENTRY": "write_eeprom_patched",
    "FLASH512K_READ_SRAM_ENTRY": "read_sram_patched",
    "FLASH512K_READ_EEPROM_ENTRY": "read_eeprom_patched",
    "FLASH512K_VERIFY_SRAM_ENTRY": "verify_sram_patched",
    "FLASH512K_VERIFY_EEPROM_ENTRY": "verify_eeprom_patched",
    "FLASH512K_FLUSH_ENTRY": "flush_journal_patched",
}
CONFIG_SYMBOLS = {
    "FLASH512K_BASE_CONFIG_OFFSET": "journal_base_offset_config",
    "FLASH512K_LOGICAL_SIZE_CONFIG_OFFSET": "journal_logical_size_config",
    "FLASH512K_LAYOUT_CONFIG_OFFSET": "journal_layout_config",
    "FLASH512K_COUNTDOWN_CONFIG_OFFSET": "journal_countdown_config",
    "FLASH512K_INDICATOR_CONFIG_OFFSET": "journal_indicator_config",
}
DRIVER_SYMBOL_ORDER = (
    "journal_rom_identify_1", "journal_rom_erase_1", "journal_rom_program_1",
    "journal_rom_identify_2", "journal_rom_erase_2", "journal_rom_program_2",
    "journal_rom_identify_3", "journal_rom_erase_3", "journal_rom_program_3",
)
DRIVER_SYMBOLS = set(DRIVER_SYMBOL_ORDER)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--build-dir", type=Path, default=DEFAULT_BUILD_DIR)
    parser.add_argument("--data-file", type=Path, default=DEFAULT_DATA_FILE)
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
    raise SystemExit(f"{name} not found in PATH or {DEFAULT_DEVKITARM_BIN}")


def run(command: list[str]) -> str:
    print("+", " ".join(command))
    completed = subprocess.run(
        command, check=False, text=True,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )
    if completed.stdout:
        print(completed.stdout, end="")
    if completed.returncode:
        raise SystemExit(completed.returncode)
    return completed.stdout


def compile_payload(build_dir: Path) -> tuple[Path, Path]:
    build_dir.mkdir(parents=True, exist_ok=True)
    elf = build_dir / "payload.elf"
    binary = build_dir / "payload.bin"
    gcc = find_tool("arm-none-eabi-gcc")
    objcopy = find_tool("arm-none-eabi-objcopy")
    run([
        str(gcc), "-mcpu=arm7tdmi", "-mthumb", "-mthumb-interwork",
        "-nostartfiles", "-nodefaultlibs", "-fPIE", "-Os",
        "-Wall", "-Wextra", "-Werror", "-Wframe-larger-than=512",
        "-fno-toplevel-reorder", "-fno-builtin", "-fno-jump-tables",
        "-fvisibility=hidden", "-fno-semantic-interposition",
        "-fno-unwind-tables", "-fno-asynchronous-unwind-tables",
        str(ROOT / "payload.c"),
        str(ROOT / "rom_flash.c"),
        "-T", str(ROOT / "payload.ld"), "-o", str(elf),
    ])
    run([str(objcopy), "-O", "binary", str(elf), str(binary)])
    return elf, binary


def parse_symbols(elf: Path) -> tuple[dict[str, int], set[str]]:
    nm = find_tool("arm-none-eabi-nm")
    all_names: set[str] = set()
    symbols: dict[str, int] = {}
    wanted = (
        set(ENTRY_SYMBOLS.values()) | set(CONFIG_SYMBOLS.values()) |
        DRIVER_SYMBOLS | {
            "flash512k_signature",
            "__journal_ram_code_start", "__journal_ram_code_end",
        }
    )
    for line in run([str(nm), "-n", str(elf)]).splitlines():
        parts = line.split()
        if len(parts) < 3:
            continue
        name = parts[2]
        all_names.add(name)
        if name in wanted:
            symbols[name] = int(parts[0], 16)
    missing = sorted(wanted - symbols.keys())
    if missing:
        raise SystemExit(f"Missing 512K FLASH payload symbols: {', '.join(missing)}")
    forbidden = sorted(name for name in all_names if "flash_4" in name or name.endswith("_4"))
    if forbidden:
        raise SystemExit(f"Type-4 symbols are forbidden: {', '.join(forbidden)}")
    return symbols, all_names


def validate_ram_code(elf: Path, symbols: dict[str, int]) -> str:
    start = symbols["__journal_ram_code_start"]
    end = symbols["__journal_ram_code_end"]
    size = end - start
    if start & 3 or end & 3 or size <= 0 or size > RAM_CODE_CAPACITY:
        raise SystemExit(f"Invalid RAM-code range: 0x{start:x}..0x{end:x} ({size} bytes)")
    for name in DRIVER_SYMBOLS:
        address = symbols[name] & ~1
        if not start <= address < end:
            raise SystemExit(f"RAM driver outside copied range: {name}=0x{address:x}")

    driver_ranges: list[tuple[str, int, int]] = []
    for index, name in enumerate(DRIVER_SYMBOL_ORDER):
        function_start = symbols[name] & ~1
        function_end = (
            symbols[DRIVER_SYMBOL_ORDER[index + 1]] & ~1
            if index + 1 < len(DRIVER_SYMBOL_ORDER)
            else end
        )
        function_size = function_end - function_start
        if function_start & 3 or function_end & 3 or function_size <= 0 or function_size & 3:
            raise SystemExit(
                f"Invalid individually copied RAM function: {name}="
                f"0x{function_start:x}..0x{function_end:x} ({function_size} bytes)"
            )
        driver_ranges.append((name, function_start, function_end))

    def containing_driver(address: int) -> tuple[str, int, int] | None:
        return next(
            (driver_range for driver_range in driver_ranges
             if driver_range[1] <= address < driver_range[2]),
            None,
        )

    objdump = find_tool("arm-none-eabi-objdump")
    disassembly = run([str(objdump), "-d", "-j", ".journal_ram_code", str(elf)])
    instruction_re = re.compile(
        r"^\s*([0-9a-f]+):\s+(?:[0-9a-f]{4,8}\s+)+([a-z][a-z0-9.]*)\s*(.*)$",
        re.IGNORECASE,
    )
    for line in disassembly.splitlines():
        match = instruction_re.match(line)
        if not match:
            continue
        address = int(match.group(1), 16)
        mnemonic = match.group(2).lower()
        operands = match.group(3)
        if not start <= address < end:
            continue
        driver_range = containing_driver(address)
        if driver_range is None:
            raise SystemExit(f"RAM-code instruction outside a driver function: {line.strip()}")
        driver_name, function_start, function_end = driver_range
        if mnemonic in {"bl", "blx"} or mnemonic.startswith("bl.") or mnemonic.startswith("blx."):
            raise SystemExit(f"RAM code calls outside itself at 0x{address:x}: {line.strip()}")
        if mnemonic.startswith("b") and not mnemonic.startswith("bx"):
            target_match = re.match(r"(?:\.\w+\s+)?([0-9a-f]+)\b", operands, re.IGNORECASE)
            if target_match:
                target = int(target_match.group(1), 16)
                if not function_start <= target < function_end:
                    raise SystemExit(
                        f"RAM-code branch leaves individually copied {driver_name}: {line.strip()}"
                    )
        literal_match = re.search(r"\[pc,.*?\].*?(?:;|@)\s*\(([0-9a-f]+)", operands, re.IGNORECASE)
        if literal_match:
            literal = int(literal_match.group(1), 16)
            if not function_start <= literal < function_end:
                raise SystemExit(
                    f"RAM-code literal pool leaves individually copied {driver_name}: {line.strip()}"
                )

    readelf = find_tool("arm-none-eabi-readelf")
    relocations = run([str(readelf), "-r", str(elf)])
    if "There are no relocations" not in relocations:
        raise SystemExit("Linked payload still contains relocations")

    driver_source = (ROOT / "rom_flash.c").read_text(encoding="utf-8").lower()
    forbidden_driver_tokens = (
        "journal_rom_identify_4", "journal_rom_erase_4", "journal_rom_program_4",
        "identify_flash_4", "erase_flash_4", "program_flash_4", "0x00ea", "0x01ff",
    )
    present = [token for token in forbidden_driver_tokens if token in driver_source]
    if present:
        raise SystemExit(f"Type-4 driver code/commands are forbidden: {', '.join(present)}")
    return disassembly


def js_literal(hex_payload: str, chunk_size: int = 128) -> str:
    chunks = [hex_payload[i:i + chunk_size] for i in range(0, len(hex_payload), chunk_size)]
    if len(chunks) == 1:
        return json.dumps(chunks[0])
    return "\n" + "\n".join(
        "  " + json.dumps(chunk) + (" +" if index + 1 < len(chunks) else "")
        for index, chunk in enumerate(chunks)
    )


def default_data_text() -> str:
    return (
        'export const FLASH512K_PAYLOAD_HEX = "";\n'
        f'export const FLASH512K_SIGNATURE_HEX = "{SIGNATURE.hex()}";\n'
        "export const FLASH512K_CONSTANTS = {};\n"
    )


def build_constants(payload: bytes, symbols: dict[str, int]) -> dict[str, object]:
    ram_function_ranges: dict[str, dict[str, int]] = {}
    for index, name in enumerate(DRIVER_SYMBOL_ORDER):
        function_start = symbols[name] & ~1
        function_end = (
            symbols[DRIVER_SYMBOL_ORDER[index + 1]] & ~1
            if index + 1 < len(DRIVER_SYMBOL_ORDER)
            else symbols["__journal_ram_code_end"]
        )
        ram_function_ranges[name] = {
            "start": function_start,
            "end": function_end,
            "size": function_end - function_start,
        }

    constants: dict[str, object] = {
        "GBA_ROM_BASE": 0x08000000,
        "FLASH512K_PAYLOAD_SIZE": len(payload),
        "FLASH512K_SIGNATURE_OFFSET": symbols["flash512k_signature"],
        "FLASH512K_ACTIVE_SIZE": 0x10000,
        "FLASH512K_RESERVED_SIZE": 0x40000,
        "FLASH512K_DEFAULT_COUNTDOWN": 100,
        "FLASH512K_RAM_CODE_START_OFFSET": symbols["__journal_ram_code_start"],
        "FLASH512K_RAM_CODE_END_OFFSET": symbols["__journal_ram_code_end"],
        "FLASH512K_RAM_CODE_SIZE": (
            symbols["__journal_ram_code_end"] - symbols["__journal_ram_code_start"]
        ),
        "FLASH512K_RAM_FUNCTION_RANGES": ram_function_ranges,
        "FLASH512K_SUPPORTED_ROM_FLASH_TYPES": [1, 2, 3],
    }
    for exported, symbol in ENTRY_SYMBOLS.items():
        constants[exported] = symbols[symbol] + 1
    for exported, symbol in CONFIG_SYMBOLS.items():
        constants[exported] = symbols[symbol]
    return constants


def validate_payload(payload: bytes, symbols: dict[str, int], constants: dict[str, object]) -> None:
    if len(payload) & 3:
        raise SystemExit(f"Payload size is not word-aligned: 0x{len(payload):x}")
    if payload.count(SIGNATURE) != 1 or not payload.endswith(SIGNATURE):
        raise SystemExit("512K FLASH marker must occur once and be the exact payload tail")
    if symbols["flash512k_signature"] != len(payload) - len(SIGNATURE):
        raise SystemExit("512K FLASH marker symbol does not describe the payload tail")
    if symbols["flash512k_signature"] & 3:
        raise SystemExit("512K FLASH marker is not word-aligned")

    # The seven-word header is an independently inspectable ABI table.  Its
    # entries must agree with the symbol-derived exports; the host itself uses
    # the exports and does not rely on compiler-specific hard-coded offsets.
    for index, (exported, symbol) in enumerate(ENTRY_SYMBOLS.items()):
        header_value = struct.unpack_from("<I", payload, index * 4)[0]
        expected = symbols[symbol] + 1
        if header_value != expected or header_value != constants[exported]:
            raise SystemExit(
                f"512K FLASH ABI header mismatch for {exported}: "
                f"0x{header_value:x} != 0x{expected:x}"
            )

    for name, value in constants.items():
        if name.endswith("_ENTRY"):
            if not isinstance(value, int) or not (value & 1):
                raise SystemExit(f"Thumb bit missing from {name}")
            if value >= len(payload):
                raise SystemExit(f"Entry outside payload: {name}=0x{value:x}")
        if name.endswith("_CONFIG_OFFSET"):
            if not isinstance(value, int) or value < 0 or value + 4 > len(payload) or value & 3:
                raise SystemExit(f"Invalid config offset: {name}={value!r}")

    defaults = {
        "FLASH512K_BASE_CONFIG_OFFSET": 0xFFFFFFFF,
        "FLASH512K_LOGICAL_SIZE_CONFIG_OFFSET": 0,
        "FLASH512K_LAYOUT_CONFIG_OFFSET": 0,
        "FLASH512K_COUNTDOWN_CONFIG_OFFSET": 100,
        "FLASH512K_INDICATOR_CONFIG_OFFSET": 0,
    }
    for name, expected in defaults.items():
        actual = struct.unpack_from("<I", payload, int(constants[name]))[0]
        if actual != expected:
            raise SystemExit(f"Unexpected default for {name}: {actual} != {expected}")


def embed(data_file: Path, payload: bytes, constants: dict[str, object]) -> None:
    text = data_file.read_text(encoding="utf-8") if data_file.exists() else default_data_text()
    constants_json = json.dumps(constants, separators=(",", ":"))
    payload_value = js_literal(payload.hex())
    payload_export = (
        f"export const FLASH512K_PAYLOAD_HEX ={payload_value};"
        if payload_value.startswith("\n") else
        f"export const FLASH512K_PAYLOAD_HEX = {payload_value};"
    )
    text, count = PAYLOAD_RE.subn(payload_export, text, count=1)
    if count != 1:
        raise SystemExit("Could not update FLASH512K_PAYLOAD_HEX")
    text, count = SIGNATURE_RE.subn(
        f'export const FLASH512K_SIGNATURE_HEX = "{SIGNATURE.hex()}";', text, count=1,
    )
    if count != 1:
        raise SystemExit("Could not update FLASH512K_SIGNATURE_HEX")
    text, count = CONSTANTS_RE.subn(
        f"export const FLASH512K_CONSTANTS = {constants_json};", text, count=1,
    )
    if count != 1:
        raise SystemExit("Could not update FLASH512K_CONSTANTS")
    data_file.parent.mkdir(parents=True, exist_ok=True)
    data_file.write_text(text, encoding="utf-8", newline="\n")


def main() -> int:
    args = parse_args()
    elf, binary = compile_payload(args.build_dir)
    payload = binary.read_bytes()
    symbols, _ = parse_symbols(elf)
    validate_ram_code(elf, symbols)
    constants = build_constants(payload, symbols)
    validate_payload(payload, symbols, constants)
    print(f"payload_len: 0x{len(payload):x}")
    print(f"ram_code: 0x{symbols['__journal_ram_code_start']:x}..0x{symbols['__journal_ram_code_end']:x}")
    print(f"signature_offset: 0x{symbols['flash512k_signature']:x}")
    if not args.no_embed:
        embed(args.data_file, payload, constants)
        print(f"updated: {args.data_file}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
