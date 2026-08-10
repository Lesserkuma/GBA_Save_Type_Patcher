// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import {
  exportDirectSramSave,
  inspectConvertedFlashSave,
  prepareDirectSave,
} from "../save-layouts/converted-flash.js";

const SRAM_SIZE = 0x8000;
const PHYSICAL_SIZE = 0x10000;

const canonical = Uint8Array.from(
  { length: SRAM_SIZE },
  (_, index) => ((index * 73) ^ (index >>> 5) ^ 0xa6) & 0xff,
);
const physical = prepareDirectSave(canonical, "sram");
assert.equal(physical.length, PHYSICAL_SIZE);
assert.equal(inspectConvertedFlashSave(physical).format, "direct-sram-sector-log-v16");
assert.deepEqual(exportDirectSramSave(physical), canonical);

const snapshotPrefixCollision = new Uint8Array(canonical);
snapshotPrefixCollision.set([0xbb, 0xac, 0xac, 0xcc, 0xfc, 0xad]);
const collisionImage = prepareDirectSave(snapshotPrefixCollision, "sram");
assert.equal(inspectConvertedFlashSave(collisionImage).format, "direct-sram-sector-log-v16");
assert.deepEqual(exportDirectSramSave(collisionImage), snapshotPrefixCollision);

const customReadback = new Uint8Array(0x20000).fill(0xa5);
customReadback.set(physical);
assert.equal(inspectConvertedFlashSave(customReadback).format, "direct-sram-sector-log-v16");
assert.deepEqual(exportDirectSramSave(customReadback), canonical);
const normalized = prepareDirectSave(customReadback, "sram");
assert.equal(normalized.length, PHYSICAL_SIZE);
assert.deepEqual(exportDirectSramSave(normalized), canonical);

const nativeCustomReadback = new Uint8Array(0x20000).fill(0x5a);
assert.equal(inspectConvertedFlashSave(nativeCustomReadback).format, "unknown");
assert.throws(
  () => prepareDirectSave(nativeCustomReadback, "sram"),
  /must use Direct SRAM v16/,
);

// Sector zero places its header before 63-byte per-block log slices. A
// committed RLE block may be followed at an odd address by ordinary deltas.
physical[0x8020] = (~0xbd) & 0xff;
physical[0x8021] = 0x81;
physical[0x8022] = (~0x33) & 0xff;
canonical.fill(0x33, 0, 0x40);
physical[0x8023] = 0xff;
physical[0x8024] = 5;
physical[0x8025] = (~0xa5) & 0xff;
physical[0x8026] = 17;
canonical[5] = 0;
canonical[17] = 0xa5;

// Logical sectors six and seven share the final physical log sector.
physical[0xe080] = (~0x3c) & 0xff;
physical[0xe081] = 0x23;
canonical[0x6123] = 0x3c;
physical[0xe880] = (~0x5a) & 0xff;
physical[0xe881] = 0x23;
canonical[0x7123] = 0x5a;
assert.deepEqual(exportDirectSramSave(physical), canonical);

// A hot v16 logical block may borrow an erased primary slice from the same
// sector. The primary marker makes the owner inventory overflow headers;
// cyclic slice order preserves append order without a game-specific table.
const overflow = new Uint8Array(physical);
const overflowBlock = 25;
const primary = 0xe800 + overflowBlock * 0x20;
const donor = primary + 0x20;
const logical = 0x7000 + overflowBlock * 0x40 + 0x12;
overflow[primary + 0x1e] = overflowBlock;
overflow[primary + 0x1f] = 0xc1;
overflow[donor] = overflowBlock;
overflow[donor + 1] = 0xc0;
overflow[donor + 2] = (~0x6d) & 0xff;
overflow[donor + 3] = 0x12;
canonical[logical] = 0x6d;
assert.deepEqual(exportDirectSramSave(overflow), canonical);

const malformedAddress = new Uint8Array(physical);
malformedAddress[0xe081] = 0x40;
assert.throws(() => exportDirectSramSave(malformedAddress), /sector-log address/);

const malformedRle = new Uint8Array(physical);
malformedRle[0x8020] = (~0xff) & 0xff;
assert.throws(() => exportDirectSramSave(malformedRle), /RLE output length/);

const dirtyScratch = new Uint8Array(physical);
dirtyScratch[0xf000] = 0;
assert.throws(() => exportDirectSramSave(dirtyScratch), /scratch range/);

const wrongVersion = new Uint8Array(physical);
wrongVersion[0x8004] ^= 1;
assert.equal(inspectConvertedFlashSave(wrongVersion).format, "unknown-converted-flash");
assert.throws(() => exportDirectSramSave(wrongVersion), RangeError);

assert.deepEqual(
  exportDirectSramSave(new Uint8Array(PHYSICAL_SIZE).fill(0xff)),
  new Uint8Array(SRAM_SIZE),
);
assert.deepEqual(
  exportDirectSramSave(new Uint8Array(0x20000).fill(0xff)),
  new Uint8Array(SRAM_SIZE),
);

console.log("direct SRAM sector-log v16 tests: PASS");
