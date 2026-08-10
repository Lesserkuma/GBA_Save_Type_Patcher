// SPDX-License-Identifier: GPL-3.0-or-later AND MIT

import {
  findBytes,
  readU16,
  readU32,
  writeU16,
  writeU32,
} from "../core/binary.js";
import { PatchError } from "../core/errors.js";
import {
  GBA_EWRAM_END_ADDRESS,
  GBA_EWRAM_START_ADDRESS,
  GBA_IWRAM_END_ADDRESS,
  GBA_IWRAM_START_ADDRESS,
  GBA_ROM_BASE_ADDRESS,
  GBA_ROM_LAST_MIRROR_BASE_ADDRESS,
} from "../domain/gba-constants.js";
import { PATCH_OPERATION_KIND } from "../domain/constants.js";
import { stagePatchOperation } from "../patch-engine/draft.js";
import {
  buildEepromV120FlashTimingHook,
  buildEepromV12xWriteCompatHook,
} from "./eeprom-v12x-write-compat.js";
import {
  analyzeDirectSramAccesses,
  analyzeSramWriteVerifyWrappers,
  verifyResultNeedsReadback,
} from "./thumb-direct-sram-analysis.js";
import {
  DIRECT_EEPROM_V11X_ANCHOR,
  DIRECT_EEPROM_V11X_LAYOUTS,
  DIRECT_SDK_HOOKS,
  DIRECT_SRAM_LAYOUTS,
} from "./direct-abi-signatures.js";


const FLASH512K_THUMB_BRANCH_THUNK = Uint8Array.of(0x00, 0x4b, 0x18, 0x47);
const FLASH512K_ARM_BRANCH_THUNK = Uint8Array.of(
  0x00, 0x30, 0x9f, 0xe5, 0x13, 0xff, 0x2f, 0xe1,
);

const FLASH512K_HOOKS = DIRECT_SDK_HOOKS;
const EEPROM_V11X_HOOK_LAYOUTS = DIRECT_EEPROM_V11X_LAYOUTS;
const EEPROM_V11X_ANCHOR = DIRECT_EEPROM_V11X_ANCHOR;
const DIRECT_SRAM_HOOK_LAYOUTS = DIRECT_SRAM_LAYOUTS;

export const DIRECT_SRAM_SAVE_TYPES = new Set(Object.keys(DIRECT_SRAM_HOOK_LAYOUTS));

function allFlash512kMatches(bytes, marker, alignment = 2) {
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
    sramWriteVerify: analyzeSramWriteVerifyWrappers(
      bytes,
      sramWrite.flatMap((hook) => hook.offsets),
      sramVerify,
    ),
    sramReadbackVerify: verifyResultNeedsReadback(bytes, sramVerify),
    eepromWrite,
    eepromRead,
    eepromVerify,
    eepromMeta,
  };
}

function patchThumbHook(
  bytes,
  operations,
  label,
  name,
  offset,
  target,
  codeName = "flash512k_thumb_hook",
) {
  const replacement = new Uint8Array(8);
  replacement.set(FLASH512K_THUMB_BRANCH_THUNK);
  writeU32(replacement, FLASH512K_THUMB_BRANCH_THUNK.length, target);
  stagePatchOperation(bytes, operations, {
    id: `save-runtime-${operations.length}`,
    kind: PATCH_OPERATION_KIND.HOOK_REPLACE,
    component: "saveRuntime",
    offset,
    byteLength: replacement.length,
    expectedBefore: bytes.slice(offset, offset + replacement.length),
    replacement,
    labelKey: "operation.saveRuntime",
    metadata: {
      name: `${label} ${name} hook`,
      value: target,
      codeName,
    },
  });
}

