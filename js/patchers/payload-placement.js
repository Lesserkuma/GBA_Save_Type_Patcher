// SPDX-License-Identifier: GPL-3.0-or-later

import { PatchError } from "../core/errors.js";
import {
  alignDown,
  alignUp,
  isBlankByte,
  isBlankRegion,
  overlapsAnyRange,
} from "../core/ranges.js";
import {
  GBA_MAX_ROM_SIZE_BYTES,
  GBA_PAYLOAD_PLACEMENT_LIMIT_BYTES,
} from "../domain/gba-constants.js";
import { stageErasedRomExpansion } from "../patch-engine/draft.js";

export const PAYLOAD_ALIGNMENT = 0x100;
export const PATCH_BLOCK_ALIGNMENT = 0x40000;

export function alignedPayloadSpan(size) {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new PatchError("Payload size must be a non-negative integer.", {
      code: "PAYLOAD_SIZE_INVALID",
      stage: "placement",
      context: { size },
    });
  }
  return alignUp(size, PAYLOAD_ALIGNMENT);
}

export function markedPayloadSpan(payloadSize, markerSize) {
  alignedPayloadSpan(payloadSize);
  if (!Number.isSafeInteger(markerSize) || markerSize < 0) {
    throw new PatchError("Payload marker size must be a non-negative integer.", {
      code: "PAYLOAD_MARKER_SIZE_INVALID",
      stage: "placement",
      context: { payloadSize, markerSize },
    });
  }
  const combinedSize = payloadSize + markerSize;
  if (!Number.isSafeInteger(combinedSize)) {
    throw new PatchError("Payload and marker size exceed the supported integer range.", {
      code: "PAYLOAD_MARKER_SPAN_INVALID",
      stage: "placement",
      context: { payloadSize, markerSize },
    });
  }
  return alignedPayloadSpan(combinedSize);
}

export function normalizeExcludedRanges(ranges, limit = GBA_MAX_ROM_SIZE_BYTES) {
  const normalized = (ranges || []).map((range) => {
    if (
      !Array.isArray(range)
      || range.length !== 2
      || !Number.isSafeInteger(range[0])
      || !Number.isSafeInteger(range[1])
      || range[0] < 0
      || range[1] <= range[0]
      || range[1] > limit
    ) {
      throw new PatchError("Excluded payload range is invalid.", {
        code: "EXCLUDED_RANGE_INVALID",
        stage: "placement",
        context: { range, limit },
      });
    }
    return [range[0], range[1]];
  }).sort((first, second) => first[0] - second[0] || first[1] - second[1]);

  const merged = [];
  for (const range of normalized) {
    const previous = merged.at(-1);
    if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1]);
    else merged.push(range);
  }
  return merged;
}

export function overlapsPowerOfTwoTailBlock(
  start,
  end,
  blockSize,
  maxSize = GBA_MAX_ROM_SIZE_BYTES,
) {
  let boundary = blockSize * 2;
  while (boundary <= maxSize) {
    if (start < boundary && end > boundary - blockSize) return true;
    boundary *= 2;
  }
  return false;
}

function stageExpansion(rom, operations, name, newLength) {
  return stageErasedRomExpansion(rom, operations, {
    id: `placement-${operations.length}`,
    component: "placement",
    newLength,
    metadata: {
      name,
      value: newLength,
      strategy: "alignedRomExpansion",
      reason: "No proven-safe trailing padding region was available.",
    },
  });
}

export function lastNonBlankEnd(bytes) {
  for (let offset = bytes.length - 1; offset >= 0; offset -= 1) {
    if (!isBlankByte(bytes[offset])) return offset + 1;
  }
  return 0;
}

export function findDirectPayloadRegion(bytes, totalSpan, excludedRanges = []) {
  if (!Number.isSafeInteger(totalSpan) || totalSpan < 0) return null;
  const normalizedRanges = normalizeExcludedRanges(excludedRanges);
  const searchEnd = Math.min(bytes.length, GBA_PAYLOAD_PLACEMENT_LIMIT_BYTES);
  if (totalSpan === 0) return alignUp(searchEnd, PAYLOAD_ALIGNMENT);

  let runEnd = null;
  for (let position = searchEnd - 1; position >= -1; position -= 1) {
    const excluded = position >= 0
      && normalizedRanges.some(([start, end]) => start <= position && position < end);
    const blank = position >= 0 && isBlankByte(bytes[position]) && !excluded;
    if (blank) {
      if (runEnd === null) runEnd = position;
      continue;
    }
    if (runEnd === null) continue;

    const runStart = position + 1;
    const latestStart = runEnd - totalSpan + 1;
    if (latestStart >= 0) {
      const start = alignDown(latestStart, PAYLOAD_ALIGNMENT);
      if (start >= runStart && !overlapsAnyRange(start, start + totalSpan, normalizedRanges)) {
        return start;
      }
    }
    runEnd = null;
  }
  return null;
}

function directPayloadTargetEnd(bytes, totalSpan, excludedRanges) {
  const normalizedRanges = normalizeExcludedRanges(excludedRanges);
  let start = alignUp(bytes.length, PAYLOAD_ALIGNMENT);
  while (true) {
    const end = start + totalSpan;
    const overlappingRange = normalizedRanges.find(
      ([rangeStart, rangeEnd]) => start < rangeEnd && end > rangeStart,
    );
    if (!overlappingRange) return end;
    start = alignUp(overlappingRange[1], PAYLOAD_ALIGNMENT);
  }
}

export function ensureDirectPayloadRegion(
  rom,
  operations,
  warnings,
  totalSpan,
  label,
  excludedRanges = [],
) {
  const normalizedRanges = normalizeExcludedRanges(excludedRanges);
  while (true) {
    if (rom.bytes.length > GBA_MAX_ROM_SIZE_BYTES) {
      warnings.push(`${label}: ROM is larger than 32 MiB`);
      return null;
    }

    const payloadBase = findDirectPayloadRegion(rom.bytes, totalSpan, normalizedRanges);
    if (payloadBase !== null) return payloadBase;

    const targetEnd = directPayloadTargetEnd(rom.bytes, totalSpan, normalizedRanges);
    if (
      targetEnd > GBA_PAYLOAD_PLACEMENT_LIMIT_BYTES
      || rom.bytes.length >= GBA_MAX_ROM_SIZE_BYTES
    ) {
      warnings.push(`${label}: no free payload area and ROM is already 32 MiB`);
      return null;
    }

    const newLength = Math.min(
      alignUp(targetEnd, PATCH_BLOCK_ALIGNMENT),
      GBA_MAX_ROM_SIZE_BYTES,
    );
    if (newLength <= rom.bytes.length) {
      warnings.push(`${label}: ROM could not be expanded`);
      return null;
    }
    stageExpansion(rom, operations, `${label} ROM expansion`, newLength);
  }
}

// Compatibility aliases for the pre-audit helper names.
export const GBA_MAX_ROM_SIZE = GBA_MAX_ROM_SIZE_BYTES;
export const GBA_PAYLOAD_PLACEMENT_LIMIT = GBA_PAYLOAD_PLACEMENT_LIMIT_BYTES;
export { alignDown, alignUp };
export const isFreeByte = isBlankByte;
export const isFreeRegion = isBlankRegion;
export const rangesOverlap = overlapsAnyRange;
export const lastNonFreeEnd = lastNonBlankEnd;
