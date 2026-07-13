// SPDX-License-Identifier: GPL-3.0-or-later

import { PATCH_OPERATION_KIND } from "../domain/constants.js";
import { stagePatchOperation, stageRomExpansion } from "../patch-engine/draft.js";

export const MAX_GBA_ROM_SIZE = 32 * 1024 * 1024;

export function stageWaitstateWrite(bytes, operations, name, offset, replacement, details = {}) {
  return stagePatchOperation(bytes, operations, {
    id: `waitstate-${operations.length}`,
    kind: details.kind || PATCH_OPERATION_KIND.LITERAL_REPLACE,
    component: "waitstate",
    labelKey: details.labelKey || "operation.waitstate",
    offset,
    byteLength: replacement.length,
    expectedBefore: bytes.slice(offset, offset + replacement.length),
    replacement,
    metadata: {
      name,
      ...(details.codeName === undefined ? {} : { codeName: details.codeName }),
      ...(details.value === undefined ? {} : { value: details.value }),
      ...(details.oldBytes === undefined ? {} : { oldBytes: details.oldBytes }),
      ...(details.newBytes === undefined ? {} : { newBytes: details.newBytes }),
    },
  });
}

function hexBytes(bytes) {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join(" ");
}

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

export function u32ToBytes(value) {
  return Uint8Array.of(
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff,
  );
}

export function u16ToBytes(value) {
  return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff);
}

export function wordsToBytes(words) {
  const out = new Uint8Array(words.length * 4);
  for (let index = 0; index < words.length; index += 1) {
    writeU32At(out, index * 4, words[index]);
  }
  return out;
}

export function rangesOverlap(start, end, ranges) {
  return ranges.some(([rangeStart, rangeEnd]) => start < rangeEnd && end > rangeStart);
}

export function isFreeRegion(bytes, start, size) {
  if (start < 0 || size < 0 || start + size > bytes.length) return false;
  for (let offset = start; offset < start + size; offset += 1) {
    if (bytes[offset] !== 0x00 && bytes[offset] !== 0xff) return false;
  }
  return true;
}

export function recordAndWriteBytes(rom, operations, offset, newBytes, codeName) {
  if (offset < 0 || offset >= MAX_GBA_ROM_SIZE) return false;
  const end = Math.min(offset + newBytes.length, MAX_GBA_ROM_SIZE);
  if (end <= offset) return false;

  const writable = newBytes.slice(0, end - offset);
  if (end > rom.bytes.length) {
    const expansionLength = end - rom.bytes.length;
    const erasedBytes = new Uint8Array(expansionLength).fill(0xff);
    stageRomExpansion(rom, operations, {
      id: `waitstate-expand-${operations.length}`,
      kind: PATCH_OPERATION_KIND.ROM_EXPAND,
      component: "waitstate",
      offset: rom.bytes.length,
      byteLength: expansionLength,
      expectedBefore: erasedBytes,
      replacement: new Uint8Array(erasedBytes),
      labelKey: "operation.romExpand",
      metadata: {
        name: "Waitstate ROM expansion",
        value: end,
      },
    });
  }
  const oldBytes = rom.bytes.slice(offset, end);
  stageWaitstateWrite(rom.bytes, operations, "superfw WAITCNT patch", offset, writable, {
    codeName,
    oldBytes: hexBytes(oldBytes),
    newBytes: hexBytes(writable),
  });
  return true;
}