function patchThumbCall(bytes, operations, label, name, offset, targetOffset) {
  const delta = targetOffset - offset - 4;
  if ((delta & 1) !== 0 || delta < -0x400000 || delta > 0x3ffffe) {
    throw new PatchError(`${label} ${name} target is outside Thumb BL range.`);
  }
  const replacement = new Uint8Array(4);
  writeU16(replacement, 0, 0xf000 | ((delta >> 12) & 0x07ff));
  writeU16(replacement, 2, 0xf800 | ((delta >> 1) & 0x07ff));
  stagePatchOperation(bytes, operations, {
    id: `save-runtime-${operations.length}`,
    kind: PATCH_OPERATION_KIND.HOOK_REPLACE,
    component: "saveRuntime",
    offset,
    byteLength: replacement.length,
    expectedBefore: bytes.slice(offset, offset + replacement.length),
    replacement,
    labelKey: "operation.saveRuntime",
    metadata: {
      name: `${label} ${name}`,
      value: targetOffset,
      codeName: "flash512k_thumb_call_redirect",
    },
  });
}

function patchThumbHookWithCache(
  bytes,
  operations,
  label,
  name,
  offset,
  target,
  cacheAddress,
  clearCache = false,
) {
  if (!Number.isInteger(cacheAddress) || cacheAddress < 0 || cacheAddress > 0xffffffff) {
    throw new PatchError(`${label} ${name} cache address is invalid.`);
  }
  const replacement = new Uint8Array(clearCache ? 64 : 20);
  const halfwords = [
    0x4b02, // ldr r3, [pc, #8] (shared EWRAM cache)
    0xb410, // push {r4}
    0x4c02, // ldr r4, [pc, #8]
    0x46a4, // mov r12, r4
    0xbc10, // pop {r4}
    0x4760, // bx r12
  ];
  for (let index = 0; index < halfwords.length; index += 1) {
    replacement[index * 2] = halfwords[index] & 0xff;
    replacement[index * 2 + 1] = halfwords[index] >>> 8;
  }
  writeU32(replacement, 12, cacheAddress);
  writeU32(replacement, 16, target);
  stagePatchOperation(bytes, operations, {
    id: `save-runtime-${operations.length}`,
    kind: PATCH_OPERATION_KIND.HOOK_REPLACE,
    component: "saveRuntime",
    offset,
    byteLength: replacement.length,
    expectedBefore: bytes.slice(offset, offset + replacement.length),
    replacement,
    labelKey: "operation.saveRuntime",
    metadata: {
      name: `${label} ${name} cached hook`,
      value: target,
      codeName: "flash512k_thumb_cached_hook",
    },
  });
}

function romOffsetFromThumbAddress(address, length) {
  if (!Number.isInteger(address) || (address & 1) === 0) return null;
  const base = address & 0x0e000000;
  if (base < GBA_ROM_BASE_ADDRESS || base > GBA_ROM_LAST_MIRROR_BASE_ADDRESS) return null;
  const offset = (address & 0x01ffffff) >>> 0;
  return offset < length ? offset : null;
}

function writableCacheAddress(address) {
  if (!Number.isInteger(address) || address % 4) return false;
  return (address >= GBA_EWRAM_START_ADDRESS && address + 64 <= GBA_EWRAM_END_ADDRESS)
    || (address >= GBA_IWRAM_START_ADDRESS && address + 64 <= GBA_IWRAM_END_ADDRESS);
}

function nextReferencedWritableAddress(bytes, address) {
  const regionEnd = address < GBA_IWRAM_START_ADDRESS ? GBA_EWRAM_END_ADDRESS : GBA_IWRAM_END_ADDRESS;
  let next = regionEnd;
  for (let offset = 0; offset + 4 <= bytes.length; offset += 4) {
    const value = readU32(bytes, offset);
    if (value > address && value < next && value < regionEnd)
      next = value;
  }
  return next;
}

