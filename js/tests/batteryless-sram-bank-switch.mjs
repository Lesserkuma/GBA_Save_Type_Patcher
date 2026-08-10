// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";

import {
  batterylessBootVectorOffset,
  routeBatterylessBootVector,
} from "../patchers/batteryless-sram.js";
import { applyIrqHandlerForPipeline } from "../patchers/irq-handler.js";
import { makeWaitstatePayload } from "../patchers/waitstate-payload.js";
import {
  BATTERYLESS_PAYLOAD_GBATA_HEX,
  BATTERYLESS_PAYLOAD_HEX,
  BATTERYLESS_SIGNATURE_HEX,
  SRAM_CONSTANTS,
} from "../patchers/sram-data.js";

const modern = Buffer.from(BATTERYLESS_PAYLOAD_HEX, "hex");
const gbata = Buffer.from(BATTERYLESS_PAYLOAD_GBATA_HEX, "hex");
const selector = SRAM_CONSTANTS.BATTERYLESS_SRAM_BANK_SELECT_PATCHED & ~1;
const ramTail = selector + 48;
const mapperAddress = selector + 72;
const signature = Buffer.from(BATTERYLESS_SIGNATURE_HEX, "hex");

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
  [...modern.subarray(selector, selector + 12)],
  [0x1f, 0xb4, 0x00, 0xb5, 0x88, 0xb0, 0x0a, 0xa1, 0x6a, 0x46, 0x1c, 0x23],
);
assert.equal(modern.readUInt16LE(selector + 24), 0x9809); // saved bank after stack slot
assert.equal(modern.readUInt16LE(selector + 44), 0x4718); // branch into copied RAM code
assert.equal(modern.readUInt16LE(ramTail), 0x4a05); // load copied mapper literal
assert.equal(modern.readUInt16LE(ramTail + 2), 0x7010); // modern byte write
assert.equal(gbata.readUInt16LE(ramTail + 6), 0x8011); // GBATA unlock write
assert.equal(gbata.readUInt16LE(ramTail + 10), 0x8010); // GBATA bank write
assert.equal(modern.readUInt16LE(ramTail + 20), 0x4770);
assert.equal(gbata.readUInt16LE(ramTail + 20), 0x4770);
assert.equal(modern.readUInt32LE(mapperAddress), 0x09000000);
assert.equal(gbata.readUInt32LE(mapperAddress), 0x09000000);

for (const offset of [0x0c, 0x10, 0x14, 0x18, 0x1c, 0x20, 0x2c, 0x34]) {
  assert.equal(modern.readUInt32LE(offset), gbata.readUInt32LE(offset));
}

assertDiscoverableFromBootVector(modern);
assertDiscoverableFromBootVector(gbata);

const originalSource = new Uint8Array(0x20000).fill(0xff);
const originalBytes = Buffer.from(originalSource.buffer);
originalBytes.writeUInt32LE(armBranch(0x08000000, 0x080000c0), 0);
const routedRom = { bytes: new Uint8Array(originalSource) };
const routedBytes = Buffer.from(routedRom.bytes.buffer);
const runtimeEntry = 0x08003000;
const bootVectorEntry = 0x08018000;
routedBytes.writeUInt32LE(armBranch(0x08000000, bootVectorEntry), 0);
routedBytes.writeUInt32LE(armBranch(bootVectorEntry, runtimeEntry), 0x18000);
const routeOperations = [];
const routeWarnings = [];
const irqResult = applyIrqHandlerForPipeline(
  routedRom,
  routeOperations,
  routeWarnings,
  {
    enabled: true,
    saveFlushEntry: 0x08004000,
    startupCallbackEntry: runtimeEntry,
    originalEntrypointOverride: runtimeEntry,
  },
  { payloadOffset: 0x10000, excludedRanges: [], entrypointSource: originalSource },
);
assert.equal(irqResult.status, "patched");
assert.equal(irqResult.entrypointHook, true);
assert.equal(irqResult.originalEntrypoint, runtimeEntry);
const installedBytes = Buffer.from(routedRom.bytes.buffer);
assert.equal(branchTarget(installedBytes, 0), irqResult.bootstrapEntry);
assert.equal(routeBatterylessBootVector(
  routedRom,
  routeOperations,
  { status: "patched", bootVectorEntry },
), true);
assert.equal(branchTarget(installedBytes, 0), bootVectorEntry);
assert.equal(branchTarget(installedBytes, 0x18000), irqResult.bootstrapEntry);
assert.deepEqual(routeWarnings, []);

const waitstateOnlyRom = { bytes: new Uint8Array(originalSource) };
const waitstateOnlyBytes = Buffer.from(waitstateOnlyRom.bytes.buffer);
const waitstateOffset = 0x14000;
const waitstateEntry = 0x08000000 + waitstateOffset;
waitstateOnlyBytes.writeUInt32LE(armBranch(0x08000000, waitstateEntry), 0);
waitstateOnlyBytes.writeUInt32LE(armBranch(bootVectorEntry, runtimeEntry), 0x18000);
waitstateOnlyBytes.set(makeWaitstatePayload(0x4003, bootVectorEntry), waitstateOffset);
const waitstateOnlyResult = { status: "patched", payloadOffset: waitstateOffset };
assert.equal(routeBatterylessBootVector(
  waitstateOnlyRom,
  [],
  { status: "patched", bootVectorEntry, runtimeEntry },
  waitstateOnlyResult,
), true);
assert.equal(branchTarget(waitstateOnlyBytes, 0), bootVectorEntry);
assert.equal(branchTarget(waitstateOnlyBytes, 0x18000), waitstateEntry);
assert.equal(waitstateOnlyBytes.readUInt32LE(waitstateOffset + 24), runtimeEntry);
assert.equal(waitstateOnlyResult.nextEntrypoint, runtimeEntry);

const irqAndWaitstateRom = { bytes: new Uint8Array(originalSource) };
const irqAndWaitstateBytes = Buffer.from(irqAndWaitstateRom.bytes.buffer);
const irqEntrypoint = 0x08012000;
irqAndWaitstateBytes.writeUInt32LE(armBranch(0x08000000, irqEntrypoint), 0);
irqAndWaitstateBytes.writeUInt32LE(armBranch(bootVectorEntry, runtimeEntry), 0x18000);
irqAndWaitstateBytes.set(makeWaitstatePayload(0x4003, bootVectorEntry), waitstateOffset);
const irqAndWaitstateResult = { status: "patched", payloadOffset: waitstateOffset };
assert.equal(routeBatterylessBootVector(
  irqAndWaitstateRom,
  [],
  { status: "patched", bootVectorEntry, runtimeEntry },
  irqAndWaitstateResult,
), true);
assert.equal(branchTarget(irqAndWaitstateBytes, 0), bootVectorEntry);
assert.equal(branchTarget(irqAndWaitstateBytes, 0x18000), waitstateEntry);
assert.equal(irqAndWaitstateBytes.readUInt32LE(waitstateOffset + 24), irqEntrypoint);
assert.equal(irqAndWaitstateResult.nextEntrypoint, irqEntrypoint);

console.log("batteryless SRAM runtime ABI tests: PASS");
