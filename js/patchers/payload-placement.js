// SPDX-License-Identifier: GPL-3.0-or-later

import { PatchError } from "../core/errors.js";
import { PATCH_OPERATION_KIND } from "../domain/constants.js";
import { stageRomExpansion } from "../patch-engine/draft.js";

export const PAYLOAD_ALIGNMENT = 0x100;
export const PATCH_BLOCK_ALIGNMENT = 0x40000;
export const GBA_MAX_ROM_SIZE = 0x02000000;

export function alignDown(value, alignment) {
  if (!Number.isSafeInteger(value) || !Number.isSafeInteger(alignment) || value < 0 || alignment <= 0) {
    throw new PatchError("Alignment values must be non-negative integers and alignment must be positive.", {
      code: "ALIGNMENT_INVALID",
      stage: "placement",
      context: { value, alignment },
    });
  }
  return value - (value % alignment);
}

export function alignUp(value, alignment) {
  return alignDown(value + alignment - 1, alignment);
}

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

export function isFreeByte(value) {
  return value === 0x00 || value === 0xff;
}

export function isFreeRegion(bytes, start, size) {
  if (start < 0 || size < 0 || start + size > bytes.length) return false;
  for (let offset = start; offset < start + size; offset += 1) {
    if (!isFreeByte(bytes[offset])) return false;
  }
  return true;
}

export function rangesOverlap(start, end, ranges) {
  return ranges.some(([rangeStart, rangeEnd]) => start < rangeEnd && end > rangeStart);
}

export function normalizeExcludedRanges(ranges, limit = GBA_MAX_ROM_SIZE) {
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

export function overlapsPowerOfTwoTailBlock(start, end, blockSize, maxSize = GBA_MAX_ROM_SIZE) {
  let boundary = blockSize * 2;
  while (boundary <= maxSize) {
    if (start < boundary && end > boundary - blockSize) return true;
    boundary *= 2;
  }
  return false;
}

function stageExpansion(rom, operations, name, oldSize, newSize) {
  const byteLength = newSize - oldSize;
  const erasedBytes = new Uint8Array(byteLength).fill(0xff);
  return stageRomExpansion(rom, operations, {
    id: `placement-${operations.length}`,
    kind: PATCH_OPERATION_KIND.ROM_EXPAND,
    component: "placement",
    labelKey: "operation.romExpand",
    offset: oldSize,
    byteLength,
    expectedBefore: erasedBytes,
    replacement: new Uint8Array(erasedBytes),
    metadata: {
      name,
      value: newSize,
      strategy: "alignedRomExpansion",
      reason: "No proven-safe trailing padding region was available.",
    },
  });
}

export function lastNonFreeEnd(bytes) {
  for (let offset = bytes.length - 1; offset >= 0; offset -= 1) {
    if (!isFreeByte(bytes[offset])) return offset + 1;
  }
  return 0;
}

export function findDirectPayloadRegion(bytes, totalSpan, excludedRanges = []) {
  if (!Number.isSafeInteger(totalSpan) || totalSpan < 0) return null;
  const normalizedRanges = normalizeExcludedRanges(excludedRanges);
  if (totalSpan === 0) return alignUp(bytes.length, PAYLOAD_ALIGNMENT);
  const paddingByte = bytes.at(-1);
  if (!isFreeByte(paddingByte)) return null;
  let suffixStart = bytes.length;
  while (suffixStart > 0 && bytes[suffixStart - 1] === paddingByte) suffixStart -= 1;
  const start = alignUp(suffixStart, PAYLOAD_ALIGNMENT);
  const end = start + totalSpan;
  if (end > bytes.length || rangesOverlap(start, end, normalizedRanges)) return null;
  return start;
}

function directPayloadTargetEnd(bytes, totalSpan, excludedRanges) {
  const normalizedRanges = normalizeExcludedRanges(excludedRanges);
  let start = alignUp(bytes.length, PAYLOAD_ALIGNMENT);
  while (true) {
    const end = start + totalSpan;
    const overlappingRange = normalizedRanges.find(([rangeStart, rangeEnd]) => start < rangeEnd && end > rangeStart);
    if (!overlappingRange) return end;
    start = alignUp(overlappingRange[1], PAYLOAD_ALIGNMENT);
  }
}

export function ensureDirectPayloadRegion(rom, operations, warnings, totalSpan, label, excludedRanges = []) {
  const normalizedRanges = normalizeExcludedRanges(excludedRanges);
  while (true) {
    if (rom.bytes.length > GBA_MAX_ROM_SIZE) {
      warnings.push(`${label}: ROM is larger than 32 MiB`);
      return null;
    }

    const payloadBase = findDirectPayloadRegion(rom.bytes, totalSpan, normalizedRanges);
    if (payloadBase !== null) return payloadBase;

    const targetEnd = directPayloadTargetEnd(rom.bytes, totalSpan, normalizedRanges);
    if (targetEnd > GBA_MAX_ROM_SIZE || rom.bytes.length >= GBA_MAX_ROM_SIZE) {
      warnings.push(`${label}: no free payload area and ROM is already 32 MiB`);
      return null;
    }

    const oldSize = rom.bytes.length;
    const newSize = Math.min(alignUp(targetEnd, PATCH_BLOCK_ALIGNMENT), GBA_MAX_ROM_SIZE);
    if (newSize <= oldSize) {
      warnings.push(`${label}: ROM could not be expanded`);
      return null;
    }
    stageExpansion(rom, operations, `${label} ROM expansion`, oldSize, newSize);
  }
}
