// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";

import {
  batterylessBootVectorOffset,
  routeBatterylessBootVector,
} from "../patchers/batteryless-sram.js";
import { patchSramBytes } from "../patchers/sram.js";
import { applyIrqHandlerForPipeline } from "../patchers/irq-handler.js";
import {
  patchWaitstateStartupLiterals,
  patchWaitstateTimingSensitiveLoops,
} from "../patchers/waitcnt-scanner.js";
import { applyWaitstatePatch } from "../patchers/waitstate.js";
import {
  WAITCNT_SWI_RESTORE_ARM_OFFSET,
  WAITCNT_SWI_RESTORE_SIZE,
  makeWaitcntSwiRestorePayload,
  makeWaitstatePayload,
} from "../patchers/waitstate-payload.js";
import { encodeThumbBlToTarget } from "../core/thumb.js";
import {
  BATTERYLESS_FLASH1M_BANK_SWITCH_THUNK_HEX,
  BATTERYLESS_PAYLOAD_GBATA_HEX,
  BATTERYLESS_PAYLOAD_HEX,
  BATTERYLESS_PAYLOAD_VISOLY_HEX,
  BATTERYLESS_SIGNATURE_HEX,
  BATTERYLESS_WRITE_HOOKS,
  PATCH_BY_SAVE_TYPE,
  SRAM_CONSTANTS,
  VISOLY_SRAM_BANK_SWITCH_PAYLOAD_HEX,
} from "../patchers/sram-data.js";

const modern = Buffer.from(BATTERYLESS_PAYLOAD_HEX, "hex");
const gbata = Buffer.from(BATTERYLESS_PAYLOAD_GBATA_HEX, "hex");
const visoly = Buffer.from(BATTERYLESS_PAYLOAD_VISOLY_HEX, "hex");
const visolyHelper = Buffer.from(VISOLY_SRAM_BANK_SWITCH_PAYLOAD_HEX, "hex");
const selector = SRAM_CONSTANTS.BATTERYLESS_SRAM_BANK_SELECT_PATCHED & ~1;
const mappedSelector = selector + 22;
const ramTail = selector + 76;
const mapperAddress = selector + 100;
const signature = Buffer.from(BATTERYLESS_SIGNATURE_HEX, "hex");

const waitcntSwiRestore = Buffer.from(makeWaitcntSwiRestorePayload());
assert.equal(waitcntSwiRestore.length, WAITCNT_SWI_RESTORE_SIZE);
assert.equal(waitcntSwiRestore.readUInt16LE(8), 0x4901);
assert.equal(waitcntSwiRestore.readUInt32LE(WAITCNT_SWI_RESTORE_ARM_OFFSET + 12), 0xef010000);

function writeThumbLiteralLoad(bytes, instructionOffset, literalOffset, register) {
  const pc = (0x08000000 + instructionOffset + 4) & ~3;
  const displacement = 0x08000000 + literalOffset - pc;
  assert.equal(displacement >= 0 && displacement <= 0x3fc && displacement % 4 === 0, true);
  bytes.writeUInt16LE(0x4800 | (register << 8) | (displacement >>> 2), instructionOffset);
}

function installThumbWaitcntStore(bytes, instructionOffset, literalOffset) {
  writeThumbLiteralLoad(bytes, instructionOffset, literalOffset, 1);
  writeThumbLiteralLoad(bytes, instructionOffset + 2, literalOffset + 4, 2);
  bytes.writeUInt16LE(0x1c10, instructionOffset + 4); // adds r0, r2, #0
  bytes.writeUInt16LE(0x8008, instructionOffset + 6); // strh r0, [r1, #0]
  bytes.writeUInt32LE(SRAM_CONSTANTS.WAITSTATE_REGISTER, literalOffset);
  bytes.writeUInt32LE(0x4000, literalOffset + 4);
}

{
  const fixture = Buffer.alloc(0x50000, 0xff);
  installThumbWaitcntStore(fixture, 0x30020, 0x30040);
  const operations = [];
  assert.equal(
    patchWaitstateStartupLiterals(fixture, 0x4003, operations, []),
    1,
    "WAITCNT initialization after the former 128 KiB bound must be patched",
  );
  assert.equal(fixture.readUInt32LE(0x30044), 0x4003);
  assert.equal(operations[0].metadata.codeName, "waitstate_startup_literal");
}

