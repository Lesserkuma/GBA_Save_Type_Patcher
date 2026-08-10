// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { hexToBytes } from "../core/binary.js";
import {
  patchCustomFlashBytes,
} from "../patchers/custom-flash.js";
import { patchFlash512kBytes } from "../patchers/flash512k.js";
import { analyzeDirectCompatibility } from "../patchers/direct-compatibility.js";
import { DIRECT_SRAM_LAYOUTS } from "../patchers/direct-abi-signatures.js";
import { EEPROM_V120_RUNTIME_WRAPPER_OFFSETS } from "../patchers/eeprom-v120-wrapper-data.js";
import {
  FLASH_DIRECT_CONSTANTS as BASE_PAYLOAD_CONSTANTS,
  FLASH_DIRECT_PAYLOAD_HEX as BASE_PAYLOAD_HEX,
} from "../patchers/flash-direct-data.js";
import {
  FLASH_DIRECT_CONSTANTS as SNAPSHOT_PAYLOAD_CONSTANTS,
  FLASH_DIRECT_PAYLOAD_HEX as SNAPSHOT_PAYLOAD_HEX,
} from "../patchers/flash-direct-snapshot-data.js";
import {
  FLASH_DIRECT_CONSTANTS as TRANSACTION_PAYLOAD_CONSTANTS,
  FLASH_DIRECT_PAYLOAD_HEX as TRANSACTION_PAYLOAD_HEX,
} from "../patchers/flash-direct-transaction-data.js";
import { analyzeBatchedSramSnapshot } from "../patchers/sram-batched-snapshot-analysis.js";
import {
  analyzeDirectSramAccesses,
  analyzeSramWriteVerifyWrappers,
  inventoryLiteralSaveAccesses,
} from "../patchers/thumb-direct-sram-analysis.js";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const strategyFiles = [
  "js/patchers/direct-compatibility.js",
  "js/patchers/flash512k.js",
  "js/patchers/flash512k-common.js",
  "js/patchers/eeprom-v12x-write-compat.js",
  "js/patchers/thumb-direct-sram-analysis.js",
  "js/patchers/sram-batched-snapshot-analysis.js",
];
const strategySource = (await Promise.all(strategyFiles.map(async (relative) => (
  readFile(path.join(repository, relative), "utf8")
)))).join("\n");
const directPayloadSource = await readFile(
  path.join(repository, "payloads/flash-direct/payload.c"), "utf8",
);

assert.doesNotMatch(
  directPayloadSource,
  /\bcfi_(?:physical|try|buffer)|flash_(?:program_buffer|marker_exponent|buffer_exponent)/,
  "Direct payload must not probe or select unsupported buffered programming",
);

