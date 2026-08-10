#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Generate the executable browser payload inventory."""

from __future__ import annotations

import hashlib
import re

from build_support import PROJECT_ROOT, write_text


OUTPUT = PROJECT_ROOT / "js" / "generated" / "payload-manifests.js"
ARTIFACTS = (
    ("batterylessSram", "batteryless-sram", "GPL-3.0-or-later AND MIT", "js/patchers/sram-data.js", "BATTERYLESS_PAYLOAD_HEX"),
    ("batterylessSramGbata", "batteryless-sram-gbata", "GPL-3.0-or-later AND MIT", "js/patchers/sram-data.js", "BATTERYLESS_PAYLOAD_GBATA_HEX"),
    ("flashDirect", "flash-direct", "GPL-3.0-only AND MIT", "js/patchers/flash-direct-data.js", "FLASH_DIRECT_PAYLOAD_HEX"),
    ("flashDirectSnapshot", "flash-direct-snapshot", "GPL-3.0-only AND MIT", "js/patchers/flash-direct-snapshot-data.js", "FLASH_DIRECT_PAYLOAD_HEX"),
    ("flashDirectTransaction", "flash-direct-transaction", "GPL-3.0-only AND MIT", "js/patchers/flash-direct-transaction-data.js", "FLASH_DIRECT_PAYLOAD_HEX"),
    ("eepromV120Wrapper", "eeprom-v120-wrapper", "GPL-3.0-or-later AND MIT", "js/patchers/eeprom-v120-wrapper-data.js", "EEPROM_V120_RUNTIME_WRAPPER_HEX"),
    ("fakeRtc", "fake-rtc", "GPL-3.0-or-later AND MIT", "js/patchers/rtc-data.js", "RTC_PAYLOAD_HEX"),
    ("sharedIrq", "shared-irq", "GPL-3.0-or-later", "js/patchers/irq-handler-data.js", "IRQ_HANDLER_PAYLOAD_HEX"),
)


def exported_hex(relative_path: str, name: str) -> bytes:
    source = (PROJECT_ROOT / relative_path).read_text(encoding="utf-8")
    match = re.search(rf"export const {re.escape(name)}\s*=\s*(.*?);", source, re.DOTALL)
    if not match:
        raise SystemExit(f"Missing {name} in {relative_path}")
    return bytes.fromhex("".join(re.findall(r'"([0-9a-fA-F]+)"', match.group(1))))


def main() -> None:
    lines = [
        "// Generated file. Do not edit.",
        "// Generator: payloads/flash-direct/generate_manifests.py",
        "// Generator version: 1",
        "// SPDX-License-Identifier: GPL-3.0-or-later",
        "",
        "export const PAYLOAD_MANIFESTS = Object.freeze({",
    ]
    for key, payload_id, license_expression, path, export_name in ARTIFACTS:
        payload = exported_hex(path, export_name)
        lines.extend((
            f"  {key}: Object.freeze({{",
            "    schemaVersion: 3,",
            f'    payloadId: "{payload_id}",',
            f'    licenseExpression: "{license_expression}",',
            f'    binarySha256: "{hashlib.sha256(payload).hexdigest()}",',
            f"    size: {len(payload)},",
            "  }),",
        ))
    lines.extend(("});", ""))
    write_text(OUTPUT, "\n".join(lines))


if __name__ == "__main__":
    main()
