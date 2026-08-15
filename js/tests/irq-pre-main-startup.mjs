// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";

import { applyIrqHandlerForPipeline } from "../patchers/irq-handler.js";
import { IRQ_HANDLER_CONSTANTS } from "../patchers/irq-handler-data.js";

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

function writeArmStartupInstaller(bytes, base, mainAddress, { clearIwram = false } = {}) {
  if (clearIwram) {
    writeU32(bytes, base + 0x04, 0xe3a00403); // mov r0, #03000000
    writeU32(bytes, base + 0x08, 0xe3a02000); // mov r2, #0
    writeU32(bytes, base + 0x0c, 0xe3a03902); // mov r3, #0x8000
    writeU32(bytes, base + 0x10, 0xe8a00004); // stmia r0!, {r2}
    writeU32(bytes, base + 0x14, 0xe2533004); // subs r3, r3, #4
    writeU32(bytes, base + 0x18, 0x1afffffc); // bne base+0x10
    writeU32(bytes, base + 0x1c, 0xe59fd01c); // ldr sp, [pc, #0x1c]
    writeU32(bytes, base + 0x20, 0xe59f101c); // ldr r1, =03007FFC
    writeU32(bytes, base + 0x24, 0xe28f0020); // add r0, pc, #0x20
    writeU32(bytes, base + 0x28, 0xe5810000); // str r0, [r1]
    writeU32(bytes, base + 0x2c, 0xe59f1014); // ldr r1, =main
    writeU32(bytes, base + 0x30, 0xe1a0e00f); // mov lr, pc
    writeU32(bytes, base + 0x34, 0xe12fff11); // bx r1
    writeU32(bytes, base + 0x40, 0x03007f00);
    writeU32(bytes, base + 0x44, 0x03007ffc);
    writeU32(bytes, base + 0x48, mainAddress);
    return;
  }
  writeU32(bytes, base + 0x10, 0xe59fd020);
  writeU32(bytes, base + 0x14, 0xe3a02000);
  writeU32(bytes, base + 0x18, 0xe3a03000);
  writeU32(bytes, base + 0x1c, 0xe59f101c);
  writeU32(bytes, base + 0x20, 0xe28f0020);
  writeU32(bytes, base + 0x24, 0xe5810000);
  writeU32(bytes, base + 0x28, 0xe59f1014);
  writeU32(bytes, base + 0x2c, 0xe1a0e00f);
  writeU32(bytes, base + 0x30, 0xe12fff11);
  writeU32(bytes, base + 0x38, 0x03007f00);
  writeU32(bytes, base + 0x40, 0x03007ffc);
  writeU32(bytes, base + 0x44, mainAddress);
}

function writeThumbReinstaller(bytes, offset, literalOffset) {
  const immediate = (literalOffset - ((offset + 4) & ~3)) >> 2;
  writeU16(bytes, offset, 0x4800 | immediate); // ldr r0, =03007FFC
  writeU16(bytes, offset + 2, 0x6004); // str r4, [r0]
  writeU32(bytes, literalOffset, 0x03007ffc);
}

function install(input, callbackOffset, payloadOffset = input.length - 0x1000) {
  const operations = [];
  const warnings = [];
  const result = applyIrqHandlerForPipeline(
    { bytes: new Uint8Array(input) },
    operations,
    warnings,
    {
      enabled: true,
      startupCallbackEntry: GBA_ROM_BASE + callbackOffset,
    },
    { payloadOffset, excludedRanges: [], entrypointSource: input },
  );
  return { result, operations, warnings };
}

assert.equal("IRQ_HANDLER_VBLANK_OFFSET" in IRQ_HANDLER_CONSTANTS, false);
assert.equal("IRQ_HANDLER_CONTINUOUS_VBLANK_OFFSET" in IRQ_HANDLER_CONSTANTS, false);

// A structurally plausible installer without a proven preceding IWRAM clear
// is not a pre-main ABI profile and must defer to first VBlank.
const deferred = new Uint8Array(0x7000).fill(0xff);
writeU32(deferred, 0, armBranch(0, 0x204));
writeArmStartupInstaller(deferred, 0x200, GBA_ROM_BASE + 0x680 + 1);
writeThumbReinstaller(deferred, 0x6e8, 0x6f0);
const deferredInstall = install(deferred, 0x3000, 0x5000);
assert.deepEqual(deferredInstall.warnings, []);
assert.equal(deferredInstall.result.status, "patched");
assert.equal(deferredInstall.result.startupCallbackTiming, "firstVBlank");
assert.equal("shortIrqHandler" in deferredInstall.result, false);
assert.equal(
  deferredInstall.result.handlerEntry,
  deferredInstall.result.runtimeBase + IRQ_HANDLER_CONSTANTS.IRQ_HANDLER_OFFSET,
);
assert.equal(
  deferredInstall.result.installHandlerEntry,
  deferredInstall.result.startupHandlerEntry,
);

// Pre-main requires the complete structural profile: reset-context installer,
// established aligned stack, a destructive full-IWRAM clear before install,
// and exactly one associated Thumb reinstaller.
const proven = new Uint8Array(0x7000).fill(0xff);
writeU32(proven, 0, armBranch(0, 0x204));
writeArmStartupInstaller(proven, 0x200, GBA_ROM_BASE + 0x680 + 1, { clearIwram: true });
writeThumbReinstaller(proven, 0x6e8, 0x6f0);
const provenInstall = install(proven, 0x3000, 0x5000);
assert.deepEqual(provenInstall.warnings, []);
assert.equal(provenInstall.result.status, "patched");
assert.equal(provenInstall.result.startupCallbackTiming, "preMain");
assert.equal(provenInstall.result.installHandlerEntry, provenInstall.result.handlerEntry);
assert.equal("shortIrqHandler" in provenInstall.result, false);

const startupStubs = provenInstall.operations.filter((operation) => (
  operation.metadata?.name === "Shared IRQ post-CRT startup hook"
));
assert.ok(startupStubs.length >= 1);
for (const stub of startupStubs) {
  const handlerLiteralOffset = readU32(stub.replacement, 12) >>> 24 === 0xeb ? 32 : 24;
  assert.equal(readU32(stub.replacement, handlerLiteralOffset), provenInstall.result.handlerEntry);
}

// An additional plausible reset-context reinstaller makes the profile
// ambiguous and therefore returns to the conservative first-VBlank path.
const ambiguous = new Uint8Array(proven);
writeThumbReinstaller(ambiguous, 0x900, 0x908);
const ambiguousInstall = install(ambiguous, 0x3000, 0x5000);
assert.equal(ambiguousInstall.result.status, "patched");
assert.equal(ambiguousInstall.result.startupCallbackTiming, "firstVBlank");
assert.equal(ambiguousInstall.result.installHandlerEntry, ambiguousInstall.result.startupHandlerEntry);

console.log("shared IRQ full-handler and startup-profile tests: PASS");
