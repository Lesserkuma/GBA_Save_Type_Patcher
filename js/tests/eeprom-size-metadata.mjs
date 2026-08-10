// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";

import { writeU16, writeU32 } from "../core/binary.js";
import { patchFlash512kBytes } from "../patchers/flash512k.js";
import { DIRECT_SDK_HOOKS } from "../patchers/direct-abi-signatures.js";
import { readDirectFlashHeaderSaveSize } from "../patchers/patch-state.js";
import { detectEepromSize, detectRomSaveMetadata } from "../patchers/save-type.js";
import { PATCH_BY_SAVE_TYPE } from "../patchers/sram-data.js";

function fixture(...argumentsUsed) {
  const bytes = new Uint8Array(0x100000);
  const core = 0x102;
  const table = 0x500;
  writeU32(bytes, table, 512);
  writeU16(bytes, table + 4, 0x40);
  writeU16(bytes, table + 6, 0x300);
  bytes[table + 8] = 6;
  writeU32(bytes, table + 12, 8192);
  writeU16(bytes, table + 16, 0x400);
  writeU16(bytes, table + 18, 0x300);
  bytes[table + 20] = 14;

  const instructions = [
    0x0400, 0x0c00, 0x2200, 0x2804, 0xd107, 0x4808, 0x4908,
    0x6008, 0xe011, 0x7824, 0x0300, 0xa118, 0x0825, 0x2840,
    0xd107, 0x4803, 0x4903, 0x6008,
  ];
  instructions.forEach((instruction, index) => writeU16(bytes, core + index * 2, instruction));
  writeU32(bytes, core + 0x2c, 0x08000000 + table);
  writeU32(bytes, core + 0x30, 0x08000000 + table + 12);

  argumentsUsed.forEach((argument, index) => {
    const call = 0x40 + index * 8;
    writeU16(bytes, call - 2, 0x2000 | argument);
    const displacement = core - call - 4;
    writeU16(bytes, call, 0xf000 | ((displacement >> 12) & 0x7ff));
    writeU16(bytes, call + 2, 0xf800 | ((displacement >> 1) & 0x7ff));
  });
  return bytes;
}

function patchableV124(...argumentsUsed) {
  const bytes = fixture(...argumentsUsed);
  bytes[0xb2] = 0x96;
  bytes.set(new TextEncoder().encode("EEPROM_V124"), 0x800);
  PATCH_BY_SAVE_TYPE.EEPROM_V124.steps.forEach((step, index) => {
    const base = 0x1000 + index * 0x200;
    for (const [offset, value] of step.identifier.checks) bytes[base + offset] = value;
  });
  bytes.set(DIRECT_SDK_HOOKS.eepromRead.marker, 0x2000);
  return bytes;
}

assert.equal(detectEepromSize(fixture(4)), 512);
assert.equal(detectEepromSize(fixture(64)), 8192);
assert.equal(detectEepromSize(fixture(4, 64)), null);
assert.equal(detectEepromSize(new Uint8Array(64)), null);
assert.equal(detectEepromSize(new Uint8Array(64), "EEPROM_V110"), 512);
assert.equal(detectEepromSize(new Uint8Array(64), "EEPROM_V111"), 512);
assert.equal(detectRomSaveMetadata(new Uint8Array(64), "EEPROM_V110").size, 512);

for (const [argumentsUsed, expectedSize] of [
  [[4], 512],
  [[64], 8192],
  [[], 8192],
]) {
  const patched = patchFlash512kBytes(patchableV124(...argumentsUsed));
  assert.equal(patched.result.headerSaveSizeBytes, expectedSize);
  assert.equal(readDirectFlashHeaderSaveSize(patched.bytes), expectedSize);
}

const patchedRom = new Uint8Array(0xc0);
patchedRom[0xbe] = 0x4c;
patchedRom[0xbf] = 0x19;
assert.equal(readDirectFlashHeaderSaveSize(patchedRom), 512);
patchedRom[0xbf] = 0x1a;
assert.equal(readDirectFlashHeaderSaveSize(patchedRom), 8192);
patchedRom[0xbf] = 0x1c;
assert.equal(readDirectFlashHeaderSaveSize(patchedRom), 65536);
patchedRom[0xbf] = 0x11;
assert.equal(readDirectFlashHeaderSaveSize(patchedRom), null);
patchedRom[0xbe] = 0;
assert.equal(readDirectFlashHeaderSaveSize(patchedRom), null);

console.log("EEPROM fixed-size metadata analysis: ok");
