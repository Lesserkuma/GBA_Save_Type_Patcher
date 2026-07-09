import {
  copyBytes,
  findBytes,
  hexToBytes,
  readU32,
  writeU32,
} from "../core/binary.js";
import { PatchError } from "../core/errors.js";


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


export function addFlash512kOperation(operations, name, offset, size, details = {}) {
  const operation = { name, offset, size };
  if (details.value !== undefined) operation.value = details.value;
  if (details.codeName !== undefined) operation.code_name = details.codeName;
  operations.push(operation);
}

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

export function detectFlash512kHookSet(bytes, label = "512K FLASH") {
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

  if ((sramComplete && eepromAny) || (eepromComplete && sramAny)) {
    throw new PatchError(`${label} found conflicting or incomplete SRAM and EEPROM hook sets.`);
  }
  if (!sramComplete && !eepromComplete) {
    const details = `SRAM write/read ${sramWriteCount}/${sramRead.length}, EEPROM write/read ${eepromWrite.length}/${eepromRead.length}`;
    throw new PatchError(`${label} could not find a complete save hook set (${details}).`);
  }

  if (eepromComplete) {
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
  copyBytes(bytes, offset, FLASH512K_THUMB_BRANCH_THUNK);
  writeU32(bytes, offset + FLASH512K_THUMB_BRANCH_THUNK.length, target);
  addFlash512kOperation(operations, `${label} ${name} hook`, offset, 8, {
    value: target,
    codeName: "flash512k_thumb_hook",
  });
}

function patchArmHook(bytes, operations, label, name, offset, target) {
  copyBytes(bytes, offset, FLASH512K_ARM_BRANCH_THUNK);
  writeU32(bytes, offset + FLASH512K_ARM_BRANCH_THUNK.length, target);
  addFlash512kOperation(operations, `${label} ${name} hook`, offset, 12, {
    value: target,
    codeName: "flash512k_arm_hook",
  });
}

export function flash512kTargetAddress(payloadBase, entry, gbaRomBase = 0x08000000) {
  return (gbaRomBase + payloadBase + entry) >>> 0;
}

export function applyFlash512kDetectedHooks(bytes, operations, hooks, payloadBase, descriptor, label = "512K FLASH") {
  const entries = descriptor.entries;
  const counts = {
    sram_write: 0,
    sram_read: 0,
    sram_verify: 0,
    eeprom_write: 0,
    eeprom_read: 0,
    eeprom_verify: 0,
    eeprom_meta: 0,
  };

  if (hooks.family === "sram") {
    const writeTarget = flash512kTargetAddress(payloadBase, entries.sramWrite, descriptor.gbaRomBase);
    for (const hook of hooks.sramWrite) {
      for (const offset of hook.offsets) {
        if (hook.thunk === "arm") patchArmHook(bytes, operations, label, hook.name, offset, writeTarget);
        else patchThumbHook(bytes, operations, label, hook.name, offset, writeTarget);
        counts.sram_write += 1;
      }
    }
    const readTarget = flash512kTargetAddress(payloadBase, entries.sramRead, descriptor.gbaRomBase);
    for (const offset of hooks.sramRead) {
      patchThumbHook(bytes, operations, label, FLASH512K_HOOKS.sramRead.name, offset, readTarget);
      counts.sram_read += 1;
    }
    const verifyTarget = flash512kTargetAddress(payloadBase, entries.sramVerify, descriptor.gbaRomBase);
    for (const offset of hooks.sramVerify) {
      patchThumbHook(bytes, operations, label, FLASH512K_HOOKS.sramVerify.name, offset, verifyTarget);
      counts.sram_verify += 1;
    }
  } else {
    const writeTarget = flash512kTargetAddress(payloadBase, entries.eepromWrite, descriptor.gbaRomBase);
    for (const offset of hooks.eepromWrite) {
      patchThumbHook(bytes, operations, label, FLASH512K_HOOKS.eepromWrite.name, offset, writeTarget);
      counts.eeprom_write += 1;
    }
    const readTarget = flash512kTargetAddress(payloadBase, entries.eepromRead, descriptor.gbaRomBase);
    for (const offset of hooks.eepromRead) {
      patchThumbHook(bytes, operations, label, FLASH512K_HOOKS.eepromRead.name, offset, readTarget);
      counts.eeprom_read += 1;
    }
    const verifyTarget = flash512kTargetAddress(payloadBase, entries.eepromVerify, descriptor.gbaRomBase);
    for (const offset of hooks.eepromVerify) {
      patchThumbHook(bytes, operations, label, FLASH512K_HOOKS.eepromVerify.name, offset, verifyTarget);
      counts.eeprom_verify += 1;
    }
    counts.eeprom_meta = hooks.eepromMeta.length;
  }
  return counts;
}

function offsetIsMutable(offset, mutableRanges) {
  return mutableRanges.some(([start, end]) => offset >= start && offset < end);
}

export function validateFlash512kPayloadDescriptor(descriptor, label = "512K FLASH") {
  const { payload, signature, signatureOffset, entries } = descriptor;
  if (!payload?.length || descriptor.payloadSize !== payload.length) throw new Error(`${label} payload data is incomplete.`);
  if (payload.length % 4 !== 0) throw new Error(`${label} payload size must be 4-byte aligned.`);
  if (!signature?.length) throw new Error(`${label} payload marker is empty.`);
  if (signatureOffset !== payload.length - signature.length) throw new Error(`${label} marker must terminate the payload.`);
  for (let index = 0; index < signature.length; index += 1) {
    if (payload[signatureOffset + index] !== signature[index]) throw new Error(`${label} marker does not match payload data.`);
  }
  for (const [name, entry] of Object.entries(entries || {})) {
    if (!Number.isInteger(entry) || entry < 0 || entry >= payload.length) throw new Error(`${label} ${name} entry is invalid.`);
  }
  for (const range of descriptor.mutableRanges || []) {
    if (!Array.isArray(range) || range.length !== 2 || range[0] < 0 || range[1] < range[0] || range[1] > payload.length) {
      throw new Error(`${label} mutable payload range is invalid.`);
    }
  }
}

export function payloadMatchesFlash512kDescriptorAt(bytes, payloadBase, descriptor) {
  if (payloadBase < 0 || payloadBase + descriptor.payload.length > bytes.length) return false;
  const mutableRanges = descriptor.mutableRanges || [];
  for (let index = 0; index < descriptor.payload.length; index += 1) {
    if (offsetIsMutable(index, mutableRanges)) continue;
    if (bytes[payloadBase + index] !== descriptor.payload[index]) return false;
  }
  return true;
}

function countPatchedThumbHooks(bytes, target) {
  let count = 0;
  for (const offset of allFlash512kMatches(bytes, FLASH512K_THUMB_BRANCH_THUNK)) {
    if (offset + 8 <= bytes.length && readU32(bytes, offset + 4) === target) count += 1;
  }
  return count;
}

function countPatchedArmHooks(bytes, target) {
  let count = 0;
  for (const offset of allFlash512kMatches(bytes, FLASH512K_ARM_BRANCH_THUNK)) {
    if (offset + 12 <= bytes.length && readU32(bytes, offset + 8) === target) count += 1;
  }
  return count;
}

export function inspectInstalledFlash512kPayload(bytes, descriptor, label = "512K FLASH") {
  const markerOffsets = allFlash512kMatches(bytes, descriptor.signature, 1);
  if (!markerOffsets.length) return null;
  const candidates = markerOffsets
    .map((markerOffset) => markerOffset - descriptor.signatureOffset)
    .filter((payloadBase) => payloadMatchesFlash512kDescriptorAt(bytes, payloadBase, descriptor));
  if (candidates.length !== 1) throw new PatchError(`${label} marker is duplicated or its payload is damaged.`);

  const payloadBase = candidates[0];
  const entries = descriptor.entries;
  const counts = {
    sram_write: countPatchedThumbHooks(bytes, flash512kTargetAddress(payloadBase, entries.sramWrite, descriptor.gbaRomBase))
      + countPatchedArmHooks(bytes, flash512kTargetAddress(payloadBase, entries.sramWrite, descriptor.gbaRomBase)),
    sram_read: countPatchedThumbHooks(bytes, flash512kTargetAddress(payloadBase, entries.sramRead, descriptor.gbaRomBase)),
    sram_verify: countPatchedThumbHooks(bytes, flash512kTargetAddress(payloadBase, entries.sramVerify, descriptor.gbaRomBase)),
    eeprom_write: countPatchedThumbHooks(bytes, flash512kTargetAddress(payloadBase, entries.eepromWrite, descriptor.gbaRomBase)),
    eeprom_read: countPatchedThumbHooks(bytes, flash512kTargetAddress(payloadBase, entries.eepromRead, descriptor.gbaRomBase)),
    eeprom_verify: countPatchedThumbHooks(bytes, flash512kTargetAddress(payloadBase, entries.eepromVerify, descriptor.gbaRomBase)),
    eeprom_meta: descriptor.eepromMetaOffset === null || descriptor.eepromMetaOffset === undefined
      ? allFlash512kMatches(bytes, FLASH512K_HOOKS.eepromMeta.marker).length
      : (readU32(bytes, payloadBase + descriptor.eepromMetaOffset) ? 1 : 0),
  };
  const sramComplete = counts.sram_write > 0 && counts.sram_read > 0;
  const eepromComplete = counts.eeprom_write > 0 && counts.eeprom_read > 0;
  if (sramComplete === eepromComplete) throw new PatchError(`${label} payload does not have one coherent installed hook family.`);
  return { payloadBase, family: eepromComplete ? "eeprom" : "sram", counts };
}

export function logicalFlash512kSaveSize(saveType, family = null) {
  if (family === "eeprom" || saveType?.startsWith("EEPROM")) return 8192;
  if (family === "sram" || saveType?.startsWith("SRAM")) return 32768;
  if (saveType?.startsWith("FLASH")) return 65536;
  return null;
}
