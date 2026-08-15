// SPDX-License-Identifier: GPL-3.0-or-later

import { findTailBlankRegion, isBlankRegion, overlapsAnyRange } from "../core/ranges.js";
import { GBA_PAYLOAD_PLACEMENT_LIMIT_BYTES } from "../domain/gba-constants.js";
import { stageErasedRomExpansion } from "../patch-engine/draft.js";
import {
  lastNonEmptyBatterylessBlockStart,
  overlapsBatterylessPowerBoundaryGuard,
} from "./batteryless-placement.js";
import { SRAM_CONSTANTS as C } from "./sram-data.js";

export { batterylessPowerBoundaryGuardRanges } from "./batteryless-placement.js";
export {
  findTailBlankRegion as findTailFreeRegion,
  isBlankRegion as isFreeRegion,
  overlapsAnyRange as rangesOverlap,
};

function waitstatePayloadFitsAtBlockEnd(bytes, blockStart, size) {
  const blockEnd = blockStart + C.BATTERYLESS_REGION_ALIGNMENT;
  const payloadBase = blockEnd - size;
  if (
    payloadBase < 0
    || blockEnd > bytes.length
    || blockEnd > GBA_PAYLOAD_PLACEMENT_LIMIT_BYTES
  ) return null;
  if (overlapsBatterylessPowerBoundaryGuard(payloadBase, blockEnd)) return null;
  if (!isBlankRegion(bytes, payloadBase, size)) return null;
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

    const newLength = Math.min(
      rom.bytes.length + C.BATTERYLESS_REGION_ALIGNMENT,
      C.GBA_MAX_ROM_SIZE,
    );
    if (newLength <= rom.bytes.length) {
      warnings.push("Waitstate: ROM could not be expanded");
      return null;
    }
    stageErasedRomExpansion(rom, operations, {
      id: `waitstate-expand-${operations.length}`,
      component: "waitstate",
      newLength,
      metadata: {
        name: "Waitstate ROM expansion",
        value: newLength,
      },
    });
  }
}