{
  const fixture = Buffer.alloc(0x100, 0xff);
  installThumbWaitcntStore(fixture, 0x20, 0x40);
  fixture.writeUInt16LE(0x4770, 0x26); // remove the proven STRH
  const original = Buffer.from(fixture);
  assert.equal(patchWaitstateStartupLiterals(fixture, 0x4003, [], []), 0);
  assert.deepEqual(fixture, original, "an unreferenced WAITCNT-looking literal pair must stay unchanged");
}

{
  const fixture = Buffer.alloc(0x200, 0xff);
  const loop = 0x100;
  fixture.writeUInt16LE(0x2600, loop - 0x24); // movs r6, #0
  fixture.writeUInt16LE(0x4818, loop - 0x22); // ldr r0, [pc, #0x60]
  fixture.writeUInt16LE(0x4680, loop - 0x20); // mov r8, r0
  fixture.writeUInt16LE(0x4644, loop - 4); // mov r4, r8
  fixture.writeUInt16LE(0x3401, loop - 2); // adds r4, #1
  [0x8810, 0x8016, 0x3208, 0x3c01, 0x2c00, 0xd1f9]
    .forEach((halfword, index) => fixture.writeUInt16LE(halfword, loop + index * 2));
  fixture.writeUInt32LE(0x3ff, 0x140);
  const unpatched = Buffer.from(fixture);
  const operations = [];
  assert.equal(patchWaitstateTimingSensitiveLoops(fixture, operations), 1);
  assert.equal(fixture.subarray(loop, loop + 12).toString("hex"), "168016811032023cfad1c046");

  const oddCount = Buffer.from(unpatched);
  oddCount.writeUInt32LE(0x400, 0x140);
  const original = Buffer.from(oddCount);
  assert.equal(patchWaitstateTimingSensitiveLoops(oddCount, []), 0);
  assert.deepEqual(oddCount, original, "the two-at-a-time rewrite requires a proven even count");
}

{
  const fixture = Buffer.alloc(0x1000, 0xff);
  fixture.writeUInt32LE(0xea00002e, 0); // entry branch to 0xc0
  fixture.writeUInt16LE(0x2080, 0x1fe); // movs r0, #0x80
  const thumbCall = encodeThumbBlToTarget(0x300, 0x200);
  assert.notEqual(thumbCall, null);
  fixture.writeUInt16LE(thumbCall[0], 0x200);
  fixture.writeUInt16LE(thumbCall[1], 0x202);
  fixture.writeUInt16LE(0xdf01, 0x300); // swi 1
  fixture.writeUInt16LE(0x4770, 0x302); // bx lr
  fixture.writeUInt32LE(0xe3a00080, 0x400); // mov r0, #0x80
  fixture.writeUInt32LE(0xef010000, 0x404); // swi 1
  const originalThumbCall = Buffer.from(fixture.subarray(0x200, 0x204));
  const operations = [];
  const warnings = [];
  const rom = { bytes: fixture };
  const result = applyWaitstatePatch(rom, operations, warnings, 0x4003, {
    payloadOffset: 0x800,
    payloadOffsetRequired: true,
  });
  const patched = Buffer.from(rom.bytes.buffer, rom.bytes.byteOffset, rom.bytes.byteLength);
  assert.equal(result.status, "patched");
  assert.equal(result.swiPatches, 2);
  assert.notEqual(patched.readUInt32LE(0x404), 0xef010000);
  assert.notDeepEqual(patched.subarray(0x200, 0x204), originalThumbCall);
  assert.deepEqual(warnings, []);
}

function assertDiscoverableFromBootVector(payload) {
  const marker = payload.indexOf(signature);
  const bootVectorTarget = batterylessBootVectorOffset(payload);
  assert.notEqual(marker, -1);
  assert.ok(bootVectorTarget <= marker);
  assert.ok(marker - bootVectorTarget <= 0x2000);

  const branch = payload.readUInt32LE(bootVectorTarget);
  assert.equal(branch >>> 24, 0xea);
  let displacement = branch & 0x00ffffff;
  if (displacement & 0x00800000) displacement -= 0x01000000;
  const runtimeEntrypoint = bootVectorTarget + 8 + (displacement << 2);
  assert.equal(runtimeEntrypoint, payload.readUInt32LE(0x0c));
}

function armBranch(source, target) {
  return (0xea000000 | (((target - source - 8) >> 2) & 0x00ffffff)) >>> 0;
}

function branchTarget(bytes, offset) {
  const branch = bytes.readUInt32LE(offset);
  let displacement = branch & 0x00ffffff;
  if (displacement & 0x00800000) displacement -= 0x01000000;
  return 0x08000000 + offset + 8 + (displacement << 2);
}

