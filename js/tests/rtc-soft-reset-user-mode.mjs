// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";

import { IRQ_HANDLER_CONSTANTS, IRQ_HANDLER_PAYLOAD_HEX } from "../patchers/irq-handler-data.js";
import { RTC_PAYLOAD_CONSTANTS, RTC_PAYLOAD_HEX } from "../patchers/rtc-data.js";

function payloadBytes(hex) {
  assert.equal(hex.length % 2, 0);
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function readU32(bytes, offset) {
  assert.ok(offset >= 0 && offset + 4 <= bytes.length);
  return (
    bytes[offset]
    | (bytes[offset + 1] << 8)
    | (bytes[offset + 2] << 16)
    | (bytes[offset + 3] << 24)
  ) >>> 0;
}

function readU16(bytes, offset) {
  assert.ok(offset >= 0 && offset + 2 <= bytes.length);
  return bytes[offset] | (bytes[offset + 1] << 8);
}

const bytes = payloadBytes(RTC_PAYLOAD_HEX);
const base = RTC_PAYLOAD_CONSTANTS.RTC_ORIGINAL_PAYLOAD_LINK_ADDR;
const symbols = RTC_PAYLOAD_CONSTANTS.RTC_ORIGINAL_PAYLOAD_SYMBOLS;
const offsetOf = (name) => {
  assert.ok(Number.isInteger(symbols[name]), `missing payload symbol: ${name}`);
  const offset = symbols[name] - base;
  assert.ok(offset >= 0 && offset < bytes.length, `${name} is outside the payload`);
  return offset;
};

const probe = offsetOf("payload_probe");
const userSnapshot = offsetOf("rtc_user_snapshot");
const irqSnapshot = offsetOf("rtc_user_snapshot_irq");
const privilegedSnapshot = offsetOf("rtc_snapshot_privileged");
const runtimeMenu = offsetOf("fake_rtc_menu_run_runtime");
const backupScratch = offsetOf("select_runtime_backup_scratch");
const backupVisualState = offsetOf("runtime_backup_visual_state");

// Probe must identify User mode before attempting any banked-register access.
assert.equal(readU32(bytes, probe + 4), 0xe10f3000); // mrs r3, cpsr
assert.equal(readU32(bytes, probe + 8), 0xe203201f); // and r2, r3, #0x1f
assert.equal(readU32(bytes, probe + 12), 0xe3520010); // cmp r2, #User
assert.equal(readU32(bytes, probe + 0x3c), 0xe3a02097); // enter masked Abort mode
assert.equal(readU32(bytes, probe + 0x44), 0xe1a0200e); // read Abort LR sentinel

// The bridge owns a temporary stack frame, redirects only the private original
// handler slot, and keeps the interrupted game's User/System mode untouched.
assert.equal(readU32(bytes, userSnapshot), 0xe92d40f0); // push r4-r7, lr
assert.equal(readU32(bytes, userSnapshot + 0x80), 0x03007ff4);
assert.equal(readU32(bytes, userSnapshot + 0x84), base + irqSnapshot);

// The IRQ stub delegates the actual banked-register read to the shared helper.
assert.equal(readU32(bytes, irqSnapshot), 0xe92d5010); // push r4, r12, lr
assert.equal(readU32(bytes, irqSnapshot + 0x34), base + privilegedSnapshot);
assert.equal(readU32(bytes, privilegedSnapshot), 0xe10fc000); // preserve CPSR in r12
assert.equal(readU32(bytes, privilegedSnapshot + 4), 0xe3a0209b); // enter Undefined
assert.equal(readU32(bytes, privilegedSnapshot + 0x24), 0xe3a02097); // phase in Abort SP
assert.equal(readU32(bytes, privilegedSnapshot + 0x58), 0xe3a0109b); // timestamp in Undefined LR
assert.equal(readU32(bytes, privilegedSnapshot + 0x74), 0xe3a02097); // sentinel in Abort LR

// The runtime menu used to put the complete palette/OAM backup on the
// interrupted game's IWRAM stack. Keep that frame small and place the 684-byte
// transient visual backup in a zeroed EWRAM span instead.
assert.equal(readU16(bytes, runtimeMenu), 0xb5f0); // push r4-r7, lr
const stackAllocation = readU16(bytes, runtimeMenu + 4);
assert.equal(stackAllocation & 0xff80, 0xb080); // Thumb SUB SP, #imm
const runtimeStackBytes = 20 + (stackAllocation & 0x7f) * 4; // saved r4-r7/lr + locals
assert.ok(runtimeStackBytes <= 48, "runtime menu stack usage regressed");

assert.equal(readU16(bytes, backupScratch), 0x2200); // zero-run length = 0
assert.equal(readU16(bytes, backupScratch + 0x12), 0x2aab); // require 171 words
assert.equal(readU32(bytes, backupScratch + 0x28), 0x0203fffc); // EWRAM top word
assert.equal(readU32(bytes, backupScratch + 0x2c), 0x01fffffc); // loop lower bound
assert.equal(readU32(bytes, backupVisualState + 0x1c), 0x05000200); // OBJ palette source

const irqBytes = payloadBytes(IRQ_HANDLER_PAYLOAD_HEX);
const continuous = IRQ_HANDLER_CONSTANTS.IRQ_HANDLER_CONTINUOUS_OFFSET;
assert.equal(readU32(irqBytes, continuous + 0x6c), 0xe3a01097); // enter masked Abort
assert.equal(readU32(irqBytes, continuous + 0x78), 0xe15e0002); // cmp Abort LR, magic

console.log("fake RTC soft-reset bridge and runtime stack tests: PASS");
