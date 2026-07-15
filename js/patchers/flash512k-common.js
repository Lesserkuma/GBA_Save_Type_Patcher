// SPDX-License-Identifier: GPL-3.0-or-later AND MIT

import {
  findBytes,
  hexToBytes,
  readU32,
  writeU32,
} from "../core/binary.js";
import { PatchError } from "../core/errors.js";
import { PATCH_OPERATION_KIND } from "../domain/constants.js";
import { stagePatchOperation } from "../patch-engine/draft.js";
import {
  buildEepromV120FlashTimingHook,
  buildEepromV12xWriteCompatHook,
} from "./eeprom-v12x-write-compat.js";


export const FLASH512K_THUMB_BRANCH_THUNK = hexToBytes("004b1847");
export const FLASH512K_ARM_BRANCH_THUNK = hexToBytes("00309fe513ff2fe1");

export const FLASH512K_HOOKS = {
  sramWrite: [
    { name: "WriteSram", marker: hexToBytes("30b5051c0c1c131c0b4a10880b490840"), thunk: "thumb" },
    { name: "WriteSram alternate", marker: hexToBytes("80b583b06f4638607960ba6009480949"), thunk: "thumb" },
    { name: "WriteSramFast", marker: hexToBytes("04c090e401c0c1e42cc4a0e101c0c1e4"), thunk: "arm" },
  ],
  sramRead: { name: "ReadSram", marker: hexToBytes("70b5a0b0041c0d1c161c084a10880849"), thunk: "thumb" },
  sramVerify: { name: "VerifySram", marker: hexToBytes("70b5b0b0041c0d1c161c084a10880849"), thunk: "thumb" },
  eepromWrite: { name: "ProgramEepromDword", marker: hexToBytes("70b500040a1c400be02109054118073100231078"), thunk: "thumb" },
  eepromRead: { name: "ReadEepromDword", marker: hexToBytes("70b500040a1c400be021090541180731"), thunk: "thumb" },
  eepromVerify: { name: "VerifyEepromDword", marker: hexToBytes("30b582b00c1c0004010c002503480068"), thunk: "thumb" },
  eepromMeta: { name: "IdentifyEeprom", marker: hexToBytes("0004000c0022042808d1024902480860") },
};

const EEPROM_V11X_HOOK_LAYOUTS = Object.freeze({
  EEPROM_V110: Object.freeze({
    read: Object.freeze({
      offset: 0x48,
      marker: hexToBytes("b0b5aab06f467960391c0880381c01883f2903d9004897e0"),
    }),
    write: Object.freeze({
      offset: 0x198,
      marker: hexToBytes("80b5aab06f467960391c0880381c01883f2903d90048b3e0"),
    }),
    verify: Object.freeze({
      offset: 0x320,
      marker: hexToBytes("b0b587b06f467960391c0880381c183000210180381c0188"),
    }),
  }),
  EEPROM_V111: Object.freeze({
    read: Object.freeze({
      offset: 0x48,
      marker: hexToBytes("b0b5aab06f467960391c0880381c01883f2903d9004899e0"),
    }),
    write: Object.freeze({
      offset: 0x19c,
      marker: hexToBytes("80b5aab06f467960391c0880381c01883f2903d90048bfe0"),
    }),
    verify: Object.freeze({
      offset: 0x33c,
      marker: hexToBytes("b0b587b06f467960391c0880381c183000210180381c0188"),
    }),
  }),
});

const EEPROM_V11X_ANCHOR = hexToBytes("0e48396801600e48796801600d48391c");