assert.equal(SRAM_CONSTANTS.BATTERYLESS_SRAM_BANK_SELECT_PATCHED & 1, 1);
assert.deepEqual(
  [...modern.subarray(selector, selector + 22)],
  [
    0x06, 0xb4, 0x10, 0xa1, 0x0a, 0x68, 0x89, 0x18, 0x09, 0x68, 0x01,
    0x22, 0x12, 0x04, 0x91, 0x42, 0x06, 0xbc, 0x00, 0xd8, 0x70, 0x47,
  ],
  "64 KiB-or-smaller saves must return before the RAM mapper path",
);
assert.equal(modern.readUInt16LE(mappedSelector), 0xb41f); // mapper-only register save
assert.equal(modern.readUInt16LE(mappedSelector + 24), 0x9809); // saved bank after stack slot
assert.equal(modern.readUInt16LE(mappedSelector + 50), 0x4718); // branch into copied RAM code
assert.equal(modern.readUInt16LE(ramTail), 0x4a05); // load copied mapper literal
assert.equal(modern.readUInt16LE(ramTail + 2), 0x7010); // modern byte write
assert.equal(gbata.readUInt16LE(ramTail + 6), 0x8011); // GBATA unlock write
assert.equal(gbata.readUInt16LE(ramTail + 10), 0x8010); // GBATA bank write
assert.equal(visoly.readUInt16LE(ramTail + 2), 0x3101); // helper is immediately after tail
assert.equal(visoly.readUInt16LE(ramTail + 4), 0x4708); // branch to full IWRAM helper
assert.equal(modern.readUInt16LE(ramTail + 20), 0x4770);
assert.equal(gbata.readUInt16LE(ramTail + 20), 0x4770);
assert.equal(modern.readUInt32LE(mapperAddress), 0x09000000);
assert.equal(gbata.readUInt32LE(mapperAddress), 0x09000000);
assert.equal(visoly.indexOf(visolyHelper), ramTail + 28);

const resetTransferWord = Buffer.from(
  "044090e40140c1e42444a0e10140c1e42444a0e10140c1e42444a0e10140c1e4",
  "hex",
);
const resetTransferBlock = Buffer.concat(Array.from({ length: 16 }, () => resetTransferWord));
const resetTransferByte = Buffer.from("0140d0e40140c1e4", "hex");
const resetTransferByteBlock = Buffer.concat(
  Array.from({ length: 64 }, () => resetTransferByte),
);
for (const [name, payload] of [["modern", modern], ["gbata", gbata], ["visoly", visoly]]) {
  const transferOffset = payload.indexOf(
    resetTransferBlock,
    SRAM_CONSTANTS.BATTERYLESS_INITIALIZE_SRAM & ~3,
  );
  assert.notEqual(
    transferOffset,
    -1,
    `${name}: reset hydration must transfer 64 bytes using word ROM reads and byte SRAM writes`,
  );
  assert.equal(
    payload.readUInt32LE(transferOffset + resetTransferBlock.length),
    0xe2855040,
    `${name}: reset hydration loop must advance its byte count by 64`,
  );
  const byteTransferOffset = payload.indexOf(
    resetTransferByteBlock,
    transferOffset + resetTransferBlock.length,
  );
  assert.notEqual(
    byteTransferOffset,
    -1,
    `${name}: larger saves must retain byte-wide Game Pak ROM reads`,
  );
  assert.equal(
    payload.readUInt32LE(byteTransferOffset + resetTransferByteBlock.length),
    0xe2855040,
    `${name}: large-save hydration loop must advance its byte count by 64`,
  );
  assert.equal(
    payload.readUInt32LE(transferOffset - 8),
    0xe3520c02,
    `${name}: reset hydration must compare the configured save size with 512 bytes`,
  );
  assert.equal(
    branchTarget(payload, transferOffset - 4),
    0x08000000 + byteTransferOffset,
    `${name}: saves larger than 512 bytes must branch to the byte-read path`,
  );
}

function installIdentifier(bytes, identifier, offset) {
  if (identifier.marker) {
    bytes.set(Buffer.from(identifier.marker, "hex"), offset);
    return;
  }
  for (const [relative, value] of identifier.checks) bytes[offset + relative] = value;
}