assert.match(
  directPayloadSource,
  /static void sram_apply_sdk_waitstate\(void\)/,
  "Direct SRAM must preserve the Nintendo SDK Save-bus timing side effect",
);
assert.equal(
  (directPayloadSource.match(/\bsram_apply_sdk_waitstate\(\);/g) || []).length,
  5,
  "every Direct SRAM read/write/verify ABI entry must apply SDK Save-bus timing",
);
assert.match(
  directPayloadSource,
  /return direct_layout_config == layout && direct_save_protocol_valid\(\);/,
  "Direct runtime configuration must reject unknown save protocols",
);
assert.deepEqual(
  [
    BASE_PAYLOAD_CONSTANTS.DIRECT_PROTOCOL_STANDARD,
    BASE_PAYLOAD_CONSTANTS.DIRECT_PROTOCOL_CUSTOM_TYPE_1,
    BASE_PAYLOAD_CONSTANTS.DIRECT_PROTOCOL_CUSTOM_TYPE_2,
  ],
  [0, 1, 2],
  "Direct protocol ABI must remain explicit",
);
assert.deepEqual(
  Object.keys(EEPROM_V120_RUNTIME_WRAPPER_OFFSETS).sort(),
  ["cleanupAddress", "configAddress", "payloadAddress", "setupAddress", "timerStateAddress"],
  "fixed GBA hardware literals must not remain in the V120 wrapper configuration ABI",
);
const SRAM_ENTRIES = [
  "DIRECT_READ_SRAM_CACHED_ENTRY", "DIRECT_READ_SRAM_ENTRY",
  "DIRECT_READ_SRAM_TRIPLET_CACHED_ENTRY", "DIRECT_READ_SRAM_TRIPLET_ENTRY",
  "DIRECT_VERIFY_SRAM_CACHED_ENTRY", "DIRECT_VERIFY_SRAM_ENTRY",
  "DIRECT_VERIFY_SRAM_FAST_ENTRY", "DIRECT_WRITE_SRAM_CACHED_ENTRY",
  "DIRECT_WRITE_SRAM_ENTRY", "DIRECT_WRITE_VERIFY_SRAM_ENTRY",
].sort();
const EEPROM_ENTRIES = [
  "DIRECT_READ_EEPROM_ENTRY", "DIRECT_VERIFY_EEPROM_ENTRY",
  "DIRECT_WRITE_EEPROM_ENTRY", "DIRECT_WRITE_EEPROM_SETTLED_ENTRY",
].sort();
const BASE_CONFIG = ["DIRECT_LAYOUT_CONFIG_OFFSET", "DIRECT_SAVE_PROTOCOL_CONFIG_OFFSET"];
const SNAPSHOT_CONFIG = [
  ...BASE_CONFIG,
  "DIRECT_SNAPSHOT_COMMIT_FIRST_CONFIG_OFFSET",
  "DIRECT_SNAPSHOT_COMMIT_SIZE_CONFIG_OFFSET",
  "DIRECT_SNAPSHOT_PROVIDERS_CONFIG_OFFSET",
  "DIRECT_SNAPSHOT_PROVIDER_COUNT_CONFIG_OFFSET",
  "DIRECT_SNAPSHOT_TRANSIENT_COUNT_CONFIG_OFFSET",
  "DIRECT_SNAPSHOT_TRANSIENT_RANGES_CONFIG_OFFSET",
].sort();
const generatedRuntimes = [
  { label: "base", constants: BASE_PAYLOAD_CONSTANTS, payload: hexToBytes(BASE_PAYLOAD_HEX) },
  { label: "snapshot", constants: SNAPSHOT_PAYLOAD_CONSTANTS, payload: hexToBytes(SNAPSHOT_PAYLOAD_HEX) },
  { label: "transaction", constants: TRANSACTION_PAYLOAD_CONSTANTS, payload: hexToBytes(TRANSACTION_PAYLOAD_HEX) },
];
const analyzerTransactionRuntime = Object.freeze({ name: "transaction" });
const analyzerDescriptor = Object.freeze({
  label: "Direct policy test",
  familyRuntimes: Object.freeze({ sramTransaction: analyzerTransactionRuntime }),
});