// These are original, unpatched Nintendo SDK SRAM library layouts. Direct
// hooks avoid first rewriting the library to a generic SRAM implementation.
const DIRECT_SRAM_HOOK_LAYOUTS = Object.freeze({
  SRAM_F_V100: Object.freeze({
    read: Object.freeze({
      offset: 0,
      marker: hexToBytes("80b583b06f4638607960ba60094809490a88094b111c1940"),
    }),
    write: Object.freeze({
      offset: 0x58,
      marker: hexToBytes("80b583b06f4638607960ba60094809490a88094b111c1940"),
    }),
    verify: Object.freeze({
      offset: 0xb0,
      marker: hexToBytes("90b583b06f4638607960ba60094809490a88094b111c1940"),
    }),
  }),
  SRAM_F_V102: Object.freeze({
    read: Object.freeze({
      offset: 0,
      marker: hexToBytes("30b5051c0c1c131c0b4a10880b490840032108431080013b"),
    }),
    write: Object.freeze({
      offset: 0x40,
      marker: hexToBytes("30b5051c0c1c131c0b4a10880b490840032108431080013b"),
    }),
    verify: Object.freeze({
      offset: 0x80,
      marker: hexToBytes("30b5051c0c1c131c0a4a10880a490840032108431080013b"),
    }),
  }),
  SRAM_F_V103: Object.freeze({
    read: Object.freeze({
      offset: 0,
      marker: hexToBytes("30b5051c0c1c131c0b4a10880b490840032108431080013b"),
    }),
    write: Object.freeze({
      offset: 0x40,
      marker: hexToBytes("30b5051c0c1c131c0b4a10880b490840032108431080013b"),
    }),
    verify: Object.freeze({
      offset: 0x80,
      marker: hexToBytes("30b5051c0c1c131c0a4a10880a490840032108431080013b"),
    }),
  }),
  SRAM_F_V110: Object.freeze({
    read: Object.freeze({
      offset: 0,
      marker: hexToBytes("30b5051c0c1c131c0b4a10880b490840032108431080013b"),
    }),
    write: Object.freeze({
      offset: 0x40,
      marker: hexToBytes("f0b5041c0e1c151c034a1088034908400321084310800ae0"),
    }),
    verify: Object.freeze({
      offset: 0xb0,
      marker: hexToBytes("30b5051c0c1c131c0a4a10880a490840032108431080013b"),
    }),
  }),
  SRAM_V110: Object.freeze({
    read: Object.freeze({
      offset: 0,
      marker: hexToBytes("90b5a7b06f4638607960ba60174817490a88174b111c1940"),
    }),
    write: Object.freeze({
      offset: 0xd8,
      marker: hexToBytes("80b583b06f4638607960ba60094809490a88094b111c1940"),
    }),
    verify: Object.freeze({
      offset: 0x178,
      marker: hexToBytes("90b5b7b06f4638607960ba60174817490a88174b111c1940"),
    }),
  }),
});

export const DIRECT_SRAM_SAVE_TYPES = new Set(Object.keys(DIRECT_SRAM_HOOK_LAYOUTS));

export function allFlash512kMatches(bytes, marker, alignment = 2) {
  const matches = [];
  let position = 0;
  while (position <= bytes.length - marker.length) {
    const offset = findBytes(bytes, marker, position);
    if (offset < 0) break;
    if (alignment <= 1 || offset % alignment === 0) matches.push(offset);
    position = offset + 1;
  }
  return matches;
}

export function detectFlash512kHookSet(bytes, label = "512K FLASH", expectedFamily = null) {
  if (expectedFamily !== null && expectedFamily !== "sram" && expectedFamily !== "eeprom") {
    throw new PatchError(`${label} received an invalid expected hook family.`);
  }
  const sramWrite = FLASH512K_HOOKS.sramWrite.map((hook) => ({ ...hook, offsets: allFlash512kMatches(bytes, hook.marker) }));
  const sramRead = allFlash512kMatches(bytes, FLASH512K_HOOKS.sramRead.marker);
  const sramVerify = allFlash512kMatches(bytes, FLASH512K_HOOKS.sramVerify.marker);
  const eepromWrite = allFlash512kMatches(bytes, FLASH512K_HOOKS.eepromWrite.marker);
  const eepromWriteOffsets = new Set(eepromWrite);
  const eepromRead = allFlash512kMatches(bytes, FLASH512K_HOOKS.eepromRead.marker)
    .filter((offset) => !eepromWriteOffsets.has(offset));
  const eepromVerify = allFlash512kMatches(bytes, FLASH512K_HOOKS.eepromVerify.marker);
  const eepromMeta = allFlash512kMatches(bytes, FLASH512K_HOOKS.eepromMeta.marker)
    .filter((offset) => offset + 24 <= bytes.length);
  const sramWriteCount = sramWrite.reduce((total, hook) => total + hook.offsets.length, 0);
  const sramComplete = sramWriteCount > 0 && sramRead.length > 0;
  const eepromComplete = eepromWrite.length > 0 && eepromRead.length > 0;
  const sramAny = sramWriteCount > 0 || sramRead.length > 0 || sramVerify.length > 0;
  const eepromAny = eepromWrite.length > 0 || eepromRead.length > 0 || eepromVerify.length > 0 || eepromMeta.length > 0;

  const details = `SRAM write/read ${sramWriteCount}/${sramRead.length}, EEPROM write/read ${eepromWrite.length}/${eepromRead.length}`;
  if (expectedFamily === "sram" && !sramComplete) {
    throw new PatchError(`${label} could not find the expected SRAM save hook set (${details}).`);
  }
  if (expectedFamily === "eeprom" && !eepromComplete) {
    throw new PatchError(`${label} could not find the expected EEPROM save hook set (${details}).`);
  }

  if (expectedFamily === null && ((sramComplete && eepromAny) || (eepromComplete && sramAny))) {
    throw new PatchError(`${label} found conflicting or incomplete SRAM and EEPROM hook sets.`);
  }
  if (expectedFamily === null && !sramComplete && !eepromComplete) {
    throw new PatchError(`${label} could not find a complete save hook set (${details}).`);
  }

  if (expectedFamily === "eeprom" || (expectedFamily === null && eepromComplete)) {
    return { family: "eeprom", sramWrite, sramRead, sramVerify, eepromWrite, eepromRead, eepromVerify, eepromMeta };
  }
  return {
    family: "sram",
    sramWrite,
    sramRead,
    sramVerify,
    eepromWrite,
    eepromRead,
    eepromVerify,
    eepromMeta,
  };
}