function mapperSpecializationFixture(saveType) {
  const bytes = new Uint8Array(0x100000).fill(0xff);
  Buffer.from(bytes.buffer).writeUInt32LE(armBranch(0x08000000, 0x080000c0), 0);
  bytes[0xb2] = 0x96;
  PATCH_BY_SAVE_TYPE[saveType].steps.forEach((step, index) => {
    installIdentifier(bytes, step.identifier, 0x200 + index * 0x400);
  });
  if (saveType.startsWith("FLASH1M")) {
    const hook = BATTERYLESS_WRITE_HOOKS.find((candidate) => candidate.save_size === 0x20000);
    bytes.set(Buffer.from(hook.marker, "hex"), 0x10000);
  }
  return bytes;
}

for (const [saveType, expectedFirstInstruction] of [
  ["EEPROM_V120", 0x4770], // literal BX LR; no flags or registers touched
  ["FLASH1M_V103", modern.readUInt16LE(selector)],
]) {
  const patched = patchSramBytes(mapperSpecializationFixture(saveType), {
    saveTypeOverride: saveType,
    batteryless: true,
    batterylessMode: "auto",
  });
  assert.equal(patched.result.batteryless.status, "patched", saveType);
  assert.equal(patched.result.irqHandler.startupCallbackEntry, 0, saveType);
  assert.equal(
    patched.result.irqHandler.originalEntrypoint,
    patched.result.batteryless.originalEntrypoint,
    `${saveType}: IRQ bootstrap must continue past the reset initializer`,
  );
  assert.equal(
    Buffer.from(patched.bytes.buffer).readUInt16LE(
      patched.result.batteryless.payloadOffset + selector,
    ),
    expectedFirstInstruction,
    `${saveType}: host-specialized mapper entry`,
  );
}

for (const offset of [0x0c, 0x10, 0x14, 0x18, 0x1c, 0x20, 0x2c, 0x34]) {
  assert.equal(modern.readUInt32LE(offset), gbata.readUInt32LE(offset));
  assert.equal(modern.readUInt32LE(offset), visoly.readUInt32LE(offset));
}

assertDiscoverableFromBootVector(modern);
assertDiscoverableFromBootVector(gbata);
assertDiscoverableFromBootVector(visoly);

{
  const patched = patchSramBytes(mapperSpecializationFixture("FLASH1M_V103"), {
    saveTypeOverride: "FLASH1M_V103",
    batteryless: true,
    batterylessMode: "auto",
    flash1mBankSwitchStyle: "visoly",
  });
  assert.equal(patched.result.batteryless.status, "patched");
  assert.equal(patched.result.batteryless.flash1mBankSwitchStyle, "visoly");
  assert.equal(patched.result.batteryless.flash1mBankSwitches, 1);
  const payloadOffset = patched.result.batteryless.payloadOffset;
  assert.deepEqual(
    Buffer.from(patched.bytes.slice(
      payloadOffset + visoly.indexOf(visolyHelper),
      payloadOffset + visoly.indexOf(visolyHelper) + visolyHelper.length,
    )),
    visolyHelper,
  );
  const installedThunk = Buffer.from(patched.bytes.slice(0x200, 0x218));
  assert.equal(
    installedThunk.subarray(0, 4).toString("hex"),
    BATTERYLESS_FLASH1M_BANK_SWITCH_THUNK_HEX,
  );
  assert.equal(
    installedThunk.readUInt32LE(4),
    0x08000000 + payloadOffset + SRAM_CONSTANTS.BATTERYLESS_SRAM_BANK_SELECT_PATCHED,
  );
}

const originalSource = new Uint8Array(0x20000).fill(0xff);
const originalBytes = Buffer.from(originalSource.buffer);
originalBytes.writeUInt32LE(armBranch(0x08000000, 0x080000c0), 0);
const routedRom = { bytes: new Uint8Array(originalSource) };
const routedBytes = Buffer.from(routedRom.bytes.buffer);
const runtimeEntry = 0x08003000;
const bootVectorEntry = 0x08018000;
const originalEntrypoint = 0x080000c0;
const batterylessPayloadOffset = runtimeEntry
  - 0x08000000
  - SRAM_CONSTANTS.BATTERYLESS_PATCHED_ENTRYPOINT;
