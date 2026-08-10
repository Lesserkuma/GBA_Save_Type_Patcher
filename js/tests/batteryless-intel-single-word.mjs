import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  BATTERYLESS_PAYLOAD_HEX,
  SRAM_CONSTANTS,
} from "../patchers/sram-data.js";
import { validatePayloadArtifacts } from "../generated/validate-payloads.js";

await validatePayloadArtifacts();

const payload = Uint8Array.from(
  BATTERYLESS_PAYLOAD_HEX.match(/../g).map((value) => Number.parseInt(value, 16)),
);
const ranges = SRAM_CONSTANTS.BATTERYLESS_RAM_FUNCTION_RANGES;

function encodeU32(value) {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24];
}

function tableBytes(names) {
  return Uint8Array.from(names.flatMap((name) => {
    const range = ranges[name];
    assert.ok(range, `missing RAM driver range: ${name}`);
    assert.ok(range.size <= SRAM_CONSTANTS.ROM_WORKSPACE_EXEC_SIZE, `${name} exceeds RAM slot`);
    return [...encodeU32(range.start + 1), ...encodeU32(range.end)];
  }));
}

function findSequence(haystack, needle) {
  for (let offset = 0; offset + needle.length <= haystack.length; offset += 1) {
    if (needle.every((value, index) => haystack[offset + index] === value)) return offset;
  }
  return -1;
}

const intelTable = tableBytes([
  "identify_flash_1",
  "erase_flash_1",
  "program_flash_1",
  "verify_flash",
]);
assert.ok(findSequence(payload, intelTable) >= 0, "Intel single-word driver is absent from dispatch table");

for (const [name, range] of Object.entries(ranges)) {
  assert.ok(range.size <= SRAM_CONSTANTS.ROM_WORKSPACE_EXEC_SIZE, `${name} exceeds RAM slot`);
  assert.ok(!/m36|buffer/i.test(name), `device-specific or buffered driver leaked into ranges: ${name}`);
}

const source = readFileSync(
  new URL("../../payloads/batteryless-sram/payload.c", import.meta.url),
  "utf8",
);
assert.doesNotMatch(source, /m36|0x88C40020|0x88C60020|0x880F008A|0x88C50020/i);

const identifySource = source.slice(
  source.indexOf("int identify_flash_1"),
  source.indexOf('asm("identify_flash_1_end:")'),
);
assert.ok(
  identifySource.indexOf("sram_bank_select(0)") < identifySource.indexOf("_FLASH_WRITE(0, 0x50)"),
  "SRAM mapper bank must be normalized before the Intel probe",
);

const programSource = source.slice(
  source.indexOf("int program_flash_1"),
  source.indexOf('asm("program_flash_1_end:")'),
);
for (const operation of [
  "0x40",
  "0x50",
  "0x70",
  "status & 0x80",
  "status != 0x80",
  "address/2",
]) {
  assert.ok(programSource.includes(operation), `missing hardened single-word operation: ${operation}`);
}
assert.doesNotMatch(programSource, /0xE8|buffer/i, "Intel Type 1 must remain single-word only");
assert.ok(
  programSource.indexOf("_FLASH_WRITE(address - 2, 0xFF)")
    < programSource.indexOf("sram_bank_select(1)"),
  "flash must return to array mode before switching the SRAM bank",
);

console.log("batteryless Intel single-word flash tests: PASS");
