#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only AND MIT
"""Build and embed the common Direct 64 KiB Save-FLASH runtime."""

from __future__ import annotations

import argparse
import json
import re
import struct
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
DEFAULT_BUILD_DIR = ROOT / "build"

SRAM_ENTRY_SYMBOLS = {
    "DIRECT_WRITE_SRAM_ENTRY": "write_sram_patched",
    "DIRECT_WRITE_SRAM_CACHED_ENTRY": "write_sram_cached_patched",
    "DIRECT_WRITE_VERIFY_SRAM_ENTRY": "write_verify_sram_patched",
    "DIRECT_READ_SRAM_ENTRY": "read_sram_patched",
    "DIRECT_READ_SRAM_CACHED_ENTRY": "read_sram_cached_patched",
    "DIRECT_READ_SRAM_TRIPLET_ENTRY": "read_sram_triplet_patched",
    "DIRECT_READ_SRAM_TRIPLET_CACHED_ENTRY": "read_sram_triplet_cached_patched",
    "DIRECT_VERIFY_SRAM_ENTRY": "verify_sram_patched",
    "DIRECT_VERIFY_SRAM_CACHED_ENTRY": "verify_sram_cached_patched",
    "DIRECT_VERIFY_SRAM_FAST_ENTRY": "verify_sram_fast_patched",
}
EEPROM_ENTRY_SYMBOLS = {
    "DIRECT_WRITE_EEPROM_ENTRY": "write_eeprom_patched",
    "DIRECT_WRITE_EEPROM_SETTLED_ENTRY": "write_eeprom_settled_patched",
    "DIRECT_READ_EEPROM_ENTRY": "read_eeprom_patched",
    "DIRECT_VERIFY_EEPROM_ENTRY": "verify_eeprom_patched",
}
CONFIG_SYMBOLS = {
    "DIRECT_LAYOUT_CONFIG_OFFSET": "direct_layout_config",
    "DIRECT_SAVE_PROTOCOL_CONFIG_OFFSET": "direct_save_protocol_config",
}
SNAPSHOT_CONFIG_SYMBOLS = {
    "DIRECT_SNAPSHOT_PROVIDER_COUNT_CONFIG_OFFSET": "direct_snapshot_provider_count_config",
    "DIRECT_SNAPSHOT_COMMIT_FIRST_CONFIG_OFFSET": "direct_snapshot_commit_first_config",
    "DIRECT_SNAPSHOT_COMMIT_SIZE_CONFIG_OFFSET": "direct_snapshot_commit_size_config",
    "DIRECT_SNAPSHOT_TRANSIENT_COUNT_CONFIG_OFFSET": "direct_snapshot_transient_count_config",
    "DIRECT_SNAPSHOT_PROVIDERS_CONFIG_OFFSET": "direct_snapshot_providers_config",
    "DIRECT_SNAPSHOT_TRANSIENT_RANGES_CONFIG_OFFSET": "direct_snapshot_transient_ranges_config",
}
FLASH_READER_THUMB_CODE = 0x47707800
FLASH_READER_LITERAL_COUNT = 1
FLASH_RANGE_READER_CODE = bytes.fromhex("002a05d003780b7001300131013af9d17047")
SRAM_BLANK_ZERO_READER_CODE = bytes.fromhex(
    "0078ff280cd1002008700131013a06d018780020087001330131013af8d1c04370470000"
)
SRAM_COMPARE_INVERTED_CODE = bytes.fromhex(
    "30b4ff25002a08d003780c786b40a34206d101300131013af6d1012030bc7047"
    "002030bc7047"
)
MAX_STATIC_STACK_USAGE = 512
SNAPSHOT_STACK_PATHS = (
    ("write_sram_cached_patched", "write_sram_result", "snapshot_commit",
     "snapshot_encode_segments", "snapshot_encode_bytes"),
    ("write_verify_sram_patched", "write_sram_result", "snapshot_commit",
     "snapshot_encode_segments", "snapshot_encode_bytes"),
    ("write_sram_cached_patched", "write_sram_result", "snapshot_commit",
     "snapshot_write_raw_segments"),
    ("write_verify_sram_patched", "write_sram_result", "snapshot_commit",
     "snapshot_write_raw_segments"),
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--build-dir", type=Path, default=DEFAULT_BUILD_DIR)
    parser.add_argument("--data-file", type=Path)
    parser.add_argument("--snapshot-data-file", type=Path)
    parser.add_argument("--transaction-data-file", type=Path)
    parser.add_argument("--no-embed", action="store_true")
    return parser.parse_args()


def run(command: list[str]) -> str:
    print("+", " ".join(command))
    completed = subprocess.run(
        command,
        check=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    if completed.stdout:
        print(completed.stdout, end="")
    if completed.returncode:
        raise SystemExit(completed.returncode)
    return completed.stdout


def build(build_dir: Path, *, snapshot: bool = False,
          transaction: bool = False) -> tuple[Path, bytes]:
    if snapshot and transaction:
        raise ValueError("snapshot and transaction builds are mutually exclusive")
    shape = "sram-snapshot" if snapshot else ("sram-transaction" if transaction else "base")
    shape_dir = build_dir / shape
    shape_dir.mkdir(parents=True, exist_ok=True)
    elf = shape_dir / "payload.elf"
    binary = shape_dir / "payload.bin"
    gcc = find_tool("arm-none-eabi-gcc")
    objcopy = find_tool("arm-none-eabi-objcopy")
    command = [
        str(gcc),
        "-mcpu=arm7tdmi",
        "-mthumb",
        "-mthumb-interwork",
        "-nostartfiles",
        "-nodefaultlibs",
        "-fPIE",
        "-Os",
        "-std=gnu11",
        "-ffreestanding",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-Wframe-larger-than=512",
        "-fno-builtin",
        "-fno-jump-tables",
        "-fvisibility=hidden",
        "-fno-semantic-interposition",
        "-fno-unwind-tables",
        "-fno-asynchronous-unwind-tables",
        "-fstack-usage",
        "-Wl,--build-id=none",
        f"-Wl,-Map={shape_dir / 'payload.map'}",
    ]
    if snapshot:
        command.append("-DDIRECT_SNAPSHOT_BUILD=1")
    if transaction:
        command.append("-DDIRECT_SRAM_TRANSACTION_BUILD=1")
    if snapshot or transaction:
        command.append("-DDIRECT_SRAM_ONLY_BUILD=1")
    command.extend((str(ROOT / "payload.c"), "-T", str(ROOT / "payload.ld"), "-o", str(elf)))
    run(command)
    run([str(objcopy), "-O", "binary", str(elf), str(binary)])
    return elf, binary.read_bytes()


def symbols(elf: Path, *, snapshot: bool = False,
            transaction: bool = False) -> dict[str, int]:
    nm = find_tool("arm-none-eabi-nm")
    output = run([str(nm), "-n", str(elf)])
    undefined = [line.split()[-1] for line in output.splitlines()
                 if len(line.split()) == 2 and line.split()[0] == "U"]
    if undefined:
        raise SystemExit(f"Direct payload has undefined symbols: {undefined}")
    sram_only = snapshot or transaction
    entries = SRAM_ENTRY_SYMBOLS if sram_only else {
        **SRAM_ENTRY_SYMBOLS,
        **EEPROM_ENTRY_SYMBOLS,
    }
    symbol_names = {
        fields[-1]
        for line in output.splitlines()
        if len((fields := line.split())) >= 3
    }
    if sram_only:
        leaked = sorted(name for name in symbol_names if "eeprom" in name.lower())
        if leaked:
            raise SystemExit(
                f"SRAM-only Direct payload contains EEPROM symbols: {leaked}"
            )
    wanted = (set(entries.values()) | set(CONFIG_SYMBOLS.values())
              | {"direct_signature", "flash_read_range_template",
                 "flash_read_range_template_end",
                 "sram_blank_zero_template",
                 "sram_blank_zero_template_end"})
    if snapshot:
        wanted |= set(SNAPSHOT_CONFIG_SYMBOLS.values())
    if transaction:
        wanted |= {"sram_compare_inverted_template",
                   "sram_compare_inverted_template_end"}
    result: dict[str, int] = {}
    for line in output.splitlines():
        fields = line.split()
        if len(fields) >= 3 and fields[-1] in wanted:
            result[fields[-1]] = int(fields[0], 16)
    missing = wanted - result.keys()
    if missing:
        raise SystemExit(f"Missing Direct ABI symbols: {sorted(missing)}")
    return result


def validate(payload: bytes, table: dict[str, int], signature: bytes,
             *, snapshot: bool = False, transaction: bool = False) -> None:
    if len(payload) > 0x40000 or len(payload) % 4:
        raise SystemExit("Direct payload violates its 256 KiB aligned block contract")
    if payload.count(signature) != 1 or table["direct_signature"] != len(payload) - len(signature):
        raise SystemExit("Direct payload signature is not unique at the binary tail")
    expected_defaults = {
        "direct_layout_config": 0xFFFFFFFF,
        "direct_save_protocol_config": 0,
    }
    if snapshot:
        expected_defaults.update({name: 0 for name in SNAPSHOT_CONFIG_SYMBOLS.values()})
    for name, expected in expected_defaults.items():
        offset = table[name]
        if offset % 4 or struct.unpack_from("<I", payload, offset)[0] != expected:
            raise SystemExit(f"Invalid Direct config field: {name}")
    entries = SRAM_ENTRY_SYMBOLS if snapshot or transaction else {
        **SRAM_ENTRY_SYMBOLS,
        **EEPROM_ENTRY_SYMBOLS,
    }
    for name in entries.values():
        offset = table[name]
        if offset >= len(payload) or offset & 1:
            raise SystemExit(f"Invalid Direct Thumb entry: {name}=0x{offset:x}")
    if struct.pack("<I", 0x08000000) in payload:
        raise SystemExit("Direct payload unexpectedly embeds the ROM-FLASH base address")
    reader_code = struct.pack("<I", FLASH_READER_THUMB_CODE)
    if payload.count(reader_code) != FLASH_READER_LITERAL_COUNT:
        raise SystemExit("Direct payload does not contain the required WRAM byte reader")
    if payload.count(FLASH_RANGE_READER_CODE) != 1:
        raise SystemExit("Direct payload does not contain the required WRAM range reader")
    template_first = table["flash_read_range_template"]
    template_end = table["flash_read_range_template_end"]
    if (template_end - template_first != len(FLASH_RANGE_READER_CODE)
            or payload[template_first:template_end] != FLASH_RANGE_READER_CODE):
        raise SystemExit("Direct WRAM range-reader symbol span does not match its template")
    blank_first = table["sram_blank_zero_template"]
    blank_end = table["sram_blank_zero_template_end"]
    if (blank_end - blank_first != len(SRAM_BLANK_ZERO_READER_CODE)
            or payload[blank_first:blank_end] != SRAM_BLANK_ZERO_READER_CODE):
        raise SystemExit(
            "Direct WRAM blank-zero reader symbol span does not match its template"
        )
    if transaction:
        compare_first = table["sram_compare_inverted_template"]
        compare_end = table["sram_compare_inverted_template_end"]
        if (compare_end - compare_first != len(SRAM_COMPARE_INVERTED_CODE)
                or payload[compare_first:compare_end]
                    != SRAM_COMPARE_INVERTED_CODE):
            raise SystemExit(
                "Direct WRAM inverted-compare symbol span does not match its template"
            )


def validate_stack_usage(elf: Path, *, snapshot: bool = False) -> None:
    usage_file = elf.with_name(f"{elf.name}-payload.su")
    if not usage_file.exists():
        raise SystemExit("Direct payload stack-usage report is missing")
    offenders: list[str] = []
    usage_by_symbol: dict[str, int] = {}
    for line in usage_file.read_text(encoding="utf-8").splitlines():
        fields = line.split("\t")
        if len(fields) < 2:
            continue
        try:
            usage = int(fields[1])
        except ValueError:
            continue
        symbol = fields[0].rsplit(":", 1)[-1]
        symbol = re.sub(
            r"\.(?:constprop|isra|part)(?:\.\d+)?$", "", symbol,
        )
        usage_by_symbol[symbol] = max(usage_by_symbol.get(symbol, 0), usage)
        if usage > MAX_STATIC_STACK_USAGE:
            offenders.append(f"{fields[0]} ({usage} bytes)")
    if snapshot:
        for path in SNAPSHOT_STACK_PATHS:
            missing = [symbol for symbol in path if symbol not in usage_by_symbol]
            if missing:
                offenders.append(
                    f"snapshot path {' -> '.join(path)} misses {missing}"
                )
                continue
            cumulative = sum(usage_by_symbol[symbol] for symbol in path)
            if cumulative > MAX_STATIC_STACK_USAGE:
                offenders.append(
                    f"snapshot path {' -> '.join(path)} ({cumulative} bytes)"
                )
    if offenders:
        raise SystemExit("Direct payload stack budget exceeds 512 bytes: "
                         + ", ".join(offenders))


def validate_relocations(elf: Path) -> None:
    objdump = find_tool("arm-none-eabi-objdump")
    output = run([str(objdump), "-r", str(elf)])
    if "R_ARM_" in output:
        raise SystemExit("Direct payload contains unresolved runtime relocations")


def hex_export(payload: bytes) -> str:
    chunks = [payload.hex()[index:index + 128] for index in range(0, len(payload.hex()), 128)]
    if len(chunks) == 1:
        return f'export const FLASH_DIRECT_PAYLOAD_HEX = "{chunks[0]}";'
    lines = [f'export const FLASH_DIRECT_PAYLOAD_HEX =\n  "{chunks[0]}" +']
    for chunk in chunks[1:-1]:
        lines.append(f'  "{chunk}" +')
    lines.append(f'  "{chunks[-1]}";')
    return "\n".join(lines)


def embed(data_file: Path, payload: bytes, table: dict[str, int],
          signature: bytes, *, snapshot: bool = False,
          transaction: bool = False) -> None:
    sram_only = snapshot or transaction
    entries = SRAM_ENTRY_SYMBOLS if sram_only else {
        **SRAM_ENTRY_SYMBOLS,
        **EEPROM_ENTRY_SYMBOLS,
    }
    constants = {
        "GBA_ROM_BASE": 0x08000000,
        "FLASH_DIRECT_PAYLOAD_SIZE": len(payload),
        "FLASH_DIRECT_SIGNATURE_OFFSET": table["direct_signature"],
        "DIRECT_LAYOUT_SRAM": 0,
        "DIRECT_PROTOCOL_STANDARD": 0,
        "DIRECT_PROTOCOL_CUSTOM_TYPE_1": 1,
        "DIRECT_PROTOCOL_CUSTOM_TYPE_2": 2,
    }
    if not sram_only:
        constants.update({
            "DIRECT_LAYOUT_EEPROM": 1,
            "EEPROM_LOGICAL_SIZE": 0x2000,
        })
    if snapshot:
        constants.update({
            "DIRECT_SNAPSHOT_PROVIDER_MAX": 128,
            "DIRECT_SNAPSHOT_TRANSIENT_MAX": 8,
        })
    constants.update({name: table[symbol] + 1 for name, symbol in entries.items()})
    constants.update({name: table[symbol] for name, symbol in CONFIG_SYMBOLS.items()})
    if snapshot:
        constants.update({name: table[symbol] for name, symbol in SNAPSHOT_CONFIG_SYMBOLS.items()})
    banner = generated_js_banner(
        generator="payloads/flash-direct/compile_payload.py",
        source_hash=source_sha256([
            ROOT / "payload.c", ROOT / "payload.ld", ROOT / "compile_payload.py",
            ROOT / "build_support.py", ROOT.parent / "common" / "gba_hw.h",
        ]),
        binary_hash=sha256_bytes(payload),
        license_expression="GPL-3.0-only AND MIT",
    )
    text = "\n".join((
        banner.rstrip(),
        hex_export(payload),
        f'export const FLASH_DIRECT_SIGNATURE_HEX = "{signature.hex()}";',
        f"export const FLASH_DIRECT_CONSTANTS = {json.dumps(constants, sort_keys=True, separators=(',', ':'))};",
        "",
    ))
    write_text(data_file, text)


def main() -> int:
    args = parse_args()
    signature = b"lk_flash_direct_v17\0"
    data_file = args.data_file or PROJECT_ROOT / "js" / "patchers" / "flash-direct-data.js"
    snapshot_data_file = args.snapshot_data_file or (
        args.data_file.with_name(f"{args.data_file.stem}-snapshot{args.data_file.suffix}")
        if args.data_file
        else PROJECT_ROOT / "js" / "patchers" / "flash-direct-snapshot-data.js"
    )
    transaction_data_file = args.transaction_data_file or (
        args.data_file.with_name(f"{args.data_file.stem}-transaction{args.data_file.suffix}")
        if args.data_file
        else PROJECT_ROOT / "js" / "patchers" / "flash-direct-transaction-data.js"
    )
    elf, payload = build(args.build_dir)
    table = symbols(elf)
    validate(payload, table, signature)
    validate_stack_usage(elf)
    validate_relocations(elf)
    snapshot_elf, snapshot_payload = build(args.build_dir, snapshot=True)
    snapshot_table = symbols(snapshot_elf, snapshot=True)
    validate(snapshot_payload, snapshot_table, signature, snapshot=True)
    validate_stack_usage(snapshot_elf, snapshot=True)
    validate_relocations(snapshot_elf)
    transaction_elf, transaction_payload = build(
        args.build_dir, transaction=True,
    )
    transaction_table = symbols(transaction_elf, transaction=True)
    validate(transaction_payload, transaction_table, signature,
             transaction=True)
    validate_stack_usage(transaction_elf)
    validate_relocations(transaction_elf)
    if not args.no_embed:
        embed(data_file, payload, table, signature)
        embed(snapshot_data_file, snapshot_payload, snapshot_table,
              signature, snapshot=True)
        embed(transaction_data_file, transaction_payload,
              transaction_table, signature, transaction=True)
        print(f"Embedded {len(payload)} bytes in {data_file}")
        print(f"Embedded {len(snapshot_payload)} bytes in {snapshot_data_file}")
        print(f"Embedded {len(transaction_payload)} bytes in {transaction_data_file}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