function patchThumbHook(bytes, operations, label, name, offset, target) {
  const replacement = new Uint8Array(8);
  replacement.set(FLASH512K_THUMB_BRANCH_THUNK);
  writeU32(replacement, FLASH512K_THUMB_BRANCH_THUNK.length, target);
  stagePatchOperation(bytes, operations, {
    id: `flash-journal-${operations.length}`,
    kind: PATCH_OPERATION_KIND.HOOK_REPLACE,
    component: "flashJournal",
    offset,
    byteLength: replacement.length,
    expectedBefore: bytes.slice(offset, offset + replacement.length),
    replacement,
    labelKey: "operation.flashJournal",
    metadata: {
      name: `${label} ${name} hook`,
      value: target,
      codeName: "flash512k_thumb_hook",
    },
  });
}

function patchEepromWriteHook(
  bytes,
  operations,
  label,
  name,
  offset,
  target,
  compatTarget,
  gbaRomBase,
) {
  const normalizationOperations = operations.filter((operation) => (
    operation.offset === offset
    && operation.metadata?.codeName === "eeprom_write"
    && operation.expectedBefore instanceof Uint8Array
  ));
  const timing = normalizationOperations.length === 1
    ? buildEepromV120FlashTimingHook(
      bytes,
      offset,
      target,
      normalizationOperations[0].expectedBefore,
      gbaRomBase,
    )
    : null;
  if (timing !== null) {
    stagePatchOperation(bytes, operations, {
      id: `flash-journal-${operations.length}`,
      kind: PATCH_OPERATION_KIND.HOOK_REPLACE,
      component: "flashJournal",
      offset,
      byteLength: timing.replacement.length,
      expectedBefore: bytes.slice(offset, offset + timing.replacement.length),
      replacement: timing.replacement,
      labelKey: "operation.flashJournal",
      metadata: {
        name: `${label} ${name} V120 timer-edge compatibility hook`,
        value: target,
        codeName: "flash512k_eeprom_v120_timing_hook",
      },
    });
    return;
  }
  const compat = buildEepromV12xWriteCompatHook(
    bytes,
    offset,
    compatTarget,
    gbaRomBase,
  );
  if (compat === null) {
    patchThumbHook(bytes, operations, label, name, offset, target);
    return;
  }
  stagePatchOperation(bytes, operations, {
    id: `flash-journal-${operations.length}`,
    kind: PATCH_OPERATION_KIND.HOOK_REPLACE,
    component: "flashJournal",
    offset,
    byteLength: compat.replacement.length,
    expectedBefore: bytes.slice(offset, offset + compat.replacement.length),
    replacement: compat.replacement,
    labelKey: "operation.flashJournal",
    metadata: {
      name: `${label} ${name} SDK timer compatibility hook`,
      value: compatTarget,
      codeName: "flash512k_eeprom_v12x_compat_hook",
    },
  });
}

