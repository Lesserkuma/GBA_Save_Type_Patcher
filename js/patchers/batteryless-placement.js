// SPDX-License-Identifier: GPL-3.0-or-later

import { alignDown, isBlankByte } from "../core/ranges.js";
import { overlapsPowerOfTwoTailBlock } from "./payload-placement.js";
import { SRAM_CONSTANTS as C } from "./sram-data.js";

export function overlapsBatterylessPowerBoundaryGuard(start, end) {
  return overlapsPowerOfTwoTailBlock(
    start,
    end,
    C.BATTERYLESS_RESERVED_SIZE,
    C.GBA_MAX_ROM_SIZE,
  );
}

export function batterylessPowerBoundaryGuardRanges(limit) {
  const ranges = [];
  let boundary = C.BATTERYLESS_REGION_ALIGNMENT * 2;
  while (boundary <= Math.min(limit, C.GBA_MAX_ROM_SIZE)) {
    ranges.push([boundary - C.BATTERYLESS_RESERVED_SIZE, boundary]);
    boundary *= 2;
  }
  return ranges;
}

export function lastNonEmptyBatterylessBlockStart(bytes) {
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
      if (!isBlankByte(bytes[offset])) {
        hasData = true;
        break;
      }
    }
    if (hasData) return blockStart;
    blockStart -= C.BATTERYLESS_REGION_ALIGNMENT;
  }
  return null;
}
