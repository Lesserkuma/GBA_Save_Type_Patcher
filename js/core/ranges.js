// SPDX-License-Identifier: GPL-3.0-or-later

export function alignDown(value, alignment) {
  return value - (value % alignment);
}

export function alignUp(value, alignment) {
  return alignDown(value + alignment - 1, alignment);
}

export function isBlankByte(value) {
  return value === 0x00 || value === 0xff;
}

export function isBlankRegion(bytes, start, size) {
  if (start < 0 || size < 0 || start + size > bytes.length) {
    return false;
  }
  const end = start + size;
  for (let offset = start; offset < end; offset += 1) {
    if (!isBlankByte(bytes[offset])) return false;
  }
  return true;
}

export function overlapsAnyRange(start, end, ranges) {
  return ranges.some(([rangeStart, rangeEnd]) => start < rangeEnd && end > rangeStart);
}

export function isOffsetWithinAnyRange(offset, ranges) {
  return ranges.some(([start, end]) => start <= offset && offset < end);
}

export function addPrefixGuardToRanges(ranges, guardSize) {
  return ranges.map(([start, end]) => [Math.max(0, start - guardSize), end]);
}

export function findTailBlankRegion(
  bytes,
  size,
  alignment = 16,
  end = bytes.length,
  excludedRanges = [],
) {
  let runEnd = null;
  const limit = Math.min(end, bytes.length);
  for (let position = limit - 1; position >= -1; position -= 1) {
    const blank = position >= 0
      && isBlankByte(bytes[position])
      && !isOffsetWithinAnyRange(position, excludedRanges);
    if (blank) {
      if (runEnd === null) runEnd = position;
      continue;
    }
    if (runEnd === null) continue;
    const runStart = position + 1;
    const latestStart = runEnd - size + 1;
    if (latestStart < runStart) {
      runEnd = null;
      continue;
    }
    const alignedStart = alignDown(latestStart, alignment);
    if (
      alignedStart >= runStart
      && !overlapsAnyRange(alignedStart, alignedStart + size, excludedRanges)
    ) {
      return alignedStart;
    }
    runEnd = null;
  }
  return null;
}