const batterylessResult = {
  status: "patched",
  bootVectorEntry,
  runtimeEntry,
  payloadOffset: batterylessPayloadOffset,
  originalEntrypoint,
};
routedBytes.writeUInt32LE(armBranch(0x08000000, bootVectorEntry), 0);
routedBytes.writeUInt32LE(armBranch(bootVectorEntry, runtimeEntry), 0x18000);
routedBytes.writeUInt32LE(originalEntrypoint, batterylessPayloadOffset);
const routeOperations = [];
const routeWarnings = [];
const irqResult = applyIrqHandlerForPipeline(
  routedRom,
  routeOperations,
  routeWarnings,
  {
    enabled: true,
    saveFlushEntry: 0x08004000,
    startupCallbackEntry: 0,
    originalEntrypointOverride: originalEntrypoint,
  },
  { payloadOffset: 0x10000, excludedRanges: [], entrypointSource: originalSource },
);
assert.equal(irqResult.status, "patched");
assert.equal(irqResult.entrypointHook, true);
assert.equal(irqResult.originalEntrypoint, originalEntrypoint);
assert.equal(irqResult.startupCallbackEntry, 0);
const installedBytes = Buffer.from(routedRom.bytes.buffer);
assert.equal(branchTarget(installedBytes, 0), irqResult.bootstrapEntry);
assert.equal(routeBatterylessBootVector(
  routedRom,
  routeOperations,
  batterylessResult,
), true);
assert.equal(branchTarget(installedBytes, 0), bootVectorEntry);
assert.equal(branchTarget(installedBytes, 0x18000), runtimeEntry);
assert.equal(installedBytes.readUInt32LE(batterylessPayloadOffset), irqResult.bootstrapEntry);
assert.deepEqual(routeWarnings, []);

const waitstateOnlyRom = { bytes: new Uint8Array(originalSource) };
const waitstateOnlyBytes = Buffer.from(waitstateOnlyRom.bytes.buffer);
const waitstateOffset = 0x14000;
const waitstateEntry = 0x08000000 + waitstateOffset;
waitstateOnlyBytes.writeUInt32LE(armBranch(0x08000000, waitstateEntry), 0);
waitstateOnlyBytes.writeUInt32LE(armBranch(bootVectorEntry, runtimeEntry), 0x18000);
waitstateOnlyBytes.writeUInt32LE(originalEntrypoint, batterylessPayloadOffset);
waitstateOnlyBytes.set(makeWaitstatePayload(0x4003, bootVectorEntry), waitstateOffset);
const waitstateOnlyResult = { status: "patched", payloadOffset: waitstateOffset };
assert.equal(routeBatterylessBootVector(
  waitstateOnlyRom,
  [],
  batterylessResult,
  waitstateOnlyResult,
), true);
assert.equal(branchTarget(waitstateOnlyBytes, 0), bootVectorEntry);
assert.equal(branchTarget(waitstateOnlyBytes, 0x18000), runtimeEntry);
assert.equal(waitstateOnlyBytes.readUInt32LE(batterylessPayloadOffset), waitstateEntry);
assert.equal(waitstateOnlyBytes.readUInt32LE(waitstateOffset + 24), originalEntrypoint);
assert.equal(waitstateOnlyResult.nextEntrypoint, originalEntrypoint);

const irqAndWaitstateRom = { bytes: new Uint8Array(originalSource) };
const irqAndWaitstateBytes = Buffer.from(irqAndWaitstateRom.bytes.buffer);
const irqEntrypoint = 0x08012000;
irqAndWaitstateBytes.writeUInt32LE(armBranch(0x08000000, irqEntrypoint), 0);
irqAndWaitstateBytes.writeUInt32LE(armBranch(bootVectorEntry, runtimeEntry), 0x18000);
irqAndWaitstateBytes.writeUInt32LE(originalEntrypoint, batterylessPayloadOffset);
irqAndWaitstateBytes.set(makeWaitstatePayload(0x4003, bootVectorEntry), waitstateOffset);
const irqAndWaitstateResult = { status: "patched", payloadOffset: waitstateOffset };
assert.equal(routeBatterylessBootVector(
  irqAndWaitstateRom,
  [],
  batterylessResult,
  irqAndWaitstateResult,
), true);
assert.equal(branchTarget(irqAndWaitstateBytes, 0), bootVectorEntry);
assert.equal(branchTarget(irqAndWaitstateBytes, 0x18000), runtimeEntry);
assert.equal(irqAndWaitstateBytes.readUInt32LE(batterylessPayloadOffset), waitstateEntry);
assert.equal(irqAndWaitstateBytes.readUInt32LE(waitstateOffset + 24), irqEntrypoint);
assert.equal(irqAndWaitstateResult.nextEntrypoint, irqEntrypoint);

console.log("batteryless SRAM runtime ABI tests: PASS");