for (const runtime of generatedRuntimes) {
  const { constants, payload } = runtime;
  if (runtime.label !== "base") {
    assert.deepEqual(
      Object.keys(constants).filter((name) => name.includes("EEPROM")),
      [],
      `${runtime.label}: SRAM-only payload contains EEPROM ABI`,
    );
  }
  const expectedEntries = runtime.label === "base"
    ? [...SRAM_ENTRIES, ...EEPROM_ENTRIES].sort()
    : SRAM_ENTRIES;
  assert.deepEqual(
    Object.keys(constants).filter((name) => name.endsWith("_ENTRY")).sort(),
    expectedEntries,
    `${runtime.label}: executable entry ABI`,
  );
  assert.deepEqual(
    Object.keys(constants).filter((name) => name.endsWith("_CONFIG_OFFSET")).sort(),
    runtime.label === "snapshot" ? SNAPSHOT_CONFIG : BASE_CONFIG,
    `${runtime.label}: configuration ABI`,
  );
  assert.equal(
    new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
      .getUint32(constants.DIRECT_LAYOUT_CONFIG_OFFSET, true),
    0xffffffff,
    `${runtime.label}: unconfigured layout must fail closed`,
  );
  assert.equal(
    new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
      .getUint32(constants.DIRECT_SAVE_PROTOCOL_CONFIG_OFFSET, true),
    constants.DIRECT_PROTOCOL_STANDARD,
    `${runtime.label}: unconfigured protocol must select the standard backend`,
  );
  assert.deepEqual([
    constants.DIRECT_PROTOCOL_STANDARD,
    constants.DIRECT_PROTOCOL_CUSTOM_TYPE_1,
    constants.DIRECT_PROTOCOL_CUSTOM_TYPE_2,
  ], [0, 1, 2], `${runtime.label}: protocol ABI`);
  for (const [plain, cached] of [
    ["DIRECT_WRITE_SRAM_ENTRY", "DIRECT_WRITE_SRAM_CACHED_ENTRY"],
    ["DIRECT_READ_SRAM_ENTRY", "DIRECT_READ_SRAM_CACHED_ENTRY"],
    ["DIRECT_READ_SRAM_TRIPLET_ENTRY", "DIRECT_READ_SRAM_TRIPLET_CACHED_ENTRY"],
    ["DIRECT_VERIFY_SRAM_ENTRY", "DIRECT_VERIFY_SRAM_CACHED_ENTRY"],
  ]) {
    assert.notEqual(
      constants[plain],
      constants[cached],
      `${runtime.label}: cacheless ${plain} must not alias the four-argument ABI`,
    );
  }
  for (const entry of [
    "DIRECT_WRITE_SRAM_ENTRY", "DIRECT_READ_SRAM_ENTRY", "DIRECT_VERIFY_SRAM_ENTRY",
  ]) {
    const offset = constants[entry] & ~1;
    assert.equal(
      payload[offset] | (payload[offset + 1] << 8),
      0x2300,
      `${runtime.label}: ${entry} must clear the absent r3 cache argument`,
    );
  }
}

{
  const ordinary = analyzeDirectCompatibility(new Uint8Array(0), {
    family: "sram",
    sourceSaveType: "SRAM_V111",
    sramWriteVerify: [],
    sramReadbackVerify: true,
  }, analyzerDescriptor);
  assert.equal(ordinary.profile, "sram-v16");
  assert.equal(ordinary.runtime, analyzerDescriptor);
  const transaction = analyzeDirectCompatibility(new Uint8Array(0), {
    family: "sram",
    sourceSaveType: "SRAM_V111",
    sramWriteVerify: [{ offset: 0x100 }],
    sramReadbackVerify: true,
  }, analyzerDescriptor);
  assert.equal(transaction.profile, "sram-transaction-v16");
  assert.equal(transaction.runtime, analyzerTransactionRuntime);
}

for (const forbidden of [
  /\b(?:gameCode|gameCodes|romHash|knownRoms|knownGames)\b/i,
  /\b(?:0x(?:a[0-9a-f]|b[01c])|1(?:6[0-9]|7[0-7]|88))\b/i,
]) {
  assert.doesNotMatch(strategySource, forbidden, `forbidden Direct strategy token: ${forbidden}`);
}

