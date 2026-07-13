// SPDX-License-Identifier: GPL-3.0-or-later AND MIT

import { findBytes, hexToBytes } from "../core/binary.js";
import { PATCH_OPERATION_KIND } from "../domain/constants.js";
import { stagePatchOperation } from "../patch-engine/draft.js";

export function stageSramWrite(bytes, operations, name, offset, replacement, details = {}) {
  return stagePatchOperation(bytes, operations, {
    id: `save-type-${operations.length}`,
    kind: details.kind || PATCH_OPERATION_KIND.HOOK_REPLACE,
    component: details.component || "saveType",
    offset,
    byteLength: replacement.length,
    expectedBefore: bytes.slice(offset, offset + replacement.length),
    replacement,
    labelKey: details.labelKey || "operation.saveType",
    metadata: {
      name,
      ...(details.codeName === undefined ? {} : { codeName: details.codeName }),
      ...(details.sourceOffset === undefined ? {} : { sourceOffset: details.sourceOffset }),
      ...(details.value === undefined ? {} : { value: details.value }),
    },
    ...(details.allowOverlap === true ? { allowOverlap: true } : {}),
  });
}

export function alignDown(value, alignment) {
  return value - (value % alignment);
}

export function alignUp(value, alignment) {
  return alignDown(value + alignment - 1, alignment);
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

export function rangesWithPrefixGuard(ranges, guardSize) {
  return ranges.map(([start, end]) => [Math.max(0, start - guardSize), end]);
}

function offsetInRanges(offset, ranges) {
  return ranges.some(([start, end]) => start <= offset && offset < end);
}

export function findAlignedMarker(bytes, marker, start = 0, end = bytes.length, alignment = 1) {
  const limit = Math.min(end, bytes.length);
  let position = Math.max(0, start);
  while (position < limit) {
    position = findBytes(bytes, marker, position, limit);
    if (position < 0) return null;
    if (alignment <= 1 || position % alignment === 0) return position;
    position += 1;
  }
  return null;
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

export function writeSramCode(out, targetOffset, writeInfo, operations, operationName = null) {
  const newCode = hexToBytes(writeInfo.hex);
  stageSramWrite(out, operations, operationName || writeInfo.name, targetOffset, newCode, {
    kind: PATCH_OPERATION_KIND.HOOK_REPLACE,
    codeName: writeInfo.code_name,
    sourceOffset: writeInfo.source_offset,
  });
}

export function writeSramU32Value(out, offset, value, operations, name) {
  const replacement = Uint8Array.of(
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff,
  );
  stageSramWrite(out, operations, name, offset, replacement, {
    kind: PATCH_OPERATION_KIND.LITERAL_REPLACE,
    value: value >>> 0,
  });
}
