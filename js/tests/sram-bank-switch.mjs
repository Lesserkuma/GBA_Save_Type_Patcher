// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";

import { patchSramBytes } from "../patchers/sram.js";
import {
  FLASH1M_BANK_SWITCH_MODERN_PATCH_HEX,
  PATCH_BY_SAVE_TYPE,
} from "../patchers/sram-data.js";

const modernPatch = Buffer.from(FLASH1M_BANK_SWITCH_MODERN_PATCH_HEX, "hex");
const switchMarker = Buffer.from(
  PATCH_BY_SAVE_TYPE.FLASH1M_V103.steps[0].identifier.marker,
  "hex",
);

// The 24-byte SDK routine prepares the mapper address, copies its eight-byte
// write/settling/return tail to the stack, restores SP, and enters that even
// RAM address without changing the current Thumb state. LR remains untouched,
// so the RAM tail's BX LR interworks back to either an ARM caller (bit 0 clear)
// or a Thumb caller (bit 0 set).
assert.equal(modernPatch.length, 24);
assert.equal(modernPatch.readUInt16LE(0), 0xa103); // adr r1, RAM tail
assert.equal(modernPatch.readUInt16LE(2), 0xc90c); // ldmia r1!, {r2, r3}
assert.equal(modernPatch.readUInt16LE(4), 0xb40c); // push {r2, r3}
assert.equal(modernPatch.readUInt16LE(6), 0x2290); // mov r2, #0x90
assert.equal(modernPatch.readUInt16LE(8), 0x0512); // lsl r2, #20
assert.equal(modernPatch.readUInt16LE(10), 0x4669); // mov r1, sp
assert.equal(modernPatch.readUInt16LE(12), 0xb002); // add sp, #8
// MOV pc keeps the current Thumb state for the even, word-aligned stack
// address. BX would interpret its clear bit 0 as an ARM-state target.
assert.equal(modernPatch.readUInt16LE(14), 0x468f); // mov pc, r1
assert.equal(modernPatch.readUInt16LE(16), 0x7010); // RAM: strb r0, [r2]
assert.equal(modernPatch.readUInt16LE(18), 0x46c0); // RAM: nop
assert.equal(modernPatch.readUInt16LE(20), 0x46c0); // RAM: nop
assert.equal(modernPatch.readUInt16LE(22), 0x4770); // RAM: bx lr

const returnState = (lr) => (lr & 1 ? "thumb" : "arm");
assert.equal(returnState(0x08001234), "arm");
assert.equal(returnState(0x08001235), "thumb");

const markerOffset = 0x100;
const input = new Uint8Array(0x400).fill(0xff);
input.set(switchMarker, markerOffset);
const patched = patchSramBytes(input, {
  saveTypeOverride: "FLASH1M_V103",
  flash1mBankSwitchStyle: "modern",
});

assert.equal(patched.result.savePatch.status, "patched");
assert.deepEqual(
  Buffer.from(patched.bytes.slice(markerOffset, markerOffset + modernPatch.length)),
  modernPatch,
);

console.log("SRAM FLASH1M RAM bank-switch tests: PASS");
