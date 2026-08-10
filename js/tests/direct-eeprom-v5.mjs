// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import {
  decodeDirectEepromSave,
  inspectConvertedFlashSave,
  prepareDirectSave,
} from "../save-layouts/converted-flash.js";

const HEADER = 0xc000;
const EEPROM_SIZE = 8192;

for (const inputSize of [512, EEPROM_SIZE]) {
  const canonical = Uint8Array.from(
    { length: inputSize },
    (_, index) => ((index * 73) ^ (index >>> 3) ^ 0xa6) & 0xff,
  );
  const expected = new Uint8Array(EEPROM_SIZE);
  expected.set(canonical);
  const physical = prepareDirectSave(canonical, "eeprom");
  assert.equal(physical[HEADER + 4], 5);
  assert.equal(physical[HEADER + 8] | (physical[HEADER + 9] << 8), EEPROM_SIZE);
  assert.deepEqual(inspectConvertedFlashSave(physical), {
    format: "direct-eeprom-delta-v5",
  });
  assert.deepEqual(decodeDirectEepromSave(physical), expected);

  const compacted = prepareDirectSave(physical, "eeprom");
  assert.equal(compacted[HEADER + 8] | (compacted[HEADER + 9] << 8), EEPROM_SIZE);
  assert.deepEqual(decodeDirectEepromSave(compacted), expected);

  const customReadback = new Uint8Array(0x20000).fill(0xa5);
  customReadback.set(physical);
  assert.deepEqual(inspectConvertedFlashSave(customReadback), {
    format: "direct-eeprom-delta-v5",
  });
  assert.deepEqual(decodeDirectEepromSave(customReadback), expected);
  const normalized = prepareDirectSave(customReadback, "eeprom");
  assert.equal(normalized.length, 0x10000);
  assert.deepEqual(decodeDirectEepromSave(normalized), expected);
}

const wrongVersion = prepareDirectSave(new Uint8Array(512), "eeprom");
wrongVersion[HEADER + 4] ^= 1;
assert.equal(inspectConvertedFlashSave(wrongVersion).format, "unknown-converted-flash");
assert.throws(() => decodeDirectEepromSave(wrongVersion), /unsupported Direct EEPROM/);

const wrongGeometry = prepareDirectSave(new Uint8Array(512), "eeprom");
wrongGeometry[HEADER + 8] = 0;
wrongGeometry[HEADER + 9] = 2;
assert.throws(() => decodeDirectEepromSave(wrongGeometry), /unsupported Direct EEPROM/);

const blank = new Uint8Array(0x10000).fill(0xff);
assert.deepEqual(decodeDirectEepromSave(blank), new Uint8Array(EEPROM_SIZE));
const initialized = prepareDirectSave(blank, "eeprom");
assert.equal(inspectConvertedFlashSave(initialized).format, "direct-eeprom-delta-v5");
assert.deepEqual(decodeDirectEepromSave(initialized), new Uint8Array(EEPROM_SIZE));

const ambiguousCustomReadback = new Uint8Array(0x20000).fill(0xff);
ambiguousCustomReadback[0] = 0;
ambiguousCustomReadback[0x10000] = 0;
assert.equal(inspectConvertedFlashSave(ambiguousCustomReadback).format, "unknown");
assert.throws(
  () => prepareDirectSave(ambiguousCustomReadback, "eeprom"),
  /must use Direct EEPROM v5/,
);

console.log("Direct EEPROM v5 fixed 8 KiB: ok");
