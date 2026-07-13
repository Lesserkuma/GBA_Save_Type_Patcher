// SPDX-License-Identifier: GPL-3.0-or-later

import { PATCH_OPERATION_KIND } from "../domain/constants.js";
import { stageRomExpansion } from "../patch-engine/draft.js";
import { SRAM_CONSTANTS as C } from "./sram-data.js";
import {
  isFreeRegion,
  rangesOverlap,
} from "./waitstate-common.js";

function alignDown(value, alignment) {
  return value - (value % alignment);
}

function isFreeByte(value) {
  return value === 0x00 || value === 0xff;
}

function offsetInRanges(offset, ranges) {
  return ranges.some(([start, end]) => start <= offset && offset < end);
}

export function findTailFreeRegion(
  bytes,
  size,
  alignment = 16,
  end = bytes.length,
  excludedRanges = [],
) {
  let runEnd = null;
  const limit = Math.min(end, bytes.length);
  for (let position = limit - 1; position >= -1; position -= 1) {
    const free = position >= 0
      && isFreeByte(bytes[position])
      && !offsetInRanges(position, excludedRanges);
    if (free) {
      if (runEnd === null) runEnd = position;
      continue;
    }
    if (runEnd === null) continue;
    const runStart = position + 1;
    const alignedStart = alignDown(runEnd - size + 1, alignment);
    if (
      alignedStart >= runStart
      && !rangesOverlap(alignedStart, alignedStart + size, excludedRanges)
    ) {
      return alignedStart;
    }
    runEnd = null;
  }
  return null;
}

function overlapsBatterylessPowerBoundaryGuard(start, end) {
  let boundary = C.BATTERYLESS_REGION_ALIGNMENT * 2;
  while (boundary <= C.GBA_MAX_ROM_SIZE) {
    const guardStart = boundary - C.BATTERYLESS_RESERVED_SIZE;
    if (start < boundary && guardStart < end) return true;
    boundary <<= 1;
  }
  return false;
}

export function batterylessPowerBoundaryGuardRanges(limit) {
  const ranges = [];
  let boundary = C.BATTERYLESS_REGION_ALIGNMENT * 2;
  while (boundary <= Math.min(limit, C.GBA_MAX_ROM_SIZE)) {
    ranges.push([boundary - C.BATTERYLESS_RESERVED_SIZE, boundary]);
    boundary <<= 1;
  }
  return ranges;
}

function lastNonEmptyBatterylessBlockStart(bytes) {
  let blockStart = alignDown(
    Math.max(0, bytes.length - 1),
    C.BATTERYLESS_REGION_ALIGNMENT,
  );
  while (blockStart >= 0) {
    const blockEnd = Math.min(
      blockStart + C.BATTERYLESS_REGION_ALIGNMENT,
      bytes.length,
    );
    let hasData = false;
    for (let offset = blockStart; offset < blockEnd; offset += 1) {
      if (!isFreeByte(bytes[offset])) {
        hasData = true;
        break;
      }
    }
    if (hasData) return blockStart;
    blockStart -= C.BATTERYLESS_REGION_ALIGNMENT;
  }
  return null;
}

function waitstatePayloadFitsAtBlockEnd(bytes, blockStart, size) {
  const blockEnd = blockStart + C.BATTERYLESS_REGION_ALIGNMENT;
  const payloadBase = blockEnd - size;
  if (payloadBase < 0 || blockEnd > bytes.length) return null;
  if (overlapsBatterylessPowerBoundaryGuard(payloadBase, blockEnd)) return null;
  if (!isFreeRegion(bytes, payloadBase, size)) return null;
  return payloadBase;
}

function findWaitstateBatterylessPosition(bytes, size) {
  const lastContentBlock = lastNonEmptyBatterylessBlockStart(bytes);
  if (lastContentBlock === null) return null;
  let blockStart = lastContentBlock;
  while (blockStart + C.BATTERYLESS_REGION_ALIGNMENT <= bytes.length) {
    const payloadBase = waitstatePayloadFitsAtBlockEnd(bytes, blockStart, size);
    if (payloadBase !== null) return payloadBase;
    blockStart += C.BATTERYLESS_REGION_ALIGNMENT;
  }
  return null;
}

export function ensureWaitstateBatterylessPosition(rom, operations, warnings, size) {
  while (true) {
    if (rom.bytes.length > C.GBA_MAX_ROM_SIZE) {
      warnings.push("Waitstate: ROM is larger than 32 MiB");
      return null;
    }
    const payloadBase = findWaitstateBatterylessPosition(rom.bytes, size);
    if (payloadBase !== null) return payloadBase;
    if (rom.bytes.length >= C.GBA_MAX_ROM_SIZE) {
      warnings.push("Waitstate: no free Batteryless code block and ROM is already 32 MiB");
      return null;
    }
    const oldSize = rom.bytes.length;
    const newSize = Math.min(
      oldSize + C.BATTERYLESS_REGION_ALIGNMENT,
      C.GBA_MAX_ROM_SIZE,
    );
    if (newSize <= oldSize) {
      warnings.push("Waitstate: ROM could not be expanded");
      return null;
    }
    const byteLength = newSize - oldSize;
    const erasedBytes = new Uint8Array(byteLength).fill(0xff);
    stageRomExpansion(rom, operations, {
      id: `waitstate-expand-${operations.length}`,
      kind: PATCH_OPERATION_KIND.ROM_EXPAND,
      component: "waitstate",
      offset: oldSize,
      byteLength,
      expectedBefore: erasedBytes,
      replacement: new Uint8Array(erasedBytes),
      labelKey: "operation.romExpand",
      metadata: {
        name: "Waitstate ROM expansion",
        value: newSize,
      },
    });
  }
}

export { isFreeRegion, rangesOverlap } from "./waitstate-common.js";
