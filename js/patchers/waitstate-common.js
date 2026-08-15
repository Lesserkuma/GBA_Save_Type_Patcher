// SPDX-License-Identifier: GPL-3.0-or-later

import { bytesToHex } from "../core/binary.js";
import { PATCH_OPERATION_KIND } from "../domain/constants.js";
import { GBA_MAX_ROM_SIZE_BYTES } from "../domain/gba-constants.js";
import { stageErasedRomExpansion, stageNamedPatchWrite } from "../patch-engine/draft.js";


export const MAX_GBA_ROM_SIZE = GBA_MAX_ROM_SIZE_BYTES;

export function stageWaitstateWrite(bytes, operations, name, offset, replacement, details = {}) {
  return stageNamedPatchWrite(bytes, operations, {
    idPrefix: "waitstate",
    kind: details.kind || PATCH_OPERATION_KIND.LITERAL_REPLACE,
    component: "waitstate",
    labelKey: details.labelKey || "operation.waitstate",
    name,
    offset,
    replacement,
    metadata: {
      ...(details.codeName === undefined ? {} : { codeName: details.codeName }),
      ...(details.value === undefined ? {} : { value: details.value }),
      ...(details.oldBytes === undefined ? {} : { oldBytes: details.oldBytes }),
      ...(details.newBytes === undefined ? {} : { newBytes: details.newBytes }),
    },
  });
}

export function stageWaitstateWriteWithinRomLimit(rom, operations, offset, newBytes, codeName) {
  if (offset < 0 || offset >= GBA_MAX_ROM_SIZE_BYTES) return false;
  const end = Math.min(offset + newBytes.length, GBA_MAX_ROM_SIZE_BYTES);
  if (end <= offset) return false;

  const writable = newBytes.slice(0, end - offset);
  if (end > rom.bytes.length) {
    stageErasedRomExpansion(rom, operations, {
      id: `waitstate-expand-${operations.length}`,
      component: "waitstate",
      newLength: end,
      metadata: {
        name: "Waitstate ROM expansion",
        value: end,
      },
    });
  }
  const oldBytes = rom.bytes.slice(offset, end);
  stageWaitstateWrite(rom.bytes, operations, "Structural WAITCNT patch", offset, writable, {
    codeName,
    oldBytes: bytesToHex(oldBytes, " "),
    newBytes: bytesToHex(writable, " "),
  });
  return true;
}

// Compatibility exports retained for existing direct module consumers.
export function readU32At(bytes, offset) {
  if (offset < 0 || offset + 4 > bytes.length) return null;
  return (
    bytes[offset]
    | (bytes[offset + 1] << 8)
    | (bytes[offset + 2] << 16)
    | (bytes[offset + 3] << 24)
  ) >>> 0;
}

export function writeU16At(bytes, offset, value) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
}

export function writeU32At(bytes, offset, value) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

export {
  u16ToBytes,
  u32ToBytes,
  u32WordsToBytes as wordsToBytes,
} from "../core/binary.js";
export {
  isBlankRegion as isFreeRegion,
  overlapsAnyRange as rangesOverlap,
} from "../core/ranges.js";
export const recordAndWriteBytes = stageWaitstateWriteWithinRomLimit;