// Some SDK SRAM libraries copy ReadSram into WRAM during their own
// initialization while WriteSram continues to execute from ROM. The literal
// table immediately following the routines records the source and destination
// addresses. Recognizing that table gives every hook one stable cache address
// without relying on a game code or a fixed WRAM location.
function detectDirectSramCache(bytes, anchor, layout) {
  const readOffset = anchor + layout.read.offset;
  const writeOffset = anchor + layout.write.offset;
  const verifyOffset = anchor + layout.verify.offset;
  if (writeOffset - readOffset < 64) return null;
  const scanEnd = Math.min(bytes.length - 12, anchor + layout.verify.offset + 0x400);
  const readMappings = [];
  const verifyMappings = [];
  for (let offset = anchor & ~3; offset <= scanEnd; offset += 4) {
    const source = romOffsetFromThumbAddress(readU32(bytes, offset), bytes.length);
    const destination = readU32(bytes, offset + 4);
    const following = romOffsetFromThumbAddress(readU32(bytes, offset + 8), bytes.length);
    if (
      source === readOffset + 1
      && following === writeOffset + 1
      && writableCacheAddress(destination)
    ) readMappings.push({ destination });
    if (source === verifyOffset + 1 && writableCacheAddress(destination))
      verifyMappings.push({ destination });
  }
  if (readMappings.length !== 1 || verifyMappings.length !== 1) return null;
  const address = readMappings[0].destination + 64;
  if (nextReferencedWritableAddress(bytes, address) - address < 8) return null;
  return { storageOffset: readOffset + 64, address };
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
  requireRuntimeTimer,
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
      id: `save-runtime-${operations.length}`,
      kind: PATCH_OPERATION_KIND.HOOK_REPLACE,
      component: "saveRuntime",
      offset,
      byteLength: timing.replacement.length,
      expectedBefore: bytes.slice(offset, offset + timing.replacement.length),
      replacement: timing.replacement,
      labelKey: "operation.saveRuntime",
      metadata: {
        name: `${label} ${name} V120 runtime-state compatibility hook`,
        value: target,
        codeName: "flash512k_eeprom_v120_runtime_hook",
      },
    });
    return;
  }
  if (requireRuntimeTimer) {
    throw new PatchError(
      `${label} could not prove the complete Nintendo EEPROM V120/V121 timer ABI.`,
    );
  }
  const compat = buildEepromV12xWriteCompatHook(
    bytes,
    offset,
    compatTarget,
    gbaRomBase,
  );
  if (compat !== null) {
    stagePatchOperation(bytes, operations, {
      id: `save-runtime-${operations.length}`,
      kind: PATCH_OPERATION_KIND.HOOK_REPLACE,
      component: "saveRuntime",
      offset,
      byteLength: compat.replacement.length,
      expectedBefore: bytes.slice(offset, offset + compat.replacement.length),
      replacement: compat.replacement,
      labelKey: "operation.saveRuntime",
      metadata: {
        name: `${label} ${name} V12x SDK setup/cleanup wrapper`,
        value: compatTarget,
        codeName: "flash512k_eeprom_v12x_abi_hook",
      },
    });
    return;
  }
  patchThumbHook(bytes, operations, label, name, offset, target);
}

function patchArmHook(bytes, operations, label, name, offset, target) {
  const replacement = new Uint8Array(12);
  replacement.set(FLASH512K_ARM_BRANCH_THUNK);
  writeU32(replacement, FLASH512K_ARM_BRANCH_THUNK.length, target);
  stagePatchOperation(bytes, operations, {
    id: `save-runtime-${operations.length}`,
    kind: PATCH_OPERATION_KIND.HOOK_REPLACE,
    component: "saveRuntime",
    offset,
    byteLength: replacement.length,
    expectedBefore: bytes.slice(offset, offset + replacement.length),
    replacement,
    labelKey: "operation.saveRuntime",
    metadata: {
      name: `${label} ${name} hook`,
      value: target,
      codeName: "flash512k_arm_hook",
    },
  });
}

function flash512kTargetAddress(payloadBase, entry, gbaRomBase = GBA_ROM_BASE_ADDRESS) {
  return (gbaRomBase + payloadBase + entry) >>> 0;
}