for (const relative of strategyFiles) {
  const source = await readFile(path.join(repository, relative), "utf8");
  assert.doesNotMatch(
    source,
    /hexToBytes\(\s*["'`][0-9a-f]{12,}/i,
    `${relative}: ABI byte signatures must live in direct-abi-signatures.js`,
  );
}

for (const [sourceSaveType, eepromRuntimeTimer, expectedProfile, expectedMode] of [
  ["EEPROM_V120", true, "eeprom-v120-runtime-timer", "settled-wrapper"],
  ["EEPROM_V121", true, "eeprom-v120-runtime-timer", "settled-wrapper"],
  ["EEPROM_V122", false, "eeprom-v5", "settled-wrapper"],
  ["EEPROM_V124", false, "eeprom-v5", "direct"],
]) {
  const plan = analyzeDirectCompatibility(new Uint8Array(0), {
    family: "eeprom",
    sourceSaveType,
    eepromRuntimeTimer,
  }, analyzerDescriptor);
  assert.equal(plan.profile, expectedProfile);
  assert.equal(plan.eepromWriteMode, expectedMode);
}

function repairHeaderChecksum(bytes) {
  let sum = 0;
  for (let offset = 0xa0; offset <= 0xbc; offset += 1) sum += bytes[offset];
  bytes[0xbd] = (-(sum + 0x19)) & 0xff;
}

function mutateHeader(source, seed) {
  const bytes = source.slice();
  for (let offset = 0xa0; offset <= 0xb1; offset += 1) {
    bytes[offset] = 0x41 + ((seed + offset * 7) % 26);
  }
  bytes[0xbc] = (bytes[0xbc] + seed + 1) & 0xff;
  repairHeaderChecksum(bytes);
  return bytes;
}

function operationPlan(result) {
  return result.result.operations
    .filter((operation) => operation.offset < 0xa0 || operation.offset >= 0xc0)
    .map((operation) => ({
      kind: operation.kind,
      component: operation.component,
      offset: operation.offset,
      byteLength: operation.byteLength,
      codeName: operation.metadata?.codeName ?? null,
      value: operation.metadata?.value ?? null,
      replacement: operation.replacement,
    }));
}

function assertDirectSize(name, patched, expectedProtocol) {
  const runtime = patched.result.saveRuntime;
  const constants = generatedRuntimes.find(
    (candidate) => candidate.constants.FLASH_DIRECT_PAYLOAD_SIZE === runtime.payloadSize,
  )?.constants;
  assert.ok(constants, `${name}: generated runtime`);
  const payloadView = new DataView(
    patched.bytes.buffer,
    patched.bytes.byteOffset,
    patched.bytes.byteLength,
  );
  const configuredLayout = payloadView.getUint32(
    runtime.payloadOffset + constants.DIRECT_LAYOUT_CONFIG_OFFSET,
    true,
  );
  assert.equal(
    configuredLayout,
    constants[runtime.family === "eeprom" ? "DIRECT_LAYOUT_EEPROM" : "DIRECT_LAYOUT_SRAM"],
    `${name}: payload layout`,
  );
  assert.equal(
    payloadView.getUint32(
      runtime.payloadOffset + constants.DIRECT_SAVE_PROTOCOL_CONFIG_OFFSET,
      true,
    ),
    expectedProtocol,
    `${name}: payload protocol`,
  );
  if (runtime.family === "eeprom") {
    assert.equal(patched.result.logicalSaveSizeBytes, 8192, `${name}: result size`);
    assert.ok([512, 8192].includes(patched.result.headerSaveSizeBytes), `${name}: export size`);
    assert.equal(
      patched.bytes[0xbf] & 0x07,
      patched.result.headerSaveSizeBytes === 512 ? 1 : 2,
      `${name}: EEPROM export-size bits`,
    );
  } else {
    assert.equal(patched.result.logicalSaveSizeBytes, 32768, `${name}: result size`);
    assert.equal(patched.result.headerSaveSizeBytes, 65536, `${name}: SRAM target size`);
    assert.equal(patched.bytes[0xbf] & 0x07, 4, `${name}: SRAM target-size bits`);
  }
  assert.equal(patched.bytes[0xbf] & 0x18, 0x18, `${name}: FLASH medium`);
  assert.equal(patched.result.targetSaveSizeBytes, 65536, `${name}: physical target size`);
}

function writeU32(bytes, offset, value) {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .setUint32(offset, value >>> 0, true);
}

function writeU16(bytes, offset, value) {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .setUint16(offset, value & 0xffff, true);
}

function syntheticDirectSramRom() {
  const bytes = new Uint8Array(0x100000);
  const saveType = "SRAM_F_V102";
  const layout = DIRECT_SRAM_LAYOUTS[saveType];
  const anchor = 0x200;
  bytes[0xb2] = 0x96;
  for (let index = 0; index < saveType.length; index += 1) {
    bytes[0x100 + index] = saveType.charCodeAt(index);
  }
  bytes.set(layout.read.marker, anchor + layout.read.offset);
  bytes.set(layout.write.marker, anchor + layout.write.offset);
  bytes.set(layout.verify.marker, anchor + layout.verify.offset);
  repairHeaderChecksum(bytes);
  return bytes;
}

function emitBl(bytes, offset, target) {
  let displacement = target - (offset + 4);
  if (displacement < 0) displacement += 0x800000;
  writeU16(bytes, offset, 0xf000 | ((displacement >>> 12) & 0x7ff));
  writeU16(bytes, offset + 2, 0xf800 | ((displacement >>> 1) & 0x7ff));
}

function emitWriteVerifyWrapper(bytes, offset, writeTarget, verifyTarget, {
  badArguments = false,
  badStatus = false,
} = {}) {
  const words = [
    0xb570, // push {r4-r6, lr}
    0x1c06, // r6 = destination argument
    0x1c0c, // r4 = source argument
    0x1c15, // r5 = size argument
    0x1c20, // r0 = source
    0x1c31, // r1 = destination
  ];
  words.forEach((word, index) => writeU16(bytes, offset + index * 2, word));
  emitBl(bytes, offset + 12, writeTarget);
  writeU16(bytes, offset + 16, 0x1c20);
  writeU16(bytes, offset + 18, 0x1c31);
  writeU16(bytes, offset + 20, badArguments ? 0x1c22 : 0x1c2a);
  emitBl(bytes, offset + 22, verifyTarget);
  writeU16(bytes, offset + 26, 0x2800);
  writeU16(bytes, offset + 28, 0xd002);
  writeU16(bytes, offset + 30, 0x2001);
  writeU16(bytes, offset + 32, badStatus ? 0x4249 : 0x4240);
  writeU16(bytes, offset + 34, 0xe000);
  writeU16(bytes, offset + 36, 0x2000);
  writeU16(bytes, offset + 38, 0xbc70);
  writeU16(bytes, offset + 40, 0xbc02);
  writeU16(bytes, offset + 42, 0x4708);
}

for (const [offset, localBase] of [[0x20, 0], [0x80, 0x40]]) {
  const fixture = new Uint8Array(0x180);
  const writeTarget = 0x120;
  const verifyTarget = 0x140;
  emitWriteVerifyWrapper(fixture, offset, writeTarget, verifyTarget);
  assert.deepEqual(
    analyzeSramWriteVerifyWrappers(fixture, [writeTarget], [verifyTarget])
      .map((wrapper) => wrapper.offset),
    [offset],
    `relocated write/verify wrapper ${localBase} must be proved`,
  );
  const badArguments = new Uint8Array(fixture);
  emitWriteVerifyWrapper(badArguments, offset, writeTarget, verifyTarget, {
    badArguments: true,
  });
  assert.deepEqual(
    analyzeSramWriteVerifyWrappers(badArguments, [writeTarget], [verifyTarget]),
    [],
  );
  const badStatus = new Uint8Array(fixture);
  emitWriteVerifyWrapper(badStatus, offset, writeTarget, verifyTarget, {
    badStatus: true,
  });
  assert.deepEqual(
    analyzeSramWriteVerifyWrappers(badStatus, [writeTarget], [verifyTarget]),
    [],
  );
}

function emitLiteralLoad(bytes, offset, register, literal) {
  const pc = (offset + 4) & ~3;
  assert.equal((literal - pc) % 4, 0);
  writeU16(bytes, offset, 0x4800 | (register << 8) | ((literal - pc) / 4));
}

function emitCallback(bytes, offset, hook) {
  writeU16(bytes, offset, 0xb500);
  emitBl(bytes, offset + 2, hook);
  writeU16(bytes, offset + 6, 0xbc01);
  writeU16(bytes, offset + 8, 0x4700);
}

function emitTransaction(bytes, start, tableOffset, callbackField, bankRegister, {
  intermediateRead = false,
  earlyReturn = false,
} = {}) {
  const dispatch = 0x3800;
  const literal = start + 0x30;
  const loop = start + 8;
  writeU16(bytes, start, 0xb500);
  emitLiteralLoad(bytes, start + 2, 4, literal);
  writeU16(bytes, start + 4, 0x2000 | (bankRegister << 8) | 0xfc);
  writeU16(bytes, start + 6, 0x0180 | (bankRegister << 3) | bankRegister);
  writeU16(bytes, loop, 0x6860); // source field +4
  writeU16(bytes, loop + 2, 0x68a2); // length field +8
  writeU16(bytes, loop + 4, 0x68e1); // save address field +12
  writeU16(bytes, loop + 6, (callbackField === 16 ? 0x6923 : 0x6963));
  if (callbackField === 20 && intermediateRead) writeU16(bytes, start + 6, 0x6927);
  emitBl(bytes, loop + 8, dispatch);
  writeU16(bytes, loop + 12, 0x3418); // record += sizeof(record)
  writeU16(bytes, loop + 14, 0x3501);
  writeU16(bytes, loop + 16, 0x2d03); // four records, derived by CFG
  if (earlyReturn) writeU16(bytes, loop + 14, 0x4770);
  const branch = loop + 18;
  const displacement = ((loop - (branch + 4)) >> 1) & 0xff;
  writeU16(bytes, branch, 0xdd00 | displacement);
  emitLiteralLoad(bytes, loop + 20, 0, literal + 4);
  emitLiteralLoad(bytes, loop + 22, 1, literal + 8);
  writeU16(bytes, loop + 24, 0xbc01);
  writeU16(bytes, loop + 26, 0x4700);
  writeU32(bytes, literal, 0x08000000 + tableOffset);
  writeU32(bytes, literal + 4, 0x02000100);
  writeU32(bytes, literal + 8, 0x02003d00);
  writeU16(bytes, dispatch, 0x4718); // compiler interworking veneer: bx r3
}

function syntheticSnapshotRom({
  tableOffset = 0x1000,
  referenceOffset = 0x200,
  bankRegister = 0,
  badCallback = false,
  ephemeralSource = false,
  overlap = false,
  duplicate = false,
  embeddedOnly = false,
  intermediateRead = false,
  earlyReturn = false,
} = {}) {
  const bytes = new Uint8Array(0x5000);
  const starts = [0x100, 0x1000, 0x1f00, overlap ? 0x2000 : 0x2e00];
  const length = 0xf00;
  const emitTable = (at, sourceDelta = 0) => {
    starts.forEach((logicalStart, index) => {
      const record = at + index * 24;
      writeU32(bytes, record, 0x08003000 + index * 4);
      writeU32(bytes, record + 4,
        (ephemeralSource ? 0x03000100 : 0x02000100) + sourceDelta + index * length);
      writeU32(bytes, record + 8, length);
      writeU32(bytes, record + 12, 0x0e000000 + logicalStart);
      writeU32(bytes, record + 16, badCallback && index === 2 ? 0x08003100 : 0x08003101);
      writeU32(bytes, record + 20, 0x08003201);
    });
  };
  emitTable(tableOffset);
  emitCallback(bytes, 0x3100, 0x3500);
  emitCallback(bytes, 0x3200, 0x3600);
  if (!embeddedOnly) {
    emitTransaction(bytes, referenceOffset, tableOffset, 16, bankRegister);
    emitTransaction(bytes, referenceOffset + 0x80, tableOffset, 20, bankRegister, {
      intermediateRead,
      earlyReturn,
    });
  }
  if (duplicate) {
    emitTable(tableOffset + 0x200, 0x4000);
    emitTransaction(bytes, referenceOffset + 0x100, tableOffset + 0x200, 16, bankRegister);
    emitTransaction(bytes, referenceOffset + 0x180, tableOffset + 0x200, 20, bankRegister);
  }
  return bytes;
}

const syntheticHooks = Object.freeze({
  family: "sram",
  sramRead: Object.freeze([0x3500]),
  sramWrite: Object.freeze([Object.freeze({ offsets: Object.freeze([0x3600]) })]),
});
const synthetic = analyzeBatchedSramSnapshot(syntheticSnapshotRom(), syntheticHooks);
assert.ok(synthetic, "semantic snapshot fixture must opt in");
assert.deepEqual(synthetic.transientRanges, [{
  logicalStart: 0,
  length: 0x100,
  sourceAddress: 0x02007900,
}]);
assert.equal(synthetic.providers.length, 8);
for (const options of [
  { badCallback: true },
  { ephemeralSource: true },
  { overlap: true },
  { duplicate: true },
  { embeddedOnly: true },
  { intermediateRead: true },
  { earlyReturn: true },
]) {
  assert.equal(
    analyzeBatchedSramSnapshot(syntheticSnapshotRom(options), syntheticHooks),
    null,
    `unsafe snapshot fixture must fail closed: ${JSON.stringify(options)}`,
  );
}
for (const [tableOffset, referenceOffset, bankRegister] of [
  [0x1800, 0x400, 3],
  [0x2400, 0x800, 6],
]) {
  const relocated = analyzeBatchedSramSnapshot(
    syntheticSnapshotRom({ tableOffset, referenceOffset, bankRegister }),
    syntheticHooks,
  );
  assert.ok(relocated, "relocated/register-varied snapshot fixture must opt in");
  assert.deepEqual(relocated.providers, synthetic.providers);
  assert.deepEqual(relocated.transientRanges, synthetic.transientRanges);
  assert.equal(relocated.commitFirst, synthetic.commitFirst);
  assert.equal(relocated.commitSize, synthetic.commitSize);
}

const embeddedSaveAccess = new Uint8Array(0x40);
writeU16(embeddedSaveAccess, 2, 0x4903); // ldr r1, [pc, #12]
writeU16(embeddedSaveAccess, 4, 0x7808); // ldrb r0, [r1]
writeU16(embeddedSaveAccess, 6, 0x4770);
writeU32(embeddedSaveAccess, 0x10, 0x0e000000);
assert.deepEqual(
  inventoryLiteralSaveAccesses(embeddedSaveAccess),
  [],
  "embedded Save-aperture bytes without a Thumb CFG must not match",
);
writeU16(embeddedSaveAccess, 0, 0xb500);
assert.equal(inventoryLiteralSaveAccesses(embeddedSaveAccess).length, 1);
assert.throws(
  () => analyzeDirectSramAccesses(embeddedSaveAccess),
  /unsupported Save-aperture read/,
);
assert.doesNotThrow(() => analyzeDirectSramAccesses(
  embeddedSaveAccess,
  { allowedFunctionStarts: [0] },
));

const policyInputs = [["synthetic SRAM_F_V102", syntheticDirectSramRom()]];
for (const inputPath of process.argv.slice(2)) {
  policyInputs.push([inputPath, new Uint8Array(await readFile(inputPath))]);
}
for (const [inputName, source] of policyInputs) {
  for (const [name, expectedProtocol, patch] of [
    ["standard", BASE_PAYLOAD_CONSTANTS.DIRECT_PROTOCOL_STANDARD,
      (bytes) => patchFlash512kBytes(bytes)],
    ["custom-type-1", BASE_PAYLOAD_CONSTANTS.DIRECT_PROTOCOL_CUSTOM_TYPE_1,
      (bytes) => patchCustomFlashBytes(bytes, { saveChipType: 1 })],
    ["custom-type-2", BASE_PAYLOAD_CONSTANTS.DIRECT_PROTOCOL_CUSTOM_TYPE_2,
      (bytes) => patchCustomFlashBytes(bytes, { saveChipType: 2 })],
  ]) {
    const baseline = patch(source);
    assertDirectSize(`${inputName}: ${name}`, baseline, expectedProtocol);
    if (name.startsWith("custom")) assert.equal(baseline.result.mode, "custom-flash");
    for (const seed of [1, 17, 93]) {
      const changed = patch(mutateHeader(source, seed));
      assert.deepEqual(
        changed.result.saveRuntime,
        baseline.result.saveRuntime,
        `${name}: header mutation changed the selected runtime`,
      );
      assert.deepEqual(
        operationPlan(changed),
        operationPlan(baseline),
        `${name}: header mutation changed non-header operations`,
      );
    }
  }
}

console.log(`Direct universal policy: ok (${policyInputs.length} ROM fixtures)`);
