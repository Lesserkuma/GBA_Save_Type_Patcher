// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";

import { applyIrqHandlerForPipeline } from "../patchers/irq-handler.js";

const GBA_ROM_BASE = 0x08000000;

function writeU16(bytes, offset, value) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
}

function writeU32(bytes, offset, value) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

function readU32(bytes, offset) {
  return (
    bytes[offset]
    | (bytes[offset + 1] << 8)
    | (bytes[offset + 2] << 16)
    | (bytes[offset + 3] << 24)
  ) >>> 0;
}

function armBranch(fromOffset, toOffset) {
  const displacement = (toOffset - fromOffset - 8) >> 2;
  return (0xea000000 | (displacement & 0x00ffffff)) >>> 0;
}

function writeArmStartupInstaller(bytes, base, mainAddress) {
  // A compact synthetic version of the proven SDK handoff recognized by the
  // shared IRQ planner. The stack is established before the handler store.
  writeU32(bytes, base + 0x10, 0xe59fd020); // ldr sp, [pc, #0x20]
  writeU32(bytes, base + 0x14, 0xe3a02000); // mov r2, #0
  writeU32(bytes, base + 0x18, 0xe3a03000); // mov r3, #0
  writeU32(bytes, base + 0x1c, 0xe59f101c); // ldr r1, =03007FFC
  writeU32(bytes, base + 0x20, 0xe28f0020); // add r0, pc, #0x20 (handler)
  writeU32(bytes, base + 0x24, 0xe5810000); // str r0, [r1]
  writeU32(bytes, base + 0x28, 0xe59f1014); // ldr r1, =main
  writeU32(bytes, base + 0x2c, 0xe1a0e00f); // mov lr, pc
  writeU32(bytes, base + 0x30, 0xe12fff11); // bx r1
  writeU32(bytes, base + 0x38, 0x03007f00); // aligned IWRAM stack
  writeU32(bytes, base + 0x40, 0x03007ffc); // user IRQ slot
  writeU32(bytes, base + 0x44, mainAddress);
}

const input = new Uint8Array(0x6000).fill(0xff);
const activeStartupBase = 0x200;
const inactiveStartupBase = 0x2000;
const mainOffset = 0x680;
const callbackOffset = 0x3000;

writeU32(input, 0, armBranch(0, activeStartupBase + 4));
writeArmStartupInstaller(input, activeStartupBase, GBA_ROM_BASE + mainOffset + 1);
writeArmStartupInstaller(input, inactiveStartupBase, 0x02000001);

// The active main routine reinstalls the IRQ vector from Thumb code. This is
// the final structural proof required for a safe pre-main callback.
writeU16(input, 0x6e8, 0x4901); // ldr r1, [pc, #4]
writeU16(input, 0x6ea, 0x6008); // str r0, [r1]
writeU32(input, 0x6f0, 0x03007ffc);

const rom = { bytes: new Uint8Array(input) };
const operations = [];
const warnings = [];
const result = applyIrqHandlerForPipeline(
  rom,
  operations,
  warnings,
  {
    enabled: true,
    startupCallbackEntry: GBA_ROM_BASE + callbackOffset,
    allowPreMainStartupCallback: true,
  },
  {
    payloadOffset: 0x4000,
    excludedRanges: [],
    entrypointSource: input,
  },
);

assert.deepEqual(warnings, []);
assert.equal(result.status, "patched");
assert.equal(result.startupHooks, 2);
assert.equal(result.startupCallbackTiming, "preMain");
assert.equal(result.installHandlerEntry, result.handlerEntry);

const stubs = operations.filter((operation) => (
  operation.metadata?.name === "Shared IRQ post-CRT startup hook"
));
assert.equal(stubs.length, 2);
assert.equal(readU32(stubs[0].replacement, 12) >>> 24, 0xeb); // BL callback
assert.notEqual(readU32(stubs[1].replacement, 12) >>> 24, 0xeb); // regular installer

const installerBranches = operations.filter((operation) => (
  operation.metadata?.name === "Shared IRQ startup installer branch"
));
const activeBranch = installerBranches.find((operation) => (
  operation.offset === activeStartupBase + 0x24
));
const inactiveBranch = installerBranches.find((operation) => (
  operation.offset === inactiveStartupBase + 0x24
));
assert.equal(activeBranch.metadata.value, GBA_ROM_BASE + stubs[0].offset);
assert.equal(inactiveBranch.metadata.value, GBA_ROM_BASE + stubs[1].offset);

// AA2P reaches the active Thumb IRQ reinstaller only after roughly 4.5 KiB of
// main-side initialization. It is still part of the same SDK startup path and
// must retain the pre-main Batteryless callback instead of falling back to the
// first VBlank, where it would overwrite an early save probe.
const delayedThumbInput = new Uint8Array(input);
delayedThumbInput.fill(0xff, 0x6e8, 0x6f4);
const delayedThumbLoad = mainOffset + 0x1200;
writeU16(delayedThumbInput, delayedThumbLoad, 0x4901); // ldr r1, [pc, #4]
writeU16(delayedThumbInput, delayedThumbLoad + 2, 0x6008); // str r0, [r1]
writeU32(delayedThumbInput, delayedThumbLoad + 8, 0x03007ffc);

const delayedRom = { bytes: new Uint8Array(delayedThumbInput) };
const delayedResult = applyIrqHandlerForPipeline(
  delayedRom,
  [],
  [],
  {
    enabled: true,
    startupCallbackEntry: GBA_ROM_BASE + callbackOffset,
    allowPreMainStartupCallback: true,
  },
  {
    payloadOffset: 0x4000,
    excludedRanges: [],
    entrypointSource: delayedThumbInput,
  },
);

assert.equal(delayedResult.status, "patched");
assert.equal(delayedResult.startupCallbackTiming, "preMain");

console.log("shared IRQ pre-main startup tests: PASS");
