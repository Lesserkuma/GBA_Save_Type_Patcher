// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";

import {
  exportDirectSramSave,
  inspectConvertedFlashSave,
  prepareDirectSave,
} from "../save-layouts/converted-flash.js";

const SLOT_SIZE = 0x8000;

function relocatedToSecondSlot(physical) {
  const relocated = new Uint8Array(physical.length).fill(0xff);
  relocated.set(physical.subarray(0, SLOT_SIZE), SLOT_SIZE);
  return relocated;
}

function deterministicNoise() {
  const bytes = new Uint8Array(SLOT_SIZE);
  let state = 0x6d2b79f5;
  for (let index = 16; index < bytes.length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[index] = state & 0xff;
  }
  return bytes;
}

for (const canonical of [
  new Uint8Array(SLOT_SIZE),
  Uint8Array.from({ length: SLOT_SIZE }, (_, index) => (
    index < 16 ? 0 : ((index >>> 7) ^ (index >>> 11)) & 0xff
  )),
  deterministicNoise(),
]) {
  const physical = prepareDirectSave(canonical, "sram", "direct-sram-snapshot-v3");
  assert.deepEqual(exportDirectSramSave(physical), canonical);
  assert.deepEqual(exportDirectSramSave(relocatedToSecondSlot(physical)), canonical);
  assert.equal(inspectConvertedFlashSave(physical).format, "direct-sram-snapshot-v3");

  const customReadback = new Uint8Array(0x20000).fill(0xa5);
  customReadback.set(physical);
  assert.equal(inspectConvertedFlashSave(customReadback).format, "direct-sram-snapshot-v3");
  assert.deepEqual(exportDirectSramSave(customReadback), canonical);
  const normalized = prepareDirectSave(customReadback, "sram", "direct-sram-snapshot-v3");
  assert.equal(normalized.length, SLOT_SIZE * 2);
  assert.deepEqual(exportDirectSramSave(normalized), canonical);
}

const unsafeRaw = deterministicNoise();
unsafeRaw[0] = 0x5a;
assert.throws(
  () => prepareDirectSave(unsafeRaw, "sram", "direct-sram-snapshot-v3"),
  /header span is not logically blank/,
);

const ambiguous = prepareDirectSave(
  new Uint8Array(SLOT_SIZE), "sram", "direct-sram-snapshot-v3",
);
ambiguous.set(ambiguous.subarray(0, SLOT_SIZE), SLOT_SIZE);
assert.throws(() => exportDirectSramSave(ambiguous), /ambiguous/);

const oversizedRle = prepareDirectSave(
  new Uint8Array(SLOT_SIZE), "sram", "direct-sram-snapshot-v3",
);
oversizedRle[6] = 0xf1;
oversizedRle[7] = 0x7f;
oversizedRle[8] = 0x0e;
oversizedRle[9] = 0x80;
assert.throws(() => exportDirectSramSave(oversizedRle), /snapshot lengths/);

console.log("Direct snapshot v3: ok");