export function applyFlash512kDetectedHooks(
  bytes,
  operations,
  hooks,
  payloadBase,
  descriptor,
  label = "512K FLASH",
  options = {},
) {
  const entries = descriptor.entries;

  if (hooks.family === "sram") {
    const cached = Number.isInteger(hooks.sramCacheAddress);
    const writeTarget = flash512kTargetAddress(
      payloadBase,
      cached ? entries.sramWriteCached : entries.sramWrite,
      descriptor.gbaRomBase,
    );
    for (const hook of hooks.sramWrite) {
      for (const offset of hook.offsets) {
        if (hook.thunk === "arm") patchArmHook(bytes, operations, label, hook.name, offset, writeTarget);
        else if (cached) {
          patchThumbHookWithCache(
            bytes, operations, label, hook.name, offset, writeTarget,
            hooks.sramCacheAddress,
          );
        } else patchThumbHook(bytes, operations, label, hook.name, offset, writeTarget);
      }
    }
    const readTarget = flash512kTargetAddress(
      payloadBase,
      cached ? entries.sramReadCached : entries.sramRead,
      descriptor.gbaRomBase,
    );
    for (const offset of hooks.sramRead) {
      if (cached) {
        patchThumbHookWithCache(
          bytes, operations, label, FLASH512K_HOOKS.sramRead.name,
          offset, readTarget, hooks.sramCacheAddress,
        );
      } else patchThumbHook(bytes, operations, label, FLASH512K_HOOKS.sramRead.name, offset, readTarget);
    }
    const verifyTarget = flash512kTargetAddress(
      payloadBase,
      cached ? entries.sramVerifyCached : entries.sramVerify,
      descriptor.gbaRomBase,
    );
    for (const offset of hooks.sramVerify) {
      if (cached) {
        patchThumbHookWithCache(
          bytes, operations, label, FLASH512K_HOOKS.sramVerify.name,
          offset, verifyTarget, hooks.sramCacheAddress,
        );
      } else patchThumbHook(bytes, operations, label, FLASH512K_HOOKS.sramVerify.name, offset, verifyTarget);
    }
    const writeVerifyTarget = flash512kTargetAddress(
      payloadBase,
      entries.sramWriteVerify,
      descriptor.gbaRomBase,
    );
    for (const wrapper of hooks.sramWriteVerify || []) {
      patchThumbHook(
        bytes, operations, label, "WriteSram+VerifySram transaction",
        wrapper.offset, writeVerifyTarget,
        "flash512k_thumb_write_verify_transaction",
      );
    }
    const tripletTarget = flash512kTargetAddress(
      payloadBase,
      cached ? entries.sramReadTripletCached : entries.sramReadTriplet,
      descriptor.gbaRomBase,
    );
    for (const offset of hooks.sramTripletRead || []) {
      if (cached) {
        patchThumbHookWithCache(
          bytes, operations, label, "direct SRAM triplet reader",
          offset, tripletTarget, hooks.sramCacheAddress,
        );
      } else {
        patchThumbHook(
          bytes, operations, label, "direct SRAM triplet reader",
          offset, tripletTarget,
        );
      }
    }
    const directTransfers = hooks.sramDirectTransfers || [];
    if (directTransfers.length > 0) {
      const readOffsets = hooks.sramRead;
      const writeOffsets = hooks.sramWrite
        .filter((hook) => hook.thunk === "thumb")
        .flatMap((hook) => hook.offsets);
      if (readOffsets.length !== 1 || writeOffsets.length !== 1) {
        throw new PatchError(
          `${label} cannot safely redirect direct SRAM transfers to ambiguous SDK hooks.`,
        );
      }
      for (const transfer of directTransfers) {
        const targetOffset = transfer.kind === "read" ? readOffsets[0] : writeOffsets[0];
        patchThumbCall(
          bytes,
          operations,
          label,
          `direct SRAM ${transfer.kind} transfer`,
          transfer.callOffset,
          targetOffset,
        );
      }
    }
  } else {
    const writeTarget = flash512kTargetAddress(
      payloadBase,
      options.eepromSettledCompat === true
        ? entries.eepromWriteSettled
        : entries.eepromWrite,
      descriptor.gbaRomBase,
    );
    const compatWriteTarget = flash512kTargetAddress(
      payloadBase,
      options.eepromSettledCompat === true
        ? entries.eepromWriteSettled
        : entries.eepromWrite,
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
        compatWriteTarget,
        descriptor.gbaRomBase,
        options.capabilityProfile === "eeprom-v120-runtime-timer",
      );
    }
    const readTarget = flash512kTargetAddress(payloadBase, entries.eepromRead, descriptor.gbaRomBase);
    for (const offset of hooks.eepromRead) {
      patchThumbHook(bytes, operations, label, FLASH512K_HOOKS.eepromRead.name, offset, readTarget);
    }
    const verifyTarget = flash512kTargetAddress(payloadBase, entries.eepromVerify, descriptor.gbaRomBase);
    for (const offset of hooks.eepromVerify) {
      patchThumbHook(bytes, operations, label, FLASH512K_HOOKS.eepromVerify.name, offset, verifyTarget);
    }
  }
}