function patchArmHook(bytes, operations, label, name, offset, target) {
  const replacement = new Uint8Array(12);
  replacement.set(FLASH512K_ARM_BRANCH_THUNK);
  writeU32(replacement, FLASH512K_ARM_BRANCH_THUNK.length, target);
  stagePatchOperation(bytes, operations, {
    id: `flash-journal-${operations.length}`,
    kind: PATCH_OPERATION_KIND.HOOK_REPLACE,
    component: "flashJournal",
    offset,
    byteLength: replacement.length,
    expectedBefore: bytes.slice(offset, offset + replacement.length),
    replacement,
    labelKey: "operation.flashJournal",
    metadata: {
      name: `${label} ${name} hook`,
      value: target,
      codeName: "flash512k_arm_hook",
    },
  });
}

export function flash512kTargetAddress(payloadBase, entry, gbaRomBase = 0x08000000) {
  return (gbaRomBase + payloadBase + entry) >>> 0;
}

export function applyFlash512kDetectedHooks(bytes, operations, hooks, payloadBase, descriptor, label = "512K FLASH") {
  const entries = descriptor.entries;
  const counts = {
    sramWrite: 0,
    sramRead: 0,
    sramVerify: 0,
    eepromWrite: 0,
    eepromRead: 0,
    eepromVerify: 0,
    eepromMeta: 0,
  };

  if (hooks.family === "sram") {
    const writeTarget = flash512kTargetAddress(payloadBase, entries.sramWrite, descriptor.gbaRomBase);
    for (const hook of hooks.sramWrite) {
      for (const offset of hook.offsets) {
        if (hook.thunk === "arm") patchArmHook(bytes, operations, label, hook.name, offset, writeTarget);
        else patchThumbHook(bytes, operations, label, hook.name, offset, writeTarget);
        counts.sramWrite += 1;
      }
    }
    const readTarget = flash512kTargetAddress(payloadBase, entries.sramRead, descriptor.gbaRomBase);
    for (const offset of hooks.sramRead) {
      patchThumbHook(bytes, operations, label, FLASH512K_HOOKS.sramRead.name, offset, readTarget);
      counts.sramRead += 1;
    }
    const verifyTarget = flash512kTargetAddress(payloadBase, entries.sramVerify, descriptor.gbaRomBase);
    for (const offset of hooks.sramVerify) {
      patchThumbHook(bytes, operations, label, FLASH512K_HOOKS.sramVerify.name, offset, verifyTarget);
      counts.sramVerify += 1;
    }
  } else {
    const writeTarget = flash512kTargetAddress(payloadBase, entries.eepromWrite, descriptor.gbaRomBase);
    const writeCompatTarget = flash512kTargetAddress(
      payloadBase,
      entries.eepromWriteCompat,
      descriptor.gbaRomBase,
    );
    for (const offset of hooks.eepromWrite) {
      patchEepromWriteHook(
        bytes,
        operations,
        label,
        FLASH512K_HOOKS.eepromWrite.name,
        offset,
        writeTarget,
        writeCompatTarget,
        descriptor.gbaRomBase,
      );
      counts.eepromWrite += 1;
    }
    const readTarget = flash512kTargetAddress(payloadBase, entries.eepromRead, descriptor.gbaRomBase);
    for (const offset of hooks.eepromRead) {
      patchThumbHook(bytes, operations, label, FLASH512K_HOOKS.eepromRead.name, offset, readTarget);
      counts.eepromRead += 1;
    }
    const verifyTarget = flash512kTargetAddress(payloadBase, entries.eepromVerify, descriptor.gbaRomBase);
    for (const offset of hooks.eepromVerify) {
      patchThumbHook(bytes, operations, label, FLASH512K_HOOKS.eepromVerify.name, offset, verifyTarget);
      counts.eepromVerify += 1;
    }
    counts.eepromMeta = hooks.eepromMeta.length;
  }
  return counts;
}