export function validateFlash512kPayloadDescriptor(descriptor, label = "512K FLASH") {
  const { payload, signature, signatureOffset, entries } = descriptor;
  const sramEntries = [
    "sramWrite", "sramWriteCached", "sramWriteVerify", "sramRead",
    "sramReadCached", "sramReadTriplet", "sramReadTripletCached",
    "sramVerify", "sramVerifyCached", "sramVerifyFast",
  ];
  const eepromEntries = ["eepromWrite", "eepromWriteSettled", "eepromRead", "eepromVerify"];
  if (!["base", "snapshot", "transaction"].includes(descriptor.shape)) {
    throw new Error(`${label} payload shape is invalid.`);
  }
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
  if (sramEntries.some((name) => !Number.isInteger(entries?.[name]))) {
    throw new Error(`${label} SRAM entry ABI is incomplete.`);
  }
  if (!descriptor.families?.sram) {
    throw new Error(`${label} SRAM family ABI is incomplete.`);
  }
  const hasEepromAbi = eepromEntries.some((name) => Object.hasOwn(entries || {}, name))
    || Object.hasOwn(descriptor.families || {}, "eeprom");
  if (descriptor.shape === "base") {
    if (eepromEntries.some((name) => !Number.isInteger(entries?.[name]))
        || !descriptor.families?.eeprom) {
      throw new Error(`${label} Base EEPROM entry ABI is incomplete.`);
    }
  } else if (hasEepromAbi) {
    throw new Error(`${label} SRAM-only shape contains EEPROM ABI fields.`);
  }
  const snapshotFields = [
    "snapshotProviderCount", "snapshotCommitFirst", "snapshotCommitSize",
    "snapshotTransientCount", "snapshotProviders", "snapshotTransientRanges",
  ];
  if (descriptor.shape === "snapshot") {
    if (snapshotFields.some((name) => !Number.isInteger(descriptor.configFields?.[name]))) {
      throw new Error(`${label} Snapshot configuration ABI is incomplete.`);
    }
  } else if (snapshotFields.some((name) => Object.hasOwn(descriptor.configFields || {}, name))) {
    throw new Error(`${label} non-Snapshot shape contains Snapshot ABI fields.`);
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
  const cache = detectDirectSramCache(bytes, anchor, layout);
  const verifyOffset = anchor + layout.verify.offset;
  const directAccesses = analyzeDirectSramAccesses(bytes, {
    allowedFunctionStarts: [
      anchor + layout.read.offset,
      anchor + layout.write.offset,
      verifyOffset,
    ],
  });
  return {
    family: "sram",
    sramWrite: [{
      name: "WriteSram",
      thunk: "thumb",
      offsets: [anchor + layout.write.offset],
    }],
    sramRead: [anchor + layout.read.offset],
    sramVerify: [verifyOffset],
    sramWriteVerify: analyzeSramWriteVerifyWrappers(
      bytes,
      [anchor + layout.write.offset],
      [verifyOffset],
    ),
    sramReadbackVerify: verifyResultNeedsReadback(
      bytes,
      [verifyOffset],
      layout.readbackVerify === true,
    ),
    sramTripletRead: directAccesses.readers,
    sramDirectTransfers: directAccesses.transfers,
    ...(cache ? {
      sramCacheAddress: cache.address,
      sramCacheStorageOffset: cache.storageOffset,
    } : {}),
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