export function validateFlash512kPayloadDescriptor(descriptor, label = "512K FLASH") {
  const { payload, signature, signatureOffset, entries } = descriptor;
  if (!payload?.length || descriptor.payloadSize !== payload.length) throw new Error(`${label} payload data is incomplete.`);
  if (payload.length % 4 !== 0) throw new Error(`${label} payload size must be 4-byte aligned.`);
  if (!signature?.length) throw new Error(`${label} payload marker is empty.`);
  if (allFlash512kMatches(payload, signature, 1).length !== 1) throw new Error(`${label} payload marker must occur exactly once.`);
  if (signatureOffset !== payload.length - signature.length) throw new Error(`${label} marker must terminate the payload.`);
  for (let index = 0; index < signature.length; index += 1) {
    if (payload[signatureOffset + index] !== signature[index]) throw new Error(`${label} marker does not match payload data.`);
  }
  for (const [name, entry] of Object.entries(entries || {})) {
    if (!Number.isInteger(entry) || entry < 0 || entry >= payload.length) throw new Error(`${label} ${name} entry is invalid.`);
    if ((entry & 1) !== 1) throw new Error(`${label} ${name} Thumb entry is missing its Thumb bit.`);
  }
  for (const range of descriptor.mutableRanges || []) {
    if (!Array.isArray(range) || range.length !== 2 || range[0] < 0 || range[1] < range[0] || range[1] > payload.length) {
      throw new Error(`${label} mutable payload range is invalid.`);
    }
  }
  const ranges = [...(descriptor.mutableRanges || [])].sort((a, b) => a[0] - b[0]);
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index][0] < ranges[index - 1][1]) throw new Error(`${label} config fields overlap.`);
  }
  for (const offset of Object.values(descriptor.configFields || {})) {
    if (!Number.isInteger(offset) || offset < 0 || offset + 4 > payload.length || offset % 4) {
      throw new Error(`${label} config field is invalid or unaligned.`);
    }
  }
  if (Number.isInteger(descriptor.configFields?.saveChipType) && readU32(payload, descriptor.configFields.saveChipType) !== 0) {
    throw new Error(`${label} chip-type template value must be zero.`);
  }
  if (Number.isInteger(descriptor.configFields?.rtcPersistEntry) && readU32(payload, descriptor.configFields.rtcPersistEntry) !== 0) {
    throw new Error(`${label} RTC persistence entry template value must be zero.`);
  }
}

function bytesMatchAt(bytes, offset, marker) {
  if (offset < 0 || offset + marker.length > bytes.length) return false;
  return marker.every((value, index) => bytes[offset + index] === value);
}

export function detectFlash512kEepromV11xHookSet(bytes, saveType, label = "512K FLASH") {
  const layout = EEPROM_V11X_HOOK_LAYOUTS[saveType];
  if (!layout) throw new PatchError(`${label} does not have an EEPROM hook layout for ${saveType}.`);
  const anchors = allFlash512kMatches(bytes, EEPROM_V11X_ANCHOR);
  const candidates = anchors.filter((anchor) =>
    bytesMatchAt(bytes, anchor + layout.read.offset, layout.read.marker)
    && bytesMatchAt(bytes, anchor + layout.write.offset, layout.write.marker)
    && bytesMatchAt(bytes, anchor + layout.verify.offset, layout.verify.marker));

  if (candidates.length !== 1) {
    throw new PatchError(`${label} could not find one complete ${saveType} hook set (found ${candidates.length}).`);
  }
  const anchor = candidates[0];
  return {
    family: "eeprom",
    sramWrite: [],
    sramRead: [],
    sramVerify: [],
    eepromWrite: [anchor + layout.write.offset],
    eepromRead: [anchor + layout.read.offset],
    eepromVerify: [anchor + layout.verify.offset],
    eepromMeta: [],
  };
}

export function detectFlash512kDirectSramHookSet(bytes, saveType, label = "512K FLASH") {
  const layout = DIRECT_SRAM_HOOK_LAYOUTS[saveType];
  if (!layout) throw new PatchError(`${label} does not have an SRAM hook layout for ${saveType}.`);
  const anchors = allFlash512kMatches(bytes, layout.read.marker);
  const candidates = anchors.filter((anchor) => (
    bytesMatchAt(bytes, anchor + layout.write.offset, layout.write.marker)
    && bytesMatchAt(bytes, anchor + layout.verify.offset, layout.verify.marker)
  ));

  if (candidates.length !== 1) {
    throw new PatchError(`${label} could not find one complete ${saveType} hook set (found ${candidates.length}).`);
  }
  const anchor = candidates[0];
  return {
    family: "sram",
    sramWrite: [{
      name: "WriteSram",
      thunk: "thumb",
      offsets: [anchor + layout.write.offset],
    }],
    sramRead: [anchor + layout.read.offset],
    sramVerify: [anchor + layout.verify.offset],
    eepromWrite: [],
    eepromRead: [],
    eepromVerify: [],
    eepromMeta: [],
  };
}

export function logicalFlash512kSaveSize(saveType, family = null) {
  if (family === "eeprom" || saveType?.startsWith("EEPROM")) return 8192;
  if (family === "sram" || saveType?.startsWith("SRAM")) return 32768;
  if (saveType?.startsWith("FLASH")) return 65536;
  return null;
}
